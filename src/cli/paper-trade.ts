/**
 * CLI: Paper Trading Mode
 * Simulates trades without real transactions
 * 
 * Usage: 
 *   npm run paper              - Interactive paper trading
 *   npm run paper:check <mint> - Check token and simulate buy
 *   npm run paper:stats        - View paper trading statistics
 *   npm run paper:reset        - Reset paper trading history
 *   npm run paper:export       - Export trades to CSV
 */

import 'dotenv/config';
import inquirer from 'inquirer';
import { 
  paperBuy, 
  paperSell, 
  displayPaperSummary, 
  getPaperPortfolio,
  getPaperTrades,
  resetPaperTrading,
  exportPaperTradesToCSV,
  loadPaperTrades 
} from '../trading/paper-trader.js';
import { runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import { fetchPumpFunToken } from '../api/pump-fun.js';
import { fetchTokenInfo } from '../api/data-providers.js';
import { POSITION_SIZING } from '../config/index.js';
import logger from '../utils/logger.js';

async function main() {
  const command = process.argv[2];
  
  console.log(`
╔═══════════════════════════════════════════╗
║     📝 PAPER TRADING MODE                 ║
║     No real transactions - safe testing   ║
╚═══════════════════════════════════════════╝
  `);
  
  // Load existing paper trades
  loadPaperTrades();
  
  switch (command) {
    case 'check':
      await handleCheck();
      break;
    case 'stats':
      displayPaperSummary();
      break;
    case 'reset':
      await handleReset();
      break;
    case 'export':
      exportPaperTradesToCSV();
      break;
    default:
      await interactiveMode();
  }
}

async function interactiveMode() {
  while (true) {
    displayPaperSummary();
    
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '🔍 Check Token & Simulate Buy', value: 'check' },
          { name: '💰 Sell Position', value: 'sell' },
          { name: '📊 View Statistics', value: 'stats' },
          { name: '📋 View All Trades', value: 'trades' },
          { name: '📤 Export to CSV', value: 'export' },
          { name: '🔄 Reset (Start Fresh)', value: 'reset' },
          { name: '❌ Exit', value: 'exit' },
        ],
      },
    ]);
    
    switch (action) {
      case 'check':
        await handleCheck();
        break;
      case 'sell':
        await handleSell();
        break;
      case 'stats':
        displayPaperSummary();
        break;
      case 'trades':
        displayAllTrades();
        break;
      case 'export':
        exportPaperTradesToCSV();
        break;
      case 'reset':
        await handleReset();
        break;
      case 'exit':
        logger.info('Goodbye! Paper trading session ended.');
        process.exit(0);
    }
    
    console.log(''); // Spacing
  }
}

async function handleCheck() {
  const mintAddress = process.argv[3] || (await inquirer.prompt([
    {
      type: 'input',
      name: 'mint',
      message: 'Enter token mint address:',
      validate: (input) => input.length >= 32 || 'Invalid address',
    },
  ])).mint;
  
  try {
    // Get token info
    let symbol = 'UNKNOWN';
    const pumpToken = await fetchPumpFunToken(mintAddress);
    const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
    
    if (pumpToken) {
      symbol = pumpToken.symbol;
      logger.info(`Token: ${pumpToken.name} (${symbol})`);
      logger.info(`Platform: 🟢 Pump.fun`);
      logger.info(`Bonding Curve: ${pumpToken.bondingCurveProgress.toFixed(1)}%`);
      logger.info(`Market Cap: $${pumpToken.marketCapUsd.toFixed(0)}`);
    } else if (looksLikePumpFun) {
      // Pump.fun API unavailable but address pattern matches
      symbol = 'PUMP';
      logger.info(`Token: Unknown (${mintAddress.slice(0, 8)}...)`);
      logger.info(`Platform: 🟢 Pump.fun (API unavailable)`);
      logger.warn('Pump.fun API unreachable - limited info available');
    } else {
      const tokenInfo = await fetchTokenInfo(mintAddress);
      symbol = tokenInfo.symbol;
      logger.info(`Token: ${tokenInfo.name} (${symbol})`);
      logger.info(`Platform: 🔵 Raydium/Jupiter`);
    }
    
    // Run checklist
    const result = await runPreTradeChecklist(mintAddress);
    
    if (result.passed) {
      const { shouldBuy } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'shouldBuy',
          message: `Checklist PASSED. Simulate BUY for ${symbol}?`,
          default: true,
        },
      ]);
      
      if (shouldBuy) {
        const portfolio = getPaperPortfolio();
        const maxSize = Math.min(POSITION_SIZING.MAX_PER_TRADE_SOL, portfolio.currentBalanceSOL * 0.9);
        
        const { size } = await inquirer.prompt([
          {
            type: 'input',
            name: 'size',
            message: `Enter SOL amount (max ${maxSize.toFixed(3)}):`,
            default: POSITION_SIZING.IDEAL_PER_TRADE_SOL.toString(),
            validate: (input) => {
              const num = parseFloat(input);
              if (isNaN(num) || num <= 0) return 'Enter a valid number';
              if (num > maxSize) return `Max is ${maxSize.toFixed(3)} SOL`;
              return true;
            },
          },
        ]);
        
        await paperBuy(mintAddress, symbol, parseFloat(size), result.passedChecks);
      }
    } else {
      logger.error('Checklist FAILED. No simulated buy.');
    }
    
  } catch (error) {
    logger.error('Check failed:', error);
  }
}

