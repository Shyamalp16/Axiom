const state = {
  positions: [],
  selectedId: null,
  refreshInterval: null,
  filterSource: 'all',
  // Tracker state
  trackerWallets: [],
  trackerTransactions: [],
  selectedWalletAddress: null,
  trackerFilter: 'all', // 'all', 'buy', 'sell'
  // SOL price for MC calculations
  solPrice: 200, // Default, will be updated
  // Token MC cache (mint -> { marketCapUsd, timestamp })
  tokenMcCache: new Map(),
  // Last MC refresh timestamp
  lastMcRefresh: null,
};

const positionsList = document.getElementById('positionsList');
const positionDetail = document.getElementById('positionDetail');
const positionsStatus = document.getElementById('positionsStatus');
const statsStatus = document.getElementById('statsStatus');
const statsGrid = document.getElementById('statsGrid');
const statsDetail = document.getElementById('statsDetail');
const controlStatus = document.getElementById('controlStatus');
const botStatusMetrics = document.getElementById('botStatusMetrics');
const paperStatusMetrics = document.getElementById('paperStatusMetrics');
const actionOutput = document.getElementById('actionOutput');

// Tracker elements
const trackerStatus = document.getElementById('trackerStatus');
const walletList = document.getElementById('walletList');
const transactionsList = document.getElementById('transactionsList');
const transactionsTitle = document.getElementById('transactionsTitle');
const transactionsCount = document.getElementById('transactionsCount');
const refreshWalletsBtn = document.getElementById('refreshWalletsBtn');
const trackerFilterButtons = document.querySelectorAll('.tracker-filter-btn');

// Mirror elements
const mirrorIndicator = document.getElementById('mirrorIndicator');
const mirrorStatusText = document.getElementById('mirrorStatusText');
const mirrorBuysEl = document.getElementById('mirrorBuys');
const mirrorSellsEl = document.getElementById('mirrorSells');
const mirrorPnlEl = document.getElementById('mirrorPnl');
const startMirrorBtn = document.getElementById('startMirrorBtn');
const stopMirrorBtn = document.getElementById('stopMirrorBtn');
const resetMirrorBtn = document.getElementById('resetMirrorBtn');
const mirrorDetails = document.getElementById('mirrorDetails');
const mirrorPositionsList = document.getElementById('mirrorPositionsList');
const mirrorTradesList = document.getElementById('mirrorTradesList');

const filterButtons = document.querySelectorAll('.filter-btn');

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(btn => btn.classList.remove('active'));
    panels.forEach(panel => panel.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

filterButtons.forEach(button => {
  button.addEventListener('click', () => {
    filterButtons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    state.filterSource = button.dataset.filter || 'all';
    renderPositions();
  });
});

// Tracker filter buttons
trackerFilterButtons.forEach(button => {
  button.addEventListener('click', () => {
    trackerFilterButtons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    state.trackerFilter = button.dataset.filter || 'all';
    loadTrackerTransactions();
  });
});

// Refresh wallets button
if (refreshWalletsBtn) {
  refreshWalletsBtn.addEventListener('click', () => {
    loadTrackerWallets();
    loadTrackerTransactions();
  });
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatCurrency(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `$${formatNumber(value, digits)}`;
}

function formatSmallNumber(value, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  
  // For very small values, use scientific notation
  if (Math.abs(value) < 0.000001) {
    return value.toExponential(4);
  }
  
  // For small values, show more decimal places
  if (Math.abs(value) < 0.001) {
    return value.toFixed(10).replace(/\.?0+$/, '');
  }
  
  return formatNumber(value, digits);
}

function formatPrice(value, unit, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return unit === 'sol' ? '0 SOL' : '$0';
  
  // For very small values, use scientific notation
  if (Math.abs(value) < 0.000001) {
    const formatted = value.toExponential(4);
    return unit === 'sol' ? `${formatted} SOL` : `$${formatted}`;
  }
  
  // For small values, show more decimal places
  if (Math.abs(value) < 0.001) {
    const formatted = value.toFixed(10).replace(/\.?0+$/, '');
    return unit === 'sol' ? `${formatted} SOL` : `$${formatted}`;
  }
  
  if (unit === 'sol') {
    return `${formatNumber(value, digits)} SOL`;
  }
  return formatCurrency(value, digits);
}

function formatPercent(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}%`;
}

function renderPositions() {
  positionsList.innerHTML = '';

  const visiblePositions = state.filterSource === 'all'
    ? state.positions
    : state.positions.filter(position => position.source === state.filterSource);

  if (!visiblePositions.length) {
    positionsList.innerHTML = `<div class="empty-state">No active positions.</div>`;
    positionDetail.innerHTML = `<div class="empty-state">
      <h3>No position selected</h3>
      <p>Open a trade to see details here.</p>
    </div>`;
    return;
  }

  if (!visiblePositions.find(position => position.id === state.selectedId)) {
    state.selectedId = visiblePositions[0].id;
    loadPositionDetail(state.selectedId);
  }

  // Fetch MCs for all visible positions
  const positionMints = visiblePositions.map(p => p.mint).filter(m => m && m.length >= 32);
  if (positionMints.length > 0) {
    fetchTokenMcs(positionMints, false);
  }

  visiblePositions.forEach(position => {
    const card = document.createElement('div');
    card.className = `position-card ${state.selectedId === position.id ? 'active' : ''}`;
    const pnlClass = position.unrealizedPnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative';
    
    // Get current MC from cache
    const currentMc = getCachedMc(position.mint);
    
    // Use server-provided entry MC (properly DCA'd) or fall back to local tracking
    let entryMcUsd = position.entryMcUsd || getEntryMc(position.mint, 'position');
    if (!entryMcUsd && currentMc && currentMc > 0) {
      // Calculate entry MC from PnL% if we have current MC (fallback)
      if (position.unrealizedPnlPercent !== undefined && position.unrealizedPnlPercent !== null) {
        const pnlFactor = 1 + (position.unrealizedPnlPercent / 100);
        if (pnlFactor > 0) {
          entryMcUsd = currentMc / pnlFactor;
        }
      }
    }
    // Update local tracker with server value for consistency
    if (position.entryMcUsd && position.entryMcUsd > 0) {
      trackEntryMc(position.mint, 'position', position.entryMcUsd);
    }
    
    // Format MC for display
    const formatMc = (mc) => {
      if (!mc || mc <= 0) return '—';
      if (mc >= 1000000) return `$${formatNumber(mc / 1000000, 2)}M`;
      if (mc >= 1000) return `$${formatNumber(mc / 1000, 1)}K`;
      return `$${formatNumber(mc, 0)}`;
    };
    
    const entryMcStr = formatMc(entryMcUsd);
    const currentMcStr = formatMc(currentMc);

    card.innerHTML = `
      <h3>${position.symbol}</h3>
      <div class="source-badge">${position.source}</div>
      <div class="card-row">
        <span>Status</span>
        <span>${position.status}</span>
      </div>
      <div class="card-row">
        <span>Entry MC</span>
        <span>${entryMcStr}</span>
      </div>
      <div class="card-row">
        <span>Current MC</span>
        <span>${currentMcStr}</span>
      </div>
      <div class="card-row">
        <span>PnL %</span>
        <span class="${pnlClass}">${formatPercent(position.unrealizedPnlPercent)}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      state.selectedId = position.id;
      renderPositions();
      loadPositionDetail(position.id);
    });

    positionsList.appendChild(card);
  });
}

