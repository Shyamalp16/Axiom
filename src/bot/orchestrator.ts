/**
 * BOT ORCHESTRATOR
 * Main bot controller that ties everything together
 */

import { BotState, EntrySignal, Position } from '../types/index.js';
import { CONFIG, validateEnv } from '../config/index.js';
import { getWalletBalance, getWallet } from '../utils/solana.js';
import { runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import { 
  generateEntrySignal, 
  displayEntrySignal,
  waitForTranche2Confirmation 
} from '../trading/entry-logic.js';
import {
  calculateTradeSize,
  createPosition,
  addTranche,
  getActivePositions,
  getDailyStats,
  getWeeklyPnl,
  displayPositionStatus,
} from '../trading/position-manager.js';
import { startTPSLMonitoring } from '../trading/tp-sl-manager.js';
import { executeBuy, getTokenBalance } from '../trading/executor.js';
import { startTokenMonitoring, startMonitoringLoop } from '../monitoring/dev-wallet-monitor.js';
import { displayTradeSummary, logTrade } from '../storage/trade-logger.js';
import { fetchTokenInfo } from '../api/data-providers.js';
import logger from '../utils/logger.js';

class TradingBot {
  private state: BotState;
  private stopTPSLMonitoring: (() => void) | null = null;
  private stopDevMonitoring: (() => void) | null = null;
  
  constructor() {
    this.state = {
      isRunning: false,
      isDisabled: false,
      dailyTradeCount: 0,
      dailyPnl: 0,
      weeklyPnl: 0,
      activePositions: [],
      startTime: new Date(),
    };
  }
  
  /**
   * Initialize the bot
   */
  async initialize(): Promise<boolean> {
    logger.header('AXIOM TRADING BOT');
    logger.info('Initializing...');
    
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
      
      logger.success(`Wallet loaded: ${wallet.publicKey.toBase58()}`);
      logger.info(`Balance: ${balance.toFixed(4)} SOL`);
      
      if (balance < CONFIG.positionSizing.MIN_PER_TRADE_SOL + 0.05) {
        logger.error(`Insufficient balance. Need at least ${CONFIG.positionSizing.MIN_PER_TRADE_SOL + 0.05} SOL`);
        return false;
      }
    } catch (error) {
      logger.error('Failed to load wallet', error);
      return false;
    }
    
    logger.success('Bot initialized successfully');
    return true;
  }
  
  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      logger.warn('Bot is already running');
      return;
    }
    
    logger.header('STARTING BOT');
    
    // Start TP/SL monitoring
    this.stopTPSLMonitoring = startTPSLMonitoring(5000);
    
    // Start dev wallet monitoring
    this.stopDevMonitoring = startMonitoringLoop(10000);
    
    this.state.isRunning = true;
    this.state.startTime = new Date();
    
    logger.success('Bot started');
    this.displayStatus();
  }
  
  /**
   * Stop the bot
   */
  stop(): void {
    logger.header('STOPPING BOT');
    
    if (this.stopTPSLMonitoring) {
      this.stopTPSLMonitoring();
      this.stopTPSLMonitoring = null;
    }
    
    if (this.stopDevMonitoring) {
      this.stopDevMonitoring();
      this.stopDevMonitoring = null;
    }
    
    this.state.isRunning = false;
    
    logger.success('Bot stopped');
  }
  
  /**
   * Analyze a token and potentially enter a trade
   */
  async analyzeAndTrade(mintAddress: string): Promise<{
    success: boolean;
    reason: string;
    position?: Position;
  }> {
    if (!this.state.isRunning) {
      return { success: false, reason: 'Bot is not running' };
    }
    
    if (this.state.isDisabled) {
      return { success: false, reason: `Bot disabled: ${this.state.disableReason}` };
    }
    
    logger.header(`ANALYZING TOKEN`);
    logger.info(`Mint: ${mintAddress}`);
    
    // Run pre-trade checklist
    const checklist = await runPreTradeChecklist(mintAddress);
    
    if (!checklist.passed) {
      return {
        success: false,
        reason: `Checklist failed: ${checklist.failedChecks.join(', ')}`,
      };
    }
    
    // Calculate trade size
    const sizeResult = await calculateTradeSize();
    
    if (!sizeResult.allowed) {
      return { success: false, reason: sizeResult.reason || 'Trade size calculation failed' };
    }
    
    // Get token info
    const tokenInfo = await fetchTokenInfo(mintAddress);
    
    // Generate entry signal
    const signal = generateEntrySignal(
      mintAddress,
      tokenInfo.symbol,
      checklist.details.entryAnalysis!,
      sizeResult.size
    );
    
    displayEntrySignal(signal, tokenInfo.symbol);
    
    // Execute tranche 1
    logger.info('\nExecuting Tranche 1...');
    const tranche1Result = await executeBuy(
      mintAddress,
      signal.tranche1Size,
      CONFIG.slippage.BUY_SLIPPAGE_PERCENT
    );
    
    if (!tranche1Result.success) {
      return { success: false, reason: `Tranche 1 failed: ${tranche1Result.error}` };
    }
    
    // Create position
    const position = createPosition(
      mintAddress,
      tokenInfo.symbol,
      signal.entryPrice,
      tranche1Result.amountReceived || 0,
      signal.tranche1Size
    );
    
    // Start monitoring this token
    await startTokenMonitoring(mintAddress);
    
    // Wait and execute tranche 2 if confirmed
    logger.info('\nWaiting for Tranche 2 confirmation...');
    const tranche2Confirm = await waitForTranche2Confirmation(
      mintAddress,
      signal.entryPrice
    );
    
    if (tranche2Confirm.confirmed) {
      logger.info('Tranche 2 confirmed, executing...');
      const tranche2Result = await executeBuy(
        mintAddress,
        signal.tranche2Size,
        CONFIG.slippage.BUY_SLIPPAGE_PERCENT
      );
      
      if (tranche2Result.success) {
        addTranche(position.id, tranche2Confirm.currentPrice, signal.tranche2Size);
      } else {
        logger.warn(`Tranche 2 failed: ${tranche2Result.error}`);
      }
    } else {
      logger.warn('Tranche 2 not confirmed - price not holding');
    }
    
    displayPositionStatus(position);
    
    return {
      success: true,
      reason: 'Trade entered successfully',
      position,
    };
  }
  
  /**
   * Run checklist only (no trade)
   */
  async checkToken(mintAddress: string): Promise<void> {
    await runPreTradeChecklist(mintAddress);
  }
  
  /**
   * Display current bot status
   */
  displayStatus(): void {
    const dailyStats = getDailyStats();
    const weeklyPnl = getWeeklyPnl();
    const positions = getActivePositions();
    
    logger.header('BOT STATUS');
    
    logger.box('State', [
      `Running: ${this.state.isRunning ? '✓' : '✗'}`,
      `Disabled: ${this.state.isDisabled ? `✗ (${this.state.disableReason})` : '✓ No'}`,
      `Uptime: ${this.getUptime()}`,
    ]);
    
    logger.box('Daily Limits', [
      `Trades: ${dailyStats.tradeCount}/${CONFIG.dailyLimits.MAX_TRADES_PER_DAY}`,
      `PnL: ${dailyStats.pnl >= 0 ? '+' : ''}${dailyStats.pnl.toFixed(4)} SOL`,
      `Max Loss: -${CONFIG.dailyLimits.MAX_DAILY_LOSS_SOL} SOL`,
    ]);
    
    logger.box('Weekly', [
      `PnL: ${weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(4)} SOL`,
      `Max Loss: -${CONFIG.weeklyLimits.MAX_WEEKLY_LOSS_SOL} SOL`,
    ]);
    
    if (positions.length > 0) {
      logger.info('\nActive Positions:');
      positions.forEach(p => displayPositionStatus(p));
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
  
  /**
   * Display trading statistics
   */
  showStats(): void {
    displayTradeSummary();
  }
  
  /**
   * Check if bot is running
   */
  isRunning(): boolean {
    return this.state.isRunning;
  }
  
  /**
   * Get bot state
   */
  getState(): BotState {
    return { ...this.state };
  }
}

// Export singleton instance
export const bot = new TradingBot();
export default bot;
