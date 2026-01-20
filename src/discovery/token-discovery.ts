/**
 * TOKEN DISCOVERY ENGINE
 * 
 * Continuously discovers candidate tokens from pump.fun
 * Sources:
 * 1. Polling: searchCoins() every 5 seconds
 * 2. Real-time: subscribeNewTokens() WebSocket
 * 
 * Filters candidates by:
 * - Age: 2-30 minutes (avoid bot wars, not too stale)
 * - Bonding curve progress: 15-85% (not too early, not about to graduate)
 * - Market cap: $8k - $50k
 * - Engagement: minimum 5 trades
 */

import { 
  searchCoins, 
  subscribeNewTokens, 
  connectPumpPortal,
  isConnectedToPumpPortal,
  PumpPortalToken,
  PumpPortalNewToken,
} from '../api/pump-portal.js';
import { CandidateQueue } from './candidate-queue.js';
import logger from '../utils/logger.js';

// Discovery configuration
export const DISCOVERY_CONFIG = {
  // Source
  source: 'pump.fun' as const,
  onlyBondingCurve: true,        // NOT graduated (complete: false)
  
  // Age filtering
  minAgeMinutes: 1,              // Avoid bot wars
  maxAgeMinutes: 30,             // Not too stale
  
  // Bonding curve progress
  minProgress: 0,                // Allow early tokens (was 15%)
  maxProgress: 85,               // Not about to graduate
  
  // Market cap (USD)
  minMarketCap: 3000,       // Lowered from 8k - most bonding curve tokens are $3k-$5k
  maxMarketCap: 50000,
  
  // Activity requirements
  minTradeCount: 1,              // Some engagement
  
  // Polling
  pollIntervalMs: 5000,          // Check every 5 seconds
  pollLimit: 50,                 // Fetch up to 50 tokens per poll
};

/**
 * Token Discovery Class
 */
export class TokenDiscovery {
  private queue: CandidateQueue;
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private unsubscribeNewTokens: (() => void) | null = null;
  private pollCount: number = 0;
  private lastPollTime: number = 0;
  private candidatesFound: number = 0;
  
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
    
    // 1. Start polling for candidates
    this.pollInterval = setInterval(
      () => this.pollCandidates(),
      DISCOVERY_CONFIG.pollIntervalMs
    );
    
    // 2. Subscribe to new token events
    this.unsubscribeNewTokens = subscribeNewTokens((newToken) => {
      this.handleNewToken(newToken);
    });
    
    // 3. Run initial poll immediately
    await this.pollCandidates();
    
    logger.success('Token discovery engine started');
    logger.info(`  Poll interval: ${DISCOVERY_CONFIG.pollIntervalMs / 1000}s`);
    logger.info(`  Age range: ${DISCOVERY_CONFIG.minAgeMinutes}-${DISCOVERY_CONFIG.maxAgeMinutes} min`);
    logger.info(`  Progress range: ${DISCOVERY_CONFIG.minProgress}-${DISCOVERY_CONFIG.maxProgress}%`);
    logger.info(`  Market cap: $${DISCOVERY_CONFIG.minMarketCap}-$${DISCOVERY_CONFIG.maxMarketCap}`);
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
    
    if (this.unsubscribeNewTokens) {
      this.unsubscribeNewTokens();
      this.unsubscribeNewTokens = null;
    }
    
    logger.info('Token discovery engine stopped');
    logger.info(`  Total polls: ${this.pollCount}`);
    logger.info(`  Candidates found: ${this.candidatesFound}`);
  }
  
  /**
   * Poll for candidate tokens
   */
  private async pollCandidates(): Promise<void> {
    if (!this.isRunning) return;
    
    this.pollCount++;
    this.lastPollTime = Date.now();
    
    try {
      // Fetch bonding curve tokens sorted by recent activity
      const tokens = await searchCoins({
        complete: false,  // Only bonding curve tokens (not graduated)
        sort: 'created_timestamp',
        order: 'DESC',
        limit: DISCOVERY_CONFIG.pollLimit,
      });
      
      let added = 0;
      
      // Log all tokens from poll with filter result
      for (const token of tokens) {
        const filterResult = this.getFilterReason(token);
        if (filterResult.passed) {
          const wasAdded = this.queue.add(token, 'poll');
          if (wasAdded) {
            added++;
            this.candidatesFound++;
            logger.info(`✓ ${token.symbol} $${token.marketCapUsd.toFixed(0)} [QUEUED]`);
          } else {
            logger.info(`${token.symbol} $${token.marketCapUsd.toFixed(0)} [already in queue]`);
          }
        } else {
          logger.info(`${token.symbol} $${token.marketCapUsd.toFixed(0)} [${filterResult.reason}]`);
        }
      }
      
      if (added > 0) {
        logger.info(`>>> +${added} new candidates (queue: ${this.queue.size})`);
      }
      
    } catch (error) {
      logger.debug(`Discovery poll failed: ${error}`);
    }
  }
  
  /**
   * Handle new token WebSocket event
   */
  private handleNewToken(newToken: PumpPortalNewToken): void {
    // New tokens are < 1 minute old - too young for our criteria
    // But we log them for awareness
    logger.debug(`New token launched: ${newToken.symbol} (${newToken.mint.slice(0, 8)}...)`);
    
    // We don't add them to queue yet - they'll be picked up by polling
    // once they're old enough (> 2 min)
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
  } {
    return {
      running: this.isRunning,
      pollCount: this.pollCount,
      candidatesFound: this.candidatesFound,
      lastPollTime: this.lastPollTime,
      queueSize: this.queue.size,
    };
  }
}

// Export default instance with a queue
export function createDiscoveryEngine(queue: CandidateQueue): TokenDiscovery {
  return new TokenDiscovery(queue);
}
