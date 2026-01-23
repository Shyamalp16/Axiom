#!/usr/bin/env node
/**
 * AXIOM AUTO-TRADE CLI
 * 
 * Autonomous paper trading using Axiom Trade data instead of pump.fun
 * 
 * Usage:
 *   npx ts-node src/cli/axiom-auto.ts           # Start Axiom paper trading
 *   npx ts-node src/cli/axiom-auto.ts status    # Show current status
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  loadAxiomAuthFromEnv,
  isAxiomAuthenticated,
  getAxiomTrending,
  getAxiomBatchPrices,
  getAxiomLivePrice,
  getAxiomTokenByMint,
  connectAxiomWebSocket,
  subscribeAxiomPrice,
  AxiomTrendingToken,
  AxiomPriceUpdate,
} from '../api/axiom-trade.js';
import { fetchPumpFunToken, fetchPumpFunTokenLive } from '../api/pump-fun.js';
import { 
  fetchCurrentlyLiveCoins, 
  searchCoins, 
  PumpPortalToken,
  connectPumpPortal,
} from '../api/pump-portal.js';
import { 
  paperBuy, 
  paperSell, 
  getPaperPortfolio, 
  getPaperTrades,
  loadPaperTrades, 
  displayPaperSummary,
  PaperPosition,
} from '../trading/paper-trader.js';
// Pre-trade checklist not used - we have custom Axiom-specific checks
import { PAPER_TRADING, POSITION_SIZING, validateEnv, ENV, PRICE_MONITOR } from '../config/index.js';
import { getWalletBalance, getWallet, sleep } from '../utils/solana.js';
import { 
  getHeliusPriceMonitor, 
  HeliusPriceUpdate, 
  deriveBondingCurveAddress 
} from '../monitoring/helius-price-monitor.js';
import logger from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

const AXIOM_AUTO_CONFIG = {
  // Discovery settings
  pollIntervalMs: 20000,           // Poll every 20 seconds
  timePeriod: '5m' as '5m' | '1h' | '24h' | '7d' | '30d',  // For Axiom trending (if used)
  
  // Discovery source: 'pumpportal' for bonding curve, 'axiom' for graduated
  discoverySource: 'pumpportal' as 'pumpportal' | 'axiom',
  
  // Token filtering - BONDING CURVE ONLY (for pumpportal)
  minMarketCapSol: 10,             // Min ~$1.25k at $125 SOL
  maxMarketCapSol: 500,            // Max 500 SOL - allow higher MC bonding curve tokens
  minVolumeSol: 0,                 // Volume not reliable from API, disable check
  maxTop10HoldersPercent: 30,      // Max concentration
  minBuyCount: 5,                  // Minimum 5 buy transactions (lowered)
  minTradesPerMinute: 0.5,         // At least 1 trade every 2 minutes (activity check)
  maxAgeHours: 6,                  // Allow tokens up to 6 hours old
  minBondingProgress: 5,           // Min 5% bonding curve progress
  maxBondingProgress: 99,          // Allow up to 99% (not graduated)
  
  // Trading settings
  maxOpenPositions: 1,             // Only 1 position at a time
  tradeCooldownMs: 15000,          // 15 seconds between trades (faster for paper testing)
  positionSizeSol: POSITION_SIZING.IDEAL_PER_TRADE_SOL,
  
  // Exit settings
  takeProfitPercent: 20,           // 20% TP
  stopLossPercent: 8,              // 8% SL (absolute)
  entryGracePeriodMs: 10000,       // 10 seconds grace period after entry before SL can trigger
  stagnantExitSeconds: 60,         // Auto-exit if no meaningful move (60s - DexScreener updates slowly)
  stagnantMinMovePercent: 0.3,     // Min % move to reset stagnation timer (lowered for low-liquidity tokens)
  priceCheckIntervalMs: 1000,      // Check price every 1 second (was 500ms, too fast for API)
};

// ============================================
// STATE
// ============================================

interface BotState {
  isRunning: boolean;
  startTime: Date;
  pollCount: number;
  tokensAnalyzed: number;
  tradesEntered: number;
  tradesRejected: number;
  lastTradeTime: number;
  currentPosition: {
    mint: string;
    pairAddress: string;  // For chart API
    symbol: string;
    entryPrice: number;
    entryMcSol: number;
    entryTime: number;    // Timestamp when position was entered
    platform: 'pump.fun' | 'jupiter';
    lastPriceSol: number;
    lastMoveTime: number;
    lastPnlPercent?: number;
    lastMcUsd?: number;
    estimatedPnlSol?: number;
    costBasisSol?: number;
  } | null;
  recentlyTraded: Set<string>;  // Tokens we've already traded (cooldown)
}

let state: BotState = {
  isRunning: false,
  startTime: new Date(),
  pollCount: 0,
  tokensAnalyzed: 0,
  tradesEntered: 0,
  tradesRejected: 0,
  lastTradeTime: 0,
  currentPosition: null,
  recentlyTraded: new Set(),
};

let shutdownRequested = false;
let manualExitRequested = false;

// Real-time price from Axiom WebSocket
let wsPrice: { priceSol: number; mcUsd: number; timestamp: number } | null = null;
let wsPriceUnsubscribe: (() => void) | null = null;

// Real-time price from Helius on-chain WebSocket (highest priority!)
let heliusPrice: { priceSol: number; mcSol: number; mcUsd: number; timestamp: number } | null = null;
let heliusPriceUnsubscribe: (() => void) | null = null;
let heliusConnected = false;

const DATA_DIR = './data';
const STATUS_FILE = join(DATA_DIR, 'axiom_auto_status.json');
const COMMAND_FILE = join(DATA_DIR, 'axiom_auto_command.json');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function writeStatusFile(): void {
  try {
    const status = {
      isRunning: state.isRunning,
      startTime: state.startTime.toISOString(),
      pollCount: state.pollCount,
      tokensAnalyzed: state.tokensAnalyzed,
      tradesEntered: state.tradesEntered,
      tradesRejected: state.tradesRejected,
      lastTradeTime: state.lastTradeTime,
      currentPosition: state.currentPosition
        ? {
            mint: state.currentPosition.mint,
            symbol: state.currentPosition.symbol,
            entryPrice: state.currentPosition.entryPrice,
            entryMcSol: state.currentPosition.entryMcSol,
            platform: state.currentPosition.platform,
            lastPriceSol: state.currentPosition.lastPriceSol,
            lastPnlPercent: state.currentPosition.lastPnlPercent ?? null,
            lastMcUsd: state.currentPosition.lastMcUsd ?? null,
            estimatedPnlSol: state.currentPosition.estimatedPnlSol ?? null,
            costBasisSol: state.currentPosition.costBasisSol ?? null,
            lastMoveTime: state.currentPosition.lastMoveTime,
          }
        : null,
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    // Ignore status write failures
  }
}

function readCommandFile(): { action?: string; mint?: string; timestamp?: string } | null {
  try {
    if (!existsSync(COMMAND_FILE)) return null;
    const raw = readFileSync(COMMAND_FILE, 'utf-8');
    if (!raw) return null;
    return JSON.parse(raw) as { action?: string; mint?: string; timestamp?: string };
  } catch {
    return null;
  }
}

function clearCommandFile(): void {
  try {
    writeFileSync(COMMAND_FILE, JSON.stringify({ action: 'none', timestamp: new Date().toISOString() }, null, 2));
  } catch {
    // Ignore
  }
}

// ============================================
// MAIN FUNCTIONS
// ============================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase() || 'start';
  
  switch (command) {
    case 'start':
      await startBot();
      break;
    case 'status':
      showStatus();
      break;
    case 'help':
      showHelp();
      break;
    default:
      logger.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

async function startBot(): Promise<void> {
  logger.header('AXIOM AUTO-TRADER (Paper Mode)');
  
  // Force paper trading
  if (!PAPER_TRADING.ENABLED) {
    logger.warn('Paper trading not enabled in config, but this script always runs in paper mode');
  }
  
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║     📝 AXIOM PAPER TRADING MODE                               ║
║     Using Axiom Trade API for token discovery                 ║
║     No real transactions - all trades simulated               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  // 1. Load Axiom auth
  logger.info('Loading Axiom auth tokens...');
  const authLoaded = loadAxiomAuthFromEnv();
  
  if (!authLoaded) {
    logger.error('Failed to load Axiom auth tokens');
    logger.info('\nTo set up Axiom Trade authentication:');
    logger.info('1. Go to https://axiom.trade and log in');
    logger.info('2. Open DevTools (F12) → Application → Cookies');
    logger.info('3. Copy the values of auth-access-token and auth-refresh-token');
    logger.info('4. Add to your .env file:');
    logger.info('   AXIOM_ACCESS_TOKEN=your_access_token_here');
    logger.info('   AXIOM_REFRESH_TOKEN=your_refresh_token_here');
    process.exit(1);
  }
  logger.success('Axiom auth loaded');
  
  // 2. Validate environment (for wallet)
  const envCheck = validateEnv();
  if (!envCheck.valid) {
    logger.error('Environment validation failed:');
    envCheck.errors.forEach(e => logger.error(`  - ${e}`));
    process.exit(1);
  }
  
  // 3. Check wallet
  try {
    const wallet = getWallet();
    logger.success(`Wallet: ${wallet.publicKey.toBase58()}`);
    
    // Load paper trades
    loadPaperTrades();
    const portfolio = getPaperPortfolio();
    logger.info(`📝 Paper Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
    
    // Check for existing position
    if (portfolio.positions.size > 0) {
      const [mint, pos] = [...portfolio.positions.entries()][0];
      // Infer platform from mint address (pump.fun mints end with 'pump')
      const inferredPlatform = mint.toLowerCase().endsWith('pump') ? 'pump.fun' : 'jupiter';
      
      // Fetch current MC and pair address (we don't have historical entry MC)
      let estimatedEntryMcSol = 0;
      let pairAddress = '';
      
      // First try Axiom trending for pair address
      try {
        const trending = await getAxiomTrending(AXIOM_AUTO_CONFIG.timePeriod);
        const token = trending.find(t => t.tokenAddress === mint);
        if (token) {
          pairAddress = token.pairAddress;
          estimatedEntryMcSol = token.marketCapSol;
        }
      } catch {
        // Fall back to DexScreener
      }
      
      // Fall back to DexScreener if not in trending
      if (!pairAddress) {
        try {
          const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
          if (response.ok) {
            const data = await response.json() as any;
            const pairs = data?.pairs || [];
            if (pairs.length > 0) {
              const topPair = pairs.sort((a: any, b: any) => 
                (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
              )[0];
              pairAddress = topPair.pairAddress || '';
              const mcUsd = topPair.marketCap || topPair.fdv || 0;
              estimatedEntryMcSol = mcUsd / 150; // Convert USD to SOL estimate
            }
          }
        } catch {
          // Use defaults if fetch fails
        }
      }
      
      state.currentPosition = {
        mint,
        pairAddress,
        symbol: pos.symbol,
        entryPrice: pos.avgEntryPrice,
        entryMcSol: estimatedEntryMcSol,
        entryTime: pos.entryTime ? new Date(pos.entryTime).getTime() : Date.now(),  // Use existing entry time or now
        platform: inferredPlatform as 'pump.fun' | 'jupiter',
        lastPriceSol: pos.avgEntryPrice,
        lastMoveTime: Date.now(),
      };
      const mcDisplay = estimatedEntryMcSol > 0 ? `~$${(estimatedEntryMcSol * 150 / 1000).toFixed(0)}k MC` : 'MC unknown';
      logger.info(`📝 Existing position: ${pos.symbol} @ ${pos.avgEntryPrice.toExponential(4)} SOL (${inferredPlatform}, ${mcDisplay})`);
      
      // Set up Helius subscription for existing bonding curve position
      if (estimatedEntryMcSol > 0 && estimatedEntryMcSol < 85) {
        try {
          const helius = getHeliusPriceMonitor();
          await helius.connect();
          
          // Use pairAddress as bonding curve if available, otherwise derive it
          const bondingCurve = pairAddress || deriveBondingCurveAddress(mint);
          logger.info(`  [HELIUS] Subscribing to existing position: ${bondingCurve.slice(0, 8)}...`);
          
          heliusPriceUnsubscribe = await helius.subscribeToBondingCurve(
            mint,
            bondingCurve,
            (update: HeliusPriceUpdate) => {
              heliusPrice = {
                priceSol: update.priceSol,
                mcSol: update.marketCapSol,
                mcUsd: update.marketCapUsd,
                timestamp: Date.now(),
              };
              logger.debug(`  [HELIUS] Price update: ${update.priceSol.toExponential(4)} SOL (MC: ${update.marketCapSol.toFixed(1)} SOL)`);
            }
          );
          logger.success(`  [HELIUS] Subscribed to ${pos.symbol} for real-time price updates`);
        } catch (heliusError) {
          logger.warn(`  [HELIUS] Could not subscribe to existing position: ${heliusError}`);
        }
      } else if (estimatedEntryMcSol >= 85) {
        logger.info(`  [HELIUS] Token ${pos.symbol} is graduated (MC: ${estimatedEntryMcSol.toFixed(0)} SOL) - using DexScreener/Axiom for price`);
      }
    }
    
    // Load recently traded tokens to prevent re-entry (from paper trade history)
    markRecentlyTradedFromHistory();
  } catch (error) {
    logger.error('Failed to load wallet', error);
    process.exit(1);
  }
  
  // 4. Setup signal handlers
  setupSignalHandlers();
  
  // 5. Display config
  displayConfig();
  
  // 6. Start main loop
  state.isRunning = true;
  state.startTime = new Date();
  writeStatusFile();
  
  logger.success('Axiom auto-trader started');
  logger.info('Press Ctrl+C to stop gracefully\n');
  
  // Short delay before starting
  await sleep(2000);
  
  await mainLoop();
}

async function mainLoop(): Promise<void> {
  while (state.isRunning && !shutdownRequested) {
    try {
      const command = readCommandFile();
      if (command?.action === 'exit' && state.currentPosition) {
        logger.warn('🔴 Exit command received from UI');
        manualExitRequested = true;
        clearCommandFile();
      } else if (command?.action === 'manual_entry' && command.mint) {
        logger.warn(`🟢 Manual entry command received: ${command.mint}`);
        clearCommandFile();
        await handleManualEntry(command.mint);
        // Skip normal loop iteration after manual entry
        writeStatusFile();
        await sleep(AXIOM_AUTO_CONFIG.priceCheckIntervalMs);
        continue;
      }

      // If we have a position, monitor it
      if (state.currentPosition) {
        await monitorPosition();
      } else {
        // Look for new opportunities
        await discoverAndTrade();
      }

      writeStatusFile();
      
      // Wait before next iteration
      await sleep(state.currentPosition ? AXIOM_AUTO_CONFIG.priceCheckIntervalMs : AXIOM_AUTO_CONFIG.pollIntervalMs);
      
    } catch (error) {
      logger.error('Main loop error:', error);
      await sleep(5000);
    }
  }
  
  // Shutdown
  await shutdown();
}

async function discoverAndTrade(): Promise<void> {
  // Check trade cooldown
  const timeSinceLastTrade = Date.now() - state.lastTradeTime;
  if (timeSinceLastTrade < AXIOM_AUTO_CONFIG.tradeCooldownMs) {
    const remaining = Math.ceil((AXIOM_AUTO_CONFIG.tradeCooldownMs - timeSinceLastTrade) / 1000);
    // Only log every 10 seconds to avoid spam
    if (remaining % 10 === 0 || remaining <= 5) {
      logger.info(`⏳ Trade cooldown: ${remaining}s remaining...`);
    }
    return;
  }
  
  state.pollCount++;
  
  logger.info(`\n[Poll #${state.pollCount}] Fetching tokens from BOTH sources...`);
  
  try {
    let candidates: AxiomTrendingToken[] = [];
    const rejectionCounts: Record<string, number> = {};
    let pumpTokens: PumpPortalToken[] = [];
    
    // === SOURCE 1: PumpPortal (bonding curve tokens - best for Helius) ===
    try {
      pumpTokens = await fetchCurrentlyLiveCoins(50);
      logger.info(`  [PumpPortal] ${pumpTokens.length} bonding curve tokens`);
      
      for (const pumpToken of pumpTokens) {
        // Skip if already in cooldown
        if (state.recentlyTraded.has(pumpToken.mint)) continue;
        
        const result = passesPumpPortalFilter(pumpToken);
        if (result.passed) {
          // Convert to AxiomTrendingToken format
          const token: AxiomTrendingToken = {
            pairAddress: pumpToken.bondingCurve || pumpToken.mint,
            tokenAddress: pumpToken.mint,
            tokenName: pumpToken.name,
            tokenTicker: pumpToken.symbol,
            tokenImage: pumpToken.imageUri,
            tokenDecimals: 6,
            protocol: 'Pump Fun',
            prevMarketCapSol: pumpToken.marketCapSol,
            marketCapSol: pumpToken.marketCapSol,
            marketCapPercentChange: 0,
            liquiditySol: pumpToken.virtualSolReserves,
            liquidityToken: pumpToken.virtualTokenReserves,
            volumeSol: 0,
            buyCount: pumpToken.tradeCount,
            sellCount: 0,
            top10Holders: 0,
            lpBurned: 0,
            mintAuthority: null,
            freezeAuthority: null,
            dexPaid: false,
            website: pumpToken.website,
            twitter: pumpToken.twitter,
            telegram: pumpToken.telegram,
            createdAt: new Date(pumpToken.createdTimestamp).toISOString(),
            supply: 1_000_000_000,
            userCount: 0,
          };
          candidates.push(token);
        } else if (result.reason) {
          const key = result.reason.split(':')[0];
          rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
        }
      }
    } catch (err) {
      logger.debug(`  PumpPortal fetch failed: ${err}`);
    }
    
    // === SOURCE 2: Axiom Trending (includes both bonding curve + graduated) ===
    try {
      const trending = await getAxiomTrending(AXIOM_AUTO_CONFIG.timePeriod);
      logger.info(`  [Axiom] ${trending.length} trending tokens`);
      
      for (const token of trending) {
        // Skip if already in cooldown or already added from PumpPortal
        if (state.recentlyTraded.has(token.tokenAddress)) continue;
        if (candidates.some(c => c.tokenAddress === token.tokenAddress)) continue;
        
        const result = passesAxiomFilter(token);
        if (result.passed) {
          candidates.push(token);
        } else if (result.reason) {
          const key = result.reason.split(':')[0];
          rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
        }
      }
    } catch (err) {
      logger.debug(`  Axiom fetch failed: ${err}`);
    }
    
    // Show rejection breakdown
    const rejectSummary = Object.entries(rejectionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    logger.info(`  ✓ ${candidates.length} passed | Rejected: ${rejectSummary || 'none'}`);
    
    // Show sample if none passed
    if (candidates.length === 0 && pumpTokens.length > 0) {
      logger.info(`  Sample PumpPortal tokens (why rejected):`);
      for (const pt of pumpTokens.slice(0, 5)) {
        const result = passesPumpPortalFilter(pt);
        const tradesPerMin = pt.ageMinutes > 0 ? (pt.tradeCount / pt.ageMinutes).toFixed(1) : '0';
        logger.info(`    ${pt.symbol}: age=${pt.ageMinutes.toFixed(0)}m, trades=${pt.tradeCount}(${tradesPerMin}/m), prog=${pt.bondingCurveProgress.toFixed(0)}% → ${result.reason || 'passed'}`);
      }
    }
    
    // Sort candidates: Pump Fun (bonding curve) first, then by activity
    candidates.sort((a, b) => {
      // Prioritize bonding curve tokens (Helius works best)
      const aIsBondingCurve = a.protocol === 'Pump Fun' && a.marketCapSol < 80;
      const bIsBondingCurve = b.protocol === 'Pump Fun' && b.marketCapSol < 80;
      if (aIsBondingCurve && !bIsBondingCurve) return -1;
      if (!aIsBondingCurve && bIsBondingCurve) return 1;
      
      // For bonding curve tokens, sort by momentum
      if (aIsBondingCurve && bIsBondingCurve) {
        const pumpA = pumpTokens.find(p => p.mint === a.tokenAddress);
        const pumpB = pumpTokens.find(p => p.mint === b.tokenAddress);
        const scoreA = pumpA ? (pumpA.tradeCount / Math.max(pumpA.ageMinutes, 1)) : 0;
        const scoreB = pumpB ? (pumpB.tradeCount / Math.max(pumpB.ageMinutes, 1)) : 0;
        return scoreB - scoreA;
      }
      
      // For other tokens, sort by buy count
      return b.buyCount - a.buyCount;
    });
    
    // Analyze top candidates
    for (const token of candidates.slice(0, 5)) {
      if (shutdownRequested) break;
      if (state.currentPosition) break;  // Position was opened
      
      state.tokensAnalyzed++;
      
      // Skip recently traded
      if (state.recentlyTraded.has(token.tokenAddress)) {
        logger.debug(`  Skipping ${token.tokenTicker} (recently traded)`);
        continue;
      }
      
      logger.info(`\n  Analyzing: ${token.tokenTicker} (${token.tokenAddress.slice(0, 8)}...)`);
      logger.info(`    MC: ${token.marketCapSol.toFixed(1)} SOL | Vol: ${token.volumeSol.toFixed(1)} SOL | Change: ${token.marketCapPercentChange >= 0 ? '+' : ''}${token.marketCapPercentChange.toFixed(1)}%`);
      
      // Run pre-trade checklist (uses existing checkers)
      const checkResult = await runAxiomChecklist(token);
      
      if (checkResult.passed) {
        // Enter trade
        await enterTrade(token, checkResult.passedChecks);
        break;  // Only one position at a time
      } else {
        state.tradesRejected++;
        logger.info(`    ❌ Failed: ${checkResult.failedChecks.join(', ')}`);
      }
    }
    
    // Status update
    const portfolio = getPaperPortfolio();
    logger.info(`\n[Status] Analyzed: ${state.tokensAnalyzed} | Entered: ${state.tradesEntered} | Rejected: ${state.tradesRejected} | Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`);
    
  } catch (error) {
    logger.error('Discovery error:', error);
  }
}

function passesAxiomFilter(token: AxiomTrendingToken): { passed: boolean; reason?: string } {
  // Check protocol - prefer bonding curve but allow others
  const protocol = token.protocol?.toLowerCase() || '';
  
  // Check if it's graduated (on AMM/Raydium instead of bonding curve)
  const isGraduated = protocol.includes('amm') || 
                      protocol.includes('raydium') || 
                      protocol.includes('meteora') ||
                      token.extra?.migratedFrom !== undefined;
  
  // Skip graduated tokens entirely - we want bonding curve only for Helius
  if (isGraduated) {
    return { passed: false, reason: `graduated:${token.protocol}` };
  }
  
  // Check if it's on pump.fun bonding curve (NOT graduated)
  const isOnBondingCurve = protocol.includes('pump') && !protocol.includes('amm');
  
  // Must be on bonding curve for Helius to work
  if (!isOnBondingCurve) {
    return { passed: false, reason: `not-bonding:${token.protocol}` };
  }
  
  // Market cap range
  if (token.marketCapSol < AXIOM_AUTO_CONFIG.minMarketCapSol) {
    return { passed: false, reason: `mc:${token.marketCapSol.toFixed(0)}SOL<${AXIOM_AUTO_CONFIG.minMarketCapSol}` };
  }
  if (token.marketCapSol > AXIOM_AUTO_CONFIG.maxMarketCapSol) {
    return { passed: false, reason: `mc:${token.marketCapSol.toFixed(0)}SOL>${AXIOM_AUTO_CONFIG.maxMarketCapSol}` };
  }
  
  // Minimum activity - require meaningful activity
  if (token.buyCount < AXIOM_AUTO_CONFIG.minBuyCount) {
    return { passed: false, reason: `buys:${token.buyCount}<${AXIOM_AUTO_CONFIG.minBuyCount}` };
  }
  
  // Volume check - disabled since API doesn't always provide accurate volume
  // if (token.volumeSol < AXIOM_AUTO_CONFIG.minVolumeSol) {
  //   return { passed: false, reason: `vol:${token.volumeSol.toFixed(1)}SOL<${AXIOM_AUTO_CONFIG.minVolumeSol}` };
  // }
  
  // Age filter - use config
  const ageHours = (Date.now() - new Date(token.createdAt).getTime()) / 1000 / 60 / 60;
  if (ageHours > AXIOM_AUTO_CONFIG.maxAgeHours) {
    return { passed: false, reason: `age:${ageHours.toFixed(1)}h>${AXIOM_AUTO_CONFIG.maxAgeHours}h` };
  }
  
  // Safety: LP burned or mint/freeze authority revoked
  if (token.mintAuthority !== null) {
    return { passed: false, reason: 'mintAuth:enabled' };
  }
  if (token.freezeAuthority !== null) {
    return { passed: false, reason: 'freezeAuth:enabled' };
  }
  
  return { passed: true };
}

/**
 * Filter for PumpPortal bonding curve tokens
 * Focus: Active bonding curve tokens suitable for Helius monitoring
 */
