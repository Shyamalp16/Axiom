/**
 * TEST AXIOM WALLET TRACKER API
 * 
 * Tests the wallet tracking endpoints
 * Run: npx tsx src/cli/test-wallet-tracker.ts
 */

import 'dotenv/config';
import logger from '../utils/logger.js';
import {
  loadAxiomAuthFromEnv,
  isAxiomAuthenticated,
  getAxiomTrackedWallets,
  getAxiomTrackedWalletTransactions,
  getAxiomTrackedWalletFirstBuys,
  monitorTrackedWallets,
} from '../api/axiom-trade.js';

async function main() {
  logger.header('AXIOM WALLET TRACKER TEST');
  
  // Load auth tokens
  logger.info('Loading Axiom auth tokens...');
  if (!loadAxiomAuthFromEnv()) {
    logger.error('Failed to load Axiom auth tokens');
    logger.info('');
    logger.info('To set up authentication:');
    logger.info('1. Go to https://axiom.trade and log in');
    logger.info('2. Open DevTools (F12) → Application → Cookies');
    logger.info('3. Copy "auth-access-token" and "auth-refresh-token"');
    logger.info('4. Add to your .env file:');
    logger.info('   AXIOM_ACCESS_TOKEN=your_access_token');
    logger.info('   AXIOM_REFRESH_TOKEN=your_refresh_token');
    process.exit(1);
  }
  
  if (!isAxiomAuthenticated()) {
    logger.error('Not authenticated with Axiom');
    process.exit(1);
  }
  
  logger.success('Axiom authenticated!');
  logger.info('');
  
  // ============================================
  // TEST 1: Get Tracked Wallets
  // ============================================
  logger.header('TEST 1: Get Tracked Wallets');
  
  try {
    const { groups, trackedWallets } = await getAxiomTrackedWallets();
    
    logger.success(`Found ${trackedWallets.length} tracked wallet(s) in ${groups.length} group(s)`);
    
    if (groups.length > 0) {
      logger.info('');
      logger.info('Groups:');
      groups.forEach(g => {
        logger.info(`  ${g.groupEmoji} ${g.groupName} (ID: ${g.groupId})`);
      });
    }
    
    if (trackedWallets.length > 0) {
      logger.info('');
      logger.info('Tracked Wallets:');
      trackedWallets.forEach(w => {
        const lastActive = new Date(w.lastActiveAt);
        const minutesAgo = Math.floor((Date.now() - lastActive.getTime()) / 60000);
        logger.info(`  ${w.emoji} ${w.name}`);
        logger.info(`    Address: ${w.trackedWalletAddress}`);
        logger.info(`    Balance: ${w.solBalance.toFixed(2)} SOL`);
        logger.info(`    Last Active: ${minutesAgo} min ago`);
        logger.info('');
      });
    } else {
      logger.warn('No wallets tracked yet. Add some wallets at https://axiom.trade/trackers');
    }
    
  } catch (error) {
    logger.error('Failed to get tracked wallets:', error);
  }
  
  // ============================================
  // TEST 2: Get Recent Transactions
  // ============================================
  logger.header('TEST 2: Get Recent Transactions');
  
  try {
    const transactions = await getAxiomTrackedWalletTransactions();
    
    logger.success(`Found ${transactions.length} recent transaction(s)`);
    
    if (transactions.length > 0) {
      logger.info('');
      logger.info('Last 5 transactions:');
      
      const recent = transactions.slice(0, 5);
      recent.forEach(tx => {
        const emoji = tx.type === 'buy' ? '🟢' : '🔴';
        const time = new Date(tx.transactionTime).toLocaleTimeString();
        logger.info(`  ${emoji} ${tx.detailedType} - ${tx.tokenTicker}`);
        logger.info(`    Wallet: ${tx.walletAddress.slice(0, 8)}...`);
        logger.info(`    Amount: ${tx.totalSol.toFixed(4)} SOL ($${tx.totalUsd.toFixed(2)})`);
        logger.info(`    PnL: ${tx.pnlSol >= 0 ? '+' : ''}${tx.pnlSol.toFixed(4)} SOL`);
        logger.info(`    Time: ${time}`);
        logger.info(`    Token: ${tx.tokenAddress}`);
        logger.info('');
      });
    }
    
  } catch (error) {
    logger.error('Failed to get transactions:', error);
  }
  
  // ============================================
  // TEST 3: Get First Buys Only
  // ============================================
  logger.header('TEST 3: Get First Buys (Fresh Entries)');
  
  try {
    const firstBuys = await getAxiomTrackedWalletFirstBuys({ limit: 5 });
    
    logger.success(`Found ${firstBuys.length} first buy(s)`);
    
    if (firstBuys.length > 0) {
      logger.info('');
      logger.info('Recent First Buys (best copy trading signals):');
      
      firstBuys.forEach(tx => {
        const time = new Date(tx.transactionTime).toLocaleTimeString();
        const tokenAge = Math.floor((Date.now() - new Date(tx.pairCreatedAt).getTime()) / 60000);
        logger.info(`  🎯 ${tx.tokenTicker} (${tx.tokenName})`);
        logger.info(`    Wallet: ${tx.walletAddress.slice(0, 8)}...`);
        logger.info(`    Entry: ${tx.totalSol.toFixed(4)} SOL at MC $${tx.averageMcBought?.toFixed(0) || 'N/A'}K`);
        logger.info(`    Token Age: ${tokenAge} min`);
        logger.info(`    Protocol: ${tx.realProtocol}`);
        logger.info(`    Time: ${time}`);
        logger.info(`    Token: ${tx.tokenAddress}`);
        logger.info('');
      });
    }
    
  } catch (error) {
    logger.error('Failed to get first buys:', error);
  }
  
  // ============================================
  // TEST 4: Live Monitoring (10 seconds)
  // ============================================
  logger.header('TEST 4: Live Monitoring (10 seconds)');
  logger.info('Monitoring for new transactions...');
  
  const stopMonitor = monitorTrackedWallets(
    (newTxs) => {
      newTxs.forEach(tx => {
        const emoji = tx.type === 'buy' ? '🟢' : '🔴';
        // Use wallet name if available, otherwise fallback to truncated address
        const walletDisplay = tx.walletName 
          ? `${tx.walletEmoji || ''} ${tx.walletName}`.trim()
          : tx.walletAddress.slice(0, 8) + '...';
        const message = `${emoji} NEW: ${tx.detailedType} ${tx.tokenTicker} by ${walletDisplay} (${tx.totalSol.toFixed(4)} SOL)`;
        if (tx.type === 'buy') {
          logger.success(message);
        } else {
          logger.warn(message);
        }
      });
    },
    {
      pollIntervalMs: 3000,
      onlyBuys: false, // Set to true to only see buys
      includeWalletNames: true, // Enriches transactions with wallet names
    }
  );
  
  // Stop after 10 seconds
  await new Promise(resolve => setTimeout(resolve, 10000));
  stopMonitor();
  
  logger.info('');
  logger.success('Wallet tracker test complete!');
  logger.info('');
  logger.info('Available functions:');
  logger.info('  getAxiomTrackedWallets() - Get your tracked wallets');
  logger.info('  getAxiomTrackedWalletTransactions() - Get all transactions');
  logger.info('  getAxiomTrackedWalletBuys() - Get only buys');
  logger.info('  getAxiomTrackedWalletFirstBuys() - Get fresh entries');
  logger.info('  monitorTrackedWallets(callback) - Live monitoring');
}

main().catch(console.error);
