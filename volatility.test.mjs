// Tests for volatility forecasting and the implied-vs-forecast check. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { qlike, FORECASTERS, volCheck, evaluateVolForecasts } = await import('./paper-bot/volatility.mjs');

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
  const nifty = series(400, 0.01);
  const vix = nifty.map((r) => ({ date: r.date, close: 20 })); // implied 20% > realised ~15.9%
  const load = async (s) => (s === '^INDIAVIX' ? vix : nifty);
  const r = await evaluateVolForecasts({ symbols: ['^NSEI'], loadCandles: load });
  assert.ok(r.summary.ewma.meanQlike < 0.05);
  assert.ok(r.niftyHeadToHead.indiaVix.n > 0);
  assert.equal(r.niftyImpliedVsRealised.pctTimeImpliedAbove, 100);
});
