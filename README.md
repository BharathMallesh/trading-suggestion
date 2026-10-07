# Trading research module

An **isolated, self-contained** module for finance **research and analysis**,
kept separate from the main app so the two can evolve independently — nothing
here imports from the app build, and changing the app never requires changing
this folder (or vice-versa). It reuses the same OpenRouter / **Ling 3.0 Flash
Fin** connection the app uses.

## Scope — read this first

### Core research tools (guardrailed)

These deliberately do **not**:

- ❌ predict prices or market direction ("will X go up or down")
- ❌ give buy / sell / hold recommendations, entry/exit points, or price targets
- ❌ give personalized investment advice
- ❌ connect to a brokerage, place orders, or move money

They **do**:

- ✅ explain instruments, metrics, and how to read them
- ✅ summarize and structure factual context you provide or ask about
- ✅ lay out drivers and risks so **you** can form your own view

### Experimental paper-bot & agents

Under `paper-bot/` and `agents/` there is an **experimental** layer for
paper-trading research (signals, backtests, multi-agent briefs). That layer:

- Is **paper simulation only** — no real orders, no broker connection
- Produces experimental LONG / SHORT / FLAT signals with **no proven edge**
- Always carries disclaimers that output is **not investment advice**
- Exists for learning and testing ideas, not for live trading decisions

Why the limits: no model — finance-tuned or not — can reliably forecast prices,
and executing trades / giving personalized advice is a licensed, high-risk
activity. Decision-support, never decision-making.

## Setup

Uses Node's built-in `fetch` (Node 18+), no dependencies to install.

```bash
export OPENROUTER_API_KEY="sk-or-..."     # your own OpenRouter key
```

Optional: `export LING_MODEL="inclusionai/ling-3.0-flash"` to use a different
OpenRouter model.

## Use

### Ask a research question

```bash
node research.mjs "Explain HDFC Bank's net interest margin and what moves it"
```

Or as a library:

```js
import { research, summarize, explain } from './research.mjs';

const a = await research('What is a candlestick chart and how is it read?');
const s = await summarize(pastedFilingText, { focus: 'the revenue segments' });
const e = await explain('a bullish engulfing candle');
```

### Fetch real market data (read-only, no API key)

```bash
node market-data.mjs AAPL                        # latest quote
node market-data.mjs HDFCBANK.NS --candles 3mo 1d # OHLC candles
node market-data.mjs HDFCBANK.NS --intraday 2026-09-29 1m
```

```js
import { quote, candles } from './market-data.mjs';
const q = await quote('AAPL');
const c = await candles('HDFCBANK.NS', { range: '6mo', interval: '1d' });
```

### Describe candles (facts, not forecasts)

```bash
node describe-candles.mjs HDFCBANK.NS 3mo
node describe-candles.mjs HDFCBANK.NS 6mo --narrate
```

### Option greeks & payoff calculator (educational, offline)

```bash
node blackscholes.mjs --spot 2500 --strike 2520 --days 7 --iv 18 --type CE
```

---

## Paper-Bot (experimental)

Folder: `paper-bot/`

Hybrid technical + optional Ling signals, long/short paper simulation,
ATR stops/targets, backtests.

```bash
# Tech-only scan (no API key)
node paper-bot/run.mjs --tech-only
npm run paper:tech

# Hybrid scan (needs key)
node paper-bot/run.mjs

# Backtest
node paper-bot/run.mjs --backtest --tech-only
npm run paper:backtest:tech

# Intraday
node paper-bot/run.mjs --tech-only --interval 15m
npm run paper:15m
```

Defaults: ₹10,000 paper capital, 10 liquid NSE symbols, daily candles,
max 3 open positions, ATR stop 1.5× / target 2.5×.

See `paper-bot/README.md` for full details.

---

## Multi-agent layer (experimental)

Folder: `agents/`

| Agent | Role |
|-------|------|
| **Research agent** | Factual overview, quote, candle stats (no predictions) |
| **Signal agent** | LONG / SHORT / FLAT paper signals (tech or hybrid) |
| **Coordinator** | Runs both → experimental paper brief |

```bash
# Via API (with server running)
curl -X POST http://127.0.0.1:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["RELIANCE.NS","TCS.NS"],"techOnly":true}'
```

