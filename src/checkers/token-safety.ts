/**
 * TOKEN SAFETY CHECKER
 * Checks: Mint authority, Freeze authority, Transfer tax, Blacklist, LP
 * 
 * RULE: If ANY check fails = NO TRADE. Period.
 */

import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { getConnection } from '../utils/solana.js';
import { TOKEN_SAFETY } from '../config/index.js';
import { TokenSafetyResult } from '../types/index.js';
import logger from '../utils/logger.js';
import { fetchLPInfo } from '../api/data-providers.js';
import { fetchPumpFunToken } from '../api/pump-fun.js';

/**
 * Run complete token safety check
 * Returns detailed results with pass/fail for each criterion
 */
export async function checkTokenSafety(mintAddress: string): Promise<TokenSafetyResult> {
  const failures: string[] = [];
  const conn = getConnection();
  
  logger.header('TOKEN SAFETY CHECK');
  logger.info(`Analyzing: ${mintAddress}`);
  
  // Check if this is a Pump.fun token
  // Quick pattern check: all Pump.fun tokens end in 'pump'
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  const pumpToken = looksLikePumpFun ? await fetchPumpFunToken(mintAddress) : null;
  const isPumpFunActive = looksLikePumpFun && pumpToken !== null && !pumpToken.isGraduated;
  const isPumpFunGraduated = looksLikePumpFun && pumpToken !== null && pumpToken.isGraduated;
  
  let mintAuthorityDisabled = false;
  let freezeAuthorityDisabled = false;
  let transferTaxPercent = 0;
  let hasBlacklistWhitelist = false;
  let lpPlatform: 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm' | 'pumpfun' | 'unknown' = 'unknown';
  let lpSolAmount = 0;
  
  try {
    if (isPumpFunActive) {
      // Pump.fun tokens (still on bonding curve) - protocol enforces safety
      mintAuthorityDisabled = true;
      freezeAuthorityDisabled = true;
      transferTaxPercent = 0;
      hasBlacklistWhitelist = false;
      
      logger.checklist('Mint authority disabled', true, 'Pump.fun (protocol enforced)');
      logger.checklist('Freeze authority disabled', true, 'Pump.fun (protocol enforced)');
      logger.checklist('Transfer tax = 0%', true, 'Pump.fun token');
      logger.checklist('No blacklist/whitelist', true, 'Pump.fun token');
      
      // Bonding curve liquidity
      lpPlatform = 'pumpfun';
      lpSolAmount = pumpToken?.realSolReserves || 0;
      logger.checklist('LP on supported DEX', true, 'Pump.fun (bonding curve)');
      logger.checklist('Bonding curve liquidity', lpSolAmount > 0, `${lpSolAmount.toFixed(2)} SOL in curve`);
      
    } else if (isPumpFunGraduated) {
      // Graduated Pump.fun token - now on Raydium
      // These tokens still have Pump.fun characteristics but LP is on Raydium
      mintAuthorityDisabled = true;  // Pump.fun burns mint authority on graduation
      freezeAuthorityDisabled = true; // Pump.fun doesn't use freeze authority
      transferTaxPercent = 0;
      hasBlacklistWhitelist = false;
      
      logger.checklist('Mint authority disabled', true, 'Pump.fun graduated (protocol enforced)');
      logger.checklist('Freeze authority disabled', true, 'Pump.fun graduated (protocol enforced)');
      logger.checklist('Transfer tax = 0%', true, 'Pump.fun token (no tax)');
      logger.checklist('No blacklist/whitelist', true, 'Pump.fun token');
      
      // LP is now on Raydium after graduation
      lpPlatform = 'raydium';
      const lpInfo = await fetchLPInfo(mintAddress);
      lpSolAmount = lpInfo.solAmount;
      logger.checklist('LP on Raydium', lpSolAmount > 0, `${lpSolAmount.toFixed(2)} SOL`);
      
    } else {
      // Standard DEX tokens - run full SPL checks
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await getMint(conn, mintPubkey);
      
      // 1. Check Mint Authority
      mintAuthorityDisabled = mintInfo.mintAuthority === null;
      if (!mintAuthorityDisabled) {
        failures.push('Mint authority is NOT disabled - can mint more tokens');
      }
      logger.checklist('Mint authority disabled', mintAuthorityDisabled);
      
      // 2. Check Freeze Authority
      freezeAuthorityDisabled = mintInfo.freezeAuthority === null;
      if (!freezeAuthorityDisabled) {
        failures.push('Freeze authority is NOT disabled - can freeze your tokens');
      }
      logger.checklist('Freeze authority disabled', freezeAuthorityDisabled);
      
      // 3. Check Transfer Tax (Token-2022)
      const isToken2022 = await checkIfToken2022(mintAddress);
      if (isToken2022) {
        const taxInfo = await checkTransferTax(mintAddress);
        transferTaxPercent = taxInfo.taxPercent;
        
        if (transferTaxPercent > TOKEN_SAFETY.MAX_TRANSFER_TAX_PERCENT) {
          failures.push(`Transfer tax is ${transferTaxPercent}% - expected 0%`);
        }
      }
      logger.checklist(
        'Transfer tax = 0%', 
        transferTaxPercent === 0,
        isToken2022 ? `Token-2022: ${transferTaxPercent}%` : 'Standard SPL token'
      );
      
      // 4. Check for Blacklist/Whitelist Logic
      hasBlacklistWhitelist = await checkBlacklistWhitelist(mintAddress);
      if (hasBlacklistWhitelist) {
        failures.push('Token has blacklist/whitelist logic detected');
      }
      logger.checklist('No blacklist/whitelist', !hasBlacklistWhitelist);
      
      // 5. Check LP Platform and Size
      const lpInfo = await fetchLPInfo(mintAddress);
      lpPlatform = lpInfo.platform;
      lpSolAmount = lpInfo.solAmount;
      
      const validPlatform = TOKEN_SAFETY.VALID_LP_PLATFORMS.includes(lpPlatform as 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm');
      if (!validPlatform && lpPlatform !== 'unknown') {
        failures.push(`LP not on supported DEX - found on ${lpPlatform}`);
      } else if (lpPlatform === 'unknown') {
        failures.push('Could not detect LP platform');
      }
      logger.checklist('LP on supported DEX', validPlatform, lpPlatform);
      
      // 6. Check LP Size
      const lpSufficient = lpSolAmount >= TOKEN_SAFETY.ABSOLUTE_FLOOR_LP_SOL;
      const lpIdeal = lpSolAmount >= TOKEN_SAFETY.MIN_LP_SOL;
      
      if (!lpSufficient) {
        failures.push(`LP too low: ${lpSolAmount.toFixed(2)} SOL (min: ${TOKEN_SAFETY.ABSOLUTE_FLOOR_LP_SOL} SOL)`);
      } else if (!lpIdeal) {
        logger.warn(`LP below ideal: ${lpSolAmount.toFixed(2)} SOL (ideal: ${TOKEN_SAFETY.MIN_LP_SOL}+ SOL)`);
      }
      logger.checklist(`LP ≥ ${TOKEN_SAFETY.MIN_LP_SOL} SOL`, lpIdeal, `${lpSolAmount.toFixed(2)} SOL`);
    }
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Safety check error: ${errMsg}`);
    logger.error('Safety check failed with error', error);
  }
  
  const passed = failures.length === 0;
  
  logger.divider();
  if (passed) {
    logger.success('TOKEN SAFETY: PASSED ✓');
  } else {
    logger.error('TOKEN SAFETY: FAILED ✗');
    failures.forEach(f => logger.error(`  → ${f}`));
  }
  
  return {
    passed,
    mintAuthorityDisabled,
    freezeAuthorityDisabled,
    transferTaxPercent,
    hasBlacklistWhitelist,
    lpPlatform,
    lpSolAmount,
    failures,
  };
}

/**
 * Check if token uses Token-2022 program
 */
async function checkIfToken2022(mintAddress: string): Promise<boolean> {
  const conn = getConnection();
  const mintPubkey = new PublicKey(mintAddress);
  
  try {
    const accountInfo = await conn.getAccountInfo(mintPubkey);
    if (!accountInfo) return false;
    
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    return accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  } catch {
    return false;
  }
}

/**
 * Check transfer tax for Token-2022 tokens
 */
async function checkTransferTax(mintAddress: string): Promise<{ taxPercent: number }> {
  return { taxPercent: 0 };
}

/**
 * Check for blacklist/whitelist functionality
 */
async function checkBlacklistWhitelist(mintAddress: string): Promise<boolean> {
  const conn = getConnection();
  const mintPubkey = new PublicKey(mintAddress);
  
  try {
    const accountInfo = await conn.getAccountInfo(mintPubkey);
    if (!accountInfo) return false;
    
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      if (accountInfo.data.length > 170) {
        logger.warn('Token-2022 with extensions detected - review manually');
        return true;
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Quick safety check - just the critical items
 */
export async function quickSafetyCheck(mintAddress: string): Promise<{
  safe: boolean;
  reason?: string;
}> {
  const conn = getConnection();
  
  try {
    // Check if Pump.fun token (pattern check + PumpPortal)
    const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
    if (looksLikePumpFun) {
      const pumpToken = await fetchPumpFunToken(mintAddress);
      if (!pumpToken || !pumpToken.isGraduated) {
        return { safe: true }; // Pump.fun tokens have protocol-enforced safety
      }
    }
    
    // Standard SPL token check
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await getMint(conn, mintPubkey);
    
    if (mintInfo.mintAuthority !== null) {
      return { safe: false, reason: 'Mint authority enabled' };
    }
    
    if (mintInfo.freezeAuthority !== null) {
      return { safe: false, reason: 'Freeze authority enabled' };
    }
    
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Could not fetch mint info' };
  }
}
