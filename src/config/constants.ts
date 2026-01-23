/**
 * AXIOM BOT - HARD-CODED DISCIPLINE RULES
 * These values are battle-tested. DO NOT DEVIATE.
 */

// ============================================
// A. PRE-TRADE CHECKLIST THRESHOLDS
// ============================================

export const TOKEN_SAFETY = {
  // MANDATORY - Fail any = NO TRADE
  MINT_AUTHORITY_MUST_BE_DISABLED: true,
  FREEZE_AUTHORITY_MUST_BE_DISABLED: true,
  MAX_TRANSFER_TAX_PERCENT: 0,
  BLACKLIST_WHITELIST_MUST_BE_NONE: true,
  
  // LP Requirements
  VALID_LP_PLATFORMS: ['raydium', 'bags', 'meteora', 'meteora_v2', 'pump_amm'] as const,
  MIN_LP_SOL: 30,           // Ideal minimum
  ABSOLUTE_FLOOR_LP_SOL: 25, // Hard floor - below this = instant reject
} as const;

export const WALLET_DISTRIBUTION = {
  // Largest wallet (excluding LP) max percentage
  MAX_SINGLE_WALLET_PERCENT: 15,
  
  // Top 5 wallets combined max percentage
  MAX_TOP5_WALLETS_PERCENT: 40,
  
  // Dev wallet limits
  IDEAL_DEV_WALLET_MAX_PERCENT: 10,
  
  // If any wallet accumulates this % during your entry window = cancel
  ACCUMULATION_ALERT_PERCENT: 5,
} as const;

export const AGE_CONTEXT_FILTER = {
  // Token age in minutes
  MIN_AGE_MINUTES: 3,
  MAX_AGE_MINUTES: 20,
  
  // Reject if older than this (unless volume exploding)
  HARD_MAX_AGE_MINUTES: 30,
  
  // Reject fresh tokens (bot war zone)
  BOT_WAR_ZONE_MINUTES: 2,
  
  // Already pumped range (2x - 5x from launch)
  MIN_PUMP_MULTIPLIER: 2,
  MAX_PUMP_MULTIPLIER: 5,
} as const;

export const VOLUME_MOMENTUM = {
  // Pullback volume must be at least this % of pump volume
  MIN_PULLBACK_VOLUME_RATIO: 0.4, // 40%
  
  // Require at least 1 consolidation after first pump
  MIN_CONSOLIDATIONS_REQUIRED: 1,
  
  // Volume must be active (not dead post-pump)
  MIN_RECENT_VOLUME_SOL: 5, // Last 5 minutes
} as const;

// ============================================
// B. ENTRY LOGIC - FIRST PULLBACK CONTINUATION
// ============================================

export const ENTRY_CONDITIONS = {
  // Price retracement from local high
  MIN_RETRACEMENT_PERCENT: 30,
  MAX_RETRACEMENT_PERCENT: 50,
  
  // Red candles should be shrinking (last 2-3)
  MIN_SHRINKING_RED_CANDLES: 2,
  MAX_SHRINKING_RED_CANDLES: 3,
  
  // Buy volume must exceed sell volume on current candle
  BUY_SELL_VOLUME_RATIO_MIN: 1.0,
  
  // Price must hold above first consolidation or VWAP
  REQUIRE_SUPPORT_HOLD: true,
} as const;

export const ENTRY_EXECUTION = {
  // Split buy into tranches
  TRANCHE_1_PERCENT: 60, // On confirmation
  TRANCHE_2_PERCENT: 40, // If holds for 1-2 candles
  
  // Candles to wait before tranche 2
  TRANCHE_2_WAIT_CANDLES: 1,
  MAX_TRANCHE_2_WAIT_CANDLES: 2,
  
  // NEVER single-click full size
  SINGLE_CLICK_FULL_SIZE: false,
} as const;

// ============================================
// C. POSITION SIZING - HARD LIMITS
// ============================================

export const POSITION_SIZING = {
  // Assuming 1-2 SOL total wallet
  MAX_PER_TRADE_SOL: 0.25,
  IDEAL_PER_TRADE_SOL: 0.20,
  MIN_PER_TRADE_SOL: 0.15,
  
  // Maximum open trades at once
  MAX_OPEN_TRADES: 1, // 2+ = overleveraging
} as const;

