// Tests for volatility forecasting and the implied-vs-forecast check. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TMP = mkdtempSync(join(tmpdir(), 'trading-vol-'));
process.env.VOL_MODEL_PATH = join(TMP, 'vol-model.json');
const { after } = await import('node:test');
after(() => rmSync(TMP, { recursive: true, force: true }));
const { qlike, FORECASTERS, volCheck, evaluateVolForecasts, garchForecast, harForecast, saveVolModel } = await import('./paper-bot/volatility.mjs');

/** Closes with constant daily vol `s` (alternating ±s log moves). */
const series = (n, s, start = 100) => {
  const rows = [];
  let c = start;
  const t0 = Date.parse('2021-01-01');
  for (let i = 0; i < n; i++) {
    c *= Math.exp(i % 2 ? s : -s);
    rows.push({ date: new Date(t0 + i * 86400000).toISOString().slice(0, 10), close: c, open: c, high: c, low: c });
  }
  return rows;
};

test('QLIKE is 0 for a perfect forecast and positive otherwise', () => {
  assert.equal(qlike(0.0004, 0.0004), 0);
  assert.ok(qlike(0.0004, 0.0001) > 0 && qlike(0.0001, 0.0004) > 0);
  assert.equal(qlike(0, 1), null);
});

test('forecasters recover a constant daily vol', () => {
  const closes = series(300, 0.01).map((r) => r.close);
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  for (const k of ['rv20', 'rv60', 'ewma']) assert.ok(Math.abs(FORECASTERS[k](r) - 0.01) < 0.001, k);
});

test('volCheck: India VIX for NIFTY, user IV for stocks, and a reading', async () => {
  const load = async (s) => (s === '^INDIAVIX' ? [{ date: '2026-10-08', close: 32 }] : series(260, 0.01));
  const n = await volCheck({ symbol: 'NIFTY', days: 7, loadCandles: load });
  assert.equal(n.symbol, '^NSEI');
  assert.equal(n.impliedSource, 'India VIX');
  assert.ok(Math.abs(n.forecastPct - 15.87) < 1); // 1% daily ≈ 15.9% annual
  assert.match(n.reading, /above the forecast/); // 32% vs ~16%
  const s = await volCheck({ symbol: 'TCS.NS', iv: 10, days: 7, loadCandles: load });
  assert.match(s.reading, /below the forecast/);
  const none = await volCheck({ symbol: 'TCS.NS', days: 7, loadCandles: load });
  assert.match(none.reading, /Enter the option/);
  await assert.rejects(() => volCheck({ symbol: 'TCS.NS', iv: 999, loadCandles: load }), /between 0 and 300/);
  await assert.rejects(() => volCheck({ symbol: 'TCS.NS', days: 0, loadCandles: load }), /1–365/);
});

test('replay scores forecasters and the NIFTY implied-vs-realised gap', async () => {
  const nifty = series(700, 0.01);
  const vix = nifty.map((r) => ({ date: r.date, close: 20 })); // implied 20% > realised ~15.9%
  const load = async (s) => (s === '^INDIAVIX' ? vix : nifty);
  const r = await evaluateVolForecasts({ symbols: ['^NSEI'], loadCandles: load });
  assert.ok(r.summary.ewma.meanQlike < 0.05);
  assert.ok(r.niftyHeadToHead.indiaVix.n > 0);
  assert.equal(r.niftyImpliedVsRealised.pctTimeImpliedAbove, 100);
});

test('GARCH and HAR recover a constant daily vol', () => {
  // Random returns with a true daily sd of 1% (sum of 12 uniforms ≈ normal).
  let seed = 11;
  const u = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = Array.from({ length: 800 }, () => 0.01 * (Array.from({ length: 12 }, u).reduce((a, b) => a + b, 0) - 6));
  assert.ok(Math.abs(garchForecast(r, 5) - 0.01) < 0.0015, `garch ${garchForecast(r, 5)}`);
  assert.ok(Math.abs(harForecast(r, 5) - 0.01) < 0.002, `har ${harForecast(r, 5)}`);
  assert.equal(harForecast(r.slice(0, 100), 5), null);
});

test('GARCH forecast mean-reverts after a volatility burst', () => {
  const calm = Array.from({ length: 600 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  const burst = [...calm, 0.05, -0.05, 0.04];
  assert.ok(garchForecast(burst, 1) > garchForecast(burst, 60), 'short-horizon vol above long-horizon after a shock');
});

test('saved model drives live choice; NIFTY reading uses VIX\'s usual premium; results add-on widens', async () => {
  saveVolModel({
    horizon: 5,
    summary: { ewma: { meanQlike: 0.6 }, har: { meanQlike: 0.5 } },
    niftyHeadToHead: { ewma: { meanQlike: 0.4 }, blend: { meanQlike: 0.45 } },
    niftyImpliedVsRealised: { avgImpliedPct: 15, avgRealisedPct: 12 },
  });
  const load = async (s) => (s === '^INDIAVIX' ? [{ date: '2026-10-08', close: 19.5 }] : series(900, 0.01));
  const n = await volCheck({ symbol: '^NSEI', days: 7, loadCandles: load });
  assert.equal(n.model, 'ewma');
  assert.ok(Math.abs(n.typicalRatio - 1.25) < 1e-9);
  assert.match(n.reading, /in line with its usual premium/); // ~19.5 vs ~15.9 → ×1.23
  const plain = await volCheck({ symbol: 'TCS.NS', iv: 30, days: 7, loadCandles: load });
  const event = await volCheck({ symbol: 'TCS.NS', iv: 30, days: 7, eventPending: true, loadCandles: load });
  assert.equal(plain.model, 'har');
  assert.ok(event.forecastPct > plain.forecastPct && event.eventAddOnPct > 0);
});
