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
import {
  loadAxiomAuthFromEnv,
  isAxiomAuthenticated,
  getAxiomTrending,
  AxiomTrendingToken,
} from '../api/axiom-trade.js';
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
import { PAPER_TRADING, POSITION_SIZING, validateEnv } from '../config/index.js';
import { getWalletBalance, getWallet, sleep } from '../utils/solana.js';
import logger from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

const AXIOM_AUTO_CONFIG = {
  // Discovery settings
  pollIntervalMs: 20000,           // Poll Axiom trending every 20 seconds
  timePeriod: '5m' as '5m' | '1h' | '24h' | '7d' | '30d',  // Trending time period (1h - 5m not supported by API)
  
  // Token filtering (Axiom-specific)
  minMarketCapSol: 20,             // Min ~$2.5k at $125 SOL
  maxMarketCapSol: 50000,          // Max ~$6.25M at $125 SOL (trending tokens are larger)
  minVolumeSol: 5,                 // Minimum 5 SOL volume
  maxTop10HoldersPercent: 30,      // Max concentration
  minBuyCount: 10,                 // Minimum buy transactions
  maxAgeHours: 24,                 // Don't trade tokens older than 24h
  
  // Trading settings
  maxOpenPositions: 1,             // Only 1 position at a time
  tradeCooldownMs: 15000,          // 15 seconds between trades (faster for paper testing)
  positionSizeSol: POSITION_SIZING.IDEAL_PER_TRADE_SOL,
  
  // Exit settings
  takeProfitPercent: 20,           // 30% TP
  stopLossPercent: -10,            // -15% SL
  priceCheckIntervalMs: 500,      // Check price every 5 seconds
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
  currentPosition: { mint: string; symbol: string; entryPrice: number; entryMcSol: number; platform: 'pump.fun' | 'jupiter' } | null;
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
      
      // Fetch current MC to use as estimate (we don't have historical entry MC)
      let estimatedEntryMcSol = 0;
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (response.ok) {
          const data = await response.json() as any;
          const pairs = data?.pairs || [];
          if (pairs.length > 0) {
            const topPair = pairs.sort((a: any, b: any) => 
              (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
            )[0];
            const mcUsd = topPair.marketCap || topPair.fdv || 0;
            estimatedEntryMcSol = mcUsd / 150; // Convert USD to SOL estimate
          }
        }
      } catch {
        // Use 0 if fetch fails
      }
      
      state.currentPosition = { mint, symbol: pos.symbol, entryPrice: pos.avgEntryPrice, entryMcSol: estimatedEntryMcSol, platform: inferredPlatform as 'pump.fun' | 'jupiter' };
      const mcDisplay = estimatedEntryMcSol > 0 ? `~$${(estimatedEntryMcSol * 150 / 1000).toFixed(0)}k MC` : 'MC unknown';
      logger.info(`📝 Existing position: ${pos.symbol} @ ${pos.avgEntryPrice.toExponential(4)} SOL (${inferredPlatform}, ${mcDisplay})`);
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
  
  logger.success('Axiom auto-trader started');
  logger.info('Press Ctrl+C to stop gracefully\n');
  
  // Short delay before starting
  await sleep(2000);
  
  await mainLoop();
}

