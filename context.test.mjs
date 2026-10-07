// Tests for the context features (paper-bot/features.mjs), the logistic
// context model (paper-bot/context-model.mjs), and their use in the replay
// harness and live predictions. Offline: synthetic candles, temp files.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-ctx-'));
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { prepare, featuresAt, inResultsSeason, isIndianListing, ALL_FEATURES, MARKET_INDEX, VIX_INDEX } = await import('./paper-bot/features.mjs');
const { fitLogistic, predictLogistic, moveOnly } = await import('./paper-bot/context-model.mjs');
const { evaluateModels, saveReport } = await import('./paper-bot/evaluate.mjs');
const { contextProbs } = await import('./paper-bot/groww-predict.mjs');
const { clearMarketCache } = await import('./market-data.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearMarketCache();
});

function walk(n, seed = 1, start = 100, t0 = 1_700_000_000, step = 86400) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const rows = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = o * (1 + (rnd() - 0.5) * 0.03);
    const ts = t0 + i * step;
    rows.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), ts, open: o, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, close: c, volume: 1000 + Math.floor(rnd() * 500) });
  }
  return rows;
}

test('results season covers Jan/Apr/Jul/Oct 10th → mid next month', () => {
  assert.equal(inResultsSeason('2026-10-12'), 1);
  assert.equal(inResultsSeason('2026-11-15'), 1);
  assert.equal(inResultsSeason('2026-11-16'), 0);
  assert.equal(inResultsSeason('2026-10-05'), 0);
  assert.equal(inResultsSeason('2026-03-20'), 0);
});

test('context model applies to Indian listings only', () => {
  assert.equal(isIndianListing('TCS.NS'), true);
  assert.equal(isIndianListing('RELIANCE.BO'), true);
  assert.equal(isIndianListing('AAPL'), false);
  assert.equal(isIndianListing('^NSEI'), false);
});

test('featuresAt returns every feature, finite, and null without market context', () => {
  const rows = walk(200, 3);
  const prep = prepare(rows, { index: walk(200, 5, 20000), vix: walk(200, 7, 14) });
  const f = featuresAt(prep, 150);
  assert.deepEqual(Object.keys(f).sort(), [...ALL_FEATURES].sort());
  for (const k of ALL_FEATURES) assert.ok(Number.isFinite(f[k]), k);
  assert.equal(featuresAt(prepare(rows, {}), 150), null);
});

test('featuresAt uses no future information', () => {
  const rows = walk(200, 3);
  const index = walk(200, 5, 20000);
  const vix = walk(200, 7, 14);
  const before = featuresAt(prepare(rows, { index, vix }), 150);
  const bump = (r, i) => (i > 150 ? { ...r, open: r.open * 3, high: r.high * 3, low: r.low * 3, close: r.close * 3 } : r);
  const after = featuresAt(prepare(rows.map(bump), { index: index.map(bump), vix: vix.map(bump) }), 150);
  assert.deepEqual(after, before);
});

test('fitLogistic learns a planted pattern and outputs valid probabilities', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 600; i++) {
    const a = (i % 7) / 3 - 1; // feature that decides the class
    const b = ((i * 13) % 11) / 5 - 1; // noise feature
    X.push([a, b]);
    y.push(a > 0.4 ? 'UP' : a < -0.4 ? 'DOWN' : 'SIDEWAYS');
  }
  const m = fitLogistic(X, y, { iters: 600 });
  const hi = predictLogistic(m, [1, 0]);
  const lo = predictLogistic(m, [-1, 0]);
  const mid = predictLogistic(m, [0, 0]);
  assert.ok(hi.probUp > 0.6 && lo.probDown > 0.6 && mid.probSideways > 0.5);
  for (const p of [hi, lo, mid]) assert.ok(Math.abs(p.probUp + p.probDown + p.probSideways - 1) < 1e-9);
});

test('moveOnly keeps the sideways chance and the up/down ratio', () => {
  const p = moveOnly({ probUp: 0.1, probDown: 0.6, probSideways: 0.3 }, { probUp: 0.3, probDown: 0.3, probSideways: 0.4 });
  assert.ok(Math.abs(p.probSideways - 0.3) < 1e-12);
  assert.ok(Math.abs(p.probUp - 0.35) < 1e-12 && Math.abs(p.probDown - 0.35) < 1e-12);
});

test('harness runs the context ablation for Indian symbols and reports direction skill', async () => {
  const data = { 'A.NS': walk(700, 11), 'B.NS': walk(700, 13), [MARKET_INDEX]: walk(700, 17, 20000), [VIX_INDEX]: walk(700, 19, 14) };
  const r = await evaluateModels({ interval: '1d', symbols: ['A.NS', 'B.NS'], loadCandles: async (s) => data[s] });
  assert.equal(r.contextEnabled, true);
  assert.deepEqual(r.ablation.map((a) => a.group), ['tech', 'stock', 'market', 'vix', 'session']);
  for (const m of ['context', 'contextMove']) assert.ok(Number.isFinite(r.metrics[m].brier), m);
  for (const m of Object.keys(r.metrics)) assert.ok(Number.isFinite(r.metrics[m].directionSkillPct), m);
  assert.ok(r.stability && Number.isFinite(r.stability.gainFirstHalf));
  assert.equal(r.contextModel.features.length, ALL_FEATURES.length);
});

test('harness skips the context model for non-Indian symbols, with a note', async () => {
  const data = { AAPL: walk(700, 11), MSFT: walk(700, 13) };
  const r = await evaluateModels({ interval: '1d', symbols: ['AAPL', 'MSFT'], loadCandles: async (s) => data[s] });
  assert.equal(r.contextEnabled, false);
  assert.match(r.contextNote, /NSE\/BSE/);
  assert.equal(r.metrics.context, undefined);
});

test('contextProbs: used for Indian listings with a validated model, otherwise null', async () => {
  const data = { 'A.NS': walk(700, 11), 'B.NS': walk(700, 13), [MARKET_INDEX]: walk(700, 17, 20000), [VIX_INDEX]: walk(700, 19, 14) };
  const r = await evaluateModels({ interval: '1d', symbols: ['A.NS', 'B.NS'], loadCandles: async (s) => data[s] });
  const rows = data['A.NS'];
  const payload = (series) => ({ chart: { error: null, result: [{ meta: { symbol: 'X', gmtoffset: 0 }, timestamp: series.map((x) => x.ts),
    indicators: { quote: [{ open: series.map((x) => x.open), high: series.map((x) => x.high), low: series.map((x) => x.low), close: series.map((x) => x.close), volume: series.map((x) => x.volume) }] } }] } });
  globalThis.fetch = async (url) => ({ ok: true, status: 200, statusText: 'OK', text: async () => '',
    json: async () => payload(String(url).includes('INDIAVIX') ? data[VIX_INDEX] : data[MARKET_INDEX]) });

  saveReport({ ...r, useContext: false, contextMode: null });
  assert.equal(await contextProbs('1d', rows, 'A.NS', { range: '5y', interval: '1d' }), null);

  saveReport({ ...r, useContext: true, contextMode: 'move' });
  const c = await contextProbs('1d', rows, 'A.NS', { range: '5y', interval: '1d' });
  assert.ok(c, 'expected context probabilities');
  assert.match(c.meta.key, /1d\/context-move/);
  assert.ok(Math.abs(c.probs.probUp + c.probs.probDown + c.probs.probSideways - 1) < 1e-9);
  assert.equal(await contextProbs('1d', rows, 'AAPL', { range: '5y', interval: '1d' }), null);
});
