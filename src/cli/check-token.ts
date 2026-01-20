/**
 * CLI: Check Token
 * Run pre-trade checklist on a token without trading
 * 
 * Usage: npm run check <mint_address>
 */

import { runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import { fetchTokenInfo } from '../api/data-providers.js';
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
  
  try {
    // Get token info first
    logger.info('Fetching token info...');
    const tokenInfo = await fetchTokenInfo(mintAddress);
    
    logger.box('Token Info', [
      `Symbol: ${tokenInfo.symbol}`,
      `Name: ${tokenInfo.name}`,
      `Age: ${tokenInfo.ageMinutes.toFixed(1)} minutes`,
      `Decimals: ${tokenInfo.decimals}`,
    ]);
    
    // Run full checklist
    const result = await runPreTradeChecklist(mintAddress);
    
    // Exit code based on result
    process.exit(result.passed ? 0 : 1);
    
  } catch (error) {
    logger.error('Check failed:', error);
    process.exit(1);
  }
}

main();
