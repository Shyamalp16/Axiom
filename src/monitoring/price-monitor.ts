/**
 * PRICE MONITOR - High-Frequency WebSocket-Based Price Tracking
 * 
 * Monitors token prices via PumpPortal WebSocket trade events
 * Checks TP/SL conditions on EVERY trade event (not on a timer)
 * 
 * Data source: PumpPortal subscribeTokenTrades()
 * Price calculation: vSolInBondingCurve / vTokensInBondingCurve
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Position, OrderReason } from '../types/index.js';
import { STOP_LOSS, TAKE_PROFIT, TIME_KILL_SWITCH, PAPER_TRADING } from '../config/index.js';
import { subscribeTokenTrades, PumpPortalTrade, getSolPrice } from '../api/pump-portal.js';
import { updatePosition, closePosition, getPosition } from '../trading/position-manager.js';
import { paperSell, getPaperPortfolio } from '../trading/paper-trader.js';
import { candidateQueue } from '../discovery/candidate-queue.js';
import { sellOnPumpFun } from '../api/pump-fun.js';
import { executeSell } from '../trading/executor.js';
import logger from '../utils/logger.js';

// Price data structure
export interface PriceData {
  priceSol: number;
  priceUsd: number;
  marketCapSol: number;
  marketCapUsd: number;
  timestamp: number;
  source: 'websocket' | 'api';
}

// TP/SL check result
interface TPSLCheckResult {
  shouldExit: boolean;
  reason: OrderReason | null;
  percentToSell: number;
  message: string;
}

// Callbacks for price monitor events
export interface PriceMonitorCallbacks {
  onPriceUpdate?: (mint: string, price: PriceData, position: Position) => void;
  onTPHit?: (mint: string, level: 1 | 2, position: Position) => void;
  onSLHit?: (mint: string, position: Position) => void;
  onRunnerExit?: (mint: string, position: Position) => void;
  onExitExecuted?: (mint: string, reason: OrderReason, pnl: number) => void;
}

// Monitored position state
interface MonitoredPosition {
  position: Position;
  unsubscribe: () => void;
  lastPriceUpdate: number;
  lastHigherHighTime: number;
}

/**
 * Price Monitor Class
 * Monitors positions via WebSocket and executes TP/SL automatically
 */
export class PriceMonitor {
  private monitored: Map<string, MonitoredPosition> = new Map();
  private callbacks: PriceMonitorCallbacks;
  private solPrice: number = 150; // Cached SOL price
  private solPriceLastUpdate: number = 0;
  private isProcessingExit: Map<string, boolean> = new Map(); // Prevent duplicate exits
  
  constructor(callbacks: PriceMonitorCallbacks = {}) {
    this.callbacks = callbacks;
    this.refreshSolPrice();
  }
  
  /**
   * Start monitoring a position
   */
  startMonitoring(mint: string, position: Position): void {
    if (this.monitored.has(mint)) {
      logger.debug(`Already monitoring ${mint.slice(0, 8)}...`);
      return;
    }
    
    logger.info(`Starting price monitor for ${position.symbol} (${mint.slice(0, 8)}...)`);
    logger.debug(`Subscribing to trade events for mint: ${mint}`);
    
    // Subscribe to trade events for this token
    const unsubscribe = subscribeTokenTrades([mint], (trade: PumpPortalTrade) => {
      logger.debug(`Trade event received for ${position.symbol}: ${trade.txType} ${trade.tokenAmount} tokens`);
      this.handleTradeEvent(mint, trade);
    });
    
    this.monitored.set(mint, {
      position,
      unsubscribe,
      lastPriceUpdate: Date.now(),
      lastHigherHighTime: Date.now(),
    });
    
    logger.success(`Price monitor active for ${position.symbol}`);
  }
  
  /**
   * Stop monitoring a position
   */
  stopMonitoring(mint: string): void {
    const monitored = this.monitored.get(mint);
    if (monitored) {
      monitored.unsubscribe();
      this.monitored.delete(mint);
      this.isProcessingExit.delete(mint);
      logger.info(`Stopped monitoring ${mint.slice(0, 8)}...`);
    }
  }
  