function drawPriceChart(canvas, candles) {
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  if (!candles || candles.length < 2) {
    ctx.fillStyle = '#9aa5b1';
    ctx.fillText('No candle data', 10, 20);
    return;
  }

  const prices = candles.map(c => c.close);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 2;
  ctx.beginPath();

  prices.forEach((price, index) => {
    const x = (index / (prices.length - 1)) * (width - 20) + 10;
    const y = height - ((price - min) / range) * (height - 20) - 10;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();
}

async function loadPositions() {
  positionsStatus.textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/positions');
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to load positions');
    }
    state.positions = data.positions || [];
    const filtered = state.filterSource === 'all'
      ? state.positions
      : state.positions.filter(position => position.source === state.filterSource);
    if (!state.selectedId && filtered.length) {
      state.selectedId = filtered[0].id;
    }
    positionsStatus.textContent = `${data.counts?.live || 0} live · ${data.counts?.paper || 0} paper · ${data.counts?.axiomAuto || 0} axiom`;
    renderPositions();
    if (state.selectedId) {
      loadPositionDetail(state.selectedId);
    }
  } catch (error) {
    positionsStatus.textContent = error instanceof Error ? error.message : 'Failed to load';
  }
}

async function loadPositionDetail(positionId) {
  positionDetail.innerHTML = `<div class="empty-state">Loading position…</div>`;
  try {
    const positionMeta = state.positions.find(position => position.id === positionId);
    const source = positionMeta?.source || 'live';
    const response = await fetch(`/api/positions/${positionId}?source=${source}`);
    if (!response.ok) {
      positionDetail.innerHTML = `<div class="empty-state">Position not found.</div>`;
      return;
    }
    const data = await response.json();
    const position = data.position;
    const market = data.market || {};
    const solPrice = data.solPrice || 0;
    const pnlClass = position.unrealizedPnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative';
    const priceUnitLabel = position.priceUnit === 'sol' ? 'SOL' : 'USD';

    // Use server-provided entry MC (properly DCA'd) or calculate from PnL
    const currentMcUsd = market.marketCap || 0;
    let entryMcUsd = position.entryMcUsd || getEntryMc(position.mint, 'position');
    if (!entryMcUsd && currentMcUsd > 0 && position.unrealizedPnlPercent !== undefined) {
      // Fallback: calculate from PnL% if no server-provided value
      const pnlFactor = 1 + (position.unrealizedPnlPercent / 100);
      if (pnlFactor > 0) {
        entryMcUsd = currentMcUsd / pnlFactor;
      }
    }
    // Update local tracker with server value
    if (position.entryMcUsd && position.entryMcUsd > 0) {
      trackEntryMc(position.mint, 'position', position.entryMcUsd);
    }
    
    // Format MC values
    const formatMcDisplay = (mc) => {
      if (!mc || mc <= 0) return '—';
      if (mc >= 1000000) return `$${formatNumber(mc / 1000000, 2)}M`;
      if (mc >= 1000) return `$${formatNumber(mc / 1000, 1)}K`;
      return formatCurrency(mc, 0);
    };

    positionDetail.innerHTML = `
      <div class="detail-header">
        <div class="detail-title">${position.symbol} · ${position.mint.slice(0, 6)}…</div>
        <div class="${pnlClass}">${formatPercent(position.unrealizedPnlPercent)}</div>
      </div>
      <div class="detail-grid">
        <div class="metric-card">
          <div class="metric-label">PnL (SOL)</div>
          <div class="metric-value ${pnlClass}">${formatNumber(position.unrealizedPnl, 4)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Entry MC</div>
          <div class="metric-value">${formatMcDisplay(entryMcUsd)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Current MC</div>
          <div class="metric-value">${formatMcDisplay(currentMcUsd)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Token Price (SOL)</div>
          <div class="metric-value">${formatSmallNumber(market.priceSol, 6)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Token Price (USD)</div>
          <div class="metric-value">$${formatSmallNumber(market.priceUsd, 6)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">SOL Price (USD)</div>
          <div class="metric-value">${formatCurrency(solPrice, 2)}</div>
        </div>
      </div>
      <div class="chart-wrapper">
        <div class="chart-header">
          <span>Price Action (candles)</span>
          <span>${(market.candles || []).length} points</span>
        </div>
        <canvas class="chart-canvas" id="priceChart"></canvas>
      </div>
      <div class="detail-actions">
        <button class="btn btn-danger" id="exitBtn">Exit Position</button>
      </div>
    `;

    const chart = document.getElementById('priceChart');
    drawPriceChart(chart, market.candles || []);

    const exitBtn = document.getElementById('exitBtn');
    exitBtn.addEventListener('click', async () => {
      exitBtn.disabled = true;
      exitBtn.textContent = 'Exiting…';
      try {
        const exitResponse = await fetch(`/api/positions/${positionId}/exit?source=${source}`, {
          method: 'POST',
        });
        if (!exitResponse.ok) {
          throw new Error('Exit failed');
        }
        await loadPositions();
        positionDetail.innerHTML = `<div class="empty-state">
          <h3>Position exited</h3>
          <p>Refresh to see updated stats.</p>
        </div>`;
      } catch (error) {
        exitBtn.disabled = false;
        exitBtn.textContent = 'Exit Position';
        alert('Unable to exit position.');
      }
    });
  } catch (error) {
    positionDetail.innerHTML = `<div class="empty-state">Failed to load position.</div>`;
  }
}

