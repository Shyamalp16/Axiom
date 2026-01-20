/**
 * PUMPPORTAL API INTEGRATION
 * 
 * Real-time data for Pump.fun tokens via PumpPortal WebSocket
 * Documentation: https://pumpportal.fun/data-api/real-time
 * 
 * Features:
 * - Real-time token creation events
 * - Trade streaming for specific tokens
 * - Account trade monitoring
 * - Migration events (graduation to Raydium)
 */

import WebSocket from 'ws';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import logger from '../utils/logger.js';

// PumpPortal WebSocket endpoint
const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Token data cache (populated from trade events)
const tokenCache: Map<string, PumpPortalToken> = new Map();
const tradeCache: Map<string, PumpPortalTrade[]> = new Map();

// WebSocket connection (singleton)
let ws: WebSocket | null = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Event handlers
type NewTokenHandler = (token: PumpPortalNewToken) => void;
type TradeHandler = (trade: PumpPortalTrade) => void;
type MigrationHandler = (event: PumpPortalMigration) => void;

const newTokenHandlers: NewTokenHandler[] = [];
const tradeHandlers: Map<string, TradeHandler[]> = new Map();
const migrationHandlers: MigrationHandler[] = [];

// ============================================
// TYPES
// ============================================

export interface PumpPortalToken {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  imageUri?: string;
  creator: string;
  createdTimestamp: number;
  ageMinutes: number;
  
  // Bonding curve state
  bondingCurve?: string;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  
  // Market data
  priceUsd: number;
  priceSol: number;
  marketCapUsd: number;
  marketCapSol: number;
  
  // Progress
  bondingCurveProgress: number;
  isGraduated: boolean;
  
  // Social (may not be available from PumpPortal)
  website?: string;
  twitter?: string;
  telegram?: string;
  
  // Stats
  tradeCount: number;
  lastTradeTimestamp?: number;
}

export interface PumpPortalNewToken {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'create';
  initialBuy: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
}

export interface PumpPortalTrade {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  newTokenBalance: number;
  timestamp: number;
}

export interface PumpPortalMigration {
  signature: string;
  mint: string;
  txType: 'migrate';
  pool: string; // Raydium pool address
}

// ============================================
// CONNECTION MANAGEMENT
// ============================================

/**
 * Connect to PumpPortal WebSocket
 */
export function connectPumpPortal(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isConnected && ws) {
      resolve();
      return;
    }
    
    try {
      ws = new WebSocket(PUMPPORTAL_WS_URL);
      
      ws.on('open', () => {
        isConnected = true;
        reconnectAttempts = 0;
        logger.success('Connected to PumpPortal WebSocket');
        resolve();
      });
      
      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          handleMessage(message);
        } catch (error) {
          logger.debug(`PumpPortal message parse error: ${error}`);
        }
      });
      
      ws.on('close', () => {
        isConnected = false;
        logger.warn('PumpPortal WebSocket disconnected');
        attemptReconnect();
      });
      
      ws.on('error', (error) => {
        logger.error('PumpPortal WebSocket error:', error);
        if (!isConnected) {
          reject(error);
        }
      });
      
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Disconnect from PumpPortal
 */
export function disconnectPumpPortal(): void {
  if (ws) {
    ws.close();
    ws = null;
    isConnected = false;
  }
}

/**
 * Attempt to reconnect
 */
function attemptReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error('Max reconnect attempts reached for PumpPortal');
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  
  logger.info(`Reconnecting to PumpPortal in ${delay / 1000}s (attempt ${reconnectAttempts})`);
  
  setTimeout(() => {
    connectPumpPortal().catch(() => {});
  }, delay);
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(message: any): void {
  if (!message.txType) return;
  
  switch (message.txType) {
    case 'create':
      handleNewToken(message);
      break;
    case 'buy':
    case 'sell':
      handleTrade(message);
      break;
    case 'migrate':
      handleMigration(message);
      break;
  }
}

/**
 * Handle new token creation event
 */
