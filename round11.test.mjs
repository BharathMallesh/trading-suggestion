// Tests for: My portfolio (lots, tax with set-off, LTCG harvesting with FIFO,
// loss harvesting, analysis with stub prices), the 25-year trend test, live
// scoring horizon helpers, explicit-date market data, NSE industries, and the
// VIX-family forecast choice. Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r11-'));
process.env.HOLDINGS_PATH = join(TMP, 'holdings.json');
process.env.BIG_MOVE_PATH = join(TMP, 'bm.json');
process.env.INDEX_LIST_DIR = TMP;
after(() => rmSync(TMP, { recursive: true, force: true }));

const h = await import('./paper-bot/holdings.mjs');
const th = await import('./paper-bot/trend-history.mjs');
const { nseOpen, sessionComplete } = await import('./paper-bot/prediction-log.mjs');
const { parseIndexIndustries } = await import('./paper-bot/ranking.mjs');
const { fetchChart } = await import('./market-data.mjs');
const { volCheck } = await import('./paper-bot/volatility.mjs');

const today = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
const yearsAgo = (y, extraDays = 0) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() - extraDays);
  return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------- holdings

test('addLot validates input and normalises symbols', () => {
  assert.throws(() => h.addLot({ symbol: 'TCS', qty: 1.5, price: 10, date: '2024-01-01' }), /whole number/);
  assert.throws(() => h.addLot({ symbol: 'TCS', qty: 1, price: -1, date: '2024-01-01' }), /positive/);
  assert.throws(() => h.addLot({ symbol: 'TCS', qty: 1, price: 1, date: '2999-01-01' }), /future/);
  assert.throws(() => h.addLot({ symbol: 'bad sym!', qty: 1, price: 1, date: '2024-01-01' }), /Symbol/);
  const l = h.addLot({ symbol: 'tcs', qty: 2, price: 100, date: '2024-01-01' });
  assert.equal(l.symbol, 'TCS.NS');
  h.removeLot(l.id);
  assert.throws(() => h.removeLot('nope'), /No lot/);
});

test('tax with set-off: long-term losses cannot offset short-term gains', () => {
  const lots = [{ symbol: 'L.NS', qty: 10, price: 200, date: yearsAgo(2) }]; // long-term, at a loss
  const prices = { 'L.NS': 100 };
  const realized = { stcg: 10000, ltcg: 0 };
  const booked = h.taxWith(lots, [], prices, realized, today);
  assert.ok(Math.abs(booked - 10000 * 0.2 * 1.04) < 1e-6);
  assert.ok(Math.abs(h.taxWith(lots, lots, prices, realized, today) - booked) < 1e-6, 'LT loss does not touch STCG');
  // ...but a short-term loss does
  const st = [{ symbol: 'S.NS', qty: 10, price: 200, date: today }];
  assert.ok(h.taxWith(st, st, { 'S.NS': 100 }, realized, today) < booked);
});

test('LTCG harvest: FIFO, stops at a short-term lot, fills the remaining exemption', () => {
  const lots = [
    { id: 'a', symbol: 'A.NS', qty: 100, price: 100, date: yearsAgo(3) },
    { id: 'b', symbol: 'A.NS', qty: 100, price: 50, date: today }, // short-term: can't be reached
    { id: 'c', symbol: 'B.NS', qty: 1000, price: 100, date: yearsAgo(2) },
  ];
  const prices = { 'A.NS': 300, 'B.NS': 200 };
  const p = h.harvestPlan(lots, prices, 50000);
  const a = p.sells.find((s) => s.symbol === 'A.NS');
  assert.ok(!a || a.qty <= 100, 'never reaches the short-term lot');
  assert.ok(p.harvested <= 50000 + 1e-6 && p.harvested > 49000);
  assert.ok(Math.abs(p.taxSaved - p.harvested * 0.125 * 1.04) < 1e-6);
  assert.ok(p.netBenefit < p.taxSaved, 'charges deducted');
  assert.equal(h.harvestPlan(lots, prices, 0).sells.length, 0);
});

