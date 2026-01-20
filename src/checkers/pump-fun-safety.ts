/**
 * PUMP.FUN SAFETY CHECKER
 * 
 * Specialized checks for Pump.fun tokens (pre-Raydium graduation)
 * Data source: PumpPortal WebSocket API
 * 
 * Different rules apply because:
 * - No LP to check (uses bonding curve)
 * - Mint/freeze authorities are controlled by Pump.fun program
 * - Dev allocation is known (creator gets % of supply)
 */

import { PUMP_FUN } from '../config/index.js';
import { DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import { 
  fetchPumpFunToken, 
  fetchPumpFunTrades,
  analyzePumpFunSafety,
  PumpFunToken 
} from '../api/pump-fun.js';
import logger from '../utils/logger.js';

export interface PumpFunSafetyResult {
  passed: boolean;
  isPumpFun: boolean;
  token: PumpFunToken | null;
  bondingCurveProgress: number;
  marketCapUsd: number;
  ageMinutes: number;
  replyCount: number;
  isGraduated: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * Run Pump.fun specific safety checks
 */
export async function checkPumpFunSafety(mintAddress: string): Promise<PumpFunSafetyResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  
  logger.header('PUMP.FUN SAFETY CHECK');
  logger.info(`Analyzing: ${mintAddress}`);
  
  // Fetch token data via PumpPortal
  const token = await fetchPumpFunToken(mintAddress);
  
  if (!token) {
    logger.error('Failed to fetch token data from PumpPortal');
    logger.warn('Possible reasons: API timeout, token not found, or network issue');
    return {
      passed: false,
      isPumpFun: false,
      token: null,
      bondingCurveProgress: 0,
      marketCapUsd: 0,
      ageMinutes: 0,
      replyCount: 0,
      isGraduated: false,
      failures: ['Token data unavailable - PumpPortal fetch failed or timed out'],
      warnings: [],
    };
  }
  
  logger.info(`Token: ${token.symbol} (${token.name})`);
  logger.info(`Creator: ${token.creator.slice(0, 8)}...`);
  
  // 1. Check if graduated (moved to Raydium)
  if (token.isGraduated) {
    logger.info(`Token graduated to Raydium: ${token.raydiumPool}`);
    return {
      passed: false,
      isPumpFun: true,
      token,
      bondingCurveProgress: 100,
      marketCapUsd: token.marketCapUsd,
      ageMinutes: token.ageMinutes,
      replyCount: token.replyCount,
      isGraduated: true,
      failures: ['Token graduated - use Raydium/Jupiter checks instead'],
      warnings: [],
    };
  }
  
  // 2. Check bonding curve progress (use DISCOVERY_CONFIG for consistency)
  const progress = token.bondingCurveProgress;
  const minProgress = DISCOVERY_CONFIG.minProgress;
  const maxProgress = DISCOVERY_CONFIG.maxProgress;
  
  if (progress < minProgress) {
    failures.push(`Bonding curve too early: ${progress.toFixed(1)}% (min ${minProgress}%)`);
  }
  
  if (progress > maxProgress) {
    failures.push(`About to graduate: ${progress.toFixed(1)}% - migration risk`);
  } else if (progress > 80) {
    warnings.push(`Near graduation: ${progress.toFixed(1)}% - be careful`);
  }
  
  logger.checklist(
    `Bonding curve ${minProgress}-${maxProgress}%`,
    progress >= minProgress && progress <= maxProgress,
    `${progress.toFixed(1)}%`
  );
  
  // 3. Check market cap (use DISCOVERY_CONFIG for consistency)
  const minMcap = DISCOVERY_CONFIG.minMarketCap;
  const maxMcap = DISCOVERY_CONFIG.maxMarketCap;
  
  if (token.marketCapUsd < minMcap) {
    failures.push(`Market cap too low: $${token.marketCapUsd.toFixed(0)} (min $${minMcap})`);
  }
  
  if (token.marketCapUsd > maxMcap) {
    warnings.push(`High market cap: $${token.marketCapUsd.toFixed(0)} - less upside potential`);
  }
  
  logger.checklist(
    `Market cap ≥ $${minMcap}`,
    token.marketCapUsd >= minMcap,
    `$${token.marketCapUsd.toFixed(0)}`
  );
  
  // 4. Check age (use DISCOVERY_CONFIG for consistency)
  const minAge = DISCOVERY_CONFIG.minAgeMinutes;
  const maxAge = DISCOVERY_CONFIG.maxAgeMinutes;
  
  if (token.ageMinutes < minAge) {
    failures.push(`Too fresh: ${token.ageMinutes.toFixed(1)} min (min ${minAge} min)`);
  }
  
  if (token.ageMinutes > maxAge) {
    failures.push(`Too old: ${token.ageMinutes.toFixed(1)} min (max ${maxAge} min)`);
  }
  
  logger.checklist(
    `Age ${minAge}-${maxAge} min`,
    token.ageMinutes >= minAge && token.ageMinutes <= maxAge,
    `${token.ageMinutes.toFixed(1)} min`
  );
  
  // 5. Check engagement (trade count)
  const minTrades = DISCOVERY_CONFIG.minTradeCount;
  if (token.replyCount < minTrades) {
    warnings.push(`Low engagement: ${token.replyCount} trades`);
  }
  
  logger.checklist(
    `Engagement (≥ ${minTrades} trades)`,
    token.replyCount >= minTrades,
    `${token.replyCount} trades`
  );
  
  // 6. Check social presence
  const hasSocial = !!(token.twitter || token.telegram || token.website);
  if (!hasSocial) {
    warnings.push('No social links - could be low effort');
  }
  
  logger.checklist(
    'Has social links',
    hasSocial,
    [token.twitter && 'Twitter', token.telegram && 'TG', token.website && 'Web'].filter(Boolean).join(', ') || 'None'
  );
  
  // 7. Analyze recent trades for manipulation (if available)
  const recentTrades = await fetchPumpFunTrades(mintAddress, 20);
  
  if (recentTrades.length > 0) {
    const manipulation = detectTradeManipulation(recentTrades, token);
    
    if (manipulation.isManipulated) {
      failures.push(`Trade manipulation detected: ${manipulation.reason}`);
    }
    
    logger.checklist(
      'No trade manipulation',
      !manipulation.isManipulated,
      manipulation.isManipulated ? manipulation.reason : 'Clean'
    );
    
    // 8. Check creator activity
    const creatorActivity = analyzeCreatorActivity(token, recentTrades);
    
    if (creatorActivity.isSelling) {
      failures.push(`Creator selling: ${creatorActivity.sellPercent.toFixed(1)}% dumped`);
    }
    
    logger.checklist(
      'Creator not dumping',
      !creatorActivity.isSelling,
      creatorActivity.isSelling ? `Selling ${creatorActivity.sellPercent.toFixed(1)}%` : 'Holding'
    );
  }
  // Skip trade analysis silently if no trades - engagement stats are enough
  
  // Final result
  const passed = failures.length === 0;
  
  logger.divider();
  if (passed) {
    logger.success('PUMP.FUN SAFETY: PASSED ✓');
    if (warnings.length > 0) {
      warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  } else {
    logger.error('PUMP.FUN SAFETY: FAILED ✗');
    failures.forEach(f => logger.error(`  → ${f}`));
  }
  
  return {
    passed,
    isPumpFun: true,
    token,
    bondingCurveProgress: progress,
    marketCapUsd: token.marketCapUsd,
    ageMinutes: token.ageMinutes,
    replyCount: token.replyCount,
    isGraduated: false,
    failures,
    warnings,
  };
}

/**
 * Detect trade manipulation patterns
 */
function detectTradeManipulation(
  trades: Awaited<ReturnType<typeof fetchPumpFunTrades>>,
  token: PumpFunToken
): { isManipulated: boolean; reason?: string } {
  if (trades.length < 5) {
    return { isManipulated: false };
  }
  
  // Check for wash trading
  const walletActivity: Map<string, { buys: number; sells: number }> = new Map();
  
  for (const trade of trades) {
    const activity = walletActivity.get(trade.user) || { buys: 0, sells: 0 };
    if (trade.isBuy) {
      activity.buys++;
    } else {
      activity.sells++;
    }
    walletActivity.set(trade.user, activity);
  }
  
  for (const [, activity] of walletActivity) {
    if (activity.buys >= 3 && activity.sells >= 3) {
      return { isManipulated: true, reason: 'Wash trading detected' };
    }
  }
  
  // Check for coordinated buying
  const buyTimes = trades.filter(t => t.isBuy).map(t => t.timestamp).sort();
  let rapidBuys = 0;
  
  for (let i = 1; i < buyTimes.length; i++) {
    if (buyTimes[i] - buyTimes[i - 1] < 2000) {
      rapidBuys++;
    }
  }
  
  if (rapidBuys >= 5) {
    return { isManipulated: true, reason: 'Coordinated buying detected' };
  }
  
  return { isManipulated: false };
}

/**
 * Analyze creator selling activity
 */
function analyzeCreatorActivity(
  token: PumpFunToken,
  trades: Awaited<ReturnType<typeof fetchPumpFunTrades>>
): { isSelling: boolean; sellPercent: number } {
  const creatorTrades = trades.filter(t => t.user === token.creator);
  
  if (creatorTrades.length === 0) {
    return { isSelling: false, sellPercent: 0 };
  }
  
  const sells = creatorTrades.filter(t => !t.isBuy);
  const totalSold = sells.reduce((sum, t) => sum + t.tokenAmount, 0);
  
  const estimatedCreatorTokens = token.virtualTokenReserves * 0.02;
  const sellPercent = (totalSold / estimatedCreatorTokens) * 100;
  
  return {
    isSelling: sellPercent > 50,
    sellPercent: Math.min(100, sellPercent),
  };
}

/**
 * Quick check if token is on Pump.fun
 */
export async function quickPumpFunCheck(mintAddress: string): Promise<{
  isPumpFun: boolean;
  shouldAnalyze: boolean;
  reason?: string;
}> {
  const token = await fetchPumpFunToken(mintAddress);
  
  if (!token) {
    return { isPumpFun: false, shouldAnalyze: false, reason: 'Not on Pump.fun' };
  }
  
  if (token.isGraduated) {
    return { isPumpFun: true, shouldAnalyze: false, reason: 'Graduated to Raydium' };
  }
  
  if (token.ageMinutes < DISCOVERY_CONFIG.minAgeMinutes) {
    return { isPumpFun: true, shouldAnalyze: false, reason: `Too fresh (< ${DISCOVERY_CONFIG.minAgeMinutes} min)` };
  }
  
  if (token.bondingCurveProgress < DISCOVERY_CONFIG.minProgress) {
    return { isPumpFun: true, shouldAnalyze: false, reason: `Too early (< ${DISCOVERY_CONFIG.minProgress}%)` };
  }
  
  return { isPumpFun: true, shouldAnalyze: true };
}

/**
 * Display Pump.fun token info
 */
export function displayPumpFunToken(token: PumpFunToken): void {
  logger.box(`${token.symbol} - Pump.fun`, [
    `Name: ${token.name}`,
    `Age: ${token.ageMinutes.toFixed(1)} minutes`,
    ``,
    `Price: $${token.priceUsd.toFixed(8)}`,
    `Market Cap: $${token.marketCapUsd.toFixed(0)}`,
    ``,
    `Bonding Curve: ${token.bondingCurveProgress.toFixed(1)}%`,
    `SOL in Curve: ${token.realSolReserves.toFixed(2)} SOL`,
    ``,
    `Trades: ${token.replyCount}`,
    `Socials: ${[token.twitter && '𝕏', token.telegram && 'TG', token.website && 'Web'].filter(Boolean).join(' ') || 'None'}`,
  ]);
}
