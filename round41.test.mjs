// Tests for Momentum 20 (ranking, ETF exclusion, month-ends, the monthly portfolio with costs and tax).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r41-'));
process.env.NSE_ETF_PATH = join(TMP, 'etfs.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const m = await import('./paper-bot/momentum.mjs');

const days = [];
for (let i = 0; i < 700; i++) {
  const d = new Date(Date.UTC(2023, 0, 2) + i * 86400000);
  if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
}
const series = (f) => days.map((date, i) => ({ date, open: f(i), close: f(i) }));

test('ETFs are not stocks', () => {
  for (const s of ['NIFTYBEES', 'LIQUIDCASE', 'LIQUID1', 'GOLDBEES', 'SETFNIF50', 'MON100']) assert.equal(m.isEtf(s), true, s);
  for (const s of ['SKYGOLD', 'RELIANCE', 'BANKBARODA', 'GOLDIAM', 'STLTECH']) assert.equal(m.isEtf(s), false, s);
});

test('month-ends and the two ranking methods', () => {
  assert.deepEqual(m.monthEnds(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-30', '2026-11-02']), ['2026-09-30', '2026-10-30', '2026-11-02']);
  const data = new Map([['FAST', series((i) => 100 * 1.004 ** i)], ['SLOW', series((i) => 100 * 1.001 ** i)], ['JUMPY', series((i) => 100 * 1.004 ** i * (1 + 0.08 * Math.sin(i)))], ['NIFTYBEES', series((i) => 100 * 1.01 ** i)]]);
  const idx = m.priceIndex(data);
  const a = m.scores(idx, [...data.keys()], days[480], 'a');
  assert.ok(!a.some((x) => x.symbol === 'NIFTYBEES'), 'ETF left out');
  assert.equal(a.at(-1).symbol, 'SLOW');
  const b = m.scores(idx, [...data.keys()], days[480], 'b');
  assert.equal(b[0].symbol, 'FAST', 'same trend, lower volatility ranks higher after the adjustment');
  assert.ok(b.find((x) => x.symbol === 'JUMPY').vol > b.find((x) => x.symbol === 'FAST').vol);
});

test('portfolio: monthly top-N, costs reduce the value, tax only on gains, a vanished stock is sold at its last price', () => {
  const names = ['A', 'B', 'C', 'D'];
  const data = new Map(names.map((s, k) => [s, series((i) => 100 * (1 + 0.0005 * (k + 1)) ** i)]));
  // D stops trading after day 500
  data.set('D', data.get('D').slice(0, 500));
  const idx = m.priceIndex(data);
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const universe = new Map(months.map((ym) => [ym, new Set(names)]));
  const r = { ...m.RULES, top: 2, from: '2024-02-01' };
  const free = m.simulate({ idx, universe, refDates: days, method: 'a', r: { ...r, costPct: 0, slipPct: 0 } });
  const cost = m.simulate({ idx, universe, refDates: days, method: 'a', r });
  const taxed = m.simulate({ idx, universe, refDates: days, method: 'a', r, tax: true });
  assert.ok(free.curve.at(-1).value > cost.curve.at(-1).value, 'costs reduce the result');
  assert.ok(cost.curve.at(-1).value > taxed.curve.at(-1).value, 'tax on the gains');
  assert.ok(taxed.taxPaid > 0);
  assert.ok(cost.lists.every((l) => l.symbols.length <= 2));
  assert.ok(cost.lists.filter((l) => l.entryDay > days[500]).every((l) => !l.symbols.includes('D')), 'not bought after it stopped trading');
  assert.ok(cost.cagr > 0);
});

test('evening note: Momentum 20 only on the month-end and on the first day of the new list', async () => {
  const { momentumLine } = await import('./paper-bot/evening.mjs');
  const mom = {
    capital: 100000,
    list: [{ symbol: 'A' }, { symbol: 'B' }],
    preview: { date: '2026-10-29', list: [{ symbol: 'A' }, { symbol: 'C' }] },
    rebalances: [],
  };
  assert.equal(momentumLine('2026-10-28', mom), null, 'an ordinary day: nothing');
  const end = momentumLine('2026-10-30', mom); // last trading day of October 2026
  assert.match(end.short, /month ends today/);
  assert.match(end.detail, /likely in: C · likely out: B/);
  assert.match(end.detail, /next open \(2026-11-02\)/);
  const first = momentumLine('2026-11-02', { ...mom, rebalances: [{ monthEnd: '2026-10-30', date: '2026-11-02', value: 100000, holdings: [{ symbol: 'A' }, { symbol: 'C' }] }] });
  assert.equal(first.short, 'Momentum 20: first list bought');
  const second = momentumLine('2026-12-01', { ...mom, rebalances: [{ date: '2026-11-02', holdings: [{ symbol: 'A' }, { symbol: 'C' }] }, { monthEnd: '2026-11-30', date: '2026-12-01', value: 104000, holdings: [{ symbol: 'A' }, { symbol: 'D' }] }] });
  assert.match(second.short, /1 in \/ 1 out/);
  assert.match(second.detail, /in D · out C · kept 1/);
  assert.match(second.detail, /₹52,000 each/);
});
