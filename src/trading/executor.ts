/**
 * TRADE EXECUTOR
 * Handles swap execution via Jupiter OR Pump.fun bonding curve
 * 
 * FEES & EXECUTION (Battle-tested):
 * - Priority fee: 0.0007 SOL
 * - Jito bribe: 0.0015 SOL (max 0.0025)
 * - Buy slippage: 10%
 * - Sell slippage: 12%
 * - Emergency sell slippage: 18%
 * 
 * Automatically routes:
 * - Pump.fun tokens → Bonding curve
 * - Graduated tokens → Jupiter (Raydium/Orca)
 */

import { 
  Connection, 
  VersionedTransaction, 
  TransactionMessage,
  PublicKey,
} from '@solana/web3.js';
import { 
  FEES_EXECUTION, 
  SLIPPAGE, 
  JUPITER_API_URL,
  SOL_MINT 
} from '../config/index.js';
import { 
  getConnection, 
  getWallet, 
  sendAndConfirmTransaction,
  solToLamports,
  withRetry 
} from '../utils/solana.js';
import { Order, OrderStatus, JupiterQuote } from '../types/index.js';
import { 
  fetchPumpFunToken, 
  buyOnPumpFun, 
  sellOnPumpFun 
} from '../api/pump-fun.js';
import logger from '../utils/logger.js';

/**
 * Execute a buy order - auto-routes to Pump.fun or Jupiter
 */