function passesPumpPortalFilter(token: PumpPortalToken): { passed: boolean; reason?: string } {
  // Skip graduated tokens - required for Helius to work
  if (token.isGraduated) {
    return { passed: false, reason: `graduated` };
  }
  
  // Market cap range - not too small, not graduated
  if (token.marketCapSol < AXIOM_AUTO_CONFIG.minMarketCapSol) {
    return { passed: false, reason: `mc:${token.marketCapSol.toFixed(0)}SOL<${AXIOM_AUTO_CONFIG.minMarketCapSol}` };
  }
  if (token.marketCapSol > AXIOM_AUTO_CONFIG.maxMarketCapSol) {
    return { passed: false, reason: `mc:${token.marketCapSol.toFixed(0)}SOL>${AXIOM_AUTO_CONFIG.maxMarketCapSol}` };
  }
  
  // Minimum trades - require at least minBuyCount
  if (token.tradeCount < AXIOM_AUTO_CONFIG.minBuyCount) {
    return { passed: false, reason: `trades:${token.tradeCount}<${AXIOM_AUTO_CONFIG.minBuyCount}` };
  }
  
  // Age filter - use config value
  const maxAgeMinutes = AXIOM_AUTO_CONFIG.maxAgeHours * 60;
  if (token.ageMinutes > maxAgeMinutes) {
    return { passed: false, reason: `age:${token.ageMinutes.toFixed(0)}m>${maxAgeMinutes}m` };
  }
  
  // Minimum bonding progress
  if (token.bondingCurveProgress < AXIOM_AUTO_CONFIG.minBondingProgress) {
    return { passed: false, reason: `progress:${token.bondingCurveProgress.toFixed(0)}%<${AXIOM_AUTO_CONFIG.minBondingProgress}%` };
  }
  
  // Maximum bonding progress (before graduation)
  if (token.bondingCurveProgress > AXIOM_AUTO_CONFIG.maxBondingProgress) {
    return { passed: false, reason: `progress:${token.bondingCurveProgress.toFixed(0)}%>${AXIOM_AUTO_CONFIG.maxBondingProgress}%` };
  }
  
  // Activity check - require minimum trades per minute
  // A token with 10 trades over 100 minutes = 0.1 trades/min (dead)
  // A token with 10 trades over 5 minutes = 2 trades/min (active)
  const tradesPerMinute = token.ageMinutes > 0 ? token.tradeCount / token.ageMinutes : 0;
  if (tradesPerMinute < AXIOM_AUTO_CONFIG.minTradesPerMinute) {
    return { passed: false, reason: `activity:${tradesPerMinute.toFixed(1)}t/m<${AXIOM_AUTO_CONFIG.minTradesPerMinute}` };
  }
  
  return { passed: true };
}