async function mainLoop(): Promise<void> {
  while (state.isRunning && !shutdownRequested) {
    try {
      // If we have a position, monitor it
      if (state.currentPosition) {
        await monitorPosition();
      } else {
        // Look for new opportunities
        await discoverAndTrade();
      }
      
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
  logger.info(`\n[Poll #${state.pollCount}] Fetching Axiom trending tokens...`);
  
  try {
    const trending = await getAxiomTrending(AXIOM_AUTO_CONFIG.timePeriod);
    logger.info(`  Got ${trending.length} trending tokens`);
    
    // Filter candidates and track rejection reasons
    const candidates: AxiomTrendingToken[] = [];
    const rejectionCounts: Record<string, number> = {};
    
    for (const token of trending) {
      const result = passesAxiomFilter(token);
      if (result.passed) {
        candidates.push(token);
      } else if (result.reason) {
        const key = result.reason.split(':')[0];  // Group by category
        rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
      }
    }
    
    // Show rejection breakdown
    const rejectSummary = Object.entries(rejectionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    logger.info(`  ${candidates.length} passed | Rejected: ${rejectSummary || 'none'}`);
    
    // Show top 3 tokens that almost passed (for debugging)
    if (candidates.length === 0 && trending.length > 0) {
      logger.info(`  Sample tokens (why rejected):`);
      for (const token of trending.slice(0, 3)) {
        const result = passesAxiomFilter(token);
        logger.info(`    ${token.tokenTicker}: MC=${token.marketCapSol.toFixed(0)} SOL, Top10=${token.top10Holders.toFixed(0)}%, ${result.reason || 'unknown'}`);
      }
    }
    
    // Sort by momentum (market cap % change)
    candidates.sort((a, b) => b.marketCapPercentChange - a.marketCapPercentChange);
    
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
  // Market cap filter
  if (token.marketCapSol < AXIOM_AUTO_CONFIG.minMarketCapSol) {
    return { passed: false, reason: `mcap:${token.marketCapSol.toFixed(0)}<${AXIOM_AUTO_CONFIG.minMarketCapSol}` };
  }
  if (token.marketCapSol > AXIOM_AUTO_CONFIG.maxMarketCapSol) {
    return { passed: false, reason: `mcap:${token.marketCapSol.toFixed(0)}>${AXIOM_AUTO_CONFIG.maxMarketCapSol}` };
  }
  
  // Volume filter
  if (token.volumeSol < AXIOM_AUTO_CONFIG.minVolumeSol) {
    return { passed: false, reason: `vol:${token.volumeSol.toFixed(1)}<${AXIOM_AUTO_CONFIG.minVolumeSol}` };
  }
  
  // Activity filter
  if (token.buyCount < AXIOM_AUTO_CONFIG.minBuyCount) {
    return { passed: false, reason: `buys:${token.buyCount}<${AXIOM_AUTO_CONFIG.minBuyCount}` };
  }
  
  // Concentration filter
  if (token.top10Holders > AXIOM_AUTO_CONFIG.maxTop10HoldersPercent) {
    return { passed: false, reason: `top10:${token.top10Holders.toFixed(0)}%>${AXIOM_AUTO_CONFIG.maxTop10HoldersPercent}%` };
  }
  
  // Age filter (from createdAt timestamp)
  const ageHours = (Date.now() - new Date(token.createdAt).getTime()) / 1000 / 60 / 60;
  if (ageHours > AXIOM_AUTO_CONFIG.maxAgeHours) {
    return { passed: false, reason: `age:${ageHours.toFixed(1)}h>${AXIOM_AUTO_CONFIG.maxAgeHours}h` };
  }
  
  // Positive momentum
  if (token.marketCapPercentChange <= 0) {
    return { passed: false, reason: `momentum:${token.marketCapPercentChange.toFixed(0)}%` };
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

async function runAxiomChecklist(token: AxiomTrendingToken): Promise<{ passed: boolean; passedChecks: string[]; failedChecks: string[] }> {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  
  // Calculate age in minutes
  const ageMinutes = (Date.now() - new Date(token.createdAt).getTime()) / 1000 / 60;
  
  // Basic checks based on Axiom data
  
  // 1. Age check (prefer tokens between 5 min and 24 hours)
  if (ageMinutes >= 5 && ageMinutes <= 24 * 60) {
    passedChecks.push(`age:${ageMinutes.toFixed(0)}min`);
  } else {
    failedChecks.push(`age:${ageMinutes.toFixed(0)}min`);
  }
  
  // 2. Momentum check
  if (token.marketCapPercentChange >= 10) {
    passedChecks.push(`momentum:+${token.marketCapPercentChange.toFixed(0)}%`);
  } else if (token.marketCapPercentChange > 0) {
    passedChecks.push(`momentum:weak+${token.marketCapPercentChange.toFixed(0)}%`);
  } else {
    failedChecks.push(`momentum:${token.marketCapPercentChange.toFixed(0)}%`);
  }
  
  // 3. Volume check
  const volumeToMcap = token.volumeSol / Math.max(token.marketCapSol, 1);
  if (volumeToMcap >= 0.1) {  // 10% volume/mcap ratio
    passedChecks.push(`volume:${(volumeToMcap * 100).toFixed(0)}%`);
  } else {
    failedChecks.push(`volume:low${(volumeToMcap * 100).toFixed(0)}%`);
  }
  
  // 4. Buy/sell ratio
  const buyRatio = token.buyCount / Math.max(token.buyCount + token.sellCount, 1);
  if (buyRatio >= 0.5) {
    passedChecks.push(`buys:${(buyRatio * 100).toFixed(0)}%`);
  } else {
    failedChecks.push(`sells:${((1 - buyRatio) * 100).toFixed(0)}%`);
  }
  
  // 5. Holder concentration
  if (token.top10Holders <= 40) {
    passedChecks.push(`holders:${token.top10Holders.toFixed(0)}%`);
  } else if (token.top10Holders <= 50) {
    passedChecks.push(`holders:warn${token.top10Holders.toFixed(0)}%`);
  } else {
    failedChecks.push(`holders:${token.top10Holders.toFixed(0)}%`);
  }
  
  // 6. LP burned check
  if (token.lpBurned >= 90) {
    passedChecks.push(`lp:${token.lpBurned.toFixed(0)}%burned`);
  } else if (token.lpBurned >= 50) {
    passedChecks.push(`lp:partial${token.lpBurned.toFixed(0)}%`);
  } else {
    failedChecks.push(`lp:notburned`);
  }
  
  // Pass if no critical failures
  const criticalFails = failedChecks.filter(f => 
    f.startsWith('momentum:') && !f.includes('weak') ||
    f.startsWith('holders:') ||
    f.startsWith('age:')
  );
  
  return {
    passed: criticalFails.length === 0 && passedChecks.length >= 3,
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
      symbol: token.tokenTicker,
      entryPrice: trade.pricePerToken,
      entryMcSol: token.marketCapSol,  // Store entry MC for ratio-based P&L
      platform: trade.platform,  // 'pump.fun' or 'jupiter'
    };
    
    logger.success(`  Trade entered: ${trade.tokenAmount.toFixed(2)} ${token.tokenTicker} @ ${trade.pricePerToken.toExponential(4)} SOL`);
    
  } catch (error) {
    logger.error('  Failed to enter trade:', error);
  }
}

async function monitorPosition(): Promise<void> {
  if (!state.currentPosition) return;
  
  const { mint, symbol, entryPrice, entryMcSol, platform } = state.currentPosition;
  
  // Check for manual exit request first
  if (manualExitRequested) {
    manualExitRequested = false;
    logger.info(`  🔴 Manual exit triggered for ${symbol}`);
    await exitPosition('MANUAL');
    return;
  }
  
  try {
    // Fetch current data from Axiom
    const trending = await getAxiomTrending(AXIOM_AUTO_CONFIG.timePeriod);
    const token = trending.find(t => t.tokenAddress === mint);
    
    if (!token) {
      // Token not in trending - fetch live data directly from DexScreener
      logger.debug(`  ${symbol} not in trending, using DexScreener...`);
      
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (response.ok) {
          const data = await response.json() as any;
          const pairs = data?.pairs || [];
          if (pairs.length > 0) {
            const topPair = pairs.sort((a: any, b: any) => 
              (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
            )[0];
            const currentPriceSol = parseFloat(topPair.priceNative) || 0;
            const currentMcUsd = topPair.marketCap || topPair.fdv || 0;
            
            if (currentPriceSol > 0) {
              const pnlPercent = ((currentPriceSol - entryPrice) / entryPrice) * 100;
              const emoji = pnlPercent >= 0 ? '📈' : '📉';
              const portfolio = getPaperPortfolio();
              const position = portfolio.positions.get(mint);
              const estimatedPnlSol = position ? position.costBasis * (pnlPercent / 100) : null;
              const pnlSolDisplay = estimatedPnlSol !== null
                ? ` | ${estimatedPnlSol >= 0 ? '+' : ''}${estimatedPnlSol.toFixed(4)} SOL est`
                : '';
              
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
              logger.info(`  ${emoji} ${symbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (SOL)${pnlSolDisplay} | MC: ${mcDisplay} | ${formatPrice(currentPriceSol)} (entry: ${formatPrice(entryPrice)})  [x to exit]`);
              
              // Check TP/SL
              if (pnlPercent >= AXIOM_AUTO_CONFIG.takeProfitPercent) {
                logger.success(`  🎯 Take profit hit! (+${pnlPercent.toFixed(1)}%)`);
                await exitPosition('TP');
              } else if (pnlPercent <= AXIOM_AUTO_CONFIG.stopLossPercent) {
                logger.warn(`  🛑 Stop loss hit! (${pnlPercent.toFixed(1)}%)`);
                await exitPosition('SL');
              }
              return;
            }
          }
        }
      } catch {
        // DexScreener fetch failed
      }
      
      logger.info(`  ⚠️ ${symbol} - Cannot fetch price, position still open  [x to exit manually]`);
      return;
    }
    
    // Get ACTUAL current price AND MC from DexScreener directly (fast, no candles overhead)
    let currentPriceSol: number = entryPrice;
    let currentMcUsd: number = 0;
    
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (response.ok) {
        const data = await response.json() as any;
        const pairs = data?.pairs || [];
        if (pairs.length > 0) {
          // Get pair with highest liquidity
          const topPair = pairs.sort((a: any, b: any) => 
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          )[0];
          currentPriceSol = parseFloat(topPair.priceNative) || entryPrice;
          currentMcUsd = topPair.marketCap || topPair.fdv || 0;
        }
      }
    } catch {
      // Keep entry price as fallback
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
    // P&L is in SOL terms (accurate), MC is just current reference
    logger.info(`  ${emoji} ${symbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (SOL)${pnlSolDisplay} | MC: ${mcDisplay} | ${formatPrice(currentPriceSol)} (entry: ${formatPrice(entryPrice)})  [x to exit]`);
    
    // Check TP/SL
    if (pnlPercent >= AXIOM_AUTO_CONFIG.takeProfitPercent) {
      logger.success(`  🎯 Take profit hit! (+${pnlPercent.toFixed(1)}%)`);
      await exitPosition('TP');
    } else if (pnlPercent <= AXIOM_AUTO_CONFIG.stopLossPercent) {
      logger.warn(`  🛑 Stop loss hit! (${pnlPercent.toFixed(1)}%)`);
      await exitPosition('SL');
    }
    
  } catch (error) {
    logger.info(`  ⚠️ Error monitoring ${symbol}: ${error}  [x to exit manually]`);
  }
}

async function exitPosition(reason: string): Promise<void> {
  if (!state.currentPosition) return;
  
  const { mint, symbol } = state.currentPosition;
  
  try {
    const trade = await paperSell(mint, symbol, 100, reason);
    
    if (trade) {
      const pnlEmoji = (trade.pnl || 0) >= 0 ? '📈' : '📉';
      const pnlPercentDisplay = trade.pnlPercent !== undefined
        ? ` (${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(1)}%)`
        : '';
      logger.success(`  ${pnlEmoji} Position closed: ${trade.pnl !== undefined ? (trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(4) : '0'} SOL${pnlPercentDisplay} (${reason})`);
    }
    
    // Add to recently traded so it won't be picked again
    state.recentlyTraded.add(mint);
    logger.info(`  Token ${symbol} added to cooldown list - will not be picked again this session`);
    
    state.currentPosition = null;
    state.lastTradeTime = Date.now();
    
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
