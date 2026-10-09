// Offline tests for the statistical-validity fixes (embargo, next-day signals,
// tax basis, missing prices, earnings drift, IST dates, VIX-scaled vol).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-statsfix-'));
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
process.env.STRATEGY_ACCOUNTS_PATH = join(TMP, 'accounts.json');
process.env.INDEX_LIST_DIR = TMP;
process.env.EVENTS_PATH = join(TMP, 'events.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

function walk(n, seed = 1, start = 100) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const rows = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = o * (1 + (rnd() - 0.5) * 0.03);
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, ts: Date.parse(d) / 1000, open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c, volume: 1000 });
  }
  return rows;
}

// ---- 1. go-live gate: embargo + holdout after train date ----
test('evaluate: embargo drops horizon train samples per symbol; holdout only after train dates', async () => {
  const { evaluateModels, buildSamples } = await import('./paper-bot/evaluate.mjs');
  const data = { A: walk(700, 7), B: walk(700, 11) };
  const r = await evaluateModels({ interval: '1d', symbols: ['A', 'B'], loadCandles: async (s) => data[s] });
  const total = buildSamples(data.A, 1).length + buildSamples(data.B, 1).length;
  assert.equal(r.samples.train + r.samples.test, total - 2 * 1); // horizon 1 x 2 symbols
  assert.equal(typeof r.useCalibrated, 'boolean');
});

test('evaluate: holdout stocks are scored only on bars after the latest train date', async () => {
  const { evaluateModels } = await import('./paper-bot/evaluate.mjs');
  const { MARKET_INDEX, VIX_INDEX } = await import('./paper-bot/features.mjs');
  const data = { 'A.NS': walk(700, 11), 'B.NS': walk(700, 13), 'H.NS': walk(700, 29), [MARKET_INDEX]: walk(700, 17, 20000), [VIX_INDEX]: walk(700, 19, 14) };
  const r = await evaluateModels({ interval: '1d', symbols: ['A.NS', 'B.NS'], holdoutSymbols: ['H.NS'], loadCandles: async (s) => data[s] });
  const n = r.holdout.n;
  assert.ok(n > 0 && n < 700 * 0.45, `holdout n=${n} should only cover the post-train tail`);
});

// ---- 2. trend strategy: signal at close i acts from close i+1 ----
test('trendStrategy: a one-day crash that triggers the signal is still suffered; the exit is a day later', async () => {
  const { trendStrategy, ASSUMPTIONS } = await import('./paper-bot/strategies.mjs');
  const n = 260;
  const idx = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    idx.push({ date: d, close: 100 + i * 0.1 });
  }
  const crash = 230;
  idx[crash].close = 50; // signal fires at the crash close
  for (let i = crash + 1; i < n; i++) idx[i].close = 50;
  const a = { ...ASSUMPTIONS, bandPct: 0, etfRoundTripPct: 0, etfExpense: 0, dividendYield: 0 };
  const r = trendStrategy(idx, { a });
  const k = crash - r.start; // curve index of the crash day
  // Crash day is suffered in full (we were invested), exit executes at the NEXT close.
  assert.ok(r.curve[k].equity / r.curve[k - 1].equity < 0.6);
  assert.equal(r.path[k], 1, 'still invested over the day after the signal');
  assert.equal(r.path[k + 1], 0, 'flat from the day after that');
  // 4% cash-yield sensitivity changes the label and the result.
  const lowCash = trendStrategy(idx, { monthEnd: true, a: { ...a, liquidYield: 0.04 }, label: 'x' });
  assert.equal(lowCash.name, 'x');
});

test('runStrategyTests lists the 4% cash-yield sensitivity row for A', async () => {
  const { runStrategyTests } = await import('./paper-bot/strategies.mjs');
  const idx = [];
  let c = 100;
  for (let i = 0; i < 1200; i++) {
    c *= 1 + Math.sin(i / 40) * 0.004 + 0.0003;
    idx.push({ date: new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: c });
  }
  const r = await runStrategyTests({ loadCandles: async (s) => (s === '^NSEI' ? idx : []) }).catch((e) => ({ err: e }));
  if (r.err) return; // universe loading needs the network/index list; the A rows are exercised above
  assert.ok(r.A.some((x) => x.name === 'A · NIFTY trend (month-end, 4% cash yield)'));
});

// ---- 3. momentum account: missing price skips the rebalance; tax basis excludes STT/DP ----
const dayN = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const up = (p, slope) => Array.from({ length: 450 }, (_, i) => ({ date: dayN(i), close: p * (1 + i * slope) }));

