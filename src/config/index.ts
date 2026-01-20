import 'dotenv/config';
import {
  TOKEN_SAFETY,
  WALLET_DISTRIBUTION,
  AGE_CONTEXT_FILTER,
  VOLUME_MOMENTUM,
  ENTRY_CONDITIONS,
  ENTRY_EXECUTION,
  POSITION_SIZING,
  FEES_EXECUTION,
  SLIPPAGE,
  STOP_LOSS,
  TAKE_PROFIT,
  DEV_MONITORING,
  TIME_KILL_SWITCH,
  DAILY_LIMITS,
  WEEKLY_LIMITS,
  PAPER_TRADING,
} from './constants.js';

// Re-export all constants
export * from './constants.js';

// Environment-based config
export const ENV = {
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  SOLANA_WS_URL: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
  JITO_BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
} as const;

// Validate critical env vars
export function validateEnv(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!ENV.WALLET_PRIVATE_KEY) {
    errors.push('WALLET_PRIVATE_KEY is required');
  }
  
  if (!ENV.HELIUS_API_KEY && !ENV.BIRDEYE_API_KEY) {
    errors.push('At least one of HELIUS_API_KEY or BIRDEYE_API_KEY is required');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// Combined config object for easy access
export const CONFIG = {
  tokenSafety: TOKEN_SAFETY,
  walletDistribution: WALLET_DISTRIBUTION,
  ageContext: AGE_CONTEXT_FILTER,
  volumeMomentum: VOLUME_MOMENTUM,
  entry: {
    conditions: ENTRY_CONDITIONS,
    execution: ENTRY_EXECUTION,
  },
  positionSizing: POSITION_SIZING,
  fees: FEES_EXECUTION,
  slippage: SLIPPAGE,
  stopLoss: STOP_LOSS,
  takeProfit: TAKE_PROFIT,
  devMonitoring: DEV_MONITORING,
  timeKillSwitch: TIME_KILL_SWITCH,
  dailyLimits: DAILY_LIMITS,
  weeklyLimits: WEEKLY_LIMITS,
  paperTrading: PAPER_TRADING,
  env: ENV,
} as const;

export type Config = typeof CONFIG;
