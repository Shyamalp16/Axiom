/**
 * TP/SL MANAGER - Automated Take Profit & Stop Loss
 * 
 * STOP LOSS:
 * - Hard stop: -6%
 * - Time stop: No higher high in 3-4 minutes = exit
 * 
 * TAKE PROFIT LADDER (DO NOT DEVIATE):
 * - TP1: Sell 40% at +20%
 * - TP2: Sell 30% at +35%
 * - Runner: 30% with trailing stop at -10% from local high
 */

import { STOP_LOSS, TAKE_PROFIT, TIME_KILL_SWITCH } from '../config/index.js';
import { Position, OrderReason } from '../types/index.js';
import { 
  updatePosition, 
  closePosition, 
  getActivePositions
} from './position-manager.js';
import { fetchCandles } from '../api/data-providers.js';
import logger from '../utils/logger.js';

interface TPSLStatus {
  shouldExit: boolean;
  reason: OrderReason | null;
  percentToSell: number;
  message: string;
}

/**
 * Check all TP/SL conditions for a position
 */
export async function checkTPSL(position: Position): Promise<TPSLStatus> {
  // Update position with latest price
  const candles = await fetchCandles(position.mint, 15, 5);
  if (candles.length === 0) {
    return { shouldExit: false, reason: null, percentToSell: 0, message: 'No price data' };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const updatedPosition = updatePosition(position.id, currentPrice);
  
  if (!updatedPosition) {
    return { shouldExit: false, reason: null, percentToSell: 0, message: 'Position not found' };
  }
  
  const pnlPercent = updatedPosition.unrealizedPnlPercent;
  
  // 1. Check HARD STOP LOSS
  if (pnlPercent <= STOP_LOSS.HARD_STOP_PERCENT) {
    return {
      shouldExit: true,
      reason: 'stop_loss',
      percentToSell: 100,
      message: `STOP LOSS HIT: ${pnlPercent.toFixed(1)}% (limit: ${STOP_LOSS.HARD_STOP_PERCENT}%)`,
    };
  }
  
  // 2. Check TIME STOP
  const timeInTradeMinutes = (Date.now() - updatedPosition.entryTime.getTime()) / 1000 / 60;
  const noHigherHighMinutes = await getMinutesSinceHigherHigh(updatedPosition);
  
  if (noHigherHighMinutes >= STOP_LOSS.TIME_STOP_MINUTES && pnlPercent < 0) {
    return {
      shouldExit: true,
      reason: 'time_stop',
      percentToSell: 100,
      message: `TIME STOP: No higher high in ${noHigherHighMinutes.toFixed(0)} minutes`,
    };
  }
  
  // 3. Check KILL SWITCH - trade not profitable
  if (timeInTradeMinutes >= TIME_KILL_SWITCH.MAX_UNPROFITABLE_MINUTES && pnlPercent <= 0) {
    return {
      shouldExit: true,
      reason: 'time_stop',
      percentToSell: 100,
      message: `KILL SWITCH: Not profitable after ${timeInTradeMinutes.toFixed(0)} minutes`,
    };
  }
  
  // 4. Check TP1 (+20%)
  if (pnlPercent >= TAKE_PROFIT.TP1_PERCENT && !updatedPosition.tpLevelsHit.includes(1)) {
    updatedPosition.tpLevelsHit.push(1);
    return {
      shouldExit: true,
      reason: 'tp1',
      percentToSell: TAKE_PROFIT.TP1_SELL_PERCENT,
      message: `TP1 HIT: +${pnlPercent.toFixed(1)}% - Selling ${TAKE_PROFIT.TP1_SELL_PERCENT}%`,
    };
  }
  
  // 5. Check TP2 (+35%)
  if (pnlPercent >= TAKE_PROFIT.TP2_PERCENT && !updatedPosition.tpLevelsHit.includes(2)) {
    updatedPosition.tpLevelsHit.push(2);
    return {
      shouldExit: true,
      reason: 'tp2',
      percentToSell: TAKE_PROFIT.TP2_SELL_PERCENT,
      message: `TP2 HIT: +${pnlPercent.toFixed(1)}% - Selling ${TAKE_PROFIT.TP2_SELL_PERCENT}%`,
    };
  }
  
  // 6. Check RUNNER TRAILING STOP (-10% from high)
  if (updatedPosition.tpLevelsHit.includes(2)) {
    const dropFromHigh = ((updatedPosition.highestPrice - currentPrice) / updatedPosition.highestPrice) * 100;
    
    if (dropFromHigh >= Math.abs(TAKE_PROFIT.RUNNER_TRAILING_STOP_PERCENT)) {
      return {
        shouldExit: true,
        reason: 'runner_exit',
        percentToSell: 100, // Sell remaining runner
        message: `RUNNER TRAILING STOP: -${dropFromHigh.toFixed(1)}% from high`,
      };
    }
  }
  
  // 7. Check for momentum stall on runner
  if (updatedPosition.tpLevelsHit.includes(2)) {
    const isStalled = await checkMomentumStall(position.mint);
    
    if (isStalled) {
      return {
        shouldExit: true,
        reason: 'runner_exit',
        percentToSell: 100,
        message: 'MOMENTUM STALL: Market selling runner',
      };
    }
  }
  
  return {
    shouldExit: false,
    reason: null,
    percentToSell: 0,
    message: `Holding: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`,
  };
}

/**
 * Get minutes since last higher high
 */
async function getMinutesSinceHigherHigh(position: Position): Promise<number> {
  try {
    const candles = await fetchCandles(position.mint, 15, 20);
    if (candles.length === 0) return 0;
    
    // Find the most recent higher high
    let lastHigherHighTime = position.entryTime.getTime();
    let runningHigh = position.entryPrice;
    
    for (const candle of candles) {
      if (candle.high > runningHigh) {
        runningHigh = candle.high;
        lastHigherHighTime = candle.timestamp;
      }
    }
    
    return (Date.now() - lastHigherHighTime) / 1000 / 60;
  } catch {
    return 0;
  }
}

/**
 * Check if momentum has stalled
 */
async function checkMomentumStall(mint: string): Promise<boolean> {
  try {
    const candles = await fetchCandles(mint, 15, 10);
    if (candles.length < 5) return false;
    
    // Check for declining volume over last 5 candles
    const recentCandles = candles.slice(-5);
    let decliningVolume = 0;
    
    for (let i = 1; i < recentCandles.length; i++) {
      if (recentCandles[i].volume < recentCandles[i - 1].volume * 0.8) {
        decliningVolume++;
      }
    }
    
    // Check for price stagnation
    const priceRange = recentCandles.map(c => c.close);
    const avgPrice = priceRange.reduce((a, b) => a + b, 0) / priceRange.length;
    const priceVariation = priceRange.reduce((max, p) => Math.max(max, Math.abs(p - avgPrice) / avgPrice), 0);
    
    // Momentum stalled if volume declining and price barely moving
    return decliningVolume >= 3 && priceVariation < 0.02;
  } catch {
    return false;
  }
}

/**
 * Monitor all positions for TP/SL
 */
export async function monitorAllPositions(): Promise<void> {
  const positions = getActivePositions();
  
  for (const position of positions) {
    const status = await checkTPSL(position);
    
    if (status.shouldExit && status.reason) {
      logger.alert(
        status.reason.includes('stop') ? 'danger' : 'info',
        status.message
      );
      
      // Get latest price for execution
      const candles = await fetchCandles(position.mint, 15, 1);
      const sellPrice = candles.length > 0 ? candles[0].close : position.currentPrice;
      
      // Execute the exit
      closePosition(position.id, sellPrice, status.percentToSell, status.reason);
    }
  }
}

/**
 * Start continuous TP/SL monitoring
 */
export function startTPSLMonitoring(intervalMs: number = 5000): () => void {
  logger.info(`Starting TP/SL monitoring (every ${intervalMs / 1000}s)`);
  
  const interval = setInterval(async () => {
    try {
      await monitorAllPositions();
    } catch (error) {
      logger.error('TP/SL monitoring error', error);
    }
  }, intervalMs);
  
  // Return cleanup function
  return () => {
    clearInterval(interval);
    logger.info('TP/SL monitoring stopped');
  };
}