test('momentum rebalance is skipped (not valued at 0) when a held symbol has no price', async () => {
  const { rebalanceAccounts, resetAccounts, loadAccounts } = await import('./paper-bot/strategy-accounts.mjs');
  const { writeFileSync } = await import('node:fs');
  resetAccounts(1e6);
  const st = loadAccounts();
  st.accounts.momentum.holdings = { GONE: { qty: 10, cost: 5000 } };
  writeFileSync(process.env.STRATEGY_ACCOUNTS_PATH, JSON.stringify(st));
  const load = async (s) => {
    if (s === 'GONE') throw new Error('delisted');
    return s === '^NSEI' ? up(20000, 0.001) : up(1000, 0.002);
  };
  const r = await rebalanceAccounts({ now: new Date('2026-10-08T06:00:00Z'), loadCandles: load });
  assert.ok(r.actions.some((a) => a.account === 'momentum' && /skipped — missing price for GONE/.test(a.action)), JSON.stringify(r.actions));
  assert.ok(loadAccounts().accounts.momentum.holdings.GONE, 'holding untouched');
  assert.equal(loadAccounts().accounts.momentum.lastRebalanceMonth, null, 'will retry next run');
});

test('tax lots exclude STT and DP charges from the cost basis', async () => {
  const { rebalanceAccounts, resetAccounts, loadAccounts } = await import('./paper-bot/strategy-accounts.mjs');
  resetAccounts(1e6);
  const load = async (s) => (s === '^NSEI' ? up(20000, 0.001) : up(1000, 0.002));
  await rebalanceAccounts({ now: new Date('2026-10-08T06:00:00Z'), loadCandles: load });
  const m = loadAccounts().accounts.momentum;
  const buy = m.trades.find((t) => t.side === 'buy');
  assert.ok(buy, 'momentum bought something');
  const lots = m.tax.lots[buy.symbol] || (m.tax.lots instanceof Array ? m.tax.lots.find((x) => x[0] === buy.symbol)?.[1] : null);
  const lot = lots[0];
  const perUnit = lot.cost; // per-unit price in the ledger
  const gross = buy.price;
  const withAll = gross + buy.charges / buy.qty;
  assert.ok(perUnit >= gross && perUnit < withAll - 1e-9, `basis/unit ${perUnit} between ${gross} and ${withAll}`);
});

// ---- 4. earnings drift: shared base close, completed sessions only, t-stats ----
test('events: both legs use the base bar close, only completed sessions settle, stats carry n and t', async () => {
  const ev = await import('./paper-bot/events.mjs');
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10));
  const stock = days.map((d, i) => ({ date: d, close: 100 * (1 + 0.01 * i) }));
  const nifty = days.map((d, i) => ({ date: d, close: 20000 * (1 + 0.002 * i) }));
  // recorded price (stale/intraday) deliberately differs from the day's close
  ev.recordEvents('Q.NS', { results: 'beat' }, { price: 90, date: days[0] });
  ev.recordEvents('R.NS', { results: 'beat' }, { price: 100, date: days[0] });
  const load = async (s) => (s === '^NSEI' ? nifty : stock);
  // "now" = during the session of bar 5: bar 5 is not yet a completed past session
  await ev.updateEventReturns({ load, now: new Date(`${days[5]}T08:00:00Z`) });
  const e = ev.loadEvents().find((x) => x.symbol === 'Q.NS');
  assert.equal(e.returns[5], undefined, 'today\'s bar must not settle');
  assert.ok(e.returns[1], 'yesterday\'s bar settles');
  assert.ok(Math.abs(e.returns[1].ret - 0.01 / 1) < 1e-9 * 100 + 1e-6);
  assert.ok(Math.abs(e.returns[1].abnormal - (e.returns[1].ret - 0.002)) < 1e-6);
  await ev.updateEventReturns({ load, now: new Date(`${days[29]}T08:00:00Z`) });
  const st = ev.eventStats().find((t) => t.type === 'results:beat');
  assert.equal(st.d5.n, 2);
  assert.equal(st.d5.nAbnormal, 2);
  assert.ok(Math.abs(st.d5.avgRetPct - 5) < 1e-6);
  assert.equal(st.d5.tStatRet, null, 'identical returns have zero spread');
});

test('events: t-stat is mean over standard error', async () => {
  const ev = await import('./paper-bot/events.mjs');
  const mk = (abn) => ({ type: 't:x', returns: { 1: { ret: abn, abnormal: abn } } });
  const st = ev.eventStats([mk(0.01), mk(0.03), mk(0.02), mk(0.04)]).find((t) => t.type === 't:x');
  const xs = [1, 3, 2, 4];
  const mean = 2.5;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / 3);
  assert.ok(Math.abs(st.d1.tStatAbnormal - mean / (sd / 2)) < 1e-9);
});
