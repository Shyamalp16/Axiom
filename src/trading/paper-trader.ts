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
import { fetchSolPrice } from '../api/data-providers.js';
import { getAxiomBatchPrices, isAxiomAuthenticated } from '../api/axiom-trade.js';
import { SLIPPAGE, FEES_EXECUTION, POSITION_SIZING } from '../config/index.js';
import logger from '../utils/logger.js';

// Cached SOL price for USD→SOL conversion
let cachedSolPriceUsd = 200;
let solPriceCacheTime = 0;

async function getCachedSolPriceUsd(): Promise<number> {
  // Cache for 60 seconds
  if (Date.now() - solPriceCacheTime < 60000) {
    return cachedSolPriceUsd;
  }
  try {
    const price = await fetchSolPrice();
    if (price > 0) {
      cachedSolPriceUsd = price;
      solPriceCacheTime = Date.now();
    }
  } catch {
    // Use cached value
  }
  return cachedSolPriceUsd;
}

/**
 * Fetch price for graduated/DEX tokens
 * Priority: Axiom → pump.fun REST API → fallback
 */
async function fetchAxiomPrice(mint: string): Promise<{ priceSol: number; source: string }> {
  // Try Axiom first if authenticated
  if (isAxiomAuthenticated()) {
    try {
      const axiomPrices = await getAxiomBatchPrices([mint]);
      const priceData = axiomPrices[mint];
      if (priceData && priceData.price > 0) {
        const solPrice = await getCachedSolPriceUsd();
        const priceSol = priceData.price / solPrice;
        logger.debug(`📝 [PAPER] Axiom price for ${mint.slice(0, 8)}...: $${priceData.price} → ${priceSol.toExponential(4)} SOL`);
        return { priceSol, source: 'axiom' };
      } else {
        logger.debug(`📝 [PAPER] Axiom batch-prices empty for ${mint.slice(0, 8)}...`);
      }
    } catch (err) {
      logger.debug(`📝 [PAPER] Axiom batch-prices failed: ${err}`);
    }
  }
  
  // Fallback to pump.fun REST API (works for graduated tokens too)
  try {
    const pumpToken = await fetchPumpFunToken(mint);
    if (pumpToken && pumpToken.priceSol > 0) {
      logger.debug(`📝 [PAPER] Pump.fun price for ${mint.slice(0, 8)}...: ${pumpToken.priceSol.toExponential(4)} SOL`);
      return { priceSol: pumpToken.priceSol, source: 'pump.fun' };
    }
  } catch (err) {
    logger.debug(`📝 [PAPER] Pump.fun price fetch failed: ${err}`);
  }
  
  // Final fallback - return 0 and let caller handle gracefully
  logger.warn(`📝 [PAPER] Could not fetch price for ${mint.slice(0, 8)}... - no valid price source`);
  return { priceSol: 0, source: 'none' };
}

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
  grossPnl?: number;
  grossPnlPercent?: number;
  netPnl?: number;
  netPnlPercent?: number;
  
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

