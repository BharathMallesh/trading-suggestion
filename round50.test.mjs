// Tests for the Imbalance swing (move → base → breakout).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r50-'));
process.env.IMBALANCE_SWING_PATH = join(TMP, 'imb.json');
process.env.IMBALANCE_SWING_PAPER_PATH = join(TMP, 'imb-paper.json');
process.env.NSE_ETF_PATH = join(TMP, 'etfs.json');
after(() => rmSync(TMP, { recursive: true, force: true }));
const im = await import('./paper-bot/imbalance-swing.mjs');

// 60 quiet days at 100 → a 10-day move to 140 on 5× volume → an 8-day quiet base 128–135 → a breakout day → a run to 180 → a fall
function build({ baseVol = 1500, giveBackLow = 128, after = 'run' } = {}) {
  const rows = [];
  let t = Date.UTC(2024, 0, 1);
  const push = (o, h, l, c, vol) => {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86400000;
    rows.push({ date: new Date(t).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, val: vol * c });
    t += 86400000;
  };
  for (let k = 0; k < 60; k++) push(100, 101, 99, 100, 1000);
  for (let k = 1; k <= 10; k++) push(100 + 4 * (k - 1), 100 + 4 * k, 99 + 4 * (k - 1), 100 + 4 * k, 5000);
  for (let k = 0; k < 8; k++) push(132, 135, k === 4 ? giveBackLow : 130, 132, baseVol);
  push(133, 138, 132, 137, 3000); // breakout: green, closes above 135 on 2× the base volume
  if (after === 'run') {
    for (let k = 1; k <= 20; k++) push(137 + 2 * (k - 1), 137 + 2 * k, 136 + 2 * (k - 1), 137 + 2 * k, 2000);
    for (let k = 1; k <= 30; k++) push(177 - 2 * (k - 1), 178 - 2 * (k - 1), 176 - 2 * k, 177 - 2 * k, 2000);
  } else for (let k = 1; k <= 10; k++) push(137 - 2 * k, 138 - 2 * k, 120 - k, 125 - k, 2000); // falls straight through the base low
  return rows;
}

test('setup: move on heavy volume, quiet base, breakout on rising volume — and each condition can veto it', () => {
  const bars = im.prepare(build());
  const i = 78; // the breakout day
  const s = im.setupAt(bars, i);
  assert.ok(s, 'setup found');
  assert.ok(s.movePct >= 30 && s.moveVolX >= 3);
  assert.equal(s.baseLow, 128);
  assert.equal(s.baseHigh, 135);
  assert.equal(im.setupAt(im.prepare(build({ baseVol: 4500 })), i), null, 'base volume too high: sellers pressing');
  assert.equal(im.setupAt(im.prepare(build({ giveBackLow: 115 })), i), null, 'gave back more than half the move');
  assert.ok(im.setupAt(bars, i - 1, im.RULES, { forming: true }), 'the day before: a base forming');
  assert.equal(im.setupAt(bars, i - 1), null, 'no trigger yet');
});

test('trade to lose: a winner trails up from +2R; a failed breakout loses about 1R at the base low', () => {
  const win = im.tradesFor('WIN', build());
  assert.equal(win.length, 1);
  assert.ok(win[0].r > 2, `trailed winner ${win[0].r}`);
  assert.equal(win[0].stop, 128);
  const lose = im.tradesFor('LOSE', build({ after: 'fail' }));
  assert.equal(lose.length, 1);
  assert.equal(lose[0].reason, 'initial stop');
  assert.ok(lose[0].r < -0.9 && lose[0].r > -1.6);
});

test('measures: win rate, average win ÷ loss, largest winner and the 30-loss check', () => {
  const t = (r) => ({ r, retPct: r / 10, open: false, exitDate: '2025-01-01', days: 5, reason: 'x' });
  const m = im.measures([t(3), t(-1), t(-1), t(5)]);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.winLossRatio, 4);
  assert.equal(m.bestR, 5);
  assert.equal(m.losses, 2);
  assert.equal(m.enoughLosses, false);
  assert.ok(m.skew > 0);
});
