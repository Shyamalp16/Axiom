/**
 * MIRROR TRADER MODULE - ULTRA LOW LATENCY VERSION
 * 
 * Mirrors transactions from tracked wallets using paper trading.
 * OPTIMIZED FOR HIGH-FREQUENCY BOT TRADING:
 * - 500ms polling for near real-time response
 * - Parallel transaction processing for bulk orders
 * - Non-blocking MC fetching
 * - Batched state saves to reduce I/O overhead
 * - Transaction queue for burst handling
 * 
 * EXACT MIRRORING: Copies the exact SOL amounts from source wallet transactions.
 * - When a tracked wallet buys 5 SOL, we buy 5 SOL
 * - When a tracked wallet sells X SOL worth, we sell X SOL worth (or all if less)
 * - We never sell positions we don't own
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { format } from 'date-fns';
import {
  monitorTrackedWallets,
  getAxiomTrackedWallets,
  AxiomWalletTransactionWithName,
} from '../api/axiom-trade.js';
import { paperBuy, paperSell, getPaperPortfolio, loadPaperTrades } from './paper-trader.js';
import { fetchPumpFunTokenUltraFresh } from '../api/pump-fun.js';
import logger from '../utils/logger.js';

const DATA_DIR = './data';
const MIRROR_STATE_FILE = join(DATA_DIR, 'mirror_state.json');
const MIRROR_TRADES_FILE = join(DATA_DIR, 'mirror_trades.json');

// ============================================
// PERFORMANCE TUNING CONSTANTS
// ============================================

// Polling interval - how often we check for new transactions
// 250ms = 4 checks per second for maximum speed
const POLL_INTERVAL_MS = 250;

// Max age of transactions to process (in milliseconds)
// Reduced from 2 minutes to 30 seconds for faster response
const MAX_TRANSACTION_AGE_MS = 30 * 1000;

// Batch save interval - save state every N milliseconds instead of after each trade
const BATCH_SAVE_INTERVAL_MS = 2000;

// Maximum concurrent trade executions
const MAX_CONCURRENT_TRADES = 10;

// MC fetch timeout - don't wait forever for market cap data
const MC_FETCH_TIMEOUT_MS = 2000;

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================
// TRANSACTION QUEUE FOR BURST HANDLING
// ============================================

interface QueuedTransaction {
  tx: AxiomWalletTransactionWithName;
  receivedAt: number;
}

// Transaction queue for handling bursts
const transactionQueue: QueuedTransaction[] = [];
let isProcessingQueue = false;
let queueProcessorInterval: ReturnType<typeof setInterval> | null = null;

// Batch save state management
let pendingSave = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export interface MirrorConfig {
  enabled: boolean;
  exactMirroring: boolean;  // Mirror exact SOL amounts from source wallet (default: true)
  walletFilter: string[];  // Empty = all wallets, otherwise specific addresses
  mirrorBuys: boolean;
  mirrorSells: boolean;
  onlyFirstBuys: boolean;  // Only mirror "First Buy" transactions
  minMarketCap: number;  // Skip tokens below this MC ($)
  maxMarketCap: number;  // Skip tokens above this MC ($), 0 = no limit
}

export interface MirrorTrade {
  id: string;
  timestamp: string;
  type: 'buy' | 'sell';
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  
  // Source transaction
  sourceWalletAddress: string;
  sourceWalletName: string;
  sourceWalletEmoji: string;
  sourceTransactionSignature: string;
  sourceTransactionType: string;
  sourceSolAmount: number;
  
  // Our trade
  ourSolAmount: number;
  ourTokenAmount?: number;
  success: boolean;
  error?: string;
  pnl?: number;
  pnlPercent?: number;
  
  // Market cap tracking (fresh from pump.fun API)
  entryMcUsd?: number;   // MC at time of buy
  exitMcUsd?: number;    // MC at time of sell (for sells only)
  currentMcUsd?: number; // For active positions - updated in real-time
}

export interface MirrorState {
  isRunning: boolean;
  startedAt: string | null;
  config: MirrorConfig;
  stats: {
    totalMirroredBuys: number;
    totalMirroredSells: number;
    successfulBuys: number;
    successfulSells: number;
    failedBuys: number;
    failedSells: number;
    totalPnL: number;
  };
  // Track which source transactions we've already processed
  processedSignatures: Set<string>;
  // Track positions we hold from mirroring (tokenMint -> position info)
  mirroredPositions: Map<string, { 
    walletAddress: string; 
    symbol: string; 
    entryTime: string;
    entryMcUsd?: number;  // Fresh MC from pump.fun at entry
    costBasisSol?: number; // SOL spent on entry
  }>;
}

// Default configuration
const DEFAULT_CONFIG: MirrorConfig = {
  enabled: false,
  exactMirroring: true,  // Mirror exact SOL amounts (if they buy 5 SOL, we buy 5 SOL)
  walletFilter: [],
  mirrorBuys: true,
  mirrorSells: true,
  onlyFirstBuys: false,
  minMarketCap: 0,
  maxMarketCap: 0,
};

// In-memory state
let mirrorState: MirrorState = {
  isRunning: false,
  startedAt: null,
  config: { ...DEFAULT_CONFIG },
  stats: {
    totalMirroredBuys: 0,
    totalMirroredSells: 0,
    successfulBuys: 0,
    successfulSells: 0,
    failedBuys: 0,
    failedSells: 0,
    totalPnL: 0,
  },
  processedSignatures: new Set(),
  mirroredPositions: new Map(),
};

let mirrorTrades: MirrorTrade[] = [];
let stopMonitorFn: (() => void) | null = null;

// Timestamp when mirroring started - only process transactions AFTER this time
let mirrorStartTimestamp: number = 0;

/**
 * Load mirror state from disk
 */
