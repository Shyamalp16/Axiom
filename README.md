# AXIOM - Disciplined Solana Memecoin Trading Bot

A battle-tested trading bot for Solana memecoins with **hard-coded discipline rules**. Built to help you survive the memecoin trenches by enforcing strict safety checks and risk management.

**Supports both:**
- 🟢 **Pump.fun** - Bonding curve tokens (pre-graduation)
- 🔵 **DEX** - Raydium, BAGS, Meteora AMM, Meteora AMM V2, Pump AMM (post-graduation)

## Philosophy

> **You are not hunting 50x. You are farming clean 20-40% rotations.**
> **One avoided rug = 5 winning trades.**

This bot enforces discipline through code. No overrides. No "it looks good anyway." No FOMO.

## Features

### Pre-Trade Safety Checklist (FAIL ONE = NO TRADE)

1. **Token Safety**
   - ❌ Mint authority must be DISABLED
   - ❌ Freeze authority must be DISABLED
   - ❌ Transfer tax must be 0%
   - ❌ No blacklist/whitelist logic
   - ✅ LP on supported DEX (Raydium, BAGS, Meteora, Meteora V2, Pump AMM)
   - ✅ LP ≥ 30 SOL (floor: 25 SOL)

2. **Wallet Distribution**
   - Largest wallet (excl. LP) ≤ 15%
   - Top 5 wallets combined ≤ 40%
   - Dev wallet < 10% and not increasing

3. **Age & Context**
   - Token age: configurable via DISCOVERY_CONFIG
   - Already pumped 2x-5x from launch
   - Volume still active (not dead)

4. **Volume & Momentum**
   - Pullback volume ≥ 40% of pump volume
   - At least 1 consolidation after first pump
   - No vertical wick dumps
   - No straight candle patterns (bot exit liquidity)

### Entry Logic (First Pullback Continuation)

- Price retraced 30-50% from local high
- Last 2-3 red candles shrinking
- Buy volume > sell volume on current candle
- Price holds above first consolidation or VWAP
- **Split entry**: 60% on confirmation, 40% if holds

### Position Management

- Max per trade: 0.25 SOL
- Ideal per trade: 0.15-0.20 SOL
- Max open trades: 1 (no overleveraging)

### Automated TP/SL

**Stop Loss:**
- Hard stop: -6%
- Time stop: No higher high in 3-4 minutes = exit

**Take Profit Ladder:**
- TP1: Sell 40% at +20%
- TP2: Sell 30% at +35%
- Runner: 30% with -10% trailing stop from high

### Risk Management

**Daily Guardrails:**
- Max 2 trades per day
- Max -0.2 SOL daily loss → bot disables

**Weekly Guardrails:**
- Max -0.5 SOL weekly loss → mandatory review

### Dev Wallet Monitoring

Instant exit triggers:
- Dev sells > 25% of holdings
- Any wallet dumps > 10% supply in < 60s
- LP removal attempt detected

### Pump.fun Specific Rules

When trading on Pump.fun bonding curve (all configurable in `src/discovery/token-discovery.ts`):
- Bonding curve progress: configurable (default 15-99%)
- Market cap: configurable (default $3k-$60k)
- Age: configurable (default 1-60 min)
- Minimum engagement: configurable trade count
- Auto-routes: Pump.fun vs Jupiter based on graduation status

### Token Discovery

Multi-strategy discovery engine:
- **LIVE** - tokens being actively traded now
- **VOLATILE** - tokens with price movement
- **NEWEST** - recently created tokens
- **Watch & Revisit** - tracks new tokens, checks for momentum after delay

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd axiom-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
```

## Configuration

Create a `.env` file with:

```env
# Solana RPC (use a paid RPC for speed)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com

# Your wallet private key (base58 encoded)
WALLET_PRIVATE_KEY=your_private_key_here

# API Keys (at least one required)
HELIUS_API_KEY=your_helius_api_key
BIRDEYE_API_KEY=your_birdeye_api_key
```

### Getting API Keys

- **Helius**: https://helius.xyz (free tier available)
- **Birdeye**: https://birdeye.so/developers (free tier available)

## Usage

### Commands

```bash
# Interactive bot mode
npm run bot

# Check a specific token (no trade)
npm run check <mint_address>

# View status & stats
npm run status

# Test setup/connection
npm run test:setup

