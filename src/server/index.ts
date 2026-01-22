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

function sendAxiomAutoCommand(action: string): void {
  try {
    if (!existsSync(DATA_DIR)) {
      return;
    }
    writeFileSync(AXIOM_COMMAND_FILE, JSON.stringify({ action, timestamp: new Date().toISOString() }, null, 2));
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
  res.json({ ok: true });
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
