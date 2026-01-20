/**
 * PUMP.FUN INTEGRATION
 * 
 * Pump.fun is where most Solana memecoins launch before migrating to Raydium.
 * This module handles:
 * - Token data from Pump.fun API
 * - Bonding curve trading (pre-Raydium)
 * - Graduation detection (when it moves to Raydium)
 */

import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getConnection, getWallet, sendAndConfirmTransaction, withRetry } from '../utils/solana.js';
import { SLIPPAGE, FEES_EXECUTION } from '../config/index.js';
import logger from '../utils/logger.js';

// Pump.fun constants
const PUMP_FUN_API = 'https://frontend-api.pump.fun';
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

// Graduation threshold (when token moves to Raydium)
const GRADUATION_MARKET_CAP_USD = 69000; // ~$69k market cap = graduation
const BONDING_CURVE_SOL_TARGET = 85; // SOL needed to graduate

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

/**
 * Fetch token data from Pump.fun
 */
export async function fetchPumpFunToken(mintAddress: string): Promise<PumpFunToken | null> {
  try {
    const response = await fetch(`${PUMP_FUN_API}/coins/${mintAddress}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null; // Not a pump.fun token
      }
      throw new Error(`Pump.fun API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Calculate age
    const createdTimestamp = data.created_timestamp || Date.now();
    const ageMinutes = (Date.now() - createdTimestamp) / 1000 / 60;
    
    // Calculate bonding curve progress
    const realSolReserves = (data.real_sol_reserves || 0) / LAMPORTS_PER_SOL;
    const bondingCurveProgress = Math.min(100, (realSolReserves / BONDING_CURVE_SOL_TARGET) * 100);
    
    // Check if graduated (moved to Raydium)
    const isGraduated = data.raydium_pool !== null && data.raydium_pool !== undefined;
    
    // Calculate price from bonding curve
    const virtualSolReserves = (data.virtual_sol_reserves || 0) / LAMPORTS_PER_SOL;
    const virtualTokenReserves = (data.virtual_token_reserves || 1) / 1e6; // 6 decimals
    const priceSol = virtualSolReserves / virtualTokenReserves;
    
    // Get USD price (estimate)
    const solPriceUsd = await getSolPriceUsd();
    const priceUsd = priceSol * solPriceUsd;
    const marketCapUsd = data.usd_market_cap || (priceUsd * 1_000_000_000); // 1B supply
    const marketCapSol = marketCapUsd / solPriceUsd;
    
    return {
      mint: mintAddress,
      name: data.name || 'Unknown',
      symbol: data.symbol || 'UNKNOWN',
      description: data.description || '',
      imageUri: data.image_uri || '',
      creator: data.creator || '',
      createdTimestamp,
      ageMinutes,
      
      bondingCurve: data.bonding_curve || '',
      associatedBondingCurve: data.associated_bonding_curve || '',
      virtualSolReserves,
      virtualTokenReserves,
      realSolReserves,
      realTokenReserves: (data.real_token_reserves || 0) / 1e6,
      
      priceUsd,
      priceSol,
      marketCapUsd,
      marketCapSol,
      
      bondingCurveProgress,
      isGraduated,
      raydiumPool: data.raydium_pool,
      
      website: data.website,
      twitter: data.twitter,
      telegram: data.telegram,
      
      replyCount: data.reply_count || 0,
      lastReply: data.last_reply,
    };
    
  } catch (error) {
    logger.debug(`Pump.fun fetch failed: ${error}`);
    return null;
  }
}

/**
 * Check if a token is on Pump.fun
 */
export async function isPumpFunToken(mintAddress: string): Promise<boolean> {
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
    const response = await fetch(
      `${PUMP_FUN_API}/trades/latest?mint=${mintAddress}&limit=${limit}`
    );
    
    if (!response.ok) {
      return [];
    }
    
    const trades = await response.json();
    
    return trades.map((t: any) => ({
      signature: t.signature,
      mint: t.mint,
      solAmount: (t.sol_amount || 0) / LAMPORTS_PER_SOL,
      tokenAmount: (t.token_amount || 0) / 1e6,
      isBuy: t.is_buy,
      user: t.user,
      timestamp: t.timestamp,
      slot: t.slot,
    }));
    
  } catch {
    return [];
  }
}

/**
 * Fetch new tokens from Pump.fun
 */
