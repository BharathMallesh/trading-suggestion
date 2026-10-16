// Tests for corporate-action detection in the survivorship-free NSE history when the
// stock also moved a lot on the ex-date (bhav-history.mjs actionFactor / adjust).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionFactor, adjust } from './paper-bot/bhav-history.mjs';

const row = (date, open, close, prev, high = Math.max(open, close), low = Math.min(open, close)) => ({ date, open, high, low, close, prev, val: 1 });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('CANBK-style 5:1 split: opens on the ratio, closes 5% above it, PREVCLOSE unadjusted', () => {
  const rows = [row('2024-05-13', 552, 549.35, 548.15), row('2024-05-14', 555.4, 566.55, 549.35), row('2024-05-15', 116.25, 119, 566.55, 119.6, 116), row('2024-05-16', 120.35, 113.7, 119)];
  assert.ok(near(actionFactor(rows[1], rows[2]), 0.2));
  const adj = adjust(rows);
  assert.ok(near(adj[1].close, 566.55 * 0.2), 'earlier prices divided by 5');
  assert.ok(adj[2].close / adj[1].close > 1, 'ex-date shows the real +5% day, not a −79% crash');
  assert.equal(adj[3].close, 113.7, 'prices after the ex-date untouched');
});

test('IEX-style 2:1 bonus (price ÷ 3): opens near a third, closes 5% above it', () => {
  const p = row('2021-12-02', 718, 729.55, 729.95);
  const r = row('2021-12-03', 247.55, 255.75, 729.55, 279.65, 246.25);
  assert.ok(near(actionFactor(p, r), 1 / 3));
});

test('COCHINSHIP-style 1:1 bonus: opens near half, closes 20% higher at the upper circuit', () => {
  const p = row('2024-01-09', 1301, 1338, 1293.65);
  const r = row('2024-01-10', 677, 802.8, 1338, 802.8, 675.1);
  assert.ok(near(actionFactor(p, r), 0.5));
  const adj = adjust([p, r]);
  assert.ok(near(adj[0].close, 669));
});

test('Aarti-style 1:1 bonus opening 4.7% above half; HDFC-style 5:1 split opening 4.7% above a fifth', () => {
  assert.ok(near(actionFactor(row('2019-09-26', 1629.85, 1602.9, 1619.75), row('2019-09-27', 839, 813.3, 1602.9)), 0.5));
  assert.ok(near(actionFactor(row('2010-08-17', 3100, 3110, 3090), row('2010-08-18', 651, 642, 3110)), 0.2));
  // TITAN-style 10:1 split with a 1:1 bonus the same day
  assert.ok(near(actionFactor(row('2011-06-22', 4400, 4400, 4380), row('2011-06-23', 215, 233, 4400)), 0.05));
});

test('genuine crashes and ordinary days are NOT adjusted', () => {
  const p = row('2024-03-01', 100, 100, 99);
  // a −20% crash at the lower band (nearest ratio 3/4 is 6.7% away from the open)
  assert.equal(actionFactor(p, row('2024-03-04', 80, 80, 100)), 1);
  const crash = adjust([p, row('2024-03-04', 80, 80, 100)]);
  assert.equal(crash[0].close, 100, 'earlier prices unchanged');
  // opens −18%, slides to −35% intraday close (close near 2/3 but the open is not)
  assert.equal(actionFactor(p, row('2024-03-04', 82, 65, 100)), 1);
  // opens near half but the close is far from it: not a clean split day
  assert.equal(actionFactor(p, row('2024-03-04', 50, 70, 100)), 1);
  // opens −22% / −28%: within 4% of a 1:3 bonus (3/4), but that ratio needs the open within 3%
  assert.equal(actionFactor(p, row('2024-03-04', 78, 76, 100)), 1);
  assert.equal(actionFactor(p, row('2024-03-04', 72, 70, 100)), 1);
  // …while a real 1:3 bonus with a 2% move still counts
  assert.ok(near(actionFactor(p, row('2024-03-04', 76.5, 77, 100)), 0.75));
  assert.equal(actionFactor(p, row('2024-03-04', 101, 99, 100)), 1);
});

test('no inference across a long suspension; NSE-adjusted PREVCLOSE still wins', () => {
  assert.equal(actionFactor(row('2009-01-02', 50, 50, 50), row('2009-05-07', 20, 21, 50)), 1);
  // newer files: NSE adjusts PREVCLOSE itself, even for a non-standard ratio
  assert.ok(near(actionFactor(row('2024-01-01', 1000, 1000, 1000), row('2024-01-02', 300, 330, 300)), 0.3));
});
