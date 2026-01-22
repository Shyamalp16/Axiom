/**
 * AXIOM TRADE API INTEGRATION
 * 
 * DEX aggregator for Solana trading with real-time WebSocket data
 * Reverse-engineered from: https://vibheksoni.github.io/axiomtrade-rs/
 * 
 * Features:
 * - Token swaps via DEX aggregation (best prices across Raydium, Orca, etc.)
 * - Real-time price streaming via WebSocket
 * - Portfolio tracking
 * - Transaction simulation before execution
 * 
 * Authentication:
 * - Requires auth tokens from axiom.trade (extract from browser cookies)
 * - Access token expires ~15 min, refresh token valid ~30 days
 * - Auto-refresh implemented
 */

import WebSocket from 'ws';
import logger from '../utils/logger.js';

// ============================================
// API ENDPOINTS
// ============================================

// REST API servers (load balanced)
const AXIOM_API_SERVERS = [
  'https://api8.axiom.trade',  // Primary - confirmed working
  'https://api2.axiom.trade',
  'https://api3.axiom.trade',
  'https://api6.axiom.trade',
  'https://api7.axiom.trade',
  'https://api9.axiom.trade',
  'https://api10.axiom.trade',
];

// Primary API server (confirmed working for market data)
const AXIOM_PRIMARY_API = 'https://api8.axiom.trade';

// Main domain for portfolio endpoints
const AXIOM_MAIN_API = 'https://axiom.trade/api';

// WebSocket clusters by region
const AXIOM_WS_CLUSTERS = {
  'us-west': 'wss://socket8.axiom.trade',
  'us-central': 'wss://cluster3.axiom.trade',
  'us-east': 'wss://cluster5.axiom.trade',
  'eu-west': 'wss://cluster6.axiom.trade',
  'eu-central': 'wss://cluster2.axiom.trade',
  'eu-east': 'wss://cluster8.axiom.trade',
  'asia': 'wss://cluster4.axiom.trade',
  'australia': 'wss://cluster7.axiom.trade',
  'global': 'wss://cluster9.axiom.trade',
};

// Default region
const DEFAULT_WS_REGION = 'global';

// Native SOL mint address
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================
// TYPES
// ============================================

export interface AxiomTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  price?: number;
  priceChange24h?: number;
  volume24h?: number;
  marketCap?: number;
}

export interface AxiomQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  fee: number;
  route: AxiomRouteStep[];
  estimatedGas: number;
  expiresAt: number;
}

export interface AxiomRouteStep {
  dex: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  poolAddress: string;
}

export interface AxiomSwapParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippagePercent: number;
  priorityFee?: number;
  userPublicKey: string;
}

export interface AxiomSwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  error?: string;
}

export interface AxiomSimulationResult {
  success: boolean;
  estimatedGas: number;
  error?: string;
  logs?: string[];
}

export interface AxiomPortfolio {
  walletAddress: string;
  solBalance: number;
  totalValueUsd: number;
  tokens: AxiomPortfolioToken[];
}

export interface AxiomPortfolioToken {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  valueUsd: number;
  price: number;
  priceChange24h?: number;
}

export interface AxiomWalletBalance {
  sol: number;
  tokens: Map<string, number>;
  totalValueUsd: number;
}

// WebSocket message types
export interface AxiomWSMessage {
  type: string;
  data: unknown;
}

export interface AxiomPriceUpdate {
  mint: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  timestamp: number;
}

export interface AxiomNewPair {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  initialLiquidity: number;
  timestamp: number;
}

// ============================================
// AUTH TOKEN MANAGEMENT
// ============================================

let accessToken: string | null = null;
let refreshToken: string | null = null;
let tokenExpiresAt: number = 0;

// Token refresh buffer (refresh 2 min before expiry)
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

/**
 * Initialize Axiom Trade client with auth tokens
 * Get these from browser cookies after logging into axiom.trade
 */
export function initAxiomAuth(access: string, refresh: string): void {
  accessToken = access;
  refreshToken = refresh;
  
  // Parse JWT to get expiry (access tokens expire in ~15 min)
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64').toString());
    tokenExpiresAt = payload.exp * 1000; // Convert to milliseconds
    logger.success('Axiom Trade auth initialized');
    logger.info(`  Token expires: ${new Date(tokenExpiresAt).toLocaleTimeString()}`);
  } catch {
    // If we can't parse, assume 15 min from now
    tokenExpiresAt = Date.now() + 15 * 60 * 1000;
    logger.warn('Could not parse token expiry, assuming 15 min');
  }
}