function renderStatsCard(title, value, accentClass = '') {
  return `
    <div class="metric-card">
      <div class="metric-label">${title}</div>
      <div class="metric-value ${accentClass}">${value}</div>
    </div>
  `;
}

function renderActionOutput(data) {
  if (!actionOutput) return;
  if (!data) {
    actionOutput.textContent = 'No actions yet.';
    return;
  }
  actionOutput.textContent = JSON.stringify(data, null, 2);
}

async function loadStats() {
  statsStatus.textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/stats');
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to load stats');
    }

    const daily = data.daily || {};
    const patterns = data.patterns || {};
    const paperPortfolio = data.paper?.portfolio || {};
    const paperTotalPnl = paperPortfolio.totalPnL || 0;
    const pnlClass = daily.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
    const paperPnlClass = paperTotalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';

    statsGrid.innerHTML = [
      renderStatsCard('Total Trades', data.totalTrades ?? 0),
      renderStatsCard('Daily Trades', daily.trades ?? 0),
      renderStatsCard('Daily PnL', formatNumber(daily.totalPnl, 4), pnlClass),
      renderStatsCard('Win Rate', formatPercent(patterns.winRate || 0)),
      renderStatsCard('Paper Trades', data.paper?.totalTrades ?? 0),
      renderStatsCard('Paper PnL', formatNumber(paperTotalPnl, 4), paperPnlClass),
      renderStatsCard('Paper Balance', formatNumber(paperPortfolio.currentBalanceSOL || 0, 4)),
    ].join('');

    statsDetail.innerHTML = `
      <div class="stats-row"><span>Avg Win (SOL)</span><span>${formatNumber(patterns.avgWin, 4)}</span></div>
      <div class="stats-row"><span>Avg Loss (SOL)</span><span>${formatNumber(patterns.avgLoss, 4)}</span></div>
      <div class="stats-row"><span>Profit Factor</span><span>${formatNumber(patterns.profitFactor, 2)}</span></div>
      <div class="stats-row"><span>Most Common Exit</span><span>${patterns.mostCommonExitReason || '—'}</span></div>
      <div class="stats-row"><span>Avg Time (Wins)</span><span>${formatNumber((patterns.avgTimeInWinningTrades || 0) / 60, 1)}m</span></div>
      <div class="stats-row"><span>Avg Time (Losses)</span><span>${formatNumber((patterns.avgTimeInLosingTrades || 0) / 60, 1)}m</span></div>
    `;

    statsStatus.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statsStatus.textContent = error instanceof Error ? error.message : 'Failed to load';
  }
}

async function loadControl() {
  controlStatus.textContent = 'Refreshing…';
  try {
    const [botResponse, paperResponse] = await Promise.all([
      fetch('/api/bot/status'),
      fetch('/api/paper/portfolio'),
    ]);
    const botData = await botResponse.json();
    const paperData = await paperResponse.json();
    if (!botResponse.ok || botData.error) {
      throw new Error(botData.error || 'Bot status failed');
    }
    if (!paperResponse.ok || paperData.error) {
      throw new Error(paperData.error || 'Paper status failed');
    }

    const stateData = botData.state || {};
    const daily = botData.daily || {};
    const weeklyPnl = botData.weeklyPnl || 0;
    const running = stateData.isRunning ? 'Running' : 'Stopped';

    botStatusMetrics.innerHTML = `
      <div>Status: ${running}</div>
      <div>Disabled: ${stateData.isDisabled ? 'Yes' : 'No'}</div>
      <div>Daily Trades: ${daily.tradeCount ?? 0}</div>
      <div>Daily PnL: ${formatNumber(daily.pnl, 4)}</div>
      <div>Weekly PnL: ${formatNumber(weeklyPnl, 4)}</div>
    `;

    const portfolio = paperData.portfolio || {};
    paperStatusMetrics.innerHTML = `
      <div>Balance: ${formatNumber(portfolio.currentBalanceSOL || 0, 4)} SOL</div>
      <div>Total Trades: ${portfolio.totalTrades || 0}</div>
      <div>Win Rate: ${formatPercent(portfolio.winRate || 0)}</div>
      <div>Total PnL: ${formatNumber(portfolio.totalPnL || 0, 4)} SOL</div>
    `;

    controlStatus.textContent = 'Ready';
  } catch (error) {
    controlStatus.textContent = error instanceof Error ? error.message : 'Failed';
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  let data = {};
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => ({}));
  } else {
    const text = await response.text().catch(() => '');
    throw new Error(text || 'Request failed');
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function wireControlActions() {
  document.getElementById('botInitBtn').addEventListener('click', async () => {
    controlStatus.textContent = 'Initializing…';
    try {
      const result = await postJson('/api/bot/init');
      renderActionOutput(result);
      controlStatus.textContent = 'Initialized';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Init failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Init failed';
    }
    loadControl();
  });

  document.getElementById('botStartBtn').addEventListener('click', async () => {
    controlStatus.textContent = 'Starting…';
    try {
      const result = await postJson('/api/bot/start');
      renderActionOutput(result);
      controlStatus.textContent = 'Running';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Start failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Start failed';
    }
    loadControl();
  });

  document.getElementById('botStopBtn').addEventListener('click', async () => {
    controlStatus.textContent = 'Stopping…';
    try {
      const result = await postJson('/api/bot/stop');
      renderActionOutput(result);
      controlStatus.textContent = 'Stopped';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Stop failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Stop failed';
    }
    loadControl();
  });

  document.getElementById('checkTokenForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mint = document.getElementById('checkTokenInput').value.trim();
    if (!mint) return;
    controlStatus.textContent = 'Checking token…';
    try {
      const result = await postJson('/api/bot/check-token', { mint });
      renderActionOutput(result);
      controlStatus.textContent = 'Checklist complete';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Checklist failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Checklist failed';
    }
  });

  document.getElementById('tradeTokenForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mint = document.getElementById('tradeTokenInput').value.trim();
    if (!mint) return;
    controlStatus.textContent = 'Analyzing trade…';
    try {
      const result = await postJson('/api/bot/trade', { mint });
      renderActionOutput(result);
      if (result.success === false) {
        throw new Error(result.reason || 'Trade failed');
      }
      controlStatus.textContent = result.reason || 'Trade completed';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Trade failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Trade failed';
    }
  });

  document.getElementById('paperResetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = Number(document.getElementById('paperResetInput').value || 2);
    controlStatus.textContent = 'Resetting paper…';
    try {
      const result = await postJson('/api/paper/reset', { startingBalance: value });
      renderActionOutput(result);
      controlStatus.textContent = 'Paper reset';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Reset failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Reset failed';
    }
    loadControl();
    loadStats();
    loadPositions();
  });

  document.getElementById('manualEntryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mint = document.getElementById('manualEntryInput').value.trim();
    if (!mint) return;
    controlStatus.textContent = 'Sending manual entry…';
    try {
      const result = await postJson('/api/axiom-auto/manual-entry', { mint });
      renderActionOutput(result);
      controlStatus.textContent = 'Manual entry sent';
      document.getElementById('manualEntryInput').value = '';
    } catch (error) {
      renderActionOutput({ error: error instanceof Error ? error.message : 'Manual entry failed' });
      controlStatus.textContent = error instanceof Error ? error.message : 'Manual entry failed';
    }
    // Wait a moment for axiom-auto to process, then refresh
    setTimeout(() => {
      loadPositions();
      loadControl();
    }, 2000);
  });
}