export function loadMirrorState(): void {
  try {
    if (existsSync(MIRROR_STATE_FILE)) {
      const data = readFileSync(MIRROR_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      mirrorState = {
        ...mirrorState,
        ...parsed,
        processedSignatures: new Set(parsed.processedSignatures || []),
        mirroredPositions: new Map(Object.entries(parsed.mirroredPositions || {})),
      };
      // Don't restore isRunning - needs to be explicitly started
      mirrorState.isRunning = false;
      logger.info(`[MIRROR] Loaded state: ${mirrorState.processedSignatures.size} processed signatures, ${mirrorState.mirroredPositions.size} active positions`);
    }
    
    if (existsSync(MIRROR_TRADES_FILE)) {
      const data = readFileSync(MIRROR_TRADES_FILE, 'utf-8');
      mirrorTrades = JSON.parse(data).trades || [];
      logger.info(`[MIRROR] Loaded ${mirrorTrades.length} mirror trades from history`);
    }
  } catch (error) {
    logger.warn('[MIRROR] Could not load state, starting fresh');
  }
}

/**
 * Save mirror state to disk
 * Uses batched saving to reduce I/O overhead during high-frequency trading
 */
export function saveMirrorState(): void {
  try {
    const stateToSave = {
      ...mirrorState,
      processedSignatures: Array.from(mirrorState.processedSignatures),
      mirroredPositions: Object.fromEntries(mirrorState.mirroredPositions),
    };
    writeFileSync(MIRROR_STATE_FILE, JSON.stringify(stateToSave, null, 2));
    writeFileSync(MIRROR_TRADES_FILE, JSON.stringify({ trades: mirrorTrades, lastUpdated: new Date().toISOString() }, null, 2));
  } catch (error) {
    logger.error('[MIRROR] Failed to save state', error);
  }
}

/**
 * Schedule a batched save - prevents excessive I/O during burst trading
 * State will be saved after BATCH_SAVE_INTERVAL_MS milliseconds
 */
function scheduleBatchSave(): void {
  if (pendingSave) return; // Already scheduled
  
  pendingSave = true;
  if (saveTimer) clearTimeout(saveTimer);
  
  saveTimer = setTimeout(() => {
    pendingSave = false;
    saveMirrorState();
  }, BATCH_SAVE_INTERVAL_MS);
}

/**
 * Force immediate save (used when stopping)
 */
function forceImmediateSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSave = false;
  saveMirrorState();
}

/**
 * Fetch MC with timeout - non-blocking, returns 0 if timeout/error
 */
async function fetchMCWithTimeout(tokenAddress: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MC_FETCH_TIMEOUT_MS);
    
    const freshToken = await Promise.race([
      fetchPumpFunTokenUltraFresh(tokenAddress),
      new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error('MC fetch timeout')), MC_FETCH_TIMEOUT_MS)
      ),
    ]);
    
    clearTimeout(timeoutId);
    
    if (freshToken && freshToken.marketCapUsd > 0) {
      return freshToken.marketCapUsd;
    }
    return 0;
  } catch {
    return 0; // Non-blocking - return 0 if fetch fails
  }
}

