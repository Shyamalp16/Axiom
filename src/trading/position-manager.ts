/**
 * POSITION MANAGER
 * Handles position sizing, tracking, and limits
 * 
 * HARD LIMITS:
 * - Max per trade: 0.25 SOL
 * - Ideal per trade: 0.15-0.20 SOL
 * - Max open trades: 1
 */

import { POSITION_SIZING, DAILY_LIMITS, WEEKLY_LIMITS } from '../config/index.js';
import { Position, OrderReason } from '../types/index.js';
import { getWalletBalance } from '../utils/solana.js';
import logger from '../utils/logger.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = './data';
const POSITIONS_FILE = join(DATA_DIR, 'positions.json');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory position store (would use DB in production)
let activePositions: Position[] = loadPositions();
let dailyStats = {
  date: new Date().toDateString(),
  tradeCount: 0,
  pnl: 0,
};
let weeklyPnl = 0;

/**
 * Calculate allowed trade size based on limits and wallet balance
 */
export async function calculateTradeSize(): Promise<{
  allowed: boolean;
  size: number;
  reason?: string;
}> {
  // Check if trading is allowed
  const tradingAllowed = await isTradingAllowed();
  if (!tradingAllowed.allowed) {
    return { allowed: false, size: 0, reason: tradingAllowed.reason };
  }
  
  // Check max open positions
  if (activePositions.length >= POSITION_SIZING.MAX_OPEN_TRADES) {
    return {
      allowed: false,
      size: 0,
      reason: `Max open trades reached (${POSITION_SIZING.MAX_OPEN_TRADES})`,
    };
  }
  
  // Get wallet balance
  const balance = await getWalletBalance();
  
  // Calculate available for trading (leave buffer for fees)
  const feeBuffer = 0.05; // Keep 0.05 SOL for fees
  const availableBalance = Math.max(0, balance - feeBuffer);
  
  // Determine trade size
  let size: number = POSITION_SIZING.IDEAL_PER_TRADE_SOL;
  
  // Cap at max
  size = Math.min(size, POSITION_SIZING.MAX_PER_TRADE_SOL);
  
  // Cap at available balance
  size = Math.min(size, availableBalance);
  
  // Check minimum
  if (size < POSITION_SIZING.MIN_PER_TRADE_SOL) {
    return {
      allowed: false,
      size: 0,
      reason: `Insufficient balance. Need ${POSITION_SIZING.MIN_PER_TRADE_SOL} SOL, have ${availableBalance.toFixed(3)} SOL`,
    };
  }
  
  return { allowed: true, size };
}

/**
 * Check if trading is currently allowed based on limits
 */
export async function isTradingAllowed(): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  // Reset daily stats if new day
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats = { date: today, tradeCount: 0, pnl: 0 };
  }
  
  // Check daily trade limit
  if (dailyStats.tradeCount >= DAILY_LIMITS.MAX_TRADES_PER_DAY) {
    return {
      allowed: false,
      reason: `Daily trade limit reached (${DAILY_LIMITS.MAX_TRADES_PER_DAY} trades)`,
    };
  }
  
  // Check daily loss limit
  if (dailyStats.pnl <= -DAILY_LIMITS.MAX_DAILY_LOSS_SOL) {
    return {
      allowed: false,
      reason: `Daily loss limit reached (-${DAILY_LIMITS.MAX_DAILY_LOSS_SOL} SOL)`,
    };
  }
  
  // Check weekly loss limit
  if (weeklyPnl <= -WEEKLY_LIMITS.MAX_WEEKLY_LOSS_SOL) {
    return {
      allowed: false,
      reason: `Weekly loss limit reached (-${WEEKLY_LIMITS.MAX_WEEKLY_LOSS_SOL} SOL) - Review logs before resuming`,
    };
  }
  
  return { allowed: true };
}

/**
 * Create a new position
 */
export function createPosition(
  mint: string,
  symbol: string,
  entryPrice: number,
  quantity: number,
  costBasis: number
): Position {
  const position: Position = {
    id: generateId(),
    mint,
    symbol,
    entryPrice,
    currentPrice: entryPrice,
    quantity,
    costBasis,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    highestPrice: entryPrice,
    entryTime: new Date(),
    tranches: [{
      size: costBasis,
      price: entryPrice,
      timestamp: new Date(),
    }],
    tpLevelsHit: [],
    status: 'active',
  };
  
  activePositions.push(position);
  savePositions(activePositions);
  dailyStats.tradeCount++;
  
  logger.trade('BUY', `Opened position: ${symbol}`);
  logger.info(`  Size: ${costBasis.toFixed(3)} SOL @ $${entryPrice.toFixed(6)}`);
  
  return position;
}

/**
 * Add a tranche to existing position
 */
export function addTranche(
  positionId: string,
  price: number,
  size: number
): Position | null {
  const position = activePositions.find(p => p.id === positionId);
  if (!position) return null;
  
  const newQuantity = size / price;
  position.quantity += newQuantity;
  position.costBasis += size;
  position.entryPrice = position.costBasis / position.quantity;
  
  position.tranches.push({
    size,
    price,
    timestamp: new Date(),
  });
  
  savePositions(activePositions);
  
  logger.trade('BUY', `Added tranche to ${position.symbol}`);
  logger.info(`  +${size.toFixed(3)} SOL @ $${price.toFixed(6)}`);
  
  return position;
}