  /**
   * Stop monitoring all positions
   */
  stopAll(): void {
    for (const [mint] of this.monitored) {
      this.stopMonitoring(mint);
    }
    logger.info('All price monitors stopped');
  }
  
  /**
   * Get current price for a monitored token
   */
  getCurrentPrice(mint: string): number | null {
    const monitored = this.monitored.get(mint);
    return monitored?.position.currentPrice || null;
  }
  
  /**
   * Check if a token is being monitored
   */
  isMonitoring(mint: string): boolean {
    return this.monitored.has(mint);
  }
  
  /**
   * Get count of monitored positions
   */
  get monitoredCount(): number {
    return this.monitored.size;
  }
  
  /**
   * Handle incoming trade event from WebSocket
   */
  private async handleTradeEvent(mint: string, trade: PumpPortalTrade): Promise<void> {
    const monitored = this.monitored.get(mint);
    if (!monitored) {
      logger.debug(`Trade event for unmonitored token: ${mint.slice(0, 8)}...`);
      return;
    }
    
    // Get latest position state
    let position: Position;
    
    if (PAPER_TRADING.ENABLED) {
      // Paper trading: check if position still exists in paper portfolio
      const portfolio = getPaperPortfolio();
      const paperPos = portfolio.positions.get(mint);
      if (!paperPos) {
        logger.warn(`📝 [PAPER] Position not found in portfolio for ${mint.slice(0, 8)}... - stopping monitor`);
        this.stopMonitoring(mint);
        return;
      }
      // Use the monitored position (we update it locally)
      position = monitored.position;
    } else {
      // Real trading: get from position manager
      const realPosition = getPosition(monitored.position.id);
      if (!realPosition || realPosition.status === 'closed') {
        this.stopMonitoring(mint);
        return;
      }
      position = realPosition;
    }
    
    // Calculate current price from bonding curve reserves
    // Handle both raw lamports and already-converted values
    let vSol = trade.vSolInBondingCurve;
    let vTokens = trade.vTokensInBondingCurve;
    
    // Smart unit conversion (same logic as pump-portal.ts)
    if (vSol > 1e9) {
      vSol = vSol / LAMPORTS_PER_SOL;
    }
    if (vTokens > 1e12) {
      vTokens = vTokens / 1e6;
    }
    
    // Sanity check
    if (vSol <= 0 || vTokens <= 0) {
      logger.debug(`Invalid reserves in trade event: vSol=${vSol}, vTokens=${vTokens}`);
      return;
    }
    
    const priceSol = vSol / vTokens;
    
    // Get market cap
    let marketCapSol = trade.marketCapSol;
    if (marketCapSol > 1e9) {
      marketCapSol = marketCapSol / LAMPORTS_PER_SOL;
    }
    
    // Refresh SOL price periodically
    await this.refreshSolPrice();
    
    const priceData: PriceData = {
      priceSol,
      priceUsd: priceSol * this.solPrice,
      marketCapSol,
      marketCapUsd: marketCapSol * this.solPrice,
      timestamp: Date.now(),
      source: 'websocket',
    };
    
    // Update position state
    position.currentPrice = priceSol;
    position.highestPrice = Math.max(position.highestPrice, priceSol);
    
    // Track higher high for time stop
    if (priceSol > monitored.position.highestPrice) {
      monitored.lastHigherHighTime = Date.now();
    }
    
    // Calculate PnL
    const pnlPercent = ((priceSol - position.entryPrice) / position.entryPrice) * 100;
    position.unrealizedPnlPercent = pnlPercent;
    position.unrealizedPnl = position.costBasis * (pnlPercent / 100);
    
    // Update position in manager
    updatePosition(position.id, priceSol);
    
    // Update monitored state
    monitored.position = position;
    monitored.lastPriceUpdate = Date.now();
    
    // Callback for price update
    this.callbacks.onPriceUpdate?.(mint, priceData, position);
    
    // Check TP/SL conditions on EVERY price update
    await this.checkTPSLAndExecute(mint, position, monitored.lastHigherHighTime);
  }
  
