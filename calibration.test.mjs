// Tests for the replay harness (paper-bot/evaluate.mjs) and calibration tables
// (paper-bot/calibration.mjs). Offline: synthetic candles, mocked fetch, temp files.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-cal-'));
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { bucketIndex, intervalKey, fitBuckets, calibratedProbs, loadCalibration, SCORE_EDGES } = await import('./paper-bot/calibration.mjs');
const { evaluateModels, saveReport, brier, labelMove, buildSamples } = await import('./paper-bot/evaluate.mjs');
const { growwProbability } = await import('./paper-bot/groww-predict.mjs');
const { clearMarketCache } = await import('./market-data.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearMarketCache();
});

/** Deterministic pseudo-random walk candles. */
function walk(n, seed = 1, start = 100) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const rows = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = o * (1 + (rnd() - 0.5) * 0.03);
    rows.push({ date: `2024-${String(i).padStart(5, '0')}`, ts: 1_700_000_000 + i * 86400, open: o, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, close: c, volume: 1000 + Math.floor(rnd() * 500) });
  }
  return rows;
}

test('bucketIndex covers [-1, 1] with the declared edges', () => {
  assert.equal(bucketIndex(-1), 0);
  assert.equal(bucketIndex(0), 3);
  assert.equal(bucketIndex(0.99), SCORE_EDGES.length - 2);
  assert.equal(bucketIndex(1), SCORE_EDGES.length - 2);
  assert.equal(bucketIndex(5), SCORE_EDGES.length - 2); // clamped
});

test('intervalKey maps bar minutes to table keys', () => {
  assert.equal(intervalKey(5), '5m');
  assert.equal(intervalKey(15), '15m');
  assert.equal(intervalKey(60), '60m');
  assert.equal(intervalKey(1440), '1d');
});

test('Brier: perfect = 0, uniform = 2/3', () => {
  assert.equal(brier({ probUp: 1, probDown: 0, probSideways: 0 }, 'UP'), 0);
  assert.ok(Math.abs(brier({ probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 }, 'DOWN') - 2 / 3) < 1e-12);
});

test('labelMove uses max(0.15%, 0.35 × ATR%) like live scoring', () => {
  assert.equal(labelMove(0.1, 0, 100), 'SIDEWAYS');
  assert.equal(labelMove(0.2, 0, 100), 'UP');
  assert.equal(labelMove(0.5, 2, 100), 'SIDEWAYS'); // threshold 0.7%
  assert.equal(labelMove(-0.8, 2, 100), 'DOWN');
});

test('fitBuckets learns a real dependency and shrinks empty buckets to base rates', () => {
  const samples = [];
  for (let i = 0; i < 300; i++) samples.push({ score: 0.8, label: i % 10 < 8 ? 'UP' : 'DOWN' });
  for (let i = 0; i < 300; i++) samples.push({ score: -0.8, label: i % 10 < 8 ? 'DOWN' : 'UP' });
  const { buckets, climatology } = fitBuckets(samples);
  const hi = buckets[bucketIndex(0.8)];
  assert.ok(hi.probUp > 0.7, `strong-bull bucket UP ${hi.probUp}`);
  const empty = buckets[bucketIndex(0)];
  assert.equal(empty.n, 0);
  assert.ok(Math.abs(empty.probUp - climatology.probUp) < 1e-12);
  for (const b of buckets) assert.ok(Math.abs(b.probUp + b.probDown + b.probSideways - 1) < 1e-9);
});

test('buildSamples: label looks forward exactly `horizon` bars, score uses only the past', () => {
  const rows = walk(120);
  const s = buildSamples(rows, 4);
  assert.ok(s.length > 50);
  // Changing a bar far in the future must not change earlier scores (no look-ahead).
  const mutated = rows.map((r, i) => (i === 110 ? { ...r, close: r.close * 2, high: r.high * 2 } : r));
  const s2 = buildSamples(mutated, 4);
  for (let k = 0; k < s.length; k++) {
    if (s[k].date >= rows[106].date) break;
    assert.equal(s[k].score, s2[k].score);
  }
});

test('evaluateModels on a random walk: calibration fixes an overconfident formula, no fake skill', async () => {
  const series = { A: walk(700, 7), B: walk(700, 11), C: walk(700, 23) };
  const r = await evaluateModels({ interval: '1d', symbols: Object.keys(series), loadCandles: async (s) => series[s] });
  assert.deepEqual(r.symbols, ['A', 'B', 'C']);
  for (const m of ['uniform', 'climatology', 'persistence', 'current', 'calibrated']) {
    assert.ok(Number.isFinite(r.metrics[m].brier), m);
  }
  assert.ok(Math.abs(r.metrics.climatology.skillPct) < 1e-9);
  // On pure noise nothing should look meaningfully skilful out of sample.
  assert.ok(r.metrics.calibrated.skillPct < 3, `calibrated skill ${r.metrics.calibrated.skillPct}`);
  assert.equal(typeof r.useCalibrated, 'boolean');
  assert.equal(r.calibrationTable.buckets.length, SCORE_EDGES.length - 1);
});

test('evaluateModels rejects an unknown interval and too little data', async () => {
  await assert.rejects(() => evaluateModels({ interval: '3d' }), (e) => e.status === 400);
  await assert.rejects(
    () => evaluateModels({ interval: '1d', symbols: ['A'], loadCandles: async () => walk(80) }),
    (e) => e.status === 400 && /Not enough history/.test(e.message),
  );
});

test('saved calibration is used live only when it beat the formula', async () => {
  const series = { A: walk(700, 3), B: walk(700, 5) };
  const r = await evaluateModels({ interval: '1d', symbols: ['A', 'B'], loadCandles: async (s) => series[s] });
  saveReport({ ...r, useCalibrated: false });
  assert.equal(calibratedProbs('1d', 0.5), null);
  saveReport({ ...r, useCalibrated: true });
  const c = calibratedProbs('1d', 0.5);
  assert.ok(c && Math.abs(c.probs.probUp + c.probs.probDown + c.probs.probSideways - 1) < 1e-9);
  assert.equal(c.meta.key, '1d');
  assert.ok(loadCalibration()['1d'].fittedAt);
});

test('live Call/Put uses a saved 15m table for its primary window', async () => {
  // A distinctive table: every bucket says 10% / 20% / 70%.
  const buckets = SCORE_EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: SCORE_EDGES[i + 1], n: 99, probUp: 0.1, probDown: 0.2, probSideways: 0.7 }));
  writeFileSync(process.env.CALIBRATION_PATH, JSON.stringify({ '15m': { fittedAt: '2026-10-07T00:00:00Z', samples: 999, useCalibrated: true, buckets } }));
  const rows = walk(90, 9);
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ chart: { error: null, result: [{
      meta: { symbol: 'X.NS', gmtoffset: 19800 },
      timestamp: rows.map((r) => r.ts),
      indicators: { quote: [{ open: rows.map((r) => r.open), high: rows.map((r) => r.high), low: rows.map((r) => r.low), close: rows.map((r) => r.close), volume: rows.map((r) => r.volume) }] },
    }] } }),
    text: async () => '',
  });
  const out = await growwProbability('X.NS', { mode: '15m', intervalMinutes: 15, preferYahoo: true }); // no API key → base only
  assert.equal(out.hybrid.calibration.windowsCalibrated, 1);
  assert.ok(Math.abs(out.prediction.probSideways - 0.7) < 1e-9);
  assert.equal(out.prediction.bias, 'SIDEWAYS');
});
