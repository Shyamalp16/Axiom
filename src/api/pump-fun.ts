/**
 * PUMP.FUN INTEGRATION
 * 
 * Pump.fun is where most Solana memecoins launch before migrating to Raydium.
 * This module handles:
 * - Token data via PumpPortal WebSocket API
 * - Bonding curve trading (pre-Raydium)
 * - Graduation detection (when it moves to Raydium)
 * 
 * Data source: PumpPortal (https://pumpportal.fun)
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SLIPPAGE } from '../config/index.js';
import logger from '../utils/logger.js';
import {
  connectPumpPortal,
  subscribeTokenTrades,
  subscribeNewTokens,
  subscribeMigrations,
  getCachedToken,
  getCachedTrades,
  fetchTokenViaPumpPortal,
  waitForNewTokens,
  isConnectedToPumpPortal,
  PumpPortalToken,
  PumpPortalTrade,
  PumpPortalNewToken,
} from './pump-portal.js';

// Bonding curve graduation threshold
const BONDING_CURVE_SOL_TARGET = 85; // SOL needed to graduate

// ============================================
// TYPES (backwards compatible)
// ============================================

export interface PumpFunTrade {
  signature: string;
  mint: string;
  solAmount: number;
  tokenAmount: number;
  isBuy: boolean;
  user: string;
  timestamp: number;
  slot: number;
}

export interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  creator: string;
  createdTimestamp: number;
  ageMinutes: number;
  
  // Bonding curve state
  bondingCurve: string;
  associatedBondingCurve: string;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  realTokenReserves: number;
  
  // Market data
  priceUsd: number;
  priceSol: number;
  marketCapUsd: number;
  marketCapSol: number;
  
  // Progress
  bondingCurveProgress: number; // 0-100%
  isGraduated: boolean;
  raydiumPool?: string;
  
  // Social
  website?: string;
  twitter?: string;
  telegram?: string;
  
  // Stats
  replyCount: number;
  lastReply?: number;
}

// ============================================
// INITIALIZATION
// ============================================

let initialized = false;

/**
 * Initialize PumpPortal connection
 */
export async function initializePumpFunApi(): Promise<void> {
  if (initialized) return;
  
  try {
    await connectPumpPortal();
    initialized = true;
    logger.success('Pump.fun API initialized (via PumpPortal)');
  } catch (error) {
    logger.error('Failed to initialize Pump.fun API:', error);
    throw error;
  }
}

/**
 * Check if connected to PumpPortal
 */
export function isPumpFunApiConnected(): boolean {
  return isConnectedToPumpPortal();
}

// ============================================
// TOKEN DATA FUNCTIONS
// ============================================

/**
 * Fetch token data from PumpPortal
 */
export async function fetchPumpFunToken(mintAddress: string): Promise<PumpFunToken | null> {
  try {
    // Ensure connected
    if (!isConnectedToPumpPortal()) {
      await connectPumpPortal();
    }
    
    // Get from cache or fetch via subscription
    let portalToken = getCachedToken(mintAddress);
    
    if (!portalToken) {
      // Subscribe to get data
      portalToken = await fetchTokenViaPumpPortal(mintAddress, 5000);
    }
    
    if (!portalToken) {
      return null;
    }
    
    // Get SOL price for USD calculations
    const solPriceUsd = await getSolPriceUsd();
    
    // Convert to PumpFunToken format
    const token: PumpFunToken = {
      mint: portalToken.mint,
      name: portalToken.name,
      symbol: portalToken.symbol,
      description: portalToken.description || '',
      imageUri: portalToken.imageUri || '',
      creator: portalToken.creator,
      createdTimestamp: portalToken.createdTimestamp,
      ageMinutes: portalToken.ageMinutes,
      
      bondingCurve: portalToken.bondingCurve || '',
      associatedBondingCurve: '',
      virtualSolReserves: portalToken.virtualSolReserves,
      virtualTokenReserves: portalToken.virtualTokenReserves,
      realSolReserves: portalToken.realSolReserves,
      realTokenReserves: 0,
      
      // Use existing USD values if available, otherwise calculate from SOL values
      priceUsd: portalToken.priceUsd > 0 ? portalToken.priceUsd : portalToken.priceSol * solPriceUsd,
      priceSol: portalToken.priceSol,
      marketCapUsd: portalToken.marketCapUsd > 0 ? portalToken.marketCapUsd : portalToken.marketCapSol * solPriceUsd,
      marketCapSol: portalToken.marketCapSol,
      
      // Use bondingCurveProgress from portal if available, otherwise calculate
      bondingCurveProgress: portalToken.bondingCurveProgress > 0 
        ? portalToken.bondingCurveProgress 
        : Math.min(100, (portalToken.realSolReserves / BONDING_CURVE_SOL_TARGET) * 100),
      isGraduated: portalToken.isGraduated,
      
      website: portalToken.website,
      twitter: portalToken.twitter,
      telegram: portalToken.telegram,
      
      replyCount: portalToken.tradeCount, // Use trade count as engagement metric
      lastReply: portalToken.lastTradeTimestamp,
    };
    
    return token;
    
  } catch (error) {
    logger.debug(`Pump.fun fetch failed: ${error}`);
    return null;
  }
}

