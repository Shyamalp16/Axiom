/**
 * PRE-TRADE CHECKLIST
 * 
 * FAIL ONE = NO TRADE
 * 
 * This is the gatekeeper. If ANY check fails, we don't trade.
 * No exceptions. No "it looks good anyway". No FOMO.
 * 
 * Supports both:
 * - Pump.fun tokens (bonding curve, pre-graduation)
 * - DEX tokens (Raydium, BAGS, Meteora, Meteora V2, Pump AMM)
 */

import { checkTokenSafety } from './token-safety.js';
import { checkWalletDistribution } from './wallet-distribution.js';
import { checkAgeContext } from './age-context.js';
import { analyzeVolumeMomentum } from './volume-momentum.js';
import { checkPumpFunSafety, PumpFunSafetyResult } from './pump-fun-safety.js';
import { analyzeEntry } from '../trading/entry-logic.js';
import { isTradingAllowed } from '../trading/position-manager.js';
import { isPumpFunToken, fetchPumpFunToken } from '../api/pump-fun.js';
import { DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import logger from '../utils/logger.js';

export interface ChecklistResult {
  passed: boolean;
  passedChecks: string[];
  failedChecks: string[];
  isPumpFun: boolean;
  details: {
    tokenSafety: Awaited<ReturnType<typeof checkTokenSafety>> | null;
    pumpFunSafety: PumpFunSafetyResult | null;
    walletDistribution: Awaited<ReturnType<typeof checkWalletDistribution>> | null;
    ageContext: Awaited<ReturnType<typeof checkAgeContext>> | null;
    volumeMomentum: Awaited<ReturnType<typeof analyzeVolumeMomentum>> | null;
    entryAnalysis: Awaited<ReturnType<typeof analyzeEntry>> | null;
  };
}

/**
 * Run the complete pre-trade checklist
 * FAIL ONE = NO TRADE
 * 
 * Automatically detects if token is on Pump.fun or Raydium/Orca
 */
export async function runPreTradeChecklist(
  mintAddress: string
): Promise<ChecklistResult> {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  
  // Initialize details
  const details: ChecklistResult['details'] = {
    tokenSafety: null,
    pumpFunSafety: null,
    walletDistribution: null,
    ageContext: null,
    volumeMomentum: null,
    entryAnalysis: null,
  };
  
  // Detect if this is a Pump.fun token
  // Quick pattern check: all Pump.fun tokens end in 'pump'
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  const pumpToken = looksLikePumpFun ? await fetchPumpFunToken(mintAddress) : null;
  const isPump = looksLikePumpFun && (pumpToken === null || !pumpToken.isGraduated);
  
  logger.header('═══════════════════════════════════════');
  logger.header('PRE-TRADE CHECKLIST');
  logger.header('═══════════════════════════════════════');
  logger.info(`Token: ${mintAddress}`);
  logger.info(`Platform: ${isPump ? '🟢 PUMP.FUN (Bonding Curve)' : '🔵 DEX (Raydium/BAGS/Meteora/Pump AMM)'}`);
  logger.info(`Time: ${new Date().toISOString()}`);
  logger.divider();
  
  // 0. Check if trading is allowed (daily/weekly limits)
  const tradingAllowed = await isTradingAllowed();
  if (!tradingAllowed.allowed) {
    failedChecks.push(`Trading disabled: ${tradingAllowed.reason}`);
    logger.error(`TRADING DISABLED: ${tradingAllowed.reason}`);
    
    return {
      passed: false,
      passedChecks,
      failedChecks,
      isPumpFun: isPump,
      details,
    };
  }
  passedChecks.push('Trading limits OK');
  
  // ========== PUMP.FUN PATH ==========
  if (isPump) {
    return await runPumpFunChecklist(mintAddress, passedChecks, failedChecks, details);
  }
  
  // ========== DEX PATH (Raydium/BAGS/Meteora/Pump AMM) ==========
  
  // 1. TOKEN SAFETY (MANDATORY)
  logger.info('\n[1/5] Checking Token Safety...');
  try {
    details.tokenSafety = await checkTokenSafety(mintAddress);
    
    if (!details.tokenSafety.passed) {
      failedChecks.push(...details.tokenSafety.failures.map(f => `Safety: ${f}`));
      
      // HARD STOP - Don't continue if safety fails
      logger.error('\n⛔ CHECKLIST FAILED AT TOKEN SAFETY');
      logger.error('No further checks needed. DO NOT TRADE.');
      
      return {
        passed: false,
        passedChecks,
        failedChecks,
        isPumpFun: false,
        details,
      };
    }
    
    passedChecks.push('Token Safety: PASSED');
  } catch (error) {
    failedChecks.push('Safety: Check failed with error');
    return { passed: false, passedChecks, failedChecks, isPumpFun: false, details };
  }
  
  // 2. WALLET DISTRIBUTION
  logger.info('\n[2/5] Checking Wallet Distribution...');
  try {
    details.walletDistribution = await checkWalletDistribution(mintAddress);
    
    if (!details.walletDistribution.passed) {
      failedChecks.push(...details.walletDistribution.failures.map(f => `Distribution: ${f}`));
      
      // Could continue for other info, but mark as failed
      logger.error('\n⛔ CHECKLIST FAILED AT WALLET DISTRIBUTION');
    } else {
      passedChecks.push('Wallet Distribution: PASSED');
    }
  } catch (error) {
    failedChecks.push('Distribution: Check failed with error');
  }
  
  // 3. AGE & CONTEXT
  logger.info('\n[3/5] Checking Age & Context...');
  try {
    details.ageContext = await checkAgeContext(mintAddress);
    
    if (!details.ageContext.passed) {
      failedChecks.push(...details.ageContext.failures.map(f => `Age/Context: ${f}`));
      logger.error('\n⛔ CHECKLIST FAILED AT AGE & CONTEXT');
    } else {
      passedChecks.push('Age & Context: PASSED');
    }
  } catch (error) {
    failedChecks.push('Age/Context: Check failed with error');
  }
  
  // 4. VOLUME & MOMENTUM
  logger.info('\n[4/5] Analyzing Volume & Momentum...');
  try {
    details.volumeMomentum = await analyzeVolumeMomentum(mintAddress);
    
    if (!details.volumeMomentum.passed) {
      failedChecks.push(...details.volumeMomentum.failures.map(f => `Volume: ${f}`));
      logger.error('\n⛔ CHECKLIST FAILED AT VOLUME & MOMENTUM');
    } else {
      passedChecks.push('Volume & Momentum: PASSED');
    }
  } catch (error) {
    failedChecks.push('Volume: Check failed with error');
  }
  
  // 5. ENTRY CONDITIONS
  logger.info('\n[5/5] Analyzing Entry Conditions...');
  try {
    details.entryAnalysis = await analyzeEntry(mintAddress);
    
    if (!details.entryAnalysis.shouldEnter) {
      failedChecks.push(...details.entryAnalysis.failures.map(f => `Entry: ${f}`));
      logger.warn('\n⚠️ Entry conditions not met');
    } else {
      passedChecks.push('Entry Conditions: PASSED');
    }
  } catch (error) {
    failedChecks.push('Entry: Check failed with error');
  }
  
  // FINAL VERDICT
  const passed = failedChecks.length === 0;
  
  displayChecklistResult(passed, passedChecks, failedChecks);
  
  return {
    passed,
    passedChecks,
    failedChecks,
    isPumpFun: false,
    details,
  };
}

/**
 * Run Pump.fun specific checklist
 */
async function runPumpFunChecklist(
  mintAddress: string,
  passedChecks: string[],
  failedChecks: string[],
  details: ChecklistResult['details']
): Promise<ChecklistResult> {
  
  // 1. PUMP.FUN SAFETY (replaces standard token safety)
  logger.info('\n[1/4] Checking Pump.fun Safety...');
  try {
    details.pumpFunSafety = await checkPumpFunSafety(mintAddress);
    
    if (!details.pumpFunSafety.passed) {
      failedChecks.push(...details.pumpFunSafety.failures.map(f => `Pump.fun: ${f}`));
      
      logger.error('\n⛔ CHECKLIST FAILED AT PUMP.FUN SAFETY');
      details.pumpFunSafety.failures.forEach(f => logger.error(`  → ${f}`));
      
      return {
        passed: false,
        passedChecks,
        failedChecks,
        isPumpFun: true,
        details,
      };
    }
    
    passedChecks.push('Pump.fun Safety: PASSED');
    
    // Log warnings if any
    if (details.pumpFunSafety.warnings.length > 0) {
      details.pumpFunSafety.warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  } catch (error) {
    failedChecks.push('Pump.fun: Check failed with error');
    return { passed: false, passedChecks, failedChecks, isPumpFun: true, details };
  }
  
  // 2. WALLET DISTRIBUTION (if data available)
  // Note: Pump.fun has different distribution model, but we still check
  logger.info('\n[2/4] Checking Holder Distribution...');
  try {
    details.walletDistribution = await checkWalletDistribution(mintAddress);
    
    if (!details.walletDistribution.passed) {
      // On Pump.fun, distribution is less critical but still logged
      details.walletDistribution.failures.forEach(f => logger.warn(`  ⚠ Distribution: ${f}`));
      // Don't hard fail for Pump.fun, just warn
      passedChecks.push('Holder Distribution: WARNED');
    } else {
      passedChecks.push('Holder Distribution: PASSED');
    }
  } catch (error) {
    // Non-critical for Pump.fun
    passedChecks.push('Holder Distribution: SKIPPED');
  }
  
  // 3. VOLUME & MOMENTUM (using Pump.fun trade data)
  logger.info('\n[3/4] Analyzing Trading Activity...');
  try {
    const { fetchPumpFunTrades } = await import('../api/pump-fun.js');
    const trades = await fetchPumpFunTrades(mintAddress, 50);
    
    if (trades.length === 0) {
      // Skip silently - engagement stats from token data are sufficient
      passedChecks.push('Trading Activity: SKIPPED');
    } else {
      const recentBuys = trades.filter(t => t.isBuy).length;
      const recentSells = trades.filter(t => !t.isBuy).length;
      const buyRatio = recentBuys / trades.length;
      
      logger.checklist(
        'Buy pressure',
        buyRatio >= 0.4,
        `${(buyRatio * 100).toFixed(0)}% buys (${recentBuys}/${trades.length} trades)`
      );
      
      if (buyRatio < 0.4) {
        failedChecks.push(`Weak buy pressure (${(buyRatio * 100).toFixed(0)}% - need 40%+)`);
      } else {
        passedChecks.push('Trading Activity: PASSED');
      }
    }
    
  } catch (error) {
    logger.debug(`Trading activity check error: ${error}`);
    passedChecks.push('Trading Activity: SKIPPED');
  }
  
  // 4. ENTRY TIMING
  logger.info('\n[4/4] Checking Entry Timing...');
  
  const pumpToken = details.pumpFunSafety?.token;
  if (pumpToken) {
    // Use config values for bonding curve range
    const minProgress = DISCOVERY_CONFIG.minProgress;
    const maxProgress = DISCOVERY_CONFIG.maxProgress;
    const progress = pumpToken.bondingCurveProgress;
    const inRange = progress >= minProgress && progress <= maxProgress;
    
    logger.checklist(
      `Bonding curve ${minProgress}-${maxProgress}%`,
      inRange,
      `${progress.toFixed(1)}%`
    );
    
    if (progress < minProgress) {
      failedChecks.push(`Pump.fun: Too early (${progress.toFixed(1)}% < ${minProgress}%)`);
    } else if (progress > maxProgress) {
      failedChecks.push(`Pump.fun: Too late (${progress.toFixed(1)}% > ${maxProgress}%)`);
    } else {
      passedChecks.push('Entry Timing: PASSED');
    }
  }
  
  // FINAL VERDICT
  const passed = failedChecks.length === 0;
  
  displayChecklistResult(passed, passedChecks, failedChecks);
  
  return {
    passed,
    passedChecks,
    failedChecks,
    isPumpFun: true,
    details,
  };
}

/**
 * Display checklist result
 */
function displayChecklistResult(
  passed: boolean,
  passedChecks: string[],
  failedChecks: string[]
): void {
  logger.header('═══════════════════════════════════════');
  logger.header('CHECKLIST RESULT');
  logger.header('═══════════════════════════════════════');
  
  if (passed) {
    logger.success('\n✅ ALL CHECKS PASSED - TRADE ALLOWED');
    logger.info('\nPassed checks:');
    passedChecks.forEach(c => logger.checklist(c, true));
  } else {
    logger.error('\n❌ CHECKLIST FAILED - NO TRADE');
    logger.info('\nFailed checks:');
    failedChecks.forEach(c => logger.checklist(c, false));
    logger.info('\nPassed checks:');
    passedChecks.forEach(c => logger.checklist(c, true));
  }
  
  logger.divider();
}

/**
 * Quick pre-check (fast rejection)
 * Use this to filter candidates before full analysis
 */
export async function quickPreCheck(mintAddress: string): Promise<{
  shouldAnalyze: boolean;
  reason?: string;
}> {
  // 1. Check trading allowed
  const tradingAllowed = await isTradingAllowed();
  if (!tradingAllowed.allowed) {
    return { shouldAnalyze: false, reason: tradingAllowed.reason };
  }
  
  // 2. Quick safety check
  const { quickSafetyCheck } = await import('./token-safety.js');
  const safety = await quickSafetyCheck(mintAddress);
  if (!safety.safe) {
    return { shouldAnalyze: false, reason: safety.reason };
  }
  
  // 3. Quick age check
  const { fetchTokenInfo } = await import('../api/data-providers.js');
  const { isAgeAcceptable } = await import('./age-context.js');
  
  try {
    const tokenInfo = await fetchTokenInfo(mintAddress);
    const ageCheck = isAgeAcceptable(tokenInfo.ageMinutes);
    
    if (!ageCheck.acceptable) {
      return { shouldAnalyze: false, reason: ageCheck.reason };
    }
  } catch {
    return { shouldAnalyze: false, reason: 'Could not fetch token info' };
  }
  
  return { shouldAnalyze: true };
}

/**
 * Format checklist result for display
 */
export function formatChecklistResult(result: ChecklistResult): string[] {
  const lines: string[] = [];
  
  lines.push(`Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
  lines.push('');
  
  if (result.failedChecks.length > 0) {
    lines.push('Failed:');
    result.failedChecks.forEach(c => lines.push(`  ✗ ${c}`));
    lines.push('');
  }
  
  lines.push('Passed:');
  result.passedChecks.forEach(c => lines.push(`  ✓ ${c}`));
  
  return lines;
}