// ============================================
// WALLET TRACKER FUNCTIONS
// ============================================

async function loadTrackerWallets() {
  if (!trackerStatus) return;
  trackerStatus.textContent = 'Loading wallets…';
  
  try {
    const response = await fetch('/api/tracker/wallets');
    const data = await response.json();
    
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to load wallets');
    }
    
    state.trackerWallets = data.wallets || [];
    trackerStatus.textContent = `${state.trackerWallets.length} wallet(s) tracked`;
    renderTrackerWallets();
    
  } catch (error) {
    trackerStatus.textContent = error instanceof Error ? error.message : 'Failed to load';
    walletList.innerHTML = `<div class="empty-state">Failed to load wallets. Check Axiom auth tokens.</div>`;
  }
}

async function loadTrackerTransactions() {
  if (!transactionsList) return;
  transactionsList.innerHTML = `<div class="empty-state">Loading transactions…</div>`;
  
  try {
    const params = new URLSearchParams();
    params.set('limit', '100');
    
    if (state.selectedWalletAddress) {
      params.set('wallet', state.selectedWalletAddress);
    }
    
    if (state.trackerFilter !== 'all') {
      params.set('type', state.trackerFilter);
    }
    
    const response = await fetch(`/api/tracker/transactions?${params}`);
    const data = await response.json();
    
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to load transactions');
    }
    
    state.trackerTransactions = data.transactions || [];
    renderTrackerTransactions();
    
    // Fetch real MCs from pump.fun API for visible transactions
    const uniqueMints = [...new Set(state.trackerTransactions.map(tx => tx.tokenAddress))];
    fetchTokenMcs(uniqueMints); // Runs async, re-renders when done
    
  } catch (error) {
    transactionsList.innerHTML = `<div class="empty-state">${error instanceof Error ? error.message : 'Failed to load'}</div>`;
  }
}

function renderTrackerWallets() {
  if (!walletList) return;
  walletList.innerHTML = '';
  
  if (!state.trackerWallets.length) {
    walletList.innerHTML = `<div class="empty-state" style="padding: 20px;">
      <p>No wallets tracked yet.</p>
      <p style="font-size: 11px;">Add wallets at <a href="https://axiom.trade/trackers" target="_blank" style="color: #00f0ff;">axiom.trade/trackers</a></p>
    </div>`;
    return;
  }
  
  // Add "All Wallets" option
  const allCard = document.createElement('div');
  allCard.className = `wallet-card ${!state.selectedWalletAddress ? 'active' : ''}`;
  allCard.innerHTML = `
    <div class="wallet-card-header">
      <span class="wallet-emoji">📊</span>
      <span class="wallet-name">All Wallets</span>
    </div>
    <div class="wallet-card-details">
      <span>${state.trackerWallets.length} tracked</span>
    </div>
  `;
  allCard.addEventListener('click', () => {
    state.selectedWalletAddress = null;
    renderTrackerWallets();
    loadTrackerTransactions();
    transactionsTitle.textContent = 'All Transactions';
  });
  walletList.appendChild(allCard);
  
  // Render individual wallets
  state.trackerWallets.forEach(wallet => {
    const card = document.createElement('div');
    card.className = `wallet-card ${state.selectedWalletAddress === wallet.address ? 'active' : ''}`;
    
    const lastActive = wallet.lastActiveAt ? formatTimeAgo(new Date(wallet.lastActiveAt)) : 'Unknown';
    
    card.innerHTML = `
      <div class="wallet-card-header">
        <span class="wallet-emoji">${wallet.emoji || '👤'}</span>
        <span class="wallet-name">${escapeHtml(wallet.name)}</span>
      </div>
      <div class="wallet-card-details">
        <span class="wallet-address">${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}</span>
        <span class="wallet-balance">${formatNumber(wallet.solBalance, 2)} SOL</span>
        <span>Active: ${lastActive}</span>
      </div>
    `;
    
    card.addEventListener('click', () => {
      state.selectedWalletAddress = wallet.address;
      renderTrackerWallets();
      loadTrackerTransactions();
      transactionsTitle.textContent = `${wallet.emoji || ''} ${wallet.name}`.trim();
    });
    
    walletList.appendChild(card);
  });
}

