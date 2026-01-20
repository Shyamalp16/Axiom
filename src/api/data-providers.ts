/**
 * DATA PROVIDERS API
 * Integrates with Helius, Birdeye, and other data sources
 * 
 * Birdeye API Reference: https://docs.birdeye.so/reference
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
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';

// Rate limiting for Birdeye API (avoid 429 errors)
let lastBirdeyeRequest = 0;
const BIRDEYE_MIN_DELAY_MS = 500; // Minimum 500ms between requests (Birdeye free tier limit)

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
 * Fetch token creation time
 * Uses DexScreener (pair creation time) or Helius transaction history
 */
export async function fetchTokenCreationTime(mintAddress: string): Promise<Date> {
  // Method 1: DexScreener - has pairCreatedAt timestamp
  try {
    const response = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      
      if (pairs.length > 0) {
        // Get the oldest pair creation time
        const creationTimes = pairs
          .map((p: any) => p.pairCreatedAt)
          .filter((t: any) => t)
          .sort((a: number, b: number) => a - b);
        
        if (creationTimes.length > 0) {
          const createdAt = new Date(creationTimes[0]);
          logger.info(`[Age] Token created: ${createdAt.toISOString()} (from DexScreener)`);
          return createdAt;
        }
      }
    }
  } catch (error) {
    logger.debug(`DexScreener creation time failed: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
  
  // Method 2: Birdeye Token Creation Info
  if (ENV.BIRDEYE_API_KEY) {
    try {
      await throttleBirdeye();
      
      const response = await fetch(
        `${BIRDEYE_BASE}/defi/token_creation_info?address=${mintAddress}`,
        {
          headers: {
            'X-API-KEY': ENV.BIRDEYE_API_KEY,
            'x-chain': 'solana',
            'Accept': 'application/json',
          },
        }
      );
      
      if (response.ok) {
        const json = await response.json() as any;
        const data = json?.data || json;
        
        const creationTime = data?.blockUnixTime || data?.txCreationTime || data?.createdTime;
        if (creationTime) {
          const createdAt = new Date(creationTime * 1000);
          logger.info(`[Age] Token created: ${createdAt.toISOString()} (from Birdeye)`);
          return createdAt;
        }
      }
    } catch (error) {
      logger.debug(`Birdeye token_creation_info failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  // Method 3: Helius transaction history
  if (ENV.HELIUS_API_KEY) {
    try {
      const response = await fetch(
        `${HELIUS_BASE}/addresses/${mintAddress}/transactions?api-key=${ENV.HELIUS_API_KEY}&limit=1&order=asc`
      );
      
      if (response.ok) {
        const txns = await response.json() as { timestamp?: number }[];
        if (txns.length > 0 && txns[0].timestamp) {
          const createdAt = new Date(txns[0].timestamp * 1000);
          logger.info(`[Age] Token created: ${createdAt.toISOString()} (from Helius)`);
          return createdAt;
        }
      }
    } catch {
      // Fall through to default
    }
  }
  
  // Default to now if we can't determine (will show 0 min age)
  logger.warn(`[Age] Could not determine creation time for ${mintAddress.slice(0, 8)}...`);
  return new Date();
}

/**
 * Fetch token holders
 * Birdeye endpoint: GET /defi/v3/token/holder
 */
export async function fetchTokenHolders(
  mintAddress: string
): Promise<{ address: string; balance: number; percent: number }[]> {
  // Pump.fun tokens don't have a reliable public holder endpoint
  // Skip Birdeye to avoid rate limits and return empty for now
  if (mintAddress.toLowerCase().endsWith('pump')) {
    logger.debug('Pump.fun holders unavailable - skipping Birdeye holder fetch');
    return [];
  }
  
  if (ENV.BIRDEYE_API_KEY) {
    try {
      // Birdeye v3 holder endpoint: /defi/v3/token/holder
      const data = await birdeyeRequest<{ items: any[] }>(
        `/defi/v3/token/holder?address=${mintAddress}&offset=0&limit=50`
      );
      
      if (!data.items || data.items.length === 0) {
        logger.debug('No holders data returned from Birdeye');
        return [];
      }
      
      const totalSupply = data.items.reduce((sum, h) => sum + (h.amount || h.uiAmount || 0), 0);
      
      return data.items.map(h => ({
        address: h.owner || h.address,
        balance: h.amount || h.uiAmount || 0,
        percent: totalSupply > 0 ? ((h.amount || h.uiAmount || 0) / totalSupply) * 100 : 0,
      }));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.debug(`Birdeye holders fetch failed: ${errMsg}`);
    }
  }
  
  // Return empty if no data available
  return [];
}

/**
 * Fetch LP information
 * Uses DexScreener (free, no rate limits) for DEX detection
 * Falls back to Birdeye for liquidity data
 */
export async function fetchLPInfo(mintAddress: string): Promise<{
  platform: 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm' | 'unknown';
  solAmount: number;
  lpAddresses: string[];
}> {
  let totalLiquidity = 0;
  let detectedPlatform: 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm' | 'unknown' = 'unknown';
  let lpAddresses: string[] = [];
  
  // Method 1: DexScreener API (FREE, no rate limits, includes DEX source)
  // This is the most reliable way to get DEX info
  try {
    const dexScreenerResponse = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    logger.info(`[LP] DexScreener status: ${dexScreenerResponse.status}`);
    
    if (dexScreenerResponse.ok) {
      const dexData = await dexScreenerResponse.json() as any;
      const pairs = dexData?.pairs || [];
      
      logger.info(`[LP] DexScreener pairs found: ${pairs.length}`);
      
      if (pairs.length > 0) {
        // Sort by liquidity and get the best pair
        const sortedPairs = pairs.sort((a: any, b: any) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        );
        const topPair = sortedPairs[0];
        
        // DexScreener uses "dexId" field for the exchange
        const dexId = topPair.dexId || '';
        logger.info(`[LP] DexScreener dexId: "${dexId}", liquidity: $${topPair.liquidity?.usd || 0}`);
        
        // Map DexScreener dexId to our platform names
        detectedPlatform = detectDexPlatformFromDexScreener(dexId);
        
        // DexScreener returns USD liquidity, convert to SOL estimate
        const liquidityUsd = topPair.liquidity?.usd || 0;
        // Get SOL price from the pair if available, or estimate
        const solPriceUsd = topPair.priceNative ? parseFloat(topPair.priceUsd) / parseFloat(topPair.priceNative) : 200;
        totalLiquidity = liquidityUsd / solPriceUsd;
        
        lpAddresses = [topPair.pairAddress].filter(Boolean);
        
        logger.info(`[LP] Detected: ${detectedPlatform}, ~${totalLiquidity.toFixed(2)} SOL liquidity`);
        
        if (detectedPlatform !== 'unknown' && totalLiquidity > 0) {
          return { platform: detectedPlatform, solAmount: totalLiquidity, lpAddresses };
        }
      }
    }
  } catch (error) {
    logger.warn(`[LP] DexScreener error: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
  
  // Method 2: Birdeye token_overview for liquidity (if DexScreener failed)
  if (ENV.BIRDEYE_API_KEY && totalLiquidity === 0) {
    try {
      await throttleBirdeye();
      
      const overviewResponse = await fetch(
        `${BIRDEYE_BASE}/defi/token_overview?address=${mintAddress}`,
        {
          headers: {
            'X-API-KEY': ENV.BIRDEYE_API_KEY,
            'x-chain': 'solana',
            'Accept': 'application/json',
          },
        }
      );
      
      if (overviewResponse.ok) {
        const overviewJson = await overviewResponse.json() as any;
        const data = overviewJson?.data || overviewJson;
        
        if (data) {
          totalLiquidity = data.liquidity || data.liquidityUsd || 0;
          logger.info(`[LP] Birdeye liquidity: ${totalLiquidity}`);
        }
      }
    } catch (error) {
      logger.debug(`[LP] Birdeye error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  if (totalLiquidity === 0) {
    logger.warn(`Could not fetch LP info for ${mintAddress.slice(0, 8)}...`);
  }
  
  return { platform: detectedPlatform, solAmount: totalLiquidity, lpAddresses };
}

/**
 * Map DexScreener dexId to our platform names
 */
function detectDexPlatformFromDexScreener(dexId: string): 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm' | 'unknown' {
  const id = dexId.toLowerCase();
  
  if (id.includes('raydium')) return 'raydium';
  if (id.includes('meteora') && id.includes('dlmm')) return 'meteora_v2';
  if (id.includes('meteora')) return 'meteora';
  if (id.includes('pump') || id.includes('pumpswap') || id.includes('pumpfun')) return 'pump_amm';
  if (id.includes('bags')) return 'bags';
  
  // Common DexScreener IDs for Solana
  if (id === 'raydium_cp') return 'raydium';  // Raydium Concentrated
  if (id === 'raydium_amm' || id === 'raydium_v4') return 'raydium';
  if (id === 'meteora_dlmm') return 'meteora_v2';
  if (id === 'meteora_pools') return 'meteora';
  if (id === 'pumpfun' || id === 'pump_amm') return 'pump_amm';
  
  logger.debug(`[LP] Unknown DexScreener dexId: "${dexId}"`);
  return 'unknown';
}

/**
 * Helper to throttle Birdeye API requests
 */
async function throttleBirdeye(): Promise<void> {
  const now = Date.now();
  if (now - lastBirdeyeRequest < BIRDEYE_MIN_DELAY_MS) {
    await sleep(BIRDEYE_MIN_DELAY_MS - (now - lastBirdeyeRequest));
  }
  lastBirdeyeRequest = Date.now();
}

/**
 * Fetch market data including price, volume, and candles
 * Uses DexScreener (free, no rate limits) as primary source
 */
export async function fetchMarketData(
  mintAddress: string,
  candleTimeframeSec: number = 15
): Promise<MarketData> {
  let priceUsd = 0;
  let priceSol = 0;
  let volume24h = 0;
  let volumeRecent = 0;
  let marketCap = 0;
  let liquidity = 0;
  let priceChange = { m5: 0, h1: 0, h6: 0, h24: 0 };
  
  // Method 1: DexScreener (free, no rate limits)
  try {
    const response = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      
      if (pairs.length > 0) {
        // Get the pair with highest liquidity
        const topPair = pairs.sort((a: any, b: any) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        
        priceUsd = parseFloat(topPair.priceUsd) || 0;
        priceSol = parseFloat(topPair.priceNative) || 0;
        
        // DexScreener has volume data
        volume24h = topPair.volume?.h24 || 0;
        volumeRecent = (topPair.volume?.h1 || 0) / 12; // Estimate 5min from 1h
        
        // Market cap and liquidity
        marketCap = topPair.marketCap || topPair.fdv || 0;
        liquidity = topPair.liquidity?.usd || 0;
        
        // Price changes
        priceChange = {
          m5: topPair.priceChange?.m5 || 0,
          h1: topPair.priceChange?.h1 || 0,
          h6: topPair.priceChange?.h6 || 0,
          h24: topPair.priceChange?.h24 || 0,
        };
        
        logger.debug(`[Market] DexScreener: price=$${priceUsd.toFixed(8)}, vol24h=$${volume24h.toFixed(0)}`);
      }
    }
  } catch (error) {
    logger.debug(`DexScreener market data failed: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
  
  // Get candles (may use Birdeye as fallback)
  const candles = await fetchCandles(mintAddress, candleTimeframeSec);
  
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
 * Priority:
 * 1. Pump.fun API (for pump tokens, no rate limits)
 * 2. GeckoTerminal API (free, no rate limits) 
 * 3. Birdeye API (rate limited on free tier)
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
      const timeframe = Math.max(60, timeframeSec);
      const candles = await fetchPumpFunCandles(mintAddress, timeframe, limit);
      
      if (candles.length > 0) {
        logger.debug(`[Candles] Pump.fun: ${candles.length} candles`);
        return candles.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          buyVolume: c.volume * 0.5,
          sellVolume: c.volume * 0.5,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }
  
  // Method 1: GeckoTerminal API (free, no rate limits)
  // First get pool address from DexScreener, then fetch OHLCV from GeckoTerminal
  try {
    // Get pool address from DexScreener
    const dexResponse = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (dexResponse.ok) {
      const dexData = await dexResponse.json() as any;
      const pairs = dexData?.pairs || [];
      
      if (pairs.length > 0) {
        // Get the pool with highest liquidity
        const topPair = pairs.sort((a: any, b: any) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        
        const poolAddress = topPair.pairAddress;
        
        if (poolAddress) {
          // Map timeframe to GeckoTerminal format: minute, hour, day
          let gtTimeframe = 'minute';
          let aggregate = 1;
          
          if (timeframeSec >= 24 * 60 * 60) {
            gtTimeframe = 'day';
            aggregate = 1;
          } else if (timeframeSec >= 60 * 60) {
            gtTimeframe = 'hour';
            aggregate = Math.floor(timeframeSec / 3600);
          } else {
            gtTimeframe = 'minute';
            aggregate = Math.max(1, Math.floor(timeframeSec / 60));
          }
          
          // GeckoTerminal OHLCV endpoint
          const gtUrl = `${GECKOTERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${gtTimeframe}?aggregate=${aggregate}&limit=${limit}`;
          
          const gtResponse = await fetch(gtUrl, {
            headers: { 'Accept': 'application/json' }
          });
          
          if (gtResponse.ok) {
            const gtData = await gtResponse.json() as any;
            const ohlcvList = gtData?.data?.attributes?.ohlcv_list || [];
            
            if (ohlcvList.length > 0) {
              logger.info(`[Candles] GeckoTerminal: ${ohlcvList.length} candles from pool ${poolAddress.slice(0, 8)}...`);
              
              // GeckoTerminal format: [timestamp, open, high, low, close, volume]
              return ohlcvList.map((c: number[]) => ({
                timestamp: c[0] * 1000,
                open: c[1] || 0,
                high: c[2] || 0,
                low: c[3] || 0,
                close: c[4] || 0,
                volume: c[5] || 0,
                buyVolume: (c[5] || 0) * 0.5,
                sellVolume: (c[5] || 0) * 0.5,
              }));
            }
          } else {
            logger.debug(`[Candles] GeckoTerminal status: ${gtResponse.status}`);
          }
        }
      }
    }
  } catch (error) {
    logger.debug(`[Candles] GeckoTerminal error: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
  
  // Method 2: Birdeye OHLCV (fallback, may be rate limited)
  // Reference: https://docs.birdeye.so/reference/get-defi-ohlcv
  if (ENV.BIRDEYE_API_KEY) {
    try {
      // Birdeye valid timeframe types: 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 6H, 8H, 12H, 1D, 3D, 1W, 1M
      let timeType = '1m';
      if (timeframeSec >= 60 * 60) {
        timeType = '1H';
      } else if (timeframeSec >= 30 * 60) {
        timeType = '30m';
      } else if (timeframeSec >= 15 * 60) {
        timeType = '15m';
      } else if (timeframeSec >= 5 * 60) {
        timeType = '5m';
      } else if (timeframeSec >= 3 * 60) {
        timeType = '3m';
      }
      
      const now = Math.floor(Date.now() / 1000);
      const actualTimeframeSec = Math.max(60, timeframeSec);
      const from = now - (limit * actualTimeframeSec);
      
      await throttleBirdeye();
      
      const response = await fetch(
        `${BIRDEYE_BASE}/defi/ohlcv?address=${mintAddress}&type=${timeType}&time_from=${from}&time_to=${now}`,
        {
          headers: {
            'X-API-KEY': ENV.BIRDEYE_API_KEY,
            'x-chain': 'solana',
            'Accept': 'application/json',
          },
        }
      );
      
      if (response.ok) {
        const json = await response.json() as any;
        const items = json?.data?.items || json?.items || [];
        
        if (items.length > 0) {
          logger.info(`[Candles] Birdeye OHLCV: ${items.length} candles`);
          return items.map((c: any) => ({
            timestamp: (c.unixTime || c.time) * 1000,
            open: c.o || c.open || 0,
            high: c.h || c.high || 0,
            low: c.l || c.low || 0,
            close: c.c || c.close || 0,
            volume: c.v || c.volume || 0,
            buyVolume: (c.v || c.volume || 0) * 0.5,
            sellVolume: (c.v || c.volume || 0) * 0.5,
          }));
        }
      }
    } catch (error) {
      logger.debug(`[Candles] Birdeye error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  logger.debug(`[Candles] No candle data available for ${mintAddress.slice(0, 8)}...`);
  return [];
}

/**
 * Fetch recent trading volume
 * Uses DexScreener for DEX tokens, pump.fun API for pump tokens
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
        logger.debug(`Pump.fun volume (${minutes}min): ${volume.volumeSol.toFixed(2)} SOL`);
        return volume.volumeSol;
      }
      return 0;
    } catch {
      return 0;
    }
  }
  
  // Use DexScreener for DEX tokens (free, no rate limits)
  try {
    const response = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      
      if (pairs.length > 0) {
        const topPair = pairs[0];
        // Estimate recent volume from hourly volume
        const hourlyVolume = topPair.volume?.h1 || 0;
        const recentVolume = (hourlyVolume / 60) * minutes;
        
        // Convert USD to SOL estimate
        const priceNative = parseFloat(topPair.priceNative) || 0;
        const priceUsd = parseFloat(topPair.priceUsd) || 0;
        const solPrice = priceNative > 0 && priceUsd > 0 ? priceUsd / priceNative : 200;
        
        return recentVolume / solPrice;
      }
    }
  } catch {
    // Silently fail
  }
  
  return 0;
}

/**
 * Fetch price changes over different timeframes
 * Uses DexScreener (free, no rate limits)
 */
export async function fetchPriceChanges(mintAddress: string): Promise<{
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}> {
  try {
    const response = await fetch(
      `${DEXSCREENER_BASE}/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      
      if (pairs.length > 0) {
        const topPair = pairs[0];
        return {
          m5: topPair.priceChange?.m5 || 0,
          h1: topPair.priceChange?.h1 || 0,
          h6: topPair.priceChange?.h6 || 0,
          h24: topPair.priceChange?.h24 || 0,
        };
      }
    }
  } catch {
    // Silently fail
  }
  
  return { m5: 0, h1: 0, h6: 0, h24: 0 };
}

/**
 * Fetch current SOL price in USD
 * Uses Jupiter price API (free, reliable)
 */
export async function fetchSolPrice(): Promise<number> {
  // Use Jupiter price API first (free, no rate limits)
  try {
    const response = await fetch(
      'https://price.jup.ag/v6/price?ids=SOL'
    );
    const data = await response.json() as { data?: { SOL?: { price?: number } } };
    if (data.data?.SOL?.price) {
      return data.data.SOL.price;
    }
  } catch {
    // Fall through
  }
  
  // Fallback: estimate from DexScreener SOL pairs
  try {
    const response = await fetch(
      `${DEXSCREENER_BASE}/tokens/So11111111111111111111111111111111111111112`
    );
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      if (pairs.length > 0) {
        // Find a USDC/USDT pair to get SOL price
        const usdPair = pairs.find((p: any) => 
          p.quoteToken?.symbol?.includes('USD')
        );
        if (usdPair) {
          return parseFloat(usdPair.priceUsd) || 200;
        }
      }
    }
  } catch {
    // Fall through
  }
  
  // Default estimate
  return 200;
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

/**
 * Make a request to Birdeye API with proper headers and rate limiting
 * Headers required: X-API-KEY, x-chain (solana)
 * Reference: https://docs.birdeye.so/reference
 * 
 * Note: Most data now comes from DexScreener (free, no rate limits)
 * Birdeye is only used as fallback for candles/OHLCV data
 */
async function birdeyeRequest<T>(endpoint: string): Promise<T> {
  // Throttle requests to avoid 429 rate limiting
  await throttleBirdeye();
  
  const response = await fetch(`${BIRDEYE_BASE}${endpoint}`, {
    headers: {
      'X-API-KEY': ENV.BIRDEYE_API_KEY,
      'x-chain': 'solana',
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Only log debug for rate limits since they're expected
    if (response.status === 429) {
      logger.debug(`Birdeye rate limited (expected on free tier)`);
    }
    throw new Error(`Birdeye API error: ${response.status} ${errorText.slice(0, 50)}`);
  }
  
  const json = await response.json() as { data?: T; success?: boolean } | T;
  
  // Birdeye wraps responses in { data: ..., success: true }
  if (typeof json === 'object' && json !== null && 'data' in json) {
    return (json as { data: T }).data;
  }
  
  return json as T;
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
