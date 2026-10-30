// Tests for "Do this month" and its evening-note / alert lines.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r47-'));
process.env.MOMENTUM_PAPER_PATH = join(TMP, 'm20-paper.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
process.env.STEADY_MIX_PAPER_PATH = join(TMP, 'sm-paper.json');
process.env.INDIA_MIX_PAPER_PATH = join(TMP, 'im-paper.json');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const tm = await import('./paper-bot/this-month.mjs');

const m10 = {
  list: [{ symbol: 'A' }, { symbol: 'B' }],
  preview: { date: '2026-11-27', list: [{ symbol: 'A' }, { symbol: 'C' }] },
  rebalances: [{ monthEnd: '2026-10-30', date: '2026-11-02', bought: ['A', 'B'], sold: [], holdings: [{ symbol: 'A' }, { symbol: 'B' }] }],
};
const steady = { filter: { monthEnd: '2026-10-30', inMarket: false, today: true }, filterHistory: [{ date: '2026-11-04', today: false }, { date: '2026-11-05', today: true }], rebalances: [] };
const ist = (d, h = 12) => new Date(`${d}T${String(h - 5).padStart(2, '0')}:30:00Z`);

test('hold phase mid-month: plans scaled to the amount, likely changes and the filter flip are shown', () => {
  const r = tm.thisMonth({ now: ist('2026-11-11'), amount: 200000, m20: null, m10, steady });
  assert.equal(r.phase, 'hold');
  assert.equal(r.monthEnd, '2026-11-30');
  assert.equal(r.changeDay, '2026-12-01');
  const s = r.plans.find((p) => p.key === 'steady');
  assert.deepEqual(s.parts.map((x) => x.amount), [60000, 20000, 120000]);
  assert.match(s.parts[0].what, /filter OUT/);
  assert.match(s.next, /turn IN/);
  const m = r.plans.find((p) => p.key === 'm10');
  assert.equal(m.perStock, 20000);
  assert.deepEqual(m.hold, ['A', 'B']);
  assert.deepEqual(m.likelyIn, ['C']);
  assert.deepEqual(m.likelyOut, ['B']);
  assert.equal(r.plans.find((p) => p.key === 'm20').ready, false);
  const india = r.plans.find((p) => p.key === 'india');
  assert.deepEqual(india.parts.map((x) => Math.round(x.amount)), [66667, 66667, 66667]);
  assert.match(india.parts[2].what, /A, B/);
  assert.match(india.next, /swaps in C and out B/);
  assert.equal(r.filter.flipLikely, true);
});

test('change day and month-end are recognised', () => {
  assert.equal(tm.thisMonth({ now: ist('2026-11-02'), m20: null, m10, steady }).phase, 'change-day');
  assert.deepEqual(tm.thisMonth({ now: ist('2026-11-02'), m20: null, m10, steady }).plans.find((p) => p.key === 'm10').today.bought, ['A', 'B']);
  assert.equal(tm.thisMonth({ now: ist('2026-11-30'), m20: null, m10, steady }).phase, 'month-end');
});

test('alert lines only on the days that matter, including a market-filter cross', () => {
  assert.equal(tm.monthLines('2026-11-11', { m10, steady }).length, 0);
  const cross = tm.monthLines('2026-11-05', { m10, steady });
  assert.equal(cross.length, 1);
  assert.match(cross[0].short, /crossed above/);
  const end = tm.monthLines('2026-11-30', { m10, steady });
  assert.match(end.find((l) => l.title === 'Momentum 10').short, /month ends today \(≈1 changes/);
  assert.match(end.find((l) => l.title === 'Steady mix').short, /filter IN/);
  assert.match(tm.monthLines('2026-11-02', { m10, steady })[0].short, /first list bought/);
});
