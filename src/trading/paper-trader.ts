/**
 * PAPER TRADING MODULE
 * 
 * Simulates all trades without making real transactions.
 * Logs everything for analysis.
 * 
 * Use this to:
 * - Test your strategy risk-free
 * - Analyze P&L over 100+ simulated trades
 * - Validate the bot's decision making
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { format } from 'date-fns';
import { fetchPumpFunToken, calculatePumpFunBuyQuote, calculatePumpFunSellQuote } from '../api/pump-fun.js';
import { fetchMarketData, fetchSolPrice } from '../api/data-providers.js';
import { SLIPPAGE, FEES_EXECUTION, POSITION_SIZING } from '../config/index.js';
import logger from '../utils/logger.js';

const DATA_DIR = './data';
const PAPER_TRADES_FILE = join(DATA_DIR, 'paper_trades.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export interface PaperTrade {
  id: string;
  timestamp: Date;
  type: 'BUY' | 'SELL';
  mint: string;
  symbol: string;
  platform: 'pump.fun' | 'jupiter';
  
  // Entry
  solAmount: number;
  tokenAmount: number;
  pricePerToken: number;
  
  // Fees (simulated)
  estimatedFees: number;
  slippageApplied: number;
  
  // For tracking
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  
  // Checklist that passed
  checklistPassed: string[];
  
  // Status
  status: 'open' | 'closed' | 'simulated';
  closeReason?: string;
}

export interface PaperPortfolio {
  startingBalanceSOL: number;
  currentBalanceSOL: number;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  positions: Map<string, PaperPosition>;
}

export interface PaperPosition {
  mint: string;
  symbol: string;
  tokenAmount: number;
  avgEntryPrice: number;
  costBasis: number;
  entryTime: Date;
}

// In-memory state
let portfolio: PaperPortfolio = {
  startingBalanceSOL: 2.0, // Simulated starting balance
  currentBalanceSOL: 2.0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnL: 0,
  winRate: 0,
  avgWin: 0,
  avgLoss: 0,
  profitFactor: 0,
  positions: new Map(),
};

let paperTrades: PaperTrade[] = [];

/**
 * Load paper trades from disk
 */
