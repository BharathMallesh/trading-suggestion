// Tests for the Momentum breakout swing (E2) paper strategy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const e2 = await import('./paper-bot/e2-swing.mjs');

// 330 quiet daily bars around ₹100, then a breakout to a new 52-week closing high, then a rise and a fall
function rows({ after = [] } = {}) {
  const out = [];
  let t = Date.parse('2024-01-01T00:00:00Z');
  const push = (c) => {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86400000;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, val: 1e8 });
    t += 86400000;
  };
  for (let i = 0; i < 330; i++) push(100 + Math.sin(i / 7) * 2);
  push(110); // first close above the previous 252 sessions' highest close
  for (const c of after) push(c);
  return out;
}

test('signal: the FIRST close above the previous 252 sessions\' highest close; stop = 10-day low − 1 ATR', () => {
  const bars = e2.prepare(rows({ after: [111, 112] }));
  const i = bars.findIndex((b) => b.close === 110);
  const sig = e2.signalAt(bars, i);
  assert.ok(sig, 'fires on the breakout day');
  assert.ok(sig.pivotLow < 110 && sig.pivotLow > 95);
  assert.equal(e2.signalAt(bars, i + 1), null, 'not again the next day (already above)');
  assert.equal(e2.signalAt(bars, i - 5), null);
});

test('walk: a close below the 5-ATR trail is sold at the next open; still open at the data end → sell-next-open flag', () => {
  const up = Array.from({ length: 20 }, (_, k) => 110 + k * 2);
  const bars = e2.prepare(rows({ after: [...up, 119.5, 119] })); // collapse below the trail, then one more bar
  const i = bars.findIndex((b) => b.close === 110);
  bars[i].stop0 = e2.signalAt(bars, i).pivotLow - bars[i].atr;
  const j = bars.findIndex((x, k) => k > i && x.close === 119.5);
  bars[j].open = 150; // opens above the trail, closes below it
  const w = e2.walk(bars, i);
  assert.equal(w.xi, j + 1, 'sold the session after the close below the trail');
  assert.equal(w.reason, 'trail');
  assert.equal(w.exit, bars[w.xi].open, 'filled at the next open');
  const bars2 = e2.prepare(rows({ after: [...up, 119.5] }));
  bars2[i].stop0 = bars[i].stop0;
  bars2[bars2.length - 1].open = 150; // the last bar opens above the trail and closes below it
  const w2 = e2.walk(bars2, i);
  assert.ok(w2.open && w2.sellNextOpen, 'last close below the trail → sell at the next open');
});

test('account: 1.25% risk sizing capped at 20% of equity, ≤ 10 positions, highest momentum first', () => {
  const days = ['2026-01-02', '2026-01-05'];
  const bars = new Map();
  const trades = [];
  for (let k = 0; k < 12; k++) {
    const s = `S${k}`;
    bars.set(s, days.map((d) => ({ date: d, close: 100 })));
    trades.push({ symbol: s, entryDate: '2026-01-02', entry: 100, riskPct: 0.25, mom: k, open: true });
  }
  const a = e2.account(trades, bars, days, '2026-01-02');
  assert.equal(a.open.length, 10);
  assert.ok(!a.open.some((p) => p.t.symbol === 'S0' || p.t.symbol === 'S1'), 'the two lowest-momentum signals get no slot');
  const s11 = a.open.find((p) => p.t.symbol === 'S11');
  assert.ok(Math.abs(s11.value - 500000 * 0.0125 / 0.25) < 1, 'risk ₹6,250 ÷ 25% stop distance = ₹25,000');
  const big = e2.account(trades.map((t) => ({ ...t, riskPct: 0.02 })), bars, days, '2026-01-02');
  assert.ok(Math.abs(big.open.at(-1).value - 100000) < 1, 'capped at 20% of equity');
  assert.equal(big.open.length, 5, 'and limited by cash');
});
