// Tests for "What works today?" on the Day patterns tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const m = await import('./paper-bot/day-today.mjs');
const st = (n, avg) => ({ n, avg, win: 0.5, t: 1 });
const study = { at: '2026-10-27', strategies: [
  { key: 'vwap-video', name: 'YouTube video', unit: '₹', all: st(95, -99), byDay: { Wed: st(20, 400), Thu: st(20, -607) }, byGap: { 'gap up': st(16, 675), 'flat open': st(59, -144) }, byStock: { 'TITAN.NS': { all: st(20, 50), Wed: st(5, 415) }, 'TRENT.NS': { all: st(25, -10), Wed: st(1, 99) } }, verdict: { best: 'Wed', worst: 'Thu', consistent: false } },
  { key: 'swing-wide', name: 'Swing wide', unit: 'R', all: st(834, 0.26), byDay: { Wed: st(165, 0.27), Thu: st(187, 0.68), Mon: st(171, -0.09) }, byStock: {}, verdict: { best: 'Thu', worst: 'Mon', consistent: true } },
  { key: 'fo-strangle', name: 'Strangle', unit: '%', all: st(398, 0.4), byDay: { Wed: st(14, 3.8) }, verdict: { note: 'era, not day' } },
] };
const papers = { vwap: { trades: [{ variant: 'video', date: '2026-10-27', symbol: 'TRENT.NS', reason: 'target', net: 1801 }, { variant: 'video', date: '2026-10-27', symbol: 'BAJAJFINSV.NS', reason: 'stop', net: -1146 }] }, breakfast: null, swing: { trades: [{ version: 'wide', symbol: 'M&M.NS', open: true, r: -0.3 }] }, dip: null, fo: null };
const IST = (d, hm) => new Date(`${d}T${hm}:00+05:30`);

test('day in focus: today on a trading day, otherwise the next trading day', () => {
  assert.equal(m.dayInFocus(IST('2026-10-28', '08:55')), '2026-10-28');
  assert.equal(m.dayInFocus(IST('2026-10-31', '12:00')), '2026-11-02', 'Saturday → Monday');
});

test('rating: only a pattern consistent in both halves is called reliable', () => {
  const thu = m.rateFor(study.strategies[1], 'Thu', null);
  assert.equal(thu.reliable, true);
  assert.match(thu.label, /best weekday — and that held/);
  const wed = m.rateFor(study.strategies[0], 'Wed', 'gap up');
  assert.equal(wed.reliable, false);
  assert.ok(wed.tilt > 0);
  assert.match(wed.label, /probably chance/);
});

test('what works today: ranked logics, stocks for the weekday, last few paper days; strangle only when picked', async () => {
  const r = await m.whatWorksToday({ now: IST('2026-10-28', '08:55'), study, papers, loadCandles: async () => [] });
  assert.equal(r.weekday, 'Wed');
  assert.equal(r.gap, null, 'before 9:20 the opening type is unknown');
  assert.deepEqual(r.rows.map((x) => x.key).sort(), ['swing-wide', 'vwap-video'], 'strangle left out of the ranking');
  const v = r.rows.find((x) => x.key === 'vwap-video');
  assert.deepEqual(v.bestStocks.map((s) => s.symbol), ['TITAN'], 'only stocks with 2+ trades that weekday');
  assert.equal(v.recent[0].date, '2026-10-27');
  assert.equal(v.recent[0].result, 655);
  const sw = r.rows.find((x) => x.key === 'swing-wide');
  assert.equal(sw.recent.at(-1).date, 'open now');
  const one = await m.whatWorksToday({ logic: 'fo-strangle', now: IST('2026-10-28', '08:55'), study, papers, loadCandles: async () => [] });
  assert.equal(one.rows.length, 1);
  assert.match(one.rows[0].note, /era/);
  // after 9:20 the gap from the first 5-minute candle is used
  const bars = [{ date: '2026-10-27 15:25', close: 100, open: 100 }, { date: '2026-10-28 09:15', open: 100.6, close: 100.7 }];
  const g = await m.whatWorksToday({ now: IST('2026-10-28', '09:40'), study, papers, loadCandles: async () => bars });
  assert.equal(g.gap, 'gap up');
  assert.ok(g.rows.find((x) => x.key === 'vwap-video').gap.n === 16);
});
