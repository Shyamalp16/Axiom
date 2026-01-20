/**
 * TOKEN DISCOVERY ENGINE
 * 
 * Multi-strategy discovery for finding tokens with momentum:
 * 
 * Strategies:
 * 1. Currently Live - tokens being actively traded right now
 * 2. Volatile - tokens with high price movement
 * 3. Watch & Revisit - track new tokens and check for growth after delay
 * 
 * Filters candidates by:
 * - Age: 1-30 minutes
 * - Bonding curve progress: 15-85%
 * - Market cap: $3k - $50k
 * - Engagement: minimum trades
 */

import { 
  searchCoins, 
  subscribeNewTokens, 
  connectPumpPortal,
  isConnectedToPumpPortal,
  PumpPortalToken,
  PumpPortalNewToken,
  fetchCurrentlyLiveCoins,
  fetchVolatileCoins,
  fetchTokenViaPumpPortal,
} from '../api/pump-portal.js';
import { CandidateQueue } from './candidate-queue.js';
import logger from '../utils/logger.js';

// Watch list entry for new tokens
interface WatchedToken {
  mint: string;
  symbol: string;
  initialMcap: number;
  initialTrades: number;
  seenAt: number;
}

// Discovery configuration
export const DISCOVERY_CONFIG = {
  // Source
  source: 'pump.fun' as const,
  onlyBondingCurve: true,        // NOT graduated (complete: false)
  
  // Age filtering
  minAgeMinutes: 1,              // Avoid bot wars
  maxAgeMinutes: 60,             // Not too stale
  
  // Bonding curve progress
  minProgress: 15,                // Allow early tokens
  maxProgress: 99,               // Not about to graduate
  
  // Market cap (USD)
  minMarketCap: 3000,            // Most bonding curve tokens are $3k-$5k
  maxMarketCap: 60000,
  
  // Activity requirements
  minTradeCount: 1,              // Some engagement
  
  // Polling
  pollIntervalMs: 5000,          // Check every 5 seconds
  pollLimit: 50,                 // Fetch up to 50 tokens per poll
  
  // Watch & Revisit
  watchDelayMs: 180000,          // 3 minutes before re-checking new tokens
  watchCheckIntervalMs: 30000,   // Check watchlist every 30 seconds
  minMcapGrowth: 1.3,            // 30% mcap growth to qualify
  minTradesGrowth: 5,            // At least 5 more trades
};

// Discovery strategies
type DiscoveryStrategy = 'live' | 'volatile' | 'newest';

/**
 * Token Discovery Class
 */
export class TokenDiscovery {
  private queue: CandidateQueue;
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private watchInterval: NodeJS.Timeout | null = null;
  private unsubscribeNewTokens: (() => void) | null = null;
  private pollCount: number = 0;
  private lastPollTime: number = 0;
  private candidatesFound: number = 0;
  
  // Multi-strategy state
  private currentStrategy: DiscoveryStrategy = 'live';
  private strategyRotation: DiscoveryStrategy[] = ['live', 'volatile', 'newest'];
  private strategyIndex: number = 0;
  
  // Watch & Revisit
  private watchlist: Map<string, WatchedToken> = new Map();
  private watchlistPromoted: number = 0;
  
  constructor(queue: CandidateQueue) {
    this.queue = queue;
  }
  