export function loadPaperTrades(): void {
  try {
    if (existsSync(PAPER_TRADES_FILE)) {
      const data = readFileSync(PAPER_TRADES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      paperTrades = parsed.trades || [];
      
      // Restore portfolio state
      if (parsed.portfolio) {
        portfolio = {
          ...parsed.portfolio,
          positions: new Map(Object.entries(parsed.portfolio.positions || {})),
        };
      }
      
      logger.info(`Loaded ${paperTrades.length} paper trades from history`);
    }
  } catch (error) {
    logger.warn('Could not load paper trades, starting fresh');
    paperTrades = [];
  }
}

/**
 * Save paper trades to disk
 */
export function savePaperTrades(): void {
  try {
    const data = {
      trades: paperTrades,
      portfolio: {
        ...portfolio,
        positions: Object.fromEntries(portfolio.positions),
      },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(PAPER_TRADES_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error('Failed to save paper trades', error);
  }
}

/**
 * Simulate a buy order
 */
export async function paperBuy(
  mint: string,
  symbol: string,
  solAmount: number,
  checklistPassed: string[] = []
): Promise<PaperTrade> {
  logger.info(`📝 [PAPER] Simulating BUY: ${solAmount} SOL → ${symbol}`);
  
  // Check balance
  if (solAmount > portfolio.currentBalanceSOL) {
    throw new Error(`Insufficient paper balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
  }
  
  // Detect platform and get price
  const pumpToken = await fetchPumpFunToken(mint);
  const isPump = pumpToken && !pumpToken.isGraduated;
  
  let tokenAmount: number;
  let pricePerToken: number;
  let platform: 'pump.fun' | 'jupiter';
  
  if (isPump && pumpToken) {
    // Pump.fun bonding curve
    platform = 'pump.fun';
    const quote = calculatePumpFunBuyQuote(pumpToken, solAmount);
    tokenAmount = quote.tokenAmount * (1 - SLIPPAGE.BUY_SLIPPAGE_PERCENT / 100); // Apply slippage
    pricePerToken = pumpToken.priceSol;
  } else {
    // Jupiter/DEX
    platform = 'jupiter';
    const marketData = await fetchMarketData(mint);
    pricePerToken = marketData.priceSol;
    tokenAmount = (solAmount / pricePerToken) * (1 - SLIPPAGE.BUY_SLIPPAGE_PERCENT / 100);
  }
  
  // Simulate fees
  const estimatedFees = FEES_EXECUTION.PRIORITY_FEE_SOL + FEES_EXECUTION.JITO_BRIBE_SOL + 0.000005;
  
  // Create paper trade
  const trade: PaperTrade = {
    id: `paper_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date(),
    type: 'BUY',
    mint,
    symbol,
    platform,
    solAmount,
    tokenAmount,
    pricePerToken,
    estimatedFees,
    slippageApplied: SLIPPAGE.BUY_SLIPPAGE_PERCENT,
    entryPrice: pricePerToken,
    checklistPassed,
    status: 'open',
  };
  
  // Update portfolio
  portfolio.currentBalanceSOL -= (solAmount + estimatedFees);
  portfolio.totalTrades++;
  
  // Add/update position
  const existingPosition = portfolio.positions.get(mint);
  if (existingPosition) {
    const totalTokens = existingPosition.tokenAmount + tokenAmount;
    const totalCost = existingPosition.costBasis + solAmount;
    existingPosition.tokenAmount = totalTokens;
    existingPosition.costBasis = totalCost;
    existingPosition.avgEntryPrice = totalCost / totalTokens;
  } else {
    portfolio.positions.set(mint, {
      mint,
      symbol,
      tokenAmount,
      avgEntryPrice: pricePerToken,
      costBasis: solAmount,
      entryTime: new Date(),
    });
  }
  
  paperTrades.push(trade);
  savePaperTrades();
  
  logger.success(`📝 [PAPER] BUY executed:`);
  logger.info(`   ${solAmount.toFixed(4)} SOL → ${tokenAmount.toFixed(2)} ${symbol}`);
  logger.info(`   Price: ${pricePerToken.toFixed(10)} SOL`);
  logger.info(`   Platform: ${platform}`);
  logger.info(`   Fees: ${estimatedFees.toFixed(6)} SOL`);
  logger.info(`   Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
  
  return trade;
}

/**
 * Simulate a sell order
 */
export async function paperSell(
  mint: string,
  symbol: string,
  percentToSell: number = 100,
  reason: string = 'manual'
): Promise<PaperTrade | null> {
  const position = portfolio.positions.get(mint);
  
  if (!position) {
    logger.warn(`📝 [PAPER] No position found for ${symbol}`);
    return null;
  }
  
  const tokenAmount = position.tokenAmount * (percentToSell / 100);
  const costBasisSold = position.costBasis * (percentToSell / 100);
  
  logger.info(`📝 [PAPER] Simulating SELL: ${tokenAmount.toFixed(2)} ${symbol} (${percentToSell}%)`);
  
  // Detect platform and get price
  const pumpToken = await fetchPumpFunToken(mint);
  const isPump = pumpToken && !pumpToken.isGraduated;
  
  let solReceived: number;
  let pricePerToken: number;
  let platform: 'pump.fun' | 'jupiter';
  
  if (isPump && pumpToken) {
    platform = 'pump.fun';
    const quote = calculatePumpFunSellQuote(pumpToken, tokenAmount);
    solReceived = quote.solAmount * (1 - SLIPPAGE.SELL_SLIPPAGE_PERCENT / 100);
    pricePerToken = pumpToken.priceSol;
  } else {
    platform = 'jupiter';
    const marketData = await fetchMarketData(mint);
    pricePerToken = marketData.priceSol;
    solReceived = (tokenAmount * pricePerToken) * (1 - SLIPPAGE.SELL_SLIPPAGE_PERCENT / 100);
  }
  
  // Simulate fees
  const estimatedFees = FEES_EXECUTION.PRIORITY_FEE_SOL + FEES_EXECUTION.JITO_BRIBE_SOL + 0.000005;
  solReceived -= estimatedFees;
  
  // Calculate P&L
  const pnl = solReceived - costBasisSold;
  const pnlPercent = (pnl / costBasisSold) * 100;
  
  // Create paper trade
  const trade: PaperTrade = {
    id: `paper_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date(),
    type: 'SELL',
    mint,
    symbol,
    platform,
    solAmount: solReceived,
    tokenAmount,
    pricePerToken,
    estimatedFees,
    slippageApplied: SLIPPAGE.SELL_SLIPPAGE_PERCENT,
    entryPrice: position.avgEntryPrice,
    exitPrice: pricePerToken,
    pnl,
    pnlPercent,
    checklistPassed: [],
    status: 'closed',
    closeReason: reason,
  };
  
  // Update portfolio
  portfolio.currentBalanceSOL += solReceived;
  portfolio.totalPnL += pnl;
  
  if (pnl > 0) {
    portfolio.wins++;
  } else {
    portfolio.losses++;
  }
  
  // Update win rate and averages
  updatePortfolioStats();
  
  // Update position
  if (percentToSell >= 100) {
    portfolio.positions.delete(mint);
  } else {
    position.tokenAmount -= tokenAmount;
    position.costBasis -= costBasisSold;
  }
  
  paperTrades.push(trade);
  savePaperTrades();
  
  const pnlEmoji = pnl >= 0 ? '📈' : '📉';
  logger.success(`📝 [PAPER] SELL executed:`);
  logger.info(`   ${tokenAmount.toFixed(2)} ${symbol} → ${solReceived.toFixed(4)} SOL`);
  logger.info(`   ${pnlEmoji} P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
  logger.info(`   Reason: ${reason}`);
  logger.info(`   Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
  
  return trade;
}

/**
 * Update portfolio statistics
 */
function updatePortfolioStats(): void {
  const wins = paperTrades.filter(t => t.type === 'SELL' && (t.pnl || 0) > 0);
  const losses = paperTrades.filter(t => t.type === 'SELL' && (t.pnl || 0) <= 0);
  
  portfolio.winRate = portfolio.totalTrades > 0 
    ? (portfolio.wins / (portfolio.wins + portfolio.losses)) * 100 
    : 0;
  
  portfolio.avgWin = wins.length > 0
    ? wins.reduce((sum, t) => sum + (t.pnl || 0), 0) / wins.length
    : 0;
  
  portfolio.avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0) / losses.length)
    : 0;
  
  const grossProfit = wins.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0));
  
  portfolio.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
}

/**
 * Display paper trading summary
 */
export function displayPaperSummary(): void {
  const totalSells = paperTrades.filter(t => t.type === 'SELL').length;
  
  logger.header('📝 PAPER TRADING SUMMARY');
  
  logger.box('Portfolio', [
    `Starting Balance: ${portfolio.startingBalanceSOL.toFixed(4)} SOL`,
    `Current Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`,
    `Total P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`,
    `ROI: ${((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100).toFixed(1)}%`,
  ]);
  
  logger.box('Statistics', [
    `Total Trades: ${portfolio.totalTrades}`,
    `Closed Trades: ${totalSells}`,
    `Wins: ${portfolio.wins} | Losses: ${portfolio.losses}`,
    `Win Rate: ${portfolio.winRate.toFixed(1)}%`,
    `Avg Win: +${portfolio.avgWin.toFixed(4)} SOL`,
    `Avg Loss: -${portfolio.avgLoss.toFixed(4)} SOL`,
    `Profit Factor: ${portfolio.profitFactor.toFixed(2)}`,
  ]);
  
  // Show open positions
  if (portfolio.positions.size > 0) {
    logger.info('\nOpen Positions:');
    for (const [mint, pos] of portfolio.positions) {
      logger.info(`  ${pos.symbol}: ${pos.tokenAmount.toFixed(2)} tokens @ ${pos.avgEntryPrice.toFixed(10)} SOL`);
    }
  }
  
  // Show recent trades
  const recentTrades = paperTrades.slice(-10);
  if (recentTrades.length > 0) {
    logger.info('\nRecent Trades:');
    for (const trade of recentTrades) {
      const time = format(new Date(trade.timestamp), 'MM/dd HH:mm');
      const pnlStr = trade.pnl !== undefined 
        ? ` | P&L: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(4)}`
        : '';
      logger.info(`  [${time}] ${trade.type} ${trade.symbol} | ${trade.solAmount.toFixed(4)} SOL${pnlStr}`);
    }
  }
}

/**
 * Get all paper trades
 */
export function getPaperTrades(): PaperTrade[] {
  return [...paperTrades];
}

/**
 * Get paper portfolio
 */
export function getPaperPortfolio(): PaperPortfolio {
  return { ...portfolio, positions: new Map(portfolio.positions) };
}

/**
 * Reset paper trading (start fresh)
 */
export function resetPaperTrading(startingBalance: number = 2.0): void {
  paperTrades = [];
  portfolio = {
    startingBalanceSOL: startingBalance,
    currentBalanceSOL: startingBalance,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    profitFactor: 0,
    positions: new Map(),
  };
  savePaperTrades();
  logger.success(`📝 Paper trading reset. Starting balance: ${startingBalance} SOL`);
}

/**
 * Export paper trades to CSV
 */
export function exportPaperTradesToCSV(): string {
  const headers = [
    'Timestamp',
    'Type',
    'Symbol',
    'Platform',
    'SOL Amount',
    'Token Amount',
    'Price',
    'Fees',
    'P&L',
    'P&L %',
    'Reason',
  ];
  
  const rows = paperTrades.map(t => [
    format(new Date(t.timestamp), 'yyyy-MM-dd HH:mm:ss'),
    t.type,
    t.symbol,
    t.platform,
    t.solAmount.toFixed(6),
    t.tokenAmount.toFixed(2),
    t.pricePerToken.toFixed(10),
    t.estimatedFees.toFixed(6),
    t.pnl?.toFixed(6) || '',
    t.pnlPercent?.toFixed(2) || '',
    t.closeReason || '',
  ]);
  
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  
  const csvPath = join(DATA_DIR, `paper_trades_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`);
  writeFileSync(csvPath, csv);
  
  logger.success(`📝 Paper trades exported to ${csvPath}`);
  return csvPath;
}

// Initialize on load
loadPaperTrades();