function renderTrackerTransactions() {
  if (!transactionsList) return;
  transactionsList.innerHTML = '';
  
  if (!state.trackerTransactions.length) {
    transactionsList.innerHTML = `<div class="empty-state">No transactions found.</div>`;
    transactionsCount.textContent = '0 transactions';
    return;
  }
  
  transactionsCount.textContent = `${state.trackerTransactions.length} transactions`;
  
  state.trackerTransactions.forEach(tx => {
    const card = document.createElement('div');
    card.className = `transaction-card ${tx.type}`;
    
    const time = formatTimeAgo(new Date(tx.transactionTime));
    const walletDisplay = tx.walletName 
      ? `<span class="tx-wallet-emoji">${tx.walletEmoji || ''}</span> ${escapeHtml(tx.walletName)}`
      : `${tx.walletAddress.slice(0, 6)}…`;
    
    // Get current MC from cache (fetched from pump.fun API)
    const currentMc = getCachedMc(tx.tokenAddress);
    
    // MC display
    let mcDisplay = '';
    if (currentMc && currentMc > 1000) {
      mcDisplay = `MC: $${formatNumber(currentMc / 1000, 1)}K`;
    } else if (tx.liquiditySol && tx.liquiditySol > 0.5) {
      const estimatedMcUsd = tx.liquiditySol * 2 * state.solPrice;
      if (estimatedMcUsd >= 1000) {
        mcDisplay = `MC: ~$${formatNumber(estimatedMcUsd / 1000, 1)}K`;
      }
    }
    
    // For BUY transactions: track entry MC and calculate live P&L
    let livePnlDisplay = '';
    if (tx.type === 'buy' && currentMc) {
      // Track this as entry MC if it's a new buy
      const entryMc = tx.averageMcBought && tx.averageMcBought > 1000 
        ? tx.averageMcBought 
        : getEntryMc(tx.tokenAddress, tx.walletAddress);
      
      // Store entry MC from transaction data if we have it
      if (tx.averageMcBought && tx.averageMcBought > 1000) {
        trackEntryMc(tx.tokenAddress, tx.walletAddress, tx.averageMcBought);
      }
      
      if (entryMc && currentMc) {
        const pnlPercent = calculateMcPnl(entryMc, currentMc);
        if (pnlPercent !== null) {
          const pnlClass = pnlPercent >= 0 ? 'positive' : 'negative';
          const pnlSign = pnlPercent >= 0 ? '+' : '';
          livePnlDisplay = `<span class="tx-live-pnl ${pnlClass}">${pnlSign}${formatNumber(pnlPercent, 1)}%</span>`;
        }
      }
    }
    
    // For SELL transactions: use the PnL from the API
    let sellPnlDisplay = '';
    if (tx.type === 'sell') {
      const pnlClass = tx.pnlSol >= 0 ? 'positive' : 'negative';
      sellPnlDisplay = `<span class="tx-pnl ${pnlClass}">${tx.pnlSol >= 0 ? '+' : ''}${formatNumber(tx.pnlSol, 4)} SOL</span>`;
    }
    
    card.innerHTML = `
      <div class="tx-type">
        <span class="tx-type-badge ${tx.type}">${tx.type}</span>
        <span class="tx-detailed-type">${tx.detailedType}</span>
      </div>
      <div class="tx-main">
        <div class="tx-token-row">
          <img class="tx-token-image" src="${tx.tokenImage || ''}" alt="" onerror="this.style.display='none'">
          <span class="tx-token-name">${escapeHtml(tx.tokenName)}</span>
          <span class="tx-token-ticker">$${escapeHtml(tx.tokenTicker)}</span>
          <span class="tx-protocol">${tx.realProtocol}</span>
        </div>
        <div class="tx-wallet-row">
          ${walletDisplay}
          <span>•</span>
          <span class="tx-time">${time}</span>
          ${mcDisplay ? `<span>•</span><span class="tx-mc">${mcDisplay}</span>` : ''}
        </div>
      </div>
      <div class="tx-values">
        <span class="tx-amount ${tx.type}">${tx.type === 'buy' ? '-' : '+'}${formatNumber(tx.totalSol, 4)} SOL</span>
        <span class="tx-usd">$${formatNumber(tx.totalUsd, 2)}</span>
        ${livePnlDisplay}
        ${sellPnlDisplay}
      </div>
    `;
    
    transactionsList.appendChild(card);
  });
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================
// MIRROR TRADER FUNCTIONS
// ============================================

async function loadMirrorStatus() {
  try {
    const [statusResponse, tradesResponse] = await Promise.all([
      fetch('/api/mirror/status'),
      fetch('/api/mirror/trades?limit=20'),
    ]);
    
    const statusData = await statusResponse.json();
    const tradesData = await tradesResponse.json();
    
    if (!statusResponse.ok || statusData.error) {
      throw new Error(statusData.error || 'Failed to load mirror status');
    }
    
    updateMirrorUI(statusData, tradesData.trades || []);
  } catch (error) {
    console.error('Failed to load mirror status:', error);
  }
}

function updateMirrorUI(data, trades = []) {
  if (!mirrorIndicator) return;
  
  const isRunning = data.isRunning;
  const hasActivity = (data.stats?.successfulBuys || 0) > 0 || (data.activePositions?.length || 0) > 0;
  
  // Update indicator
  mirrorIndicator.className = `mirror-indicator ${isRunning ? 'active' : ''}`;
  mirrorStatusText.textContent = isRunning 
    ? 'Mirror: Running (exact amounts)'
    : 'Mirror: Off';
  
  // Update stats
  if (mirrorBuysEl) mirrorBuysEl.textContent = data.stats?.successfulBuys || 0;
  if (mirrorSellsEl) mirrorSellsEl.textContent = data.stats?.successfulSells || 0;
  if (mirrorPnlEl) {
    const pnl = data.stats?.totalPnL || 0;
    mirrorPnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(4);
    mirrorPnlEl.className = pnl >= 0 ? 'positive' : 'negative';
  }
  
  // Update buttons
  if (startMirrorBtn) startMirrorBtn.disabled = isRunning;
  if (stopMirrorBtn) stopMirrorBtn.disabled = !isRunning;
  
  // Show/hide details panel
  if (mirrorDetails) {
    if (isRunning || hasActivity) {
      mirrorDetails.classList.add('expanded');
    } else {
      mirrorDetails.classList.remove('expanded');
    }
  }
  
  // Render active positions
  renderMirrorPositions(data.activePositions || []);
  
  // Render trades
  renderMirrorTrades(trades);
}

function renderMirrorPositions(positions) {
  if (!mirrorPositionsList) return;
  
  if (!positions.length) {
    mirrorPositionsList.innerHTML = '<div class="empty-state-small">No active positions</div>';
    return;
  }
  
  // Fetch current MCs for all positions
  const mints = positions.map(p => p.mint).filter(m => m && m.length >= 32);
  if (mints.length > 0) {
    fetchTokenMcs(mints, false); // Will re-render when done
  }
  
  mirrorPositionsList.innerHTML = positions.map(pos => {
    const timeAgo = formatTimeAgo(new Date(pos.entryTime));
    
    // Use server-provided MC values (calculated from our actual position)
    const currentMc = pos.currentMcUsd || getCachedMc(pos.mint);
    const entryMcUsd = pos.entryMcUsd; // Our entry MC, calculated by server
    
    // Format MC for display
    const formatMc = (mc) => {
      if (!mc || mc <= 0) return '—';
      if (mc >= 1000000) return `$${formatNumber(mc / 1000000, 2)}M`;
      if (mc >= 1000) return `$${formatNumber(mc / 1000, 1)}K`;
      return `$${formatNumber(mc, 0)}`;
    };
    
    const entryMcStr = formatMc(entryMcUsd);
    const currentMcStr = formatMc(currentMc);
    
    // Calculate PnL directly from MC values (since we're showing MC, not SOL)
    let livePnlHtml = '';
    if (entryMcUsd && entryMcUsd > 0 && currentMc && currentMc > 0) {
      const pnlPercent = ((currentMc - entryMcUsd) / entryMcUsd) * 100;

      const pnlClass = pnlPercent >= 0 ? 'positive' : 'negative';
      const pnlSign = pnlPercent >= 0 ? '+' : '';
      livePnlHtml = `<span class="mirror-live-pnl ${pnlClass}">${pnlSign}${formatNumber(pnlPercent, 1)}%</span>`;
    }
    
    // Cost basis display
    const costBasis = pos.costBasisSol || 0;
    const costStr = costBasis > 0
      ? `${formatNumber(costBasis, 4)} SOL`
      : '';
    
    // Truncated mint for display, full mint in tooltip
    const mintShort = pos.mint ? `${pos.mint.slice(0, 6)}...${pos.mint.slice(-4)}` : '';
    
    // Source wallet display
    const sourceDisplay = pos.walletAddress === 'pre-existing' || pos.walletAddress === 'manual-sync'
      ? 'paper trade'
      : `from ${pos.walletAddress.slice(0, 6)}...`;
    
    return `
      <div class="mirror-position-card" title="Mint: ${pos.mint || 'Unknown'}">
        <div class="mirror-position-info">
          <span class="mirror-position-symbol" title="${pos.mint || ''}">${escapeHtml(pos.symbol)}</span>
          <span class="mirror-position-mint" title="Click to copy mint">${mintShort}</span>
          <span class="mirror-position-source">${sourceDisplay}</span>
          <span class="mirror-position-time">${timeAgo}</span>
        </div>
        <div class="mirror-position-mc">
          <span class="mirror-mc-entry" title="Entry MC">Entry: ${entryMcStr}</span>
          <span class="mirror-mc-separator">→</span>
          <span class="mirror-mc-current" title="Current MC">Now: ${currentMcStr}</span>
          ${livePnlHtml}
        </div>
        ${costStr ? `<div class="mirror-position-cost">${costStr}</div>` : ''}
      </div>
    `;
  }).join('');
  
  // Add click handlers to copy mint address
  document.querySelectorAll('.mirror-position-mint').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = el.closest('.mirror-position-card');
      const mint = card?.getAttribute('title')?.replace('Mint: ', '');
      if (mint && mint !== 'Unknown') {
        try {
          await navigator.clipboard.writeText(mint);
          el.textContent = 'Copied!';
          setTimeout(() => {
            const short = `${mint.slice(0, 6)}...${mint.slice(-4)}`;
            el.textContent = short;
          }, 1000);
        } catch (err) {
          console.error('Failed to copy mint:', err);
        }
      }
    });
  });
}

