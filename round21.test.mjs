// Tests for the strong-stock swing strategy (ATH filter, base / flag breakouts,
// ATR stops, Chandelier exit, portfolio, streak odds).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const a = await import('./paper-bot/ath-swing.mjs');

/** Daily rows from a list of closes (high/low ±0.5%, open = previous close), weekdays only. */
function rows(closes, start = '2024-01-01') {
  const out = [];
  let d = new Date(`${start}T00:00:00Z`);
  let prev = closes[0];
  for (const c of closes) {
    while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86400000);
    out.push({ date: d.toISOString().slice(0, 10), open: prev, high: Math.max(prev, c) * 1.005, low: Math.min(prev, c) * 0.995, close: c, volume: 1000 });
    prev = c;
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

test('indicators: all-time high age, ATR, weekly RSI without look-ahead', () => {
  const closes = [];
  for (let i = 0; i < 200; i++) closes.push(100 + i); // steady rise
  const b = a.indicators(rows(closes));
  assert.equal(b[199].athAge, 0);
  assert.ok(b[199].atr > 0);
  assert.equal(b[199].weeklyRsi, 100, 'only rising weeks');
  // RSI seen on a day comes from completed weeks only: a crash on the last day doesn't change it
  const crash = [...closes.slice(0, 199), 50];
  const c = a.indicators(rows(crash));
  assert.equal(c[199].weeklyRsi, b[199].weeklyRsi);
  assert.ok(a.isStrong(b[199]));
  // Yes-Bank-like: far below an old high → not strong
  const fallen = [...closes, ...Array.from({ length: 300 }, (_, i) => 299 - i * 0.6)];
  const f = a.indicators(rows(fallen));
  assert.equal(a.isStrong(f[f.length - 1]), false);
});

test('flag breakout: pole, tight flag, breakout above the pole top', () => {
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 + i * 0.2); // uptrend to ~152, ATH recent
  const base = closes[closes.length - 1];
  for (let i = 1; i <= 6; i++) closes.push(base + i * 2.5); // pole: +15 in 6 days
  const top = closes[closes.length - 1];
  for (const x of [-1, -2, -1.5, -2.5, -1]) closes.push(top + x); // flag holds the upper half
  closes.push(top + 3); // breakout close
  const bars = a.indicators(rows(closes));
  const sig = a.setupAt(bars, bars.length - 1);
  assert.ok(sig, 'signal on the breakout day');
  assert.equal(sig.setup, 'flag breakout');
  assert.ok(sig.pivotLow < top && sig.pivotLow > top - 5);
  assert.equal(a.setupAt(bars, bars.length - 2), null, 'not during the flag');
});

test('oversold base breakout: weekly RSI low, 5+ days without a new low, first breakout', () => {
  const closes = [];
  for (let i = 0; i < 300; i++) closes.push(100 + i * 0.3); // strong stock, ATH ~190
  let p = closes[closes.length - 1];
  for (let i = 0; i < 25; i++) closes.push((p *= 0.985)); // ~30% pullback over 5 weeks → weekly RSI low
  const low = p;
  for (const x of [1.01, 1.0, 1.015, 1.005, 1.01, 1.012]) closes.push(low * x); // base: no new low for 6 days
  closes.push(low * 1.05); // breakout above the base high
  const bars = a.indicators(rows(closes));
  const i = bars.length - 1;
  assert.ok(bars[i].weeklyRsi <= 35, `weekly RSI ${bars[i].weeklyRsi}`);
  assert.ok(a.isStrong(bars[i]), 'still within 30% of a recent all-time high');
  const sig = a.setupAt(bars, i);
  assert.ok(sig);
  assert.equal(sig.setup, 'oversold base breakout');
  assert.ok(sig.baseDays >= 5);
});

test('trades: entry next open, stop 1 ATR below the low, Chandelier exit lets winners run', () => {
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 + i * 0.2);
  const base = closes[closes.length - 1];
  for (let i = 1; i <= 6; i++) closes.push(base + i * 2.5);
  const top = closes[closes.length - 1];
  for (const x of [-1, -2, -1.5, -2.5, -1]) closes.push(top + x);
  closes.push(top + 3);
  let q = top + 3;
  for (let i = 0; i < 40; i++) closes.push((q += 1.2)); // big run after the breakout
  for (let i = 0; i < 10; i++) closes.push((q -= 4)); // sharp drop → Chandelier exit
  const tr = a.tradesFor('X.NS', rows(closes));
  const t = tr.find((x) => x.setup === 'flag breakout');
  assert.ok(t);
  assert.ok(t.stop < t.entry);
  assert.equal(t.reason, 'chandelier');
  assert.ok(t.r > 2, `a big winner: ${t.r.toFixed(2)} R`);
  assert.ok(t.retPct > 0.1);
});

test('stats: top-10% share, losing-streak odds, portfolio with cash interest', () => {
  assert.ok(Math.abs(a.streakProb(1, 0.5, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(a.streakProb(2, 0.5, 2) - 0.25) < 1e-12);
  assert.ok(a.streakProb(800, 0.37, 19) < 0.1 && a.streakProb(800, 0.37, 10) > 0.5);
  const mk = (r, i) => ({ symbol: `S${i}`, entryDate: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, exitDate: `2024-02-${String((i % 28) + 1).padStart(2, '0')}`, retPct: r / 10, riskPct: 0.1, r, days: 20, open: false });
  const trades = [...Array.from({ length: 18 }, (_, i) => mk(-1, i)), mk(10, 18), mk(15, 19)];
  const s = a.summarise(trades);
  assert.equal(s.trades, 20);
  assert.equal(s.winRate, 0.1);
  assert.ok(Math.abs(s.top10ShareOfR - 25 / 7) < 1e-9, 'top 2 trades = 25 R of a 7 R total');
  assert.equal(s.longestLosingStreak, 18);
  const flat = a.portfolio([], { ...a.RULES });
  assert.equal(flat.finalEquity, a.RULES.capital);
  const one = a.portfolio([{ symbol: 'A', entryDate: '2024-01-01', exitDate: '2025-01-01', retPct: 0, riskPct: 0.1, r: 0, open: false }]);
  assert.ok(one.finalEquity > a.RULES.capital * 1.04 && one.finalEquity < a.RULES.capital * 1.07, 'uninvested cash earns about 6% in a year');
});

test('completed candles only: today’s bar is dropped until 15:35 IST', () => {
  const r = [{ date: '2026-10-13', close: 1 }, { date: '2026-10-14', close: 2 }];
  assert.equal(a.completedOnly(r, new Date('2026-10-14T05:00:00Z')).length, 1);
  assert.equal(a.completedOnly(r, new Date('2026-10-14T10:10:00Z')).length, 2);
});
