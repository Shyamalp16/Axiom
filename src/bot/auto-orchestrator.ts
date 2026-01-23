/**
 * AUTO-ORCHESTRATOR
 * 
 * Main autonomous trading loop that ties everything together:
 * - Token discovery (continuous candidate sourcing)
 * - Candidate queue (prioritization and deduplication)
 * - Trade pipeline (analysis and execution)
 * - Price monitoring (TP/SL on every trade event)
 * 
 * Graceful shutdown on SIGINT/SIGTERM
 */

import { TokenDiscovery, createDiscoveryEngine, DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import { CandidateQueue, candidateQueue } from '../discovery/candidate-queue.js';
import { TradePipeline, createTradePipeline, PipelineResult, PIPELINE_CONFIG } from '../pipeline/trade-pipeline.js';
import { PriceMonitor, getPriceMonitor, resetPriceMonitor } from '../monitoring/price-monitor.js';
import { getActivePositions, getDailyStats, getWeeklyPnl } from '../trading/position-manager.js';
import { getPaperPortfolio, loadPaperTrades, displayPaperSummary, getPaperTrades } from '../trading/paper-trader.js';
import { Position } from '../types/index.js';
import { validateEnv, PAPER_TRADING } from '../config/index.js';
import { getWalletBalance, getWallet, sleep } from '../utils/solana.js';
import { connectPumpPortal, isConnectedToPumpPortal } from '../api/pump-portal.js';
import logger from '../utils/logger.js';

// Bot state
interface BotState {
  isRunning: boolean;
  startTime: Date;
  tradesEntered: number;
  tradesRejected: number;
  lastActivityTime: number;
}

/**
 * Auto Trading Bot Class
 */
export class AutoTradingBot {
  private discovery: TokenDiscovery;
  private queue: CandidateQueue;
  private pipeline: TradePipeline;
  private priceMonitor: PriceMonitor;
  private state: BotState;
  private shutdownRequested: boolean = false;
  
  constructor() {
    // Initialize components
    this.queue = new CandidateQueue(50, 0.167); // Max 50 candidates, 10 sec cooldown (testing)
    this.discovery = createDiscoveryEngine(this.queue);
    this.pipeline = createTradePipeline(this.queue, {
      onTradeEntered: (result) => this.handleTradeEntered(result),
      onTradeRejected: (result) => this.handleTradeRejected(result),
    });
    this.priceMonitor = getPriceMonitor({
      onPriceUpdate: (mint, price, position) => {
        logger.debug(`Price update: ${position.symbol} @ ${price.priceSol.toExponential(4)} SOL`);
      },
      onTPHit: (mint, level, position) => {
        logger.alert('info', `TP${level} hit for ${position.symbol}!`);
      },
      onSLHit: (mint, position) => {
        logger.alert('danger', `Stop loss hit for ${position.symbol}!`);
      },
      onRunnerExit: (mint, position) => {
        logger.alert('info', `Runner exit for ${position.symbol}`);
      },
      onExitExecuted: (mint, reason, pnl) => {
        logger.trade('SELL', `Exit: ${reason} - PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
        // Mark token as recently exited in THIS queue to prevent re-entry
        this.queue.markRejected(mint, `exited_${reason}`);
        logger.info(`📝 Token marked for 15-min cooldown (no re-entry)`);
      },
    });
    
    this.state = {
      isRunning: false,
      startTime: new Date(),
      tradesEntered: 0,
      tradesRejected: 0,
      lastActivityTime: Date.now(),
    };
  }
  
  /**
   * Initialize the bot
   */
  async initialize(): Promise<boolean> {
    logger.header('AXIOM AUTO-TRADER');
    
    // Show paper trading mode banner
    if (PAPER_TRADING.ENABLED) {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║     📝 PAPER TRADING MODE ACTIVE                              ║
║     No real transactions will be executed                     ║
║     All trades are simulated for testing                      ║
╚═══════════════════════════════════════════════════════════════╝
      `);
      // Load existing paper trades
      loadPaperTrades();
      
      // Mark recently traded tokens as rejected to prevent re-entry
      this.markRecentlyTradedTokens();
    }
    
    logger.info('Initializing autonomous trading bot...');
    
    // Validate environment
    const envCheck = validateEnv();
    if (!envCheck.valid) {
      logger.error('Environment validation failed:');
      envCheck.errors.forEach(e => logger.error(`  - ${e}`));
      return false;
    }
    
    // Check wallet
    try {
      const wallet = getWallet();
      const balance = await getWalletBalance();
      
      logger.success(`Wallet: ${wallet.publicKey.toBase58()}`);
      logger.info(`Balance: ${balance.toFixed(4)} SOL`);
      
      if (PAPER_TRADING.ENABLED) {
        // Show paper portfolio instead
        const portfolio = getPaperPortfolio();
        logger.info(`📝 Paper Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
        logger.info(`📝 Paper P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`);
      } else {
        if (balance < 0.1) {
          logger.error('Insufficient balance. Need at least 0.2 SOL');
          return false;
        }
      }
    } catch (error) {
      logger.error('Failed to load wallet', error);
      return false;
    }
    
    // Connect to PumpPortal
    try {
      if (!isConnectedToPumpPortal()) {
        await connectPumpPortal();
      }
      logger.success('PumpPortal connected');
    } catch (error) {
      logger.error('Failed to connect to PumpPortal', error);
      return false;
    }
    
    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();
    
    logger.success('Bot initialized successfully');
    if (PAPER_TRADING.ENABLED) {
      logger.info('📝 Running in PAPER TRADING mode - no real funds at risk');
    }
    return true;
  }
  
  /**
   * Start the autonomous trading loop
   */
  async run(): Promise<void> {
    if (this.state.isRunning) {
      logger.warn('Bot is already running');
      return;
    }
    
    this.state.isRunning = true;
    this.state.startTime = new Date();
    this.shutdownRequested = false;
    
    logger.header(PAPER_TRADING.ENABLED ? 'STARTING AUTO-TRADER (PAPER MODE)' : 'STARTING AUTO-TRADER');
    this.displayConfig();
    
    // Restore existing position monitoring FIRST (before discovery)
    const hasExistingPositions = await this.restoreExistingPositions();
    
    // Only start discovery if no positions to monitor
    if (!hasExistingPositions) {
      await this.discovery.start();
    } else {
      logger.info('📝 Existing position(s) found - skipping discovery, monitoring only');
    }
    
    logger.success(PAPER_TRADING.ENABLED ? '📝 Paper auto-trader running' : 'Auto-trader running');
    logger.info('Press Ctrl+C to stop gracefully\n');
    
    // Main loop
    while (this.state.isRunning && !this.shutdownRequested) {
      try {
        // Check if we have an open position - if so, skip discovery and just monitor
        const hasOpenPosition = this.priceMonitor.monitoredCount > 0;
        
        if (hasOpenPosition) {
          // Position is open - just wait for price monitor to handle TP/SL
          // Discovery is paused to focus on the current position
          if (this.discovery.running) {
            logger.info('📝 Position open - pausing discovery to focus on monitoring');
            this.discovery.stop();
          }
        } else {
          // No position - ensure discovery is running
          if (!this.discovery.running) {
            logger.info('📝 No open positions - resuming discovery');
            await this.discovery.start();
          }
          
          // 1. Get next candidate from queue
          const candidate = this.queue.getNext();
          
          if (candidate) {
            this.state.lastActivityTime = Date.now();
            
            // 2. Process through pipeline
            const result = await this.pipeline.process(candidate);
            
            if (result.entered && result.position) {
              // 3. Start price monitoring for the new position (async - uses Helius on-chain if available)
              await this.priceMonitor.startMonitoring(candidate.mint, result.position);
              
              // 4. Stop discovery while position is open
              logger.info('📝 Position entered - stopping discovery to focus on monitoring');
              this.discovery.stop();
            }
          }
        }
        
        // 5. Periodic status log (every 30 seconds if idle)
        if (Date.now() - this.state.lastActivityTime > 30000) {
          this.logStatus();
          this.state.lastActivityTime = Date.now();
        }
        
        // 5. Cleanup expired rejections periodically
        this.queue.cleanupExpiredRejections();
        
        // 6. Small sleep to prevent CPU spin
        await sleep(100);
        
      } catch (error) {
        logger.error('Main loop error:', error);
        await sleep(1000); // Wait a bit before continuing
      }
    }
    
    // Shutdown sequence
    await this.shutdown();
  }
  
  /**
   * Request graceful shutdown
   */
  stop(): void {
    if (!this.state.isRunning) return;
    
    logger.info('Shutdown requested...');
    this.shutdownRequested = true;
  }
  
  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    logger.header('SHUTTING DOWN');
    
    // Stop discovery
    this.discovery.stop();
    logger.info('Discovery stopped');
    
    // Note: We don't stop price monitoring - positions continue to be monitored
    // User can manually exit remaining positions
    const activePositions = getActivePositions();
    if (activePositions.length > 0) {
      logger.warn(`${activePositions.length} position(s) still active - monitoring continues`);
      logger.info('Manually exit positions or restart the bot');
    } else {
      // Only stop price monitor if no positions
      this.priceMonitor.stopAll();
      logger.info('Price monitoring stopped');
    }
    
    this.state.isRunning = false;
    
    // Final stats
    this.displayFinalStats();
    
    logger.success('Bot stopped');
  }
  
  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handler = () => {
      if (this.shutdownRequested) {
        // Second Ctrl+C = force exit
        logger.warn('Force exit requested');
        process.exit(1);
      }
      this.stop();
    };
    
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }
  
  /**
   * Restore monitoring for existing positions
   * @returns true if positions were restored
   */
  private async restoreExistingPositions(): Promise<boolean> {
    // Check paper trading positions first
    if (PAPER_TRADING.ENABLED) {
      const portfolio = getPaperPortfolio();
      
      if (portfolio.positions.size > 0) {
        logger.info(`📝 Restoring monitoring for ${portfolio.positions.size} paper position(s)...`);
        
        for (const [mint, paperPos] of portfolio.positions) {
          // Convert paper position to Position format for price monitor
          const position: Position = {
            id: `paper_${mint}`,
            mint,
            symbol: paperPos.symbol,
            entryPrice: paperPos.avgEntryPrice,
            currentPrice: paperPos.avgEntryPrice,
            quantity: paperPos.tokenAmount,
            costBasis: paperPos.costBasis,
            unrealizedPnl: 0,
            unrealizedPnlPercent: 0,
            highestPrice: paperPos.avgEntryPrice,
            entryTime: new Date(paperPos.entryTime),
            tranches: [{
              size: paperPos.costBasis,
              price: paperPos.avgEntryPrice,
              timestamp: new Date(paperPos.entryTime),
            }],
            tpLevelsHit: [],
            status: 'active',
          };
          
          await this.priceMonitor.startMonitoring(mint, position);
          logger.info(`📝 Monitoring restored for ${paperPos.symbol}`);
        }
        
        return true;
      }
      
      return false;
    }
    
    // Real trading positions
    const positions = getActivePositions();
    
    if (positions.length > 0) {
      logger.info(`Restoring monitoring for ${positions.length} existing position(s)...`);
      
      for (const position of positions) {
        await this.priceMonitor.startMonitoring(position.mint, position);
      }
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Handle trade entered event
   */
  private handleTradeEntered(result: PipelineResult): void {
    this.state.tradesEntered++;
    logger.success(`Trade entered: ${result.symbol} (Total: ${this.state.tradesEntered})`);
  }
  
  /**
   * Handle trade rejected event
   */
  private handleTradeRejected(result: PipelineResult): void {
    this.state.tradesRejected++;
    logger.debug(`Trade rejected: ${result.symbol} - ${result.reason}`);
  }
  
  /**
   * Mark recently traded tokens as rejected to prevent re-entry
   * Checks paper trade history for tokens traded within cooldown period
   */
  private markRecentlyTradedTokens(): void {
    const trades = getPaperTrades();
    const cooldownMs = 15 * 60 * 1000; // 15 minutes
    const now = Date.now();
    
    // Find unique mints that were traded recently
    const recentlyTraded = new Set<string>();
    
    for (const trade of trades) {
      const tradeTime = new Date(trade.timestamp).getTime();
      if (now - tradeTime < cooldownMs) {
        recentlyTraded.add(trade.mint);
      }
    }
    
    // Mark them as rejected in THIS bot's queue (not the singleton)
    if (recentlyTraded.size > 0) {
      logger.info(`📝 Marking ${recentlyTraded.size} recently traded token(s) for cooldown...`);
      for (const mint of recentlyTraded) {
        this.queue.markRejected(mint, 'recently_traded_startup');
      }
    }
  }
  
  /**
   * Display current configuration
   */
  private displayConfig(): void {
    const configItems = [
      `Mode: ${PAPER_TRADING.ENABLED ? '📝 PAPER TRADING' : '💰 LIVE TRADING'}`,
      `Discovery interval: ${DISCOVERY_CONFIG.pollIntervalMs / 1000}s`,
      `Age range: ${DISCOVERY_CONFIG.minAgeMinutes}-${DISCOVERY_CONFIG.maxAgeMinutes} min`,
      `Progress range: ${DISCOVERY_CONFIG.minProgress}-${DISCOVERY_CONFIG.maxProgress}%`,
      `Market cap: $${DISCOVERY_CONFIG.minMarketCap}-$${DISCOVERY_CONFIG.maxMarketCap}`,
      `Max positions: ${PIPELINE_CONFIG.maxOpenPositions}`,
      `Trade cooldown: ${PIPELINE_CONFIG.tradeCooldownMs / 1000}s`,
    ];
    
    if (PAPER_TRADING.ENABLED) {
      const portfolio = getPaperPortfolio();
      configItems.push(`Paper balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
    }
    
    logger.box('Configuration', configItems);
  }
  
  /**
   * Log periodic status
   */
  private logStatus(): void {
    const queueStats = this.queue.getStats();
    
    if (PAPER_TRADING.ENABLED) {
      const portfolio = getPaperPortfolio();
      const positionCount = portfolio.positions.size;
      const monitoredCount = this.priceMonitor.monitoredCount;
      logger.info(`Status: ${positionCount} position(s) | Monitoring: ${monitoredCount} | Queue: ${queueStats.queueSize} | Paper trades: ${portfolio.totalTrades}`);
    } else {
      const dailyStats = getDailyStats();
      const positions = getActivePositions();
      logger.info(`Status: ${positions.length} position(s) | Queue: ${queueStats.queueSize} | Daily trades: ${dailyStats.tradeCount}`);
    }
  }
  
  /**
   * Display final statistics
   */
  private displayFinalStats(): void {
    const runtime = (Date.now() - this.state.startTime.getTime()) / 1000 / 60;
    
    if (PAPER_TRADING.ENABLED) {
      const portfolio = getPaperPortfolio();
      const roi = ((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100);
      
      logger.box('📝 Paper Trading Session Summary', [
        `Runtime: ${runtime.toFixed(1)} minutes`,
        `Trades entered: ${this.state.tradesEntered}`,
        `Trades rejected: ${this.state.tradesRejected}`,
        ``,
        `Starting Balance: ${portfolio.startingBalanceSOL.toFixed(4)} SOL`,
        `Final Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`,
        `Total P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`,
        `ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
        `Win Rate: ${portfolio.winRate.toFixed(1)}%`,
      ]);
      
      // Also display full paper summary
      displayPaperSummary();
    } else {
      const dailyStats = getDailyStats();
      const weeklyPnl = getWeeklyPnl();
      
      logger.box('Session Summary', [
        `Runtime: ${runtime.toFixed(1)} minutes`,
        `Trades entered: ${this.state.tradesEntered}`,
        `Trades rejected: ${this.state.tradesRejected}`,
        `Daily PnL: ${dailyStats.pnl >= 0 ? '+' : ''}${dailyStats.pnl.toFixed(4)} SOL`,
        `Weekly PnL: ${weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(4)} SOL`,
      ]);
    }
  }
  
  /**
   * Get current bot state
   */
  getState(): BotState {
    return { ...this.state };
  }
  
  /**
   * Check if bot is running
   */
  isRunning(): boolean {
    return this.state.isRunning;
  }
  
  /**
   * Display current status
   */
  displayStatus(): void {
    const queueStats = this.queue.getStats();
    const discoveryStats = this.discovery.getStats();
    const pipelineStats = this.pipeline.getStats();
    const monitorStatus = this.priceMonitor.getStatus();
    
    logger.header(PAPER_TRADING.ENABLED ? '📝 PAPER BOT STATUS' : 'BOT STATUS');
    
    logger.box('State', [
      `Mode: ${PAPER_TRADING.ENABLED ? '📝 PAPER TRADING' : '💰 LIVE TRADING'}`,
      `Running: ${this.state.isRunning ? 'Yes' : 'No'}`,
      `Uptime: ${this.getUptime()}`,
      `Trades entered: ${this.state.tradesEntered}`,
      `Trades rejected: ${this.state.tradesRejected}`,
    ]);
    
    logger.box('Discovery', [
      `Active: ${discoveryStats.running ? 'Yes' : 'No'}`,
      `Polls: ${discoveryStats.pollCount}`,
      `Candidates found: ${discoveryStats.candidatesFound}`,
    ]);
    
    logger.box('Queue', [
      `Size: ${queueStats.queueSize}`,
      `Rejected (cooldown): ${queueStats.rejectedCount}`,
      `Processed: ${queueStats.processedCount}`,
      `Top candidate: ${queueStats.topCandidate?.symbol || 'None'}`,
    ]);
    
    logger.box('Pipeline', [
      `Processing: ${pipelineStats.currentlyProcessing}`,
      `Cooldown: ${pipelineStats.timeSinceLastTrade >= 0 
        ? `${Math.floor(pipelineStats.timeSinceLastTrade / 1000)}s ago` 
        : 'Ready'}`,
    ]);
    
    if (PAPER_TRADING.ENABLED) {
      const portfolio = getPaperPortfolio();
      const roi = ((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100);
      
      logger.box('📝 Paper Portfolio', [
        `Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`,
        `Total P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`,
        `ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
        `Wins/Losses: ${portfolio.wins}/${portfolio.losses}`,
        `Win Rate: ${portfolio.winRate.toFixed(1)}%`,
        `Open Positions: ${portfolio.positions.size}`,
      ]);
    } else {
      const dailyStats = getDailyStats();
      const weeklyPnl = getWeeklyPnl();
      
      logger.box('Limits', [
        `Daily trades: ${dailyStats.tradeCount}/${PIPELINE_CONFIG.maxDailyTrades}`,
        `Daily PnL: ${dailyStats.pnl >= 0 ? '+' : ''}${dailyStats.pnl.toFixed(4)} SOL`,
        `Weekly PnL: ${weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(4)} SOL`,
      ]);
    }
    
    const positions = PAPER_TRADING.ENABLED ? Array.from(getPaperPortfolio().positions.values()) : getActivePositions();
    
    if (positions.length > 0 || monitorStatus.length > 0) {
      logger.info('\nActive Positions:');
      for (const status of monitorStatus) {
        const emoji = status.pnlPercent >= 0 ? '📈' : '📉';
        const tpStatus = status.tpLevelsHit.length > 0 
          ? `TP${status.tpLevelsHit.join(',')} hit` 
          : 'No TP hit';
        logger.info(`  ${emoji} ${status.symbol}: ${status.pnlPercent >= 0 ? '+' : ''}${status.pnlPercent.toFixed(1)}% (${tpStatus})`);
      }
    } else {
      logger.info('\nNo active positions');
    }
  }
  
  /**
   * Get formatted uptime
   */
  private getUptime(): string {
    const seconds = Math.floor((Date.now() - this.state.startTime.getTime()) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
  }
}

// Export singleton instance
let botInstance: AutoTradingBot | null = null;

export function getAutoTradingBot(): AutoTradingBot {
  if (!botInstance) {
    botInstance = new AutoTradingBot();
  }
  return botInstance;
}

export function resetAutoTradingBot(): void {
  if (botInstance) {
    botInstance.stop();
    resetPriceMonitor();
    botInstance = null;
  }
}