function renderMirrorTrades(trades) {
  if (!mirrorTradesList) return;
  
  if (!trades.length) {
    mirrorTradesList.innerHTML = '<div class="empty-state-small">No trades yet</div>';
    return;
  }
  
  // Show most recent first
  const sortedTrades = [...trades].sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  
  // Helper to format MC values
  const formatMcValue = (mc) => {
    if (!mc || mc <= 0) return '?';
    if (mc >= 1000000) return `$${formatNumber(mc / 1000000, 2)}M`;
    if (mc >= 1000) return `$${formatNumber(mc / 1000, 1)}K`;
    return `$${formatNumber(mc, 0)}`;
  };
  
  mirrorTradesList.innerHTML = sortedTrades.slice(0, 15).map(trade => {
    const timeAgo = formatTimeAgo(new Date(trade.timestamp));
    const sourceDisplay = trade.sourceWalletName 
      ? `${trade.sourceWalletEmoji || ''} ${trade.sourceWalletName}`.trim()
      : trade.sourceWalletAddress.slice(0, 6) + '...';
    
    // MC display - Entry MC for buys, Entry→Exit for sells
    let mcHtml = '';
    if (trade.type === 'buy' && trade.entryMcUsd && trade.entryMcUsd > 0) {
      mcHtml = `<span class="mirror-trade-mc">MC: ${formatMcValue(trade.entryMcUsd)}</span>`;
    } else if (trade.type === 'sell') {
      const entryMcStr = formatMcValue(trade.entryMcUsd);
      const exitMcStr = formatMcValue(trade.exitMcUsd);
      mcHtml = `<span class="mirror-trade-mc">MC: ${entryMcStr} → ${exitMcStr}</span>`;
    }
    
    let resultHtml = '';
    if (trade.type === 'buy') {
      // BUY: Show SOL spent (negative from our balance)
      resultHtml = `<span class="mirror-trade-amount buy">-${trade.ourSolAmount.toFixed(4)} SOL</span>`;
    } else {
      // SELL: Show SOL received, P&L in SOL and %
      const pnlClass = (trade.pnl || 0) >= 0 ? 'positive' : 'negative';
      const pnlSign = (trade.pnl || 0) >= 0 ? '+' : '';
      const pnlPercentStr = trade.pnlPercent !== undefined && trade.pnlPercent !== null
        ? ` (${pnlSign}${formatNumber(trade.pnlPercent, 1)}%)`
        : '';
      resultHtml = `
        <span class="mirror-trade-amount sell">+${(trade.ourSolAmount || 0).toFixed(4)} SOL</span>
        <span class="mirror-trade-pnl ${pnlClass}">${pnlSign}${(trade.pnl || 0).toFixed(4)} PnL${pnlPercentStr}</span>
      `;
    }
    
    const statusIcon = trade.success ? '' : ' ⚠️';
    const mintShort = trade.tokenMint ? `${trade.tokenMint.slice(0, 6)}...${trade.tokenMint.slice(-4)}` : '';
    
    return `
      <div class="mirror-trade-card ${trade.type}" title="Mint: ${trade.tokenMint || 'Unknown'}">
        <div class="mirror-trade-info">
          <span class="mirror-trade-token" title="${trade.tokenMint || ''}">${trade.type.toUpperCase()} ${escapeHtml(trade.tokenSymbol)}${statusIcon}</span>
          <span class="mirror-trade-meta">${sourceDisplay} · ${timeAgo}</span>
          ${mcHtml}
        </div>
        <div class="mirror-trade-result">
          ${resultHtml}
        </div>
      </div>
    `;
  }).join('');
}

