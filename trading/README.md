# Trading research module

An **isolated, self-contained** module for finance **research and analysis**,
kept separate from the main app so the two can evolve independently — nothing
here imports from the app build, and changing the app never requires changing
this folder (or vice-versa). It reuses the same OpenRouter / **Ling 3.0 Flash
Fin** connection the app uses.

## Scope — read this first

This module is **information only**. It deliberately does **not**:

- ❌ predict prices or market direction ("will X go up or down")
- ❌ give buy / sell / hold recommendations, entry/exit points, or price targets
- ❌ give personalized investment advice
- ❌ connect to a brokerage, place orders, or move money

It **does**:

- ✅ explain instruments, metrics, and how to read them
- ✅ summarize and structure factual context you provide or ask about
- ✅ lay out drivers and risks so **you** can form your own view

Why the limits: no model — finance-tuned or not — can reliably forecast prices,
and executing trades / giving personalized advice is a licensed, high-risk
activity. Decision-support, never decision-making. The guardrails are enforced
in the model's system prompt (`research.mjs`), but they are policy, not a
technical guarantee — treat every output as general information.

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
node trading/research.mjs "Explain HDFC Bank's net interest margin and what moves it"
```

Or as a library:

```js
import { research, summarize, explain } from './trading/research.mjs';

const a = await research('What is a candlestick chart and how is it read?');

// Summarize a filing / press release / news you paste in (facts only, no verdict):
const s = await summarize(pastedFilingText, { focus: 'the revenue segments' });

// Explain a metric or chart pattern generically (textbook-style, ticker-agnostic):
const e = await explain('a bullish engulfing candle');
```

### Fetch real market data (read-only, no API key)

Grounds research in actual numbers. Uses the public Yahoo Finance chart endpoint
— **data in, no predictions out**. Prices may be delayed and carry no warranty.
Symbols follow Yahoo's convention: bare ticker for US (`AAPL`), a suffix for
other exchanges (`HDFCBANK.NS` for NSE India, `BP.L` for London).

```bash
node trading/market-data.mjs AAPL                        # latest quote
node trading/market-data.mjs HDFCBANK.NS --candles 3mo 1d # OHLC candles
```

```js
import { quote, candles } from './trading/market-data.mjs';
const q = await quote('AAPL');                       // { price, dayHigh, 52wk..., ... }
const c = await candles('HDFCBANK.NS', { range: '6mo', interval: '1d' });
```

### Option greeks & payoff calculator (educational, offline)

A pure-maths Black-Scholes calculator — **you supply every number**; it computes
theoretical price, greeks (delta/gamma/vega/theta), and the payoff mechanics
(breakeven, max loss, max profit) of a single-leg position you name. It does
**not** fetch data, connect to any broker, or suggest what to trade — same
numbers in, same numbers out.

```bash
# spot 2500, strike 2520, 7 days to expiry, IV 18%, a call:
node trading/blackscholes.mjs --spot 2500 --strike 2520 --days 7 --iv 18 --type CE

# add the mechanics of a specific position (e.g. buying it, lot size 250):
node trading/blackscholes.mjs --spot 2500 --strike 2520 --days 7 --iv 18 --type CE \
  --action buy --lot 250 --premium 22
```

```js
import { greeks, payoff } from './trading/blackscholes.mjs';
const g = greeks({ spot: 2500, strike: 2520, tYears: 7 / 365, iv: 0.18, type: 'CE' });
const p = payoff({ action: 'buy', type: 'CE', strike: 2520, premium: 22, lotSize: 250 });
```

The breakeven/max-loss/max-profit figures describe the mechanics of a position
*you* describe — they are not a recommendation to take it.

## Tests

No dependencies — Node's built-in runner with a mocked `fetch` (no network, no key):

```bash
cd trading && npm test        # or: node --test  (run from inside trading/)
```

## Files

- `config.mjs` — OpenRouter base URL + model (mirrors the app's `ling-fin` preset).
- `ling-client.mjs` — minimal OpenAI-compatible client (key from `OPENROUTER_API_KEY`).
- `research.mjs` — the guardrailed research entry point: `research` / `summarize` / `explain` (library + CLI).
- `market-data.mjs` — read-only public quotes + OHLC candles (library + CLI, no key).
- `blackscholes.mjs` — offline option greeks + payoff calculator (library + CLI, no data/broker).
- `test.mjs` — unit tests for the client, guardrail prompt, helpers, data parsing, and the maths.