  /**
   * Check TP/SL conditions and execute exits
   */
  private async checkTPSLAndExecute(
    mint: string,
    position: Position,
    lastHigherHighTime: number
  ): Promise<void> {
    // Prevent duplicate exit processing
    if (this.isProcessingExit.get(mint)) {
      return;
    }
    
    const pnlPercent = position.unrealizedPnlPercent;
    const currentPrice = position.currentPrice;
    
    // 1. Check HARD STOP LOSS (-6%)
    if (pnlPercent <= STOP_LOSS.HARD_STOP_PERCENT) {
      await this.executeExit(mint, position, 'stop_loss', 100, 
        `STOP LOSS HIT: ${pnlPercent.toFixed(1)}%`);
      return;
    }
    
    // 2. Check TIME STOP (no higher high in X minutes while negative)
    const noHigherHighMinutes = (Date.now() - lastHigherHighTime) / 1000 / 60;
    if (noHigherHighMinutes >= STOP_LOSS.TIME_STOP_MINUTES && pnlPercent < 0) {
      await this.executeExit(mint, position, 'time_stop', 100,
        `TIME STOP: No higher high in ${noHigherHighMinutes.toFixed(0)} minutes`);
      return;
    }
    
    // 3. Check KILL SWITCH (not profitable after X minutes)
    const timeInTradeMinutes = (Date.now() - position.entryTime.getTime()) / 1000 / 60;
    if (timeInTradeMinutes >= TIME_KILL_SWITCH.MAX_UNPROFITABLE_MINUTES && pnlPercent <= 0) {
      await this.executeExit(mint, position, 'time_stop', 100,
        `KILL SWITCH: Not profitable after ${timeInTradeMinutes.toFixed(0)} minutes`);
      return;
    }
    
    // 4. Check TP1 (+20%)
    if (pnlPercent >= TAKE_PROFIT.TP1_PERCENT && !position.tpLevelsHit.includes(1)) {
      position.tpLevelsHit.push(1);
      this.callbacks.onTPHit?.(mint, 1, position);
      await this.executeExit(mint, position, 'tp1', TAKE_PROFIT.TP1_SELL_PERCENT,
        `TP1 HIT: +${pnlPercent.toFixed(1)}% - Selling ${TAKE_PROFIT.TP1_SELL_PERCENT}%`);
      return;
    }
    
    // 5. Check TP2 (+35%)
    if (pnlPercent >= TAKE_PROFIT.TP2_PERCENT && !position.tpLevelsHit.includes(2)) {
      position.tpLevelsHit.push(2);
      this.callbacks.onTPHit?.(mint, 2, position);
      await this.executeExit(mint, position, 'tp2', TAKE_PROFIT.TP2_SELL_PERCENT,
        `TP2 HIT: +${pnlPercent.toFixed(1)}% - Selling ${TAKE_PROFIT.TP2_SELL_PERCENT}%`);
      return;
    }
    
    // 6. Check RUNNER TRAILING STOP (-10% from high)
    if (position.tpLevelsHit.includes(2)) {
      const dropFromHigh = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
      
      if (dropFromHigh >= Math.abs(TAKE_PROFIT.RUNNER_TRAILING_STOP_PERCENT)) {
        this.callbacks.onRunnerExit?.(mint, position);
        await this.executeExit(mint, position, 'runner_exit', 100,
          `RUNNER TRAILING STOP: -${dropFromHigh.toFixed(1)}% from high`);
        return;
      }
    }
  }
  
