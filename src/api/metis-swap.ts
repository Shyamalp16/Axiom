/**
 * METIS SWAP API INTEGRATION
 * 
 * Wrapper for the public Metis Pump.fun swap endpoint
 * Endpoint: https://public.jupiterapi.com/pump-fun/swap
 * 
 * Note: Public endpoint incurs a swap fee but provides reliable pre-built transactions
 * 
 * Reference: https://www.quicknode.com/guides/solana-development/tooling/web3-2/pump-fun-api
 */

import { VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getWallet, getConnection, withRetry, sleep } from '../utils/solana.js';
import { PAPER_TRADING } from '../config/constants.js';
import logger from '../utils/logger.js';

// Public Metis endpoint (has swap fees but works without API key)
const METIS_PUBLIC_ENDPOINT = 'https://public.jupiterapi.com';

// Priority fee levels supported by Metis
type PriorityFeeLevel = 'low' | 'medium' | 'high' | 'veryHigh';

// Metis swap request parameters
interface MetisSwapParams {
  wallet: string;           // Wallet public key
  type: 'BUY' | 'SELL';
  mint: string;             // Token mint address
  inAmount: number;         // Amount in smallest units (lamports for SOL, token atoms for tokens)
  priorityFeeLevel?: PriorityFeeLevel;
}

// Metis swap response
interface MetisSwapResponse {
  tx: string;  // Base64 encoded transaction ready to sign
}

// Result type for swap execution
interface SwapResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Execute a BUY swap via public Metis API
 * Buys tokens with SOL
 * 
 * @param mint - Token mint address
 * @param solAmount - Amount of SOL to spend
 * @param priorityFeeLevel - Priority fee level (default: high)
 */
export async function metisBuy(
  mint: string,
  solAmount: number,
  priorityFeeLevel: PriorityFeeLevel = 'high'
): Promise<SwapResult> {
  logger.info(`Metis BUY: ${solAmount} SOL → ${mint.slice(0, 8)}...`);
  
  // Paper trading mode - simulate success
  if (PAPER_TRADING.ENABLED) {
    logger.info('📝 PAPER TRADE: Simulating Metis buy');
    await sleep(500); // Simulate network delay
    return {
      success: true,
      signature: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
  }
  
  return executeMetisSwap({
    mint,
    type: 'BUY',
    amountLamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    priorityFeeLevel,
  });
}

/**
 * Execute a SELL swap via public Metis API
 * Sells tokens for SOL
 * 
 * @param mint - Token mint address
 * @param tokenAmount - Amount of tokens to sell (in token atoms, typically * 1e6)
 * @param priorityFeeLevel - Priority fee level (default: high)
 */
export async function metisSell(
  mint: string,
  tokenAmount: number,
  priorityFeeLevel: PriorityFeeLevel = 'high'
): Promise<SwapResult> {
  logger.info(`Metis SELL: ${tokenAmount} tokens → SOL`);
  
  // Paper trading mode - simulate success
  if (PAPER_TRADING.ENABLED) {
    logger.info('📝 PAPER TRADE: Simulating Metis sell');
    await sleep(500); // Simulate network delay
    return {
      success: true,
      signature: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
  }
  
  return executeMetisSwap({
    mint,
    type: 'SELL',
    amountLamports: Math.floor(tokenAmount), // Token amount in atoms
    priorityFeeLevel,
  });
}

/**
 * Internal function to execute swap via Metis public API
 */
async function executeMetisSwap(params: {
  mint: string;
  type: 'BUY' | 'SELL';
  amountLamports: number;
  priorityFeeLevel: PriorityFeeLevel;
}): Promise<SwapResult> {
  const wallet = getWallet();
  const connection = getConnection();
  
  try {
    // 1. Get swap transaction from Metis with retry
    const swapTx = await withRetry(async () => {
      const response = await fetch(`${METIS_PUBLIC_ENDPOINT}/pump-fun/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.publicKey.toBase58(),
          type: params.type,
          mint: params.mint,
          inAmount: params.amountLamports,
          priorityFeeLevel: params.priorityFeeLevel,
        } satisfies MetisSwapParams),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Metis API error: ${response.status} - ${errorText}`);
      }
      
      return response.json() as Promise<MetisSwapResponse>;
    }, 3, 500);
    
    logger.debug('Metis swap transaction received');
    
    // 2. Decode the base64 transaction
    const transactionBuffer = Buffer.from(swapTx.tx, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    
    // 3. Sign the transaction
    transaction.sign([wallet]);
    
    // 4. Send the transaction
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 3,
    });
    
    logger.debug(`Transaction sent: ${signature}`);
    
    // 5. Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    logger.success(`Metis ${params.type} executed: ${signature}`);
    return { success: true, signature };
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Metis swap failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Check if Metis API is reachable
 */
export async function isMetisAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${METIS_PUBLIC_ENDPOINT}/pump-fun/swap`, {
      method: 'OPTIONS',
    });
    return response.ok || response.status === 405; // 405 Method Not Allowed is fine
  } catch {
    return false;
  }
}

// Export types
export type { MetisSwapParams, MetisSwapResponse, SwapResult, PriorityFeeLevel };