  /**
   * Start the discovery engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Discovery engine is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting token discovery engine...');
    
    // Ensure PumpPortal connection
    if (!isConnectedToPumpPortal()) {
      await connectPumpPortal();
    }
    
    // 1. Start polling for candidates (rotates strategies)
    this.pollInterval = setInterval(
      () => this.pollCandidates(),
      DISCOVERY_CONFIG.pollIntervalMs
    );
    
    // 2. Start watchlist checker
    this.watchInterval = setInterval(
      () => this.checkWatchlist(),
      DISCOVERY_CONFIG.watchCheckIntervalMs
    );
    
    // 3. Subscribe to new token events (adds to watchlist)
    this.unsubscribeNewTokens = subscribeNewTokens((newToken) => {
      this.handleNewToken(newToken);
    });
    
    // 4. Run initial poll immediately
    await this.pollCandidates();
    
    logger.success('Token discovery engine started');
    logger.info(`  Strategies: ${this.strategyRotation.join(' → ')}`);
    logger.info(`  Poll interval: ${DISCOVERY_CONFIG.pollIntervalMs / 1000}s`);
    logger.info(`  Watch delay: ${DISCOVERY_CONFIG.watchDelayMs / 1000}s`);
    logger.info(`  Mcap range: $${DISCOVERY_CONFIG.minMarketCap}-$${DISCOVERY_CONFIG.maxMarketCap}`);
  }
  
  /**
   * Stop the discovery engine
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    
    if (this.unsubscribeNewTokens) {
      this.unsubscribeNewTokens();
      this.unsubscribeNewTokens = null;
    }
    
    logger.info('Token discovery engine stopped');
    logger.info(`  Total polls: ${this.pollCount}`);
    logger.info(`  Candidates found: ${this.candidatesFound}`);
    logger.info(`  Watchlist promoted: ${this.watchlistPromoted}`);
  }
  
  /**
   * Poll for candidate tokens using rotating strategies
   */
  private async pollCandidates(): Promise<void> {
    if (!this.isRunning) return;
    
    this.pollCount++;
    this.lastPollTime = Date.now();
    
    // Rotate strategy
    this.currentStrategy = this.strategyRotation[this.strategyIndex];
    this.strategyIndex = (this.strategyIndex + 1) % this.strategyRotation.length;
    
    try {
      // Fetch tokens based on current strategy
      let tokens: PumpPortalToken[] = [];
      
      switch (this.currentStrategy) {
        case 'live':
          tokens = await fetchCurrentlyLiveCoins(DISCOVERY_CONFIG.pollLimit);
          break;
        case 'volatile':
          tokens = await fetchVolatileCoins();
          break;
        case 'newest':
          tokens = await searchCoins({
            complete: false,
            sort: 'created_timestamp',
            order: 'DESC',
            limit: DISCOVERY_CONFIG.pollLimit,
          });
          break;
      }
      
      let added = 0;
      let passed = 0;
      const rejectionReasons: Record<string, number> = {};
      
      // Process tokens
      for (const token of tokens) {
        const filterResult = this.getFilterReason(token);
        if (filterResult.passed) {
          passed++;
          const wasAdded = this.queue.add(token, 'poll');
          if (wasAdded) {
            added++;
            this.candidatesFound++;
            logger.info(`✓ ${token.symbol} $${token.marketCapUsd.toFixed(0)} [${this.currentStrategy}]`);
          }
        } else {
          // Track rejection reasons
          const reason = filterResult.reason.split(' ')[0]; // Get first word (e.g., "age", "graduated")
          rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
        }
      }
      
      // Summary log with rejection breakdown
      const rejectSummary = Object.entries(rejectionReasons)
        .map(([r, c]) => `${r}:${c}`)
        .join(' ');
      logger.info(`[${this.currentStrategy.toUpperCase()}] ${tokens.length} tokens → ${passed} passed → +${added} queued | rejects: ${rejectSummary || 'none'}`);
      
    } catch (error) {
      logger.debug(`Discovery poll failed (${this.currentStrategy}): ${error}`);
    }
  }
  
  /**
   * Handle new token WebSocket event - add to watchlist
   */
  private handleNewToken(newToken: PumpPortalNewToken): void {
    // Skip if already watching
    if (this.watchlist.has(newToken.mint)) return;
    
    // Add to watchlist for later evaluation
    const initialMcap = (newToken.marketCapSol || 0) / 1e9 * 150; // Rough USD estimate
    
    this.watchlist.set(newToken.mint, {
      mint: newToken.mint,
      symbol: newToken.symbol,
      initialMcap,
      initialTrades: 0,
      seenAt: Date.now(),
    });
    
    logger.debug(`👀 Watching: ${newToken.symbol} (will check in ${DISCOVERY_CONFIG.watchDelayMs / 1000}s)`);
  }
  