/**
 * Load auth tokens from environment variables
 */
export function loadAxiomAuthFromEnv(): boolean {
  const access = process.env.AXIOM_ACCESS_TOKEN;
  const refresh = process.env.AXIOM_REFRESH_TOKEN;
  
  if (!access || !refresh) {
    logger.warn('Axiom Trade tokens not found in environment');
    logger.info('  Set AXIOM_ACCESS_TOKEN and AXIOM_REFRESH_TOKEN in .env');
    return false;
  }
  
  initAxiomAuth(access, refresh);
  return true;
}

/**
 * Check if tokens are configured
 */
export function isAxiomAuthenticated(): boolean {
  return accessToken !== null && refreshToken !== null;
}

/**
 * Get current access token, refreshing if needed
 */
async function getAccessToken(): Promise<string> {
  if (!accessToken || !refreshToken) {
    throw new Error('Axiom Trade not authenticated. Call initAxiomAuth() first.');
  }
  
  // Check if token needs refresh
  if (Date.now() > tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    await refreshAccessToken();
  }
  
  return accessToken;
}

/**
 * Refresh the access token using refresh token
 * Includes retry logic with exponential backoff for transient errors
 */
async function refreshAccessToken(): Promise<void> {
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }
  
  const maxRetries = 3;
  const transientErrors = [502, 503, 504, 429];
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Try a different server on each retry
    const server = AXIOM_API_SERVERS[(currentServerIndex + attempt) % AXIOM_API_SERVERS.length];
    
    try {
      const response = await fetch(`${server}/refresh-access-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `auth-refresh-token=${refreshToken}`,
          'Origin': 'https://axiom.trade',
        },
      });
      
      if (!response.ok) {
        // Check if this is a transient error worth retrying
        if (transientErrors.includes(response.status) && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          logger.warn(`Token refresh got ${response.status} from ${server}, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Token refresh failed: ${response.status}`);
      }
      
      const data = await response.json() as { access_token: string };
      accessToken = data.access_token;
      
      // Parse new expiry
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
        tokenExpiresAt = payload.exp * 1000;
      } catch {
        tokenExpiresAt = Date.now() + 15 * 60 * 1000;
      }
      
      logger.debug(`Axiom access token refreshed via ${server}`);
      return; // Success!
      
    } catch (error) {
      lastError = error as Error;
      
      // Only retry on network errors, not on auth failures
      if (attempt < maxRetries - 1 && !(error instanceof Error && error.message.includes('Token refresh failed: 4'))) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`Token refresh error from ${server}, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }
  
  logger.error('Failed to refresh Axiom token after all retries:', lastError);
  throw lastError || new Error('Token refresh failed after all retries');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

let currentServerIndex = 0;

/**
 * Get a random API server for load balancing
 */
function getRandomApiServer(): string {
  currentServerIndex = (currentServerIndex + 1) % AXIOM_API_SERVERS.length;
  return AXIOM_API_SERVERS[currentServerIndex];
}

/**
 * Make authenticated API request
 */
async function axiomFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  useMainDomain: boolean = false
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = useMainDomain ? AXIOM_MAIN_API : getRandomApiServer();
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cookie': `auth-access-token=${token}`,
    'Origin': 'https://axiom.trade',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...(options.headers as Record<string, string> || {}),
  };
  
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers,
  });
  
  if (response.status === 401) {
    // Token might have expired, try refresh
    await refreshAccessToken();
    const newToken = await getAccessToken();
    headers['Cookie'] = `auth-access-token=${newToken}`;
    
    const retryResponse = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers,
    });
    
    if (!retryResponse.ok) {
      throw new Error(`Axiom API error: ${retryResponse.status}`);
    }
    
    return retryResponse.json() as Promise<T>;
  }
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Axiom API error ${response.status}: ${errorText}`);
  }
  
  return response.json() as Promise<T>;
}

// ============================================
// MARKET DATA FUNCTIONS (CONFIRMED WORKING)
// ============================================

export interface AxiomTrendingToken {
  pairAddress: string;
  tokenAddress: string;
  tokenName: string;
  tokenTicker: string;
  tokenImage?: string;
  tokenDecimals: number;
  protocol: string;
  protocolDetails?: {
    creator: string;
    isMayhem: boolean;
    isOffchain: boolean;
    isTokenSideX: boolean;
    tokenProgram: string;
    pairSolAccount: string;
    pairTokenAccount: string;
  };
  prevMarketCapSol: number;
  marketCapSol: number;
  marketCapPercentChange: number;
  liquiditySol: number;
  liquidityToken: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  top10Holders: number;
  lpBurned: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  dexPaid: boolean;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  createdAt: string;
  supply: number;
  userCount: number;
  extra?: {
    migratedFrom?: string;
    pumpDeployerAddress?: string;
  };
}

/**
 * Get trending meme tokens
 * @param timePeriod - '1h', '24h', '7d', or '30d' (confirmed working)
 * Note: '1m' return 500 error - not supported by API
 */
export async function getAxiomTrending(
  timePeriod: '1m' | '5m' | '1h' | '24h' | '7d' | '30d' = '1h'
): Promise<AxiomTrendingToken[]> {
  const token = await getAccessToken();
  
  const response = await fetch(`${AXIOM_PRIMARY_API}/meme-trending?timePeriod=${timePeriod}`, {
    headers: {
      'Cookie': `auth-access-token=${token}`,
      'Origin': 'https://axiom.trade',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Note: Only 1h, 24h, 7d, 30d are confirmed working. 1m/5m may return 500.
    throw new Error(`Axiom trending API error: ${response.status} (timePeriod=${timePeriod}) ${errorText.slice(0, 100)}`);
  }
  
  return response.json() as Promise<AxiomTrendingToken[]>;
}

/**
 * Get token chart data
 * @param tokenMint - Token mint address
 * @param timeframe - Candle timeframe
 */
export async function getAxiomChart(
  tokenMint: string,
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '5m'
): Promise<unknown> {
  const token = await getAccessToken();
  
  const response = await fetch(`${AXIOM_PRIMARY_API}/chart/${tokenMint}?timeframe=${timeframe}`, {
    headers: {
      'Cookie': `auth-access-token=${token}`,
      'Origin': 'https://axiom.trade',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Axiom chart API error: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Get token data by pair address
 * This queries the same data source as the Axiom UI
 */
export async function getAxiomTokenByPair(
  pairAddress: string
): Promise<AxiomTrendingToken | null> {
  try {
    const token = await getAccessToken();
    
    // Try pair-specific endpoint
    const response = await fetch(`${AXIOM_PRIMARY_API}/pair/${pairAddress}`, {
      headers: {
        'Cookie': `auth-access-token=${token}`,
        'Origin': 'https://axiom.trade',
      },
    });
    
    if (response.ok) {
      return await response.json() as AxiomTrendingToken;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Get token data by mint address (searches trending data)
 * Returns the token's live market data from Axiom
 */
export async function getAxiomTokenByMint(
  mint: string,
  timePeriod: '5m' | '1h' | '24h' = '5m'
): Promise<AxiomTrendingToken | null> {
  try {
    const trending = await getAxiomTrending(timePeriod);
    return trending.find(t => t.tokenAddress === mint) || null;
  } catch {
    return null;
  }
}

/**
 * Get real-time token price from Axiom chart API
 * Uses pair address for chart data (more reliable than mint)
 * Tries 1s candles first for most granular data, falls back to 1m
 */
export async function getAxiomLivePrice(
  pairAddress: string
): Promise<{ priceSol: number; mcUsd: number } | null> {
  if (!pairAddress) {
    logger.debug('Axiom chart: no pair address provided');
    return null;
  }
  
  try {
    const token = await getAccessToken();
    logger.debug(`Axiom chart: fetching for pair ${pairAddress.slice(0, 8)}...`);
    
    // Try 1-minute candles (1s may not be supported)
    let response = await fetch(`${AXIOM_PRIMARY_API}/chart/${pairAddress}?timeframe=1m`, {
      headers: {
        'Cookie': `auth-access-token=${token}`,
        'Origin': 'https://axiom.trade',
      },
    });
    
    // Also try with /pair/ prefix if direct fails
    if (!response.ok) {
      logger.debug(`Axiom chart: direct failed (${response.status}), trying /pair/...`);
      response = await fetch(`${AXIOM_PRIMARY_API}/pair/${pairAddress}/chart?timeframe=1m`, {
        headers: {
          'Cookie': `auth-access-token=${token}`,
          'Origin': 'https://axiom.trade',
        },
      });
    }
    
    if (!response.ok) {
      logger.debug(`Axiom chart: all attempts failed (${response.status})`);
      return null;
    }
    
    const data = await response.json() as any;
    
    // Log raw data structure for debugging
    logger.debug(`Axiom chart response: ${JSON.stringify(data).slice(0, 300)}...`);
    
    // Chart data is typically an array of candles [time, open, high, low, close, volume]
    // Get the most recent candle's close price
    if (Array.isArray(data) && data.length > 0) {
      const lastCandle = data[data.length - 1];
      // Format: [timestamp, open, high, low, close, volume] or similar
      if (Array.isArray(lastCandle) && lastCandle.length >= 5) {
        const closePriceSol = lastCandle[4]; // Close price
        logger.debug(`Axiom chart: ${data.length} candles, last close=${closePriceSol}`);
        return { priceSol: closePriceSol, mcUsd: 0 };
      }
      // Alternative format: { time, open, high, low, close, volume }
      if (lastCandle.close !== undefined) {
        logger.debug(`Axiom chart: ${data.length} candles, last close=${lastCandle.close}`);
        return { priceSol: lastCandle.close, mcUsd: 0 };
      }
    }
    
    logger.debug(`Axiom chart: unexpected format`);
    return null;
  } catch {
    return null;
  }
}

/**
 * Get batch token prices
 * @param mints - Array of token mint addresses
 */
export async function getAxiomBatchPrices(
  mints: string[]
): Promise<Record<string, { price: number; change24h: number }>> {
  const token = await getAccessToken();
  
  const response = await fetch(`${AXIOM_PRIMARY_API}/batch-prices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `auth-access-token=${token}`,
      'Origin': 'https://axiom.trade',
    },
    body: JSON.stringify({ mints }),
  });
  
  if (!response.ok) {
    throw new Error(`Axiom batch prices API error: ${response.status}`);
  }
  
  return response.json() as Promise<Record<string, { price: number; change24h: number }>>;
}

