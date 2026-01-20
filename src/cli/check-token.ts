/**
 * CLI: Check Token
 * Run pre-trade checklist on a token without trading
 * 
 * Usage: npm run check <mint_address>
 */

import { runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import { fetchTokenInfo } from '../api/data-providers.js';
import { fetchPumpFunToken } from '../api/pump-fun.js';
import { DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

async function main() {
  const mintAddress = process.argv[2];
  
  if (!mintAddress) {
    console.log(`
Usage: npm run check <mint_address>

Example:
  npm run check EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    `);
    process.exit(1);
  }
  
  // Validate address format
  if (mintAddress.length < 32 || mintAddress.length > 44) {
    logger.error('Invalid Solana address format');
    process.exit(1);
  }
  
  console.log(`
╔═══════════════════════════════════════════╗
║         TOKEN SAFETY CHECK                ║
╚═══════════════════════════════════════════╝
  `);
  
  // Show active config
  logger.box('Active Config (DISCOVERY_CONFIG)', [
    `Age: ${DISCOVERY_CONFIG.minAgeMinutes}-${DISCOVERY_CONFIG.maxAgeMinutes} min`,
    `Progress: ${DISCOVERY_CONFIG.minProgress}-${DISCOVERY_CONFIG.maxProgress}%`,
    `Market Cap: $${DISCOVERY_CONFIG.minMarketCap.toLocaleString()}-$${DISCOVERY_CONFIG.maxMarketCap.toLocaleString()}`,
    `Min Trades: ${DISCOVERY_CONFIG.minTradeCount}`,
  ]);
  
  try {
    // Check if Pump.fun token
    const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
    let pumpToken = null;
    
    if (looksLikePumpFun) {
      logger.info('Detected Pump.fun token, fetching bonding curve data...');
      pumpToken = await fetchPumpFunToken(mintAddress);
      
      if (pumpToken) {
        logger.box('Pump.fun Token', [
          `Name: ${pumpToken.name} (${pumpToken.symbol})`,
          `Progress: ${pumpToken.bondingCurveProgress.toFixed(1)}%`,
          `Market Cap: $${pumpToken.marketCapUsd.toLocaleString()}`,
          `Age: ${pumpToken.ageMinutes.toFixed(1)} min`,
          `Graduated: ${pumpToken.isGraduated ? 'YES' : 'NO'}`,
        ]);
      }
    }
    
    // Get general token info
    if (!pumpToken) {
      logger.info('Fetching token info...');
      const tokenInfo = await fetchTokenInfo(mintAddress);
      
      logger.box('Token Info', [
        `Symbol: ${tokenInfo.symbol}`,
        `Name: ${tokenInfo.name}`,
        `Age: ${tokenInfo.ageMinutes.toFixed(1)} minutes`,
        `Decimals: ${tokenInfo.decimals}`,
      ]);
    }
    
    // Run full checklist
    const result = await runPreTradeChecklist(mintAddress);
    
    // Summary
    logger.divider();
    if (result.passed) {
      logger.success(`✅ TOKEN PASSED ALL CHECKS`);
    } else {
      logger.error(`❌ TOKEN FAILED - ${result.failedChecks.length} issue(s)`);
    }
    
    // Exit code based on result
    process.exit(result.passed ? 0 : 1);
    
  } catch (error) {
    logger.error('Check failed:', error);
    process.exit(1);
  }
}

main();