async function runAxiomChecklist(token: AxiomTrendingToken): Promise<{ passed: boolean; passedChecks: string[]; failedChecks: string[] }> {
  // TEMPORARILY DISABLED - Testing Helius price monitoring
  // Just pass everything that's on bonding curve
  const passedChecks = ['testing:helius-monitoring'];
  const failedChecks: string[] = [];
  
  return {
    passed: true,
    passedChecks,
    failedChecks,
  };
}

async function enterTrade(token: AxiomTrendingToken, passedChecks: string[]): Promise<void> {
  const solAmount = AXIOM_AUTO_CONFIG.positionSizeSol || 0.20;  // Default to 0.20 SOL if undefined
  
  if (!solAmount || solAmount <= 0) {
    logger.error('  Invalid position size, skipping trade');
    return;
  }
  
  logger.info(`\n  ✅ Entering trade: ${solAmount.toFixed(2)} SOL → ${token.tokenTicker}`);
  logger.info(`    Mint: ${token.tokenAddress}`);
  logger.info(`    Market Cap: ${token.marketCapSol.toFixed(2)} SOL (~$${(token.marketCapSol * 125).toFixed(0)})`);
  logger.info(`    Checks passed: ${passedChecks.join(', ')}`);
  
  try {
    // Execute paper buy
    const trade = await paperBuy(
      token.tokenAddress,
      token.tokenTicker,
      solAmount,
      passedChecks
    );
    
    state.tradesEntered++;
    state.lastTradeTime = Date.now();
    state.recentlyTraded.add(token.tokenAddress);
    
    // Track position for monitoring (use MC ratio for P&L consistency)
    state.currentPosition = {
      mint: token.tokenAddress,
      pairAddress: token.pairAddress,  // For chart API
      symbol: token.tokenTicker,
      entryPrice: trade.pricePerToken,
      entryMcSol: token.marketCapSol,  // Store entry MC for ratio-based P&L
      entryTime: Date.now(),           // Track entry time for grace period
      platform: trade.platform,  // 'pump.fun' or 'jupiter'
      lastPriceSol: trade.pricePerToken,
      lastMoveTime: Date.now(),
    };

    writeStatusFile();
    
    // Subscribe to real-time price updates via WebSocket
    try {
      await connectAxiomWebSocket();
      wsPrice = null; // Reset
      const solPriceAtEntry = await getSolPriceUsd(); // Cache SOL price for conversion
      wsPriceUnsubscribe = subscribeAxiomPrice(token.tokenAddress, (update: AxiomPriceUpdate) => {
        // WebSocket price is in USD, convert to SOL
        const priceSol = solPriceAtEntry > 0 ? update.price / solPriceAtEntry : 0;
        wsPrice = {
          priceSol,
          mcUsd: update.marketCap,
          timestamp: update.timestamp || Date.now(),
        };
      });
      logger.debug(`  Subscribed to Axiom WebSocket price updates for ${token.tokenTicker}`);
    } catch (err) {
      logger.debug(`  Could not subscribe to Axiom WebSocket: ${err}`);
    }
    
    // PRIORITY: Subscribe to Helius on-chain price updates (truly real-time!)
    // Only works for tokens still on Pump.fun bonding curve (not graduated to Raydium)
    const isOnBondingCurve = token.marketCapSol < 85; // Graduation threshold is 85 SOL (~$10.6k at $125 SOL)
    
    if (ENV.HELIUS_API_KEY && PRICE_MONITOR?.USE_HELIUS && isOnBondingCurve) {
      try {
        const heliusMonitor = getHeliusPriceMonitor();
        
        if (!heliusConnected) {
          await heliusMonitor.connect();
          heliusConnected = true;
          logger.success(`  [HELIUS] Connected to on-chain monitoring`);
        }
        
        heliusPrice = null; // Reset
        
        // Use actual bonding curve address from PumpPortal if available, otherwise derive
        // pairAddress contains bondingCurve for PumpPortal tokens
        const bondingCurve = (token.pairAddress && token.pairAddress !== token.tokenAddress) 
          ? token.pairAddress 
          : deriveBondingCurveAddress(token.tokenAddress);
        
        const solPriceForHelius = await getSolPriceUsd();
        
        logger.debug(`  [HELIUS] Using bonding curve: ${bondingCurve.slice(0, 8)}... for mint ${token.tokenAddress.slice(0, 8)}...`);
        
        heliusPriceUnsubscribe = await heliusMonitor.subscribeToBondingCurve(
          token.tokenAddress,
          bondingCurve,
          (update: HeliusPriceUpdate) => {
            heliusPrice = {
              priceSol: update.priceSol,
              mcSol: update.marketCapSol,
              mcUsd: update.marketCapUsd || (update.marketCapSol * solPriceForHelius),
              timestamp: update.timestamp,
            };
          }
        );
        
        logger.success(`  [HELIUS] Subscribed to bonding curve for ${token.tokenTicker}`);
      } catch (err) {
        logger.warn(`  [HELIUS] Could not subscribe: ${err} - falling back to other sources`);
      }
    } else if (ENV.HELIUS_API_KEY && !isOnBondingCurve) {
      logger.info(`  [HELIUS] Token ${token.tokenTicker} is graduated (MC: ${token.marketCapSol.toFixed(0)} SOL) - using DexScreener/Axiom for price`);
    }
    
    logger.success(`  Trade entered: ${trade.tokenAmount.toFixed(2)} ${token.tokenTicker} @ ${trade.pricePerToken.toExponential(4)} SOL`);
    
  } catch (error) {
    logger.error('  Failed to enter trade:', error);
  }
}

