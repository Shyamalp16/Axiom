/**
 * AGE & CONTEXT FILTER
 * Checks: Token age, pump status, volume activity
 * 
 * RULE: 3-20 minutes old, 2-5x pumped, volume still active
 */

import { AGE_CONTEXT_FILTER, VOLUME_MOMENTUM } from '../config/index.js';
import { DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import { fetchTokenInfo, fetchMarketData, fetchRecentVolume } from '../api/data-providers.js';
import logger from '../utils/logger.js';

export interface AgeContextResult {
  passed: boolean;
  ageMinutes: number;
  pumpMultiplier: number;
  recentVolumeSol: number;
  isVolumeActive: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * Check token age and context filters
 */
export async function checkAgeContext(mintAddress: string): Promise<AgeContextResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  
  logger.header('AGE & CONTEXT CHECK');
  logger.info(`Analyzing: ${mintAddress}`);
  
  let ageMinutes = 0;
  let pumpMultiplier = 1;
  let recentVolumeSol = 0;
  let isVolumeActive = false;
  
  try {
    // 1. Get token age
    const tokenInfo = await fetchTokenInfo(mintAddress);
    ageMinutes = tokenInfo.ageMinutes;
    
    // Check age constraints (use DISCOVERY_CONFIG for consistency)
    const minAge = DISCOVERY_CONFIG.minAgeMinutes;
    const maxAge = DISCOVERY_CONFIG.maxAgeMinutes;
    const tooYoung = ageMinutes < minAge;
    const tooOld = ageMinutes > maxAge;
    
    if (tooYoung) {
      failures.push(`Token too young (${ageMinutes.toFixed(1)} min) - min ${minAge} min`);
    }
    
    logger.checklist(
      `Age ≥ ${minAge} min`,
      !tooYoung,
      `${ageMinutes.toFixed(1)} min`
    );
    
    // 2. Get market data for pump analysis
    const marketData = await fetchMarketData(mintAddress);
    
    // Calculate pump multiplier from launch
    // This is approximate - would need first candle price vs current
    if (marketData.candles.length > 0) {
      const firstCandle = marketData.candles[0];
      const currentPrice = marketData.priceUsd;
      
      if (firstCandle.open > 0) {
        pumpMultiplier = currentPrice / firstCandle.open;
      }
    }
    
    // Check pump range
    const notPumpedEnough = pumpMultiplier < AGE_CONTEXT_FILTER.MIN_PUMP_MULTIPLIER;
    const pumpedTooMuch = pumpMultiplier > AGE_CONTEXT_FILTER.MAX_PUMP_MULTIPLIER;
    
    if (notPumpedEnough) {
      failures.push(`Not pumped enough (${pumpMultiplier.toFixed(1)}x) - needs ${AGE_CONTEXT_FILTER.MIN_PUMP_MULTIPLIER}x+`);
    }
    
    if (pumpedTooMuch) {
      failures.push(`Already pumped too much (${pumpMultiplier.toFixed(1)}x) - max ${AGE_CONTEXT_FILTER.MAX_PUMP_MULTIPLIER}x`);
    }
    
    logger.checklist(
      `Pump: ${AGE_CONTEXT_FILTER.MIN_PUMP_MULTIPLIER}x-${AGE_CONTEXT_FILTER.MAX_PUMP_MULTIPLIER}x`,
      !notPumpedEnough && !pumpedTooMuch,
      `${pumpMultiplier.toFixed(1)}x`
    );
    
    // 3. Check recent volume
    recentVolumeSol = marketData.volumeRecent;
    isVolumeActive = recentVolumeSol >= VOLUME_MOMENTUM.MIN_RECENT_VOLUME_SOL;
    
    if (!isVolumeActive) {
      // If old token but volume is exploding, allow it
      if (tooOld && recentVolumeSol > VOLUME_MOMENTUM.MIN_RECENT_VOLUME_SOL * 5) {
        warnings.push('Old token but volume exploding - proceeding with caution');
      } else if (tooOld) {
        failures.push(`Token too old (${ageMinutes.toFixed(1)} min) with weak volume`);
      } else {
        failures.push(`Volume dead: ${recentVolumeSol.toFixed(2)} SOL (need ${VOLUME_MOMENTUM.MIN_RECENT_VOLUME_SOL}+ SOL)`);
      }
    }
    
    logger.checklist(
      `Volume active (≥ ${VOLUME_MOMENTUM.MIN_RECENT_VOLUME_SOL} SOL/5min)`,
      isVolumeActive,
      `${recentVolumeSol.toFixed(2)} SOL`
    );
    
    // 4. Check if too old (with volume exception)
    if (tooOld && !isVolumeActive) {
      failures.push(`Too old: ${ageMinutes.toFixed(0)} min (max ${maxAge} min) with weak volume`);
    } else if (tooOld && isVolumeActive) {
      warnings.push('Token older than ideal but volume still active');
    }
    
    logger.checklist(
      `Age ≤ ${maxAge} min (or volume active)`,
      !tooOld || isVolumeActive,
      `${ageMinutes.toFixed(1)} min`
    );
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Age/context check error: ${errMsg}`);
    logger.error('Age/context check failed with error', error);
  }
  
  const passed = failures.length === 0;
  
  logger.divider();
  if (passed) {
    logger.success('AGE & CONTEXT: PASSED ✓');
    if (warnings.length > 0) {
      warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  } else {
    logger.error('AGE & CONTEXT: FAILED ✗');
    failures.forEach(f => logger.error(`  → ${f}`));
  }
  
  return {
    passed,
    ageMinutes,
    pumpMultiplier,
    recentVolumeSol,
    isVolumeActive,
    failures,
    warnings,
  };
}

/**
 * Quick age check for filtering (uses DISCOVERY_CONFIG)
 */
export function isAgeAcceptable(ageMinutes: number): {
  acceptable: boolean;
  reason?: string;
} {
  if (ageMinutes < DISCOVERY_CONFIG.minAgeMinutes) {
    return { acceptable: false, reason: `Too young (< ${DISCOVERY_CONFIG.minAgeMinutes} min)` };
  }
  
  if (ageMinutes > DISCOVERY_CONFIG.maxAgeMinutes) {
    return { acceptable: false, reason: `Too old (> ${DISCOVERY_CONFIG.maxAgeMinutes} min)` };
  }
  
  return { acceptable: true };
}