// ============================================
// TRADING FUNCTIONS (MAY REQUIRE TURNKEY WALLET)
// Note: These endpoints may not work without Turnkey hardware wallet setup
// ============================================

/**
 * Get a swap quote
 * WARNING: This endpoint may require Turnkey wallet integration
 */
export async function getAxiomQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippagePercent: number = 1
): Promise<AxiomQuote> {
  const response = await axiomFetch<AxiomQuote>('/quote', {
    method: 'POST',
    body: JSON.stringify({
      input_mint: inputMint,
      output_mint: outputMint,
      amount: amount.toString(),
      slippage_percent: slippagePercent,
    }),
  });
  
  return response;
}

/**
 * Get quote for buying a token with SOL
 */
export async function getAxiomBuyQuote(
  tokenMint: string,
  solAmount: number,
  slippagePercent: number = 1
): Promise<AxiomQuote> {
  return getAxiomQuote(NATIVE_SOL_MINT, tokenMint, solAmount, slippagePercent);
}

/**
 * Get quote for selling a token for SOL
 */
export async function getAxiomSellQuote(
  tokenMint: string,
  tokenAmount: number,
  slippagePercent: number = 1
): Promise<AxiomQuote> {
  return getAxiomQuote(tokenMint, NATIVE_SOL_MINT, tokenAmount, slippagePercent);
}

