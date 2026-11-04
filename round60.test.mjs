// Tests for "My F&O plan" and the plan rules in the spread paper tracker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r60-'));
process.env.SPREAD_PAPER_PATH = join(TMP, 'sp.json');
process.env.FO_BHAV_DIR = join(TMP, 'fo');
process.env.FO_STOCKS_DIR = join(TMP, 'fo-stocks');
process.env.BHAV_EQ_DIR = join(TMP, 'eq');
after(() => rmSync(TMP, { recursive: true, force: true }));
const sp = await import('./paper-bot/spread-paper.mjs');
const plan = await import('./paper-bot/fo-plan.mjs');

const closedTrade = (pnl, i) => ({ symbol: `S${i}`, open: false, pnl, cost: 2000, strategy: 'put-spread', lean: 'weak' });
const record = (pnls, extra = {}) => {
  const trades = pnls.map(closedTrade);
  const cash = 10000 + pnls.reduce((a, b) => a + b, 0);
  return { startedAt: '2026-11-04', rules: sp.RULES, cash, trades, summary: { value: cash }, curve: [{ date: '2026-11-05', value: cash }], ...extra };
};

test('practise until 20 closed trades', () => {
  const r = plan.foPlanFrom(record([500, -300, 200]));
  assert.equal(r.decision.status, 'practise');
  assert.match(r.decision.text, /3 of 20/);
});

test('at 30 trades: pass only if it made money AND beat holding NIFTY', () => {
  const win = Array.from({ length: 30 }, (_, i) => (i % 2 ? 400 : -200)); // +₹3,000
  assert.equal(plan.foPlanFrom(record(win), { niftyRet: 0.05 }).decision.status, 'go-small');
  assert.equal(plan.foPlanFrom(record(win), { niftyRet: 0.5 }).decision.status, 'stop', 'positive but behind NIFTY');
  const lose = Array.from({ length: 30 }, (_, i) => (i % 2 ? 100 : -200));
  assert.equal(plan.foPlanFrom(record(lose), { niftyRet: 0 }).decision.status, 'stop');
  assert.match(plan.foPlanFrom(record(lose), { niftyRet: 0 }).decision.text, /Momentum 10 or India mix/);
  assert.equal(plan.foPlanFrom(record(Array.from({ length: 22 }, () => 100)), { niftyRet: 0 }).decision.status, 'early-good');
});

test('a 30% fall stops the plan whatever the count', () => {
  const r = plan.foPlanFrom(record([-1000], { curve: [{ date: '2026-11-05', value: 10500 }, { date: '2026-11-20', value: 7000 }] }));
  assert.equal(r.decision.status, 'stop');
  assert.ok(Math.abs(plan.worstFall([{ value: 10500 }, { value: 7000 }], 10000) - 1 / 3) < 1e-9, 'from the high, not the start');
});

test('the checklist flags broken rules', () => {
  const st = record([], { trades: [{ symbol: 'A', open: true, cost: 2900, maxLoss: 3400, strategy: 'call-spread', lean: 'weak' }] });
  const r = plan.foPlanFrom(st, { today: { kinds: [{ kind: 'intraday', level: 'stay' }], signs: [{ text: 'VIX jumped' }] } });
  const bad = r.checklist.filter((c) => c.ok === false).map((c) => c.rule);
  assert.ok(bad.some((x) => /Most you can lose/.test(x)));
  assert.ok(bad.some((x) => /Calls only on STRONG/.test(x)));
  assert.ok(bad.some((x) => /STAY OUT/.test(x)));
});

// a put spread row for the tracker
const row = { symbol: 'AAA', lean: 'weak', kind: 'spread', strategy: 'put-spread', chanceOfProfit: 0.5, cost: 2000, maxLoss: 2050, maxProfit: 2000, lot: 100, expiry: '2026-11-24', spot: 100, date: '2026-11-04', sessions: 13, minVolume: 500,
  legs: [{ strike: 100, type: 'PE', side: 'buy', price: 30 }, { strike: 60, type: 'PE', side: 'sell', price: 10 }] };
const quiet = { fetchDay: async () => null, eqClose: () => null, loadCandles: async () => [] };
const EVENING = new Date('2026-11-04T15:00:00Z');

test('tracker: no new trade on a STAY OUT day, and the skip is recorded', async () => {
  const stay = async () => ({ asOf: '2026-11-04', kinds: [{ kind: 'intraday', level: 'stay' }], signs: [{ text: 'NIFTY fell 1.5% or more' }] });
  const { st, opened } = await sp.spreadPaperUpdate({ now: EVENING, pick: async () => ({ rows: [row] }), dayCheck: stay, ...quiet });
  assert.equal(opened, 0);
  assert.equal(st.skipped[0].date, '2026-11-04');
  assert.equal(st.curve.at(-1).date, '2026-11-04', 'the day\'s value is recorded');
});

test('tracker: opens on a normal day, and stops opening after a 30% fall', async () => {
  process.env.SPREAD_PAPER_PATH = join(TMP, 'sp2.json');
  const go = async () => ({ asOf: '2026-11-04', kinds: [{ kind: 'intraday', level: 'go' }], signs: [] });
  const { opened } = await sp.spreadPaperUpdate({ now: EVENING, pick: async () => ({ rows: [row] }), dayCheck: go, ...quiet });
  assert.equal(opened, 1);
  process.env.SPREAD_PAPER_PATH = join(TMP, 'sp3.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SPREAD_PAPER_PATH, JSON.stringify({ startedAt: '2026-11-01', rules: sp.RULES, cash: 6500, trades: [] }));
  const r = await sp.spreadPaperUpdate({ now: EVENING, pick: async () => ({ rows: [row] }), dayCheck: go, ...quiet });
  assert.equal(r.opened, 0);
  assert.equal(r.st.stopped.value, 6500);
});
