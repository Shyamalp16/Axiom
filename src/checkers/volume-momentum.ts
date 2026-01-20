/**
 * VOLUME & MOMENTUM ANALYZER
 * Checks: Pullback volume ratio, consolidation, wick patterns
 * 
 * RULE: Pullback vol ≥ 40% of pump, no vertical wicks, has consolidation
 */

import { VOLUME_MOMENTUM } from '../config/index.js';
import { fetchMarketData, fetchCandles } from '../api/data-providers.js';
import { VolumeAnalysis, Candle } from '../types/index.js';
import logger from '../utils/logger.js';

/**
 * Analyze volume and momentum patterns
 */
export async function analyzeVolumeMomentum(mintAddress: string): Promise<VolumeAnalysis> {
  const failures: string[] = [];
  
  logger.header('VOLUME & MOMENTUM ANALYSIS');
  logger.info(`Analyzing: ${mintAddress}`);
  
  let pumpVolume = 0;
  let pullbackVolume = 0;
  let pullbackVolumeRatio = 0;
  let consolidationsDetected = 0;
  let hasVerticalWickDumps = false;
  
  try {
    // Fetch candles for analysis
    const candles = await fetchCandles(mintAddress, 15, 100);
    
    if (candles.length < 10) {
      failures.push('Insufficient candle data for analysis');
      logger.warn('Not enough candles to analyze');
    } else {
      // Analyze pump and pullback phases
      const analysis = analyzePumpPullback(candles);
      pumpVolume = analysis.pumpVolume;
      pullbackVolume = analysis.pullbackVolume;
      pullbackVolumeRatio = pumpVolume > 0 ? pullbackVolume / pumpVolume : 0;
      
      // Check pullback volume ratio
      if (pullbackVolumeRatio < VOLUME_MOMENTUM.MIN_PULLBACK_VOLUME_RATIO) {
        failures.push(
          `Pullback volume weak: ${(pullbackVolumeRatio * 100).toFixed(0)}% ` +
          `(need ${VOLUME_MOMENTUM.MIN_PULLBACK_VOLUME_RATIO * 100}%+)`
        );
      }
      
      logger.checklist(
        `Pullback vol ≥ ${VOLUME_MOMENTUM.MIN_PULLBACK_VOLUME_RATIO * 100}% of pump`,
        pullbackVolumeRatio >= VOLUME_MOMENTUM.MIN_PULLBACK_VOLUME_RATIO,
        `${(pullbackVolumeRatio * 100).toFixed(0)}%`
      );
      
      // Detect consolidation phases
      consolidationsDetected = detectConsolidations(candles);
      
      if (consolidationsDetected < VOLUME_MOMENTUM.MIN_CONSOLIDATIONS_REQUIRED) {
        failures.push(
          `No consolidation detected after pump - likely bot exit liquidity`
        );
      }
      
      logger.checklist(
        `At least ${VOLUME_MOMENTUM.MIN_CONSOLIDATIONS_REQUIRED} consolidation`,
        consolidationsDetected >= VOLUME_MOMENTUM.MIN_CONSOLIDATIONS_REQUIRED,
        `${consolidationsDetected} found`
      );
      
      // Check for vertical wick dumps
      hasVerticalWickDumps = detectVerticalWickDumps(candles);
      
      if (hasVerticalWickDumps) {
        failures.push('Vertical wick dumps detected - dangerous pattern');
      }
      
      logger.checklist(
        'No vertical wick dumps',
        !hasVerticalWickDumps
      );
      
      // Additional check: straight candles pattern (bot pattern)
      const hasStraightCandles = detectStraightCandlePattern(candles);
      
      if (hasStraightCandles) {
        failures.push('Straight candle pattern detected - skip, this is bot exit liquidity');
      }
      
      logger.checklist(
        'No straight candle pattern',
        !hasStraightCandles
      );
    }
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Volume analysis error: ${errMsg}`);
    logger.error('Volume analysis failed with error', error);
  }
  
  const passed = failures.length === 0;
  
  logger.divider();
  if (passed) {
    logger.success('VOLUME & MOMENTUM: PASSED ✓');
  } else {
    logger.error('VOLUME & MOMENTUM: FAILED ✗');
    failures.forEach(f => logger.error(`  → ${f}`));
  }
  
  return {
    passed,
    pumpVolume,
    pullbackVolume,
    pullbackVolumeRatio,
    consolidationsDetected,
    hasVerticalWickDumps,
    failures,
  };
}

/**
 * Analyze pump and pullback phases from candles
 */
function analyzePumpPullback(candles: Candle[]): {
  pumpVolume: number;
  pullbackVolume: number;
  pumpEndIndex: number;
  pullbackStartIndex: number;
} {
  if (candles.length === 0) {
    return { pumpVolume: 0, pullbackVolume: 0, pumpEndIndex: 0, pullbackStartIndex: 0 };
  }
  
  // Find the local high (pump end)
  let highPrice = 0;
  let highIndex = 0;
  
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > highPrice) {
      highPrice = candles[i].high;
      highIndex = i;
    }
  }
  
  // Pump phase: start to high
  let pumpVolume = 0;
  for (let i = 0; i <= highIndex; i++) {
    pumpVolume += candles[i].volume;
  }
  
  // Pullback phase: high to current
  let pullbackVolume = 0;
  for (let i = highIndex + 1; i < candles.length; i++) {
    pullbackVolume += candles[i].volume;
  }
  
  return {
    pumpVolume,
    pullbackVolume,
    pumpEndIndex: highIndex,
    pullbackStartIndex: highIndex + 1,
  };
}

/**
 * Detect consolidation phases (sideways movement)
 */
function detectConsolidations(candles: Candle[]): number {
  if (candles.length < 5) return 0;
  
  let consolidations = 0;
  const windowSize = 5;
  const priceChangeThreshold = 0.03; // 3% range
  
  for (let i = windowSize; i < candles.length; i++) {
    const window = candles.slice(i - windowSize, i);
    
    const highs = window.map(c => c.high);
    const lows = window.map(c => c.low);
    
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    
    if (minLow === 0) continue;
    
    const range = (maxHigh - minLow) / minLow;
    
    // Consolidation = tight range
    if (range < priceChangeThreshold) {
      consolidations++;
      // Skip the window to avoid counting overlapping consolidations
      i += windowSize - 1;
    }
  }
  
  return consolidations;
}

/**
 * Detect vertical wick dumps (large wicks with body near top)
 */
function detectVerticalWickDumps(candles: Candle[]): boolean {
  const recentCandles = candles.slice(-20); // Look at last 20 candles
  
  for (const candle of recentCandles) {
    const range = candle.high - candle.low;
    if (range === 0) continue;
    
    const body = Math.abs(candle.close - candle.open);
    const bodyRatio = body / range;
    
    // Vertical wick: body is small, wick is long, closed near low
    const isVerticalWick = bodyRatio < 0.2; // Body is < 20% of range
    const closedNearLow = candle.close < candle.open && 
                          (candle.close - candle.low) / range < 0.3;
    
    // Check for significant volume on the dump
    const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    const highVolume = candle.volume > avgVolume * 1.5;
    
    if (isVerticalWick && closedNearLow && highVolume) {
      return true;
    }
  }
  
  return false;
}

/**
 * Detect straight candle pattern (all green or all red, no consolidation)
 * This is typically bot manipulation
 */
function detectStraightCandlePattern(candles: Candle[]): boolean {
  if (candles.length < 8) return false;
  
  const recentCandles = candles.slice(-15);
  
  // Count consecutive same-direction candles
  let consecutiveGreen = 0;
  let consecutiveRed = 0;
  let maxConsecutiveGreen = 0;
  let maxConsecutiveRed = 0;
  
  for (const candle of recentCandles) {
    if (candle.close > candle.open) {
      consecutiveGreen++;
      consecutiveRed = 0;
      maxConsecutiveGreen = Math.max(maxConsecutiveGreen, consecutiveGreen);
    } else {
      consecutiveRed++;
      consecutiveGreen = 0;
      maxConsecutiveRed = Math.max(maxConsecutiveRed, consecutiveRed);
    }
  }
  
  // 8+ consecutive same-direction candles = bot pattern
  return maxConsecutiveGreen >= 8 || maxConsecutiveRed >= 8;
}

/**
 * Calculate VWAP for the session
 */
export function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  
  let cumulativeTPV = 0; // Typical Price * Volume
  let cumulativeVolume = 0;
  
  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }
  
  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
}

/**
 * Find local high from recent candles
 */
export function findLocalHigh(candles: Candle[]): { price: number; index: number } {
  let highPrice = 0;
  let highIndex = 0;
  
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > highPrice) {
      highPrice = candles[i].high;
      highIndex = i;
    }
  }
  
  return { price: highPrice, index: highIndex };
}

/**
 * Find first consolidation range
 */
export function findFirstConsolidationRange(candles: Candle[]): {
  high: number;
  low: number;
} | null {
  const windowSize = 5;
  const priceChangeThreshold = 0.05; // 5% range
  
  for (let i = windowSize; i < candles.length; i++) {
    const window = candles.slice(i - windowSize, i);
    
    const highs = window.map(c => c.high);
    const lows = window.map(c => c.low);
    
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    
    if (minLow === 0) continue;
    
    const range = (maxHigh - minLow) / minLow;
    
    if (range < priceChangeThreshold) {
      return { high: maxHigh, low: minLow };
    }
  }
  
  return null;
}