// ============================================
// D. FEES & EXECUTION - BATTLE-TESTED
// ============================================

export const FEES_EXECUTION = {
  // Priority fee in SOL
  PRIORITY_FEE_SOL: 0.0007,
  
  // Jito bribe in SOL
  JITO_BRIBE_SOL: 0.0015,
  MAX_JITO_BRIBE_SOL: 0.0025, // Never exceed this
  
  // Max total transaction cost (round trip)
  MAX_ROUND_TRIP_COST_SOL: 0.004,
  
  // Congestion handling
  PRIORITY_FEE_CONGESTION_MULTIPLIER: 1.5,
} as const;

export const SLIPPAGE = {
  // Normal operations (live trading - accounts for volatility)
  BUY_SLIPPAGE_PERCENT: 10,
  SELL_SLIPPAGE_PERCENT: 12,
  
  // Paper trading - more realistic simulation (price impact only, no panic selling)
  PAPER_BUY_SLIPPAGE_PERCENT: 1,
  PAPER_SELL_SLIPPAGE_PERCENT: 1,
  
  // Emergency sell
  EMERGENCY_SELL_SLIPPAGE_PERCENT: 18,
  
  // If needs more than emergency = already over
  MAX_ACCEPTABLE_SLIPPAGE_PERCENT: 18,
} as const;

// ============================================
// E. STOP LOSS & TAKE PROFIT - AUTOMATED
// ============================================

export const STOP_LOSS = {
  // Hard stop loss percentage
  HARD_STOP_PERCENT: -6,
  
  // Time stop: if no higher high in X minutes, exit
  TIME_STOP_MINUTES: 4,
  MIN_TIME_STOP_MINUTES: 3,
  
  // No exceptions - small losses keep you alive
  ENFORCE_STRICTLY: true,
} as const;

export const TAKE_PROFIT = {
  // TP Ladder - DO NOT DEVIATE
  TP1_PERCENT: 20,
  TP1_SELL_PERCENT: 40, // Sell 40% at +20%
  
  TP2_PERCENT: 35,
  TP2_SELL_PERCENT: 30, // Sell 30% at +35%
  
  // Runner: remaining 30%
  RUNNER_PERCENT: 30,
  RUNNER_TRAILING_STOP_PERCENT: -10, // From local high
  
  // If momentum stalls, market sell runner
  STALL_DETECTION_ENABLED: true,
} as const;

// ============================================
// F. DEV & SMART WALLET MONITORING
// ============================================

export const DEV_MONITORING = {
  // Instant exit if dev sells more than this %
  DEV_SELL_EXIT_THRESHOLD_PERCENT: 25,
  
  // Any wallet dumps more than this % in < 60s = exit
  WHALE_DUMP_THRESHOLD_PERCENT: 10,
  WHALE_DUMP_TIME_WINDOW_SECONDS: 60,
  
  // LP removal detection
  LP_REMOVAL_INSTANT_EXIT: true,
} as const;

// ============================================
// G. TIME-BASED KILL SWITCH
// ============================================

export const TIME_KILL_SWITCH = {
  // If trade not profitable within X minutes = exit
  MAX_UNPROFITABLE_MINUTES: 10,
  MIN_UNPROFITABLE_MINUTES: 8,
  
  // No "let's see what happens" - dead coins don't revive
  ENFORCE_STRICTLY: true,
} as const;

// ============================================
// H. DAILY & WEEKLY GUARDRAILS
// ============================================

export const DAILY_LIMITS = {
  // Max trades per day
  MAX_TRADES_PER_DAY: 2,
  
  // Max daily loss in SOL
  MAX_DAILY_LOSS_SOL: 0.2,
  
  // Hit limit = bot disables itself
  AUTO_DISABLE_ON_LIMIT: true,
} as const;

export const WEEKLY_LIMITS = {
  // Stop trading if down this much
  MAX_WEEKLY_LOSS_SOL: 0.5,
  
  // Must review logs before resuming
  REQUIRE_LOG_REVIEW: true,
  
  // Survival > activity
  ENFORCE_STRICTLY: true,
} as const;

// ============================================
// PAPER TRADING MODE
// ============================================

