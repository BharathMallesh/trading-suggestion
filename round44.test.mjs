// Tests for the new-ideas study (low volatility, momentum + calm, market filter).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r44-'));
process.env.NEW_IDEAS_PATH = join(TMP, 'ideas.json');
process.env.NSE_ETF_PATH = join(TMP, 'etfs.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const ni = await import('./paper-bot/new-ideas.mjs');
const { priceIndex, simulate } = await import('./paper-bot/momentum.mjs');

// trading days for ~2 years
const days = [];
for (let t = Date.UTC(2020, 0, 1); days.length < 520; t += 86400000) {
  const d = new Date(t);
  if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
}
// CALM rises smoothly; WILD rises faster but swings ±4% every day
const series = new Map([
  ['CALM', days.map((date, i) => ({ date, open: 100 * 1.0004 ** i, close: 100 * 1.0004 ** i }))],
  ['WILD', days.map((date, i) => ({ date, open: 100 * 1.001 ** i * (i % 2 ? 1.04 : 0.96), close: 100 * 1.001 ** i * (i % 2 ? 1.04 : 0.96) }))],
]);
const idx = priceIndex(series);
const universe = new Map();
for (const d of days) universe.set(d.slice(0, 7), new Set(['CALM', 'WILD']));

test('low volatility ranks the calm stock first; the blend weighs both strength and calmness', () => {
  const me = days[400];
  assert.equal(ni.lowVol(idx, ['CALM', 'WILD'], me)[0].symbol, 'CALM');
  const blend = ni.momLowVolBlend(idx, ['CALM', 'WILD'], me);
  assert.equal(blend.length, 2);
  assert.ok(blend.every((x) => Number.isFinite(x.score)));
  assert.equal(ni.momThenLowVol(1)(idx, ['CALM', 'WILD'], me).length, 1);
});

test('trend gate: out below the 200-day average minus the band, back in above it plus the band, unchanged inside', () => {
  const up = Array.from({ length: 250 }, (_, i) => ({ date: days[i], close: 100 + i }));
  const fall = [...up, ...Array.from({ length: 60 }, (_, i) => ({ date: days[250 + i], close: 300 - i * 3 }))];
  const g = ni.trendGate(fall);
  assert.equal(g(days[249]), true);
  assert.equal(g(days[309]), false);
  const g2 = ni.trendGate(up);
  assert.equal(g2(days[100]), true); // not enough history: stays in
});

test('a closed gate holds the liquid fund: value grows only by the cash yield, no stocks held', () => {
  const r = { top: 1, costPct: 0.25, slipPct: 0.1, cashYield: 0.05, from: days[300] };
  const out = simulate({ idx, universe, refDates: days, r, from: days[300], rank: ni.lowVol, gate: () => false });
  assert.ok(out.lists.every((l) => l.symbols.length === 0));
  const last = out.curve[out.curve.length - 1].value;
  assert.ok(last > 1 && last < 1.05, `cash only, got ${last}`);
  const inMkt = simulate({ idx, universe, refDates: days, r, from: days[300], rank: ni.lowVol });
  assert.ok(inMkt.lists.some((l) => l.symbols[0] === 'CALM'));
});
