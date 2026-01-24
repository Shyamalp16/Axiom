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

// Pump.fun REST API endpoints
const PUMPFUN_API_URL = 'https://frontend-api-v3.pump.fun';
const PUMPFUN_ADVANCED_API_URL = 'https://advanced-api-v2.pump.fun';
const PUMPFUN_VOLATILITY_API_URL = 'https://volatility-api-v2.pump.fun';

// Bonding curve graduation threshold (85 SOL)
const BONDING_CURVE_SOL_TARGET = 85;

// Cached SOL price (refreshed periodically)
let cachedSolPrice: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_MS = 30000; // 30 seconds

// ETag cache for API responses (reduces bandwidth via 304 Not Modified)
interface ETagCacheEntry<T> {
  etag: string;
  data: T;
  timestamp: number;
}
const etagCache: Map<string, ETagCacheEntry<unknown>> = new Map();
const ETAG_CACHE_TTL_MS = 60000; // 1 minute max TTL before forcing refresh

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
    // Smart unit conversion for reserves
    // WebSocket can return values in lamports OR already converted
    // Heuristic: if value > 1e9, it's likely in lamports; if < 1000, it's likely in SOL/tokens
    if (data.vSolInBondingCurve > 0) {
      const rawSol = data.vSolInBondingCurve;
      // Expected range for bonding curve: 1-100 SOL
      // If > 1e9, definitely lamports. If < 1000, check if conversion makes sense
      const convertedSol = rawSol > 1e9 ? rawSol / LAMPORTS_PER_SOL : 
                           rawSol > 1000 ? rawSol / LAMPORTS_PER_SOL : rawSol;
      // Sanity check: should be between 0.1 and 100 SOL for active bonding curve
      if (convertedSol >= 0.1 && convertedSol <= 100) {
        existing.virtualSolReserves = convertedSol;
      }
      // else: don't update, keep existing value
    }
    
    if (data.vTokensInBondingCurve > 0) {
      const rawTokens = data.vTokensInBondingCurve;
      // Expected range: 100M - 1B tokens
      // If > 1e12, definitely in token atoms (need /1e6). If < 1e9, check if makes sense
      const convertedTokens = rawTokens > 1e12 ? rawTokens / 1e6 :
                              rawTokens > 1e9 ? rawTokens / 1e6 : rawTokens;
      // Sanity check: should be between 100M and 1B for pump.fun
      if (convertedTokens >= 1e8 && convertedTokens <= 1.1e9) {
        existing.virtualTokenReserves = convertedTokens;
      }
    }
    
    // Only update market cap if we have valid data (> 0)
    if (data.marketCapSol > 0) {
      const rawMcap = data.marketCapSol;
      // Expected range: 1-100 SOL market cap during bonding curve
      const convertedMcap = rawMcap > 1e9 ? rawMcap / LAMPORTS_PER_SOL : rawMcap;
      if (convertedMcap >= 0.1 && convertedMcap <= 500) {
        existing.marketCapSol = convertedMcap;
        existing.marketCapUsd = existing.marketCapSol * (cachedSolPrice?.price || 150);
      }
    }
    
    // Recalculate price if we have valid reserves
    if (existing.virtualSolReserves > 0.1 && existing.virtualTokenReserves > 1e8) {
      existing.priceSol = existing.virtualSolReserves / existing.virtualTokenReserves;
    }
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
 * Fetch fresh token data (bypasses all caching)
 * Use this for live price monitoring
 */
export async function fetchFreshPumpToken(mint: string): Promise<PumpPortalToken | null> {
  // Add cache-busting timestamp and clear ETag cache
  const cacheKey = `coins:${mint}`;
  etagCache.delete(cacheKey); // Clear ETag to force fresh fetch
  
  const token = await fetchTokenViaRestApi(mint, true);
  if (token) {
    tokenCache.set(mint, token);
  }
  return token;
}

/**
 * Fetch ULTRA FRESH token data - bypasses ALL caching including pump.fun CDN
 * Use this for real-time MC tracking
 * 
 * IMPORTANT: This function makes a direct API call with cache-busting to get
 * the most recent market cap data. Do not add any caching here.
 */