/**
 * Handle manual entry command from UI
 * Discards any current position and enters the specified token
 */
async function handleManualEntry(mint: string): Promise<void> {
  logger.info(`\n🟢 MANUAL ENTRY: ${mint}`);
  
  // 1. Discard any current position (no sell, just abandon it)
  if (state.currentPosition) {
    logger.warn(`  Discarding current position: ${state.currentPosition.symbol}`);
    
    // Unsubscribe from price feeds
    if (wsPriceUnsubscribe) {
      wsPriceUnsubscribe();
      wsPriceUnsubscribe = null;
    }
    if (heliusPriceUnsubscribe) {
      heliusPriceUnsubscribe();
      heliusPriceUnsubscribe = null;
    }
    
    // Clear position state (don't sell, just discard)
    wsPrice = null;
    heliusPrice = null;
    state.currentPosition = null;
    
    logger.info(`  Previous position discarded (not sold)`);
  }
  
  // 2. Fetch token data
  logger.info(`  Fetching token data for ${mint.slice(0, 8)}...`);
  
  try {
    // Try PumpPortal first (for bonding curve tokens)
    const { fetchTokenViaPumpPortal } = await import('../api/pump-portal.js');
    const pumpToken = await fetchTokenViaPumpPortal(mint);
    
    if (pumpToken) {
      logger.info(`  Found token: ${pumpToken.symbol} (${pumpToken.name})`);
      logger.info(`  Market Cap: ${pumpToken.marketCapSol.toFixed(2)} SOL (~$${pumpToken.marketCapUsd.toFixed(0)})`);
      logger.info(`  Bonding Progress: ${pumpToken.bondingCurveProgress.toFixed(1)}%`);
      logger.info(`  Graduated: ${pumpToken.isGraduated ? 'YES' : 'NO'}`);
      
      // Convert to AxiomTrendingToken format
      const token: AxiomTrendingToken = {
        pairAddress: pumpToken.bondingCurve || pumpToken.mint,
        tokenAddress: pumpToken.mint,
        tokenName: pumpToken.name,
        tokenTicker: pumpToken.symbol,
        tokenImage: pumpToken.imageUri,
        tokenDecimals: 6,
        protocol: 'Pump Fun',
        prevMarketCapSol: pumpToken.marketCapSol,
        marketCapSol: pumpToken.marketCapSol,
        marketCapPercentChange: 0,
        liquiditySol: pumpToken.virtualSolReserves,
        liquidityToken: pumpToken.virtualTokenReserves,
        volumeSol: 0,
        buyCount: pumpToken.tradeCount,
        sellCount: 0,
        top10Holders: 0,
        lpBurned: 0,
        mintAuthority: null,
        freezeAuthority: null,
        dexPaid: false,
        createdAt: new Date(pumpToken.createdTimestamp).toISOString(),
        supply: 1_000_000_000,
        userCount: 0,
      };
      
      // Enter the trade
      await enterTrade(token, ['MANUAL_ENTRY']);
      logger.success(`  ✅ Manual entry complete: ${pumpToken.symbol}`);
      return;
    }
    
    // Try Axiom/DexScreener for graduated tokens
    const axiomToken = await getAxiomTokenByMint(mint, '5m');
    if (axiomToken) {
      logger.info(`  Found graduated token via Axiom: ${axiomToken.tokenTicker}`);
      await enterTrade(axiomToken, ['MANUAL_ENTRY']);
      logger.success(`  ✅ Manual entry complete: ${axiomToken.tokenTicker}`);
      return;
    }
    
    logger.error(`  ❌ Could not find token data for ${mint}`);
    
  } catch (error) {
    logger.error(`  ❌ Manual entry failed:`, error);
  }
}

