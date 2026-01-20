#!/usr/bin/env node
/**
 * TEST AXIOM TRADE API
 * 
 * Test the Axiom Trade integration
 * 
 * Usage:
 *   npm run test:axiom
 */

import 'dotenv/config';
import {
  loadAxiomAuthFromEnv,
  isAxiomAuthenticated,
  getAxiomTrending,
  getAxiomBuyQuote,
  getAxiomPortfolio,
  connectAxiomWebSocket,
  subscribeAxiomNewPairs,
  subscribeAxiomPrice,
  disconnectAxiomWebSocket,
} from '../api/axiom-trade.js';
import logger from '../utils/logger.js';

async function main(): Promise<void> {
  logger.header('AXIOM TRADE API TEST');
  
  // 1. Load auth from environment
  logger.info('Loading auth tokens from environment...');
  const loaded = loadAxiomAuthFromEnv();
  
  if (!loaded) {
    logger.error('Failed to load Axiom auth tokens');
    logger.info('\nTo set up Axiom Trade authentication:');
    logger.info('1. Go to https://axiom.trade and log in');
    logger.info('2. Open DevTools (F12) → Application → Cookies');
    logger.info('3. Copy the values of:');
    logger.info('   - auth-access-token');
    logger.info('   - auth-refresh-token');
    logger.info('4. Add to your .env file:');
    logger.info('   AXIOM_ACCESS_TOKEN=your_access_token_here');
    logger.info('   AXIOM_REFRESH_TOKEN=your_refresh_token_here');
    process.exit(1);
  }
  
  logger.success('Auth tokens loaded');
  
  // 2. Test trending tokens (CONFIRMED WORKING)
  logger.divider();
  logger.info('Testing trending tokens endpoint...');
  
  try {
    const trending = await getAxiomTrending('1h');
    logger.success(`Got ${trending.length} trending tokens!`);
    
    // Show top 5
    logger.info('\nTop 5 Trending (1h):');
    logger.info('─'.repeat(80));
    for (const token of trending.slice(0, 5)) {
      const change = token.marketCapPercentChange >= 0 ? `+${token.marketCapPercentChange.toFixed(1)}%` : `${token.marketCapPercentChange.toFixed(1)}%`;
      const mcapK = (token.marketCapSol * 127).toFixed(0); // Rough USD estimate at $127/SOL
      const volK = (token.volumeSol * 127 / 1000).toFixed(1);
      const holders = token.top10Holders.toFixed(1);
      logger.info(`  ${token.tokenTicker.padEnd(12)} | MC: $${mcapK.padStart(6)}k | Vol: $${volK.padStart(5)}k | ${change.padStart(7)} | Top10: ${holders}%`);
    }
    logger.info('─'.repeat(80));
  } catch (error) {
    logger.error('Trending tokens failed:', error);
  }
  
  // 4. Test WebSocket connection
  logger.divider();
  logger.info('Testing WebSocket connection...');
  
  try {
    await connectAxiomWebSocket('global');
    logger.success('WebSocket connected');
    
    // Subscribe to new pairs for 10 seconds
    logger.info('Listening for new pairs (10 seconds)...');
    
    const unsubNewPairs = subscribeAxiomNewPairs((pair) => {
      logger.info(`🆕 New pair: ${pair.symbol} (${pair.mint.slice(0, 8)}...)`);
    });
    
    // Wait 10 seconds
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Cleanup
    unsubNewPairs();
    disconnectAxiomWebSocket();
    logger.success('WebSocket test complete');
    
  } catch (error) {
    logger.error('WebSocket failed:', error);
  }
  
  logger.divider();
  logger.success('Axiom Trade API test complete');
}

main().catch(console.error);