export async function fetchUltraFreshPumpToken(mint: string): Promise<PumpPortalToken | null> {
  if (!mint || mint.length < 32) {
    logger.debug(`Invalid mint address: ${mint}`);
    return null;
  }

  const PUMPFUN_API_URL = 'https://frontend-api-v3.pump.fun';
  // Add cache-busting timestamp to bypass CDN caching
  const cacheBuster = Date.now();
  const url = `${PUMPFUN_API_URL}/coins/${mint}?sync=true&_t=${cacheBuster}`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      // Don't log 404s as errors - token might just not exist on pump.fun
      if (response.status !== 404) {
        logger.debug(`Ultra fresh fetch returned ${response.status} for ${mint.slice(0, 8)}...`);
      }
      return null;
    }
    
    const data = await response.json() as any;
    
    if (!data || !data.mint) {
      logger.debug(`Invalid response data for ${mint.slice(0, 8)}...`);
      return null;
    }
    
    // Get SOL price for conversions
    const solPrice = await getSolPrice();
    
    // Extract market cap - try multiple fields
    let marketCapUsd = 0;
    if (data.usd_market_cap && data.usd_market_cap > 0) {
      marketCapUsd = data.usd_market_cap;
    } else if (data.market_cap_usd && data.market_cap_usd > 0) {
      marketCapUsd = data.market_cap_usd;
    } else if (data.market_cap && data.market_cap > 0) {
      // market_cap might be in SOL, convert to USD
      marketCapUsd = data.market_cap * solPrice;
    }
    
    // Convert directly to PumpPortalToken
    const token: PumpPortalToken = {
      mint: data.mint,
      name: data.name || 'Unknown',
      symbol: data.symbol || 'UNKNOWN',
      description: data.description || '',
      imageUri: data.image_uri || '',
      creator: data.creator || '',
      createdTimestamp: data.created_timestamp || Date.now(),
      ageMinutes: data.created_timestamp ? (Date.now() - data.created_timestamp) / 1000 / 60 : 0,
      bondingCurve: data.bonding_curve || '',
      virtualSolReserves: (data.virtual_sol_reserves || 0) / 1e9,
      virtualTokenReserves: (data.virtual_token_reserves || 0) / 1e6,
      realSolReserves: (data.real_sol_reserves || 0) / 1e9,
      priceSol: 0,
      priceUsd: 0,
      marketCapSol: 0,
      marketCapUsd: marketCapUsd,
      bondingCurveProgress: 0,
      isGraduated: data.complete === true || !!data.raydium_pool,
      website: data.website,
      twitter: data.twitter,
      telegram: data.telegram,
      tradeCount: data.reply_count || 0,
      lastTradeTimestamp: data.last_reply,
    };
    
    // Calculate prices from reserves if not provided
    if (token.virtualSolReserves > 0 && token.virtualTokenReserves > 0) {
      token.priceSol = token.virtualSolReserves / token.virtualTokenReserves;
      token.priceUsd = token.priceSol * solPrice;
    }
    
    // Calculate market cap in SOL if we have USD
    if (token.marketCapUsd > 0 && solPrice > 0) {
      token.marketCapSol = token.marketCapUsd / solPrice;
    }
    
    // Calculate bonding curve progress
    const BONDING_CURVE_SOL_TARGET = 85;
    token.bondingCurveProgress = Math.min(100, (token.realSolReserves / BONDING_CURVE_SOL_TARGET) * 100);
    
    // DO NOT cache ultra-fresh results - we want fresh data each time
    // tokenCache.set(mint, token);
    
    return token;
    
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug(`Ultra fresh fetch timed out for ${mint.slice(0, 8)}...`);
    } else {
      logger.debug(`Ultra fresh fetch failed for ${mint.slice(0, 8)}...: ${error}`);
    }
    return null;
  }
}

/**
 * Get recent trades from cache
 */
export function getCachedTrades(mint: string): PumpPortalTrade[] {
  return tradeCache.get(mint) || [];
}

/**
 * Get connection status
 */
