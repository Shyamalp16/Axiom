/**
 * DATA PROVIDERS API
 * Integrates with Helius, Birdeye, and other data sources
 */

import { ENV, API_RETRY_ATTEMPTS, API_RETRY_DELAY_MS } from '../config/index.js';
import { withRetry, sleep } from '../utils/solana.js';
import logger from '../utils/logger.js';
import type { 
  TokenInfo, 
  Candle, 
  MarketData,
  BirdeyeTokenOverview,
  HolderInfo 
} from '../types/index.js';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const HELIUS_BASE = 'https://api.helius.xyz/v0';

/**
 * Fetch token metadata and basic info
 * For pump.fun tokens, uses pump.fun API first (more reliable)
 */
export async function fetchTokenInfo(mintAddress: string): Promise<TokenInfo> {
  // For pump.fun tokens, try pump.fun API first (no rate limits!)
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  
  if (looksLikePumpFun) {
    try {
      const { fetchTokenViaPumpPortal } = await import('./pump-portal.js');
      const pumpToken = await fetchTokenViaPumpPortal(mintAddress);
      
      if (pumpToken) {
        logger.debug(`Using pump.fun API for token info: ${pumpToken.symbol}`);
        return {
          mint: mintAddress,
          symbol: pumpToken.symbol,
          name: pumpToken.name,
          decimals: 6, // Pump.fun tokens use 6 decimals
          supply: pumpToken.virtualTokenReserves * 1e6 || 1e9,
          createdAt: new Date(pumpToken.createdTimestamp),
          ageMinutes: pumpToken.ageMinutes,
        };
      }
    } catch (error) {
      logger.debug(`Pump.fun API failed, falling back to Birdeye/Helius`);
    }
  }
  
  // Try Birdeye
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const data = await birdeyeRequest<BirdeyeTokenOverview>(
        `/defi/token_overview?address=${mintAddress}`
      );
      
      // Calculate age
      const createdAt = await fetchTokenCreationTime(mintAddress);
      const ageMinutes = (Date.now() - createdAt.getTime()) / 1000 / 60;
      
      return {
        mint: mintAddress,
        symbol: data.symbol || 'UNKNOWN',
        name: data.name || 'Unknown Token',
        decimals: data.decimals || 9,
        supply: data.supply || 0,
        createdAt,
        ageMinutes,
      };
    } catch (error) {
      logger.warn('Birdeye token info failed, trying Helius');
    }
  }
  
  // Fallback to Helius
  if (ENV.HELIUS_API_KEY) {
    try {
      const response = await heliusRequest<any>(
        `/token-metadata?api-key=${ENV.HELIUS_API_KEY}`,
        {
          method: 'POST',
          body: JSON.stringify({ mintAccounts: [mintAddress] }),
        }
      );
      
      const token = response[0];
      const createdAt = await fetchTokenCreationTime(mintAddress);
      const ageMinutes = (Date.now() - createdAt.getTime()) / 1000 / 60;
      
      return {
        mint: mintAddress,
        symbol: token?.onChainMetadata?.metadata?.symbol || 'UNKNOWN',
        name: token?.onChainMetadata?.metadata?.name || 'Unknown Token',
        decimals: 9,
        supply: 0,
        createdAt,
        ageMinutes,
      };
    } catch (error) {
      logger.warn('Helius token info also failed');
    }
  }
  
  // Last resort: return minimal info with unknown age
  logger.warn(`Could not fetch token info for ${mintAddress.slice(0, 8)}...`);
  return {
    mint: mintAddress,
    symbol: 'UNKNOWN',
    name: 'Unknown Token',
    decimals: 9,
    supply: 0,
    createdAt: new Date(),
    ageMinutes: 0,
  };
}

/**
 * Fetch token creation time from first transaction
 */
export async function fetchTokenCreationTime(mintAddress: string): Promise<Date> {
  if (ENV.HELIUS_API_KEY) {
    try {
      // Get earliest transaction for the mint
      const response = await fetch(
        `${HELIUS_BASE}/addresses/${mintAddress}/transactions?api-key=${ENV.HELIUS_API_KEY}&limit=1&order=asc`
      );
      
      if (response.ok) {
        const txns = await response.json() as { timestamp?: number }[];
        if (txns.length > 0 && txns[0].timestamp) {
          return new Date(txns[0].timestamp * 1000);
        }
      }
    } catch {
      // Fall through to default
    }
  }
  
  // Default to now if we can't determine
  return new Date();
}

/**
 * Fetch token holders
 */