export async function fetchNewPumpFunTokens(limit: number = 20): Promise<PumpFunToken[]> {
  try {
    const response = await fetch(
      `${PUMP_FUN_API}/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=false`
    );
    
    if (!response.ok) {
      return [];
    }
    
    const coins = await response.json();
    const tokens: PumpFunToken[] = [];
    
    for (const coin of coins) {
      const token = await fetchPumpFunToken(coin.mint);
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
 * Get king of the hill token (highest market cap not graduated)
 */
export async function fetchKingOfTheHill(): Promise<PumpFunToken | null> {
  try {
    const response = await fetch(`${PUMP_FUN_API}/coins/king-of-the-hill`);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return fetchPumpFunToken(data.mint);
    
  } catch {
    return null;
  }
}

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
    
    // Calculate minimum tokens with slippage
    const minTokens = quote.tokenAmount * (1 - slippagePercent / 100);
    
    // Build transaction using Pump.fun's buy endpoint
    const wallet = getWallet();
    
    const response = await fetch(`${PUMP_FUN_API}/trade/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mint: mintAddress,
        amount: Math.floor(solAmount * LAMPORTS_PER_SOL),
        slippage: slippagePercent / 100,
        priorityFee: FEES_EXECUTION.PRIORITY_FEE_SOL,
        userPublicKey: wallet.publicKey.toBase58(),
      }),
    });
    
    if (!response.ok) {
      // Fallback: construct transaction manually
      return await executePumpFunBuyManual(token, solAmount, minTokens);
    }
    
    const txData = await response.json();
    const transaction = Transaction.from(Buffer.from(txData.transaction, 'base64'));
    
    const signature = await sendAndConfirmTransaction(transaction);
    
    logger.success(`Pump.fun BUY executed: ${signature}`);
    
    return {
      success: true,
      signature,
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
    
    // Calculate minimum SOL with slippage
    const minSol = quote.solAmount * (1 - slippagePercent / 100);
    
    // Build transaction
    const wallet = getWallet();
    
    const response = await fetch(`${PUMP_FUN_API}/trade/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mint: mintAddress,
        amount: Math.floor(tokenAmount * 1e6), // 6 decimals
        slippage: slippagePercent / 100,
        priorityFee: FEES_EXECUTION.PRIORITY_FEE_SOL,
        userPublicKey: wallet.publicKey.toBase58(),
      }),
    });
    
    if (!response.ok) {
      return await executePumpFunSellManual(token, tokenAmount, minSol);
    }
    
    const txData = await response.json();
    const transaction = Transaction.from(Buffer.from(txData.transaction, 'base64'));
    
    const signature = await sendAndConfirmTransaction(transaction);
    
    logger.success(`Pump.fun SELL executed: ${signature}`);
    
    return {
      success: true,
      signature,
      solAmount: quote.solAmount,
    };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Pump.fun SELL failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Manual buy execution (fallback)
 */
async function executePumpFunBuyManual(
  token: PumpFunToken,
  solAmount: number,
  minTokens: number
): Promise<{ success: boolean; signature?: string; tokenAmount?: number; error?: string }> {
  // This would construct the transaction manually using Pump.fun's program
  // For now, return error as this requires complex instruction building
  return { 
    success: false, 
    error: 'Manual transaction building not implemented - use Pump.fun website' 
  };
}

/**
 * Manual sell execution (fallback)
 */
async function executePumpFunSellManual(
  token: PumpFunToken,
  tokenAmount: number,
  minSol: number
): Promise<{ success: boolean; signature?: string; solAmount?: number; error?: string }> {
  return { 
    success: false, 
    error: 'Manual transaction building not implemented - use Pump.fun website' 
  };
}

/**
 * Get SOL price in USD
 */
async function getSolPriceUsd(): Promise<number> {
  try {
    const response = await fetch('https://price.jup.ag/v4/price?ids=SOL');
    const data = await response.json();
    return data.data?.SOL?.price || 150; // Fallback to $150
  } catch {
    return 150;
  }
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
  
  // Check reply count (engagement)
  if (token.replyCount < 5) {
    warnings.push('Low engagement (< 5 replies)');
    score -= 5;
  }
  
  return {
    safe: score >= 50 && !warnings.some(w => w.includes('extreme')),
    warnings,
    score: Math.max(0, score),
  };
}