export function isConnectedToPumpPortal(): boolean {
  return isConnected;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Pump.fun REST API response type for /coins/{mint}
 * Based on frontend-api-v3.pump.fun OpenAPI spec
 */
interface PumpFunApiResponse {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  image_uri?: string;
  creator: string;
  created_timestamp: number;
  bonding_curve?: string;
  associated_bonding_curve?: string;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  real_sol_reserves: number;
  real_token_reserves: number;
  total_supply: number;
  market_cap: number;
  usd_market_cap: number;
  market_cap_usd?: number;
  market_cap_sol?: number;
  price?: number;
  price_usd?: number;
  price_sol?: number;
  complete: boolean;
  raydium_pool?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  reply_count?: number;
  last_reply?: number;
}

/**
 * Fetch SOL price from Pump.fun API
 * Uses /sol-price endpoint from frontend-api-v3
 */
async function fetchSolPriceFromPumpFun(): Promise<number> {
  // Return cached price if fresh enough
  if (cachedSolPrice && Date.now() - cachedSolPrice.timestamp < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice.price;
  }
  
  try {
    const response = await fetch(`${PUMPFUN_API_URL}/sol-price`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`SOL price API returned ${response.status}`);
      return cachedSolPrice?.price || 150; // Fallback
    }
    
    const data = await response.json() as { solPrice: number } | number;
    
    // API might return { solPrice: number } or just a number
    const price = typeof data === 'number' ? data : (data.solPrice || 150);
    
    cachedSolPrice = { price, timestamp: Date.now() };
    logger.debug(`SOL price updated: $${price}`);
    
    return price;
  } catch (error) {
    logger.debug(`Failed to fetch SOL price: ${error}`);
    return cachedSolPrice?.price || 150; // Fallback
  }
}

/**
 * Export SOL price fetcher for use by other modules
 */
export async function getSolPrice(): Promise<number> {
  return fetchSolPriceFromPumpFun();
}

/**
 * Convert API response to PumpPortalToken
 */
