/**
 * CLI: Test Price Monitor
 * Tests the price monitoring module by subscribing to a token's trades
 * and displaying price + market cap updates for 30 seconds
 * 
 * Usage: npm run test:price
 */

import 'dotenv/config';
import inquirer from 'inquirer';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connectPumpPortal, subscribeTokenTrades, getSolPrice, fetchTokenViaPumpPortal } from '../api/pump-portal.js';
import logger from '../utils/logger.js';

// Test duration in seconds
const TEST_DURATION_SECONDS = 30;

// Stats tracking
interface PriceStats {
  updateCount: number;
  lastPrice: number;
  lastMarketCap: number;
  highPrice: number;
  lowPrice: number;
  highMC: number;
  lowMC: number;
  startPrice: number;
  startMC: number;
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           PRICE MONITOR TEST - WebSocket Feed             ║
╠═══════════════════════════════════════════════════════════╣
║  This test subscribes to real-time trade data via         ║
║  PumpPortal WebSocket and displays price/MC updates       ║
║  for ${TEST_DURATION_SECONDS} seconds.                                       ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  // Prompt for mint address
  const { mintAddress } = await inquirer.prompt<{ mintAddress: string }>([
    {
      type: 'input',
      name: 'mintAddress',
      message: 'Enter token mint address:',
      validate: (input: string) => {
        if (!input || input.trim().length === 0) {
          return 'Mint address is required';
        }
        if (input.length < 32 || input.length > 44) {
          return 'Invalid Solana address format (should be 32-44 characters)';
        }
        return true;
      },
    },
  ]);
  
  const mint = mintAddress.trim();
  
  logger.info(`Testing price monitor for: ${mint.slice(0, 8)}...${mint.slice(-8)}`);
  logger.divider();
  
