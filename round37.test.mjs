// Tests for the core + satellite paper account (80% index fund + 20% swing vs 100% NIFTY).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r37-'));
process.env.CORE_SAT_PATH = join(TMP, 'cs.json');
process.env.ATH_SWING_PATH = join(TMP, 'ath-swing.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const c = await import('./paper-bot/core-satellite.mjs');

test('worst fall and the mixes add up', () => {
  assert.ok(Math.abs(c.worstFall([100, 110, 99, 120]) - 0.1) < 1e-12);
  const nifty = [{ date: 'd1', close: 100 }, { date: 'd2', close: 110 }, { date: 'd3', close: 99 }];
  const sat = new Map([['d2', 1.2]]);
  const rows = c.combine({ nifty, satellite: sat, capital: 100000 });
  assert.ok(Math.abs(rows[0].nifty - 100000 * (1 - 0.0005)) < 1e-6, 'buy cost on day 1');
  assert.ok(Math.abs(rows[1].m80 - 100000 * (0.8 * 1.1 * 0.9995 + 0.2 * 1.2)) < 1e-6);
  assert.equal(rows[2].satellite, 1.2, 'satellite carried forward on days without a point');
  assert.ok(Math.abs(rows[2].m50 - 100000 * (0.5 * 0.99 * 0.9995 + 0.5 * 1.2)) < 1e-6);
});

test('paper account from the swing record and NIFTY (injected data)', async () => {
  const day = (i) => new Date(Date.UTC(2026, 9, 14) + i * 86400000).toISOString().slice(0, 10);
  const series = (f) => Array.from({ length: 10 }, (_, i) => ({ date: day(i), open: f(i), high: f(i), low: f(i), close: f(i) }));
  const loadCandles = async (s) => (s === '^NSEI' ? series((i) => 25000 + i * 50) : series((i) => 100 + i));
  const swing = { startedAt: day(0), trades: [{ symbol: 'A.NS', version: 'original', setup: 'flag breakout', entryDate: day(1), exitDate: day(9), entry: 101, exit: 109, retPct: 0.07, riskPct: 0.05, r: 1.4, open: true, days: 8 }] };
  const r = await c.coreSatellite({ loadCandles, swing, capital: 100000, now: new Date('2026-10-30T12:00:00Z') });
  assert.equal(r.startedAt, day(0));
  assert.deepEqual(r.mixes.map((m) => m.key), ['m80', 'm50', 'nifty']);
  const n = r.mixes.find((m) => m.key === 'nifty');
  assert.ok(n.returnPct > 1.5 && n.returnPct < 2, 'NIFTY 25,000 → 25,450 less the buy cost');
  assert.ok(r.swingSlice.returnPct > 0, 'the one swing trade gained');
  assert.equal(r.swingSlice.positions.length, 1);
  assert.equal(await c.coreSatellite({ loadCandles, swing: null }), null);
});