// Paper trading behavior flags
const PAPER_TRADING_SKIP_FEES = true;

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
  
  // Use lower slippage for paper trading (realistic price impact only)
  const buySlippage = SLIPPAGE.PAPER_BUY_SLIPPAGE_PERCENT;
  
  if (isPump && pumpToken) {
    // Pump.fun bonding curve
    platform = 'pump.fun';
    
    // Log market data at entry
    logger.info(`📝 [PAPER] Entry Market:`);
    logger.info(`   Spot Price: ${pumpToken.priceSol.toFixed(12)} SOL/token`);
    logger.info(`   Market Cap: $${pumpToken.marketCapUsd.toFixed(0)} (${pumpToken.marketCapSol.toFixed(2)} SOL)`);
    logger.info(`   Reserves: ${pumpToken.virtualSolReserves.toFixed(4)} vSOL / ${pumpToken.virtualTokenReserves.toFixed(0)} vTokens`);
    
    // Check if reserves are valid for bonding curve calculation
    const hasValidReserves = pumpToken.virtualSolReserves > 0.001 && pumpToken.virtualTokenReserves > 1000;
    
    if (hasValidReserves) {
      const quote = calculatePumpFunBuyQuote(pumpToken, solAmount);
      logger.info(`📝 [PAPER] Buy Quote: ${solAmount} SOL → ${quote.tokenAmount.toFixed(2)} tokens (impact: ${quote.priceImpact.toFixed(2)}%)`);
      tokenAmount = quote.tokenAmount * (1 - buySlippage / 100); // Apply paper slippage
      pricePerToken = tokenAmount > 0 ? solAmount / tokenAmount : pumpToken.priceSol;
    } else {
      // Fallback: Reserves invalid, use spot price or market cap estimate
      // Priority: 1) spot price, 2) market cap derived, 3) bonding curve estimate
      const PUMP_TOTAL_SUPPLY = 1_000_000_000;
      
      // Try spot price first (most reliable)
      if (pumpToken.priceSol > 1e-15) {
        pricePerToken = pumpToken.priceSol;
        logger.warn(`📝 [PAPER] Reserves invalid, using spot price: ${pricePerToken.toExponential(4)} SOL/token`);
      } 
      // Try market cap derived price
      else if (pumpToken.marketCapSol > 0) {
        pricePerToken = pumpToken.marketCapSol / PUMP_TOTAL_SUPPLY;
        logger.warn(`📝 [PAPER] Using market cap derived price: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      // Last resort: estimate from bonding curve progress
      else if (pumpToken.bondingCurveProgress > 0) {
        // At 100% progress, market cap is ~85 SOL
        const estimatedMarketCapSol = (pumpToken.bondingCurveProgress / 100) * 85;
        pricePerToken = estimatedMarketCapSol / PUMP_TOTAL_SUPPLY;
        logger.warn(`📝 [PAPER] Using bonding curve estimate: ${pricePerToken.toExponential(4)} SOL/token (${pumpToken.bondingCurveProgress.toFixed(1)}% progress)`);
      }
      // Absolute fallback - should never happen
      else {
        pricePerToken = 1e-8; // ~$0.000001 at $100 SOL
        logger.error(`📝 [PAPER] No valid price data! Using fallback: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      
      tokenAmount = (solAmount / pricePerToken) * (1 - buySlippage / 100);
      logger.info(`📝 [PAPER] Buy (estimated): ${solAmount} SOL → ${tokenAmount.toFixed(2)} tokens @ ${pricePerToken.toExponential(4)} SOL`);
    }
  } else {
    // Jupiter/DEX - use Axiom pricing for consistency
    platform = 'jupiter';
    const { priceSol, source } = await fetchAxiomPrice(mint);
    
    // Validate price - must be > 0 and not unreasonably large
    if (priceSol <= 0 || !isFinite(priceSol)) {
      throw new Error(`No valid price available for ${symbol} (${mint.slice(0, 8)}...) - cannot execute paper trade`);
    }
    
    pricePerToken = priceSol;
    tokenAmount = (solAmount / pricePerToken) * (1 - buySlippage / 100);
    logger.debug(`📝 [PAPER] BUY price source: ${source}`);
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
    slippageApplied: buySlippage,
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
    logger.debug(`📝 [PAPER] Position added to portfolio: ${symbol} (${mint.slice(0,8)}...) - Total positions: ${portfolio.positions.size}`);
  }
  
  paperTrades.push(trade);
  savePaperTrades();
  
  logger.success(`📝 [PAPER] BUY executed:`);
  logger.info(`   ${solAmount.toFixed(4)} SOL → ${tokenAmount.toFixed(2)} ${symbol}`);
  logger.info(`   Price: ${pricePerToken.toFixed(12)} SOL`);
  logger.info(`   Platform: ${platform}`);
  logger.info(`   Fees: ${estimatedFees.toFixed(6)} SOL`);
  logger.info(`   Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
  
  return trade;
}

/**
 * Simulate a sell order
 * @param overridePrice - Optional price to use instead of fetching (e.g., from Helius)
 */
export async function paperSell(
  mint: string,
  symbol: string,
  percentToSell: number = 100,
  reason: string = 'manual',
  overridePrice?: number
): Promise<PaperTrade | null> {
  const position = portfolio.positions.get(mint);
  
  if (!position) {
    logger.warn(`📝 [PAPER] No position found for ${symbol}`);
    return null;
  }
  
  const tokenAmount = position.tokenAmount * (percentToSell / 100);
  const costBasisSold = position.costBasis * (percentToSell / 100);
  
  logger.info(`📝 [PAPER] Simulating SELL: ${tokenAmount.toFixed(2)} ${symbol} (${percentToSell}%)`);
  
  // Log entry details
  logger.info(`📝 [PAPER] Entry: ${position.avgEntryPrice.toFixed(12)} SOL/token (cost basis: ${costBasisSold.toFixed(4)} SOL)`);
  
  // Detect platform and get price
  const pumpToken = await fetchPumpFunToken(mint);
  const isPump = pumpToken && !pumpToken.isGraduated;
  
  let solReceived: number;
  let pricePerToken: number;
  let platform: 'pump.fun' | 'jupiter';
  
  // Use lower slippage for paper trading (realistic price impact only)
  const sellSlippage = SLIPPAGE.PAPER_SELL_SLIPPAGE_PERCENT;
  
  // If override price is provided (e.g., from Helius real-time), use it
  if (overridePrice && overridePrice > 0) {
    platform = isPump ? 'pump.fun' : 'jupiter';
    pricePerToken = overridePrice;
    logger.info(`📝 [PAPER] Using override price: ${pricePerToken.toExponential(4)} SOL/token`);
    solReceived = (tokenAmount * pricePerToken) * (1 - sellSlippage / 100);
    logger.info(`📝 [PAPER] Sell: ${tokenAmount.toFixed(2)} tokens × ${pricePerToken.toExponential(4)} SOL = ${(tokenAmount * pricePerToken).toFixed(6)} SOL`);
    logger.info(`📝 [PAPER] After ${sellSlippage}% slippage: ${solReceived.toFixed(6)} SOL`);
  } else if (isPump && pumpToken) {
    platform = 'pump.fun';
    
    // Log current market data
    logger.info(`📝 [PAPER] Current Market:`);
    logger.info(`   Spot Price: ${pumpToken.priceSol.toFixed(12)} SOL/token`);
    logger.info(`   Market Cap: $${pumpToken.marketCapUsd.toFixed(0)} (${pumpToken.marketCapSol.toFixed(2)} SOL)`);
    logger.info(`   Reserves: ${pumpToken.virtualSolReserves.toFixed(4)} vSOL / ${pumpToken.virtualTokenReserves.toFixed(0)} vTokens`);
    
    // Check if reserves are valid for bonding curve calculation
    const hasValidReserves = pumpToken.virtualSolReserves > 0.001 && pumpToken.virtualTokenReserves > 1000;
    
    if (hasValidReserves) {
      const quote = calculatePumpFunSellQuote(pumpToken, tokenAmount);
      logger.info(`📝 [PAPER] Sell Quote: ${tokenAmount.toFixed(2)} tokens → ${quote.solAmount.toFixed(6)} SOL (impact: ${quote.priceImpact.toFixed(2)}%)`);
      solReceived = quote.solAmount * (1 - sellSlippage / 100);
      pricePerToken = tokenAmount > 0 ? quote.solAmount / tokenAmount : pumpToken.priceSol;
    } else {
      // Fallback: Reserves invalid, try multiple price sources
      // Priority: 1) current spot price, 2) entry price, 3) market cap derived
      const PUMP_TOTAL_SUPPLY = 1_000_000_000;
      
      // Try current spot price first (most accurate for current value)
      if (pumpToken.priceSol > 1e-15) {
        pricePerToken = pumpToken.priceSol;
        logger.warn(`📝 [PAPER] Reserves invalid, using current spot price: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      // Try entry price (guaranteed to exist for open position)
      else if (position.avgEntryPrice > 1e-15) {
        pricePerToken = position.avgEntryPrice;
        logger.warn(`📝 [PAPER] Using entry price for sell: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      // Try market cap derived
      else if (pumpToken.marketCapSol > 0) {
        pricePerToken = pumpToken.marketCapSol / PUMP_TOTAL_SUPPLY;
        logger.warn(`📝 [PAPER] Using market cap derived price: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      // Absolute fallback
      else {
        pricePerToken = 1e-8;
        logger.error(`📝 [PAPER] No valid price data! Using fallback: ${pricePerToken.toExponential(4)} SOL/token`);
      }
      
      solReceived = (tokenAmount * pricePerToken) * (1 - sellSlippage / 100);
      logger.info(`📝 [PAPER] Sell (estimated): ${tokenAmount.toFixed(2)} tokens × ${pricePerToken.toExponential(4)} SOL = ${solReceived.toFixed(6)} SOL`);
    }
    
    logger.info(`📝 [PAPER] After ${sellSlippage}% slippage: ${solReceived.toFixed(6)} SOL`);
  } else {
    // Jupiter/DEX - use Axiom pricing for consistency
    platform = 'jupiter';
    const { priceSol, source } = await fetchAxiomPrice(mint);
    
    // Validate price - must be > 0 and finite
    if (priceSol <= 0 || !isFinite(priceSol)) {
      // Fall back to entry price for sells if no current price available
      logger.warn(`📝 [PAPER] No valid market price for ${symbol} - using entry price for sell`);
      pricePerToken = position.avgEntryPrice;
    } else {
      pricePerToken = priceSol;
    }
    
    solReceived = (tokenAmount * pricePerToken) * (1 - sellSlippage / 100);
    logger.debug(`📝 [PAPER] SELL price source: ${source}`);
  }
  
  // Simulate fees (optional for paper trading)
  const estimatedFees = FEES_EXECUTION.PRIORITY_FEE_SOL + FEES_EXECUTION.JITO_BRIBE_SOL + 0.000005;
  const grossSolReceived = solReceived;
  const feesApplied = PAPER_TRADING_SKIP_FEES ? 0 : estimatedFees;
  solReceived = Math.max(0, solReceived - feesApplied);
  if (!PAPER_TRADING_SKIP_FEES && solReceived === 0 && grossSolReceived > 0) {
    logger.warn(`📝 [PAPER] Sell proceeds (${grossSolReceived.toFixed(6)} SOL) are below fees (${estimatedFees.toFixed(6)} SOL) - net set to 0`);
  }
  
  // Calculate P&L (gross vs net)
  const grossPnl = grossSolReceived - costBasisSold;
  const grossPnlPercent = (grossPnl / costBasisSold) * 100;
  const netPnl = solReceived - costBasisSold;
  const netPnlPercent = (netPnl / costBasisSold) * 100;
  
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
    estimatedFees: feesApplied,
    slippageApplied: sellSlippage,
    entryPrice: position.avgEntryPrice,
    exitPrice: pricePerToken,
    pnl: netPnl,
    pnlPercent: netPnlPercent,
    grossPnl,
    grossPnlPercent,
    netPnl,
    netPnlPercent,
    checklistPassed: [],
    status: 'closed',
    closeReason: reason,
  };
  
  // Update portfolio
  portfolio.currentBalanceSOL += solReceived;
  portfolio.totalPnL += netPnl;
  
  if (netPnl > 0) {
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
  
  const pnlEmoji = netPnl >= 0 ? '📈' : '📉';
  logger.success(`📝 [PAPER] SELL executed:`);
  logger.info(`   ${tokenAmount.toFixed(2)} ${symbol} → ${solReceived.toFixed(6)} SOL`);
  logger.info(`   ${pnlEmoji} P&L (gross): ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)} SOL (${grossPnlPercent >= 0 ? '+' : ''}${grossPnlPercent.toFixed(1)}%)`);
  logger.info(`   ${pnlEmoji} P&L (net): ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} SOL (${netPnlPercent >= 0 ? '+' : ''}${netPnlPercent.toFixed(1)}%)`);
  if (PAPER_TRADING_SKIP_FEES) {
    logger.info(`   Fees skipped (paper trading)`);
  } else {
    logger.info(`   Fees: ${feesApplied.toFixed(6)} SOL`);
  }
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