export async function executeBuy(
  tokenMint: string,
  amountSol: number,
  slippagePercent: number = SLIPPAGE.BUY_SLIPPAGE_PERCENT
): Promise<{
  success: boolean;
  signature?: string;
  amountReceived?: number;
  actualSlippage?: number;
  error?: string;
  platform?: 'pump.fun' | 'jupiter';
}> {
  // Check if this is a Pump.fun token (not yet graduated)
  const pumpToken = await fetchPumpFunToken(tokenMint);
  
  if (pumpToken && !pumpToken.isGraduated) {
    logger.info(`🟢 Routing to PUMP.FUN (Bonding Curve)`);
    const result = await buyOnPumpFun(tokenMint, amountSol, slippagePercent);
    return { ...result, platform: 'pump.fun' };
  }
  
  // Use Jupiter for graduated tokens or non-pump tokens
  logger.info(`🔵 Routing to JUPITER (DEX)`);
  logger.info(`Executing BUY: ${amountSol} SOL → ${tokenMint.slice(0, 8)}...`);
  logger.info(`  Slippage: ${slippagePercent}%`);
  
  try {
    // 1. Get quote from Jupiter
    const quote = await getJupiterQuote(
      SOL_MINT,
      tokenMint,
      solToLamports(amountSol),
      slippagePercent
    );
    
    if (!quote) {
      return { success: false, error: 'Failed to get quote' };
    }
    
    logger.debug('Quote received', {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
    });
    
    // 2. Check price impact
    const priceImpact = parseFloat(quote.priceImpactPct);
    if (priceImpact > 5) {
      logger.warn(`High price impact: ${priceImpact.toFixed(2)}%`);
    }
    
    // 3. Get swap transaction
    const swapTx = await getJupiterSwapTransaction(quote);
    
    if (!swapTx) {
      return { success: false, error: 'Failed to get swap transaction' };
    }
    
    // 4. Execute transaction
    const signature = await sendAndConfirmTransaction(swapTx);
    
    const amountReceived = parseInt(quote.outAmount);
    
    logger.success(`BUY executed: ${signature}`);
    
    return {
      success: true,
      signature,
      amountReceived,
      actualSlippage: priceImpact,
    };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`BUY failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Execute a sell order - auto-routes to Pump.fun or Jupiter
 */
export async function executeSell(
  tokenMint: string,
  amountTokens: number,
  slippagePercent: number = SLIPPAGE.SELL_SLIPPAGE_PERCENT,
  isEmergency: boolean = false
): Promise<{
  success: boolean;
  signature?: string;
  amountReceived?: number;
  actualSlippage?: number;
  error?: string;
  platform?: 'pump.fun' | 'jupiter';
}> {
  const slippage = isEmergency 
    ? SLIPPAGE.EMERGENCY_SELL_SLIPPAGE_PERCENT 
    : slippagePercent;
  
  // Check if this is a Pump.fun token (not yet graduated)
  const pumpToken = await fetchPumpFunToken(tokenMint);
  
  if (pumpToken && !pumpToken.isGraduated) {
    logger.info(`🟢 Routing SELL to PUMP.FUN (Bonding Curve)`);
    const result = await sellOnPumpFun(tokenMint, amountTokens, slippage);
    return { ...result, platform: 'pump.fun' };
  }
  
  // Use Jupiter for graduated tokens or non-pump tokens
  logger.info(`🔵 Routing SELL to JUPITER (DEX)`);
  logger.info(`Executing SELL: ${amountTokens} tokens → SOL`);
  logger.info(`  Slippage: ${slippage}%${isEmergency ? ' (EMERGENCY)' : ''}`);
  
  try {
    // 1. Get quote from Jupiter
    const quote = await getJupiterQuote(
      tokenMint,
      SOL_MINT,
      Math.floor(amountTokens),
      slippage
    );
    
    if (!quote) {
      return { success: false, error: 'Failed to get quote' };
    }
    
    logger.debug('Quote received', {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
    });
    
    // 2. Check if slippage is acceptable
    const priceImpact = parseFloat(quote.priceImpactPct);
    
    if (priceImpact > SLIPPAGE.MAX_ACCEPTABLE_SLIPPAGE_PERCENT && !isEmergency) {
      logger.error(`Price impact too high: ${priceImpact.toFixed(2)}% - Aborting`);
      return { 
        success: false, 
        error: `Price impact ${priceImpact.toFixed(2)}% exceeds max ${SLIPPAGE.MAX_ACCEPTABLE_SLIPPAGE_PERCENT}%` 
      };
    }
    
    // 3. Get swap transaction
    const swapTx = await getJupiterSwapTransaction(quote);
    
    if (!swapTx) {
      return { success: false, error: 'Failed to get swap transaction' };
    }
    
    // 4. Execute transaction
    const signature = await sendAndConfirmTransaction(swapTx);
    
    const amountReceived = parseInt(quote.outAmount) / 1e9; // Convert to SOL
    
    logger.success(`SELL executed: ${signature}`);
    logger.info(`  Received: ${amountReceived.toFixed(4)} SOL`);
    
    return {
      success: true,
      signature,
      amountReceived,
      actualSlippage: priceImpact,
    };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`SELL failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Emergency sell - use max slippage
 */
export async function emergencySell(
  tokenMint: string,
  amountTokens: number
): Promise<{
  success: boolean;
  signature?: string;
  error?: string;
}> {
  logger.alert('danger', 'EMERGENCY SELL TRIGGERED');
  
  return executeSell(
    tokenMint,
    amountTokens,
    SLIPPAGE.EMERGENCY_SELL_SLIPPAGE_PERCENT,
    true
  );
}

/**
 * Get quote from Jupiter
 */
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<JupiterQuote | null> {
  return withRetry(async () => {
    const slippageInBps = Math.floor(slippageBps * 100); // Convert % to bps
    
    const url = new URL(`${JUPITER_API_URL}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount.toString());
    url.searchParams.set('slippageBps', slippageInBps.toString());
    url.searchParams.set('onlyDirectRoutes', 'false');
    url.searchParams.set('asLegacyTransaction', 'false');
    
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status}`);
    }
    
    return response.json();
  });
}

/**
 * Get swap transaction from Jupiter
 */
async function getJupiterSwapTransaction(
  quote: JupiterQuote
): Promise<VersionedTransaction | null> {
  return withRetry(async () => {
    const wallet = getWallet();
    
    const response = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: Math.floor(FEES_EXECUTION.PRIORITY_FEE_SOL * 1e9 / 200000),
        dynamicComputeUnitLimit: true,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Jupiter swap failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Decode the transaction
    const swapTransaction = VersionedTransaction.deserialize(
      Buffer.from(data.swapTransaction, 'base64')
    );
    
    return swapTransaction;
  });
}

/**
 * Get token balance for wallet
 */
export async function getTokenBalance(tokenMint: string): Promise<number> {
  const conn = getConnection();
  const wallet = getWallet();
  
  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(tokenMint) }
    );
    
    if (tokenAccounts.value.length === 0) {
      return 0;
    }
    
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return parseFloat(balance.amount);
  } catch {
    return 0;
  }
}

/**
 * Estimate transaction fees
 */
export function estimateFees(): {
  priorityFee: number;
  jitoBribe: number;
  total: number;
} {
  const priorityFee = FEES_EXECUTION.PRIORITY_FEE_SOL;
  const jitoBribe = FEES_EXECUTION.JITO_BRIBE_SOL;
  
  return {
    priorityFee,
    jitoBribe,
    total: priorityFee + jitoBribe + 0.000005, // Base fee
  };
}

/**
 * Check if we can afford the transaction
 */
export async function canAffordTransaction(tradeSizeSol: number): Promise<boolean> {
  const fees = estimateFees();
  const totalRequired = tradeSizeSol + (fees.total * 2); // Round trip
  
  const balance = await (await import('../utils/solana.js')).getWalletBalance();
  
  return balance >= totalRequired;
}