async function convertApiResponseToToken(data: PumpFunApiResponse): Promise<PumpPortalToken> {
  // Fetch current SOL price for USD calculations
  const solPrice = await fetchSolPriceFromPumpFun();
  
  // Check if token is graduated (moved to Raydium)
  const isGraduated = data.complete === true || data.raydium_pool != null;
  
  // Handle timestamp - API returns Unix seconds, convert to milliseconds
  // Detect format: if timestamp is < year 2000 in ms, it's probably seconds
  let createdTimestamp = data.created_timestamp || 0;
  if (createdTimestamp > 0 && createdTimestamp < 1e12) {
    // Timestamp is in seconds, convert to milliseconds
    createdTimestamp = createdTimestamp * 1000;
  }
  const ageMinutes = createdTimestamp > 0 
    ? (Date.now() - createdTimestamp) / 1000 / 60 
    : 0;
  
  // Calculate derived values
  // Note: For graduated tokens, reserves may be 0 as liquidity moved to Raydium
  const rawVirtualSol = data.virtual_sol_reserves || 0;
  const rawVirtualTokens = data.virtual_token_reserves || 0;
  const rawRealSol = data.real_sol_reserves || 0;

  // Smart unit conversion with sanity checks
  // API can return values in lamports/atoms OR already converted to SOL/tokens
  // Expected ranges for pump.fun bonding curve:
  // - virtualSolReserves: 10-100 SOL
  // - virtualTokenReserves: 100M - 1B tokens
  // - realSolReserves: 0-85 SOL
  
  let virtualSolReserves: number;
  if (rawVirtualSol > 1e9) {
    // Definitely in lamports (billions), convert to SOL
    virtualSolReserves = rawVirtualSol / LAMPORTS_PER_SOL;
  } else if (rawVirtualSol > 1000) {
    // Ambiguous - could be lamports (thousands) or SOL (would be unusually high)
    // Try conversion, check if result is reasonable
    const asLamports = rawVirtualSol / LAMPORTS_PER_SOL;
    virtualSolReserves = asLamports >= 0.1 ? asLamports : rawVirtualSol;
  } else {
    // Small value - assume already in SOL
    virtualSolReserves = rawVirtualSol;
  }
  
  let virtualTokenReserves: number;
  if (rawVirtualTokens > 1e12) {
    // Definitely in token atoms (trillions), convert
    virtualTokenReserves = rawVirtualTokens / 1e6;
  } else if (rawVirtualTokens > 1e9) {
    // Billions - could be atoms or already converted
    const asAtoms = rawVirtualTokens / 1e6;
    // If result is in expected range (100M-1B), use it
    virtualTokenReserves = asAtoms >= 1e8 ? asAtoms : rawVirtualTokens;
  } else {
    // Assume already in token units
    virtualTokenReserves = rawVirtualTokens;
  }
  
  let realSolReserves: number;
  if (rawRealSol > 1e9) {
    realSolReserves = rawRealSol / LAMPORTS_PER_SOL;
  } else if (rawRealSol > 1000) {
    const asLamports = rawRealSol / LAMPORTS_PER_SOL;
    realSolReserves = asLamports >= 0.01 ? asLamports : rawRealSol;
  } else {
    realSolReserves = rawRealSol;
  }

  // Calculate price from API field or reserves
  let priceSol = data.price_sol || 0;
  if (priceSol === 0 && virtualTokenReserves > 0 && virtualSolReserves > 0) {
    priceSol = virtualSolReserves / virtualTokenReserves;
  }
  
  // Sanity check: price should be between 1e-12 and 1e-6 for typical pump.fun tokens
  // If calculated price is outside this range, something is wrong
  if (priceSol > 0 && (priceSol < 1e-12 || priceSol > 1e-5)) {
    logger.debug(`Price sanity check failed: ${priceSol.toExponential(4)} - may have unit conversion issue`);
  }
  
  const priceUsd = data.price_usd || (data.price ? data.price : priceSol * solPrice);
  
  // For graduated tokens, bonding curve is 100%
  const bondingCurveProgress = isGraduated 
    ? 100 
    : Math.min(100, (realSolReserves / BONDING_CURVE_SOL_TARGET) * 100);
  
  // Market cap handling:
  // - usd_market_cap: Direct USD value from API
  // - market_cap: Value in lamports (SOL)
  // For graduated tokens, both might be 0 from pump.fun API (liquidity moved to Raydium)
  const rawMarketCap = data.market_cap || 0;
  let marketCapUsd =
    data.usd_market_cap ||
    data.market_cap_usd ||
    0;
  let marketCapSol =
    data.market_cap_sol ||
    0;
  
  // If market cap is 0 but we have reserves, estimate from reserves
  if (marketCapUsd === 0 && marketCapSol === 0 && rawMarketCap > 0) {
    // Heuristic: if market_cap looks like lamports (> 1e9), treat as SOL lamports
    if (rawMarketCap > 1e9) {
      marketCapSol = rawMarketCap / LAMPORTS_PER_SOL;
      marketCapUsd = marketCapSol * solPrice;
    } else {
      // Otherwise assume market_cap is already USD
      marketCapUsd = rawMarketCap;
      marketCapSol = marketCapUsd / solPrice;
    }
  }

  if (marketCapUsd === 0 && marketCapSol === 0 && virtualSolReserves > 0) {
    // Total supply is typically 1 billion for pump.fun tokens
    const rawSupply = data.total_supply || 0;
    const totalSupply =
      rawSupply > 1e9 ? rawSupply / 1e6 : rawSupply > 0 ? rawSupply : 1e9;
    marketCapSol = priceSol * totalSupply;
    marketCapUsd = marketCapSol * solPrice;
  }

  if (marketCapUsd === 0 && marketCapSol > 0) {
    marketCapUsd = marketCapSol * solPrice;
  } else if (marketCapSol === 0 && marketCapUsd > 0) {
    marketCapSol = marketCapUsd / solPrice;
  }
  
  // Debug logging only for problematic tokens (missing price/mcap)
  if (marketCapUsd === 0 && priceSol === 0) {
    logger.debug(`API: ${data.symbol} missing price/mcap data`);
  }
  
  return {
    mint: data.mint,
    name: data.name,
    symbol: data.symbol,
    description: data.description,
    imageUri: data.image_uri,
    creator: data.creator,
    createdTimestamp,
    ageMinutes,
    bondingCurve: data.bonding_curve,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    priceSol,
    priceUsd,
    marketCapSol,
    marketCapUsd,
    bondingCurveProgress,
    isGraduated,
    website: data.website,
    twitter: data.twitter,
    telegram: data.telegram,
    tradeCount: data.reply_count || 0,
    lastTradeTimestamp: data.last_reply,
  };
}

