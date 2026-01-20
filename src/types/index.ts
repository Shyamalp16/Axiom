/**
 * Core type definitions for the Axiom Trading Bot
 */

// ============================================
// TOKEN TYPES
// ============================================

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  supply: number;
  createdAt: Date;
  ageMinutes: number;
}

export interface TokenSafetyResult {
  passed: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  transferTaxPercent: number;
  hasBlacklistWhitelist: boolean;
  lpPlatform: 'raydium' | 'bags' | 'meteora' | 'meteora_v2' | 'pump_amm' | 'pumpfun' | 'unknown';
  lpSolAmount: number;
  failures: string[];
}

export interface WalletDistributionResult {
  passed: boolean;
  largestWalletPercent: number;
  top5WalletsPercent: number;
  devWalletPercent: number;
  devWalletIncreasing: boolean;
  failures: string[];
  holders: HolderInfo[];
}

export interface HolderInfo {
  address: string;
  balance: number;
  percent: number;
  isLP: boolean;
  isDev: boolean;
}

// ============================================
// MARKET DATA TYPES
// ============================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

export interface MarketData {
  mint: string;
  priceUsd: number;
  priceSol: number;
  volume24h: number;
  volumeRecent: number; // Last 5 mins
  marketCap: number;
  liquidity: number;
  priceChange: PriceChange;
  candles: Candle[];
}

export interface PriceChange {
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}

export interface VolumeAnalysis {
  passed: boolean;
  pumpVolume: number;
  pullbackVolume: number;
  pullbackVolumeRatio: number;
  consolidationsDetected: number;
  hasVerticalWickDumps: boolean;
  failures: string[];
}

// ============================================
// ENTRY ANALYSIS TYPES
// ============================================

export interface EntryAnalysis {
  shouldEnter: boolean;
  retracementPercent: number;
  shrinkingRedCandles: number;
  buyVolumeRatio: number;
  holdingSupport: boolean;
  supportLevel: number;
  localHigh: number;
  failures: string[];
}

export interface EntrySignal {
  mint: string;
  entryPrice: number;
  suggestedSize: number;
  tranche1Size: number;
  tranche2Size: number;
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  confidence: 'high' | 'medium' | 'low';
  timestamp: Date;
}

// ============================================
// POSITION TYPES
// ============================================

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  costBasis: number; // Total SOL spent
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  highestPrice: number; // For trailing stop
  entryTime: Date;
  tranches: Tranche[];
  tpLevelsHit: number[];
  status: PositionStatus;
}

export interface Tranche {
  size: number;
  price: number;
  timestamp: Date;
}

export type PositionStatus = 
  | 'pending_entry'
  | 'partial_fill'
  | 'active'
  | 'partial_exit'
  | 'closed';

// ============================================
// ORDER TYPES
// ============================================

export interface Order {
  id: string;
  positionId: string;
  mint: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size: number;
  price?: number;
  slippage: number;
  status: OrderStatus;
  txSignature?: string;
  filledSize?: number;
  filledPrice?: number;
  fees?: number;
  timestamp: Date;
  reason: OrderReason;
}

export type OrderStatus = 
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'filled'
  | 'failed'
  | 'cancelled';

export type OrderReason = 
  | 'entry_tranche_1'
  | 'entry_tranche_2'
  | 'tp1'
  | 'tp2'
  | 'runner_exit'
  | 'stop_loss'
  | 'time_stop'
  | 'dev_sell_exit'
  | 'whale_dump_exit'
  | 'lp_removal_exit'
  | 'manual_exit'
  | 'daily_limit_exit'
  | 'emergency_exit';

// ============================================
// MONITORING TYPES
// ============================================

export interface DevWalletActivity {
  address: string;
  action: 'buy' | 'sell' | 'transfer';
  amount: number;
  percentOfHoldings: number;
  timestamp: Date;
  txSignature: string;
}

export interface AlertType {
  type: 'dev_sell' | 'whale_dump' | 'lp_removal' | 'accumulation';
  severity: 'warning' | 'critical';
  message: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

// ============================================
// TRADE LOG TYPES
// ============================================

export interface TradeLog {
  id: string;
  mint: string;
  symbol: string;
  entryReason: string[];
  checklistPassed: string[];
  checklistFailed: string[];
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  slippageExpected: number;
  slippageActual: number;
  timeInTrade: number; // seconds
  exitReason: OrderReason;
  timestamp: Date;
  notes?: string;
}

// ============================================
// BOT STATE TYPES
// ============================================

export interface BotState {
  isRunning: boolean;
  isDisabled: boolean;
  disableReason?: string;
  dailyTradeCount: number;
  dailyPnl: number;
  weeklyPnl: number;
  activePositions: Position[];
  lastTradeTime?: Date;
  startTime: Date;
}

export interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  biggestWin: number;
  biggestLoss: number;
  avgTimeInTrade: number;
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RoutePlan[];
}

export interface RoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidity: number;
  price: number;
  volume24h: number;
  priceChange24h: number;
  mc: number;
  holder: number;
  supply: number;
}
