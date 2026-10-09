// Regression tests for the QA findings (2026-10-07). Offline: global fetch is
// mocked, the prediction log goes to a temp file, and the server is started on
// a random local port only to exercise its request guard and validation.
//
//   node --test        (runs test.mjs and this file)
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'trading-qa-'));
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { clampToBase, parseProb, baseProbabilities, shortWindowScore, formatIST, resolveYahooSymbol, topLabel } =
  await import('./paper-bot/groww-predict.mjs');
const { logPrediction, evaluatePending, computeStats, getHistory } = await import('./paper-bot/prediction-log.mjs');
const { PaperEngine } = await import('./paper-bot/paper-engine.mjs');
const { alignByDate, runBacktest } = await import('./paper-bot/backtest.mjs');
const { extractJson, normalizeConfidence } = await import('./paper-bot/llm-json.mjs');
const { normalizeBias, candlePredict } = await import('./paper-bot/candle-predict.mjs');
const { rsi } = await import('./paper-bot/indicators.mjs');
const { greeks, payoff } = await import('./blackscholes.mjs');
const { parseSymbols, parseBool } = await import('./util.mjs');
const { daySession } = await import('./groww-data.mjs');
const { fetchChart, candles, intraday, clearMarketCache } = await import('./market-data.mjs');
const { research } = await import('./research.mjs');
const { PAPER } = await import('./paper-bot/config.mjs');
const { generateSignal } = await import('./paper-bot/signal.mjs');

const realFetch = globalThis.fetch;
beforeEach(() => clearMarketCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

/** Build a Yahoo chart payload from bars [{ts, o, h, l, c, v}]. */
function chart(bars, meta = {}) {
  return {
    chart: {
      error: null,
      result: [{
        meta: { symbol: 'X.NS', gmtoffset: 19800, currency: 'INR', fullExchangeName: 'NSE', ...meta },
        timestamp: bars.map((b) => b.ts),
        indicators: {
          quote: [{
            open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l),
            close: bars.map((b) => b.c), volume: bars.map((b) => b.v ?? 1000),
          }],
        },
      }],
    },
  };
}
const res = (payload, status = 200) => ({
  ok: status === 200, status, statusText: status === 200 ? 'OK' : 'ERR',
  json: async () => payload, text: async () => JSON.stringify(payload),
});

// --- #1 #2 #3 probabilities -------------------------------------------------
test('clampToBase keeps every leg within ±15pp of the base and sums to 1', () => {
  const base = { probUp: 0.44, probDown: 0.2, probSideways: 0.36 };
  for (const adj of [
    { probUp: 0.9, probDown: 0.05, probSideways: 0.05 },
    { probUp: 0.0, probDown: 0.9, probSideways: 0.1 },
    { probUp: 0.33, probDown: 0.33, probSideways: 0.34 },
  ]) {
    const out = clampToBase(adj, base, 0.15);
    const sum = out.probUp + out.probDown + out.probSideways;
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
    for (const k of ['probUp', 'probDown', 'probSideways']) {
      assert.ok(Math.abs(out[k] - base[k]) <= 0.15 + 1e-9, `${k} moved ${out[k] - base[k]}`);
    }
  }
});

test('parseProb derives bias from the final probabilities, not the model text', () => {
  const base = { probUp: 0.5, probDown: 0.2, probSideways: 0.3 };
  const p = parseProb('{"probUp":0.6,"probDown":0.2,"probSideways":0.2,"bias":"DOWN","confidence":0.7}', base);
  assert.equal(p.bias, topLabel(p));
  assert.equal(p.bias, 'UP');
});

test('parseProb fallback explains a missing API key honestly', () => {
  const p = parseProb('', baseProbabilities(0), 'Missing OPENROUTER_API_KEY. Set your OpenRouter key first');
  assert.match(p.summary, /OPENROUTER_API_KEY is not set/);
});

