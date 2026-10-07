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

Key stays **server-side**. Server binds to `127.0.0.1` only, accepts only a
`localhost` / `127.0.0.1` Host header, and rejects cross-site requests (other
browser tabs can't spend your OpenRouter credits). Script calls are fine — POSTs
just need `Content-Type: application/json`.

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

Based on recent OHLC + indicators (SMA, RSI, ATR, volume). A technical base
mix is computed first (neutral score → 25/25/50); Ling may then move each leg by
at most 15 points, and the **Bias** is always the largest of the three final
numbers. Bare tickers are tried as NSE first (`HDFCBANK` → `HDFCBANK.NS`), then
as-is (`AAPL`); indices/crypto (`^NSEI`, `BTC-USD`) work too.  
**Not investment advice** and **not** real options pricing — research/paper only.

Every run is logged to `paper-bot/prediction-history.json`. **Evaluate** scores a
prediction only once its horizon has passed: ~4 bars for single-timeframe runs
(15m → 1 hour), the next completed session for multi-horizon runs.

API:

```bash
curl -X POST http://127.0.0.1:3000/api/groww-predict \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"RELIANCE.NS","intervalMinutes":15,"preferYahoo":true}'
```

### Model evaluation & calibration

How good are the Call / Put / Sideways numbers? The replay harness answers that
without waiting for live predictions: it walks past bars, makes the model's
prediction at each one, and scores it against what happened next — next session
for daily bars, next 4 bars intraday (same rule as live hit-rate scoring).

```bash
npm run eval -- --interval 1d        # report: daily, 10 default symbols
node paper-bot/evaluate.mjs --interval 15m TCS.NS INFY.NS
npm run calibrate                    # fit + save all intervals (1d, 60m, 15m, 5m)
```

It compares five models on a chronological split (fit on the first 60%, score
on the last 40%): uniform 33/33/33, historical base rates, "last move repeats",
the hand-written formula, and probabilities **calibrated** to past data (score
bucket → observed frequencies, shrunk toward base rates). Metrics: Brier score,
log loss, accuracy, skill vs base rates, and a reliability chart.

Fitted tables live in `paper-bot/calibration.json`; live Call / Put uses them
per interval **only if** they beat the formula on held-out bars. The dashboard's
**Model evaluation** section runs the same replay and shows the charts.

First results (Oct 2026, 10 NSE large caps): the uncalibrated formula scored
−11% to −17% vs base rates (overconfident); calibrated probabilities score about
0% — i.e. the technical score has little predictive information at these
horizons, and calibration makes the numbers honest rather than predictive.
Refit regularly (`npm run calibrate`) — behaviour drifts.

#### Context model (market, VIX, regime, session)

For NSE/BSE symbols the harness also fits a small logistic regression on 18
features, all known at the bar's close: the technical score; stock regime (RSI,
5/20-bar returns, ATR %, ATR rank vs last 100 bars, trend strength, volume);
market (NIFTY 50 returns and score, relative strength vs NIFTY); India VIX
(level z-score, 5-bar change); and session/calendar (opening gap, first / last
half hour, Indian results season — a calendar proxy, since free earnings dates
aren't available). An **ablation** adds one group at a time so you can see what
helps, and a **direction skill** column checks whether a model knows *which
way* (on bars that moved) rather than just *whether* it moves.

Live use needs ≥ 0.2 points of skill over calibration **and** a win in both
halves of the held-out period. In "move" mode the context model supplies only
the chance of a real move; up vs down still comes from calibration.

Findings (Oct 2026, 18 NIFTY 50 stocks): context predicts **volatility, not
direction**. 5-min: +3.9% skill (stable; replicated on a separate set of
stocks), driven by stock regime and time of day. Daily +0.3%, 15-min +0.4%
(marginal), 60-min none. Direction skill is ≤ 0 everywhere — none of these
inputs tell which way the price will go.

### Realistic paper trading (India)

- **Costs** (`paper-bot/costs.mjs`): STT (delivery 0.1% both sides; intraday
  0.025% sell), NSE transaction 0.00297%, SEBI ₹10/crore, stamp duty (0.015% /
  0.003% buy), 18% GST on brokerage + exchange + SEBI, DP charge per delivery
  sell, discount-broker brokerage, and 0.05% slippage in every fill. Override
  brokerage / DP / slippage in **Settings**.
- **Daily = delivery, long-only**: retail can't hold cash-segment shorts
  overnight. **Intraday = shorts allowed, squared off at the session end.**
- Backtests use longer history (daily 2 years) and report **buy-and-hold of
  the same stocks** and **NIFTY 50** over the same period, plus charges paid.

### Paper portfolio, news, settings

- **Paper portfolio**: a persistent simulated delivery account
  (`paper-bot/portfolio.json`). *Apply today's signals* buys on daily LONG
  signals and exits on FLAT after the minimum hold; stops/targets are checked
  against daily bars since entry.
- **News**: recent headlines (Google News RSS India edition for NSE/BSE;
  Yahoo for others) and, with the key, a factual Ling brief with a sentiment
  score. Sentiment is shown and logged, **not** used in the numbers — the
  hit-rate panel measures whether it (and Ling's probability adjustment)
  actually helps.
- **Auto-evaluation**: the server scores due predictions every 15 minutes
  (`AUTO_EVALUATE=0` to disable).
- **Settings**: capital, risk, limits, confidence threshold, symbols and cost
  overrides, saved to `paper-bot/settings.json`.

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
| `/api/prediction-stats` | GET | Hit-rate calibration stats |
| `/api/prediction-evaluate` | POST | Score predictions whose horizon has passed |
| `/api/prediction-history` | GET | Logged predictions (`?limit=1..500`) |
| `/api/model-eval` | POST | Replay + score models `{interval, symbols?, save?}` |
| `/api/calibration` | GET | Saved calibration tables + their validation scores |
| `/api/news` | GET | Headlines + factual brief `?symbol=` |
| `/api/portfolio` | GET | Refresh + summary of the paper portfolio |
| `/api/portfolio/rebalance` | POST | Apply today's daily signals |
| `/api/portfolio/close` | POST | Close one paper position `{symbol}` |
| `/api/portfolio/reset` | POST | Fresh paper account `{capital?}` |
| `/api/settings` | GET/POST | Read / save settings `{settings}` or `{reset:true}` |

Bad input returns **400** with a readable message, unknown symbols **404**,
a missing API key **503**.

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
npm run eval            # replay & score the probability model
npm run calibrate       # fit + save calibration for all intervals
npm test
```

## Tests

```bash
npm test        # or: node --test
```

`test.mjs` covers the core modules; `regression.test.mjs` pins the fixes from
the 2026-10-07 QA pass (probability maths, hit-rate scoring, fees/gap fills,
date-aligned backtests, input validation, and the server's request guard).
Everything is offline — fetch is mocked.

## Files

**Core research**
- `config.mjs` — OpenRouter base URL + model
- `ling-client.mjs` — minimal chat client
- `research.mjs` — guardrailed research / summarize / explain
- `market-data.mjs` — read-only Yahoo quotes + candles
- `paper-bot/evaluate.mjs` — replay harness (models vs baselines, ablation)
- `paper-bot/calibration.mjs` / `calibration.json` — fitted probability tables
- `paper-bot/features.mjs` / `context-model.mjs` — context features + logistic model
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