async function handleSell() {
  const portfolio = getPaperPortfolio();
  
  if (portfolio.positions.size === 0) {
    logger.warn('No open positions to sell.');
    return;
  }
  
  const choices = Array.from(portfolio.positions.values()).map(pos => ({
    name: `${pos.symbol} - ${pos.tokenAmount.toFixed(2)} tokens (${pos.costBasis.toFixed(4)} SOL)`,
    value: pos.mint,
  }));
  
  const { mint } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mint',
      message: 'Select position to sell:',
      choices,
    },
  ]);
  
  const { percent, reason } = await inquirer.prompt([
    {
      type: 'list',
      name: 'percent',
      message: 'How much to sell?',
      choices: [
        { name: '40% (TP1)', value: 40 },
        { name: '30% (TP2)', value: 30 },
        { name: '50%', value: 50 },
        { name: '100% (Full Exit)', value: 100 },
      ],
    },
    {
      type: 'list',
      name: 'reason',
      message: 'Exit reason:',
      choices: [
        { name: 'TP1 (+20%)', value: 'tp1' },
        { name: 'TP2 (+35%)', value: 'tp2' },
        { name: 'Stop Loss (-6%)', value: 'stop_loss' },
        { name: 'Time Stop', value: 'time_stop' },
        { name: 'Manual Exit', value: 'manual' },
        { name: 'Dev Dump', value: 'dev_sell' },
      ],
    },
  ]);
  
  const position = portfolio.positions.get(mint);
  if (position) {
    await paperSell(mint, position.symbol, percent, reason);
  }
}

async function handleReset() {
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'This will erase all paper trading history. Continue?',
      default: false,
    },
  ]);
  
  if (confirm) {
    const { balance } = await inquirer.prompt([
      {
        type: 'input',
        name: 'balance',
        message: 'Starting balance (SOL):',
        default: '2.0',
      },
    ]);
    
    resetPaperTrading(parseFloat(balance));
  }
}

function displayAllTrades() {
  const trades = getPaperTrades();
  
  if (trades.length === 0) {
    logger.info('No paper trades yet.');
    return;
  }
  
  logger.header(`ALL PAPER TRADES (${trades.length} total)`);
  
  for (const trade of trades) {
    const time = new Date(trade.timestamp).toLocaleString();
    const pnlStr = trade.pnl !== undefined 
      ? ` | P&L: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(4)} SOL (${trade.pnlPercent?.toFixed(1)}%)`
      : '';
    
    const icon = trade.type === 'BUY' ? '🟢' : '🔴';
    logger.info(`${icon} [${time}] ${trade.type} ${trade.symbol}`);
    logger.info(`   ${trade.solAmount.toFixed(4)} SOL | ${trade.platform}${pnlStr}`);
    if (trade.closeReason) {
      logger.info(`   Reason: ${trade.closeReason}`);
    }
  }
}

main().catch(console.error);
