// Tests for the 16-year open → close view in Day patterns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dp = await import('./paper-bot/day-patterns.mjs');

test('open → close by the stock\'s own gap, averaged per day, split 2010–18 / 2019 →', () => {
  // 12 stocks; every weekday each stock opens 1% up and closes 0.5% below its open (a fade)
  const series = new Map();
  const uni = new Map();
  const dates = [];
  for (let t = Date.parse('2018-12-03T00:00:00Z'); dates.length < 30; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (new Date(t).getUTCDay() % 6) dates.push(d);
  }
  for (let k = 0; k < 12; k++) {
    let c = 100;
    const rows = dates.map((date) => {
      const open = c * 1.01;
      c = open * 0.995;
      return { date, open, close: c };
    });
    series.set(`S${k}`, rows);
  }
  for (const ym of ['2018-12', '2019-01']) uni.set(ym, new Set(series.keys()));
  const r = dp.longIntraday(series, uni, { from: '2018-12-01' });
  const all = r.cells['All days']['gap up'];
  assert.ok(Math.abs(all.early.avg - -0.5) < 1e-9 && Math.abs(all.late.avg - -0.5) < 1e-9, 'a 0.5% fall from the open in both halves');
  assert.equal(r.cells['All days']['gap down'], undefined, 'no stock opened down');
  assert.ok(r.cells.Mon && r.cells.Fri, 'per weekday too');
  assert.ok(Math.abs(r.byYear['2019']['gap up'] - -0.5) < 1e-9);
});

test('a stock outside that month\'s top 200 is left out', () => {
  const rows = [{ date: '2019-01-01', open: 100, close: 100 }, { date: '2019-01-02', open: 110, close: 100 }];
  const r = dp.longIntraday(new Map([['X', rows]]), new Map([['2019-01', new Set(['Y'])]]), { from: '2018-01-01' });
  assert.equal(r.days, 0);
});
