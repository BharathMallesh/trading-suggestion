// Tests for the India mix 5-point re-balance band, the NSE delivery parser and the ML picks paper book.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const im = await import('./paper-bot/india-mix.mjs');
const dl = await import('./paper-bot/delivery.mjs');
const ml = await import('./paper-bot/ml-picks.mjs');

test('India mix band: left alone inside 5 points of ⅓, put back to ⅓ at 5+ points or the first time', () => {
  const v = 300000;
  assert.equal(im.bandDecision(im.sleeveValues(new Map(), v), v).rebalance, true, 'first time → ⅓ each');
  const near = new Map([['JUNIORBEES.NS', 104000], ['GOLDBEES.NS', 96000], ['ABC.NS', 50000]]);
  const s = im.sleeveValues(near, v);
  assert.equal(Math.round(s.stocks), 100000, 'stock part = the rest (liquid money included)');
  assert.equal(im.bandDecision(s, v).rebalance, false, '34.7% / 32% / 33.3% → leave');
  const far = new Map([['JUNIORBEES.NS', 120000], ['GOLDBEES.NS', 90000]]);
  const d = im.bandDecision(im.sleeveValues(far, v), v);
  assert.equal(d.rebalance, true, 'Next 50 at 40% → put back');
  assert.ok(Math.abs(d.weights.next50 - 0.4) < 1e-9);
});

test('India mix band backtest: weights drift, re-balance only when 5+ points off, drag only then', () => {
  const months = ['2020-01', '2020-02', '2020-03'];
  const flat = new Map(months.map((m) => [m, 0]));
  const r = im.indiaMixBandedReturns(months, { next50: flat, gold: flat, stocks: flat });
  assert.equal(r.rebalances, 0);
  assert.ok(r.every((x) => x.r === 0), 'no drag without a re-balance');
  const up = new Map(months.map((m) => [m, 0.3]));
  const r2 = im.indiaMixBandedReturns(months, { next50: up, gold: flat, stocks: flat });
  assert.ok(r2.rebalances >= 1, 'a 30% jump in one part triggers it');
  assert.ok(Math.abs(r2[0].r - (0.1 - im.MIX.rebalanceDragPct / 100)) < 1e-9);
});

test('NSE delivery file: header trade date checked; EQ/BE/BZ rows of tracked symbols kept', () => {
  const txt = 'Security Wise Delivery Position - Compulsory Rolling Settlement\n10,MTO,13112026,1,1\nTrade Date <13-NOV-2026>,Settlement Type <N>\nRecord Type,Sr No,Name of Security,Quantity Traded,Deliverable Quantity(gross across client level),% of Deliverable Quantity to Traded Quantity\n20,1,ABC,EQ,1000,600,60.00\n20,2,XYZ,EQ,500,100,20.00\n20,3,ABC,GB,9,9,100\n20,4,OTHER,EQ,7,7,100\n';
  assert.deepEqual(dl.parseMto(txt, '2026-11-13', new Set(['ABC', 'XYZ'])), { ABC: [1000, 600], XYZ: [500, 100] });
  assert.throws(() => dl.parseMto(txt, '2026-11-12'), /different trade date/);
  assert.match(dl.mtoUrl('2026-11-13'), /MTO_13112026\.DAT$/);
});

test('ML picks book: equal parts of the new list, charges on what changed only, prices at the session midpoint', () => {
  const prices = { A: 100, B: 200, C: 50 };
  const px = (s) => prices[s] ?? null;
  const first = ml.rebalanceBook({ cash: 500000, holdings: [] }, ['A', 'B'], px, '2026-11-18');
  assert.equal(first.holdings.length, 2);
  assert.ok(Math.abs(first.cost - 500000 * 0.00175) < 1e-6, 'buying everything: 0.175% of ₹5 lakh');
  assert.ok(Math.abs(first.holdings[0].amount - (500000 - first.cost) / 2) < 1e-6);
  // A doubles; swap B for C: sells B in full, trims A to half the value, buys C
  prices.A = 200;
  const second = ml.rebalanceBook({ cash: 0, holdings: first.holdings }, ['A', 'C'], px, '2026-12-01');
  const before = first.holdings[0].amount * 2 + first.holdings[1].amount;
  assert.ok(Math.abs(second.value + second.cost - before) < 1e-6, 'value before charges = holdings marked at the midpoint');
  assert.deepEqual(second.holdings.map((h) => h.symbol), ['A', 'C']);
  assert.equal(second.holdings[1].entry, 50);
  const noPrice = ml.rebalanceBook({ cash: 100000, holdings: [] }, ['A', 'ZZZ'], px, '2026-12-01');
  assert.deepEqual(noPrice.missing, ['ZZZ'], 'a stock with no price that day stays in cash');
  assert.ok(noPrice.cash > 0);
});