/**
 * Fetch token data via Pump.fun REST API
 * More reliable than WebSocket for one-off lookups (doesn't require active trades)
 * Uses ?sync=true to get fresh on-chain data
 * Supports ETag caching for bandwidth optimization (304 Not Modified)
 */
async function fetchTokenViaRestApi(mint: string, skipEtagCache: boolean = false): Promise<PumpPortalToken | null> {
  const cacheKey = `coins:${mint}`;
  const url = `${PUMPFUN_API_URL}/coins/${mint}?sync=true`;
  
  try {
    logger.debug(`Fetching token via REST API: ${mint.slice(0, 8)}...${skipEtagCache ? ' (fresh)' : ''}`);
    
    // Build headers with ETag support
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Origin': 'https://pump.fun',
    };
    
    // Include If-None-Match header if we have a cached ETag (unless skipEtagCache)
    const cached = etagCache.get(cacheKey) as ETagCacheEntry<PumpFunApiResponse> | undefined;
    if (!skipEtagCache && cached && Date.now() - cached.timestamp < ETAG_CACHE_TTL_MS) {
      headers['If-None-Match'] = cached.etag;
    }
    
    const response = await fetch(url, { headers });
    
    // Handle 304 Not Modified - return cached data
    if (response.status === 304 && cached) {
      const cachedToken = await convertApiResponseToToken(cached.data);
      // If cached conversion has no market cap, force a fresh fetch
      if (cachedToken.marketCapUsd <= 0 && cachedToken.marketCapSol <= 0) {
        logger.debug(`REST API 304 but cached token has no market cap, forcing fresh fetch...`);
        etagCache.delete(cacheKey); // Clear stale ETag
        return fetchTokenViaRestApi(mint); // Retry without ETag
      }
      logger.debug(`REST API cache hit (304) for ${mint.slice(0, 8)}... mcap: $${cachedToken.marketCapUsd.toFixed(0)}`);
      return cachedToken;
    }
    
    if (!response.ok) {
      logger.debug(`REST API returned ${response.status} for ${mint.slice(0, 8)}...`);
      return null;
    }
    
    const data = await response.json() as PumpFunApiResponse;
    
    // Store ETag for future requests
    const etag = response.headers.get('etag');
    if (etag) {
      etagCache.set(cacheKey, {
        etag,
        data,
        timestamp: Date.now(),
      });
      logger.debug(`REST API cached with ETag: ${etag.slice(0, 20)}...`);
    }
    
    const token = await convertApiResponseToToken(data);
    
    logger.debug(`REST API success: ${data.symbol} (${data.name}) - graduated: ${token.isGraduated}, mcap: $${token.marketCapUsd.toLocaleString()}`);
    return token;
    
  } catch (error) {
    logger.debug(`REST API fetch failed: ${error}`);
    return null;
  }
}

/**
 * Fetch token data - tries REST API first, falls back to WebSocket
 * REST API is more reliable for inactive tokens
 */