/**
 * Update position with current price
 */
export function updatePosition(positionId: string, currentPrice: number): Position | null {
  const position = activePositions.find(p => p.id === positionId);
  if (!position) return null;
  
  position.currentPrice = currentPrice;
  position.highestPrice = Math.max(position.highestPrice, currentPrice);
  
  // Calculate unrealized PnL
  const currentValue = position.quantity * currentPrice;
  position.unrealizedPnl = currentValue - position.costBasis;
  position.unrealizedPnlPercent = (position.unrealizedPnl / position.costBasis) * 100;
  
  savePositions(activePositions);
  
  return position;
}

/**
 * Close position (partially or fully)
 */
export function closePosition(
  positionId: string,
  sellPrice: number,
  percentToSell: number,
  reason: OrderReason
): { pnl: number; remainingPosition: Position | null } {
  const position = activePositions.find(p => p.id === positionId);
  if (!position) return { pnl: 0, remainingPosition: null };
  
  const quantityToSell = position.quantity * (percentToSell / 100);
  const costBasisToSell = position.costBasis * (percentToSell / 100);
  const proceeds = quantityToSell * sellPrice;
  const pnl = proceeds - costBasisToSell;
  
  // Update daily/weekly PnL
  dailyStats.pnl += pnl;
  weeklyPnl += pnl;
  
  // Update position
  position.quantity -= quantityToSell;
  position.costBasis -= costBasisToSell;
  
  const pnlPercent = (pnl / costBasisToSell) * 100;
  const pnlEmoji = pnl >= 0 ? '📈' : '📉';
  
  logger.trade('SELL', `${position.symbol} - ${reason}`);
  logger.info(`  ${pnlEmoji} PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
  
  // Check if position fully closed
  if (position.quantity <= 0.0001 || percentToSell >= 100) {
    position.status = 'closed';
    activePositions = activePositions.filter(p => p.id !== positionId);
    savePositions(activePositions);
    logger.info(`  Position fully closed`);
    return { pnl, remainingPosition: null };
  }
  
  position.status = 'partial_exit';
  savePositions(activePositions);
  return { pnl, remainingPosition: position };
}

/**
 * Get all active positions
 */
export function getActivePositions(): Position[] {
  refreshPositionsFromDisk();
  return [...activePositions];
}

/**
 * Get position by ID
 */
export function getPosition(positionId: string): Position | undefined {
  refreshPositionsFromDisk();
  return activePositions.find(p => p.id === positionId);
}

/**
 * Get position by mint address
 */
export function getPositionByMint(mint: string): Position | undefined {
  refreshPositionsFromDisk();
  return activePositions.find(p => p.mint === mint);
}

/**
 * Get current daily stats
 */
export function getDailyStats() {
  return { ...dailyStats };
}

/**
 * Get weekly PnL
 */
export function getWeeklyPnl(): number {
  return weeklyPnl;
}

/**
 * Display position status
 */
export function displayPositionStatus(position: Position): void {
  const pnlColor = position.unrealizedPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const pnlSign = position.unrealizedPnl >= 0 ? '+' : '';
  
  logger.box(`Position: ${position.symbol}`, [
    `Status: ${position.status}`,
    `Entry: $${position.entryPrice.toFixed(6)}`,
    `Current: $${position.currentPrice.toFixed(6)}`,
    `Highest: $${position.highestPrice.toFixed(6)}`,
    ``,
    `Cost: ${position.costBasis.toFixed(3)} SOL`,
    `PnL: ${pnlSign}${position.unrealizedPnl.toFixed(4)} SOL (${pnlSign}${position.unrealizedPnlPercent.toFixed(1)}%)`,
    ``,
    `TP Levels Hit: ${position.tpLevelsHit.join(', ') || 'None'}`,
    `Time in Trade: ${getTimeInTrade(position)}`,
  ]);
}

/**
 * Get formatted time in trade
 */
function getTimeInTrade(position: Position): string {
  const seconds = Math.floor((Date.now() - position.entryTime.getTime()) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Generate unique ID
 */
function generateId(): string {
  return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function loadPositions(): Position[] {
  try {
    if (!existsSync(POSITIONS_FILE)) {
      return [];
    }
    const data = readFileSync(POSITIONS_FILE, 'utf-8');
    const raw = JSON.parse(data) as Position[];
    return raw.map(position => ({
      ...position,
      entryTime: new Date(position.entryTime),
      tranches: (position.tranches || []).map(tranche => ({
        ...tranche,
        timestamp: new Date(tranche.timestamp),
      })),
    }));
  } catch (error) {
    logger.error('Failed to load positions', error);
    return [];
  }
}

function savePositions(positions: Position[]): void {
  try {
    writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
  } catch (error) {
    logger.error('Failed to save positions', error);
  }
}

function refreshPositionsFromDisk(): void {
  activePositions = loadPositions();
}
