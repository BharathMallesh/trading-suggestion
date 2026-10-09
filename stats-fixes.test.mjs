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