test('baseProbabilities is neutral at 0, symmetric, and monotone in the score', () => {
  const z = baseProbabilities(0);
  assert.ok(Math.abs(z.probUp - z.probDown) < 1e-12, 'score 0 must not lean either way');
  let prevUp = -1;
  for (let s = -1; s <= 1.0001; s += 0.05) {
    const b = baseProbabilities(s);
    assert.ok(Math.abs(b.probUp + b.probDown + b.probSideways - 1) < 1e-12);
    assert.ok(b.probUp >= prevUp - 1e-12, `probUp not monotone at ${s.toFixed(2)}`);
    prevUp = b.probUp;
    const m = baseProbabilities(-s);
    assert.ok(Math.abs(b.probUp - m.probDown) < 1e-12, 'not symmetric');
  }
  assert.ok(baseProbabilities(-0.1).probDown > baseProbabilities(-0.1).probUp);
});

test('short windows (last hour / 15 min) get a non-neutral price-action score', () => {
  const up = [100, 100.2, 100.5].map((c, i) => ({ open: c - 0.1, high: c + 0.05, low: c - 0.15, close: c, ts: i }));
  assert.ok(shortWindowScore(up) > 0.3);
  const down = up.map((r) => ({ ...r, open: 200 - r.open, close: 200 - r.close, high: 200 - r.low, low: 200 - r.high }));
  assert.ok(shortWindowScore(down) < -0.3);
});

test('formatIST is IST regardless of the machine timezone', () => {
  assert.equal(formatIST(new Date('2026-01-01T00:00:00Z')), '2026-01-01 05:30:00');
});

