// Tests for the per-signal odds of the VWAP pullback strategy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r16-'));
process.env.VWAP_ODDS_PATH = join(TMP, 'vwap-odds.json');
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const o = await import('./paper-bot/vwap-odds.mjs');

const mk = (i, { side = 'long', dailyUp = true, gapPct = 0, niftySide = 1, time = '11:00', atrPct = 0.3, net }) =>
  ({ date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, time, side, net, feat: { dailyUp, gapPct, niftySide, atrPct } });

test('conditions: read relative to the trade direction', () => {
  const c = o.conditions(mk(0, { side: 'short', dailyUp: false, gapPct: -0.8, niftySide: 1, time: '09:45', atrPct: 0.5, net: 1 }), 0.3);
  assert.deepEqual(c, { dailyTrend: 'with', morningMove: 'with', nifty: 'against', time: 'early', volatility: 'high' });
  assert.equal(o.conditions({ side: 'long', time: '12:30', feat: {} }, null).dailyTrend, null);
});

test('fit + predict: shrinks small groups, moves odds toward conditions that won', () => {
  // 200 signals: 'with' daily trend wins 60%, 'against' wins 20%
  const tr = [];
  for (let i = 0; i < 100; i++) tr.push(mk(i, { dailyUp: true, net: i % 10 < 6 ? 100 : -100 }));
  for (let i = 0; i < 100; i++) tr.push(mk(i, { dailyUp: false, net: i % 10 < 2 ? 100 : -100 }));
  const m = o.fitOdds(tr);
  assert.ok(Math.abs(m.base - 0.4) < 0.01);
  const w = m.table.dailyTrend.with;
  assert.equal(w.rawRate, 0.6);
  assert.ok(w.rate < 0.6 && w.rate > 0.5, 'shrunk toward 40%');
  const pWith = o.predictOdds(m, mk(1, { dailyUp: true, net: 0 }));
  const pAgainst = o.predictOdds(m, mk(1, { dailyUp: false, net: 0 }));
  assert.ok(pWith.prob > 0.45 && pAgainst.prob < 0.35);
  assert.equal(pWith.reasons[0].condition, 'Daily trend');
});

test('evaluation: adopts a real pattern, rejects noise', () => {
  const real = [];
  for (let i = 0; i < 400; i++) {
    const up = i % 2 === 0;
    real.push(mk(i, { dailyUp: up, net: (up ? i % 10 < 6 : i % 10 < 2) ? 100 : -100 }));
  }
  const e = o.evaluateOdds(real);
  assert.equal(e.enough, true);
  assert.ok(e.skill > 0.05);
  assert.equal(e.adopt, true);
  assert.ok(e.higherOdds.winRate > e.lowerOdds.winRate);
  const noise = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) noise.push(mk(i, { dailyUp: rnd() < 0.5, gapPct: rnd() - 0.5, net: rnd() < 0.38 ? 100 : -100 }));
  assert.equal(o.evaluateOdds(noise).adopt, false);
  assert.equal(o.evaluateOdds(noise.slice(0, 50)).enough, false);
});

test('oddsFor: plain win rate unless the model was adopted', () => {
  const tr = [];
  for (let i = 0; i < 100; i++) tr.push(mk(i, { dailyUp: i % 2 === 0, net: i % 10 < 4 ? 1 : -1 }));
  const model = o.fitOdds(tr);
  const t = mk(3, { dailyUp: true, net: 0 });
  const plain = o.oddsFor(t, { model, adopted: false });
  assert.equal(plain.adjusted, false);
  assert.equal(plain.prob, model.base);
  assert.equal(o.oddsFor(t, { model, adopted: true }).adjusted, true);
  assert.equal(o.oddsFor(t, null), null);
});

test('backtest trades carry the conditions at the signal', async () => {
  const v = await import('./paper-bot/vwap-pullback.mjs');
  const TIMES = [];
  for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) TIMES.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const rows = [];
  let p = 100;
  for (const t of TIMES) {
    const op = p;
    let c = p + 0.1;
    if (t === '11:00') c = p - 0.6;
    if (t > '11:00' && t < '12:00') c = p + 0.4;
    const lo = Math.min(op, c) - 0.05;
    rows.push({ date: `2026-10-12 ${t}`, open: op, high: Math.max(op, c) + 0.05, low: t === '11:00' ? lo - 0.5 : lo, close: t === '11:00' ? p + 0.05 : c, volume: 1000 });
    p = t === '11:00' ? p + 0.05 : c;
  }
  const [t] = v.backtestStock('X.NS', rows, v.RULES, { daily: new Map([['2026-10-12', { aboveAvg20: true }]]) });
  assert.ok(t.feat.atrPct > 0);
  assert.equal(t.feat.dailyUp, true);
  assert.equal(t.feat.gapPct, null, 'no previous session');
  assert.equal(t.feat.niftySide, null);
  // live view attaches odds through the lookup
  const live = await v.todaySignals({ loadCandles: async (s, q) => (q.interval === '5m' ? rows : []), now: new Date('2026-10-12T11:00:00Z'), oddsLookup: () => ({ prob: 0.38, adjusted: false }) });
  assert.equal(live.variants.video.trades[0].odds.prob, 0.38);
});