export async function fetchTokenViaPumpPortal(
  mint: string,
  timeoutMs: number = 5000
): Promise<PumpPortalToken | null> {
  // 1. Check cache first
  const cached = getCachedToken(mint);
  if (cached) {
    // Update age
    cached.ageMinutes = (Date.now() - cached.createdTimestamp) / 1000 / 60;
    // If cache has market cap info, use it; otherwise try REST for richer data
    const hasMarketCap = cached.marketCapUsd > 0 || cached.marketCapSol > 0;
    if (hasMarketCap) {
      return cached;
    }
    logger.debug(`Cached token missing market cap, refreshing via REST: ${mint.slice(0, 8)}...`);
  }
  
  // 2. Try REST API first (works for any token, even inactive ones)
  const restToken = await fetchTokenViaRestApi(mint);
  if (restToken) {
    // Only update cache if the new token has market cap, or there's no existing cached token
    const existingCached = tokenCache.get(mint);
    if (!existingCached || 
        restToken.marketCapUsd > 0 || 
        restToken.marketCapSol > 0 ||
        (existingCached.marketCapUsd <= 0 && existingCached.marketCapSol <= 0)) {
      tokenCache.set(mint, restToken);
    } else if (existingCached) {
      // Merge: update other fields but keep the good market cap
      logger.debug(`Preserving cached market cap: $${existingCached.marketCapUsd.toFixed(0)}`);
      restToken.marketCapUsd = existingCached.marketCapUsd;
      restToken.marketCapSol = existingCached.marketCapSol;
      tokenCache.set(mint, restToken);
    }
    return tokenCache.get(mint)!;
  }
  
  // 3. Fallback to WebSocket (for very new tokens not yet indexed by REST API)
  logger.debug(`REST API failed, trying WebSocket for ${mint.slice(0, 8)}...`);
  
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

// ============================================
// ADDITIONAL API ENDPOINTS
// ============================================

/**
 * Batch fetch metadata for multiple coin mints
 * POST /coins/mints - More efficient than individual lookups
 */
export async function fetchMultipleTokens(mints: string[]): Promise<PumpPortalToken[]> {
  try {
    const response = await fetch(`${PUMPFUN_API_URL}/coins/mints`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://pump.fun',
      },
      body: JSON.stringify({ mints }),
    });
    
    if (!response.ok) {
      logger.debug(`Batch fetch returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      if (data && data.mint) {
        const token = await convertApiResponseToToken(data);
        tokens.push(token);
        tokenCache.set(data.mint, token);
      }
    }
    
    logger.debug(`Batch fetched ${tokens.length} tokens`);
    return tokens;
  } catch (error) {
    logger.debug(`Batch fetch failed: ${error}`);
    return [];
  }
}

/**
 * Get currently live coins on pump.fun
 * GET /coins/currently-live
 * Only returns tokens still on bonding curve (not graduated)
 */
export async function fetchCurrentlyLiveCoins(
  limit: number = 50,
  offset: number = 0,
  includeNsfw: boolean = false
): Promise<PumpPortalToken[]> {
  try {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      includeNsfw: includeNsfw.toString(),
    });
    
    const response = await fetch(`${PUMPFUN_API_URL}/coins/currently-live?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Currently live fetch returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      // Skip graduated tokens (complete=true or has raydium_pool)
      if (!data || !data.mint || data.complete === true || data.raydium_pool) {
        continue;
      }
      const token = await convertApiResponseToToken(data);
      if (!token.isGraduated) {
        tokens.push(token);
      }
    }
    
    return tokens;
  } catch (error) {
    logger.debug(`Currently live fetch failed: ${error}`);
    return [];
  }
}

/**
 * Search coins with filtering and sorting
 * GET /coins/search
 */
export async function searchCoins(options: {
  searchTerm?: string;
  limit?: number;
  offset?: number;
  sort?: 'created_timestamp' | 'market_cap' | 'reply_count';
  order?: 'ASC' | 'DESC';
  complete?: boolean; // true = graduated, false = still on bonding curve
  includeNsfw?: boolean;
}): Promise<PumpPortalToken[]> {
  try {
    const params = new URLSearchParams();
    params.set('limit', (options.limit || 50).toString());
    params.set('offset', (options.offset || 0).toString());
    params.set('sort', options.sort || 'created_timestamp');
    params.set('order', options.order || 'DESC');
    params.set('includeNsfw', (options.includeNsfw || false).toString());
    
    if (options.searchTerm) params.set('searchTerm', options.searchTerm);
    if (options.complete !== undefined) params.set('complete', options.complete.toString());
    
    const response = await fetch(`${PUMPFUN_API_URL}/coins/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Search returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      if (data && data.mint) {
        const token = await convertApiResponseToToken(data);
        tokens.push(token);
      }
    }
    
    return tokens;
  } catch (error) {
    logger.debug(`Search failed: ${error}`);
    return [];
  }
}

/**
 * Get current trending meta words
 * GET /metas/current
 */
export async function fetchTrendingMetas(): Promise<string[]> {
  try {
    const response = await fetch(`${PUMPFUN_API_URL}/metas/current`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json() as { metas?: string[] } | string[];
    return Array.isArray(data) ? data : (data.metas || []);
  } catch {
    return [];
  }
}

/**
 * Get coins that graduated to Raydium
 * GET /coins/graduated (Advanced API v2)
 */
export async function fetchGraduatedCoins(
  limit: number = 50,
  offset: number = 0
): Promise<PumpPortalToken[]> {
  try {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
    });
    
    const response = await fetch(`${PUMPFUN_ADVANCED_API_URL}/coins/graduated?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Graduated coins fetch returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      if (data && data.mint) {
        const token = await convertApiResponseToToken(data);
        token.isGraduated = true; // Ensure graduated flag is set
        tokens.push(token);
      }
    }
    
    return tokens;
  } catch (error) {
    logger.debug(`Graduated coins fetch failed: ${error}`);
    return [];
  }
}