/**
 * Process a new transaction from a tracked wallet
 * OPTIMIZED: Non-blocking MC fetch, batched saves, fast execution
 */
async function processTransaction(tx: AxiomWalletTransactionWithName): Promise<void> {
  const startTime = Date.now();
  
  // Validate transaction data
  if (!tx || !tx.signature || !tx.tokenAddress || !tx.walletAddress) {
    logger.debug('[MIRROR] Invalid transaction data, skipping');
    return;
  }
  
  const config = mirrorState.config;
  
  // Skip if already processed (prevents duplicate processing)
  if (mirrorState.processedSignatures.has(tx.signature)) {
    return;
  }
  
  // CRITICAL: Only process transactions that happened AFTER we started mirroring
  const txTime = new Date(tx.transactionTime).getTime();
  if (isNaN(txTime) || txTime < mirrorStartTimestamp) {
    mirrorState.processedSignatures.add(tx.signature);
    return;
  }
  
  // Tighter time check: skip transactions older than 30 seconds
  const txAgeMs = Date.now() - txTime;
  if (txAgeMs > MAX_TRANSACTION_AGE_MS) {
    logger.debug(`[MIRROR] Skipping old transaction (${Math.round(txAgeMs / 1000)}s old)`);
    mirrorState.processedSignatures.add(tx.signature);
    return;
  }
  
  // Mark as processed immediately to avoid duplicates
  mirrorState.processedSignatures.add(tx.signature);
  
  // Filter by wallet if specified
  if (config.walletFilter.length > 0) {
    const lowerWallet = tx.walletAddress.toLowerCase();
    if (!config.walletFilter.some(w => w.toLowerCase() === lowerWallet)) {
      return;
    }
  }
  
  const walletDisplay = tx.walletName 
    ? `${tx.walletEmoji || ''} ${tx.walletName}`.trim()
    : tx.walletAddress.slice(0, 8) + '...';
  
  // Handle BUY transactions
  if (tx.type === 'buy' && config.mirrorBuys) {
    await processBuyTransaction(tx, config, walletDisplay, txAgeMs);
  }
  
  // Handle SELL transactions
  if (tx.type === 'sell' && config.mirrorSells) {
    await processSellTransaction(tx, config, walletDisplay, txAgeMs);
  }
  
  const elapsed = Date.now() - startTime;
  if (elapsed > 100) {
    logger.debug(`[MIRROR] Transaction processed in ${elapsed}ms`);
  }
}

/**
 * Process a BUY transaction - optimized for speed
 */