  /**
   * Check watchlist for tokens that have gained momentum
   */
  private async checkWatchlist(): Promise<void> {
    if (!this.isRunning) return;
    
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [mint, watched] of this.watchlist) {
      // Only check tokens after the delay period
      if (now - watched.seenAt < DISCOVERY_CONFIG.watchDelayMs) continue;
      
      // Mark for removal (we'll process once)
      toRemove.push(mint);
      
      try {
        // Re-fetch current data
        const freshToken = await fetchTokenViaPumpPortal(mint);
        if (!freshToken) continue;
        
        // Check for momentum
        const mcapGrowth = freshToken.marketCapUsd / Math.max(watched.initialMcap, 1);
        const tradesGrowth = freshToken.tradeCount - watched.initialTrades;
        
        const hasMomentum = mcapGrowth >= DISCOVERY_CONFIG.minMcapGrowth && 
                           tradesGrowth >= DISCOVERY_CONFIG.minTradesGrowth;
        
        if (hasMomentum) {
          // Check if passes main filter
          const filterResult = this.getFilterReason(freshToken);
          if (filterResult.passed) {
            const wasAdded = this.queue.add(freshToken, 'websocket');
            if (wasAdded) {
              this.candidatesFound++;
              this.watchlistPromoted++;
              logger.info(`🚀 ${freshToken.symbol} $${freshToken.marketCapUsd.toFixed(0)} [MOMENTUM +${((mcapGrowth - 1) * 100).toFixed(0)}%]`);
            }
          }
        }
      } catch (error) {
        logger.debug(`Watchlist check failed for ${watched.symbol}: ${error}`);
      }
    }
    
    // Clean up processed tokens
    for (const mint of toRemove) {
      this.watchlist.delete(mint);
    }
    
    // Limit watchlist size (remove oldest if too large)
    if (this.watchlist.size > 200) {
      const entries = [...this.watchlist.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
      while (this.watchlist.size > 150) {
        const [mint] = entries.shift()!;
        this.watchlist.delete(mint);
      }
    }
  }
  
  /**
   * Get filter rejection reason (for logging)
   */
  private getFilterReason(token: PumpPortalToken): { passed: boolean; reason: string } {
    if (token.isGraduated) return { passed: false, reason: 'graduated' };
    if (token.ageMinutes < DISCOVERY_CONFIG.minAgeMinutes) return { passed: false, reason: `age ${token.ageMinutes.toFixed(1)}m < ${DISCOVERY_CONFIG.minAgeMinutes}m` };
    if (token.ageMinutes > DISCOVERY_CONFIG.maxAgeMinutes) return { passed: false, reason: `age ${token.ageMinutes.toFixed(1)}m > ${DISCOVERY_CONFIG.maxAgeMinutes}m` };
    if (token.bondingCurveProgress < DISCOVERY_CONFIG.minProgress) return { passed: false, reason: `progress ${token.bondingCurveProgress.toFixed(0)}%` };
    if (token.bondingCurveProgress > DISCOVERY_CONFIG.maxProgress) return { passed: false, reason: `progress ${token.bondingCurveProgress.toFixed(0)}% > ${DISCOVERY_CONFIG.maxProgress}%` };
    if (token.marketCapUsd < DISCOVERY_CONFIG.minMarketCap) return { passed: false, reason: `mcap $${token.marketCapUsd.toFixed(0)} < $${DISCOVERY_CONFIG.minMarketCap}` };
    if (token.marketCapUsd > DISCOVERY_CONFIG.maxMarketCap) return { passed: false, reason: `mcap > $${DISCOVERY_CONFIG.maxMarketCap}` };
    if (token.tradeCount < DISCOVERY_CONFIG.minTradeCount) return { passed: false, reason: `trades ${token.tradeCount} < ${DISCOVERY_CONFIG.minTradeCount}` };
    return { passed: true, reason: '' };
  }

  /**
   * Quick filter for candidates (before expensive checks)
   */
  private passesQuickFilter(token: PumpPortalToken): boolean {
    return this.getFilterReason(token).passed;
  }
  
  /**
   * Force an immediate poll
   */
  async forcePoll(): Promise<void> {
    await this.pollCandidates();
  }
  
  /**
   * Check if discovery is running
   */
  get running(): boolean {
    return this.isRunning;
  }
  
  /**
   * Get discovery statistics
   */
  getStats(): {
    running: boolean;
    pollCount: number;
    candidatesFound: number;
    lastPollTime: number;
    queueSize: number;
    currentStrategy: string;
    watchlistSize: number;
    watchlistPromoted: number;
  } {
    return {
      running: this.isRunning,
      pollCount: this.pollCount,
      candidatesFound: this.candidatesFound,
      lastPollTime: this.lastPollTime,
      queueSize: this.queue.size,
      currentStrategy: this.currentStrategy,
      watchlistSize: this.watchlist.size,
      watchlistPromoted: this.watchlistPromoted,
    };
  }
}

// Export default instance with a queue
export function createDiscoveryEngine(queue: CandidateQueue): TokenDiscovery {
  return new TokenDiscovery(queue);
}