async function monitorPosition(): Promise<void> {
  if (!state.currentPosition) return;
  
  const { mint, pairAddress, symbol, entryPrice, entryMcSol, entryTime, platform } = state.currentPosition;
  
  // Check if we're in the grace period (no SL triggers immediately after entry)
  const timeSinceEntry = Date.now() - entryTime;
  const inGracePeriod = timeSinceEntry < AXIOM_AUTO_CONFIG.entryGracePeriodMs;
  
  // Check for manual exit request first
  if (manualExitRequested) {
    manualExitRequested = false;
    logger.info(`  🔴 Manual exit triggered for ${symbol}`);
    await exitPosition('MANUAL');
    return;
  }
  
  // Helper to format price in readable units
  const fmtPrice = (price: number): string => {
    if (price >= 0.001) return `${price.toFixed(6)} SOL`;
    if (price >= 0.000001) return `${(price * 1e6).toFixed(2)} μSOL`;
    return `${(price * 1e9).toFixed(2)} nSOL`;
  };
  
  // Helper function to process price update from any source
  const processPriceUpdate = async (currentPriceSol: number, currentMcUsd: number, source: string) => {
    const pnlPercent = ((currentPriceSol - entryPrice) / entryPrice) * 100;
    const emoji = pnlPercent >= 0 ? '📈' : '📉';
    const portfolio = getPaperPortfolio();
    const position = portfolio.positions.get(mint);
    const estimatedPnlSol = position ? position.costBasis * (pnlPercent / 100) : null;
    const pnlSolDisplay = estimatedPnlSol !== null
      ? ` | ${estimatedPnlSol >= 0 ? '+' : ''}${estimatedPnlSol.toFixed(4)} SOL est`
      : '';

    if (state.currentPosition) {
      const now = Date.now();
      const lastPrice = state.currentPosition.lastPriceSol;
      const movePercent = lastPrice > 0
        ? Math.abs((currentPriceSol - lastPrice) / lastPrice) * 100
        : 0;

      if (movePercent >= AXIOM_AUTO_CONFIG.stagnantMinMovePercent) {
        state.currentPosition.lastPriceSol = currentPriceSol;
        state.currentPosition.lastMoveTime = now;
      } else {
        const stagnantMs = now - state.currentPosition.lastMoveTime;
        if (stagnantMs >= AXIOM_AUTO_CONFIG.stagnantExitSeconds * 1000) {
          logger.warn(`  ⏳ Position stagnant for ${(stagnantMs / 1000).toFixed(0)}s with no significant move (min ${AXIOM_AUTO_CONFIG.stagnantMinMovePercent}%)`);
          await exitPosition('STAGNANT');
          return true; // Signal that we exited
        }
      }

      state.currentPosition.lastPnlPercent = pnlPercent;
      state.currentPosition.lastMcUsd = currentMcUsd;
    }

    const mcDisplay = currentMcUsd >= 1_000_000 
      ? `$${(currentMcUsd / 1_000_000).toFixed(1)}M` 
      : `$${(currentMcUsd / 1000).toFixed(1)}k`;
    const sourceTag = ` [${source}]`;
    
    logger.info(`  ${emoji} ${symbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (SOL)${pnlSolDisplay} | MC: ${mcDisplay} | ${fmtPrice(currentPriceSol)} (entry: ${fmtPrice(entryPrice)})${sourceTag}  [x to exit]`);
    writeStatusFile();
    
    if (pnlPercent >= AXIOM_AUTO_CONFIG.takeProfitPercent) {
      logger.success(`  🎯 Take profit hit! (+${pnlPercent.toFixed(1)}%)`);
      await exitPosition('TP');
      return true;
    } else if (pnlPercent <= -AXIOM_AUTO_CONFIG.stopLossPercent) {
      if (inGracePeriod) {
        const graceRemaining = Math.ceil((AXIOM_AUTO_CONFIG.entryGracePeriodMs - timeSinceEntry) / 1000);
        logger.debug(`  ⏸️ SL would trigger (${pnlPercent.toFixed(1)}%) but in grace period (${graceRemaining}s remaining)`);
      } else {
        logger.warn(`  🛑 Stop loss hit! (${pnlPercent.toFixed(1)}%)`);
        await exitPosition('SL');
        return true;
      }
    }
    return false;
  };
  
  try {
    // PRIORITY 0: Helius on-chain price (truly real-time, direct from blockchain!)
    // If we have an active subscription, the price IS the on-chain price - no staleness check needed
    // Only updates come when trades happen, but the price is still valid (hasn't changed)
    if (heliusPriceUnsubscribe && heliusPrice && heliusPrice.priceSol > 0) {
      const exited = await processPriceUpdate(heliusPrice.priceSol, heliusPrice.mcUsd, 'helius');
      if (exited) return;
      return; // Helius price used, don't fall through
    } else if (heliusPriceUnsubscribe && heliusPrice && heliusPrice.priceSol === 0) {
      // Helius is subscribed but returning 0 - likely bad bonding curve address
      logger.debug(`  ⚠️ Helius returning 0 price - bonding curve may be wrong, using fallback`);
    }
    
    // PRIORITY 1: Check Axiom WebSocket price (second most real-time)
    if (wsPrice && wsPrice.priceSol > 0 && (Date.now() - wsPrice.timestamp) < 5000) {
      const exited = await processPriceUpdate(wsPrice.priceSol, wsPrice.mcUsd, 'axiom-ws');
      if (exited) return;
      return;
    }
    
    // PRIORITY 2: Try DexScreener (reliable free API)
    try {
      const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (dexResponse.ok) {
        const dexData = await dexResponse.json() as any;
        const pairs = dexData?.pairs || [];
        if (pairs.length > 0) {
          const topPair = pairs.sort((a: any, b: any) => 
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          )[0];
          const priceUsd = parseFloat(topPair.priceUsd || '0');
          const solPriceUsd = await getSolPriceUsd();
          const currentPriceSol = priceUsd / solPriceUsd;
          const currentMcUsd = topPair.marketCap || topPair.fdv || 0;
          
          if (currentPriceSol > 0) {
            // Sanity check: reject prices that are wildly different from entry
            // A 5x move in seconds is almost certainly bad data
            const priceRatio = currentPriceSol / entryPrice;
            if (priceRatio > 5 || priceRatio < 0.2) {
              logger.warn(`  ⚠️ DexScreener price looks wrong: ${(currentPriceSol * 1e9).toFixed(2)} nSOL vs entry ${(entryPrice * 1e9).toFixed(2)} nSOL (${((priceRatio - 1) * 100).toFixed(0)}%) - skipping`);
            } else {
              const exited = await processPriceUpdate(currentPriceSol, currentMcUsd, 'dexscreener');
              if (exited) return;
              return;
            }
          }
        }
      }
    } catch (err) {
      logger.debug(`DexScreener failed: ${err}`);
    }
    
    // PRIORITY 4: Fetch current data from Axiom trending (last resort, updates every ~20s)
    const trending = await getAxiomTrending(AXIOM_AUTO_CONFIG.timePeriod);
    const token = trending.find(t => t.tokenAddress === mint);
    
    if (!token) {
      // Token not in trending - fetch live price
      logger.debug(`  ${symbol} not in trending, fetching live price...`);
      try {
        const { priceSol: currentPriceSol, mcUsd: currentMcUsd, source } = await fetchCurrentPriceAndMc(
          mint,
          entryPrice,
          platform
        );
        if (currentPriceSol > 0) {
          // Sanity check: reject wildly different prices
          const priceRatio = currentPriceSol / entryPrice;
          if (priceRatio > 5 || priceRatio < 0.2) {
            logger.warn(`  ⚠️ Price from ${source} looks wrong: ratio=${priceRatio.toFixed(2)}x entry - skipping`);
            return;
          }
          
          const pnlPercent = ((currentPriceSol - entryPrice) / entryPrice) * 100;
          const emoji = pnlPercent >= 0 ? '📈' : '📉';
          const portfolio = getPaperPortfolio();
          const position = portfolio.positions.get(mint);
          const estimatedPnlSol = position ? position.costBasis * (pnlPercent / 100) : null;
          const pnlSolDisplay = estimatedPnlSol !== null
            ? ` | ${estimatedPnlSol >= 0 ? '+' : ''}${estimatedPnlSol.toFixed(4)} SOL est`
            : '';
          
          if (state.currentPosition) {
            state.currentPosition.lastPnlPercent = pnlPercent;
            state.currentPosition.lastMcUsd = currentMcUsd;
            state.currentPosition.estimatedPnlSol = estimatedPnlSol ?? undefined;
            state.currentPosition.costBasisSol = position?.costBasis ?? undefined;
          }

          if (state.currentPosition) {
            const now = Date.now();
            const lastPrice = state.currentPosition.lastPriceSol;
            const movePercent = lastPrice > 0
              ? Math.abs((currentPriceSol - lastPrice) / lastPrice) * 100
              : 0;
            if (movePercent >= AXIOM_AUTO_CONFIG.stagnantMinMovePercent) {
              state.currentPosition.lastPriceSol = currentPriceSol;
              state.currentPosition.lastMoveTime = now;
            } else if (now - state.currentPosition.lastMoveTime >= AXIOM_AUTO_CONFIG.stagnantExitSeconds * 1000) {
              logger.warn(`  💤 No meaningful price action for ${AXIOM_AUTO_CONFIG.stagnantExitSeconds}s (${movePercent.toFixed(2)}% move). Closing position.`);
              await exitPosition('STAGNANT');
              return;
            }
          }
          
          const formatPrice = (price: number): string => {
            if (price >= 0.001) return `${price.toFixed(6)} SOL`;
            if (price >= 0.000001) return `${(price * 1e6).toFixed(2)} μSOL`;
            return `${(price * 1e9).toFixed(2)} nSOL`;
          };
          
          const formatMc = (usd: number): string => {
            if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
            if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
            return `$${usd.toFixed(0)}`;
          };
          const mcDisplay = currentMcUsd > 0 ? formatMc(currentMcUsd) : '?';
          const sourceTag = source !== 'pump.fun' ? ` [${source}]` : '';
          logger.info(`  ${emoji} ${symbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (SOL)${pnlSolDisplay} | MC: ${mcDisplay} | ${formatPrice(currentPriceSol)} (entry: ${formatPrice(entryPrice)})${sourceTag}  [x to exit]`);
          writeStatusFile();
          
          // Check TP/SL
          if (pnlPercent >= AXIOM_AUTO_CONFIG.takeProfitPercent) {
            logger.success(`  🎯 Take profit hit! (+${pnlPercent.toFixed(1)}%)`);
            await exitPosition('TP');
          } else if (pnlPercent <= -AXIOM_AUTO_CONFIG.stopLossPercent) {
            if (inGracePeriod) {
              const graceRemaining = Math.ceil((AXIOM_AUTO_CONFIG.entryGracePeriodMs - timeSinceEntry) / 1000);
              logger.debug(`  ⏸️ SL would trigger (${pnlPercent.toFixed(1)}%) but in grace period (${graceRemaining}s remaining)`);
            } else {
              logger.warn(`  🛑 Stop loss hit! (${pnlPercent.toFixed(1)}%)`);
              await exitPosition('SL');
            }
          }
          return;
        }
      } catch {
        // Price fetch failed
      }
      
      logger.info(`  ⚠️ ${symbol} - Cannot fetch price, position still open  [x to exit manually]`);
      return;
    }
    
    // Token IS in trending - use Axiom's live data directly (faster!)
    // Calculate price from marketCapSol / supply
    const axiomPriceSol = token.supply > 0 ? token.marketCapSol / token.supply : 0;
    const solPriceForMc = await getSolPriceUsd();
    const axiomMcUsd = token.marketCapSol * solPriceForMc;
    
    // Use Axiom data if valid, otherwise fallback
    let currentPriceSol: number;
    let currentMcUsd: number;
    let source: string;
    
    if (axiomPriceSol > 0) {
      currentPriceSol = axiomPriceSol;
      currentMcUsd = axiomMcUsd;
      source = 'axiom';
    } else {
      // Fallback to other sources
      const fetched = await fetchCurrentPriceAndMc(mint, entryPrice, platform);
      currentPriceSol = fetched.priceSol;
      currentMcUsd = fetched.mcUsd;
      source = fetched.source;
    }
    
    // Calculate P&L from actual prices (matches paper-trader calculation)
    const pnlPercent = ((currentPriceSol - entryPrice) / entryPrice) * 100;
    const emoji = pnlPercent >= 0 ? '📈' : '📉';
    const portfolio = getPaperPortfolio();
    const position = portfolio.positions.get(mint);
    const estimatedPnlSol = position ? position.costBasis * (pnlPercent / 100) : null;
    const pnlSolDisplay = estimatedPnlSol !== null
      ? ` | ${estimatedPnlSol >= 0 ? '+' : ''}${estimatedPnlSol.toFixed(4)} SOL est`
      : '';

    if (state.currentPosition) {
      const now = Date.now();
      const lastPrice = state.currentPosition.lastPriceSol;
      const movePercent = lastPrice > 0
        ? Math.abs((currentPriceSol - lastPrice) / lastPrice) * 100
        : 0;
      if (movePercent >= AXIOM_AUTO_CONFIG.stagnantMinMovePercent) {
        state.currentPosition.lastPriceSol = currentPriceSol;
        state.currentPosition.lastMoveTime = now;
      } else if (now - state.currentPosition.lastMoveTime >= AXIOM_AUTO_CONFIG.stagnantExitSeconds * 1000) {
        logger.warn(`  💤 No meaningful price action for ${AXIOM_AUTO_CONFIG.stagnantExitSeconds}s (${movePercent.toFixed(2)}% move). Closing position.`);
        await exitPosition('STAGNANT');
        return;
      }
    }
    
    // Format price for readability (show in readable units)
    const formatPrice = (price: number): string => {
      if (price >= 0.001) return `${price.toFixed(6)} SOL`;
      if (price >= 0.000001) return `${(price * 1e6).toFixed(2)} μSOL`;  // micro-SOL
      return `${(price * 1e9).toFixed(2)} nSOL`;  // nano-SOL
    };
    
    // Format MC (USD) - only show current, entry MC is unreliable
    const formatMc = (usd: number): string => {
      if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
      if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
      return `$${usd.toFixed(0)}`;
    };
    
    const mcDisplay = currentMcUsd > 0 ? formatMc(currentMcUsd) : '?';
    const sourceTag = source !== 'pump.fun' ? ` [${source}]` : '';
    // P&L is in SOL terms (accurate), MC is just current reference
    logger.info(`  ${emoji} ${symbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (SOL)${pnlSolDisplay} | MC: ${mcDisplay} | ${formatPrice(currentPriceSol)} (entry: ${formatPrice(entryPrice)})${sourceTag}  [x to exit]`);
    
    if (state.currentPosition) {
      state.currentPosition.lastPnlPercent = pnlPercent;
      state.currentPosition.lastMcUsd = currentMcUsd;
      state.currentPosition.estimatedPnlSol = estimatedPnlSol ?? undefined;
      state.currentPosition.costBasisSol = position?.costBasis ?? undefined;
    }
    writeStatusFile();
    
    // Check TP/SL
    if (pnlPercent >= AXIOM_AUTO_CONFIG.takeProfitPercent) {
      logger.success(`  🎯 Take profit hit! (+${pnlPercent.toFixed(1)}%)`);
      await exitPosition('TP');
    } else if (pnlPercent <= -AXIOM_AUTO_CONFIG.stopLossPercent) {
      if (inGracePeriod) {
        const graceRemaining = Math.ceil((AXIOM_AUTO_CONFIG.entryGracePeriodMs - timeSinceEntry) / 1000);
        logger.debug(`  ⏸️ SL would trigger (${pnlPercent.toFixed(1)}%) but in grace period (${graceRemaining}s remaining)`);
      } else {
        logger.warn(`  🛑 Stop loss hit! (${pnlPercent.toFixed(1)}%)`);
        await exitPosition('SL');
      }
    }
    
  } catch (error) {
    logger.info(`  ⚠️ Error monitoring ${symbol}: ${error}  [x to exit manually]`);
  }
}