/**
 * Simulate a transaction before executing
 */
export async function simulateAxiomSwap(
  params: AxiomSwapParams
): Promise<AxiomSimulationResult> {
  const response = await axiomFetch<AxiomSimulationResult>('/simulate', {
    method: 'POST',
    body: JSON.stringify({
      input_mint: params.inputMint,
      output_mint: params.outputMint,
      amount: params.amount.toString(),
      slippage_percent: params.slippagePercent,
      priority_fee: params.priorityFee || 0,
      user_public_key: params.userPublicKey,
    }),
  });
  
  return response;
}

/**
 * Execute a swap transaction
 */
export async function executeAxiomSwap(
  params: AxiomSwapParams
): Promise<AxiomSwapResult> {
  const response = await axiomFetch<AxiomSwapResult>('/batched-send-tx-v2', {
    method: 'POST',
    body: JSON.stringify({
      input_mint: params.inputMint,
      output_mint: params.outputMint,
      amount: params.amount.toString(),
      slippage_percent: params.slippagePercent,
      priority_fee: params.priorityFee || 0,
      user_public_key: params.userPublicKey,
    }),
  });
  
  return response;
}

/**
 * Buy a token with SOL
 */
export async function axiomBuy(
  tokenMint: string,
  solAmount: number,
  userPublicKey: string,
  slippagePercent: number = 1,
  priorityFee?: number
): Promise<AxiomSwapResult> {
  return executeAxiomSwap({
    inputMint: NATIVE_SOL_MINT,
    outputMint: tokenMint,
    amount: solAmount,
    slippagePercent,
    priorityFee,
    userPublicKey,
  });
}

