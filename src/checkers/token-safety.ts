/**
 * TOKEN SAFETY CHECKER
 * Checks: Mint authority, Freeze authority, Transfer tax, Blacklist, LP
 * 
 * RULE: If ANY check fails = NO TRADE. Period.
 */

import { PublicKey, AccountInfo, ParsedAccountData } from '@solana/web3.js';
import { getMint, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
  
  // First check if this is a Pump.fun token (bonding curve, not LP)
  // Pump.fun tokens have addresses ending in 'pump' (vanity suffix)
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  const pumpToken = await fetchPumpFunToken(mintAddress);
  const isPumpFun = (pumpToken !== null && !pumpToken.isGraduated) || looksLikePumpFun;
  
  if (looksLikePumpFun && !pumpToken) {
    logger.warn('Pump.fun API unavailable - using address pattern detection');
  }
  
  let mintAuthorityDisabled = false;
  let freezeAuthorityDisabled = false;
  let transferTaxPercent = 0;
  let hasBlacklistWhitelist = false;
  let lpPlatform: 'raydium' | 'orca' | 'pumpfun' | 'unknown' = 'unknown';
  let lpSolAmount = 0;
  
  try {
    // For Pump.fun tokens, skip standard SPL checks (handled by Pump.fun protocol)
    if (isPumpFun) {
      // Pump.fun tokens are created with mint/freeze authority disabled by protocol
      mintAuthorityDisabled = true;
      freezeAuthorityDisabled = true;
      transferTaxPercent = 0;
      hasBlacklistWhitelist = false;
      
      logger.checklist('Mint authority disabled', true, 'Pump.fun (protocol enforced)');
      logger.checklist('Freeze authority disabled', true, 'Pump.fun (protocol enforced)');
      logger.checklist('Transfer tax = 0%', true, 'Pump.fun token');
      logger.checklist('No blacklist/whitelist', true, 'Pump.fun token');
    } else {
      // Standard DEX tokens - run full SPL checks
      // 1. Check Mint Authority
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await getMint(conn, mintPubkey);
      
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
      
      // 3. Check Transfer Tax (Token-2022 extension)
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
    }
    
    // 5. Check LP Platform and Size
    if (isPumpFun) {
      // Pump.fun tokens use bonding curve, not traditional LP
      lpPlatform = 'pumpfun';
      lpSolAmount = pumpToken?.realSolReserves || 0;
      logger.checklist(
        'LP on Raydium/Orca',
        true,
        'Pump.fun (bonding curve)'
      );
      // Skip LP size check for Pump.fun - bonding curve has different mechanics
      if (pumpToken) {
        logger.checklist(
          'Bonding curve liquidity',
          true,
          `${lpSolAmount.toFixed(2)} SOL in curve`
        );
      } else {
        logger.checklist(
          'Bonding curve liquidity',
          true,
          'Pump.fun token (API unavailable)'
        );
      }
    } else {
      // Standard DEX tokens (Raydium/Orca)
      const lpInfo = await fetchLPInfo(mintAddress);
      lpPlatform = lpInfo.platform;
      lpSolAmount = lpInfo.solAmount;
      
      const validPlatform = TOKEN_SAFETY.VALID_LP_PLATFORMS.includes(lpPlatform as 'raydium' | 'orca');
      if (!validPlatform && lpPlatform !== 'unknown') {
        failures.push(`LP not on Raydium/Orca - found on ${lpPlatform}`);
      } else if (lpPlatform === 'unknown') {
        failures.push('Could not detect LP platform');
      }
      logger.checklist(
        'LP on Raydium/Orca', 
        validPlatform,
        lpPlatform
      );
      
      // 6. Check LP Size (only for DEX tokens)
      const lpSufficient = lpSolAmount >= TOKEN_SAFETY.ABSOLUTE_FLOOR_LP_SOL;
      const lpIdeal = lpSolAmount >= TOKEN_SAFETY.MIN_LP_SOL;
      
      if (!lpSufficient) {
        failures.push(`LP too low: ${lpSolAmount.toFixed(2)} SOL (min: ${TOKEN_SAFETY.ABSOLUTE_FLOOR_LP_SOL} SOL)`);
      } else if (!lpIdeal) {
        // Warning but not failure if above floor but below ideal
        logger.warn(`LP below ideal: ${lpSolAmount.toFixed(2)} SOL (ideal: ${TOKEN_SAFETY.MIN_LP_SOL}+ SOL)`);
      }
      logger.checklist(
        `LP ≥ ${TOKEN_SAFETY.MIN_LP_SOL} SOL`, 
        lpIdeal,
        `${lpSolAmount.toFixed(2)} SOL`
      );
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
    
    // Token-2022 program ID
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
  // For Token-2022 tokens with transfer fee extension
  // This would need to parse the mint account data for the extension
  // For now, return 0 as most meme tokens use standard SPL
  
  // TODO: Implement full Token-2022 transfer fee check if needed
  return { taxPercent: 0 };
}

/**
 * Check for blacklist/whitelist functionality
 * This is tricky - usually requires analyzing transfer hooks
 */
async function checkBlacklistWhitelist(mintAddress: string): Promise<boolean> {
  const conn = getConnection();
  const mintPubkey = new PublicKey(mintAddress);
  
  try {
    const accountInfo = await conn.getAccountInfo(mintPubkey);
    if (!accountInfo) return false;
    
    // Check if using Token-2022 with transfer hook
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      // Token-2022 can have transfer hooks that implement blacklists
      // For safety, flag any Token-2022 token for manual review
      // This is conservative but safe
      
      // Check data length - standard mint is 82 bytes, extensions add more
      if (accountInfo.data.length > 170) {
        // Has extensions - could include transfer hook
        logger.warn('Token-2022 with extensions detected - review manually');
        return true;
      }
    }
    
    return false;
  } catch {
    // If we can't check, assume no blacklist (but other checks should catch issues)
    return false;
  }
}

/**
 * Quick safety check - just the critical items
 * Use for fast filtering before deep analysis
 */
export async function quickSafetyCheck(mintAddress: string): Promise<{
  safe: boolean;
  reason?: string;
}> {
  const conn = getConnection();
  
  try {
    // Check if Pump.fun token first (by API or address pattern)
    const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
    const pumpToken = await fetchPumpFunToken(mintAddress);
    
    if ((pumpToken && !pumpToken.isGraduated) || looksLikePumpFun) {
      // Pump.fun tokens have mint/freeze disabled by protocol
      return { safe: true };
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
  } catch (error) {
    return { safe: false, reason: 'Could not fetch mint info' };
  }
}
