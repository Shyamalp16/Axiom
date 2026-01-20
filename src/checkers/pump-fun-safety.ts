/**
 * PUMP.FUN SAFETY CHECKER
 * 
 * Specialized checks for Pump.fun tokens (pre-Raydium graduation)
 * Different rules apply because:
 * - No LP to check (uses bonding curve)
 * - Mint/freeze authorities are controlled by Pump.fun program
 * - Dev allocation is known (creator gets % of supply)
 */

import { PUMP_FUN, TOKEN_SAFETY } from '../config/index.js';
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
  
  // Fetch token data
  const token = await fetchPumpFunToken(mintAddress);
  
  if (!token) {
    return {
      passed: false,
      isPumpFun: false,
      token: null,
      bondingCurveProgress: 0,
      marketCapUsd: 0,
      ageMinutes: 0,
      replyCount: 0,
      isGraduated: false,
      failures: ['Not a Pump.fun token'],
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
  
  // 2. Check bonding curve progress
  const progress = token.bondingCurveProgress;
  
  if (progress < PUMP_FUN.MIN_BONDING_CURVE_PROGRESS) {
    failures.push(`Bonding curve too early: ${progress.toFixed(1)}% (min ${PUMP_FUN.MIN_BONDING_CURVE_PROGRESS}%)`);
  }
  
  if (progress > PUMP_FUN.MAX_BONDING_CURVE_PROGRESS) {
    failures.push(`About to graduate: ${progress.toFixed(1)}% - migration risk`);
  } else if (progress > PUMP_FUN.GRADUATION_WARNING_PERCENT) {
    warnings.push(`Near graduation: ${progress.toFixed(1)}% - be careful`);
  }
  
  const progressInIdealRange = 
    progress >= PUMP_FUN.IDEAL_PROGRESS_MIN && 
    progress <= PUMP_FUN.IDEAL_PROGRESS_MAX;
  
  logger.checklist(
    `Bonding curve ${PUMP_FUN.MIN_BONDING_CURVE_PROGRESS}-${PUMP_FUN.MAX_BONDING_CURVE_PROGRESS}%`,
    progress >= PUMP_FUN.MIN_BONDING_CURVE_PROGRESS && progress <= PUMP_FUN.MAX_BONDING_CURVE_PROGRESS,
    `${progress.toFixed(1)}%${progressInIdealRange ? ' (ideal range!)' : ''}`
  );
  
  // 3. Check market cap
  if (token.marketCapUsd < PUMP_FUN.MIN_MARKET_CAP_USD) {
    failures.push(`Market cap too low: $${token.marketCapUsd.toFixed(0)} (min $${PUMP_FUN.MIN_MARKET_CAP_USD})`);
  }
  
  if (token.marketCapUsd > PUMP_FUN.MAX_MARKET_CAP_USD) {
    warnings.push(`High market cap: $${token.marketCapUsd.toFixed(0)} - less upside potential`);
  }
  
  logger.checklist(
    `Market cap ≥ $${PUMP_FUN.MIN_MARKET_CAP_USD}`,
    token.marketCapUsd >= PUMP_FUN.MIN_MARKET_CAP_USD,
    `$${token.marketCapUsd.toFixed(0)}`
  );
  
  // 4. Check age
  if (token.ageMinutes < PUMP_FUN.BOT_WAR_ZONE_MINUTES) {
    failures.push(`Too fresh: ${token.ageMinutes.toFixed(1)} min - BOT WAR ZONE`);
  } else if (token.ageMinutes < PUMP_FUN.MIN_AGE_MINUTES) {
    warnings.push(`Very new: ${token.ageMinutes.toFixed(1)} min - high risk`);
  }
  
  if (token.ageMinutes > PUMP_FUN.MAX_AGE_MINUTES) {
    warnings.push(`Older token: ${token.ageMinutes.toFixed(0)} min - check momentum`);
  }
  
  logger.checklist(
    `Age ≥ ${PUMP_FUN.MIN_AGE_MINUTES} min`,
    token.ageMinutes >= PUMP_FUN.MIN_AGE_MINUTES,
    `${token.ageMinutes.toFixed(1)} min`
  );
  
  // 5. Check engagement (reply count)
  if (token.replyCount < PUMP_FUN.MIN_REPLY_COUNT) {
    warnings.push(`Low engagement: ${token.replyCount} replies`);
  }
  
  logger.checklist(
    `Engagement (≥ ${PUMP_FUN.MIN_REPLY_COUNT} replies)`,
    token.replyCount >= PUMP_FUN.MIN_REPLY_COUNT,
    `${token.replyCount} replies`
  );
  
  // 6. Check social presence
  const hasSocial = token.twitter || token.telegram || token.website;
  if (!hasSocial) {
    warnings.push('No social links - could be low effort');
  }
  
  logger.checklist(
    'Has social links',
    hasSocial,
    [token.twitter && 'Twitter', token.telegram && 'TG', token.website && 'Web'].filter(Boolean).join(', ') || 'None'
  );
  
  // 7. Analyze recent trades for manipulation
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
  }
  
  // 8. Check creator hasn't dumped
  // On Pump.fun, creator typically gets tokens - check if they're selling aggressively
  const creatorActivity = await analyzeCreatorActivity(token, recentTrades);
  
  if (creatorActivity.isSelling) {
    failures.push(`Creator selling: ${creatorActivity.sellPercent.toFixed(1)}% dumped`);
  }
  
  logger.checklist(
    'Creator not dumping',
    !creatorActivity.isSelling,
    creatorActivity.isSelling ? `Selling ${creatorActivity.sellPercent.toFixed(1)}%` : 'Holding'
  );
  
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
  
  // Check for wash trading (same wallet buying and selling rapidly)
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
  
  // If single wallet has both many buys and sells, suspicious
  for (const [wallet, activity] of walletActivity) {
    if (activity.buys >= 3 && activity.sells >= 3) {
      return { isManipulated: true, reason: 'Wash trading detected' };
    }
  }
  
  // Check for coordinated buying (many buys in rapid succession from different wallets)
  const buyTimes = trades.filter(t => t.isBuy).map(t => t.timestamp).sort();
  let rapidBuys = 0;
  
  for (let i = 1; i < buyTimes.length; i++) {
    if (buyTimes[i] - buyTimes[i - 1] < 2000) { // Within 2 seconds
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
async function analyzeCreatorActivity(
  token: PumpFunToken,
  trades: Awaited<ReturnType<typeof fetchPumpFunTrades>>
): Promise<{ isSelling: boolean; sellPercent: number }> {
  const creatorTrades = trades.filter(t => t.user === token.creator);
  
  if (creatorTrades.length === 0) {
    return { isSelling: false, sellPercent: 0 };
  }
  
  const sells = creatorTrades.filter(t => !t.isBuy);
  const totalSold = sells.reduce((sum, t) => sum + t.tokenAmount, 0);
  
  // Estimate creator's initial allocation (typically small % on pump.fun)
  const estimatedCreatorTokens = token.virtualTokenReserves * 0.02; // ~2% creator allocation
  
  const sellPercent = (totalSold / estimatedCreatorTokens) * 100;
  
  // Consider selling if > 50% of allocation dumped
  return {
    isSelling: sellPercent > 50,
    sellPercent: Math.min(100, sellPercent),
  };
}

/**
 * Quick check if token is on Pump.fun and worth analyzing
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
  
  if (token.ageMinutes < PUMP_FUN.BOT_WAR_ZONE_MINUTES) {
    return { isPumpFun: true, shouldAnalyze: false, reason: 'Too fresh (bot war)' };
  }
  
  if (token.bondingCurveProgress < 10) {
    return { isPumpFun: true, shouldAnalyze: false, reason: 'Too early in curve' };
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
    `Replies: ${token.replyCount}`,
    `Socials: ${[token.twitter && '𝕏', token.telegram && 'TG', token.website && 'Web'].filter(Boolean).join(' ') || 'None'}`,
  ]);
}
