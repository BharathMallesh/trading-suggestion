// Tests for "Trade today?" (Go / Be careful / Stay out from warning signs known at the last close).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tt = await import('./paper-bot/trade-today.mjs');

// 400 calm, rising sessions ending on a Tuesday, then a last day that can be shocked
function series({ lastMove = 0.002, lastRange = 0.01, vixLast = 13, vixPrev = 13 } = {}) {
  const N = [];
  const vix = [];
  let d = Date.parse('2025-03-03T00:00:00Z');
  let c = 20000;
  while (N.length < 400) {
    const s = new Date(d).toISOString().slice(0, 10);
    const wd = new Date(d).getUTCDay();
    d += 86400000;
    if (wd === 0 || wd === 6) continue;
    const last = N.length === 399;
    c *= 1 + (last ? lastMove : N.length % 2 ? 0.004 : -0.002);
    const r = last ? lastRange : 0.01;
    N.push({ date: s, open: c, high: c * (1 + r / 2), low: c * (1 - r / 2), close: c });
    vix.push({ date: s, close: last ? vixLast : N.length === 399 ? vixPrev : 12 + (N.length % 7) * 0.3 });
  }
  return { N, vix };
}
const after = (N) => new Date(`${N.at(-1).date}T14:00:00Z`); // 19:30 IST on the last day: its close is final

test('a calm day: GO for everything', () => {
  const { N, vix } = series();
  const r = tt.tradeTodayFrom(N, vix, after(N));
  assert.equal(r.asOf, N.at(-1).date);
  assert.equal(r.overall, 'go');
  assert.ok(r.kinds.every((k) => k.level === 'go'));
});

test('a 2% fall with VIX up 20%: stay out of intraday and option selling, but keep investing', () => {
  const { N, vix } = series({ lastMove: -0.02, lastRange: 0.03, vixLast: 16, vixPrev: 13.3 });
  const r = tt.tradeTodayFrom(N, vix, after(N));
  const lv = Object.fromEntries(r.kinds.map((k) => [k.kind, k.level]));
  assert.equal(lv.intraday, 'stay');
  assert.equal(lv.fnoSell, 'stay');
  assert.equal(lv.invest, 'go', 'monthly investing is never timed');
  assert.equal(lv.fnoBuy, 'go', 'no tested sign for buyers');
  assert.ok(r.signs.some((s) => s.key === 'bigFall') && r.signs.some((s) => s.key === 'vixJump'));
});

test('never uses an in-progress bar: during market hours today\'s row is ignored', () => {
  const { N, vix } = series();
  const shocked = [...N.slice(0, -1), { ...N.at(-1), close: N.at(-2).close * 0.97 }];
  const during = new Date(`${N.at(-1).date}T06:00:00Z`); // 11:30 IST on the last day
  const r = tt.tradeTodayFrom(shocked, vix, during);
  assert.equal(r.asOf, N.at(-2).date, 'yesterday\'s close');
  assert.ok(!r.signs.some((s) => s.key === 'bigFall'), 'the intraday fall is not used');
});

test('signs at a day use nothing after it', () => {
  const { N, vix } = series();
  const v = new Map(vix.map((x) => [x.date, x.close]));
  const a = tt.signsAt(N, v, 300);
  const b = tt.signsAt(N.slice(0, 301), v, 300);
  assert.deepEqual(a, b);
});

test('levels follow the fixed rule lists', () => {
  assert.equal(tt.levelOf('intraday', { wideRange: true }), 'careful');
  assert.equal(tt.levelOf('intraday', { vixJump: true, wideRange: true }), 'stay');
  assert.equal(tt.levelOf('fnoSell', { below200: true }), 'stay');
  assert.equal(tt.levelOf('swing', { vixHigh: true }), 'careful');
  assert.equal(tt.levelOf('invest', { vixJump: true, bigFall: true }), 'go');
});