function handleNewToken(data: PumpPortalNewToken): void {
  // Create token entry in cache
  const token: PumpPortalToken = {
    mint: data.mint,
    name: data.name,
    symbol: data.symbol,
    creator: data.traderPublicKey,
    createdTimestamp: Date.now(),
    ageMinutes: 0,
    virtualSolReserves: data.vSolInBondingCurve / LAMPORTS_PER_SOL,
    virtualTokenReserves: data.vTokensInBondingCurve / 1e6,
    realSolReserves: data.initialBuy / LAMPORTS_PER_SOL,
    bondingCurve: data.bondingCurveKey,
    priceSol: (data.vSolInBondingCurve / LAMPORTS_PER_SOL) / (data.vTokensInBondingCurve / 1e6),
    priceUsd: 0, // Will be calculated
    marketCapSol: data.marketCapSol / LAMPORTS_PER_SOL,
    marketCapUsd: 0, // Will be calculated
    bondingCurveProgress: 0,
    isGraduated: false,
    tradeCount: 1,
  };
  
  tokenCache.set(data.mint, token);
  
  // Notify handlers
  for (const handler of newTokenHandlers) {
    try {
      handler(data);
    } catch (error) {
      logger.debug(`New token handler error: ${error}`);
    }
  }
}

/**
 * Handle trade event
 */
function handleTrade(data: PumpPortalTrade): void {
  // Add timestamp
  data.timestamp = Date.now();
  
  // Update token cache
  const existing = tokenCache.get(data.mint);
  if (existing) {
    existing.virtualSolReserves = data.vSolInBondingCurve / LAMPORTS_PER_SOL;
    existing.virtualTokenReserves = data.vTokensInBondingCurve / 1e6;
    existing.marketCapSol = data.marketCapSol / LAMPORTS_PER_SOL;
    existing.priceSol = existing.virtualSolReserves / existing.virtualTokenReserves;
    existing.tradeCount++;
    existing.lastTradeTimestamp = data.timestamp;
    existing.ageMinutes = (Date.now() - existing.createdTimestamp) / 1000 / 60;
  }
  
  // Add to trade cache
  const trades = tradeCache.get(data.mint) || [];
  trades.unshift(data);
  if (trades.length > 100) trades.pop(); // Keep last 100 trades
  tradeCache.set(data.mint, trades);
  
  // Notify handlers
  const handlers = tradeHandlers.get(data.mint) || [];
  for (const handler of handlers) {
    try {
      handler(data);
    } catch (error) {
      logger.debug(`Trade handler error: ${error}`);
    }
  }
}

/**
 * Handle migration event (token graduated to Raydium)
 */
function handleMigration(data: PumpPortalMigration): void {
  // Mark token as graduated
  const token = tokenCache.get(data.mint);
  if (token) {
    token.isGraduated = true;
  }
  
  // Notify handlers
  for (const handler of migrationHandlers) {
    try {
      handler(data);
    } catch (error) {
      logger.debug(`Migration handler error: ${error}`);
    }
  }
}

// ============================================
// SUBSCRIPTION METHODS
// ============================================

/**
 * Subscribe to new token creation events
 */
export function subscribeNewTokens(handler: NewTokenHandler): () => void {
  ensureConnected();
  
  // Add handler
  newTokenHandlers.push(handler);
  
  // Send subscription if this is the first handler
  if (newTokenHandlers.length === 1 && ws && isConnected) {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    logger.info('Subscribed to new token events');
  }
  
  // Return unsubscribe function
  return () => {
    const index = newTokenHandlers.indexOf(handler);
    if (index > -1) {
      newTokenHandlers.splice(index, 1);
    }
    
    if (newTokenHandlers.length === 0 && ws && isConnected) {
      ws.send(JSON.stringify({ method: 'unsubscribeNewToken' }));
    }
  };
}

/**
 * Subscribe to trades for specific token(s)
 */
