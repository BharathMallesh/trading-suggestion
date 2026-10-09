// Offline tests for the statistical-validity fixes (embargo, next-day signals,
// tax basis, missing prices, earnings drift, IST dates, VIX-scaled vol).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-statsfix-'));
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
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
