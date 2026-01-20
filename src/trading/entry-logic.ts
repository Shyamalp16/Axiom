/**
 * ENTRY LOGIC - FIRST PULLBACK CONTINUATION
 * 
 * Entry Conditions (ALL must be TRUE):
 * 1. Price retraced 30-50% from local high
 * 2. Last 2-3 red candles shrinking
 * 3. Buy volume > sell volume on current candle
 * 4. Price holds above first consolidation OR VWAP
 * 
 * Entry Execution:
 * - Split buy into 2 tranches: 60% on confirmation, 40% if holds
 * - NEVER single-click full size
 */

import { ENTRY_CONDITIONS, ENTRY_EXECUTION } from '../config/index.js';
import { fetchCandles, fetchMarketData } from '../api/data-providers.js';
import { 
  calculateVWAP, 
  findLocalHigh, 
  findFirstConsolidationRange 
} from '../checkers/volume-momentum.js';
import { EntryAnalysis, EntrySignal, Candle } from '../types/index.js';
import logger from '../utils/logger.js';

/**
 * Analyze if entry conditions are met
 */
export async function analyzeEntry(mintAddress: string): Promise<EntryAnalysis> {
  const failures: string[] = [];
  
  logger.header('ENTRY ANALYSIS');
  logger.info(`Checking entry conditions for: ${mintAddress}`);
  
  let retracementPercent = 0;
  let shrinkingRedCandles = 0;
  let buyVolumeRatio = 0;
  let holdingSupport = false;
  let supportLevel = 0;
  let localHigh = 0;
  
  try {
    // Fetch recent candles
    const candles = await fetchCandles(mintAddress, 15, 50);
    
    if (candles.length < 10) {
      failures.push('Insufficient candle data for entry analysis');
      return createFailedAnalysis(failures);
    }
    
    // 1. Calculate retracement from local high
    const highInfo = findLocalHigh(candles);
    localHigh = highInfo.price;
    
    const currentPrice = candles[candles.length - 1].close;
    
    if (localHigh > 0) {
      retracementPercent = ((localHigh - currentPrice) / localHigh) * 100;
    }
    
    const retracementInRange = 
      retracementPercent >= ENTRY_CONDITIONS.MIN_RETRACEMENT_PERCENT &&
      retracementPercent <= ENTRY_CONDITIONS.MAX_RETRACEMENT_PERCENT;
    
    if (!retracementInRange) {
      if (retracementPercent < ENTRY_CONDITIONS.MIN_RETRACEMENT_PERCENT) {
        failures.push(`Retracement too shallow: ${retracementPercent.toFixed(1)}% (need ${ENTRY_CONDITIONS.MIN_RETRACEMENT_PERCENT}%+)`);
      } else {
        failures.push(`Retracement too deep: ${retracementPercent.toFixed(1)}% (max ${ENTRY_CONDITIONS.MAX_RETRACEMENT_PERCENT}%)`);
      }
    }
    
    logger.checklist(
      `Retracement ${ENTRY_CONDITIONS.MIN_RETRACEMENT_PERCENT}-${ENTRY_CONDITIONS.MAX_RETRACEMENT_PERCENT}%`,
      retracementInRange,
      `${retracementPercent.toFixed(1)}%`
    );
    
    // 2. Check for shrinking red candles
    shrinkingRedCandles = countShrinkingRedCandles(candles);
    
    const hasEnoughShrinkingRed = 
      shrinkingRedCandles >= ENTRY_CONDITIONS.MIN_SHRINKING_RED_CANDLES;
    
    if (!hasEnoughShrinkingRed) {
      failures.push(`Need ${ENTRY_CONDITIONS.MIN_SHRINKING_RED_CANDLES}+ shrinking red candles, found ${shrinkingRedCandles}`);
    }
    
    logger.checklist(
      `${ENTRY_CONDITIONS.MIN_SHRINKING_RED_CANDLES}+ shrinking red candles`,
      hasEnoughShrinkingRed,
      `${shrinkingRedCandles} found`
    );
    
    // 3. Check buy vs sell volume on current candle
    const currentCandle = candles[candles.length - 1];
    buyVolumeRatio = currentCandle.buyVolume / 
      (currentCandle.sellVolume || 1);
    
    const buyVolumeStrong = buyVolumeRatio >= ENTRY_CONDITIONS.BUY_SELL_VOLUME_RATIO_MIN;
    
    if (!buyVolumeStrong) {
      failures.push(`Buy volume weak: ${buyVolumeRatio.toFixed(2)}x (need ${ENTRY_CONDITIONS.BUY_SELL_VOLUME_RATIO_MIN}x+)`);
    }
    
    logger.checklist(
      'Buy volume > sell volume',
      buyVolumeStrong,
      `${buyVolumeRatio.toFixed(2)}x`
    );
    
    // 4. Check if price holds above support
    // Support = first consolidation range OR VWAP
    const consolidationRange = findFirstConsolidationRange(candles);
    const vwap = calculateVWAP(candles);
    
    if (consolidationRange) {
      supportLevel = consolidationRange.low;
      holdingSupport = currentPrice > supportLevel;
    } else if (vwap > 0) {
      supportLevel = vwap;
      holdingSupport = currentPrice > vwap;
    }
    
    if (ENTRY_CONDITIONS.REQUIRE_SUPPORT_HOLD && !holdingSupport) {
      failures.push(`Price below support: $${currentPrice.toFixed(6)} < $${supportLevel.toFixed(6)}`);
    }
    
    logger.checklist(
      'Price above support',
      holdingSupport,
      consolidationRange ? 'Consolidation' : 'VWAP'
    );
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Entry analysis error: ${errMsg}`);
    logger.error('Entry analysis failed', error);
  }
  
  const shouldEnter = failures.length === 0;
  
  logger.divider();
  if (shouldEnter) {
    logger.success('ENTRY SIGNAL: CONFIRMED ✓');
  } else {
    logger.warn('ENTRY SIGNAL: NOT READY');
    failures.forEach(f => logger.warn(`  → ${f}`));
  }
  
  return {
    shouldEnter,
    retracementPercent,
    shrinkingRedCandles,
    buyVolumeRatio,
    holdingSupport,
    supportLevel,
    localHigh,
    failures,
  };
}

/**
 * Generate entry signal with exact sizing
 */
export function generateEntrySignal(
  mintAddress: string,
  symbol: string,
  analysis: EntryAnalysis,
  totalSizeSOL: number
): EntrySignal {
  const currentPrice = analysis.localHigh * (1 - analysis.retracementPercent / 100);
  
  // Calculate tranche sizes
  const tranche1Size = totalSizeSOL * (ENTRY_EXECUTION.TRANCHE_1_PERCENT / 100);
  const tranche2Size = totalSizeSOL * (ENTRY_EXECUTION.TRANCHE_2_PERCENT / 100);
  
  // Calculate exit levels
  const stopLossPrice = currentPrice * (1 + (-6) / 100); // -6% stop
  const tp1Price = currentPrice * (1 + 20 / 100); // +20% TP1
  const tp2Price = currentPrice * (1 + 35 / 100); // +35% TP2
  
  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  
  if (analysis.shrinkingRedCandles >= 3 && 
      analysis.buyVolumeRatio >= 1.5 &&
      analysis.retracementPercent >= 35 && 
      analysis.retracementPercent <= 45) {
    confidence = 'high';
  } else if (analysis.shrinkingRedCandles < 2 || analysis.buyVolumeRatio < 1.2) {
    confidence = 'low';
  }
  
  return {
    mint: mintAddress,
    entryPrice: currentPrice,
    suggestedSize: totalSizeSOL,
    tranche1Size,
    tranche2Size,
    stopLossPrice,
    tp1Price,
    tp2Price,
    confidence,
    timestamp: new Date(),
  };
}

/**
 * Count consecutive shrinking red candles at the end
 */
function countShrinkingRedCandles(candles: Candle[]): number {
  if (candles.length < 3) return 0;
  
  // Look at last 5 candles
  const recentCandles = candles.slice(-5);
  let count = 0;
  let prevBodySize = Infinity;
  
  // Start from second-to-last and work backwards
  for (let i = recentCandles.length - 2; i >= 0; i--) {
    const candle = recentCandles[i];
    const isRed = candle.close < candle.open;
    const bodySize = Math.abs(candle.close - candle.open);
    
    if (isRed && bodySize < prevBodySize) {
      count++;
      prevBodySize = bodySize;
    } else {
      break;
    }
  }
  
  return count;
}

/**
 * Create a failed analysis result
 */
function createFailedAnalysis(failures: string[]): EntryAnalysis {
  return {
    shouldEnter: false,
    retracementPercent: 0,
    shrinkingRedCandles: 0,
    buyVolumeRatio: 0,
    holdingSupport: false,
    supportLevel: 0,
    localHigh: 0,
    failures,
  };
}

/**
 * Monitor for entry confirmation (use during tranche 2 wait)
 */
export async function waitForTranche2Confirmation(
  mintAddress: string,
  entryPrice: number,
  maxWaitCandles: number = ENTRY_EXECUTION.MAX_TRANCHE_2_WAIT_CANDLES
): Promise<{ confirmed: boolean; currentPrice: number }> {
  const candleIntervalMs = 15 * 1000; // 15 second candles
  let candlesWaited = 0;
  
  while (candlesWaited < maxWaitCandles) {
    await new Promise(resolve => setTimeout(resolve, candleIntervalMs));
    
    const candles = await fetchCandles(mintAddress, 15, 5);
    if (candles.length === 0) continue;
    
    const currentPrice = candles[candles.length - 1].close;
    
    // Check if price is still above entry
    if (currentPrice >= entryPrice) {
      return { confirmed: true, currentPrice };
    }
    
    candlesWaited++;
  }
  
  // Didn't hold
  const candles = await fetchCandles(mintAddress, 15, 1);
  const currentPrice = candles.length > 0 ? candles[0].close : entryPrice;
  
  return { confirmed: false, currentPrice };
}

/**
 * Display entry signal in formatted output
 */
export function displayEntrySignal(signal: EntrySignal, symbol: string): void {
  const confidenceColor = {
    high: '\x1b[32m', // Green
    medium: '\x1b[33m', // Yellow
    low: '\x1b[31m', // Red
  };
  
  logger.box(`ENTRY SIGNAL: ${symbol}`, [
    `Confidence: ${signal.confidence.toUpperCase()}`,
    `Entry Price: $${signal.entryPrice.toFixed(6)}`,
    ``,
    `Tranche 1: ${signal.tranche1Size.toFixed(3)} SOL (60%)`,
    `Tranche 2: ${signal.tranche2Size.toFixed(3)} SOL (40%)`,
    ``,
    `Stop Loss: $${signal.stopLossPrice.toFixed(6)} (-6%)`,
    `TP1: $${signal.tp1Price.toFixed(6)} (+20%)`,
    `TP2: $${signal.tp2Price.toFixed(6)} (+35%)`,
  ]);
}
