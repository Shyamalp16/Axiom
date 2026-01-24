import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  closePosition,
  getActivePositions,
  getPosition,
  updatePosition,
  getDailyStats,
  getWeeklyPnl,
} from '../trading/position-manager.js';
import { fetchMarketData, fetchSolPrice } from '../api/data-providers.js';
import {
  analyzePatterns,
  calculateDailyStats,
  getAllTrades,
} from '../storage/trade-logger.js';
import { bot } from '../bot/orchestrator.js';
import { runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import {
  getPaperPortfolio,
  getPaperTrades,
  loadPaperTrades,
  paperSell,
  resetPaperTrading,
} from '../trading/paper-trader.js';
import {
  isAxiomAuthenticated,
  loadAxiomAuthFromEnv,
  updateAxiomTokens,
  getAxiomTrackedWallets,
  getAxiomTrackedWalletTransactionsWithNames,
  AxiomWalletTransactionWithName,
  getAutoRefreshStatus,
  startAutoRefresh,
  stopAutoRefresh,
} from '../api/axiom-trade.js';
import { fetchPumpFunToken, fetchPumpFunTokenLive, fetchPumpFunTokenUltraFresh } from '../api/pump-fun.js';
import {
  startMirroring,
  stopMirroring,
  getMirrorState,
  getMirrorTrades,
  updateMirrorConfig,
  resetMirrorStats,
  loadMirrorState,
  syncMirroredPositions,
} from '../trading/mirror-trader.js';

// Initialize Axiom auth on startup
loadAxiomAuthFromEnv();

// Load mirror state on startup
loadMirrorState();

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');
const DATA_DIR = path.resolve(__dirname, '../../data');
const AXIOM_STATUS_FILE = path.join(DATA_DIR, 'axiom_auto_status.json');
const AXIOM_COMMAND_FILE = path.join(DATA_DIR, 'axiom_auto_command.json');

app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use(express.static(publicDir));

function serializePosition(position: ReturnType<typeof getPosition>) {
  if (!position) return null;
  return {
    ...position,
    entryTime: position.entryTime.toISOString(),
    tranches: position.tranches.map(tranche => ({
      ...tranche,
      timestamp: tranche.timestamp.toISOString(),
    })),
  };
}

const MARKET_CACHE_TTL_MS = 1500;
const marketCache = new Map<string, { timestamp: number; data: Awaited<ReturnType<typeof fetchMarketData>> }>();

async function getMarketDataCached(mint: string) {
  const cached = marketCache.get(mint);
  const now = Date.now();
  if (cached && now - cached.timestamp < MARKET_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchMarketData(mint, 15);
  marketCache.set(mint, { timestamp: now, data });
  return data;
}

function serializePaperPosition(position: ReturnType<typeof getPaperPortfolio>['positions'], mint: string, marketPriceSol: number) {
  const paperPosition = position.get(mint);
  if (!paperPosition) return null;
  const currentValue = paperPosition.tokenAmount * marketPriceSol;
  const unrealizedPnl = currentValue - paperPosition.costBasis;
  const unrealizedPnlPercent = paperPosition.costBasis > 0
    ? (unrealizedPnl / paperPosition.costBasis) * 100
    : 0;

  return {
    id: `paper_${paperPosition.mint}`,
    mint: paperPosition.mint,
    symbol: paperPosition.symbol,
    entryPrice: paperPosition.avgEntryPrice,
    currentPrice: marketPriceSol,
    quantity: paperPosition.tokenAmount,
    costBasis: paperPosition.costBasis,
    unrealizedPnl,
    unrealizedPnlPercent,
    highestPrice: marketPriceSol,
    entryTime: new Date(paperPosition.entryTime).toISOString(),
    status: 'active',
    priceUnit: 'sol',
    source: 'paper',
    // DCA'd entry MC from paper position
    entryMcUsd: paperPosition.entryMcUsd || undefined,
  };
}

function readAxiomAutoStatus(): any | null {
  try {
    if (!existsSync(AXIOM_STATUS_FILE)) return null;
    const raw = readFileSync(AXIOM_STATUS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendAxiomAutoCommand(action: string, data?: Record<string, unknown>): void {
  try {
    if (!existsSync(DATA_DIR)) {
      return;
    }
    writeFileSync(AXIOM_COMMAND_FILE, JSON.stringify({ action, ...data, timestamp: new Date().toISOString() }, null, 2));
  } catch {
    // Ignore
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/routes', (_req, res) => {
  const routes: Array<{ path: string; methods: string[] }> = [];
  (app as any)._router.stack.forEach((layer: any) => {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
      routes.push({ path: layer.route.path, methods });
    }
  });
  res.json({ routes });
});

app.get('/api/positions', (_req, res) => {
  try {
    loadPaperTrades();
    const livePositions = getActivePositions();
    const paperPortfolio = getPaperPortfolio();
    const axiomStatus = readAxiomAutoStatus();

    Promise.allSettled([
      Promise.all(livePositions.map(async position => {
        try {
          const market = await getMarketDataCached(position.mint);
          const priceUsd = market.priceUsd || position.currentPrice || position.entryPrice;
          updatePosition(position.id, priceUsd);
          return {
            ...serializePosition(position),
            priceUnit: 'usd',
            source: 'live',
          };
        } catch {
          return {
            ...serializePosition(position),
            priceUnit: 'usd',
            source: 'live',
          };
        }
      })),
      Promise.all(Array.from(paperPortfolio.positions.keys()).map(async mint => {
        try {
          const market = await getMarketDataCached(mint);
          return serializePaperPosition(paperPortfolio.positions, mint, market.priceSol);
        } catch {
          const position = paperPortfolio.positions.get(mint);
          const fallbackPrice = position?.avgEntryPrice || 0;
          return serializePaperPosition(paperPortfolio.positions, mint, fallbackPrice);
        }
      })),
    ]).then(results => {
      const live = results[0].status === 'fulfilled' ? results[0].value : [];
      const paper = results[1].status === 'fulfilled' ? results[1].value : [];
      const positions = [...live, ...paper].filter(Boolean);

      let axiomAutoCount = 0;
      if (axiomStatus?.currentPosition) {
        const cp = axiomStatus.currentPosition;
        const normalizedMint = cp.mint;
        const deduped = positions.filter(position => position?.mint !== normalizedMint);
        positions.length = 0;
        positions.push(...deduped);
        positions.push({
          id: 'axiom_auto',
          mint: cp.mint,
          symbol: cp.symbol,
          entryPrice: cp.entryPrice,
          currentPrice: cp.lastPriceSol ?? cp.entryPrice,
          quantity: cp.costBasisSol && cp.entryPrice ? cp.costBasisSol / cp.entryPrice : 0,
          costBasis: cp.costBasisSol ?? 0,
          unrealizedPnl: cp.estimatedPnlSol ?? 0,
          unrealizedPnlPercent: cp.lastPnlPercent ?? 0,
          highestPrice: cp.lastPriceSol ?? cp.entryPrice,
          entryTime: axiomStatus.startTime,
          status: 'active',
          priceUnit: 'sol',
          source: 'axiom-auto',
        });
        axiomAutoCount = 1;
      }

      res.json({
        positions,
        counts: {
          live: live.length,
          paper: paper.length,
          axiomAuto: axiomAutoCount,
        },
        updatedAt: new Date().toISOString(),
      });
    }).catch(error => {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load positions' });
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load positions' });
  }
});

app.get('/api/positions/:id', async (req, res) => {
  const source = req.query.source === 'paper'
    ? 'paper'
    : req.query.source === 'axiom-auto'
      ? 'axiom-auto'
      : 'live';
  const id = req.params.id;

  if (source === 'paper') {
    loadPaperTrades();
    const portfolio = getPaperPortfolio();
    const mint = id.startsWith('paper_') ? id.replace('paper_', '') : id;
    const position = portfolio.positions.get(mint);
    if (!position) {
      res.status(404).json({ error: 'Paper position not found' });
      return;
    }
    const [market, solPrice] = await Promise.all([
      getMarketDataCached(position.mint),
      fetchSolPrice(),
    ]);
    res.json({
      position: serializePaperPosition(portfolio.positions, mint, market.priceSol),
      market,
      solPrice,
    });
    return;
  }

  if (source === 'axiom-auto') {
    const axiomStatus = readAxiomAutoStatus();
    const cp = axiomStatus?.currentPosition;
    if (!cp) {
      res.status(404).json({ error: 'Axiom auto position not found' });
      return;
    }
    const [market, solPrice] = await Promise.all([
      getMarketDataCached(cp.mint),
      fetchSolPrice(),
    ]);
    res.json({
      position: {
        id: 'axiom_auto',
        mint: cp.mint,
        symbol: cp.symbol,
        entryPrice: cp.entryPrice,
        currentPrice: cp.lastPriceSol ?? cp.entryPrice,
        quantity: cp.costBasisSol && cp.entryPrice ? cp.costBasisSol / cp.entryPrice : 0,
        costBasis: cp.costBasisSol ?? 0,
        unrealizedPnl: cp.estimatedPnlSol ?? 0,
        unrealizedPnlPercent: cp.lastPnlPercent ?? 0,
        highestPrice: cp.lastPriceSol ?? cp.entryPrice,
        entryTime: axiomStatus?.startTime,
        status: 'active',
        priceUnit: 'sol',
        source: 'axiom-auto',
      },
      market,
      solPrice,
    });
    return;
  }

  const position = getPosition(id);
  if (!position) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }

  const [market, solPrice] = await Promise.all([
    getMarketDataCached(position.mint),
    fetchSolPrice(),
  ]);

  res.json({
    position: {
      ...serializePosition(position),
      priceUnit: 'usd',
      source: 'live',
    },
    market,
    solPrice,
  });
});

app.post('/api/positions/:id/exit', async (req, res) => {
  const source = req.query.source === 'paper'
    ? 'paper'
    : req.query.source === 'axiom-auto'
      ? 'axiom-auto'
      : 'live';
  const id = req.params.id;

  if (source === 'paper') {
    loadPaperTrades();
    const portfolio = getPaperPortfolio();
    const mint = id.startsWith('paper_') ? id.replace('paper_', '') : id;
    const position = portfolio.positions.get(mint);
    if (!position) {
      res.status(404).json({ error: 'Paper position not found' });
      return;
    }

    const trade = await paperSell(position.mint, position.symbol, 100, 'ui_exit');
    res.json({ ok: true, trade });
    return;
  }

  if (source === 'axiom-auto') {
    const status = readAxiomAutoStatus();
    if (!status?.currentPosition) {
      res.status(404).json({ error: 'Axiom auto position not found' });
      return;
    }
    sendAxiomAutoCommand('exit');
    res.json({ ok: true, action: 'exit' });
    return;
  }

  const position = getPosition(id);
  if (!position) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }

  const market = await getMarketDataCached(position.mint);
  const sellPrice = market.priceUsd || position.currentPrice || position.entryPrice;
  updatePosition(position.id, sellPrice);

  const result = closePosition(position.id, sellPrice, 100, 'manual_exit');

  res.json({
    ok: true,
    pnl: result.pnl,
    remainingPosition: serializePosition(result.remainingPosition || undefined),
  });
});

app.get('/api/stats', (_req, res) => {
  loadPaperTrades();
  const daily = calculateDailyStats();
  const patterns = analyzePatterns();
  const allTrades = getAllTrades();
  const paperPortfolio = getPaperPortfolio();
  const paperTrades = getPaperTrades();

  res.json({
    daily,
    patterns,
    totalTrades: allTrades.length,
    lastTrade: allTrades[allTrades.length - 1] || null,
    paper: {
      portfolio: {
        ...paperPortfolio,
        positions: Array.from(paperPortfolio.positions.values()),
      },
      totalTrades: paperTrades.length,
      lastTrade: paperTrades[paperTrades.length - 1] || null,
    },
  });
});

app.get('/api/bot/status', (_req, res) => {
  const state = bot.getState();
  res.json({
    state,
    daily: getDailyStats(),
    weeklyPnl: getWeeklyPnl(),
    activePositions: getActivePositions().map(p => serializePosition(p)),
  });
});

app.get('/api/axiom-auto/status', (_req, res) => {
  const status = readAxiomAutoStatus();
  if (!status) {
    res.status(404).json({ error: 'Axiom auto status not found' });
    return;
  }
  res.json(status);
});

app.post('/api/axiom-auto/manual-entry', (req, res) => {
  const mint = req.body?.mint;
  if (!mint || typeof mint !== 'string' || mint.length < 32) {
    res.status(400).json({ error: 'Valid mint address required' });
    return;
  }
  sendAxiomAutoCommand('manual_entry', { mint: mint.trim() });
  res.json({ ok: true, action: 'manual_entry', mint: mint.trim() });
});

app.post('/api/bot/init', async (_req, res) => {
  const ok = await bot.initialize();
  res.json({ ok });
});

app.post('/api/bot/start', async (_req, res) => {
  await bot.start();
  res.json({ ok: true });
});

app.post('/api/bot/stop', (_req, res) => {
  bot.stop();
  res.json({ ok: true });
});

app.post('/api/bot/check-token', async (req, res) => {
  const mint = req.body?.mint;
  if (!mint) {
    res.status(400).json({ error: 'mint required' });
    return;
  }
  try {
    const result = await runPreTradeChecklist(mint);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Checklist failed' });
  }
});

app.post('/api/bot/trade', async (req, res) => {
  const mint = req.body?.mint;
  if (!mint) {
    res.status(400).json({ error: 'mint required' });
    return;
  }
  try {
    const result = await bot.analyzeAndTrade(mint);
    res.json({
      ...result,
      activePositions: getActivePositions().map(p => serializePosition(p)),
    });
  } catch (error) {
    res.status(500).json({ success: false, reason: error instanceof Error ? error.message : 'Trade failed' });
  }
});

app.get('/api/paper/portfolio', (_req, res) => {
  loadPaperTrades();
  const portfolio = getPaperPortfolio();
  res.json({
    portfolio: {
      ...portfolio,
      positions: Array.from(portfolio.positions.values()),
    },
  });
});

app.get('/api/paper/trades', (req, res) => {
  loadPaperTrades();
  const limit = Number(req.query.limit || 50);
  const trades = getPaperTrades();
  res.json({ trades: trades.slice(-limit) });
});

app.post('/api/paper/reset', (req, res) => {
  const startingBalance = Number(req.body?.startingBalance || 2);
  resetPaperTrading(startingBalance);
  // Also reset mirror stats when resetting paper trading
  resetMirrorStats();
  res.json({ ok: true });
});

// ============================================
// WALLET TRACKER API ENDPOINTS
// ============================================

app.get('/api/tracker/status', (_req, res) => {
  const autoRefresh = getAutoRefreshStatus();
  res.json({
    authenticated: isAxiomAuthenticated(),
    autoRefresh: autoRefresh.enabled,
    nextRefreshAt: autoRefresh.nextRefreshAt,
    timestamp: new Date().toISOString(),
  });
});

// Update Axiom auth tokens (allows updating via UI instead of editing .env)
app.post('/api/tracker/auth', (req, res) => {
  try {
    const { accessToken, refreshToken } = req.body || {};
    
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }
    
    // Update tokens (accessToken is optional - will be fetched if not provided)
    const success = updateAxiomTokens(accessToken || null, refreshToken);
    
    if (success) {
      res.json({ 
        ok: true, 
        message: 'Axiom tokens updated successfully',
        authenticated: isAxiomAuthenticated(),
      });
    } else {
      res.status(400).json({ error: 'Failed to update tokens' });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update tokens' });
  }
});

app.get('/api/tracker/wallets', async (_req, res) => {
  try {
    if (!isAxiomAuthenticated()) {
      res.status(401).json({ error: 'Axiom not authenticated. Please update your tokens via the Settings tab.' });
      return;
    }
    
    const { groups, trackedWallets } = await getAxiomTrackedWallets();
    res.json({
      groups,
      wallets: trackedWallets.map(w => ({
        id: w.id,
        address: w.trackedWalletAddress,
        name: w.name,
        emoji: w.emoji,
        solBalance: w.solBalance,
        lastActiveAt: w.lastActiveAt,
        createdAt: w.createdAt,
      })),
      total: trackedWallets.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch tracked wallets';
    // Return 401 for auth-related errors so UI knows to prompt re-login
    if (message.includes('Session expired') || message.includes('Refresh token invalid') || message.includes('login again')) {
      res.status(401).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

app.get('/api/tracker/transactions', async (req, res) => {
  try {
    if (!isAxiomAuthenticated()) {
      res.status(401).json({ error: 'Axiom not authenticated' });
      return;
    }
    
    const limit = Number(req.query.limit || 100);
    const walletAddress = req.query.wallet as string | undefined;
    const typeFilter = req.query.type as string | undefined; // 'buy', 'sell', or undefined for all
    
    let transactions = await getAxiomTrackedWalletTransactionsWithNames();
    
    // Filter by wallet if specified
    if (walletAddress) {
      transactions = transactions.filter(tx => 
        tx.walletAddress.toLowerCase() === walletAddress.toLowerCase()
      );
    }
    
    // Filter by type if specified
    if (typeFilter === 'buy') {
      transactions = transactions.filter(tx => tx.type === 'buy');
    } else if (typeFilter === 'sell') {
      transactions = transactions.filter(tx => tx.type === 'sell');
    }
    
    // Sort by time (most recent first)
    transactions.sort((a, b) => 
      new Date(b.transactionTime).getTime() - new Date(a.transactionTime).getTime()
    );
    
    // Apply limit
    transactions = transactions.slice(0, limit);
    
    res.json({
      transactions: transactions.map(tx => ({
        signature: tx.signature,
        walletAddress: tx.walletAddress,
        walletName: tx.walletName || null,
        walletEmoji: tx.walletEmoji || null,
        type: tx.type,
        detailedType: tx.detailedType,
        tokenAddress: tx.tokenAddress,
        tokenName: tx.tokenName,
        tokenTicker: tx.tokenTicker,
        tokenImage: tx.tokenImage,
        priceSol: tx.priceSol,
        priceUsd: tx.priceUsd,
        totalSol: tx.totalSol,
        totalUsd: tx.totalUsd,
        tokenAmount: tx.tokenAmount,
        pnlSol: tx.pnlSol,
        feesSol: tx.feesSol,
        averageMcBought: tx.averageMcBought,
        averageMcSold: tx.averageMcSold,
        liquiditySol: tx.liquiditySol,
        realProtocol: tx.realProtocol,
        isMigrated: tx.isMigrated,
        transactionTime: tx.transactionTime,
        pairCreatedAt: tx.pairCreatedAt,
      })),
      total: transactions.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch transactions';
    // Return 401 for auth-related errors
    if (message.includes('Session expired') || message.includes('Refresh token invalid') || message.includes('login again')) {
      res.status(401).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// ============================================
// MIRROR TRADER API ENDPOINTS
// ============================================

app.get('/api/mirror/status', async (_req, res) => {
  const state = getMirrorState();
  
  // Enrich active positions with paper portfolio data for accurate PnL
  loadPaperTrades();
  const portfolio = getPaperPortfolio();
  
  const enrichedPositions = await Promise.all(
    state.activePositions.map(async (pos) => {
      const paperPos = portfolio.positions.get(pos.mint);
      if (paperPos) {
        // Get current market data for accurate PnL
        try {
          const market = await getMarketDataCached(pos.mint);
          const currentValue = paperPos.tokenAmount * market.priceSol;
          const unrealizedPnl = currentValue - paperPos.costBasis;
          const unrealizedPnlPercent = paperPos.costBasis > 0
            ? (unrealizedPnl / paperPos.costBasis) * 100
            : 0;
          
          return {
            ...pos,
            // Use paper position's stored entry MC (captured at buy time)
            // Don't derive from PnL - only show if we actually captured it
            entryMcUsd: paperPos.entryMcUsd || undefined,
            currentMcUsd: market.marketCap,
            costBasisSol: paperPos.costBasis,
            currentValueSol: currentValue,
            unrealizedPnl,
            unrealizedPnlPercent,
            currentPriceSol: market.priceSol,
            entryPriceSol: paperPos.avgEntryPrice,
          };
        } catch {
          return {
            ...pos,
            entryMcUsd: paperPos.entryMcUsd || undefined,
            costBasisSol: paperPos.costBasis,
            entryPriceSol: paperPos.avgEntryPrice,
          };
        }
      }
      return pos;
    })
  );
  
  res.json({
    ...state,
    activePositions: enrichedPositions,
  });
});

app.post('/api/mirror/start', (req, res) => {
  try {
    if (!isAxiomAuthenticated()) {
      res.status(401).json({ error: 'Axiom not authenticated' });
      return;
    }
    
    const config = req.body || {};
    const success = startMirroring({
      exactMirroring: config.exactMirroring ?? true,  // Default: copy exact SOL amounts
      mirrorBuys: config.mirrorBuys ?? true,
      mirrorSells: config.mirrorSells ?? true,
      onlyFirstBuys: config.onlyFirstBuys ?? false,
      walletFilter: config.walletFilter ?? [],
      minMarketCap: config.minMarketCap ?? 0,
      maxMarketCap: config.maxMarketCap ?? 0,
    });
    
    if (success) {
      res.json({ ok: true, message: 'Mirror trading started', state: getMirrorState() });
    } else {
      res.status(400).json({ error: 'Mirror trading already running' });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start mirroring' });
  }
});

app.post('/api/mirror/stop', (_req, res) => {
  try {
    stopMirroring();
    res.json({ ok: true, message: 'Mirror trading stopped', state: getMirrorState() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to stop mirroring' });
  }
});

app.get('/api/mirror/trades', (req, res) => {
  const limit = Number(req.query.limit || 100);
  const trades = getMirrorTrades(limit);
  res.json({ trades, total: trades.length });
});

app.post('/api/mirror/config', (req, res) => {
  try {
    const config = updateMirrorConfig(req.body || {});
    res.json({ ok: true, config });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update config' });
  }
});

app.post('/api/mirror/reset', (_req, res) => {
  try {
    resetMirrorStats();
    res.json({ ok: true, message: 'Mirror stats reset', state: getMirrorState() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reset' });
  }
});

// Sync existing paper positions to mirrored positions (so they can be sold)
app.post('/api/mirror/sync', (_req, res) => {
  try {
    const syncedCount = syncMirroredPositions();
    res.json({ 
      ok: true, 
      message: `Synced ${syncedCount} positions`, 
      syncedCount,
      state: getMirrorState() 
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to sync' });
  }
});

// ============================================
// TOKEN DATA API ENDPOINTS  
// ============================================

// Get token market cap from pump.fun API
app.get('/api/token/:mint/mc', async (req, res) => {
  try {
    const mint = req.params.mint;
    if (!mint || mint.length < 32) {
      res.status(400).json({ error: 'Invalid mint address' });
      return;
    }
    
    const token = await fetchPumpFunToken(mint);
    
    if (!token) {
      res.status(404).json({ error: 'Token not found', mint });
      return;
    }
    
    res.json({
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      marketCapUsd: token.marketCapUsd,
      marketCapSol: token.marketCapSol,
      priceUsd: token.priceUsd,
      priceSol: token.priceSol,
      bondingCurveProgress: token.bondingCurveProgress,
      isGraduated: token.isGraduated,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch token' });
  }
});

// Batch fetch token MCs (for transaction list) - fetches LIVE data
// This endpoint is critical for real-time MC display - always fetch fresh data
app.post('/api/tokens/mc', async (req, res) => {
  try {
    const mints: string[] = req.body?.mints || [];
    const fresh = req.query.fresh === 'true' || req.body?.fresh === true;
    
    if (!Array.isArray(mints) || mints.length === 0) {
      res.status(400).json({ error: 'mints array required' });
      return;
    }
    
    // Filter out invalid mints
    const validMints = mints.filter(mint => typeof mint === 'string' && mint.length >= 32);
    
    // Limit to 10 tokens per request for faster response
    const limitedMints = validMints.slice(0, 10);
    
    const results: Record<string, { marketCapUsd: number; marketCapSol: number; symbol: string } | null> = {};
    
    // Fetch in parallel - no stagger needed for small batches
    const fetchPromises = limitedMints.map(async (mint) => {
      try {
        // ALWAYS use ultra fresh fetch for real-time MC tracking
        // The fresh flag just determines if we also try fallback
        const token = await fetchPumpFunTokenUltraFresh(mint);
        
        if (token && token.marketCapUsd > 0) {
          results[mint] = {
            marketCapUsd: token.marketCapUsd,
            marketCapSol: token.marketCapSol,
            symbol: token.symbol,
          };
        } else if (!fresh) {
          // If not explicitly fresh and ultra-fresh failed, try regular fetch
          const fallbackToken = await fetchPumpFunToken(mint, true);
          if (fallbackToken && fallbackToken.marketCapUsd > 0) {
            results[mint] = {
              marketCapUsd: fallbackToken.marketCapUsd,
              marketCapSol: fallbackToken.marketCapSol,
              symbol: fallbackToken.symbol,
            };
          } else {
            results[mint] = null;
          }
        } else {
          results[mint] = null;
        }
      } catch (error) {
        console.error(`MC fetch error for ${mint.slice(0, 8)}:`, error);
        results[mint] = null;
      }
    });
    
    // Wait for all fetches with a global timeout
    await Promise.race([
      Promise.all(fetchPromises),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000)),
    ]).catch(() => {
      // Timeout - return whatever we have
      console.warn('MC batch fetch timed out, returning partial results');
    });
    
    res.json({ tokens: results, timestamp: Date.now() });
  } catch (error) {
    console.error('MC endpoint error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch tokens' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`UI server running at http://localhost:${port}`);
});