export async function fetchTokenHolders(
  mintAddress: string
): Promise<{ address: string; balance: number; percent: number }[]> {
  // Pump.fun tokens don't have a reliable public holder endpoint
  // Skip Birdeye to avoid rate limits and return empty for now
  if (mintAddress.toLowerCase().endsWith('pump')) {
    logger.warn('Pump.fun holders unavailable - skipping Birdeye holder fetch');
    return [];
  }
  
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const data = await birdeyeRequest<{ items: any[] }>(
        `/defi/v2/tokens/${mintAddress}/holders?limit=50`
      );
      
      const totalSupply = data.items.reduce((sum, h) => sum + (h.amount || 0), 0);
      
      return data.items.map(h => ({
        address: h.owner || h.address,
        balance: h.amount || h.balance || 0,
        percent: totalSupply > 0 ? ((h.amount || h.balance || 0) / totalSupply) * 100 : 0,
      }));
    } catch (error) {
      logger.warn('Birdeye holders fetch failed');
    }
  }
  
  // Return empty if no data available
  return [];
}

/**
 * Fetch LP information
 */
export async function fetchLPInfo(mintAddress: string): Promise<{
  platform: 'raydium' | 'orca' | 'unknown';
  solAmount: number;
  lpAddresses: string[];
}> {
  if (ENV.BIRDEYE_API_KEY) {
    try {
      // Get markets/pools for the token
      const data = await birdeyeRequest<{ data: any[] }>(
        `/defi/v2/markets?address=${mintAddress}&sort_by=liquidity&sort_type=desc`
      );
      
      if (data.data && data.data.length > 0) {
        const topPool = data.data[0];
        
        let platform: 'raydium' | 'orca' | 'unknown' = 'unknown';
        const source = (topPool.source || '').toLowerCase();
        
        if (source.includes('raydium')) {
          platform = 'raydium';
        } else if (source.includes('orca')) {
          platform = 'orca';
        }
        
        return {
          platform,
          solAmount: topPool.liquidity || 0,
          lpAddresses: [topPool.address].filter(Boolean),
        };
      }
    } catch (error) {
      logger.warn('Birdeye LP info fetch failed');
    }
  }
  
  return {
    platform: 'unknown',
    solAmount: 0,
    lpAddresses: [],
  };
}

/**
 * Fetch market data including price, volume, and candles
 */
export async function fetchMarketData(
  mintAddress: string,
  candleTimeframeSec: number = 15
): Promise<MarketData> {
  const candles = await fetchCandles(mintAddress, candleTimeframeSec);
  
  let priceUsd = 0;
  let priceSol = 0;
  let volume24h = 0;
  let volumeRecent = 0;
  let marketCap = 0;
  let liquidity = 0;
  let priceChange = { m5: 0, h1: 0, h6: 0, h24: 0 };
  
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const data = await birdeyeRequest<BirdeyeTokenOverview>(
        `/defi/token_overview?address=${mintAddress}`
      );
      
      priceUsd = data.price || 0;
      volume24h = data.volume24h || 0;
      marketCap = data.mc || 0;
      liquidity = data.liquidity || 0;
      priceChange.h24 = data.priceChange24h || 0;
      
      // Get SOL price to calculate priceSol
      const solPrice = await fetchSolPrice();
      priceSol = solPrice > 0 ? priceUsd / solPrice : 0;
      
      // Fetch recent volume (last 5 minutes)
      volumeRecent = await fetchRecentVolume(mintAddress, 5);
      
      // Fetch price changes
      const changes = await fetchPriceChanges(mintAddress);
      priceChange = { ...priceChange, ...changes };
      
    } catch (error) {
      logger.warn('Market data fetch failed');
    }
  }
  
  return {
    mint: mintAddress,
    priceUsd,
    priceSol,
    volume24h,
    volumeRecent,
    marketCap,
    liquidity,
    priceChange,
    candles,
  };
}

/**
 * Fetch OHLCV candles
 * For pump.fun tokens, uses pump.fun API (no rate limits)
 * Falls back to Birdeye for other tokens
 */
export async function fetchCandles(
  mintAddress: string,
  timeframeSec: number = 15,
  limit: number = 100
): Promise<Candle[]> {
  // For pump.fun tokens, use pump.fun API first (no rate limits!)
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  
  if (looksLikePumpFun) {
    try {
      const { fetchPumpFunCandles } = await import('./pump-portal.js');
      // Pump.fun API uses seconds for timeframe (minimum 60s = 1 minute)
      const timeframe = Math.max(60, timeframeSec);
      const candles = await fetchPumpFunCandles(mintAddress, timeframe, limit);
      
      if (candles.length > 0) {
        logger.debug(`Using pump.fun API for candles: ${candles.length} candles`);
        return candles.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          buyVolume: c.volume * 0.5, // Estimate
          sellVolume: c.volume * 0.5,
        }));
      }
      
      // For pump.fun tokens, don't fall back to Birdeye (avoids rate limits)
      logger.warn('Pump.fun candles unavailable - skipping Birdeye fallback for pump.fun token');
      return [];
    } catch (error) {
      logger.warn('Pump.fun candles fetch failed - skipping Birdeye fallback for pump.fun token');
      return [];
    }
  }
  
  // Fallback to Birdeye
  if (ENV.BIRDEYE_API_KEY) {
    try {
      // Birdeye uses minute-based timeframes, convert
      const timeframeMin = Math.max(1, Math.floor(timeframeSec / 60));
      const timeType = timeframeSec < 60 ? '15s' : `${timeframeMin}m`;
      
      const now = Math.floor(Date.now() / 1000);
      const from = now - (limit * timeframeSec);
      
      const data = await birdeyeRequest<{ items: any[] }>(
        `/defi/ohlcv?address=${mintAddress}&type=${timeType}&time_from=${from}&time_to=${now}`
      );
      
      if (data.items) {
        return data.items.map(c => ({
          timestamp: c.unixTime * 1000,
          open: c.o || c.open || 0,
          high: c.h || c.high || 0,
          low: c.l || c.low || 0,
          close: c.c || c.close || 0,
          volume: c.v || c.volume || 0,
          buyVolume: (c.v || c.volume || 0) * 0.5, // Estimate
          sellVolume: (c.v || c.volume || 0) * 0.5,
        }));
      }
    } catch (error) {
      logger.warn('Candle fetch failed');
    }
  }
  
  return [];
}

