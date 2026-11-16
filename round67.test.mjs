// Tests for the Leader Box Breakout paper strategy (best version of the YouTube swing strategies).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lbb = await import('./paper-bot/lbb-swing.mjs');

// weekday rows from a list of closes (high/low ±1%, traded value ₹1 cr unless given)
function rows(closes, { start = '2023-01-02', vals = null } = {}) {
  const out = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  closes.forEach((c, k) => {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86400000;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, val: vals?.[k] ?? 1e7 * c });
    t += 86400000;
  });
  return out;
}
// a long steady uptrend, a new high, a 3-day pause (box), then a breakout close above the box top
function boxSeries() {
  const c = [];
  for (let i = 0; i < 320; i++) c.push(50 + i * 0.25); // up to ~130
  const top = c.at(-1) * 1.03;
  c.push(top); // new 52-week high
  c.push(top * 0.98, top * 0.97, top * 0.975, top * 0.98, top * 0.985, top * 0.98, top * 0.99); // top + floor confirm
  c.push(top * 1.04); // breakout close
  c.push(top * 1.05, top * 1.06);
  return c;
}

test('Darvas box: a close above the confirmed box top is a breakout, with the box floor recorded', () => {
  const bars = lbb.prepare(rows(boxSeries()));
  const hits = bars.filter((b) => b.brkTop != null);
  assert.equal(hits.length, 1, 'one breakout');
  const b = hits[0];
  assert.ok(b.close > b.brkTop && b.brkFloor < b.brkTop, 'close above top, floor below');
  assert.ok(lbb.trendTemplate(bars, b.i), 'a steady uptrend passes the trend template');
});

test('stop: box floor, but never more than 8% below the breakout close; weekly close below the 30-week SMA exits', () => {
  const bars = lbb.prepare(rows(boxSeries()));
  const b = bars.find((x) => x.brkTop != null);
  const stop = Math.max(b.brkFloor, b.close * 0.92);
  assert.ok(stop >= b.close * 0.92 - 1e-9);
  // collapse after entry: a close below the stop is sold at the next open
  const c = boxSeries().concat([b.close * 0.8, b.close * 0.79, b.close * 0.78]);
  const bars2 = lbb.prepare(rows(c));
  const w = lbb.walk(bars2, b.i + 1, stop);
  assert.equal(w.reason, 'stop');
  assert.equal(w.exit, bars2[w.xi].open);
  assert.ok(bars2[w.xi - 1].close < stop);
});

test('signals: need RS ≥ 70, volume above its 50-day average and NIFTY above its 200-day; the last-day breakout is a next-open signal', () => {
  const c = boxSeries().slice(0, -2); // breakout is the last bar
  const vals = c.map((x, k) => (k === c.length - 1 ? 3e7 * x : 1e7 * x)); // heavy volume on the breakout
  const bars = lbb.prepare(rows(c, { vals }));
  for (const b of bars) b.rs = 90;
  const sym = 'TEST';
  const universe = new Map(bars.map((b) => [b.date.slice(0, 7), new Set([sym])]));
  const r = lbb.tradesFor(sym, bars, universe, () => true, '2000-01-01');
  assert.equal(r.trades.length, 0);
  assert.equal(r.signals.length, 1, 'signal to buy at the next open');
  assert.ok(r.signals[0].riskPct > 0 && r.signals[0].riskPct <= 0.08 + 1e-9);
  assert.equal(lbb.tradesFor(sym, bars, universe, () => false, '2000-01-01').signals.length, 0, 'NIFTY below its 200-day → no buys');
  for (const b of bars) b.rs = 50;
  assert.equal(lbb.tradesFor(sym, bars, universe, () => true, '2000-01-01').signals.length, 0, 'RS below 70 → no buys');
  const quiet = lbb.prepare(rows(c));
  for (const b of quiet) b.rs = 90;
  assert.equal(lbb.tradesFor(sym, quiet, universe, () => true, '2000-01-01').signals.length, 0, 'volume not above its average → no buys');
});

test('account: 0.5% risk ÷ stop distance capped at 6% of equity; strongest first; rotation swaps out a much weaker holding', () => {
  const days = ['2026-01-02', '2026-01-05', '2026-01-06'];
  const stocks = new Map();
  const trades = [];
  for (let k = 0; k < 20; k++) {
    const s = `S${k}`;
    stocks.set(s, days.map((d) => ({ date: d, open: 100, close: 100, rs: 71 + k })));
    trades.push({ symbol: s, entryDate: '2026-01-02', entry: 100, riskPct: 0.05, rs: 71 + k, open: true });
  }
  const a = lbb.account(trades, stocks, days, '2026-01-02');
  assert.equal(a.open.size, 17, '16 × 6%, then the last 4% of cash (≥ 2%), then nothing');
  assert.ok(Math.abs(a.open.get('S3').cost - 20000) < 1 && !a.open.has('S2'), 'strongest first; the weakest get no cash');
  const one = lbb.account([{ ...trades[0], riskPct: 0.25 }], stocks, days, '2026-01-02');
  assert.ok(Math.abs(one.open.get('S0').cost - 500000 * 0.005 / 0.25) < 1, '₹2,500 risk ÷ 25% = ₹10,000');
  // a much stronger signal on day 3 rotates out the weakest holding
  stocks.set('NEW', days.map((d) => ({ date: d, open: 100, close: 100, rs: 99 })));
  const b = lbb.account([...trades, { symbol: 'NEW', entryDate: '2026-01-06', entry: 100, riskPct: 0.05, rs: 99, open: true }], stocks, days, '2026-01-02');
  assert.ok(b.open.has('NEW'), 'bought the new leader');
  assert.equal(b.closed.find((t) => t.reason === 'rotated')?.symbol, 'S3', 'sold the weakest holding (RS 74 ≤ 99 − 20)');
});

test('NIFTY filter: above the 200-day SMA on a date; non-trading dates use the previous NIFTY close', () => {
  const up = rows(Array.from({ length: 260 }, (_, i) => 100 + i));
  const f = lbb.niftyFilter(up);
  assert.equal(f(up.at(-1).date), true);
  assert.equal(f('2099-01-01'), true, 'uses the last known day');
  const down = rows(Array.from({ length: 260 }, (_, i) => 400 - i));
  assert.equal(lbb.niftyFilter(down)(down.at(-1).date), false);
});