/**
 * Sell a token for SOL
 */
export async function axiomSell(
  tokenMint: string,
  tokenAmount: number,
  userPublicKey: string,
  slippagePercent: number = 1,
  priorityFee?: number
): Promise<AxiomSwapResult> {
  return executeAxiomSwap({
    inputMint: tokenMint,
    outputMint: NATIVE_SOL_MINT,
    amount: tokenAmount,
    slippagePercent,
    priorityFee,
    userPublicKey,
  });
}

/**
 * Get portfolio for a wallet
 */
export async function getAxiomPortfolio(
  walletAddress: string
): Promise<AxiomPortfolio> {
  const response = await axiomFetch<AxiomPortfolio>('/portfolio-v5', {
    method: 'POST',
    body: JSON.stringify({
      wallet_addresses: [walletAddress],
      is_other_wallet: true,
    }),
  }, true); // Use main domain
  
  return response;
}

/**
 * Get SOL and token balances for multiple wallets
 */
export async function getAxiomBatchedBalance(
  walletAddresses: string[]
): Promise<Map<string, AxiomWalletBalance>> {
  const response = await axiomFetch<Record<string, AxiomWalletBalance>>('/batched-sol-balance', {
    method: 'POST',
    body: JSON.stringify({
      public_keys: walletAddresses,
    }),
  }, true); // Use main domain
  
  return new Map(Object.entries(response));
}

// ============================================
// WEBSOCKET CLIENT
// ============================================

let axiomWs: WebSocket | null = null;
let axiomWsConnected = false;
let axiomWsReconnectAttempts = 0;
const AXIOM_WS_MAX_RECONNECT = 5;

// Event handlers
type PriceUpdateHandler = (update: AxiomPriceUpdate) => void;
type NewPairHandler = (pair: AxiomNewPair) => void;

const priceHandlers: Map<string, PriceUpdateHandler[]> = new Map();
const newPairHandlers: NewPairHandler[] = [];

/**
 * Connect to Axiom Trade WebSocket
 */
