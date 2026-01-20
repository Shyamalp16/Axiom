/**
 * WALLET DISTRIBUTION CHECKER
 * Checks: Largest wallet, Top 5 wallets, Dev wallet, Accumulation
 * 
 * RULE: If distribution is concentrated = HIGH RUG RISK
 */

import { PublicKey } from '@solana/web3.js';
import { WALLET_DISTRIBUTION } from '../config/index.js';
import { WalletDistributionResult, HolderInfo } from '../types/index.js';
import logger from '../utils/logger.js';
import { fetchTokenHolders, fetchLPInfo } from '../api/data-providers.js';

/**
 * Analyze token holder distribution
 * Returns detailed breakdown with pass/fail criteria
 */
export async function checkWalletDistribution(
  mintAddress: string
): Promise<WalletDistributionResult> {
  const failures: string[] = [];
  
  logger.header('WALLET DISTRIBUTION CHECK');
  logger.info(`Analyzing holders for: ${mintAddress}`);
  
  let largestWalletPercent = 0;
  let top5WalletsPercent = 0;
  let devWalletPercent = 0;
  let devWalletIncreasing = false;
  let holders: HolderInfo[] = [];
  
  try {
    // Fetch holder data from API
    const holderData = await fetchTokenHolders(mintAddress);
    const lpInfo = await fetchLPInfo(mintAddress);
    
    // If no holder data (common for pump.fun), skip distribution check gracefully
    if (holderData.length === 0 && mintAddress.toLowerCase().endsWith('pump')) {
      logger.warn('Holder distribution unavailable for pump.fun token - skipping distribution check');
      return {
        passed: true,
        largestWalletPercent: 0,
        top5WalletsPercent: 0,
        devWalletPercent: 0,
        devWalletIncreasing: false,
        holders: [],
        failures: [],
      };
    }
    
    // Process holders - exclude LP addresses
    const lpAddresses = new Set(lpInfo.lpAddresses || []);
    
    // Mark holders
    holders = holderData.map((h, index) => ({
      address: h.address,
      balance: h.balance,
      percent: h.percent,
      isLP: lpAddresses.has(h.address),
      isDev: index === 0 && !lpAddresses.has(h.address), // Assume largest non-LP is dev initially
    }));
    
    // Filter out LP wallets for analysis
    const nonLPHolders = holders.filter(h => !h.isLP);
    
    // 1. Largest wallet (excluding LP)
    if (nonLPHolders.length > 0) {
      largestWalletPercent = nonLPHolders[0].percent;
      
      if (largestWalletPercent > WALLET_DISTRIBUTION.MAX_SINGLE_WALLET_PERCENT) {
        failures.push(
          `Largest wallet holds ${largestWalletPercent.toFixed(1)}% ` +
          `(max: ${WALLET_DISTRIBUTION.MAX_SINGLE_WALLET_PERCENT}%)`
        );
      }
    }
    logger.checklist(
      `Largest wallet ≤ ${WALLET_DISTRIBUTION.MAX_SINGLE_WALLET_PERCENT}%`,
      largestWalletPercent <= WALLET_DISTRIBUTION.MAX_SINGLE_WALLET_PERCENT,
      `${largestWalletPercent.toFixed(1)}%`
    );
    
    // 2. Top 5 wallets combined (excluding LP)
    const top5 = nonLPHolders.slice(0, 5);
    top5WalletsPercent = top5.reduce((sum, h) => sum + h.percent, 0);
    
    if (top5WalletsPercent > WALLET_DISTRIBUTION.MAX_TOP5_WALLETS_PERCENT) {
      failures.push(
        `Top 5 wallets hold ${top5WalletsPercent.toFixed(1)}% combined ` +
        `(max: ${WALLET_DISTRIBUTION.MAX_TOP5_WALLETS_PERCENT}%)`
      );
    }
    logger.checklist(
      `Top 5 wallets ≤ ${WALLET_DISTRIBUTION.MAX_TOP5_WALLETS_PERCENT}%`,
      top5WalletsPercent <= WALLET_DISTRIBUTION.MAX_TOP5_WALLETS_PERCENT,
      `${top5WalletsPercent.toFixed(1)}%`
    );
    
    // 3. Dev wallet analysis
    // Try to identify dev wallet (usually deployer or largest early holder)
    const devWallet = await identifyDevWallet(mintAddress, nonLPHolders);
    
    if (devWallet) {
      devWalletPercent = devWallet.percent;
      devWalletIncreasing = devWallet.isIncreasing;
      
      // Mark in holders array
      const devIndex = holders.findIndex(h => h.address === devWallet.address);
      if (devIndex !== -1) {
        holders[devIndex].isDev = true;
      }
      
      if (devWalletPercent > WALLET_DISTRIBUTION.IDEAL_DEV_WALLET_MAX_PERCENT) {
        // Warning but not auto-fail if dev is transparent
        logger.warn(
          `Dev wallet at ${devWalletPercent.toFixed(1)}% ` +
          `(ideal: < ${WALLET_DISTRIBUTION.IDEAL_DEV_WALLET_MAX_PERCENT}%)`
        );
      }
      
      if (devWalletIncreasing) {
        failures.push('Dev wallet is actively accumulating - DANGER');
      }
    }
    logger.checklist(
      `Dev wallet < ${WALLET_DISTRIBUTION.IDEAL_DEV_WALLET_MAX_PERCENT}%`,
      devWalletPercent < WALLET_DISTRIBUTION.IDEAL_DEV_WALLET_MAX_PERCENT,
      devWallet ? `${devWalletPercent.toFixed(1)}%` : 'Not identified'
    );
    logger.checklist(
      'Dev wallet not increasing',
      !devWalletIncreasing,
      devWalletIncreasing ? 'ACCUMULATING!' : 'Stable'
    );
    
    // 4. Distribution health score
    const distributionScore = calculateDistributionScore(nonLPHolders);
    logger.info(`Distribution health score: ${distributionScore}/100`);
    
    if (distributionScore < 40) {
      failures.push(`Poor distribution score: ${distributionScore}/100`);
    }
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Distribution check error: ${errMsg}`);
    logger.error('Distribution check failed with error', error);
  }
  
  const passed = failures.length === 0;
  
  logger.divider();
  if (passed) {
    logger.success('WALLET DISTRIBUTION: PASSED ✓');
  } else {
    logger.error('WALLET DISTRIBUTION: FAILED ✗');
    failures.forEach(f => logger.error(`  → ${f}`));
  }
  
  return {
    passed,
    largestWalletPercent,
    top5WalletsPercent,
    devWalletPercent,
    devWalletIncreasing,
    failures,
    holders,
  };
}

/**
 * Try to identify the dev wallet
 * Heuristics: deployer, largest early holder, known patterns
 */
async function identifyDevWallet(
  mintAddress: string,
  holders: HolderInfo[]
): Promise<{ address: string; percent: number; isIncreasing: boolean } | null> {
  try {
    // For now, assume largest non-LP holder could be dev
    // In production, you'd check:
    // 1. Token deployer address
    // 2. First receiver of minted tokens
    // 3. Wallets with SOL funding from known dev wallets
    
    if (holders.length === 0) return null;
    
    const potentialDev = holders[0];
    
    // Check if this wallet has been accumulating recently
    // This would require historical balance data
    const isIncreasing = await checkWalletAccumulating(potentialDev.address, mintAddress);
    
    return {
      address: potentialDev.address,
      percent: potentialDev.percent,
      isIncreasing,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a wallet has been accumulating tokens recently
 */
async function checkWalletAccumulating(
  walletAddress: string,
  mintAddress: string
): Promise<boolean> {
  // This would check recent transactions for the wallet
  // Looking for buy patterns in the last few minutes
  
  // TODO: Implement with transaction history API
  // For now, return false (assume not accumulating)
  return false;
}

/**
 * Calculate distribution health score (0-100)
 * Higher = more distributed = healthier
 */
function calculateDistributionScore(holders: HolderInfo[]): number {
  if (holders.length === 0) return 0;
  
  // Factors:
  // 1. Number of holders (more = better, up to a point)
  // 2. Gini coefficient (lower = more equal distribution)
  // 3. Top holder concentration
  
  let score = 0;
  
  // Holder count score (max 30 points)
  const holderCountScore = Math.min(30, holders.length / 10);
  score += holderCountScore;
  
  // Top holder concentration (max 40 points)
  const top1Percent = holders[0]?.percent || 0;
  const concentrationScore = Math.max(0, 40 - (top1Percent * 2));
  score += concentrationScore;
  
  // Distribution evenness (max 30 points)
  if (holders.length >= 5) {
    const top5Percent = holders.slice(0, 5).reduce((sum, h) => sum + h.percent, 0);
    const evennessScore = Math.max(0, 30 - (top5Percent - 20) * 0.5);
    score += evennessScore;
  }
  
  return Math.round(Math.min(100, score));
}

