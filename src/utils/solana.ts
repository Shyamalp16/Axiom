import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SendOptions,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { ENV } from '../config/index.js';
import logger from './logger.js';

let connection: Connection | null = null;
let wallet: Keypair | null = null;

/**
 * Initialize Solana connection
 */
export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(ENV.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: ENV.SOLANA_WS_URL,
    });
    logger.info(`Connected to Solana RPC: ${ENV.SOLANA_RPC_URL}`);
  }
  return connection;
}

/**
 * Get wallet keypair from private key
 */
export function getWallet(): Keypair {
  if (!wallet) {
    if (!ENV.WALLET_PRIVATE_KEY) {
      throw new Error('WALLET_PRIVATE_KEY not set in environment');
    }
    
    try {
      const decoded = bs58.decode(ENV.WALLET_PRIVATE_KEY);
      wallet = Keypair.fromSecretKey(decoded);
      logger.info(`Wallet loaded: ${wallet.publicKey.toBase58().slice(0, 8)}...`);
    } catch (error) {
      throw new Error('Invalid WALLET_PRIVATE_KEY format. Must be base58 encoded.');
    }
  }
  return wallet;
}

/**
 * Get wallet SOL balance
 */
export async function getWalletBalance(): Promise<number> {
  const conn = getConnection();
  const w = getWallet();
  const balance = await conn.getBalance(w.publicKey);
  return balance / 1e9; // Convert lamports to SOL
}

/**
 * Send and confirm transaction with retry logic
 */
export async function sendAndConfirmTransaction(
  transaction: Transaction | VersionedTransaction,
  options?: SendOptions
): Promise<string> {
  const conn = getConnection();
  const w = getWallet();
  
  const sendOptions: SendOptions = {
    skipPreflight: false,
    maxRetries: 3,
    ...options,
  };
  
  let signature: string;
  
  if (transaction instanceof VersionedTransaction) {
    transaction.sign([w]);
    signature = await conn.sendTransaction(transaction, sendOptions);
  } else {
    transaction.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    transaction.feePayer = w.publicKey;
    transaction.sign(w);
    signature = await conn.sendRawTransaction(transaction.serialize(), sendOptions);
  }
  
  logger.debug(`Transaction sent: ${signature}`);
  
  // Wait for confirmation
  const confirmation = await conn.confirmTransaction(signature, 'confirmed');
  
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  logger.success(`Transaction confirmed: ${signature}`);
  return signature;
}

/**
 * Format SOL to lamports
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * 1e9);
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 500
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Retry ${i + 1}/${maxRetries} failed: ${lastError.message}`);
      
      if (i < maxRetries - 1) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
  }
  
  throw lastError;
}