test('analyzeHoldings: totals, flags, risk and crisis scenarios from stub prices', async () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const mk = (base, vol) => {
    let p = base;
    return Array.from({ length: 6900 }, (_, i) => ({ date: new Date(Date.UTC(2007, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: (p *= 1 + rnd() * vol) }))
      .filter((r) => r.date <= today);
  };
  const series = { 'X.NS': mk(100, 0.03), 'Y.NS': mk(50, 0.02), '^NSEI': mk(10000, 0.02) };
  const load = async (s) => series[s] || [];
  const last = (s) => series[s][series[s].length - 1].close;
  h.addLot({ symbol: 'X', qty: 100, price: last('X.NS') * 0.8, date: yearsAgo(2) });
  h.addLot({ symbol: 'Y', qty: 10, price: last('Y.NS') * 1.2, date: today });
  h.setRealized({ stcg: 0, ltcg: 30000 });
  const a = await h.analyzeHoldings({ loadCandles: load });
  assert.ok(Math.abs(a.totals.value - (100 * last('X.NS') + 10 * last('Y.NS'))) < 1e-6);
  assert.equal(a.harvest.remaining, 125000 - 30000);
  assert.ok(a.flags.some((f) => f.startsWith('X.NS')), 'X dominates the portfolio');
  assert.ok(a.risk && a.risk.typicalDay.rupees > 0 && a.risk.weeklyLossOdds.length === 3);
  assert.equal(a.scenarios.length, h.CRISIS_SCENARIOS.length);
  assert.ok(a.lots.find((l) => l.symbol === 'Y.NS').term === 'short');
});

// ------------------------------------------------------- trend history

test('crisis window stats and coverage rule', () => {
  const curve = Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), equity: i < 50 ? 100 - i : 50 + (i - 50) }));
  const w = th.windowStats(curve, '2020-01-01', '2020-04-09');
  assert.ok(Math.abs(w.maxDrawdownPct - 50) < 1e-9); // 100 → 50 at the turn
  assert.equal(th.windowStats(curve, '2021-01-01', '2021-02-01'), null);
  // falling index: the filter steps aside; crises before the 200-day warm-up are skipped
  const rows = Array.from({ length: 1500 }, (_, i) => ({ date: new Date(Date.UTC(2009, 0, 1) + i * 86400000 * 1.4).toISOString().slice(0, 10), close: 10000 * (i < 900 ? 1 + i / 900 : 2 - (i - 900) / 700) }));
  const x = th.analyseIndex('Synthetic', rows);
  assert.ok(x.partialCrisesSkipped.every((n) => typeof n === 'string'));
  assert.ok(x.crises.every((c) => c.from >= x.testedFrom));
});

// --------------------------------------------- scoring horizon helpers

test('NSE session helpers use IST', () => {
  assert.equal(nseOpen(new Date('2026-10-09T05:00:00Z')), true); // Fri 10:30 IST
  assert.equal(nseOpen(new Date('2026-10-09T11:00:00Z')), false); // 16:30 IST
  assert.equal(nseOpen(new Date('2026-10-10T05:00:00Z')), false); // Saturday
  assert.equal(sessionComplete('2026-10-09', Date.parse('2026-10-09T09:00:00Z')), false); // 14:30 IST
  assert.equal(sessionComplete('2026-10-09', Date.parse('2026-10-09T10:10:00Z')), true); // 15:40 IST
  assert.equal(sessionComplete('2026-10-08', Date.parse('2026-10-09T03:00:00Z')), true);
});

// ------------------------------------------------- data plumbing

test('explicit dates replace range in the chart URL', async () => {
  const real = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}] } }] } }) };
  };
  try {
    await fetchChart('^BSESN', { period1: 868000000, interval: '1d' });
    assert.match(url, /period1=868000000&period2=\d+/);
    assert.doesNotMatch(url, /range=/);
  } finally {
    globalThis.fetch = real;
  }
});

test('NSE index CSV industries', () => {
  const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\nReliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018\nTCS,Information Technology,TCS,EQ,X\n';
  assert.deepEqual(parseIndexIndustries(csv), { 'RELIANCE.NS': 'Oil Gas & Consumable Fuels', 'TCS.NS': 'Information Technology' });
  assert.deepEqual(parseIndexIndustries('Symbol\nA\n'), {});
});

test('NIFTY uses VIX-scaled when any VIX-family model wins the head-to-head', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: 20000 * Math.exp(0.01 * Math.sin(i)) }));
  const load = async (s) => (s === '^INDIAVIX' ? [{ date: '2026-10-08', close: 15 }] : rows);
  const base = { bestNifty: 'blend', niftyTypicalRatio: 1.25 };
  for (const winner of ['indiaVix', 'vixScaled', 'blendVix']) {
    const h2h = { blend: { meanQlike: 0.5 }, indiaVix: { meanQlike: winner === 'indiaVix' ? 0.3 : 0.4 }, vixScaled: { meanQlike: winner === 'vixScaled' ? 0.3 : 0.4 }, blendVix: { meanQlike: winner === 'blendVix' ? 0.3 : 0.4 } };
    const r = await volCheck({ symbol: '^NSEI', days: 7, loadCandles: load, model: { ...base, niftyHeadToHead: h2h } });
    assert.equal(r.model, 'vixScaled', winner);
    assert.ok(Math.abs(r.forecastPct - 12) < 1e-9);
  }
  const hist = await volCheck({ symbol: '^NSEI', days: 7, loadCandles: load, model: { ...base, niftyHeadToHead: { blend: { meanQlike: 0.2 }, vixScaled: { meanQlike: 0.4 } } } });
  assert.equal(hist.model, 'blend');
});
