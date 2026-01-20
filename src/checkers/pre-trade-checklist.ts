/**
 * PRE-TRADE CHECKLIST
 * 
 * FAIL ONE = NO TRADE
 * 
 * This is the gatekeeper. If ANY check fails, we don't trade.
 * No exceptions. No "it looks good anyway". No FOMO.
 */

import { checkTokenSafety } from './token-safety.js';
import { checkWalletDistribution } from './wallet-distribution.js';
import { checkAgeContext } from './age-context.js';
import { analyzeVolumeMomentum } from './volume-momentum.js';
import { analyzeEntry } from '../trading/entry-logic.js';
import { isTradingAllowed } from '../trading/position-manager.js';
import logger from '../utils/logger.js';

export interface ChecklistResult {
  passed: boolean;
  passedChecks: string[];
  failedChecks: string[];
  details: {
    tokenSafety: Awaited<ReturnType<typeof checkTokenSafety>> | null;
    walletDistribution: Awaited<ReturnType<typeof checkWalletDistribution>> | null;
    ageContext: Awaited<ReturnType<typeof checkAgeContext>> | null;
    volumeMomentum: Awaited<ReturnType<typeof analyzeVolumeMomentum>> | null;
    entryAnalysis: Awaited<ReturnType<typeof analyzeEntry>> | null;
  };
}

/**
 * Run the complete pre-trade checklist
 * FAIL ONE = NO TRADE
 */
export async function runPreTradeChecklist(
  mintAddress: string
): Promise<ChecklistResult> {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  
  logger.header('═══════════════════════════════════════');
  logger.header('PRE-TRADE CHECKLIST');
  logger.header('═══════════════════════════════════════');
  logger.info(`Token: ${mintAddress}`);
  logger.info(`Time: ${new Date().toISOString()}`);
  logger.divider();
  
  // Initialize details
  const details: ChecklistResult['details'] = {
    tokenSafety: null,
    walletDistribution: null,
    ageContext: null,
    volumeMomentum: null,
    entryAnalysis: null,
  };
  
  // 0. Check if trading is allowed (daily/weekly limits)
  const tradingAllowed = await isTradingAllowed();
  if (!tradingAllowed.allowed) {
    failedChecks.push(`Trading disabled: ${tradingAllowed.reason}`);
    logger.error(`TRADING DISABLED: ${tradingAllowed.reason}`);
    
    return {
      passed: false,
      passedChecks,
      failedChecks,
      details,
    };
  }
  passedChecks.push('Trading limits OK');
  
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
        details,
      };
    }
    
    passedChecks.push('Token Safety: PASSED');
  } catch (error) {
    failedChecks.push('Safety: Check failed with error');
    return { passed: false, passedChecks, failedChecks, details };
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
  
  return {
    passed,
    passedChecks,
    failedChecks,
    details,
  };
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