/**
 * Fetch recent trading volume
 * For pump.fun tokens, uses pump.fun trades API
 */
export async function fetchRecentVolume(
  mintAddress: string,
  minutes: number
): Promise<number> {
  // For pump.fun tokens, use pump.fun API
  const looksLikePumpFun = mintAddress.toLowerCase().endsWith('pump');
  
  if (looksLikePumpFun) {
    try {
      const { fetchPumpFunRecentVolume } = await import('./pump-portal.js');
      const volume = await fetchPumpFunRecentVolume(mintAddress, minutes);
      
      if (volume.volumeSol > 0) {
        logger.debug(`Pump.fun volume (${minutes}min): ${volume.volumeSol.toFixed(2)} SOL (${volume.tradeCount} trades)`);
        return volume.volumeSol;
      }
      
      logger.warn('Pump.fun volume unavailable - skipping Birdeye fallback for pump.fun token');
      return 0;
    } catch (error) {
      logger.warn('Pump.fun volume fetch failed - skipping Birdeye fallback for pump.fun token');
      return 0;
    }
  }
  
  // Fallback to Birdeye
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - (minutes * 60);
      
      const data = await birdeyeRequest<{ items: any[] }>(
        `/defi/ohlcv?address=${mintAddress}&type=1m&time_from=${from}&time_to=${now}`
      );
      
      if (data.items) {
        return data.items.reduce((sum, c) => sum + (c.v || c.volume || 0), 0);
      }
    } catch {
      // Fall through
    }
  }
  
  return 0;
}

/**
 * Fetch price changes over different timeframes
 */
export async function fetchPriceChanges(mintAddress: string): Promise<{
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}> {
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const data = await birdeyeRequest<any>(
        `/defi/price_change?address=${mintAddress}`
      );
      
      return {
        m5: data.priceChange5m || 0,
        h1: data.priceChange1h || 0,
        h6: data.priceChange6h || 0,
        h24: data.priceChange24h || 0,
      };
    } catch {
      // Fall through
    }
  }
  
  return { m5: 0, h1: 0, h6: 0, h24: 0 };
}

/**
 * Fetch current SOL price in USD
 */
export async function fetchSolPrice(): Promise<number> {
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const data = await birdeyeRequest<{ value: number }>(
        `/defi/price?address=${SOL_MINT}`
      );
      return data.value || 0;
    } catch {
      // Fall through
    }
  }
  
  // Fallback: try Jupiter price API
  try {
    const response = await fetch(
      'https://price.jup.ag/v4/price?ids=SOL'
    );
    const data = await response.json() as { data?: { SOL?: { price?: number } } };
    return data.data?.SOL?.price || 0;
  } catch {
    return 0;
  }
}

/**
 * Watch for dev wallet transactions
 */
export async function watchWalletTransactions(
  walletAddress: string,
  callback: (tx: any) => void
): Promise<() => void> {
  // This would set up a websocket subscription
  // For now, return a no-op cleanup function
  
  // TODO: Implement via Helius websocket or polling
  return () => {};
}

// ============================================
// INTERNAL HELPERS
// ============================================

async function birdeyeRequest<T>(endpoint: string): Promise<T> {
  return withRetry(async () => {
    const response = await fetch(`${BIRDEYE_BASE}${endpoint}`, {
      headers: {
        'X-API-KEY': ENV.BIRDEYE_API_KEY,
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Birdeye API error: ${response.status}`);
    }
    
    const json = await response.json() as { data?: T } | T;
    return (json as { data?: T }).data || (json as T);
  }, API_RETRY_ATTEMPTS, API_RETRY_DELAY_MS);
}

async function heliusRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  return withRetry(async () => {
    const response = await fetch(`${HELIUS_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }
    
    return response.json() as Promise<T>;
  }, API_RETRY_ATTEMPTS, API_RETRY_DELAY_MS);
}