export function subscribeTokenTrades(mints: string[], handler: TradeHandler): () => void {
  ensureConnected();
  
  // Add handlers for each mint
  for (const mint of mints) {
    const handlers = tradeHandlers.get(mint) || [];
    handlers.push(handler);
    tradeHandlers.set(mint, handlers);
  }
  
  // Send subscription
  if (ws && isConnected) {
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints }));
    logger.debug(`Subscribed to trades for ${mints.length} token(s)`);
  }
  
  // Return unsubscribe function
  return () => {
    for (const mint of mints) {
      const handlers = tradeHandlers.get(mint) || [];
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      
      if (handlers.length === 0) {
        tradeHandlers.delete(mint);
        if (ws && isConnected) {
          ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
        }
      }
    }
  };
}

/**
 * Subscribe to migration events
 */
export function subscribeMigrations(handler: MigrationHandler): () => void {
  ensureConnected();
  
  migrationHandlers.push(handler);
  
  if (migrationHandlers.length === 1 && ws && isConnected) {
    ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    logger.info('Subscribed to migration events');
  }
  
  return () => {
    const index = migrationHandlers.indexOf(handler);
    if (index > -1) {
      migrationHandlers.splice(index, 1);
    }
  };
}

/**
 * Ensure WebSocket is connected
 */
function ensureConnected(): void {
  if (!isConnected || !ws) {
    connectPumpPortal().catch((error) => {
      logger.error('Failed to connect to PumpPortal:', error);
    });
  }
}

// ============================================
// DATA ACCESS METHODS
// ============================================

/**
 * Get token from cache
 */
export function getCachedToken(mint: string): PumpPortalToken | null {
  return tokenCache.get(mint) || null;
}

/**
 * Get recent trades from cache
 */
export function getCachedTrades(mint: string): PumpPortalTrade[] {
  return tradeCache.get(mint) || [];
}

/**
 * Check if we have data for a token
 */
export function hasTokenData(mint: string): boolean {
  return tokenCache.has(mint);
}

/**
 * Get connection status
 */
export function isConnectedToPumpPortal(): boolean {
  return isConnected;
}

/**
 * Clear caches
 */
export function clearCaches(): void {
  tokenCache.clear();
  tradeCache.clear();
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Fetch token data by subscribing temporarily
 * This is a helper for one-off token lookups
 */
export async function fetchTokenViaPumpPortal(
  mint: string,
  timeoutMs: number = 5000
): Promise<PumpPortalToken | null> {
  // Check cache first
  const cached = getCachedToken(mint);
  if (cached) {
    // Update age
    cached.ageMinutes = (Date.now() - cached.createdTimestamp) / 1000 / 60;
    return cached;
  }
  
  // Subscribe and wait for data
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    
    const unsubscribe = subscribeTokenTrades([mint], (trade) => {
      clearTimeout(timeout);
      unsubscribe();
      
      // Build token from trade data
      const token: PumpPortalToken = {
        mint: trade.mint,
        name: 'Unknown',
        symbol: 'UNKNOWN',
        creator: '',
        createdTimestamp: Date.now() - 60000, // Estimate
        ageMinutes: 1,
        virtualSolReserves: trade.vSolInBondingCurve / LAMPORTS_PER_SOL,
        virtualTokenReserves: trade.vTokensInBondingCurve / 1e6,
        realSolReserves: 0,
        priceSol: (trade.vSolInBondingCurve / LAMPORTS_PER_SOL) / (trade.vTokensInBondingCurve / 1e6),
        priceUsd: 0,
        marketCapSol: trade.marketCapSol / LAMPORTS_PER_SOL,
        marketCapUsd: 0,
        bondingCurveProgress: 0,
        isGraduated: false,
        tradeCount: 1,
        lastTradeTimestamp: trade.timestamp,
      };
      
      tokenCache.set(mint, token);
      resolve(token);
    });
  });
}

/**
 * Wait for new tokens (returns first N new tokens)
 */
export async function waitForNewTokens(
  count: number = 1,
  timeoutMs: number = 60000
): Promise<PumpPortalNewToken[]> {
  const tokens: PumpPortalNewToken[] = [];
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(tokens);
    }, timeoutMs);
    
    const unsubscribe = subscribeNewTokens((token) => {
      tokens.push(token);
      
      if (tokens.length >= count) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(tokens);
      }
    });
  });
}
