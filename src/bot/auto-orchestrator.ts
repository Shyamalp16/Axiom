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
import { CandidateQueue } from '../discovery/candidate-queue.js';
import { TradePipeline, createTradePipeline, PipelineResult, PIPELINE_CONFIG } from '../pipeline/trade-pipeline.js';
import { PriceMonitor, getPriceMonitor, resetPriceMonitor } from '../monitoring/price-monitor.js';
import { getActivePositions, getDailyStats, getWeeklyPnl } from '../trading/position-manager.js';
import { validateEnv } from '../config/index.js';
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
    this.queue = new CandidateQueue(50, 15); // Max 50 candidates, 15 min cooldown
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
      
      if (balance < 0.2) {
        logger.error('Insufficient balance. Need at least 0.2 SOL');
        return false;
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
    
    logger.header('STARTING AUTO-TRADER');
    this.displayConfig();
    
    // Start discovery engine
    await this.discovery.start();
    
    // Start existing position monitoring
    await this.restoreExistingPositions();
    
    logger.success('Auto-trader running');
    logger.info('Press Ctrl+C to stop gracefully\n');
    
    // Main loop
    while (this.state.isRunning && !this.shutdownRequested) {
      try {
        // 1. Get next candidate from queue
        const candidate = this.queue.getNext();
        
        if (candidate) {
          this.state.lastActivityTime = Date.now();
          
          // 2. Process through pipeline
          const result = await this.pipeline.process(candidate);
          
          if (result.entered && result.position) {
            // 3. Start price monitoring for the new position
            this.priceMonitor.startMonitoring(candidate.mint, result.position);
          }
        }
        
        // 4. Periodic status log (every 30 seconds if idle)
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
   */
  private async restoreExistingPositions(): Promise<void> {
    const positions = getActivePositions();
    
    if (positions.length > 0) {
      logger.info(`Restoring monitoring for ${positions.length} existing position(s)...`);
      
      for (const position of positions) {
        this.priceMonitor.startMonitoring(position.mint, position);
      }
    }
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
   * Display current configuration
   */
  private displayConfig(): void {
    logger.box('Configuration', [
      `Discovery interval: ${DISCOVERY_CONFIG.pollIntervalMs / 1000}s`,
      `Age range: ${DISCOVERY_CONFIG.minAgeMinutes}-${DISCOVERY_CONFIG.maxAgeMinutes} min`,
      `Progress range: ${DISCOVERY_CONFIG.minProgress}-${DISCOVERY_CONFIG.maxProgress}%`,
      `Market cap: $${DISCOVERY_CONFIG.minMarketCap}-$${DISCOVERY_CONFIG.maxMarketCap}`,
      `Max positions: ${PIPELINE_CONFIG.maxOpenPositions}`,
      `Trade cooldown: ${PIPELINE_CONFIG.tradeCooldownMs / 1000}s`,
    ]);
  }
  
  /**
   * Log periodic status
   */
  private logStatus(): void {
    const dailyStats = getDailyStats();
    const positions = getActivePositions();
    const queueStats = this.queue.getStats();
    
    logger.info(`Status: ${positions.length} position(s) | Queue: ${queueStats.queueSize} | Daily trades: ${dailyStats.tradeCount}`);
  }
  
  /**
   * Display final statistics
   */
  private displayFinalStats(): void {
    const runtime = (Date.now() - this.state.startTime.getTime()) / 1000 / 60;
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
    const dailyStats = getDailyStats();
    const weeklyPnl = getWeeklyPnl();
    const positions = getActivePositions();
    const queueStats = this.queue.getStats();
    const discoveryStats = this.discovery.getStats();
    const pipelineStats = this.pipeline.getStats();
    const monitorStatus = this.priceMonitor.getStatus();
    
    logger.header('BOT STATUS');
    
    logger.box('State', [
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
    
    logger.box('Limits', [
      `Daily trades: ${dailyStats.tradeCount}/${PIPELINE_CONFIG.maxDailyTrades}`,
      `Daily PnL: ${dailyStats.pnl >= 0 ? '+' : ''}${dailyStats.pnl.toFixed(4)} SOL`,
      `Weekly PnL: ${weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(4)} SOL`,
    ]);
    
    if (positions.length > 0) {
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
