// Tests for Home → My plan and the realistic Momentum 20 options.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const p = await import('./paper-bot/my-plan.mjs');

test('dates: next trading day and the last trading day of the month', () => {
  assert.equal(p.nextTradingDay('2026-10-30'), '2026-11-02', 'Friday → Monday');
  assert.equal(p.lastTradingDayOfMonth('2026-10-29'), '2026-10-30');
});

test('my plan: core, momentum with next-month changes, swing signals and holdings, skip list, dates', async () => {
  const research = async () => ({ raw: {
    regime: { state: 'out', reading: 'NIFTY 6% below its 200-day average' }, capital: 100000, riskPct: 1,
    funds: [{ index: 'NIFTY 50', name: 'Fund A', type: 'ETF', r3: 0.0765 }],
    triggered: [{ symbol: 'LT.NS', setup: 'flag breakout', close: 3500, stop: 3325, riskPct: 5, size: { qty: 5, value: 17500 } }],
    momentum: { monthEnd: '2026-09-30', passed: true, rebalances: 0, list: [{ symbol: 'A', ret12: 1 }, { symbol: 'B', ret12: 0.5 }], preview: { date: '2026-10-28', list: [{ symbol: 'A' }, { symbol: 'C' }] } },
  } });
  const papers = {
    swing: { trades: [{ version: 'improved', open: true, symbol: 'M&M.NS', entryDate: '2026-10-19', entry: 2920, exit: 2850, trail: 2676, r: -0.28 }] },
    vwap: { trades: [{ variant: 'video', net: -1000 }, { variant: 'scanner', net: 500 }] }, breakfast: { trades: [{ net: -5000 }] }, fo: { trades: [] },
  };
  const r = await p.myPlan({ now: new Date('2026-10-29T05:00:00Z'), research, papers });
  assert.equal(r.regime.state, 'out');
  assert.equal(r.core.funds[0].name, 'Fund A');
  assert.equal(r.momentum.perStock, 50000);
  assert.equal(r.momentum.perStockSatellite, 10000);
  assert.deepEqual([r.momentum.likelyIn, r.momentum.likelyOut], [['C'], ['B']]);
  assert.equal(r.momentum.nextRebalance, '2026-11-02');
  assert.equal(r.swing.signals[0].shares, 5);
  assert.ok(r.swing.open[0].gapToStopPct > 6);
  assert.equal(r.skip.find((x) => x.name === 'Breakfast').net, -5000);
  assert.equal(r.dates[0].date, '2026-10-30');
});

test('momentum: realistic fills and quarterly rebalancing', async () => {
  const m = await import('./paper-bot/momentum.mjs');
  const days = [];
  for (let i = 0; i < 900; i++) { const d = new Date(Date.UTC(2023, 0, 2) + i * 86400000); if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10)); }
  const names = ['A', 'B', 'C', 'D'];
  const data = new Map(names.map((s, k) => [s, days.map((date, i) => ({ date, open: 100 * (1 + 0.0004 * (k + 1)) ** i * (1 + 0.01 * Math.sin(i + k)), close: 100 * (1 + 0.0004 * (k + 1)) ** i }))]));
  const idx = m.priceIndex(data);
  const universe = new Map([...new Set(days.map((d) => d.slice(0, 7)))].map((ym) => [ym, new Set(names)]));
  const base = { ...m.RULES, top: 2, from: '2024-02-01' };
  const monthly = m.simulate({ idx, universe, refDates: days, method: 'a', r: base });
  const quarterly = m.simulate({ idx, universe, refDates: days, method: 'a', r: { ...base, rebalanceEvery: 3 } });
  const realistic = m.simulate({ idx, universe, refDates: days, method: 'a', r: { ...base, fill: 'mid', slipPct: 0.3 } });
  assert.ok(quarterly.lists.length < monthly.lists.length / 2, 'about a third of the rebalances');
  assert.ok(quarterly.lists.every((l, i) => i === 0 || Number(l.signal.slice(5, 7)) % 3 === 0));
  assert.ok(realistic.curve.at(-1).value < monthly.curve.at(-1).value, 'more slippage costs more');
});
