/**
 * AXIOM SOLANA TRADING BOT
 * 
 * A disciplined memecoin trading bot with hard-coded safety rules.
 * 
 * Usage:
 *   npm run bot              - Start interactive mode
 *   npm run check <address>  - Check a token without trading
 *   npm run status           - Show bot status and stats
 */

import { bot } from './bot/orchestrator.js';
import logger from './utils/logger.js';
import inquirer from 'inquirer';

async function main() {
  // Display banner
  console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║     █████╗ ██╗  ██╗██╗ ██████╗ ███╗   ███╗                   ║
  ║    ██╔══██╗╚██╗██╔╝██║██╔═══██╗████╗ ████║                   ║
  ║    ███████║ ╚███╔╝ ██║██║   ██║██╔████╔██║                   ║
  ║    ██╔══██║ ██╔██╗ ██║██║   ██║██║╚██╔╝██║                   ║
  ║    ██║  ██║██╔╝ ██╗██║╚██████╔╝██║ ╚═╝ ██║                   ║
  ║    ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝     ╚═╝                   ║
  ║                                                               ║
  ║         Disciplined Solana Memecoin Trading Bot               ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
  
  // Initialize bot
  const initialized = await bot.initialize();
  
  if (!initialized) {
    logger.error('Bot initialization failed. Check your configuration.');
    process.exit(1);
  }
  
  // Start interactive loop
  await interactiveLoop();
}

async function interactiveLoop() {
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '🚀 Start Bot', value: 'start' },
          { name: '⏹️  Stop Bot', value: 'stop' },
          { name: '🔍 Check Token', value: 'check' },
          { name: '💰 Analyze & Trade', value: 'trade' },
          { name: '📊 Show Status', value: 'status' },
          { name: '📈 Show Stats', value: 'stats' },
          { name: '💼 Show Positions', value: 'positions' },
          { name: '❌ Exit', value: 'exit' },
        ],
      },
    ]);
    
    switch (action) {
      case 'start':
        await bot.start();
        break;
        
      case 'stop':
        bot.stop();
        break;
        
      case 'check':
        await handleCheckToken();
        break;
        
      case 'trade':
        await handleTrade();
        break;
        
      case 'status':
        bot.displayStatus();
        break;
        
      case 'stats':
        bot.showStats();
        break;
        
      case 'positions':
        await handleShowPositions();
        break;
        
      case 'exit':
        await handleExit();
        return;
    }
    
    console.log(''); // Add spacing
  }
}

async function handleCheckToken() {
  const { mintAddress } = await inquirer.prompt([
    {
      type: 'input',
      name: 'mintAddress',
      message: 'Enter token mint address:',
      validate: (input) => {
        if (!input || input.length < 32) {
          return 'Please enter a valid Solana address';
        }
        return true;
      },
    },
  ]);
  
  await bot.checkToken(mintAddress);
}

async function handleTrade() {
  if (!bot.isRunning()) {
    logger.warn('Bot is not running. Start the bot first.');
    return;
  }
  
  const { mintAddress } = await inquirer.prompt([
    {
      type: 'input',
      name: 'mintAddress',
      message: 'Enter token mint address to trade:',
      validate: (input) => {
        if (!input || input.length < 32) {
          return 'Please enter a valid Solana address';
        }
        return true;
      },
    },
  ]);
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'This will execute a real trade. Continue?',
      default: false,
    },
  ]);
  
  if (confirm) {
    const result = await bot.analyzeAndTrade(mintAddress);
    
    if (!result.success) {
      logger.error(`Trade not executed: ${result.reason}`);
    }
  } else {
    logger.info('Trade cancelled');
  }
}

async function handleShowPositions() {
  const { getActivePositions, displayPositionStatus } = await import('./trading/position-manager.js');
  
  const positions = getActivePositions();
  
  if (positions.length === 0) {
    logger.info('No active positions');
    return;
  }
  
  logger.header('ACTIVE POSITIONS');
  positions.forEach(p => displayPositionStatus(p));
}

async function handleExit() {
  const { getActivePositions } = await import('./trading/position-manager.js');
  const positions = getActivePositions();
  
  if (positions.length > 0) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `You have ${positions.length} active position(s). Are you sure you want to exit?`,
        default: false,
      },
    ]);
    
    if (!confirm) {
      return;
    }
  }
  
  bot.stop();
  logger.info('Goodbye! Stay disciplined. 🎯');
  process.exit(0);
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n');
  logger.warn('Received SIGINT. Shutting down...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warn('Received SIGTERM. Shutting down...');
  bot.stop();
  process.exit(0);
});

// Run
main().catch((error) => {
  logger.critical('Fatal error:', error);
  process.exit(1);
});