async function processBuyTransaction(
  tx: AxiomWalletTransactionWithName,
  config: MirrorConfig,
  walletDisplay: string,
  txAgeMs: number
): Promise<void> {
  // Validate token address
  if (!tx.tokenAddress || tx.tokenAddress.length < 32) {
    return;
  }
  
  // Filter by detailed type if onlyFirstBuys is enabled
  if (config.onlyFirstBuys && tx.detailedType !== 'First Buy') {
    return;
  }
  
  // Filter by market cap (use Axiom's data for speed, don't fetch fresh)
  const marketCap = tx.averageMcBought || 0;
  if (config.minMarketCap > 0 && marketCap > 0 && marketCap < config.minMarketCap) {
    return;
  }
  if (config.maxMarketCap > 0 && marketCap > config.maxMarketCap) {
    return;
  }
  
  // Validate SOL amount
  const solAmount = tx.totalSol;
  if (!solAmount || solAmount <= 0 || isNaN(solAmount)) {
    return;
  }
  
  // Log detection with timing info
  const detectTime = Date.now();
  const txTime = new Date(tx.transactionTime).getTime();
  const apiDelayMs = detectTime - txTime;
  logger.info(`🪞 [MIRROR] BUY detected: ${walletDisplay} → ${tx.tokenTicker} ${solAmount.toFixed(4)} SOL`);
  logger.info(`   ⏱️ TX time: ${new Date(txTime).toLocaleTimeString()} | API delay: ${(apiDelayMs / 1000).toFixed(1)}s`);
  
  mirrorState.stats.totalMirroredBuys++;
  
  const mirrorTrade: MirrorTrade = {
    id: `mirror_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    type: 'buy',
    tokenMint: tx.tokenAddress,
    tokenSymbol: tx.tokenTicker,
    tokenName: tx.tokenName,
    sourceWalletAddress: tx.walletAddress,
    sourceWalletName: tx.walletName || '',
    sourceWalletEmoji: tx.walletEmoji || '',
    sourceTransactionSignature: tx.signature,
    sourceTransactionType: tx.detailedType,
    sourceSolAmount: tx.totalSol,
    ourSolAmount: solAmount,
    success: false,
    entryMcUsd: undefined,
  };
  
  try {
    // SPEED CRITICAL: Fetch token data once and pass to paperBuy
    const tokenData = await fetchPumpFunTokenUltraFresh(tx.tokenAddress);
    const entryMcUsd = tokenData?.marketCapUsd || 0;
    
    // Execute trade with pre-fetched data (no duplicate network calls)
    const trade = await paperBuy(
      tx.tokenAddress,
      tx.tokenTicker,
      solAmount,
      [`mirror:${walletDisplay}:${tx.detailedType}`],
      tokenData, // Pass pre-fetched data
      false
    );
    
    // Store entry MC we captured
    mirrorTrade.entryMcUsd = entryMcUsd > 0 ? entryMcUsd : undefined;
    
    mirrorTrade.success = true;
    mirrorTrade.ourTokenAmount = trade.tokenAmount;
    mirrorState.stats.successfulBuys++;
    
    // Get paper position for cost basis
    const paperPortfolio = getPaperPortfolio();
    const paperPos = paperPortfolio.positions.get(tx.tokenAddress);
    
    // Track position with entry MC we captured
    const existingPosition = mirrorState.mirroredPositions.get(tx.tokenAddress);
    
    // DCA the entry MC if adding to existing position
    let dcaEntryMc = entryMcUsd;
    if (existingPosition && existingPosition.entryMcUsd && existingPosition.entryMcUsd > 0 && entryMcUsd > 0) {
      const existingCost = existingPosition.costBasisSol || 0;
      const newTotalCost = existingCost + solAmount;
      dcaEntryMc = (existingPosition.entryMcUsd * existingCost + entryMcUsd * solAmount) / newTotalCost;
    }
    
    mirrorState.mirroredPositions.set(tx.tokenAddress, {
      walletAddress: tx.walletAddress,
      symbol: tx.tokenTicker,
      entryTime: existingPosition?.entryTime || new Date().toISOString(),
      entryMcUsd: dcaEntryMc > 0 ? dcaEntryMc : existingPosition?.entryMcUsd,
      costBasisSol: paperPos?.costBasis || solAmount,
    });
    
    const processTimeMs = Date.now() - detectTime;
    const totalDelayMs = Date.now() - txTime;
    logger.success(`🪞 [MIRROR] BUY EXECUTED: ${solAmount.toFixed(4)} SOL → ${tx.tokenTicker}${entryMcUsd > 0 ? ` @ $${entryMcUsd.toFixed(0)} MC` : ''}`);
    logger.info(`   ⏱️ Process: ${processTimeMs}ms | Total delay: ${(totalDelayMs / 1000).toFixed(1)}s`);
    
  } catch (error) {
    mirrorTrade.success = false;
    mirrorTrade.error = error instanceof Error ? error.message : 'Unknown error';
    mirrorState.stats.failedBuys++;
    logger.error(`🪞 [MIRROR] BUY FAILED: ${mirrorTrade.error}`);
  }
  
  mirrorTrades.push(mirrorTrade);
  scheduleBatchSave(); // Batched save instead of immediate
}

/**
 * Process a SELL transaction - optimized for speed
 */
async function processSellTransaction(
  tx: AxiomWalletTransactionWithName,
  config: MirrorConfig,
  walletDisplay: string,
  txAgeMs: number
): Promise<void> {
  // Validate token address
  if (!tx.tokenAddress || tx.tokenAddress.length < 32) {
    return;
  }
  
  // Check if we have this position in paper portfolio
  const portfolio = getPaperPortfolio();
  const position = portfolio.positions.get(tx.tokenAddress);
  
  if (!position) {
    logger.debug(`[MIRROR] No position in ${tx.tokenTicker || tx.tokenAddress.slice(0, 8)}, skipping sell`);
    return;
  }
  
  // Get or create mirrored position tracking
  let mirroredPosition = mirrorState.mirroredPositions.get(tx.tokenAddress);
  if (!mirroredPosition) {
    const entryTimeStr = typeof position.entryTime === 'string' 
      ? position.entryTime 
      : (position.entryTime instanceof Date 
          ? position.entryTime.toISOString() 
          : new Date().toISOString());
    mirroredPosition = {
      walletAddress: tx.walletAddress,
      symbol: tx.tokenTicker || position.symbol,
      entryTime: entryTimeStr,
      costBasisSol: position.costBasis,
    };
    mirrorState.mirroredPositions.set(tx.tokenAddress, mirroredPosition);
  }
  
  // Validate tokens exist
  if (!position.tokenAmount || position.tokenAmount <= 0 || isNaN(position.tokenAmount)) {
    mirrorState.mirroredPositions.delete(tx.tokenAddress);
    scheduleBatchSave();
    return;
  }
  
  // Calculate sell percentage
  let sellPercent = 100;
  const theirSolAmount = tx.totalSol || 0;
  
  if (tx.detailedType === 'Sell All') {
    sellPercent = 100;
  } else if (theirSolAmount > 0) {
    const ourPositionValueSol = position.costBasis;
    if (ourPositionValueSol > 0) {
      sellPercent = Math.min(100, (theirSolAmount / ourPositionValueSol) * 100);
    }
  }
  
  // Log detection with latency info
  logger.info(`🪞 [MIRROR] SELL detected (${Math.round(txAgeMs / 1000)}s ago): ${walletDisplay} → ${tx.tokenTicker} (${tx.detailedType})`);
  
  mirrorState.stats.totalMirroredSells++;
  
  const entryMcUsd = mirroredPosition?.entryMcUsd || 0;
  const exitMcUsd = tx.averageMcSold || 0;
  
  const mirrorTrade: MirrorTrade = {
    id: `mirror_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    type: 'sell',
    tokenMint: tx.tokenAddress,
    tokenSymbol: tx.tokenTicker,
    tokenName: tx.tokenName,
    sourceWalletAddress: tx.walletAddress,
    sourceWalletName: tx.walletName || '',
    sourceWalletEmoji: tx.walletEmoji || '',
    sourceTransactionSignature: tx.signature,
    sourceTransactionType: tx.detailedType,
    sourceSolAmount: tx.totalSol,
    ourSolAmount: 0,
    success: false,
    entryMcUsd: entryMcUsd > 0 ? entryMcUsd : undefined,
    exitMcUsd: exitMcUsd > 0 ? exitMcUsd : undefined,
  };
  
  try {
    // EXECUTE TRADE FIRST - speed is critical
    const trade = await paperSell(
      tx.tokenAddress,
      tx.tokenTicker,
      sellPercent,
      `mirror:${tx.detailedType}`
    );
    
    if (trade) {
      mirrorTrade.success = true;
      mirrorTrade.ourSolAmount = trade.solAmount;
      mirrorTrade.ourTokenAmount = trade.tokenAmount;
      mirrorTrade.pnl = trade.pnl;
      
      const costBasis = mirroredPosition?.costBasisSol || position.costBasis;
      mirrorTrade.pnlPercent = costBasis > 0 ? ((trade.pnl || 0) / costBasis) * 100 : 0;
      
      mirrorState.stats.successfulSells++;
      mirrorState.stats.totalPnL += trade.pnl || 0;
      
      // Remove from tracked positions if sold all
      if (sellPercent >= 100) {
        mirrorState.mirroredPositions.delete(tx.tokenAddress);
      }
      
      const pnlStr = trade.pnl !== undefined 
        ? (trade.pnl >= 0 ? `+${trade.pnl.toFixed(4)}` : trade.pnl.toFixed(4))
        : '?';
      logger.success(`🪞 [MIRROR] SELL EXECUTED: ${tx.tokenTicker} → ${trade.solAmount.toFixed(4)} SOL (PnL: ${pnlStr} SOL)`);
      
      // Fetch fresh exit MC in background
      fetchMCWithTimeout(tx.tokenAddress).then(freshMc => {
        if (freshMc > 0) {
          mirrorTrade.exitMcUsd = freshMc;
        }
      }).catch(() => {});
      
    } else {
      mirrorTrade.success = false;
      mirrorTrade.error = 'Sell returned null';
      mirrorState.stats.failedSells++;
    }
    
  } catch (error) {
    mirrorTrade.success = false;
    mirrorTrade.error = error instanceof Error ? error.message : 'Unknown error';
    mirrorState.stats.failedSells++;
    logger.error(`🪞 [MIRROR] SELL FAILED: ${mirrorTrade.error}`);
  }
  
  mirrorTrades.push(mirrorTrade);
  scheduleBatchSave(); // Batched save instead of immediate
}