# Test token discovery (polls for candidates, runs safety checks)
npm run test:discovery

# Test Price Monitoring
npm run test:price

# Paper trading (simulated trades)
npm run paper              # Start paper trading
npm run paper:check        # Check paper positions
npm run paper:stats        # View paper trading stats
npm run paper:reset        # Reset paper trading data
npm run paper:export       # Export paper trade history

# Development mode (hot reload)
npm run dev

# Build for production
npm run build
npm run start
```

## Project Structure

```
src/
├── api/
│   ├── data-providers.ts  # Birdeye/Helius/DexScreener APIs
│   ├── pump-fun.ts        # Pump.fun token operations
│   ├── pump-portal.ts     # PumpPortal WebSocket + REST API
│   └── metis-swap.ts      # Swap execution
├── bot/
│   ├── orchestrator.ts    # Main controller
│   └── auto-orchestrator.ts # Automated trading
├── checkers/
│   ├── pre-trade-checklist.ts # Main safety checklist
│   ├── pump-fun-safety.ts # Pump.fun specific checks
│   ├── token-safety.ts    # Mint/freeze/LP checks
│   ├── wallet-distribution.ts
│   ├── age-context.ts
│   └── volume-momentum.ts
├── cli/
│   ├── auto-trade.ts      # Auto trading CLI
│   ├── check-token.ts     # Token checker
│   ├── paper-trade.ts     # Paper trading
│   ├── test-discovery.ts  # Discovery testing
│   ├── test-setup.ts      # Setup testing
│   └── status.ts          # Status display
├── config/
│   ├── constants.ts       # Trading rules
│   └── index.ts
├── discovery/
│   ├── token-discovery.ts # Multi-strategy discovery + config
│   └── candidate-queue.ts # Priority queue
├── monitoring/
│   ├── dev-wallet-monitor.ts
│   └── price-monitor.ts
├── pipeline/
│   └── trade-pipeline.ts  # Trade execution pipeline
├── trading/
│   ├── entry-logic.ts
│   ├── executor.ts
│   ├── paper-trader.ts
│   ├── position-manager.ts
│   └── tp-sl-manager.ts
└── index.ts
```

## Configuration

### Discovery Config (`src/discovery/token-discovery.ts`)

Single source of truth for token filtering:

| Setting | Default | Description |
|---------|---------|-------------|
| minAgeMinutes | 1 | Minimum token age |
| maxAgeMinutes | 60 | Maximum token age |
| minProgress | 15 | Min bonding curve % |
| maxProgress | 99 | Max bonding curve % |
| minMarketCap | $3,000 | Min market cap |
| maxMarketCap | $60,000 | Max market cap |
| minTradeCount | 1 | Min trades/engagement |

### Trading Rules (`src/config/constants.ts`)

| Rule | Value |
|------|-------|
| Min LP | 25 SOL (floor), 30 SOL (ideal) |
| Max Single Wallet | 15% |
| Max Top 5 Wallets | 40% |
| Stop Loss | -6% |
| Time Stop | 4 minutes |
| TP1 | +20% (sell 40%) |
| TP2 | +35% (sell 30%) |
| Runner Trail | -10% from high |
| Max Daily Trades | 2 |
| Max Daily Loss | 0.2 SOL |
| Max Weekly Loss | 0.5 SOL |

## Trade Logging

Every trade is logged to `data/trades.json` with:
- Entry reason (checklist items passed)
- Actual vs expected slippage
- Time in trade
- Exit reason

After 20-30 trades, patterns will emerge. Use `npm run status` to analyze.

## Fees

Optimized for current Solana conditions:

| Fee Type | Amount |
|----------|--------|
| Priority Fee | 0.0007 SOL |
| Jito Bribe | 0.0015 SOL (max 0.0025) |
| Max Round Trip | 0.004 SOL |
| Buy Slippage | 10% |
| Sell Slippage | 12% |
| Emergency Slippage | 18% |

## Safety Notes

⚠️ **NEVER share your private key**

⚠️ **Start with small amounts** (0.15-0.20 SOL per trade)

⚠️ **This bot is for education** - trading memecoins is extremely risky

⚠️ **Past performance doesn't guarantee future results**

## License

MIT

---

*Built for survival in the memecoin trenches. Stay disciplined.* 🎯