/**
 * Get most volatile coins by score
 * GET /coins/volatile (Volatility API v2)
 * Only returns tokens still on bonding curve (not graduated)
 */
export async function fetchVolatileCoins(): Promise<PumpPortalToken[]> {
  try {
    const response = await fetch(`${PUMPFUN_VOLATILITY_API_URL}/coins/volatile`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Volatile coins fetch returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      // Skip graduated tokens (complete=true or has raydium_pool)
      if (!data || !data.mint || data.complete === true || data.raydium_pool) {
        continue;
      }
      const token = await convertApiResponseToToken(data);
      if (!token.isGraduated) {
        tokens.push(token);
      }
    }
    
    return tokens;
  } catch (error) {
    logger.debug(`Volatile coins fetch failed: ${error}`);
    return [];
  }
}

/**
 * Get featured coins with holder analytics
 * GET /coins/featured (Advanced API v2)
 * Only returns tokens still on bonding curve (not graduated)
 */
export async function fetchFeaturedCoins(
  timeWindow: '1h' | '6h' | '24h' = '24h',
  limit: number = 50,
  offset: number = 0
): Promise<PumpPortalToken[]> {
  try {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      includeNsfw: 'false',
    });
    
    const response = await fetch(`${PUMPFUN_ADVANCED_API_URL}/coins/featured/${timeWindow}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Featured coins fetch returned ${response.status}`);
      return [];
    }
    
    const dataArray = await response.json() as PumpFunApiResponse[];
    const tokens: PumpPortalToken[] = [];
    
    for (const data of dataArray) {
      // Skip graduated tokens (complete=true or has raydium_pool)
      if (!data || !data.mint || data.complete === true || data.raydium_pool) {
        continue;
      }
      const token = await convertApiResponseToToken(data);
      if (!token.isGraduated) {
        tokens.push(token);
      }
    }
    
    return tokens;
  } catch (error) {
    logger.debug(`Featured coins fetch failed: ${error}`);
    return [];
  }
}

/**
 * Get king of the hill token (highest market cap on bonding curve)
 * GET /coins/king-of-the-hill
 */
export async function fetchKingOfTheHill(): Promise<PumpPortalToken | null> {
  try {
    const response = await fetch(`${PUMPFUN_API_URL}/coins/king-of-the-hill?includeNsfw=false`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json() as PumpFunApiResponse;
    if (!data || !data.mint) return null;
    
    return convertApiResponseToToken(data);
  } catch {
    return null;
  }
}

// ============================================
// CANDLESTICK & TRADE DATA
// ============================================

/**
 * Pump.fun candlestick response type
 */
interface PumpFunCandle {
  mint: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  slot: number;
}

/**
 * Standardized candle format
 */
export interface PumpFunCandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch candlestick data from pump.fun API
 * GET /candlesticks/{mint}
 * 
 * @param mint - Token mint address
 * @param timeframe - Timeframe in seconds (default 60 = 1 minute)
 * @param limit - Number of candles to fetch
 * @param offset - Offset for pagination
 */
export async function fetchPumpFunCandles(
  mint: string,
  timeframe: number = 60,
  limit: number = 100,
  offset: number = 0
): Promise<PumpFunCandleData[]> {
  try {
    const params = new URLSearchParams({
      timeframe: timeframe.toString(),
      limit: limit.toString(),
      offset: offset.toString(),
    });
    
    const response = await fetch(`${PUMPFUN_API_URL}/candlesticks/${mint}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Pump.fun candles API returned ${response.status}`);
      return [];
    }
    
    const data = await response.json() as PumpFunCandle[];
    
    if (!Array.isArray(data)) {
      return [];
    }
    
    // Get SOL price for USD conversion
    const solPrice = await fetchSolPriceFromPumpFun();
    
    return data.map(c => ({
      timestamp: c.timestamp * 1000, // Convert to milliseconds
      open: c.open * solPrice,
      high: c.high * solPrice,
      low: c.low * solPrice,
      close: c.close * solPrice,
      volume: c.volume * solPrice, // Convert SOL volume to USD
    }));
    
  } catch (error) {
    logger.debug(`Pump.fun candles fetch failed: ${error}`);
    return [];
  }
}