/**
 * Process transaction queue - handles burst orders in parallel
 */
async function processTransactionQueue(): Promise<void> {
  if (isProcessingQueue || transactionQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  try {
    // Get all pending transactions
    const toProcess = transactionQueue.splice(0, MAX_CONCURRENT_TRADES);
    
    if (toProcess.length > 1) {
      logger.info(`🪞 [MIRROR] Processing ${toProcess.length} transactions in parallel`);
    }
    
    // Process all transactions in parallel for maximum speed
    await Promise.allSettled(
      toProcess.map(({ tx }) => processTransaction(tx))
    );
    
  } catch (error) {
    logger.error('[MIRROR] Queue processing error:', error);
  } finally {
    isProcessingQueue = false;
    
    // Continue processing if more in queue
    if (transactionQueue.length > 0) {
      setImmediate(processTransactionQueue);
    }
  }
}

/**
 * Queue a transaction for processing
 */
function queueTransaction(tx: AxiomWalletTransactionWithName): void {
  transactionQueue.push({
    tx,
    receivedAt: Date.now(),
  });
  
  // Trigger processing immediately
  setImmediate(processTransactionQueue);
}

/**
 * Start mirroring tracked wallets
 * OPTIMIZED: 500ms polling, parallel processing, queue-based burst handling
 */
export function startMirroring(config?: Partial<MirrorConfig>): boolean {
  if (mirrorState.isRunning) {
    logger.warn('[MIRROR] Already running');
    return false;
  }
  
  // Load paper trades to sync positions
  loadPaperTrades();
  
  // CRITICAL: Sync existing paper positions to mirroredPositions
  const portfolio = getPaperPortfolio();
  let syncedCount = 0;
  for (const [mint, position] of portfolio.positions) {
    if (!mirrorState.mirroredPositions.has(mint)) {
      mirrorState.mirroredPositions.set(mint, {
        walletAddress: 'pre-existing',
        symbol: position.symbol,
        entryTime: typeof position.entryTime === 'string' ? position.entryTime : new Date(position.entryTime).toISOString(),
        costBasisSol: position.costBasis,
      });
      syncedCount++;
    }
  }
  if (syncedCount > 0) {
    logger.info(`[MIRROR] Synced ${syncedCount} existing positions`);
  }
  
  // Update config if provided
  if (config) {
    mirrorState.config = { ...mirrorState.config, ...config };
  }
  mirrorState.config.enabled = true;
  
  // CRITICAL: Set the start timestamp
  mirrorStartTimestamp = Date.now();
  
  logger.header('🪞 MIRROR TRADER - ULTRA LOW LATENCY MODE');
  logger.info(`   ⚡ Polling: ${POLL_INTERVAL_MS}ms (${(1000/POLL_INTERVAL_MS).toFixed(1)} checks/sec)`);
  logger.info(`   ⚡ Max tx age: ${MAX_TRANSACTION_AGE_MS/1000}s`);
  logger.info(`   ⚡ Parallel trades: up to ${MAX_CONCURRENT_TRADES}`);
  logger.info(`   ⚡ Batch saves: every ${BATCH_SAVE_INTERVAL_MS}ms`);
  logger.info(`   Start time: ${new Date(mirrorStartTimestamp).toISOString()}`);
  logger.info(`   Mirror buys: ${mirrorState.config.mirrorBuys}`);
  logger.info(`   Mirror sells: ${mirrorState.config.mirrorSells}`);
  logger.info(`   Only first buys: ${mirrorState.config.onlyFirstBuys}`);
  if (mirrorState.config.walletFilter.length > 0) {
    logger.info(`   Wallet filter: ${mirrorState.config.walletFilter.length} wallets`);
  }
  
  // Start monitoring with FAST polling - 500ms for near real-time
  stopMonitorFn = monitorTrackedWallets(
    (transactions) => {
      // Queue ALL transactions for parallel processing
      // Don't await - let the queue handle it
      for (const tx of transactions) {
        queueTransaction(tx);
      }
    },
    {
      pollIntervalMs: POLL_INTERVAL_MS,  // 500ms for fast mirroring
      onlyBuys: false,
      includeWalletNames: true,
    }
  );
  
  // Start queue processor interval as backup
  if (queueProcessorInterval) {
    clearInterval(queueProcessorInterval);
  }
  queueProcessorInterval = setInterval(() => {
    if (transactionQueue.length > 0 && !isProcessingQueue) {
      processTransactionQueue();
    }
  }, 100); // Check queue every 100ms
  
  mirrorState.isRunning = true;
  mirrorState.startedAt = new Date().toISOString();
  saveMirrorState();
  
  logger.success('[MIRROR] ⚡ ULTRA LOW LATENCY MODE ACTIVE');
  return true;
}

/**
 * Stop mirroring
 */
export function stopMirroring(): void {
  if (!mirrorState.isRunning) {
    logger.warn('[MIRROR] Not running');
    return;
  }
  
  // Stop the monitor
  if (stopMonitorFn) {
    stopMonitorFn();
    stopMonitorFn = null;
  }
  
  // Stop queue processor
  if (queueProcessorInterval) {
    clearInterval(queueProcessorInterval);
    queueProcessorInterval = null;
  }
  
  // Clear transaction queue
  transactionQueue.length = 0;
  isProcessingQueue = false;
  
  mirrorState.isRunning = false;
  mirrorState.config.enabled = false;
  
  // Force immediate save of final state
  forceImmediateSave();
  
  logger.success('[MIRROR] Stopped');
}

/**
 * Get current mirror state
 * Also syncs mirroredPositions with actual paper portfolio (cleans up stale entries)
 */
export function getMirrorState(): {
  isRunning: boolean;
  startedAt: string | null;
  config: MirrorConfig;
  stats: MirrorState['stats'];
  activePositions: Array<{ 
    mint: string; 
    symbol: string; 
    walletAddress: string; 
    entryTime: string;
    entryMcUsd?: number;
    costBasisSol?: number;
  }>;
  performance: {
    pollIntervalMs: number;
    maxTransactionAgeMs: number;
    maxConcurrentTrades: number;
    queueSize: number;
  };
} {
  // Sync mirrored positions with actual paper portfolio
  const portfolio = getPaperPortfolio();
  let cleanedUp = false;
  
  for (const [mint, pos] of mirrorState.mirroredPositions.entries()) {
    if (!portfolio.positions.has(mint)) {
      mirrorState.mirroredPositions.delete(mint);
      logger.debug(`[MIRROR] Cleaned up stale mirrored position: ${pos.symbol}`);
      cleanedUp = true;
    }
  }
  
  if (cleanedUp) {
    scheduleBatchSave();
  }
  
  return {
    isRunning: mirrorState.isRunning,
    startedAt: mirrorState.startedAt,
    config: { ...mirrorState.config },
    stats: { ...mirrorState.stats },
    activePositions: Array.from(mirrorState.mirroredPositions.entries()).map(([mint, pos]) => ({
      mint,
      symbol: pos.symbol,
      walletAddress: pos.walletAddress,
      entryTime: pos.entryTime,
      entryMcUsd: pos.entryMcUsd,
      costBasisSol: pos.costBasisSol,
    })),
    performance: {
      pollIntervalMs: POLL_INTERVAL_MS,
      maxTransactionAgeMs: MAX_TRANSACTION_AGE_MS,
      maxConcurrentTrades: MAX_CONCURRENT_TRADES,
      queueSize: transactionQueue.length,
    },
  };
}

/**
 * Get mirror trades
 */
export function getMirrorTrades(limit: number = 100): MirrorTrade[] {
  return mirrorTrades.slice(-limit);
}

/**
 * Update mirror config
 */
export function updateMirrorConfig(config: Partial<MirrorConfig>): MirrorConfig {
  mirrorState.config = { ...mirrorState.config, ...config };
  saveMirrorState();
  return mirrorState.config;
}

/**
 * Sync paper portfolio positions to mirroredPositions
 * Call this to ensure all existing positions can be sold when tracked wallets sell
 */
export function syncMirroredPositions(): number {
  loadPaperTrades();
  const portfolio = getPaperPortfolio();
  let syncedCount = 0;
  
  for (const [mint, position] of portfolio.positions) {
    if (!mirrorState.mirroredPositions.has(mint)) {
      mirrorState.mirroredPositions.set(mint, {
        walletAddress: 'manual-sync',
        symbol: position.symbol,
        entryTime: typeof position.entryTime === 'string' ? position.entryTime : new Date(position.entryTime).toISOString(),
        costBasisSol: position.costBasis,
        // entryMcUsd not available for manual sync - will be undefined
      });
      syncedCount++;
      logger.info(`[MIRROR] Synced position: ${position.symbol}`);
    }
  }
  
  if (syncedCount > 0) {
    saveMirrorState();
    logger.success(`[MIRROR] Synced ${syncedCount} positions to mirroredPositions`);
  }
  
  return syncedCount;
}

/**
 * Reset mirror stats (keeps config)
 */
export function resetMirrorStats(): void {
  mirrorState.stats = {
    totalMirroredBuys: 0,
    totalMirroredSells: 0,
    successfulBuys: 0,
    successfulSells: 0,
    failedBuys: 0,
    failedSells: 0,
    totalPnL: 0,
  };
  mirrorState.processedSignatures.clear();
  mirrorState.mirroredPositions.clear();
  mirrorTrades = [];
  saveMirrorState();
  logger.success('[MIRROR] Stats reset');
}

/**
 * Display mirror summary
 */
export function displayMirrorSummary(): void {
  const stats = mirrorState.stats;
  const runTime = mirrorState.startedAt 
    ? Math.floor((Date.now() - new Date(mirrorState.startedAt).getTime()) / 1000 / 60)
    : 0;
  
  logger.header('🪞 MIRROR TRADER SUMMARY - ULTRA LOW LATENCY');
  
  logger.box('Performance Settings', [
    `Polling: ${POLL_INTERVAL_MS}ms (${(1000/POLL_INTERVAL_MS).toFixed(1)} checks/sec)`,
    `Max TX Age: ${MAX_TRANSACTION_AGE_MS/1000}s`,
    `Parallel Trades: ${MAX_CONCURRENT_TRADES}`,
    `Batch Save: ${BATCH_SAVE_INTERVAL_MS}ms`,
  ]);
  
  logger.box('Status', [
    `Running: ${mirrorState.isRunning ? '⚡ YES' : 'No'}`,
    `Run Time: ${runTime} minutes`,
    `Exact Mirroring: ${mirrorState.config.exactMirroring ? 'Yes' : 'No'}`,
    `Queue Size: ${transactionQueue.length}`,
  ]);
  
  logger.box('Statistics', [
    `Total Mirrored Buys: ${stats.totalMirroredBuys}`,
    `Successful Buys: ${stats.successfulBuys}`,
    `Failed Buys: ${stats.failedBuys}`,
    `Total Mirrored Sells: ${stats.totalMirroredSells}`,
    `Successful Sells: ${stats.successfulSells}`,
    `Failed Sells: ${stats.failedSells}`,
    `Total PnL: ${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(4)} SOL`,
  ]);
  
  if (mirrorState.mirroredPositions.size > 0) {
    logger.info('\nActive Mirrored Positions:');
    for (const [mint, pos] of mirrorState.mirroredPositions) {
      logger.info(`  ${pos.symbol}: mirrored from ${pos.walletAddress.slice(0, 8)}...`);
    }
  }
  
  const recentTrades = mirrorTrades.slice(-5);
  if (recentTrades.length > 0) {
    logger.info('\nRecent Mirror Trades:');
    for (const trade of recentTrades) {
      const time = format(new Date(trade.timestamp), 'MM/dd HH:mm');
      const status = trade.success ? '✓' : '✗';
      const pnlStr = trade.pnl !== undefined 
        ? ` | PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(4)}`
        : '';
      logger.info(`  [${time}] ${status} ${trade.type.toUpperCase()} ${trade.tokenSymbol} (from ${trade.sourceWalletName || trade.sourceWalletAddress.slice(0, 8)})${pnlStr}`);
    }
  }
}

/**
 * Get current performance settings
 */
export function getMirrorPerformanceSettings(): {
  pollIntervalMs: number;
  maxTransactionAgeMs: number;
  maxConcurrentTrades: number;
  batchSaveIntervalMs: number;
  mcFetchTimeoutMs: number;
} {
  return {
    pollIntervalMs: POLL_INTERVAL_MS,
    maxTransactionAgeMs: MAX_TRANSACTION_AGE_MS,
    maxConcurrentTrades: MAX_CONCURRENT_TRADES,
    batchSaveIntervalMs: BATCH_SAVE_INTERVAL_MS,
    mcFetchTimeoutMs: MC_FETCH_TIMEOUT_MS,
  };
}

// Initialize on load
loadMirrorState();