// --- #7 symbols ---------------------------------------------------------------
test('resolveYahooSymbol: NSE first, then bare US ticker; qualified symbols untouched', async () => {
  globalThis.fetch = async (url) => (String(url).includes('/AAPL.NS?')
    ? res({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 404)
    : res(chart([{ ts: 1700000000, o: 1, h: 1, l: 1, c: 1 }])));
  assert.equal(await resolveYahooSymbol('aapl'), 'AAPL');
  assert.equal(await resolveYahooSymbol('HDFCBANK'), 'HDFCBANK.NS');
  assert.equal(await resolveYahooSymbol('^NSEI'), '^NSEI');
  assert.equal(await resolveYahooSymbol('BTC-USD'), 'BTC-USD');
});

// --- #4 hit-rate --------------------------------------------------------------
function predictionResult(overrides = {}) {
  return {
    symbol: 'X.NS', mode: '15m', intervalMinutes: 15, asOf: '2026-10-07 10:00', lastClose: 100,
    prediction: { bias: 'SIDEWAYS', probUp: 0.25, probDown: 0.25, probSideways: 0.5, confidence: 0.4 },
    indicators: { atr14: 0 }, ...overrides,
  };
}

test('a prediction is NOT scored before its horizon passes (no free SIDEWAYS hits)', async () => {
  logPrediction(predictionResult());
  globalThis.fetch = async () => assert.fail('no price lookup before the horizon');
  const r = await evaluatePending({});
  assert.equal(r.updated, 0);
  assert.equal(computeStats().pending, 1);
});

test('a due prediction is scored at the bar after its horizon', async () => {
  const entry = logPrediction(predictionResult({ prediction: { bias: 'UP', probUp: 0.5, probDown: 0.2, probSideways: 0.3, confidence: 0.6 } }));
  // Pretend it was logged 3 hours ago.
  const { readFileSync, writeFileSync } = await import('node:fs');
  const log = JSON.parse(readFileSync(process.env.PREDICTION_LOG_PATH, 'utf8'));
  const predMs = Date.now() - 3 * 3600_000;
  for (const e of log.entries) if (e.id === entry.id) e.ts = new Date(predMs).toISOString();
  writeFileSync(process.env.PREDICTION_LOG_PATH, JSON.stringify(log));
  const t = (min) => Math.ceil((predMs + min * 60_000) / 1000);
  globalThis.fetch = async () => res(chart([
    { ts: t(30), o: 100.5, h: 101, l: 100, c: 100.8 },
    { ts: t(60), o: 102, h: 103, l: 101, c: 102.5 }, // first bar at/after +60 min
    { ts: t(75), o: 99, h: 99, l: 98, c: 98.5 },
  ]));
  await evaluatePending({});
  const e = getHistory(10).find((x) => x.id === entry.id);
  assert.equal(e.evaluated, true);
  assert.equal(e.futureClose, 102);
  assert.equal(e.realizedLabel, 'UP');
  assert.equal(e.hitBias, true);
});

test('getHistory clamps silly limits', () => {
  assert.ok(getHistory('abc').length >= 1);
  assert.equal(getHistory(1).length, 1);
});

// --- #6 #8 #10 #11 #14 #30 paper engine / backtest ----------------------------
test('trade PnL includes entry AND exit charges (long and short)', () => {
  for (const side of ['openLong', 'openShort']) {
    const e = new PaperEngine({ product: 'intraday', costs: { slippagePct: 0 } });
    e[side]('A', 100, 'd1', 2);
    const { trade } = e.closePosition('A', 100, 'd2');
    assert.ok(trade.charges > 0);
    assert.ok(Math.abs(trade.pnl + trade.charges) < 1e-9, `${side}: pnl ${trade.pnl} vs -${trade.charges}`);
    assert.ok(Math.abs(e.cash - (PAPER.startingCapital - trade.charges)) < 1e-6);
  }
});

test('Indian cost model: delivery round trip ≈ 0.2% + DP; intraday far cheaper', async () => {
  const { orderCharges } = await import('./paper-bot/costs.mjs');
  const v = 100000;
  const del = orderCharges({ side: 'buy', value: v, product: 'delivery' }).total + orderCharges({ side: 'sell', value: v, product: 'delivery' }).total;
  const intra = orderCharges({ side: 'buy', value: v, product: 'intraday' }).total + orderCharges({ side: 'sell', value: v, product: 'intraday' }).total;
  // delivery: STT 0.1%×2 = ₹200, stamp ₹15, exchange ~₹5.9, GST, DP ₹15.93
  assert.ok(del > 235 && del < 240, `delivery ${del}`);
  // intraday: STT ₹25, stamp ₹3, brokerage ₹20×2, exchange, GST
  assert.ok(intra > 75 && intra < 85, `intraday ${intra}`);
});

test('no overnight shorts in delivery mode', () => {
  const e = new PaperEngine({ product: 'delivery' });
  const r = e.openShort('A', 100, 'd1', 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /intraday only/);
});

test('intraday backtest squares off every position at the session end', async () => {
  const bars = [];
  for (let d = 0; d < 6; d++) {
    for (let k = 0; k < 25; k++) {
      const i = d * 25 + k;
      const c = 100 + i * 0.3 + Math.sin(i) * 1.5;
      const hh = String(9 + Math.floor((15 + k * 15) / 60)).padStart(2, '0');
      const mm = String((15 + k * 15) % 60).padStart(2, '0');
      bars.push({ date: `2026-01-0${d + 1} ${hh}:${mm}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + (i % 5) * 100 });
    }
  }
  const r = await runBacktest({ A: bars }, { techOnly: true, product: 'intraday' });
  for (const t of r.summary.trades) {
    if (t.reason === 'end-of-test') continue;
    assert.equal(t.entryDate.slice(0, 10), t.exitDate.slice(0, 10), `held overnight: ${t.entryDate} → ${t.exitDate}`);
  }
});

test('a gap through the stop fills at the open, not the stop', () => {
  const e = new PaperEngine({ product: 'intraday', costs: { slippagePct: 0 } });
  e.openLong('A', 100, 'd1', 2); // stop 97
  const [t] = e.checkStopsAndTargets('A', { date: 'd2', open: 90, high: 91, low: 89 });
  assert.equal(t.exitPrice, 90);
  const s = new PaperEngine({ product: 'intraday', costs: { slippagePct: 0 } });
  s.openShort('B', 100, 'd1', 2); // stop 103
  const [u] = s.checkStopsAndTargets('B', { date: 'd2', open: 110, high: 111, low: 109 });
  assert.equal(u.exitPrice, 110);
});

test('alignByDate keeps only dates every symbol has', () => {
  const out = alignByDate({
    A: [{ date: '1' }, { date: '2' }, { date: '3' }],
    B: [{ date: '2' }, { date: '3' }, { date: '4' }],
  });
  assert.deepEqual(out.A.map((b) => b.date), ['2', '3']);
  assert.deepEqual(out.B.map((b) => b.date), ['2', '3']);
});

test('backtest walks date-aligned bars and labels the equity curve', async () => {
  const mk = (n, offset) => Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.3 + Math.sin(i) * 1.5;
    return { date: `2026-01-${String(i + offset).padStart(3, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 };
  });
  const r = await runBacktest({ A: mk(90, 0), B: mk(90, 5) }, { techOnly: true });
  assert.equal(r.bars, 85); // 5-day offset → 85 shared dates
  assert.ok(r.summary.equityCurve.every((p) => p.date), 'every curve point has a date');
});

test('backtest needs enough shared bars and says why', async () => {
  const few = Array.from({ length: 20 }, (_, i) => ({ date: String(i), open: 1, high: 1, low: 1, close: 1 }));
  await assert.rejects(() => runBacktest({ A: few }), (e) => e.status === 400 && /Not enough bars/.test(e.message));
});

test('15-min paper preset fetches enough history for a backtest', () => {
  assert.equal(PAPER.intraday['15m'].range, '1mo');
});

test('RSI of a flat series is 50, not 100', () => {
  assert.equal(rsi(Array(20).fill(5), 14), 50);
});

// --- #12 #9 AI reply parsing ---------------------------------------------------
test('extractJson skips braces in leading prose and strips fences', () => {
  assert.deepEqual(extractJson('Thinking {draft}… final: {"signal":"LONG","confidence":0.7}', (o) => 'signal' in o), { signal: 'LONG', confidence: 0.7 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('extractJson repairs a reply that is missing its closing brace (seen live from Ling)', () => {
  const live = '```json\n{\n  "signal": "FLAT",\n  "confidence": 0.55,\n  "reasoning": "mixed signals."\n```';
  assert.deepEqual(extractJson(live, (o) => 'signal' in o), { signal: 'FLAT', confidence: 0.55, reasoning: 'mixed signals.' });
});

test('chat() recovers the JSON answer from message.reasoning when content is null (seen live from Ling)', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { chat } = await import('./ling-client.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return res({ choices: [{ message: { content: null, reasoning: 'Schema {"signal": "LONG" | "SHORT"}… final answer: {"signal":"SHORT","confidence":0.65,"reasoning":"x"}' } }] });
  };
  const out = await chat([{ role: 'user', content: 'x' }], { jsonKeys: ['signal'] });
  assert.deepEqual(JSON.parse(out), { signal: 'SHORT', confidence: 0.65, reasoning: 'x' });
  assert.equal(calls, 1);
});

test('chat() retries once on an empty reply, then returns ""', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const { chat } = await import('./ling-client.mjs');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return res({ choices: [{ message: { content: calls === 1 ? null : 'second try' } }] });
  };
  assert.equal(await chat([{ role: 'user', content: 'x' }]), 'second try');
  assert.equal(calls, 2);
});

test('normalizeConfidence handles percent, words, and junk', () => {
  assert.equal(normalizeConfidence(75), 0.75);
  assert.equal(normalizeConfidence('70%'), 0.7);
  assert.equal(normalizeConfidence('high'), 0.75);
  assert.equal(normalizeConfidence('???', 0), 0);
});

test('hybrid signal reads confidence 75 as 75% and "high" as 0.75', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const bars = Array.from({ length: 80 }, (_, i) => {
    const c = 100 + i * 0.3 + Math.sin(i) * 1.5;
    return { date: `d${i}`, open: c * 0.998, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + (i % 5) * 100 };
  });
  for (const [conf, want] of [['75', 0.75], ['"high"', 0.75]]) {
    globalThis.fetch = async () => res({ choices: [{ message: { content: `{"signal":"LONG","confidence":${conf},"reasoning":"x"}` } }] });
    const s = await generateSignal('X', bars, {});
    assert.equal(s.confidence, want);
  }
});

test('candle bias mapping only accepts exact words ("NOT BEARISH" → NEUTRAL)', () => {
  assert.equal(normalizeBias('NOT BEARISH'), 'NEUTRAL');
  assert.equal(normalizeBias('bullish'), 'BULLISH');
  assert.equal(normalizeBias('Bear'), 'BEARISH');
});

test('candle AI read clamps the range for 15-min bars instead of failing', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  let yahooUrl = '';
  const base = 1_780_000_000;
  const bars = Array.from({ length: 70 }, (_, i) => ({ ts: base + i * 900, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) return res({ choices: [{ message: { content: '{"bias":"NEUTRAL","confidence":0.5,"summary":"s"}' } }] });
    yahooUrl = String(url);
    return res(chart(bars));
  };
  const out = await candlePredict('X.NS', { interval: '15m', range: '3mo' });
  assert.match(yahooUrl, /range=1mo/);
  assert.match(out.rangeAdjusted, /used 1mo/);
});

// --- #13 options --------------------------------------------------------------
test('greeks rejects bad input instead of returning NaN / pricing as a put', () => {
  const ok = { spot: 100, strike: 100, tYears: 0.1, iv: 0.2, type: 'CE' };
  assert.throws(() => greeks({ ...ok, spot: NaN }), (e) => e.status === 400);
  assert.throws(() => greeks({ ...ok, spot: -5 }), /Spot/);
  assert.throws(() => greeks({ ...ok, type: 'XX' }), /CE or PE/);
  assert.throws(() => greeks({ ...ok, tYears: -1 }), /Days/);
});

test('payoff rejects a put premium above the strike', () => {
  assert.throws(() => payoff({ action: 'buy', type: 'PE', strike: 100, premium: 120 }), /cannot exceed/);
  assert.throws(() => payoff({ action: 'hold', type: 'CE', strike: 100, premium: 5 }), /buy or sell/);
});

// --- #16 #19 #20 #21 #22 inputs & errors ---------------------------------------
test('parseSymbols accepts arrays and comma/space strings', () => {
  assert.deepEqual(parseSymbols('TCS.NS, INFY.NS  SBIN.NS'), ['TCS.NS', 'INFY.NS', 'SBIN.NS']);
  assert.deepEqual(parseSymbols([' A ', '']), ['A']);
  assert.deepEqual(parseSymbols(null), []);
  assert.throws(() => parseSymbols(42), /symbols must be/);
  assert.equal(parseBool('false'), false);
  assert.equal(parseBool(true), true);
});

test('research() rejects an empty question before calling the model', async () => {
  globalThis.fetch = async () => assert.fail('must not call the model');
  await assert.rejects(() => research('   '), (e) => e.status === 400);
});

test('daySession rejects impossible dates', async () => {
  await assert.rejects(() => daySession('HDFCBANK', '2026-13-45'), /real date/);
  await assert.rejects(() => daySession('HDFCBANK', '2026-02-30'), /real date/);
});

test('unknown symbol → 404 with a .NS hint instead of raw JSON', async () => {
  globalThis.fetch = async () => res({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 404);
  await assert.rejects(() => fetchChart('RELIANCE'), (e) => e.status === 404 && /RELIANCE\.NS/.test(e.message) && !/\{/.test(e.message));
});

test('a 429 from Yahoo is retried once', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n === 1 ? res({}, 429) : res(chart([{ ts: 1700000000, o: 1, h: 1, l: 1, c: 1 }])));
  await fetchChart('X.NS');
  assert.equal(n, 2);
});

// --- #17 #18 intraday labels ------------------------------------------------------
test('intraday candles carry a time in their date label', async () => {
  globalThis.fetch = async () => res(chart([{ ts: 1791300000, o: 1, h: 1, l: 1, c: 1 }, { ts: 1791300900, o: 1, h: 1, l: 1, c: 1 }]));
  const rows = await candles('X.NS', { range: '5d', interval: '15m' });
  assert.match(rows[0].date, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.notEqual(rows[0].date, rows[1].date);
});

test('intraday(date: "previous") returns the session before the exchange\'s today', async () => {
  const off = 19800;
  const todayLocal = new Date(Date.now() + off * 1000).toISOString().slice(0, 10);
  const dayStart = (d) => Math.floor(Date.parse(d + 'T09:15:00Z') / 1000) - off;
  const yesterday = new Date(Date.parse(todayLocal) - 86400000).toISOString().slice(0, 10);
  globalThis.fetch = async () => res(chart([
    { ts: dayStart(yesterday), o: 1, h: 1, l: 1, c: 1 },
    { ts: dayStart(todayLocal), o: 2, h: 2, l: 2, c: 2 },
  ]));
  const d = await intraday('X.NS', { interval: '1m', date: 'previous' });
  assert.equal(d.date, yesterday);
});

// --- #5 #19 server guard & validation (no network needed) ----------------------
const PORT = 3900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [join(HERE, 'server.mjs')], { env: { ...process.env, PORT: String(PORT), AUTO_EVALUATE: '0', SETTINGS_PATH: join(TMP, 'settings.json'), PORTFOLIO_PATH: join(TMP, 'portfolio.json') }, stdio: 'pipe' });
after(() => server.kill());
await new Promise((resolve) => server.stdout.once('data', resolve));

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...headers } }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const JSONH = { 'content-type': 'application/json' };

test('server rejects foreign Host headers (DNS rebinding)', async () => {
  assert.equal((await call('/', { headers: { host: 'attacker.example' } })).status, 421);
});

test('server rejects cross-site and non-JSON POSTs (CSRF)', async () => {
  assert.equal((await call('/api/prediction-stats', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/ask', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"question":"x"}' })).status, 415);
  assert.equal((await call('/api/ask', { method: 'POST', headers: { ...JSONH, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await call('/api/prediction-stats', { headers: { 'sec-fetch-site': 'same-origin', origin: `http://localhost:${PORT}` } })).status, 200);
});

test('server answers bad input with 400, not 500', async () => {
  const cases = [
    ['/api/ask', { method: 'POST', headers: JSONH, body: 'not-json' }],
    ['/api/ask', { method: 'POST', headers: JSONH, body: 'null' }],
    ['/api/ask', { method: 'POST', headers: JSONH, body: '{"mode":"explain"}' }],
    ['/api/option?strike=100&days=30&iv=20'],
    ['/api/option?spot=100&strike=100&days=30&iv=20&type=XX'],
    ['/api/option?spot=100&strike=100&days=30&iv=20&type=PE&action=buy&premium=120'],
    ['/api/quote?symbol='],
    ['/api/candles?symbol=TCS.NS&range=bad'],
    ['/api/intraday?symbol=TCS.NS&date=garbage'],
    ['/api/paper-scan', { method: 'POST', headers: JSONH, body: '{"interval":"3d"}' }],
    ['/api/foundation?model=gpt&symbol=TCS.NS'],
    ['/api/foundation-replay?model='],
    ['/api/foundation-replay', { method: 'POST', headers: JSONH, body: '{"model":"x"}' }],
  ];
  for (const [path, opts] of cases) {
    const r = await call(path, opts);
    assert.equal(r.status, 400, `${path} ${opts?.body ?? ''} → ${r.status} ${r.body}`);
  }
});