export const PAPER_TRADING = {
  // Enable paper trading (no real transactions)
  ENABLED: process.env.PAPER_TRADE === 'true',
  
  // Starting simulated balance
  STARTING_BALANCE_SOL: 2.0,
  
  // Log level for paper trades
  VERBOSE: true,
} as const;

// ============================================
// PRICE MONITORING SETTINGS
// ============================================

export const PRICE_MONITOR = {
  // Use Helius WebSocket for on-chain price monitoring (truly real-time)
  // Requires HELIUS_API_KEY in environment
  USE_HELIUS: true,
  
  // Use both Helius and PumpPortal simultaneously
  // Helius for price, PumpPortal for trade metadata
  DUAL_SOURCE: false,
  
  // Fallback to PumpPortal if Helius fails
  FALLBACK_TO_PUMPPORTAL: true,
  
  // Maximum time (ms) without price update before considering stale
  STALE_PRICE_THRESHOLD_MS: 30000, // 30 seconds
} as const;

// ============================================
// TECHNICAL DEFAULTS
// ============================================

export const API_RETRY_ATTEMPTS = 3;
export const API_RETRY_DELAY_MS = 500;

// Jupiter API
export const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

// SOL mint address
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================
// AUTO-TRADE SETTINGS
// ============================================

export const AUTO_TRADE = {
  // Discovery settings
  DISCOVERY_POLL_INTERVAL_MS: 5000,    // Poll every 5 seconds
  CANDIDATE_QUEUE_MAX_SIZE: 50,        // Max candidates in queue
  CANDIDATE_COOLDOWN_MINUTES: 15,      // Cooldown for rejected tokens
  
  // Pipeline settings
  MAX_CONCURRENT_ANALYSIS: 2,          // Don't overload APIs
  TRADE_COOLDOWN_MS: 60000,            // 1 minute between trades
  AUTO_ENTER_ON_PASS: true,            // Enter automatically when checklist passes
  ENABLE_TRANCHE_2: true,              // Enable second tranche execution
  
  // Discovery filters (also in PUMP_FUN section)
  MIN_AGE_MINUTES: 2,
  MAX_AGE_MINUTES: 30,
  MIN_BONDING_CURVE_PROGRESS: 15,
  MAX_BONDING_CURVE_PROGRESS: 85,
  MIN_MARKET_CAP_USD: 8000,
  MAX_MARKET_CAP_USD: 50000,
  MIN_TRADE_COUNT: 5,
} as const;

// ============================================
// METIS API SETTINGS (Public Endpoint)
// ============================================

export const METIS_API = {
  // Public endpoint (has swap fees but works without API key)
  PUBLIC_ENDPOINT: 'https://public.jupiterapi.com',
  
  // Priority fee levels: 'low' | 'medium' | 'high' | 'veryHigh'
  DEFAULT_PRIORITY_FEE: 'high' as const,
  
  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 500,
  
  // Request timeout
  REQUEST_TIMEOUT_MS: 30000,
} as const;

// ============================================
// PUMP.FUN SPECIFIC SETTINGS
// ============================================

export const PUMP_FUN = {
  // Bonding curve progress requirements
  MIN_BONDING_CURVE_PROGRESS: 15, // Don't buy too early (< 15%)
  MAX_BONDING_CURVE_PROGRESS: 85, // Don't buy about to graduate (> 85%)
  
  // Ideal sweet spot for entry
  IDEAL_PROGRESS_MIN: 25,
  IDEAL_PROGRESS_MAX: 70,
  
  // Market cap requirements (USD)
  MIN_MARKET_CAP_USD: 8000,   // At least $8k mcap
  MAX_MARKET_CAP_USD: 50000,  // Below $50k (before graduation)
  
  // Age requirements (different from Raydium tokens)
  MIN_AGE_MINUTES: 2,         // Slightly younger OK on pump
  MAX_AGE_MINUTES: 30,        // Older OK if momentum
  BOT_WAR_ZONE_MINUTES: 1,    // < 1 min = extreme danger
  
  // Reply/engagement minimums
  MIN_REPLY_COUNT: 3,         // Some engagement required
  
  // Graduation threshold
  GRADUATION_SOL: 85,         // SOL needed to graduate to Raydium
  GRADUATION_MCAP_USD: 69000, // ~$69k mcap = graduation
  
  // Don't trade tokens about to graduate (migration risk)
  GRADUATION_WARNING_PERCENT: 90,
} as const;