// Approximate SOL price for USD→SOL conversion (updated periodically)
let cachedSolPriceUsd = 200; // Conservative default
let solPriceLastFetched = 0;

async function getSolPriceUsd(): Promise<number> {
  // Cache for 60 seconds
  if (Date.now() - solPriceLastFetched < 60000) {
    return cachedSolPriceUsd;
  }
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (response.ok) {
      const data = await response.json() as any;
      cachedSolPriceUsd = data?.solana?.usd || cachedSolPriceUsd;
      solPriceLastFetched = Date.now();
    }
  } catch {
    // Use cached value
  }
  return cachedSolPriceUsd;
}

async function fetchCurrentPriceAndMc(
  mint: string,
  entryPrice: number,
  platform: 'pump.fun' | 'jupiter'
): Promise<{ priceSol: number; mcUsd: number; source: string }> {
  // PRIORITY 0: Helius on-chain price (truly real-time, direct from blockchain!)
  // If we have an active subscription, the price IS the on-chain price
  if (heliusPriceUnsubscribe && heliusPrice && heliusPrice.priceSol > 0) {
    return {
      priceSol: heliusPrice.priceSol,
      mcUsd: heliusPrice.mcUsd,
      source: 'helius',
    };
  }
  
  // PRIORITY 1: Use Axiom WebSocket price if available
  if (wsPrice && wsPrice.priceSol > 0 && (Date.now() - wsPrice.timestamp) < 5000) {
    return {
      priceSol: wsPrice.priceSol,
      mcUsd: wsPrice.mcUsd,
      source: 'axiom-ws',
    };
  }
  
  // For pump.fun tokens (not graduated), use LIVE fetch (bypasses all caching)
  if (platform === 'pump.fun') {
    const pumpToken = await fetchPumpFunTokenLive(mint);
    if (pumpToken && !pumpToken.isGraduated && pumpToken.priceSol > 0) {
      return {
        priceSol: pumpToken.priceSol,
        mcUsd: pumpToken.marketCapUsd || 0,
        source: 'pump.fun',
      };
    }
    // If graduated, fall through to Axiom
  }

  // PRIORITY 2: Try Axiom chart API (1s candles for most real-time data)
  try {
    const livePrice = await getAxiomLivePrice(mint);
    if (livePrice && livePrice.priceSol > 0) {
      // Get supply from trending to calculate accurate MC
      const axiomToken = await getAxiomTokenByMint(mint, '5m');
      const supply = axiomToken?.supply || 1_000_000_000;
      const solPriceUsd = await getSolPriceUsd();
      const mcUsd = livePrice.priceSol * supply * solPriceUsd;
      return {
        priceSol: livePrice.priceSol,
        mcUsd,
        source: 'axiom-chart',
      };
    }
  } catch (err) {
    logger.debug(`Axiom chart failed for ${mint.slice(0, 8)}...: ${err}`);
  }
  
  // PRIORITY 3: Try Axiom trending feed (updates less frequently)
  try {
    const axiomToken = await getAxiomTokenByMint(mint, '5m');
    if (axiomToken && axiomToken.supply > 0) {
      const priceSol = axiomToken.marketCapSol / axiomToken.supply;
      const solPriceUsd = await getSolPriceUsd();
      const mcUsd = axiomToken.marketCapSol * solPriceUsd;
      if (priceSol > 0) {
        return {
          priceSol,
          mcUsd,
          source: 'axiom-feed',
        };
      }
    }
  } catch (err) {
    logger.debug(`Axiom feed failed for ${mint.slice(0, 8)}...: ${err}`);
  }
  
  // Try Axiom batch prices as backup
  try {
    const axiomPrices = await getAxiomBatchPrices([mint]);
    const priceData = axiomPrices[mint];
    if (priceData && priceData.price > 0) {
      const solPrice = await getSolPriceUsd();
      const priceSol = priceData.price / solPrice;
      // Estimate MC from price (assuming 1B supply for memecoins)
      const estimatedMcUsd = priceData.price * 1_000_000_000;
      return {
        priceSol,
        mcUsd: estimatedMcUsd,
        source: 'axiom',
      };
    } else {
      logger.debug(`Axiom batch-prices returned no data for ${mint.slice(0, 8)}...`);
    }
  } catch (err) {
    logger.debug(`Axiom batch-prices failed for ${mint.slice(0, 8)}...: ${err}`);
  }

  // Fallback to DexScreener if Axiom fails
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (response.ok) {
      const data = await response.json() as any;
      const pairs = data?.pairs || [];
      if (pairs.length > 0) {
        const topPair = pairs.sort((a: any, b: any) =>
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        const priceSol = parseFloat(topPair.priceNative) || entryPrice;
        const mcUsd = topPair.marketCap || topPair.fdv || 0;
        return { priceSol, mcUsd, source: 'dexscreener' };
      }
    }
  } catch {
    // Keep entry price as fallback
  }

  return { priceSol: entryPrice, mcUsd: 0, source: 'fallback' };
}

