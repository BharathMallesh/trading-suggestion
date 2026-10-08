// Kronos / Chronos-Bolt bridge: probability conversion, live forecast shape
// and replay scoring with a stubbed worker (no Python, no network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-fm-'));
process.env.FOUNDATION_DIR = TMP;
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const fm = await import('./paper-bot/foundation.mjs');
const { probsFromPaths, cdfFromQuantiles, probsFromQuantiles, foundationForecast } = fm;

test('sampled paths → bucket shares that sum to 1', () => {
  const paths = [[103, 104], [102, 90], [100.1, 100], [97, 99]];
  const [s1, s2] = probsFromPaths(paths, 100, 1);
  assert.equal(s1.probUp, 0.5);
  assert.equal(s1.probDown, 0.25);
  assert.equal(s1.probSideways, 0.25);
  assert.ok(Math.abs(s2.probUp + s2.probDown + s2.probSideways - 1) < 1e-12);
  assert.ok(s1.lowPct < s1.medianPct && s1.medianPct < s1.highPct);
});

test('quantile CDF interpolates inside and extends (clamped) outside', () => {
  const levels = [0.1, 0.5, 0.9];
  const q = [90, 100, 110];
  assert.equal(cdfFromQuantiles(levels, q, 100), 0.5);
  assert.ok(Math.abs(cdfFromQuantiles(levels, q, 95) - 0.3) < 1e-12);
  assert.ok(Math.abs(cdfFromQuantiles(levels, q, 88) - 0.02) < 1e-12);
  assert.equal(cdfFromQuantiles(levels, q, 50), 0);
  assert.equal(cdfFromQuantiles(levels, q, 200), 1);
  const [p] = probsFromQuantiles(levels, [q], 100, 5);
  assert.ok(Math.abs(p.probUp - 0.3) < 1e-12 && Math.abs(p.probDown - 0.3) < 1e-12);
  assert.equal(p.medianPct, 0);
});

test('foundationForecast validates input and says which model produced it', async () => {
  await assert.rejects(() => foundationForecast({ symbol: 'X', model: 'gpt' }), /kronos or chronos/);
  await assert.rejects(() => foundationForecast({ symbol: 'X', model: 'kronos', loadCandles: async () => [] }), /Not enough/);
});
