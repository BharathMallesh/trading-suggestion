# Paper-Bot (Experimental)

**Hybrid signal generator + paper-trading simulator** for research and education only.

This folder is deliberately separated from the main research tools so experiments
do not weaken the pure research guardrails.

## ⚠️ Critical disclaimers

- This is **experimental research code**.
- It does **not** place real orders or connect to any broker.
- Signals have **no proven edge**. Most such systems lose money after costs.
- Past simulated results do **not** predict future performance.
- Nothing here is investment advice.
- Short-selling is simulated only. Real NSE shorting has additional restrictions.

## What it does

1. Fetches candles (daily or intraday) for liquid NSE stocks.
2. Computes technical indicators (SMA-20/50, RSI-14, ATR-14, volume ratio).
3. Applies tightened technical filters (SMA separation, volume, RSI bands).
4. Optionally asks **Ling 3.0 Flash Fin** for a structured signal
   (`LONG` / `SHORT` / `FLAT` + confidence + reasoning).
5. Simulates paper trades (long **and** short) with ATR sizing, stop-loss and take-profit.
6. Supports one-shot scans and sequential backtests with equity curves.

## Setup

```bash
export OPENROUTER_API_KEY="sk-or-..."   # only needed for hybrid mode
```

No extra packages.

## CLI usage

From the `trading-research` folder:

```bash
# Tech-only daily scan (no API key)
node paper-bot/run.mjs --tech-only
npm run paper:tech

# Hybrid daily scan (needs key)
node paper-bot/run.mjs
npm run paper

# Specific symbols
node paper-bot/run.mjs RELIANCE.NS TCS.NS --tech-only

# Intraday
node paper-bot/run.mjs --tech-only --interval 15m
node paper-bot/run.mjs --tech-only --interval 5m
node paper-bot/run.mjs --tech-only --interval 1h
npm run paper:15m

# Sequential backtest
node paper-bot/run.mjs --backtest --tech-only
npm run paper:backtest:tech

# Hybrid backtest (slower, needs key)
node paper-bot/run.mjs --backtest
```

Backtest results are also written to `paper-bot/last-backtest.json`.

## Web UI

Start the dashboard:

```bash
export OPENROUTER_API_KEY="sk-or-..."
node server.mjs
# open http://localhost:3000 → scroll to Paper-Bot
```

UI buttons:

| Button | Action |
|--------|--------|
| **Run scan** | Live signals + paper snapshot |
| **Run backtest** | Historical simulation + equity curve + recent trades |
| **Run agents** | Research agent + signal agent + experimental paper suggestions |

## Features

| Feature | Description |
|---------|-------------|
| **Long + Short** | Full support for both directions |
| **Stop-loss / Take-profit** | ATR-based (default 1.5× stop, 2.5× target) |
| **`--tech-only` mode** | Pure technical signals — no API key |
| **Intraday** | `--interval 15m` / `5m` / `1h` |
| **Realistic fills** | Backtest fills at next bar’s **open** |
| **Exit tracking** | stop-loss / take-profit / signal / end-of-test |
| **Tightened filters** | min confidence 0.65, SMA separation, volume filter |
| **Results export** | `last-backtest.json` |

## Default symbols (10 liquid NSE names)

RELIANCE, HDFCBANK, TCS, INFY, ICICIBANK, SBIN, BHARTIARTL, ITC, LT, AXISBANK

## Configuration

Edit `config.mjs`:

- Starting capital (default ₹10,000)
- Risk per trade / max position size / max open positions
- Stop & target ATR multiples
- `allowShort` flag
- Symbol list
- `minConfidence` (default 0.65)
- Intraday presets

## Files

| File | Role |
|------|------|
| `config.mjs` | Capital, risk, symbols, intervals, thresholds |
| `indicators.mjs` | SMA, RSI, ATR |
| `signal.mjs` | Hybrid + tech-only signal logic |
| `paper-engine.mjs` | Positions (long/short), stops/targets, equity, stats |
| `run.mjs` | CLI entry point |
| `last-backtest.json` | Latest backtest output (generated) |

## Related: multi-agent layer

See `../agents/`:

- `research-agent.mjs` — factual market research
- `signal-agent.mjs` — wraps this paper-bot signal logic
- `coordinator.mjs` — combines both into an experimental brief

API: `POST /api/agents` (via `server.mjs`).

## Notes on intraday

Yahoo only serves fine intervals for a short recent window.
15m / 5m data is typically limited to the last few days.
For longer history use daily (`1d`).

Again: learning and research tool only — not a money-making system.