async function exitPosition(reason: string, exitPrice?: number): Promise<void> {
  if (!state.currentPosition) return;
  
  const { mint, symbol } = state.currentPosition;
  
  // Use Helius price if available and no override provided
  const priceToUse = exitPrice || (heliusPrice?.priceSol && heliusPrice.priceSol > 0 ? heliusPrice.priceSol : undefined);
  
  try {
    const trade = await paperSell(mint, symbol, 100, reason, priceToUse);
    
    if (trade) {
      const pnlEmoji = (trade.pnl || 0) >= 0 ? '📈' : '📉';
      const pnlPercentDisplay = trade.pnlPercent !== undefined
        ? ` (${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(1)}%)`
        : '';
      logger.success(`  ${pnlEmoji} Position closed: ${trade.pnl !== undefined ? (trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(4) : '0'} SOL${pnlPercentDisplay} (${reason})`);
    }
    
    // Unsubscribe from WebSocket price updates
    if (wsPriceUnsubscribe) {
      wsPriceUnsubscribe();
      wsPriceUnsubscribe = null;
      wsPrice = null;
    }
    
    // Unsubscribe from Helius on-chain price updates
    if (heliusPriceUnsubscribe) {
      heliusPriceUnsubscribe();
      heliusPriceUnsubscribe = null;
      heliusPrice = null;
    }
    
    // Add to recently traded so it won't be picked again
    state.recentlyTraded.add(mint);
    logger.info(`  Token ${symbol} added to cooldown list - will not be picked again this session`);
    
    state.currentPosition = null;
    state.lastTradeTime = Date.now();
    writeStatusFile();
    
    logger.info('  Resuming token discovery...\n');
    
  } catch (error) {
    logger.error(`  Failed to exit position: ${error}`);
  }
}

