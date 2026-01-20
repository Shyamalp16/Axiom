#!/usr/bin/env node
/**
 * AUTO-TRADE CLI
 * 
 * Command-line interface for the autonomous trading bot
 * 
 * Usage:
 *   npx ts-node src/cli/auto-trade.ts start    # Start autonomous trading
 *   npx ts-node src/cli/auto-trade.ts status   # Show current status
 *   npx ts-node src/cli/auto-trade.ts stop     # Stop the bot (via file signal)
 */

import { getAutoTradingBot, resetAutoTradingBot } from '../bot/auto-orchestrator.js';
import { getActivePositions, displayPositionStatus } from '../trading/position-manager.js';
import { displayTradeSummary } from '../storage/trade-logger.js';
import logger from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

// Command handlers
const commands: Record<string, () => Promise<void>> = {
  start: startBot,
  status: showStatus,
  stop: stopBot,
  positions: showPositions,
  stats: showStats,
  help: showHelp,
};

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase() || 'help';
  
  const handler = commands[command];
  
  if (!handler) {
    logger.error(`Unknown command: ${command}`);
    await showHelp();
    process.exit(1);
  }
  
  try {
    await handler();
  } catch (error) {
    logger.error('Command failed:', error);
    process.exit(1);
  }
}

/**
 * Start the autonomous trading bot
 */
async function startBot(): Promise<void> {
  logger.header('AXIOM AUTO-TRADER');
  logger.info('Starting autonomous trading mode...\n');
  
  const bot = getAutoTradingBot();
  
  // Initialize
  const initialized = await bot.initialize();
  if (!initialized) {
    logger.error('Failed to initialize bot');
    process.exit(1);
  }
  
  // Show warning
  logger.divider();
  logger.warn('⚠️  AUTONOMOUS TRADING MODE');
  logger.warn('The bot will automatically:');
  logger.warn('  - Discover and analyze pump.fun tokens');
  logger.warn('  - Execute trades when criteria are met');
  logger.warn('  - Monitor positions and execute TP/SL');
  logger.divider();
  logger.info('Press Ctrl+C to stop gracefully\n');
  
  // Short delay to let user read the warning
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Run the bot (blocks until stopped)
  await bot.run();
}

/**
 * Show current bot status
 */
async function showStatus(): Promise<void> {
  const bot = getAutoTradingBot();
  
  // Try to initialize (just to load state)
  try {
    await bot.initialize();
  } catch {
    // Ignore initialization errors for status check
  }
  
  bot.displayStatus();
}

/**
 * Stop the bot (creates a stop signal file)
 */
async function stopBot(): Promise<void> {
  logger.info('Sending stop signal to bot...');
  
  // Create a stop signal file that the bot can watch for
  const stopFile = path.join(process.cwd(), '.stop-trading');
  
  try {
    fs.writeFileSync(stopFile, `Stop requested at ${new Date().toISOString()}`);
    logger.success('Stop signal sent');
    logger.info(`Created ${stopFile}`);
    logger.info('The bot will stop gracefully on next iteration');
  } catch (error) {
    logger.error('Failed to create stop file:', error);
  }
}

/**
 * Show active positions
 */
async function showPositions(): Promise<void> {
  const positions = getActivePositions();
  
  logger.header('ACTIVE POSITIONS');
  
  if (positions.length === 0) {
    logger.info('No active positions');
    return;
  }
  
  for (const position of positions) {
    displayPositionStatus(position);
  }
}

/**
 * Show trading statistics
 */
async function showStats(): Promise<void> {
  displayTradeSummary();
}

/**
 * Show help information
 */
async function showHelp(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               AXIOM AUTO-TRADER CLI                           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Commands:                                                    ║
║    npm run auto         Start autonomous trading (LIVE)       ║
║    npm run paper:auto   Start autonomous trading (PAPER)      ║
║                                                               ║
║  Paper Trading (Interactive):                                 ║
║    npm run paper        Interactive paper trading             ║
║    npm run paper:stats  View paper trading statistics         ║
║    npm run paper:reset  Reset paper trading history           ║
║    npm run paper:export Export paper trades to CSV            ║
║                                                               ║
║  Utilities:                                                   ║
║    npm run check        Check a specific token                ║
║    npm run status       Show bot status                       ║
║    npm run test:setup   Test wallet and RPC setup             ║
║                                                               ║
║  Environment Variables Required (.env):                       ║
║    SOLANA_RPC_URL       - Solana RPC endpoint                 ║
║    WALLET_PRIVATE_KEY   - Base58 encoded private key          ║
║    HELIUS_API_KEY       - Helius API key (or BIRDEYE)         ║
║                                                               ║
║  Paper Trading Mode:                                          ║
║    Simulates all trades without real transactions.            ║
║    Perfect for testing strategies risk-free.                  ║
║    Paper portfolio starts with 2 SOL by default.              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