async function startMirror() {
  if (!startMirrorBtn) return;
  
  startMirrorBtn.disabled = true;
  startMirrorBtn.textContent = 'Starting…';
  
  try {
    const response = await postJson('/api/mirror/start', {
      exactMirroring: true,  // Copy exact SOL amounts from tracked wallets
      mirrorBuys: true,
      mirrorSells: true,
      onlyFirstBuys: false,
    });
    
    if (response.ok) {
      // Reload full status with trades
      await loadMirrorStatus();
    }
    startMirrorBtn.textContent = 'Start Mirror';
  } catch (error) {
    alert('Failed to start mirror: ' + (error instanceof Error ? error.message : 'Unknown error'));
    startMirrorBtn.disabled = false;
    startMirrorBtn.textContent = 'Start Mirror';
  }
}

async function stopMirror() {
  if (!stopMirrorBtn) return;
  
  stopMirrorBtn.disabled = true;
  stopMirrorBtn.textContent = 'Stopping…';
  
  try {
    const response = await postJson('/api/mirror/stop');
    
    if (response.ok) {
      // Reload full status with trades
      await loadMirrorStatus();
    }
    stopMirrorBtn.textContent = 'Stop';
  } catch (error) {
    alert('Failed to stop mirror: ' + (error instanceof Error ? error.message : 'Unknown error'));
    stopMirrorBtn.textContent = 'Stop';
  }
}

async function resetMirror() {
  if (!confirm('Reset all mirror stats and trades? This cannot be undone.')) {
    return;
  }
  
  try {
    const response = await postJson('/api/mirror/reset');
    
    if (response.ok) {
      // Reload full status with trades
      await loadMirrorStatus();
    }
  } catch (error) {
    alert('Failed to reset: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}

// Wire up mirror buttons
if (startMirrorBtn) {
  startMirrorBtn.addEventListener('click', startMirror);
}
if (stopMirrorBtn) {
  stopMirrorBtn.addEventListener('click', stopMirror);
}
if (resetMirrorBtn) {
  resetMirrorBtn.addEventListener('click', resetMirror);
}

// ============================================
// SOL PRICE FETCHING
// ============================================

async function fetchSolPrice() {
  try {
    // Use CoinGecko public API for SOL price
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (response.ok) {
      const data = await response.json();
      if (data.solana?.usd) {
        state.solPrice = data.solana.usd;
      }
    }
  } catch (error) {
    console.debug('Failed to fetch SOL price:', error);
    // Keep using default/previous value
  }
}

// ============================================
// TOKEN MC FETCHING (from pump.fun API)
// ============================================

// MC cache - stores fresh MCs from the server
// IMPORTANT: Always fetch fresh data, cache is only for display between refreshes
const MC_CACHE_TTL = 3000; // 3 seconds - short TTL to ensure fresh data

// Track entry MCs for P&L calculation (mint -> { entryMc, entryTime, walletAddress })
// We track per wallet to handle multiple wallets buying same token
const entryMcTracker = new Map(); // key: `${mint}_${walletAddress}` -> { entryMc, entryTime }

// Track if a fetch is in progress to avoid duplicate requests
let mcFetchInProgress = false;

async function fetchTokenMcs(mints, forceRefresh = false) {
  if (!mints || mints.length === 0) return;
  if (mcFetchInProgress) return; // Prevent duplicate fetches
  
  const now = Date.now();
  
  // Always fetch if forceRefresh, otherwise check cache
  const mintsToFetch = forceRefresh 
    ? mints 
    : mints.filter(mint => {
        const cached = state.tokenMcCache.get(mint);
        return !cached || (now - cached.timestamp > MC_CACHE_TTL);
      });
  
  if (mintsToFetch.length === 0) return;
  
  mcFetchInProgress = true;
  
  try {
    const response = await fetch('/api/tokens/mc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        mints: mintsToFetch.slice(0, 10), // Limit batch size
        fresh: true, // Always request fresh data
      }),
    });
    
    if (response.ok) {
      const data = await response.json();
      const tokens = data.tokens || {};
      const serverTimestamp = data.timestamp || now;
      
      // Update cache with fresh data
      let updatedCount = 0;
      for (const [mint, tokenData] of Object.entries(tokens)) {
        if (tokenData && tokenData.marketCapUsd > 0) {
          const oldMc = state.tokenMcCache.get(mint)?.marketCapUsd;
          state.tokenMcCache.set(mint, {
            ...tokenData,
            timestamp: serverTimestamp,
          });
          if (oldMc !== tokenData.marketCapUsd) {
            updatedCount++;
          }
        }
      }
      
      // Always re-render on force refresh
      if (updatedCount > 0 || forceRefresh) {
        renderTrackerTransactions();
      }
    } else {
      console.warn('MC fetch failed:', response.status);
    }
  } catch (error) {
    console.warn('Failed to fetch token MCs:', error);
  } finally {
    mcFetchInProgress = false;
  }
}