  /**
   * Execute an exit trade
   */
  private async executeExit(
    mint: string,
    position: Position,
    reason: OrderReason,
    percentToSell: number,
    message: string
  ): Promise<void> {
    // Mark as processing to prevent duplicates
    this.isProcessingExit.set(mint, true);
    
    try {
      // Log the exit signal
      const isStopLoss = reason.includes('stop');
      logger.alert(isStopLoss ? 'danger' : 'info', message);
      
      // Paper trading mode
      if (PAPER_TRADING.ENABLED) {
        await this.executePaperExit(mint, position, reason, percentToSell);
        return;
      }
      
      // Real trading mode
      // Calculate amount to sell
      const quantityToSell = position.quantity * (percentToSell / 100);
      
      // Execute the sell
      // Try pump.fun first (for bonding curve tokens), falls back handled by executor
      const result = await executeSell(
        mint,
        quantityToSell,
        isStopLoss ? 18 : 12, // Higher slippage for stop loss
        isStopLoss
      );
      
      if (result.success) {
        // Update position via position manager
        const { pnl } = closePosition(position.id, position.currentPrice, percentToSell, reason);
        
        logger.success(`Exit executed: ${reason} - PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
        
        // Callback
        this.callbacks.onExitExecuted?.(mint, reason, pnl);
        
        // Stop monitoring if position fully closed
        if (percentToSell >= 100) {
          this.stopMonitoring(mint);
          // Mark token as recently traded to prevent re-entry
          candidateQueue.markRejected(mint, `recently_exited_${reason}`);
        }
      } else {
        logger.error(`Exit failed: ${result.error}`);
      }
    } catch (error) {
      logger.error(`Exit execution error: ${error}`);
    } finally {
      this.isProcessingExit.set(mint, false);
    }
  }
  
  /**
   * Execute a paper trading exit (simulation)
   */
  private async executePaperExit(
    mint: string,
    position: Position,
    reason: OrderReason,
    percentToSell: number
  ): Promise<void> {
    try {
      // Execute paper sell
      const paperTrade = await paperSell(
        mint,
        position.symbol,
        percentToSell,
        reason
      );
      
      if (paperTrade) {
        const pnl = paperTrade.pnl || 0;
        logger.success(`📝 [PAPER] Exit executed: ${reason} - PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`);
        
        // Callback
        this.callbacks.onExitExecuted?.(mint, reason, pnl);
        
        // Stop monitoring if position fully closed
        if (percentToSell >= 100) {
          this.stopMonitoring(mint);
          // Mark token as recently traded to prevent re-entry
          candidateQueue.markRejected(mint, `recently_exited_${reason}`);
          logger.info(`📝 Token ${position.symbol} marked for cooldown (no re-entry for 15 min)`);
        }
      } else {
        logger.warn(`📝 [PAPER] No position found to sell for ${position.symbol}`);
      }
    } catch (error) {
      logger.error(`📝 [PAPER] Exit execution error: ${error}`);
    } finally {
      this.isProcessingExit.set(mint, false);
    }
  }
  
  /**
   * Refresh cached SOL price
   */
  private async refreshSolPrice(): Promise<void> {
    const now = Date.now();
    // Refresh every 30 seconds
    if (now - this.solPriceLastUpdate < 30000) {
      return;
    }
    
    try {
      this.solPrice = await getSolPrice();
      this.solPriceLastUpdate = now;
    } catch {
      // Keep using cached price
    }
  }
  
  /**
   * Get status of all monitored positions
   */
  getStatus(): Array<{
    mint: string;
    symbol: string;
    pnlPercent: number;
    tpLevelsHit: number[];
    lastUpdate: number;
  }> {
    const status: Array<{
      mint: string;
      symbol: string;
      pnlPercent: number;
      tpLevelsHit: number[];
      lastUpdate: number;
    }> = [];
    
    for (const [mint, monitored] of this.monitored) {
      status.push({
        mint,
        symbol: monitored.position.symbol,
        pnlPercent: monitored.position.unrealizedPnlPercent,
        tpLevelsHit: monitored.position.tpLevelsHit,
        lastUpdate: monitored.lastPriceUpdate,
      });
    }
    
    return status;
  }
}

// Export singleton instance for easy access
let priceMonitorInstance: PriceMonitor | null = null;

export function getPriceMonitor(callbacks?: PriceMonitorCallbacks): PriceMonitor {
  if (!priceMonitorInstance) {
    priceMonitorInstance = new PriceMonitor(callbacks);
  }
  return priceMonitorInstance;
}

export function resetPriceMonitor(): void {
  if (priceMonitorInstance) {
    priceMonitorInstance.stopAll();
    priceMonitorInstance = null;
  }
}
