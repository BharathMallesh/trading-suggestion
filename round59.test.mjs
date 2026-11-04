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

test('"today\'s results" before the evening run: today\'s live intraday trades on top, then the latest saved day', async () => {
  const { resultsAnswer } = await import('./paper-bot/period-results.mjs');
  const now = new Date('2026-11-04T09:50:00Z'); // 15:20 IST, before the 4:05 PM run
  const live = { date: '2026-11-04', lastBar: '15:15', variants: { video: { label: 'Video rules', netRs: 3616, trades: [{ symbol: 'TRENT.NS', side: 'long', time: '09:35', reason: 'target', net: 1805 }, { symbol: 'TITAN.NS', side: 'long', time: '11:20', reason: 'target', net: 1811 }] } } };
  const empty = { vwap: { trades: [] }, breakfast: { trades: [] }, swing: { trades: [] }, dip: { trades: [] }, fo: { trades: [] }, condor: { trades: [] }, cs: null };
  const a = resultsAnswer("Today's results", { now, live, ...empty });
  assert.match(a.title, /today so far \(Wed, 4 Nov, live\)/);
  assert.match(a.summary[0], /Video rules \+₹3,616/);
  assert.match(a.sections[0].heading, /live/);
  assert.match(a.sections[0].rows[0][3], /TRENT long 09:35 target \+₹1,805/);
  const old = resultsAnswer("Today's results", { now, live: { ...live, date: '2026-11-03' }, ...empty });
  assert.doesNotMatch(old.title, /live/, 'a live view of another day is not used');
});

test('results include the investing portfolios, RSI / Imbalance swing and the spread tracker', async () => {
  const { periodResults, resultsAnswer } = await import('./paper-bot/period-results.mjs');
  const empty = { vwap: { trades: [] }, breakfast: { trades: [] }, swing: { trades: [] }, dip: { trades: [] }, fo: { trades: [] }, condor: { trades: [] }, cs: null };
  const port = (startedAt, curve) => ({ startedAt, capital: 100000, curve, rebalances: [{ holdings: [{}, {}] }] });
  const papers = {
    ...empty,
    m20: port('2026-10-28', [{ date: '2026-11-03', value: 99662 }]),
    m10: port('2026-10-30', [{ date: '2026-11-03', value: 101000 }, { date: '2026-11-10', value: 102500 }]),
    steady: null, india: null,
    rsi: { version: 'b', trades: [{ symbol: 'VMM.NS', version: 'b', open: false, exitDate: '2026-11-03', r: -1.65 }, { symbol: 'X.NS', version: 'a', open: false, exitDate: '2026-11-03', r: 9 }] },
    imb: { trades: [] },
    spread: { trades: [{ symbol: 'PFC', open: false, settleDate: '2026-11-20', pnl: 1200, legs: [{ k: 310, t: 'PE' }, { k: 305, t: 'PE' }] }] },
  };
  const nov = periodResults({ from: '2026-11-01', to: '2026-11-30', kind: 'month' }, papers);
  assert.equal(nov.portfolios.find((x) => x.label === 'Momentum 10 + buffer').change, 2500, 'from the capital to the last value in the period');
  assert.equal(nov.rows.find((x) => x.label === 'RSI swing').result, -1.65, 'only the tracked version');
  assert.equal(nov.rows.find((x) => x.label.startsWith('F&O spread')).result, 1200);
  const oct = periodResults({ from: '2026-10-01', to: '2026-10-31', kind: 'month' }, papers);
  assert.equal(oct.portfolios.find((x) => x.label === 'Momentum 20').change, null, 'no value inside October yet');
  const a = resultsAnswer('results 2026-11-10', { now: new Date('2026-11-12T12:00:00Z'), ...papers });
  assert.ok(a.sections.some((s) => /Investing portfolios/.test(s.heading)));
});