Or from the web UI: **Run agents** button in the Paper-Bot panel.

---

## Web dashboard

Local, zero-dependency UI:

- **Ask** — research / explain / summarize (needs key)
- **Market data** — quotes, candles, intraday chart  
  - **Call / Put %** button — Yahoo candles → Ling scenario weights  
    (CALL = % up, PUT = % down, SIDEWAYS = % chop)
- **Option calculator** — offline Black-Scholes
- **Paper-Bot** — scan, backtest (equity curve + trades), multi-agent brief
- **Candle AI read** — daily/range candle directional lean from Ling
- **Live candles → Ling probability** — same Call/Put/Sideways panel (Yahoo default; Groww optional)

```bash
export OPENROUTER_API_KEY="sk-or-..."   # needed for Ask, Call/Put %, Hybrid
node server.mjs                         # open http://localhost:3000
```

Key stays **server-side**. Server binds to `127.0.0.1` only.

### Call / Put % (experimental)

In **Market data**, after entering a symbol (e.g. `RELIANCE.NS`):

1. Click **Fetch** (optional — chart)
2. Click **Call / Put %**

You get three percentages that sum to ~100%:

| Label | Meaning |
|-------|---------|
| **CALL (up)** | Model weight that price leans up near term |
| **PUT (down)** | Model weight that price leans down near term |
| **SIDEWAYS** | Model weight for chop / no clear direction |

Based on recent OHLC + indicators (SMA, RSI, ATR, volume) sent to Ling.  
**Not investment advice** and **not** real options pricing — research/paper only.

API:

```bash
curl -X POST http://127.0.0.1:3000/api/groww-predict \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"RELIANCE.NS","intervalMinutes":15,"preferYahoo":true}'
```

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ask` | POST | Research / explain / summarize |
| `/api/quote` | GET | Latest quote |
| `/api/candles` | GET | OHLC history |
| `/api/intraday` | GET | One-day intraday |
| `/api/describe` | GET | Factual candle description |
| `/api/option` | GET | Greeks + payoff |
| `/api/paper-scan` | POST | Paper-bot signal scan |
| `/api/paper-backtest` | POST | Paper backtest + equity curve |
| `/api/agents` | POST | Multi-agent brief |
| `/api/agents/research` | POST | Research agent only |
| `/api/agents/signal` | POST | Signal agent only |
| `/api/candle-predict` | POST | Candle AI directional read |
| `/api/groww-predict` | POST | Call/Put/Sideways probabilities (Yahoo or Groww) |

---

## npm scripts

```bash
npm run research
npm run market
npm run options
npm run describe
npm run groww
npm run serve
npm run paper
npm run paper:tech
npm run paper:backtest
npm run paper:backtest:tech
npm run paper:15m
npm test
```

## Tests

```bash
npm test        # or: node --test
```

## Files

**Core research**
- `config.mjs` — OpenRouter base URL + model
- `ling-client.mjs` — minimal chat client
- `research.mjs` — guardrailed research / summarize / explain
- `market-data.mjs` — read-only Yahoo quotes + candles
- `groww-data.mjs` — optional Groww candles (token from env)
- `describe-candles.mjs` — factual candle stats + optional narration
- `blackscholes.mjs` — offline option maths
- `server.mjs` + `index.html` — local dashboard
- `test.mjs` — unit tests

**Experimental paper-bot**
- `paper-bot/config.mjs` — capital, risk, symbols, intervals
- `paper-bot/indicators.mjs` — SMA, RSI, ATR
- `paper-bot/signal.mjs` — hybrid + tech-only signals
- `paper-bot/paper-engine.mjs` — long/short, stops, equity, stats
- `paper-bot/run.mjs` — CLI
- `paper-bot/candle-predict.mjs` — candle AI directional read (Ling)
- `paper-bot/groww-predict.mjs` — Call/Put/Sideways probabilities (Yahoo or Groww → Ling)
- `paper-bot/README.md` — paper-bot docs

**Experimental agents**
- `agents/research-agent.mjs` — factual research agent
- `agents/signal-agent.mjs` — paper signal agent
- `agents/coordinator.mjs` — multi-agent orchestrator

---

Again: research tools are information-only. Paper-bot, agents, and Call/Put %
are **experimental** for learning — not a trading system and not advice.