function getCachedMc(mint) {
  const cached = state.tokenMcCache.get(mint);
  if (cached && cached.marketCapUsd > 0) {
    return cached.marketCapUsd;
  }
  return null;
}

// Track entry MC when a buy is detected
function trackEntryMc(mint, walletAddress, mcUsd) {
  if (!mcUsd || mcUsd <= 0) return;
  const key = `${mint}_${walletAddress}`;
  if (!entryMcTracker.has(key)) {
    entryMcTracker.set(key, {
      entryMc: mcUsd,
      entryTime: Date.now(),
    });
  }
}

// Get entry MC for a position
function getEntryMc(mint, walletAddress) {
  const key = `${mint}_${walletAddress}`;
  const entry = entryMcTracker.get(key);
  return entry?.entryMc > 0 ? entry.entryMc : null;
}

// Calculate P&L percentage based on entry MC vs current MC
function calculateMcPnl(entryMc, currentMc) {
  if (!entryMc || !currentMc || entryMc <= 0 || currentMc <= 0) return null;
  return ((currentMc - entryMc) / entryMc) * 100;
}

// Refresh MCs for all visible tokens (called every 5 seconds)
async function refreshVisibleTokenMcs() {
  if (!state.trackerTransactions || state.trackerTransactions.length === 0) return;
  
  // Get unique mints from visible transactions
  const uniqueMints = [...new Set(
    state.trackerTransactions
      .map(tx => tx.tokenAddress)
      .filter(addr => addr && addr.length >= 32)
  )];
  
  if (uniqueMints.length === 0) return;
  
  await fetchTokenMcs(uniqueMints, true); // Force fresh fetch
  state.lastMcRefresh = Date.now();
  
  // Update the status indicator with timestamp
  const trackerStatus = document.getElementById('trackerStatus');
  if (trackerStatus) {
    const timeStr = new Date().toLocaleTimeString();
    trackerStatus.textContent = `MC: ${timeStr}`;
    trackerStatus.title = `Last MC refresh: ${timeStr}`;
  }
}

// ============================================
// AUTH MANAGEMENT FUNCTIONS
// ============================================

const authIndicator = document.getElementById('authIndicator');
const authStatusText = document.getElementById('authStatusText');
const authUpdateForm = document.getElementById('authUpdateForm');
const refreshTokenInput = document.getElementById('refreshTokenInput');
const accessTokenInput = document.getElementById('accessTokenInput');
const updateAuthBtn = document.getElementById('updateAuthBtn');

async function loadAuthStatus() {
  try {
    const response = await fetch('/api/tracker/status');
    const data = await response.json();
    
    if (authIndicator && authStatusText) {
      if (data.authenticated) {
        authIndicator.className = 'auth-indicator authenticated';
        
        // Show auto-refresh status
        let statusText = 'Authenticated ✓';
        if (data.autoRefresh && data.nextRefreshAt) {
          const nextRefresh = new Date(data.nextRefreshAt);
          const now = new Date();
          const minsUntilRefresh = Math.round((nextRefresh - now) / 1000 / 60);
          if (minsUntilRefresh > 0) {
            statusText += ` (auto-refresh in ${minsUntilRefresh}m)`;
          } else {
            statusText += ' (refreshing...)';
          }
        } else if (data.autoRefresh) {
          statusText += ' (auto-refresh active)';
        }
        authStatusText.textContent = statusText;
      } else {
        authIndicator.className = 'auth-indicator not-authenticated';
        authStatusText.textContent = 'Not authenticated';
      }
    }
  } catch (error) {
    if (authIndicator && authStatusText) {
      authIndicator.className = 'auth-indicator error';
      authStatusText.textContent = 'Error checking status';
    }
  }
}

async function updateAuthTokens(event) {
  event.preventDefault();
  
  const refreshToken = refreshTokenInput?.value?.trim();
  const accessToken = accessTokenInput?.value?.trim();
  
  if (!refreshToken) {
    alert('Refresh token is required');
    return;
  }
  
  if (updateAuthBtn) {
    updateAuthBtn.disabled = true;
    updateAuthBtn.textContent = 'Updating...';
  }
  
  try {
    const response = await fetch('/api/tracker/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken,
        accessToken: accessToken || null,
      }),
    });
    
    const data = await response.json();
    
    if (response.ok && data.ok) {
      alert('Tokens updated successfully!');
      // Clear the form
      if (refreshTokenInput) refreshTokenInput.value = '';
      if (accessTokenInput) accessTokenInput.value = '';
      // Refresh auth status
      await loadAuthStatus();
      // Reload tracker data with new auth
      await loadTrackerWallets();
      await loadTrackerTransactions();
    } else {
      alert('Failed to update tokens: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Failed to update tokens: ' + (error instanceof Error ? error.message : 'Network error'));
  } finally {
    if (updateAuthBtn) {
      updateAuthBtn.disabled = false;
      updateAuthBtn.textContent = 'Update Tokens';
    }
  }
}

// Wire up auth form
if (authUpdateForm) {
  authUpdateForm.addEventListener('submit', updateAuthTokens);
}

async function bootstrap() {
  // Fetch SOL price first for accurate MC calculations
  await fetchSolPrice();
  
  await loadPositions();
  await loadStats();
  await loadControl();
  await loadAuthStatus();
  await loadTrackerWallets();
  await loadTrackerTransactions();
  await loadMirrorStatus();
  wireControlActions();
  state.refreshInterval = setInterval(() => {
    loadPositions();
    loadStats();
    loadControl();
  }, 1000);
  
  // Refresh tracker and mirror status (every 2 seconds for fast updates)
  setInterval(() => {
    loadTrackerTransactions();
    loadMirrorStatus();
  }, 2000);
  
  // Refresh MCs for all visible tokens every 5 seconds (for live P&L updates)
  setInterval(refreshVisibleTokenMcs, 5000);
  
  // Check auth status every 30 seconds
  setInterval(loadAuthStatus, 30000);
  
  // Refresh SOL price every 60 seconds
  setInterval(fetchSolPrice, 60000);
}

bootstrap();
