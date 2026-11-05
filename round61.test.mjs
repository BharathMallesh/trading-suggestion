// Tests for the real-price F&O stock-spread test (paper-bot/fo-stock-backtest.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ft = await import('./paper-bot/fo-stock-backtest.mjs');
const spread = (extra = {}) => ({ sym: 'AAA', lab: 'weak', strategy: 'put-spread', legs: [{ k: 100, t: 'PE', q: 1, p: 6 }, { k: 95, t: 'PE', q: -1, p: 3 }], lot: 1000, cost: 3000, maxLoss: 3100, expiry: '2026-11-24', chance: 0.4, spot: 100, ...extra });
const exitOn = (S, prices) => ({ AAA: { underlying: S, expiries: { '2026-11-24': prices } } });

test('a stale close of an untraded option is valued at no less than its intrinsic value', () => {
  // stock fell to 90: both puts deep in the money; NSE kept a stale 6 for the bought 100 put
  const r = ft.closeSpread(spread(), '2026-11-03', '2026-11-20', exitOn(90, { 100: { PE: 6 }, 95: { PE: 5 } }));
  assert.ok(r.pnl > 5 * 1000 - 3000 - 600 && r.pnl < 5 * 1000 - 3000, `the full width less the cost and charges (≈ ₹525 here): ${r.pnl}`);
});

test('a bought spread is worth 0 … its width, and a split is left out', () => {
  const r = ft.closeSpread(spread(), '2026-11-03', '2026-11-20', exitOn(120, { 100: { PE: 0.05 }, 95: { PE: 0.4 } }));
  assert.ok(r.pnl < -3000 && r.pnl > -3600, `never worse than the cost and the charges: ${r.pnl}`);
  assert.equal(ft.closeSpread(spread(), '2026-11-03', '2026-11-20', exitOn(45, {})), null, 'a 55% move = an adjusted contract');
});

test('at most 3 spreads and 2 the same way, best first', () => {
  const c = (sym, strategy, score) => ({ sym, strategy, score });
  const got = ft.pickSpreads([c('A', 'put-spread', 0.5), c('B', 'put-spread', 0.4), c('C', 'put-spread', 0.3), c('D', 'call-spread', 0.2), c('E', 'call-spread', 0.1)]);
  assert.deepEqual(got.map((x) => x.sym), ['A', 'B', 'D']);
});

test('summary: totals, win rate vs the odds, without the best 2, and where the 30% stop hits', () => {
  const t = (exitDate, pnl, entryDate = '2025-01-01') => ({ exitDate, entryDate, pnl, chance: 0.4, strategy: 'put-spread' });
  const s = ft.summarise([t('2025-01-20', -2000), t('2025-01-20', -1500), t('2025-02-20', 9000), t('2025-09-20', -500, '2025-09-01')]);
  assert.equal(s.all.total, 5000);
  assert.equal(s.all.winRate, 0.25);
  assert.equal(s.all.expectedWinRate, 0.4);
  assert.equal(s.all.withoutBest2, 5000 - 9000 - -500, 'the total less the 2 best trades (9,000 and −500)');
  assert.equal(s.stoppedAt, '2025-01-20', '₹10,000 − ₹3,500 ≤ ₹7,000');
  assert.equal(s.holdout.trades, 1);
});