  try {
    // Get initial token info
    logger.info('Fetching initial token data...');
    const tokenInfo = await fetchTokenViaPumpPortal(mint, 10000);
    
    if (tokenInfo) {
      logger.box(`Token: ${tokenInfo.symbol} (${tokenInfo.name})`, [
        `Price: ${tokenInfo.priceSol.toExponential(4)} SOL`,
        `Market Cap: $${tokenInfo.marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `Age: ${tokenInfo.ageMinutes.toFixed(1)} minutes`,
        `Graduated: ${tokenInfo.isGraduated ? 'YES (on Raydium)' : 'NO (bonding curve)'}`,
      ]);
    } else {
      logger.warn('Could not fetch initial token info, will try WebSocket...');
    }
    
    // Connect to PumpPortal WebSocket
    logger.info('Connecting to PumpPortal WebSocket...');
    await connectPumpPortal();
    logger.success('WebSocket connected!');
    
    // Get SOL price for USD calculations
    const solPrice = await getSolPrice();
    logger.info(`SOL Price: $${solPrice.toFixed(2)}`);
    
    logger.divider();
    logger.info(`Starting ${TEST_DURATION_SECONDS} second price monitor test...`);
    logger.info('Waiting for trades (prices update on each buy/sell)...\n');
    
    // Initialize stats
    const stats: PriceStats = {
      updateCount: 0,
      lastPrice: tokenInfo?.priceSol || 0,
      lastMarketCap: tokenInfo?.marketCapUsd || 0,
      highPrice: tokenInfo?.priceSol || 0,
      lowPrice: tokenInfo?.priceSol || Infinity,
      highMC: tokenInfo?.marketCapUsd || 0,
      lowMC: tokenInfo?.marketCapUsd || Infinity,
      startPrice: tokenInfo?.priceSol || 0,
      startMC: tokenInfo?.marketCapUsd || 0,
    };
    
    const startTime = Date.now();
    
    // Subscribe to token trades
    const unsubscribe = subscribeTokenTrades([mint], (trade) => {
      stats.updateCount++;
      
      // Calculate price from bonding curve reserves
      let vSol = trade.vSolInBondingCurve;
      let vTokens = trade.vTokensInBondingCurve;
      
      // Smart unit conversion
      if (vSol > 1e9) {
        vSol = vSol / LAMPORTS_PER_SOL;
      }
      if (vTokens > 1e12) {
        vTokens = vTokens / 1e6;
      }
      
      if (vSol <= 0 || vTokens <= 0) {
        return;
      }
      
      const priceSol = vSol / vTokens;
      const priceUsd = priceSol * solPrice;
      
      // Calculate market cap
      let marketCapSol = trade.marketCapSol;
      if (marketCapSol > 1e9) {
        marketCapSol = marketCapSol / LAMPORTS_PER_SOL;
      }
      const marketCapUsd = marketCapSol * solPrice;
      
      // Update stats
      stats.lastPrice = priceSol;
      stats.lastMarketCap = marketCapUsd;
      
      if (stats.startPrice === 0) {
        stats.startPrice = priceSol;
        stats.startMC = marketCapUsd;
      }
      
      if (priceSol > stats.highPrice) stats.highPrice = priceSol;
      if (priceSol < stats.lowPrice) stats.lowPrice = priceSol;
      if (marketCapUsd > stats.highMC) stats.highMC = marketCapUsd;
      if (marketCapUsd < stats.lowMC) stats.lowMC = marketCapUsd;
      
      // Calculate price change from start
      const priceChange = stats.startPrice > 0 
        ? ((priceSol - stats.startPrice) / stats.startPrice) * 100 
        : 0;
      
      // Calculate time elapsed
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = TEST_DURATION_SECONDS - elapsed;
      
      // Determine trade type indicator
      const tradeType = trade.txType === 'buy' ? '🟢 BUY ' : '🔴 SELL';
      const tradeSize = (trade.solAmount / LAMPORTS_PER_SOL).toFixed(4);
      
      // Format output
      const changeIndicator = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;
      const changeColor = priceChange >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      
      console.log(
        `[${remaining.toString().padStart(2, '0')}s] ${tradeType} ${tradeSize} SOL | ` +
        `Price: ${priceSol.toExponential(4)} SOL ($${priceUsd.toExponential(3)}) | ` +
        `MC: $${marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(10)} | ` +
        `${changeColor}${changeIndicator}${reset}`
      );
    });
    
    // Set timeout to end test
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, TEST_DURATION_SECONDS * 1000);
      
      // Also handle graceful shutdown
      process.on('SIGINT', () => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
    
    // Display summary
    console.log('\n');
    logger.divider();
    logger.header('TEST COMPLETE - SUMMARY');
    
    if (stats.updateCount === 0) {
      logger.warn('No trades received during the test period.');
      logger.info('This could mean:');
      logger.info('  - The token has low trading activity');
      logger.info('  - The token has graduated to Raydium (trades not on pump.fun)');
      logger.info('  - The mint address may be incorrect');
    } else {
      logger.box('Price Statistics', [
        `Total Updates: ${stats.updateCount} trades`,
        `Start Price: ${stats.startPrice.toExponential(4)} SOL`,
        `End Price: ${stats.lastPrice.toExponential(4)} SOL`,
        `High: ${stats.highPrice.toExponential(4)} SOL`,
        `Low: ${stats.lowPrice.toExponential(4)} SOL`,
        `Price Change: ${((stats.lastPrice - stats.startPrice) / stats.startPrice * 100).toFixed(2)}%`,
      ]);
      
      logger.box('Market Cap Statistics', [
        `Start MC: $${stats.startMC.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `End MC: $${stats.lastMarketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `High MC: $${stats.highMC.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        `Low MC: $${stats.lowMC.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      ]);
      
      logger.success(`Received ${stats.updateCount} price updates in ${TEST_DURATION_SECONDS} seconds`);
      logger.info(`Average: ${(stats.updateCount / TEST_DURATION_SECONDS).toFixed(2)} trades/second`);
    }
    
    process.exit(0);
    
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
