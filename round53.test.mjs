// Tests for the swing entry timing test (open vs opening-range breakout).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r53-'));
process.env.SWING_ORB_PATH = join(TMP, 'orb.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const so = await import('./paper-bot/swing-orb.mjs');

// 5-minute bars from 9:15: [open, high, low, close]
const day = (ohlc) => ohlc.map(([o, h, l, c], i) => {
  const m = 15 + 5 * i;
  return { hm: `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, open: o, high: h, low: l, close: c };
});

test('enters on the first break above the 10-minute high (with buffer and slippage)', () => {
  const r = so.orbEntry(day([[100, 102, 99, 101], [101, 103, 100, 102], [102, 102.5, 101, 102], [102, 104, 101.5, 103.5]]), 95);
  assert.equal(r.time, '09:30');
  assert.ok(Math.abs(r.entry - 103 * 1.0005 * 1.001) < 1e-9);
  assert.equal(r.orHigh, 103);
});

test('skips when the range breaks down first, never breaks, or only after 2:30', () => {
  assert.match(so.orbEntry(day([[100, 102, 99, 101], [101, 103, 100, 102], [101, 101.5, 98, 98.5], [99, 104, 98, 103]]), 95).skip, /broke down/);
  const flat = day(Array.from({ length: 70 }, () => [101, 102, 100, 101]));
  assert.match(so.orbEntry(flat, 95).skip, /never broke/);
  const late = day(Array.from({ length: 70 }, (_, i) => (i === 64 ? [101, 110, 100, 109] : [101, 102, 100, 101]))); // 64th bar = 14:35
  assert.match(so.orbEntry(late, 95).skip, /never broke/);
});

test('summary: skipped trades count as 0 R for the opening-range version', () => {
  const s = so.summary({ trades: {
    a: { open: false, rOpen: -1, rOrb: null, orb: { skip: 'x' } },
    b: { open: false, rOpen: 2, rOrb: 1.6, orb: { entry: 1 } },
    c: { open: true, rOpen: 0.3, rOrb: 0.2, orb: { entry: 1 } },
  } });
  assert.equal(s.closed, 2);
  assert.equal(s.atOpen.avgR, 0.5);
  assert.equal(s.orb.avgR, 0.8);
  assert.equal(s.orb.skipped, 1);
  assert.equal(s.skippedAtOpenR, -1);
});