/**
 * Check if a token is on Pump.fun
 */
export async function isPumpFunToken(mintAddress: string): Promise<boolean> {
  // Quick check by address pattern (Pump.fun tokens end in 'pump')
  if (mintAddress.toLowerCase().endsWith('pump')) {
    return true;
  }
  
  const token = await fetchPumpFunToken(mintAddress);
  return token !== null;
}

/**
 * Fetch recent trades for a Pump.fun token
 */
export async function fetchPumpFunTrades(
  mintAddress: string,
  limit: number = 50
): Promise<PumpFunTrade[]> {
  try {
    // Ensure connected
    if (!isConnectedToPumpPortal()) {
      await connectPumpPortal();
    }
    
    // Get cached trades
    const portalTrades = getCachedTrades(mintAddress);
    
    if (portalTrades.length === 0) {
      // Subscribe to start receiving trades
      subscribeTokenTrades([mintAddress], () => {});
      
      // Wait a moment for trades to come in
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Convert to PumpFunTrade format
    return getCachedTrades(mintAddress)
      .slice(0, limit)
      .map((t: PumpPortalTrade) => ({
        signature: t.signature,
        mint: t.mint,
        solAmount: t.solAmount / LAMPORTS_PER_SOL,
        tokenAmount: t.tokenAmount / 1e6,
        isBuy: t.txType === 'buy',
        user: t.traderPublicKey,
        timestamp: t.timestamp,
        slot: 0,
      }));
      
  } catch {
    return [];
  }
}

/**
 * Fetch new tokens from Pump.fun (via PumpPortal stream)
 */
export async function fetchNewPumpFunTokens(limit: number = 20): Promise<PumpFunToken[]> {
  try {
    // Get new tokens via WebSocket
    const newTokens = await waitForNewTokens(limit, 30000);
    
    const tokens: PumpFunToken[] = [];
    
    for (const newToken of newTokens) {
      const token = await fetchPumpFunToken(newToken.mint);
      if (token) {
        tokens.push(token);
      }
    }
    
    return tokens;
    
  } catch {
    return [];
  }
}

/**
 * Subscribe to new token creation events
 */
export function onNewPumpFunToken(handler: (token: PumpPortalNewToken) => void): () => void {
  return subscribeNewTokens(handler);
}

/**
 * Subscribe to token trade events
 */
export function onPumpFunTrade(mint: string, handler: (trade: PumpPortalTrade) => void): () => void {
  return subscribeTokenTrades([mint], handler);
}

/**
 * Subscribe to token graduation events
 */
export function onPumpFunGraduation(handler: (event: { mint: string; pool: string }) => void): () => void {
  return subscribeMigrations((event) => {
    handler({ mint: event.mint, pool: event.pool });
  });
}

// ============================================
// BONDING CURVE CALCULATIONS
// ============================================

/**
 * Calculate buy quote for Pump.fun bonding curve
 */
export function calculatePumpFunBuyQuote(
  token: PumpFunToken,
  solAmount: number
): { tokenAmount: number; priceImpact: number } {
  // Constant product formula: x * y = k
  const k = token.virtualSolReserves * token.virtualTokenReserves;
  const newSolReserves = token.virtualSolReserves + solAmount;
  const newTokenReserves = k / newSolReserves;
  const tokenAmount = token.virtualTokenReserves - newTokenReserves;
  
  // Calculate price impact
  const avgPrice = solAmount / tokenAmount;
  const spotPrice = token.priceSol;
  const priceImpact = ((avgPrice - spotPrice) / spotPrice) * 100;
  
  return { tokenAmount, priceImpact };
}

/**
 * Calculate sell quote for Pump.fun bonding curve
 */
export function calculatePumpFunSellQuote(
  token: PumpFunToken,
  tokenAmount: number
): { solAmount: number; priceImpact: number } {
  // Constant product formula
  const k = token.virtualSolReserves * token.virtualTokenReserves;
  const newTokenReserves = token.virtualTokenReserves + tokenAmount;
  const newSolReserves = k / newTokenReserves;
  const solAmount = token.virtualSolReserves - newSolReserves;
  
  // Calculate price impact
  const avgPrice = solAmount / tokenAmount;
  const spotPrice = token.priceSol;
  const priceImpact = ((spotPrice - avgPrice) / spotPrice) * 100;
  
  return { solAmount, priceImpact };
}

// ============================================
// TRADING FUNCTIONS
// ============================================

/**
 * Buy tokens on Pump.fun bonding curve
 */
export async function buyOnPumpFun(
  mintAddress: string,
  solAmount: number,
  slippagePercent: number = SLIPPAGE.BUY_SLIPPAGE_PERCENT
): Promise<{
  success: boolean;
  signature?: string;
  tokenAmount?: number;
  error?: string;
}> {
  logger.info(`Pump.fun BUY: ${solAmount} SOL → ${mintAddress.slice(0, 8)}...`);
  
  try {
    const token = await fetchPumpFunToken(mintAddress);
    
    if (!token) {
      return { success: false, error: 'Token not found on Pump.fun' };
    }
    
    if (token.isGraduated) {
      return { success: false, error: 'Token graduated to Raydium - use Jupiter' };
    }
    
    // Calculate expected output
    const quote = calculatePumpFunBuyQuote(token, solAmount);
    
    if (quote.priceImpact > slippagePercent) {
      return { 
        success: false, 
        error: `Price impact too high: ${quote.priceImpact.toFixed(2)}%` 
      };
    }
    
    // For paper trading, just return success with calculated amount
    // Real trading would require transaction building
    logger.success(`Pump.fun BUY simulated: ${quote.tokenAmount.toFixed(2)} tokens`);
    
    return {
      success: true,
      tokenAmount: quote.tokenAmount,
    };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Pump.fun BUY failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Sell tokens on Pump.fun bonding curve
 */
export async function sellOnPumpFun(
  mintAddress: string,
  tokenAmount: number,
  slippagePercent: number = SLIPPAGE.SELL_SLIPPAGE_PERCENT
): Promise<{
  success: boolean;
  signature?: string;
  solAmount?: number;
  error?: string;
}> {
  logger.info(`Pump.fun SELL: ${tokenAmount} tokens → SOL`);
  
  try {
    const token = await fetchPumpFunToken(mintAddress);
    
    if (!token) {
      return { success: false, error: 'Token not found on Pump.fun' };
    }
    
    if (token.isGraduated) {
      return { success: false, error: 'Token graduated to Raydium - use Jupiter' };
    }
    
    // Calculate expected output
    const quote = calculatePumpFunSellQuote(token, tokenAmount);
    
    if (quote.priceImpact > slippagePercent) {
      logger.warn(`High price impact: ${quote.priceImpact.toFixed(2)}%`);
    }
    
    // For paper trading, return success with calculated amount
    logger.success(`Pump.fun SELL simulated: ${quote.solAmount.toFixed(4)} SOL`);
    
    return {
      success: true,
      solAmount: quote.solAmount,
    };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Pump.fun SELL failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Get SOL price in USD (uses pump.fun /sol-price API via pump-portal)
 */
async function getSolPriceUsd(): Promise<number> {
  // Use the getSolPrice from pump-portal for consistency
  const { getSolPrice } = await import('./pump-portal.js');
  return getSolPrice();
}

/**
 * Analyze Pump.fun token for safety
 */
export function analyzePumpFunSafety(token: PumpFunToken): {
  safe: boolean;
  warnings: string[];
  score: number;
} {
  const warnings: string[] = [];
  let score = 100;
  
  // Check if too new (< 1 min = very risky)
  if (token.ageMinutes < 1) {
    warnings.push('Token is less than 1 minute old - extreme risk');
    score -= 40;
  } else if (token.ageMinutes < 3) {
    warnings.push('Token is very new (< 3 min) - high risk');
    score -= 20;
  }
  
  // Check bonding curve progress
  if (token.bondingCurveProgress < 10) {
    warnings.push('Very early in bonding curve (< 10%) - low liquidity');
    score -= 15;
  } else if (token.bondingCurveProgress > 90) {
    warnings.push('About to graduate (> 90%) - migration risk');
    score -= 10;
  }
  
  // Check market cap
  if (token.marketCapUsd < 5000) {
    warnings.push('Very low market cap (< $5k) - high volatility');
    score -= 10;
  }
  
  // Check social presence
  if (!token.twitter && !token.telegram && !token.website) {
    warnings.push('No social links - could be low effort launch');
    score -= 10;
  }
  
  // Check engagement (trade count)
  if (token.replyCount < 5) {
    warnings.push('Low engagement (< 5 trades)');
    score -= 5;
  }
  
  return {
    safe: score >= 50 && !warnings.some(w => w.includes('extreme')),
    warnings,
    score: Math.max(0, score),
  };
}
