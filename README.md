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

## Run it always (macOS)

The project must live outside ~/Downloads, ~/Desktop and ~/Documents (macOS
blocks background services there), e.g. `~/trading-research`.

```bash
# 1. Store your keys in the macOS Keychain (encrypted; prompts for the value)
security add-generic-password -U -a "$USER" -s trading-research-openrouter -w
security add-generic-password -U -a "$USER" -s trading-research-groww -w      # optional

# 2. Install the background services (once)
bash scripts/install-autostart.sh
```

That installs LaunchAgents: the **server** starts at login and is restarted
if it stops; the **collector** runs weekdays 16:05, the **monitor** weekdays
10:00 / 13:00 / 15:00 (macOS notifications for alerts), the **refit**
Saturdays 10:00. Missed runs happen when the Mac wakes. Logs:
`~/Library/Logs/trading-research/`.

```bash
launchctl kickstart -k gui/$(id -u)/com.trading-research.server   # restart (e.g. after changing a key)
launchctl list | grep trading-research                            # status
bash scripts/uninstall-autostart.sh                               # remove
```

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
- **News sentiment**: recent headlines (Google News RSS India edition for
  NSE/BSE, with aliases such as SBIN → "SBI"; Yahoo for others), a factual Ling
  brief, a sentiment score (−1…+1) and event-risk flags (results, dividend,
  corporate action, rating change, policy). Shown in Call/Put (on by default),
  the paper scan and the paper portfolio.
- **News tilt**: in Call/Put, sentiment (|s| ≥ 0.2) moves probability between
  UP and DOWN by at most `newsTiltPts` × sentiment (default 5 pts, editable in
  Settings, 0 = off); SIDEWAYS is untouched. Both versions are logged, and the
  tilt **switches itself off** once 20+ scored predictions show it doesn't
  improve the Brier score. Sentiment is model-generated and can vary between
  runs — treat it as context.
- **Auto-evaluation**: the server scores due predictions every 15 minutes
  (`AUTO_EVALUATE=0` to disable).
- **Settings**: capital, risk, limits, confidence threshold, symbols and cost
  overrides, saved to `paper-bot/settings.json`.

### Investor monitor

`npm run monitor` (with the dashboard running) does what an investor would
check, and records it: Call/Put + news for the whole watchlist (each prediction
is logged for scoring), scores due predictions, applies daily signals to the
paper portfolio, and prints a scorecard — hit-rate, Brier vs a coin-flip,
whether Ling's adjustment and the news tilt help. Reports go to
`paper-bot/monitor/<date-time IST>.json` and a running `journal.md`. Read the
scorecard only after ~30+ scored predictions.

### Stock ranking (weeks–months)

`node paper-bot/ranking.mjs --horizon 60` (or dashboard → Stock ranking →
Evidence) replays 5 years of NIFTY 50 rankings at non-overlapping dates for
fixed-rule signals — 12-1 / 6-1 month momentum, 3-month momentum, 1-month
reversal, low volatility, nearness to 52-week high, trend, and a composite —
and reports the information coefficient (rank correlation with the following
return), t-stat, stability across halves, top-minus-bottom spread, and a
top-5 portfolio net of costs vs equal weight and NIFTY. `--live` prints today's
ranking. Oct 2026 result: no signal reached "strong" evidence in this sample
(5 years, large caps, survivorship-biased universe).

### Intraday history collector

`npm run collect` after the close merges the day's 5-min / 15-min bars into
`paper-bot/data/candles/` so intraday history grows beyond Yahoo's ~1 month;
the replay harness uses it automatically. With `GROWW_ACCESS_TOKEN`,
`node paper-bot/collector.mjs --groww-backfill 120` adds older history.
`--status` shows what is stored.

### Volatility check

Dashboard → Volatility check (or `node paper-bot/volatility.mjs ^NSEI`):
forecast volatility (EWMA, 20/60-day) vs what options price (India VIX for
NIFTY, or the IV you enter for a stock), with ±1σ moves to expiry.
`--eval` scores forecasters on 5 years (QLIKE): India VIX was the best NIFTY
forecaster, yet averaged ~15% vs ~12% realised and sat above realised ~79% of
the time (the usual volatility risk premium).

### News stability & facts

One AI news reading per stock per day (cached in `paper-bot/data/`), so
sentiment doesn't drift between runs. Ling also extracts structured facts —
results beat/miss/inline (actual results only), guidance raised/cut,
upgrade/downgrade, order win, management change, regulatory action — shown as
chips and logged; the hit-rate panel shows what followed each fact type.
Scoring counts one prediction per stock per day.

### Today page, health, alerts, events

- **Today** (top of the dashboard): the latest monitor run on one screen —
  alerts, health chips, NIFTY volatility, watchlist, ranking, earnings events,
  paper portfolio and scorecard. *Run now* re-runs the monitor in-process.
- **Health checks** (`/api/health`): market data, news feed, AI key present
  (never its value), intraday-store freshness, calibration age, scoring
  progress, last monitor run.
- **Alerts**: held stock with a results event, NIFTY options unusually rich or
  cheap vs forecast, news tilt switched off, probabilities worse than a
  coin-flip after 30+ scored, failing health checks, new events.
  `node paper-bot/monitor.mjs --notify` shows them as macOS notifications.