/**
 * Fetch recent trades from pump.fun API
 * GET /trades/all/{mint}
 */
export async function fetchPumpFunRecentTrades(
  mint: string,
  limit: number = 100,
  offset: number = 0
): Promise<{
  signature: string;
  timestamp: number;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
}[]> {
  try {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      minimumSize: '0',
    });
    
    const response = await fetch(`${PUMPFUN_API_URL}/trades/all/${mint}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Pump.fun trades API returned ${response.status}`);
      return [];
    }
    
    const data = await response.json() as any[];
    
    if (!Array.isArray(data)) {
      return [];
    }
    
    return data.map(t => ({
      signature: t.signature || '',
      timestamp: (t.timestamp || t.blockTime || 0) * 1000,
      isBuy: t.is_buy || t.isBuy || t.txType === 'buy',
      solAmount: (t.sol_amount || t.solAmount || 0) / LAMPORTS_PER_SOL,
      tokenAmount: (t.token_amount || t.tokenAmount || 0) / 1e6,
    }));
    
  } catch (error) {
    logger.debug(`Pump.fun trades fetch failed: ${error}`);
    return [];
  }
}

/**
 * Fetch pump.fun holder distribution by analyzing trade history
 * Returns estimated holder balances based on buy/sell activity
 */
export async function fetchPumpFunHolders(
  mint: string,
  limit: number = 200
): Promise<{ address: string; balance: number; percent: number }[]> {
  try {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: '0',
      minimumSize: '0',
    });
    
    const response = await fetch(`${PUMPFUN_API_URL}/trades/all/${mint}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (!response.ok) {
      logger.debug(`Pump.fun trades API returned ${response.status}`);
      return [];
    }
    
    const trades = await response.json() as any[];
    
    if (!Array.isArray(trades) || trades.length === 0) {
      return [];
    }
    
    // Build holder map from trades
    const holderMap = new Map<string, number>();
    
    for (const trade of trades) {
      const user = trade.user || trade.traderPublicKey || trade.trader;
      if (!user) continue;
      
      const tokenAmount = (trade.token_amount || trade.tokenAmount || 0) / 1e6;
      const isBuy = trade.is_buy || trade.isBuy || trade.txType === 'buy';
      
      const currentBalance = holderMap.get(user) || 0;
      
      if (isBuy) {
        holderMap.set(user, currentBalance + tokenAmount);
      } else {
        holderMap.set(user, Math.max(0, currentBalance - tokenAmount));
      }
    }
    
    // Convert to array and calculate percentages
    const totalSupply = 1_000_000_000; // Pump.fun tokens have 1B supply
    const holders = [...holderMap.entries()]
      .filter(([_, balance]) => balance > 0)
      .map(([address, balance]) => ({
        address,
        balance,
        percent: (balance / totalSupply) * 100,
      }))
      .sort((a, b) => b.balance - a.balance);
    
    logger.debug(`Pump.fun holders derived from trades: ${holders.length} holders`);
    return holders;
    
  } catch (error) {
    logger.debug(`Pump.fun holder analysis failed: ${error}`);
    return [];
  }
}

/**
 * Calculate recent volume from pump.fun trades
 */
export async function fetchPumpFunRecentVolume(
  mint: string,
  minutes: number = 5
): Promise<{ volumeSol: number; volumeUsd: number; tradeCount: number }> {
  const trades = await fetchPumpFunRecentTrades(mint, 200);
  const solPrice = await fetchSolPriceFromPumpFun();
  
  const cutoffTime = Date.now() - (minutes * 60 * 1000);
  const recentTrades = trades.filter(t => t.timestamp >= cutoffTime);
  
  const volumeSol = recentTrades.reduce((sum, t) => sum + t.solAmount, 0);
  
  return {
    volumeSol,
    volumeUsd: volumeSol * solPrice,
    tradeCount: recentTrades.length,
  };
}