export async function connectAxiomWebSocket(
  region: keyof typeof AXIOM_WS_CLUSTERS = DEFAULT_WS_REGION
): Promise<void> {
  if (axiomWsConnected && axiomWs) {
    return;
  }
  
  if (!accessToken || !refreshToken) {
    throw new Error('Axiom Trade not authenticated');
  }
  
  return new Promise((resolve, reject) => {
    const wsUrl = AXIOM_WS_CLUSTERS[region];
    
    try {
      axiomWs = new WebSocket(wsUrl, {
        headers: {
          'Cookie': `auth-access-token=${accessToken}; auth-refresh-token=${refreshToken}`,
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      
      axiomWs.on('open', () => {
        axiomWsConnected = true;
        axiomWsReconnectAttempts = 0;
        logger.success(`Connected to Axiom Trade WebSocket (${region})`);
        resolve();
      });
      
      axiomWs.on('message', (data: WebSocket.Data) => {
        try {
          const rawMsg = data.toString();
          logger.debug(`Axiom WS raw: ${rawMsg.slice(0, 200)}...`);
          const message = JSON.parse(rawMsg) as AxiomWSMessage;
          handleAxiomWSMessage(message);
        } catch (error) {
          logger.debug(`Axiom WS parse error: ${error}`);
        }
      });
      
      axiomWs.on('close', (code, reason) => {
        axiomWsConnected = false;
        logger.warn(`Axiom WebSocket disconnected: ${code} - ${reason}`);
        attemptAxiomReconnect(region);
      });
      
      axiomWs.on('error', (error) => {
        logger.error('Axiom WebSocket error:', error);
        if (!axiomWsConnected) {
          reject(error);
        }
      });
      
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Attempt to reconnect WebSocket
 */
function attemptAxiomReconnect(region: keyof typeof AXIOM_WS_CLUSTERS): void {
  if (axiomWsReconnectAttempts >= AXIOM_WS_MAX_RECONNECT) {
    logger.error('Max Axiom WebSocket reconnect attempts reached');
    return;
  }
  
  axiomWsReconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, axiomWsReconnectAttempts), 30000);
  
  logger.info(`Axiom WS reconnecting in ${delay / 1000}s (attempt ${axiomWsReconnectAttempts})`);
  
  setTimeout(() => {
    connectAxiomWebSocket(region).catch(err => {
      logger.error('Axiom WS reconnect failed:', err);
    });
  }, delay);
}

/**
 * Handle incoming WebSocket messages
 */
function handleAxiomWSMessage(message: AxiomWSMessage): void {
  switch (message.type) {
    case 'connected':
      logger.debug('Axiom WS connected confirmation received');
      break;
      
    case 'market_update':
    case 'price_update': {
      const update = message.data as AxiomPriceUpdate;
      logger.debug(`Axiom WS price update: ${update.mint?.slice(0, 8)}... price=${update.price} mc=${update.marketCap}`);
      const handlers = priceHandlers.get(update.mint) || [];
      for (const handler of handlers) {
        try {
          handler(update);
        } catch (error) {
          logger.debug(`Price handler error: ${error}`);
        }
      }
      break;
    }
    
    case 'new_pair': {
      const pair = message.data as AxiomNewPair;
      for (const handler of newPairHandlers) {
        try {
          handler(pair);
        } catch (error) {
          logger.debug(`New pair handler error: ${error}`);
        }
      }
      break;
    }
    
    case 'disconnected':
      logger.warn('Axiom WS received disconnect message');
      break;
      
    default:
      logger.debug(`Unknown Axiom WS message type: ${message.type}`);
  }
}

/**
 * Subscribe to new token pair launches
 */
export function subscribeAxiomNewPairs(handler: NewPairHandler): () => void {
  if (!axiomWs || !axiomWsConnected) {
    throw new Error('Axiom WebSocket not connected');
  }
  
  newPairHandlers.push(handler);
  
  // Send subscription if first handler
  if (newPairHandlers.length === 1) {
    axiomWs.send(JSON.stringify({
      action: 'join',
      room: 'new_pairs',
    }));
    logger.info('Subscribed to Axiom new pairs');
  }
  
  // Return unsubscribe function
  return () => {
    const index = newPairHandlers.indexOf(handler);
    if (index > -1) {
      newPairHandlers.splice(index, 1);
    }
    
    if (newPairHandlers.length === 0 && axiomWs && axiomWsConnected) {
      axiomWs.send(JSON.stringify({
        action: 'leave',
        room: 'new_pairs',
      }));
    }
  };
}

/**
 * Subscribe to price updates for a specific token
 */
export function subscribeAxiomPrice(
  mint: string,
  handler: PriceUpdateHandler
): () => void {
  if (!axiomWs || !axiomWsConnected) {
    throw new Error('Axiom WebSocket not connected');
  }
  
  const handlers = priceHandlers.get(mint) || [];
  handlers.push(handler);
  priceHandlers.set(mint, handlers);
  
  // Send subscription if first handler for this mint
  if (handlers.length === 1) {
    // Try multiple room formats to see which one works
    const roomFormats = [
      mint,                    // Just mint
      `token:${mint}`,         // token:mint
      `pair:${mint}`,          // pair:mint  
    ];
    
    for (const room of roomFormats) {
      axiomWs.send(JSON.stringify({
        action: 'join',
        room,
      }));
      logger.debug(`Axiom WS: joined room '${room.slice(0, 20)}...'`);
    }
  }
  
  // Return unsubscribe function
  return () => {
    const currentHandlers = priceHandlers.get(mint) || [];
    const index = currentHandlers.indexOf(handler);
    if (index > -1) {
      currentHandlers.splice(index, 1);
    }
    
    if (currentHandlers.length === 0) {
      priceHandlers.delete(mint);
      if (axiomWs && axiomWsConnected) {
        axiomWs.send(JSON.stringify({
          action: 'leave',
          room: mint,
        }));
      }
    }
  };
}

/**
 * Disconnect Axiom WebSocket
 */
export function disconnectAxiomWebSocket(): void {
  if (axiomWs) {
    axiomWs.close();
    axiomWs = null;
    axiomWsConnected = false;
    priceHandlers.clear();
    newPairHandlers.length = 0;
    logger.info('Axiom WebSocket disconnected');
  }
}

/**
 * Check if WebSocket is connected
 */
export function isAxiomWSConnected(): boolean {
  return axiomWsConnected;
}

// ============================================
// EXPORTS
// ============================================

export {
  NATIVE_SOL_MINT,
  AXIOM_API_SERVERS,
  AXIOM_WS_CLUSTERS,
};