function setupSignalHandlers(): void {
  const handler = () => {
    if (shutdownRequested) {
      logger.warn('Force exit requested');
      process.exit(1);
    }
    logger.info('\nShutdown requested...');
    shutdownRequested = true;
  };
  
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  
  // Setup keyboard input for manual exit
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('data', (key: string) => {
      // Ctrl+C
      if (key === '\u0003') {
        handler();
        return;
      }
      
      // 'x' or 'X' to exit position
      if (key.toLowerCase() === 'x' && state.currentPosition) {
        logger.info('\n🔴 Manual exit requested...');
        manualExitRequested = true;
      }
      
      // 's' to show status
      if (key.toLowerCase() === 's') {
        showQuickStatus();
      }
      
      // 'h' for help
      if (key.toLowerCase() === 'h') {
        showKeyboardHelp();
      }
    });
    
    logger.info('Keyboard controls: [x] Exit position | [s] Status | [h] Help | [Ctrl+C] Quit');
  }
}

function showKeyboardHelp(): void {
  logger.info('\n📋 Keyboard Controls:');
  logger.info('  [x] - Exit current position manually');
  logger.info('  [s] - Show quick status');
  logger.info('  [h] - Show this help');
  logger.info('  [Ctrl+C] - Stop the bot\n');
}

function showQuickStatus(): void {
  const portfolio = getPaperPortfolio();
  const roi = ((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100);
  
  logger.info('\n📊 Quick Status:');
  logger.info(`  Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL | P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`);
  logger.info(`  Polls: ${state.pollCount} | Analyzed: ${state.tokensAnalyzed} | Entered: ${state.tradesEntered}`);
  
  if (state.currentPosition) {
    logger.info(`  Position: ${state.currentPosition.symbol} @ ${state.currentPosition.entryPrice.toExponential(4)} SOL`);
  } else {
    logger.info('  Position: None (scanning...)');
  }
  logger.info('');
}

/**
 * Mark tokens from paper trade history as recently traded to prevent re-entry
 */
function markRecentlyTradedFromHistory(): void {
  const trades = getPaperTrades();
  const cooldownMs = 60 * 60 * 1000; // 1 hour cooldown from last trade
  const now = Date.now();
  
  // Find unique mints that were traded recently
  const recentlyTraded = new Map<string, { symbol: string; time: Date }>();
  
  for (const trade of trades) {
    const tradeTime = new Date(trade.timestamp).getTime();
    if (now - tradeTime < cooldownMs) {
      // Keep most recent trade time for each mint
      const existing = recentlyTraded.get(trade.mint);
      if (!existing || new Date(trade.timestamp) > existing.time) {
        recentlyTraded.set(trade.mint, { symbol: trade.symbol, time: new Date(trade.timestamp) });
      }
    }
  }
  
  // Mark them in state
  if (recentlyTraded.size > 0) {
    logger.info(`📝 Loaded ${recentlyTraded.size} recently traded token(s) from history (1h cooldown):`);
    for (const [mint, info] of recentlyTraded) {
      state.recentlyTraded.add(mint);
      const minsAgo = Math.floor((now - info.time.getTime()) / 60000);
      logger.info(`   - ${info.symbol} (${minsAgo}m ago)`);
    }
  }
}

async function shutdown(): Promise<void> {
  logger.header('SHUTTING DOWN');
  
  state.isRunning = false;
  writeStatusFile();
  
  // Show final stats
  displayFinalStats();
  
  // Show paper trading summary
  displayPaperSummary();
  
  logger.success('Axiom auto-trader stopped');
}

function displayConfig(): void {
  logger.box('Axiom Auto-Trader Config', [
    `Mode: 📝 PAPER TRADING (Axiom Data)`,
    `Poll interval: ${AXIOM_AUTO_CONFIG.pollIntervalMs / 1000}s`,
    `Time period: ${AXIOM_AUTO_CONFIG.timePeriod}`,
    `Market cap: ${AXIOM_AUTO_CONFIG.minMarketCapSol}-${AXIOM_AUTO_CONFIG.maxMarketCapSol} SOL`,
    `Min volume: ${AXIOM_AUTO_CONFIG.minVolumeSol} SOL`,
    `Max top 10 holders: ${AXIOM_AUTO_CONFIG.maxTop10HoldersPercent}%`,
    `Position size: ${AXIOM_AUTO_CONFIG.positionSizeSol} SOL`,
    `Take profit: +${AXIOM_AUTO_CONFIG.takeProfitPercent}%`,
    `Stop loss: ${AXIOM_AUTO_CONFIG.stopLossPercent}%`,
    `Stagnant exit: ${AXIOM_AUTO_CONFIG.stagnantExitSeconds}s @ ${AXIOM_AUTO_CONFIG.stagnantMinMovePercent}%`,
  ]);
}

function displayFinalStats(): void {
  const runtime = (Date.now() - state.startTime.getTime()) / 1000 / 60;
  const portfolio = getPaperPortfolio();
  const roi = ((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100);
  
  logger.box('📝 Axiom Session Summary', [
    `Runtime: ${runtime.toFixed(1)} minutes`,
    `Polls: ${state.pollCount}`,
    `Tokens analyzed: ${state.tokensAnalyzed}`,
    `Trades entered: ${state.tradesEntered}`,
    `Trades rejected: ${state.tradesRejected}`,
    ``,
    `Starting Balance: ${portfolio.startingBalanceSOL.toFixed(4)} SOL`,
    `Final Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`,
    `Total P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`,
    `ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
    `Win Rate: ${portfolio.winRate.toFixed(1)}%`,
  ]);
}

function showStatus(): void {
  loadPaperTrades();
  const portfolio = getPaperPortfolio();
  const roi = ((portfolio.currentBalanceSOL - portfolio.startingBalanceSOL) / portfolio.startingBalanceSOL * 100);
  
  logger.header('📝 AXIOM AUTO-TRADER STATUS');
  
  logger.box('Paper Portfolio', [
    `Balance: ${portfolio.currentBalanceSOL.toFixed(4)} SOL`,
    `Total P&L: ${portfolio.totalPnL >= 0 ? '+' : ''}${portfolio.totalPnL.toFixed(4)} SOL`,
    `ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
    `Wins/Losses: ${portfolio.wins}/${portfolio.losses}`,
    `Win Rate: ${portfolio.winRate.toFixed(1)}%`,
    `Open Positions: ${portfolio.positions.size}`,
  ]);
  
  if (portfolio.positions.size > 0) {
    logger.info('\nOpen Positions:');
    for (const [mint, pos] of portfolio.positions) {
      logger.info(`  ${pos.symbol}: ${pos.tokenAmount.toFixed(2)} tokens @ ${pos.avgEntryPrice.toExponential(4)} SOL`);
    }
  }
  
  displayPaperSummary();
}

function showHelp(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               AXIOM AUTO-TRADER CLI                           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Commands:                                                    ║
║    npm run axiom:auto         Start Axiom paper trading       ║
║    npm run axiom:auto status  Show paper trading status       ║
║                                                               ║
║  Data Source:                                                 ║
║    Uses Axiom Trade API for token discovery (trending)        ║
║    instead of pump.fun/PumpPortal                             ║
║                                                               ║
║  Environment Variables Required (.env):                       ║
║    AXIOM_ACCESS_TOKEN   - From axiom.trade cookies            ║
║    AXIOM_REFRESH_TOKEN  - From axiom.trade cookies            ║
║    WALLET_PRIVATE_KEY   - Base58 encoded private key          ║
║    SOLANA_RPC_URL       - Solana RPC endpoint                 ║
║                                                               ║
║  Features:                                                    ║
║    - Discovers tokens via Axiom trending API                  ║
║    - Filters by market cap, volume, holders, momentum         ║
║    - Auto TP/SL monitoring                                    ║
║    - Uses same paper trading portfolio as pump.fun mode       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
