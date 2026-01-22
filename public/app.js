const state = {
  positions: [],
  selectedId: null,
  refreshInterval: null,
  filterSource: 'all',
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

function formatPrice(value, unit, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
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

  visiblePositions.forEach(position => {
    const card = document.createElement('div');
    card.className = `position-card ${state.selectedId === position.id ? 'active' : ''}`;
    const pnlClass = position.unrealizedPnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative';
    const priceUnitLabel = position.priceUnit === 'sol' ? 'SOL' : 'USD';

    card.innerHTML = `
      <h3>${position.symbol}</h3>
      <div class="source-badge">${position.source}</div>
      <div class="card-row">
        <span>Status</span>
        <span>${position.status}</span>
      </div>
      <div class="card-row">
        <span>Entry (${priceUnitLabel})</span>
        <span>${formatPrice(position.entryPrice, position.priceUnit, 6)}</span>
      </div>
      <div class="card-row">
        <span>Current (${priceUnitLabel})</span>
        <span>${formatPrice(position.currentPrice, position.priceUnit, 6)}</span>
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

    positionDetail.innerHTML = `
      <div class="detail-header">
        <div class="detail-title">${position.symbol} · ${position.mint.slice(0, 6)}…</div>
        <div class="${pnlClass}">${formatPercent(position.unrealizedPnlPercent)}</div>
      </div>
      <div class="detail-grid">
        <div class="metric-card">
          <div class="metric-label">PnL</div>
          <div class="metric-value ${pnlClass}">${formatNumber(position.unrealizedPnl, 4)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Market Cap</div>
          <div class="metric-value">${formatCurrency(market.marketCap, 0)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Token Price (SOL)</div>
          <div class="metric-value">${formatNumber(market.priceSol, 6)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Token Price (USD)</div>
          <div class="metric-value">${formatCurrency(market.priceUsd, 6)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">SOL Price (USD)</div>
          <div class="metric-value">${formatCurrency(solPrice, 2)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Highest Price (${priceUnitLabel})</div>
          <div class="metric-value">${formatPrice(position.highestPrice, position.priceUnit, 6)}</div>
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
}

async function bootstrap() {
  await loadPositions();
  await loadStats();
  await loadControl();
  wireControlActions();
  state.refreshInterval = setInterval(() => {
    loadPositions();
    loadStats();
    loadControl();
  }, 1000);
}

bootstrap();
