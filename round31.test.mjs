// Tests for the swing portfolio valued at every close (worst fall includes open positions)
// and the "wide trail" paper version (5 ATR trail, 1.5% risk, up to 20 positions).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r31-'));
process.env.ATH_SWING_PATH = join(TMP, 'ath-swing.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const a = await import('./paper-bot/ath-swing.mjs');
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const days = Array.from({ length: 120 }, (_, i) => day(i));

test('wide trail version: 5 ATR, 1.5% risk, 20 positions on top of the rules in use', () => {
  assert.deepEqual(a.WIDE, { chandelierAtr: 5, riskPct: 1.5, maxOpen: 20 });
  const w = a.wideRules({ ...a.RULES, chandelierAtr: 4, stopAtr: 1 });
  assert.equal(w.chandelierAtr, 5);
  assert.equal(w.riskPct, 1.5);
  assert.equal(w.stopAtr, 1, 'other rules kept');
});

test('portfolio valued at every close: a loss on an open position shows in the worst fall', () => {
  // one trade: bought at 100 on day 10, falls to 70 by day 40, recovers and is sold at 110 on day 100
  const px = (i) => (i <= 10 ? 100 : i <= 40 ? 100 - (i - 10) : i <= 100 ? 70 + (i - 40) * (40 / 60) : 110);
  const closes = new Map(days.map((d, i) => [d, px(i)]));
  const t = { symbol: 'A', entryDate: day(10), exitDate: day(100), entry: 100, retPct: 0.1, riskPct: 0.05, r: 2, open: false };
  const r = { ...a.RULES, riskPct: 20, maxPositionPct: 100 }; // whole capital in the one position
  const atCost = a.portfolio([t], r);
  const daily = a.portfolio([t], r, { closes: () => closes, days });
  assert.ok(Math.abs(atCost.finalEquity - daily.finalEquity) < 1e-6, 'same trades, same money at the end');
  const dd = (curve) => { let pk = -Infinity; let m = 0; for (const p of curve) { pk = Math.max(pk, p.equity); m = Math.max(m, 1 - p.equity / pk); } return m; };
  assert.ok(dd(atCost.curve) < 0.01, 'valued at cost the fall is invisible');
  assert.ok(dd(daily.curve) > 0.25 && dd(daily.curve) < 0.35, 'valued daily: the ~30% fall shows');
  assert.equal(daily.curve.length, 91, 'one point per trading day from entry to exit');
});

test('portfolio valued daily: year-end values come from the closes', () => {
  const ds = Array.from({ length: 500 }, (_, i) => day(i));
  const closes = new Map(ds.map((d, i) => [d, 100 * (1 + i / 1000)]));
  const t = { symbol: 'A', entryDate: ds[5], exitDate: ds[480], entry: 100, retPct: 0.475, riskPct: 0.05, r: 9, open: false };
  const p = a.portfolio([t], { ...a.RULES, riskPct: 20, maxPositionPct: 100 }, { closes: () => closes, days: ds });
  assert.ok(p.yearEquity['2025'] > a.RULES.capital * 1.3, 'the position\'s gain by 31 Dec is counted');
});

test('survivorship run: wide version, after-tax and NIFTY comparison', () => {
  const ds = Array.from({ length: 900 }, (_, i) => day(i));
  const rows = ds.map((date, i) => ({ date, open: 100 + i * 0.2, high: 100 + i * 0.2 + 1, low: 100 + i * 0.2 - 1, close: 100 + i * 0.2 + 0.1, val: 1e9 }));
  const universe = new Map([...new Set(ds.map((x) => x.slice(0, 7)))].map((m) => [m, new Set(['UP'])]));
  const market = new Map(ds.map((d) => [d, true]));
  const nifty = ds.map((date, i) => ({ date, close: 10000 * (1 + i / 3000) }));
  const r = a.survivorshipRun(new Map([['UP', rows]]), universe, market, { testFrom: '2024-01-01', rulesList: { original: a.RULES, wide: a.wideRules(a.RULES) }, nifty, splitYear: '2025-01-01' });
  assert.ok(r.results.wide);
  assert.equal(r.results.wide.rules.chandelierAtr, 5);
  for (const k of ['original', 'wide']) {
    assert.ok('portfolioCagrAfterTax' in r.results[k]);
    assert.ok('halves' in r.results[k]);
  }
  if (r.index) {
    assert.ok(r.index.cagr > 0);
    assert.ok(r.index.cagrAfterTax <= r.index.cagr);
  }
});
