// Tests for the weekday-study paper versions: swing "no Monday buys" and Breakfast "flat opens only".
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ath = await import('./paper-bot/ath-swing.mjs');
const bf = await import('./paper-bot/breakfast.mjs');

test('swing: skipEntryDays leaves out buys on those weekdays (the stock may signal again)', () => {
  // a long rising series with dips gives several setups; compare entry weekdays with and without the rule
  const rows = [];
  let px = 100;
  for (let i = 0; i < 900; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
    if ([0, 6].includes(d.getUTCDay())) continue;
    px *= 1 + 0.002 + 0.03 * Math.sin(i / 9) / 9;
    rows.push({ date: d.toISOString().slice(0, 10), open: px * 0.998, high: px * 1.01, low: px * 0.99, close: px, volume: 1e6 });
  }
  const all = ath.tradesFor('X.NS', rows, ath.RULES);
  const noMon = ath.tradesFor('X.NS', rows, { ...ath.RULES, skipEntryDays: [1] });
  const day = (t) => new Date(`${t.entryDate}T00:00:00Z`).getUTCDay();
  assert.ok(noMon.every((t) => day(t) !== 1), 'no Monday entries');
  if (all.some((t) => day(t) === 1)) assert.notDeepEqual(all.map((t) => t.entryDate), noMon.map((t) => t.entryDate));
  // shiftEntryDays: a Monday buy happens at Tuesday's open instead, with the same stop
  const shifted = ath.tradesFor('X.NS', rows, { ...ath.RULES, shiftEntryDays: [1] });
  assert.ok(shifted.every((t) => day(t) !== 1), 'no Monday entries after the shift');
  for (const t of all.filter((x) => day(x) === 1)) {
    const s = shifted.find((x) => x.signalDate === t.signalDate);
    if (s) {
      assert.equal(day(s), 2, 'bought on the Tuesday');
      assert.equal(s.stop, t.stop, 'same stop');
    }
  }
});

test('breakfast: flat open = NIFTY within ±0.3% in the first five minutes', () => {
  assert.equal(bf.isFlatOpen({ niftyMovePct: 0.29 }), true);
  assert.equal(bf.isFlatOpen({ niftyMovePct: -0.3 }), true);
  assert.equal(bf.isFlatOpen({ niftyMovePct: 0.45 }), false);
  assert.equal(bf.isFlatOpen({ niftyMovePct: null }), false);
});

test('period results: the flat-open version is shown but not counted twice in the totals', async () => {
  const r = await import('./paper-bot/period-results.mjs');
  const res = r.periodResults({ from: '2026-10-19', to: '2026-10-23', label: 'x', kind: 'week' }, {
    vwap: { trades: [] }, swing: { trades: [] }, dip: null, fo: null, cs: null, swingVersion: 'original',
    breakfast: { trades: [{ date: '2026-10-21', symbol: 'A.NS', side: 'long', reason: 'stop', net: -5000, niftyMovePct: 0.1 }, { date: '2026-10-22', symbol: 'B.NS', side: 'short', reason: 'target', net: 4000, niftyMovePct: 0.8 }] },
  });
  assert.equal(res.rows.find((x) => /flat opens/.test(x.label)).result, -5000);
  assert.equal(res.totalRs, -1000, 'the two Breakfast trades once, not three times');
  assert.equal(res.tradesInPeriod, 2);
});
