/**
 * CLI: Status
 * Show trading stats and performance metrics
 * 
 * Usage: npm run status
 */

import { displayTradeSummary, analyzePatterns, getAllTrades } from '../storage/trade-logger.js';
import { getWalletBalance } from '../utils/solana.js';
import { getDailyStats, getWeeklyPnl } from '../trading/position-manager.js';
import { CONFIG } from '../config/index.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

async function main() {
  console.log(`
╔═══════════════════════════════════════════╗
║         AXIOM BOT STATUS                  ║
╚═══════════════════════════════════════════╝
  `);
  
  try {
    // Wallet balance
    try {
      const balance = await getWalletBalance();
      logger.box('Wallet', [
        `Balance: ${balance.toFixed(4)} SOL`,
        `Min Trade: ${CONFIG.positionSizing.MIN_PER_TRADE_SOL} SOL`,
        `Max Trade: ${CONFIG.positionSizing.MAX_PER_TRADE_SOL} SOL`,
      ]);
    } catch {
      logger.warn('Could not fetch wallet balance (check WALLET_PRIVATE_KEY)');
    }
    
    // Trading limits
    const dailyStats = getDailyStats();
    const weeklyPnl = getWeeklyPnl();
    
    logger.box('Daily Status', [
      `Trades: ${dailyStats.tradeCount}/${CONFIG.dailyLimits.MAX_TRADES_PER_DAY}`,
      `PnL: ${dailyStats.pnl >= 0 ? '+' : ''}${dailyStats.pnl.toFixed(4)} SOL`,
      `Limit: -${CONFIG.dailyLimits.MAX_DAILY_LOSS_SOL} SOL max loss`,
    ]);
    
    logger.box('Weekly Status', [
      `PnL: ${weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(4)} SOL`,
      `Limit: -${CONFIG.weeklyLimits.MAX_WEEKLY_LOSS_SOL} SOL max loss`,
    ]);
    
    // Trade history
    const trades = getAllTrades();
    
    if (trades.length > 0) {
      displayTradeSummary();
      
      // Show pattern insights if enough trades
      if (trades.length >= 10) {
        const patterns = analyzePatterns();
        
        logger.header('PATTERN INSIGHTS');
        logger.info(`Based on ${trades.length} trades:\n`);
        
        if (patterns.profitFactor >= 1.5) {
          logger.success(`✓ Strong profit factor: ${patterns.profitFactor.toFixed(2)}`);
        } else if (patterns.profitFactor >= 1) {
          logger.info(`○ Profit factor: ${patterns.profitFactor.toFixed(2)} (needs improvement)`);
        } else {
          logger.error(`✗ Negative profit factor: ${patterns.profitFactor.toFixed(2)}`);
        }
        
        if (patterns.avgTimeInWinningTrades < patterns.avgTimeInLosingTrades) {
          logger.success(`✓ Winning trades are faster than losing trades`);
        } else {
          logger.warn(`⚠ Losing trades are held longer than winners`);
        }
        
        // Best performing checklist items
        const bestChecks = Object.entries(patterns.checklistCorrelations)
          .filter(([_, rate]) => rate > 60)
          .sort((a, b) => b[1] - a[1]);
        
        if (bestChecks.length > 0) {
          logger.info('\nHighest win rate checklist items:');
          bestChecks.slice(0, 3).forEach(([check, rate]) => {
            logger.info(`  ${check}: ${rate.toFixed(0)}% win rate`);
          });
        }
      }
    } else {
      logger.info('No trade history yet. Start trading to see stats.');
    }
    
  } catch (error) {
    logger.error('Status check failed:', error);
    process.exit(1);
  }
}

main();