- **Earnings & rating events** (`paper-bot/events.mjs`): results beat / miss /
  in-line, upgrades / downgrades and guidance changes from NIFTY 50 news are
  recorded with the price, then returns at +1 / +5 / +20 trading days vs NIFTY
  are measured (post-earnings drift, tracked going forward).
  Facts are only kept when the headline Ling cites actually supports them;
  previews, business updates, older quarters, foreign namesakes ("Titan
  Machinery", "Severn Trent", "Bel Fuse") and plain ratings without a change
  are rejected.
- **Ranking universes**: NIFTY 50 / 100 / 200 / 500 from NSE's official lists
  (`npm run ranking`), sort the live ranking by any signal.
- **Groww** (with `GROWW_ACCESS_TOKEN`): `npm run backfill` adds ~120 days of
  intraday history; the volatility check reads ATM IV and the put/call OI ratio
  from Groww's option chain (default expiry: last Tuesday of the month).
- **Scheduled** (Claude app): monitor 10:00 / 13:00 / 15:00 IST weekdays,
  collector ~16:00 weekdays, model refit Saturdays 10:00.

### Volatility models (upgraded)

`node paper-bot/volatility.mjs --eval --save` scores EWMA, 20/60-day, GARCH(1,1),
HAR (daily/weekly/monthly realised variance) and a blend on identical dates
(QLIKE), plus India VIX and a bias-corrected VIX for NIFTY, and saves the
winners to `paper-bot/vol-model.json` (stocks → HAR, NIFTY → blend in Oct
2026; HAR ~10% better than EWMA). The live check uses the winner, judges NIFTY
against VIX's *usual* premium (~24% over realised) instead of calling every
day "expensive", and adds a one-big-day add-on when results are due.

### Strategies: backtests + forward test

`node paper-bot/strategies.mjs` (dashboard → Strategies) tests two rule-based,
low-turnover strategies fixed in advance, after Indian costs, vs NIFTY
buy-and-hold (+dividends), over 10 years, with both halves reported:

- **A · NIFTY trend**: NIFTY ETF while NIFTY > 200-day average (±1%), else a
  liquid fund. Month-end check: ~9.1% CAGR vs 10.5% but max drawdown ~15% vs
  ~38% — a risk reducer, not a return booster.
- **B · Momentum** (NIFTY 200, top 20, monthly) built up as B0 → B1 buffer →
  B2 market filter → B3 vol target, plus an **equal-weight control** of the
  same stocks (shares the survivorship bias) and a **real-ETF reality check**
  (MOMENTUM.NS vs NIFTYBEES since 2022: 8.6% vs 7.0% CAGR, max drawdown 31%
  vs 15%). The backtest's big numbers are mostly survivorship bias.

Taxes (STCG on switches/rebalances) are not modelled.

**Forward test**: `paper-bot/strategy-accounts.mjs` runs NIFTY buy-and-hold,
A and B2 as ₹10 lakh paper accounts from the start date with real costs (ETF
rates for NIFTYBEES), trading only on their own schedules (A and B2 monthly);
the monitor updates them every run. Results from here on can't be
hindsight-fitted — judge after many months.

### Call / Put payoff odds (volatility-based)

Dashboard → Call / Put payoff odds, or `node paper-bot/option-odds.mjs TCS.NS CE 2150 25 7`:
the chance an option ends **above breakeven** at expiry (CE: strike + premium,
PE: strike − premium) from the volatility forecast — normal and fat-tailed
(the stock's own past moves) — vs the chance implied by the option's price,
plus fair value at forecast vol vs the premium. `--eval` replays 5 years:
predicted vs observed frequencies line up (e.g. 32% → 32%, 72% → 73%).

### Is Ling worth it? (replay)

`OPENROUTER_API_KEY=… node paper-bot/ling-replay.mjs --n 200 --apply` replays
past moments through the identical Ling prompt, **anonymised** (no names,
dates or real prices, so the model can't recall what happened), and compares
the Brier score with vs without Ling's adjustment. Rule fixed in advance:
keep it only if it helps with t ≤ −2; `--apply` sets Settings → llmAdjust.

### FII positioning test

`node paper-bot/fii.mjs` (dashboard → Model evaluation → FII positioning test)
downloads NSE's daily participant-wise open interest (cached; polite; stops if
NSE blocks) and tests whether FII index-futures / options positioning predicted
NIFTY's next 5 / 20 sessions. Result so far: no reliable evidence — shown as
context only, not used in predictions.

### Context model replication

The context model must now also beat calibration on 10 NIFTY 50 stocks it
never saw (`HOLDOUT_UNIVERSE`) before it is used live. Oct 2026: 5-min (+4.0%
on unseen stocks) and daily (+0.5%) pass; 15-min and 60-min are off.

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
| `/api/rankings` | GET | Current composite ranking `?symbols=` |
| `/api/ranking-eval` | POST | Ranking replay `{horizon: 20|40|60, symbols?}` |
| `/api/vol-check` | GET | Implied vs forecast vol `?symbol=&iv=&days=` |
| `/api/vol-eval` | POST | Volatility forecast replay |
| `/api/health` | GET | Health checks |
| `/api/events` | GET | Tracked earnings/rating events + drift stats |
| `/api/events/scan` | POST | Scan news for new events `{universe?|symbols?}` |
| `/api/today` | GET | Latest monitor report + health |
| `/api/today/run` | POST | Run the investor monitor now |
| `/api/strategy-tests` | POST | 10-year strategy backtests `{capital?, universe?}` |
| `/api/strategy-accounts` | GET | Forward-test paper accounts |
| `/api/strategy-accounts/rebalance` | POST | Run the accounts' schedules + mark to market |
| `/api/strategy-accounts/reset` | POST | Restart the forward test `{capital}` |
| `/api/option-odds` | GET | Payoff odds `?symbol=&type=&strike=&premium=&iv=&days=` |
| `/api/option-odds-eval` | POST | Calibration replay of the odds |
| `/api/fii-test` | POST | FII positioning test |

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
