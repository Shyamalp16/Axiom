# AXIOM - Disciplined Solana Memecoin Trading Bot

A battle-tested trading bot for Solana memecoins with **hard-coded discipline rules**. Built to help you survive the memecoin trenches by enforcing strict safety checks and risk management.

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
   - ✅ LP on Raydium or Orca
   - ✅ LP ≥ 30 SOL (floor: 25 SOL)

2. **Wallet Distribution**
   - Largest wallet (excl. LP) ≤ 15%
   - Top 5 wallets combined ≤ 40%
   - Dev wallet < 10% and not increasing

3. **Age & Context**
   - Token age: 3-20 minutes (sweet spot)
   - Already pumped 2x-5x from launch
   - Volume still active (not dead)
   - Rejects: Fresh < 2min (bot war), Old > 30min (dead)

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

### Interactive Mode
```bash
npm run bot
```

### Check a Token (No Trade)
```bash
npm run check <mint_address>

# Example:
npm run check EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### View Status & Stats
```bash
npm run status
```

### Development Mode (Hot Reload)
```bash
npm run dev
```

## Project Structure

```
src/
├── config/
│   ├── constants.ts     # All hard-coded rules (DO NOT MODIFY)
│   └── index.ts         # Config exports
├── types/
│   └── index.ts         # TypeScript types
├── utils/
│   ├── logger.ts        # Colored logging
│   └── solana.ts        # Solana utilities
├── api/
│   └── data-providers.ts # Birdeye/Helius APIs
├── checkers/
│   ├── token-safety.ts   # Mint/freeze/LP checks
│   ├── wallet-distribution.ts
│   ├── age-context.ts
│   ├── volume-momentum.ts
│   └── pre-trade-checklist.ts
├── trading/
│   ├── entry-logic.ts    # Entry conditions
│   ├── position-manager.ts
│   ├── tp-sl-manager.ts  # Automated TP/SL
│   └── executor.ts       # Jupiter swaps
├── monitoring/
│   └── dev-wallet-monitor.ts
├── storage/
│   └── trade-logger.ts   # Trade history
├── bot/
│   └── orchestrator.ts   # Main controller
├── cli/
│   ├── check-token.ts
│   └── status.ts
└── index.ts              # Entry point
```

## Hard-Coded Rules (constants.ts)

These values are **battle-tested**. Do not modify unless you have a very good reason:

| Rule | Value |
|------|-------|
| Min LP | 25 SOL (floor), 30 SOL (ideal) |
| Max Single Wallet | 15% |
| Max Top 5 Wallets | 40% |
| Token Age | 3-20 minutes |
| Pump Range | 2x-5x |
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
