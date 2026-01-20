/**
 * TRADE LOGGER
 * Logs every trade for edge analysis
 * 
 * LOG EVERYTHING:
 * - Entry reason (which checklist items passed)
 * - Slippage actual vs expected
 * - Time in trade
 * - Exit reason (TP / SL / dev sell)
 * 
 * After 20-30 trades, patterns will scream at you.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { format } from 'date-fns';
import { TradeLog, DailyStats, Position, OrderReason } from '../types/index.js';
import logger from '../utils/logger.js';

const DATA_DIR = './data';
const TRADES_FILE = join(DATA_DIR, 'trades.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load trades from disk
 */
function loadTrades(): TradeLog[] {
  try {
    if (existsSync(TRADES_FILE)) {
      const data = readFileSync(TRADES_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.error('Failed to load trades', error);
  }
  return [];
}

/**
 * Save trades to disk
 */
function saveTrades(trades: TradeLog[]): void {
  try {
    writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (error) {
    logger.error('Failed to save trades', error);
  }
}

/**
 * Log a completed trade
 */
export function logTrade(
  position: Position,
  exitPrice: number,
  exitReason: OrderReason,
  checklistPassed: string[],
  checklistFailed: string[],
  slippageExpected: number,
  slippageActual: number,
  notes?: string
): TradeLog {
  const pnl = (exitPrice - position.entryPrice) * position.quantity;
  const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  const timeInTrade = (Date.now() - position.entryTime.getTime()) / 1000;
  
  const log: TradeLog = {
    id: `trade_${Date.now()}`,
    mint: position.mint,
    symbol: position.symbol,
    entryReason: checklistPassed,
    checklistPassed,
    checklistFailed,
    entryPrice: position.entryPrice,
    exitPrice,
    size: position.costBasis,
    pnl,
    pnlPercent,
    slippageExpected,
    slippageActual,
    timeInTrade,
    exitReason,
    timestamp: new Date(),
    notes,
  };
  
  // Load, append, save
  const trades = loadTrades();
  trades.push(log);
  saveTrades(trades);
  
  logger.info(`Trade logged: ${position.symbol}`);
  logger.info(`  PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
  logger.info(`  Time: ${Math.floor(timeInTrade / 60)}m ${Math.floor(timeInTrade % 60)}s`);
  logger.info(`  Exit: ${exitReason}`);
  
  return log;
}

/**
 * Get all logged trades
 */
export function getAllTrades(): TradeLog[] {
  return loadTrades();
}

/**
 * Calculate daily statistics
 */
export function calculateDailyStats(date: Date = new Date()): DailyStats {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  
  const allTrades = loadTrades();
  const trades = allTrades.filter(t => {
    const tradeDate = new Date(t.timestamp);
    return tradeDate >= dayStart && tradeDate <= dayEnd;
  });
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  
  return {
    date: format(date, 'yyyy-MM-dd'),
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    totalPnl,
    biggestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
    biggestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    avgTimeInTrade: trades.length > 0 
      ? trades.reduce((sum, t) => sum + t.timeInTrade, 0) / trades.length 
      : 0,
  };
}

/**
 * Analyze trading patterns
 */
export function analyzePatterns(): {
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  mostCommonExitReason: string;
  avgTimeInWinningTrades: number;
  avgTimeInLosingTrades: number;
  checklistCorrelations: Record<string, number>;
} {
  const trades = loadTrades();
  
  if (trades.length === 0) {
    return {
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      mostCommonExitReason: 'N/A',
      avgTimeInWinningTrades: 0,
      avgTimeInLosingTrades: 0,
      checklistCorrelations: {},
    };
  }
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length > 0 
    ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length 
    : 0;
  const avgLoss = losses.length > 0 
    ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length)
    : 0;
  
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
  
  // Most common exit reason
  const exitReasons: Record<string, number> = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  });
  const mostCommonExitReason = Object.entries(exitReasons)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
  
  // Time in trades
  const avgTimeInWinningTrades = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.timeInTrade, 0) / wins.length
    : 0;
  const avgTimeInLosingTrades = losses.length > 0
    ? losses.reduce((sum, t) => sum + t.timeInTrade, 0) / losses.length
    : 0;
  
  // Checklist item correlations with wins
  const checklistCorrelations: Record<string, number> = {};
  const allChecks = new Set<string>();
  
  trades.forEach(t => {
    t.checklistPassed.forEach(c => allChecks.add(c));
  });
  
  allChecks.forEach(check => {
    const tradesWithCheck = trades.filter(t => t.checklistPassed.includes(check));
    const winsWithCheck = tradesWithCheck.filter(t => t.pnl > 0);
    checklistCorrelations[check] = tradesWithCheck.length > 0
      ? (winsWithCheck.length / tradesWithCheck.length) * 100
      : 0;
  });
  
  return {
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    mostCommonExitReason,
    avgTimeInWinningTrades,
    avgTimeInLosingTrades,
    checklistCorrelations,
  };
}

/**
 * Display trade log summary
 */
export function displayTradeSummary(): void {
  const stats = analyzePatterns();
  const todayStats = calculateDailyStats();
  
  logger.header('TRADE LOG ANALYSIS');
  
  logger.box('Overall Performance', [
    `Total Trades: ${loadTrades().length}`,
    `Win Rate: ${stats.winRate.toFixed(1)}%`,
    `Avg Win: +${stats.avgWin.toFixed(4)} SOL`,
    `Avg Loss: -${stats.avgLoss.toFixed(4)} SOL`,
    `Profit Factor: ${stats.profitFactor.toFixed(2)}`,
    ``,
    `Avg Time (Wins): ${(stats.avgTimeInWinningTrades / 60).toFixed(1)}m`,
    `Avg Time (Losses): ${(stats.avgTimeInLosingTrades / 60).toFixed(1)}m`,
    `Most Common Exit: ${stats.mostCommonExitReason}`,
  ]);
  
  logger.box("Today's Stats", [
    `Trades: ${todayStats.trades}`,
    `Wins: ${todayStats.wins} | Losses: ${todayStats.losses}`,
    `PnL: ${todayStats.totalPnl >= 0 ? '+' : ''}${todayStats.totalPnl.toFixed(4)} SOL`,
    `Biggest Win: +${todayStats.biggestWin.toFixed(4)} SOL`,
    `Biggest Loss: ${todayStats.biggestLoss.toFixed(4)} SOL`,
  ]);
  
  // Show checklist correlations if we have data
  if (Object.keys(stats.checklistCorrelations).length > 0) {
    logger.info('\nChecklist Item Win Rates:');
    Object.entries(stats.checklistCorrelations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([check, winRate]) => {
        logger.info(`  ${check}: ${winRate.toFixed(0)}%`);
      });
  }
}

