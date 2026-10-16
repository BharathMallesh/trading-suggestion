// Tests for Home → Daily results (one day's paper trades across all three strategies).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r26-'));
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
process.env.BREAKFAST_PAPER_PATH = join(TMP, 'breakfast-paper.json');
process.env.NIFTY_DIP_PAPER_PATH = join(TMP, 'nifty-dip-paper.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { dayResults } = await import('./paper-bot/day-results.mjs');
const vwap = { updatedAt: '2026-10-15T10:35:00Z', trades: [
  { variant: 'video', date: '2026-10-15', symbol: 'TRENT.NS', side: 'long', net: -1132, charges: 90, reason: 'stop', seenLive: true },
  { variant: 'video', date: '2026-10-14', symbol: 'TITAN.NS', side: 'long', net: 900, charges: 90, reason: 'target' },
  { variant: 'scanner', date: '2026-10-15', symbol: 'ICICIBANK.NS', side: 'long', net: 1800, charges: 90, reason: 'target' },
] };
const breakfast = { updatedAt: '2026-10-15T10:36:00Z', trades: [{ date: '2026-10-15', symbol: 'TECHM.NS', side: 'long', sector: 'IT', net: 4621, charges: 224, reason: 'target' }, { date: '2026-10-14', symbol: 'TCS.NS', side: 'long', net: -5360, charges: 221, reason: 'stop' }] };
const swing = { updatedAt: '2026-10-15T10:35:00Z', trades: [
  { version: 'improved', symbol: 'TATACONSUM.NS', setup: 'oversold base breakout', entryDate: '2026-10-15', exitDate: '2026-10-15', entry: 987, exit: 990.5, stop: 926.7, trail: 933.5, r: 0.02, retPct: 0.001, days: 0, open: true },
  { version: 'original', symbol: 'TATACONSUM.NS', entryDate: '2026-10-15', open: true, r: 0.02 },
] };
const scan = { date: '2026-10-15', triggered: [{ symbol: 'HDFCBANK.NS', setup: 'oversold base breakout', close: 700, stop: 674.8, riskPct: 3.6 }, { symbol: 'TATACONSUM.NS', held: true }] };

test('daily results: every strategy for one day, totals since start', () => {
  const r = dayResults('2026-10-15', { vwap, breakfast, swing, scan, swingVersion: 'improved', now: new Date('2026-10-15T11:00:00Z') });
  assert.equal(r.tradingDay, true);
  assert.equal(r.pending, false);
  const v = r.vwap.variants.find((x) => x.key === 'video');
  assert.equal(v.trades.length, 1);
  assert.equal(v.dayNet, -1132);
  assert.deepEqual(v.total, { trades: 2, net: -232 });
  assert.equal(r.vwap.variants.find((x) => x.key === 'scanner').wins, 1);
  assert.equal(r.breakfast.dayNet, 4621);
  assert.equal(r.breakfast.total.net, 4621 - 5360);
  assert.equal(r.swing.bought.length, 1, 'only the version in use');
  assert.equal(r.swing.open.length, 1);
  assert.deepEqual(r.swing.newSignals.map((x) => x.symbol), ['HDFCBANK.NS']);
  assert.deepEqual(r.swing.heldSignals, ['TATACONSUM.NS']);
  assert.deepEqual(r.dates.slice(0, 2), ['2026-10-15', '2026-10-14']);
});

test('daily results: earlier day, holidays, not yet recorded, bad date', () => {
  const r = dayResults('2026-10-14', { vwap, breakfast, swing, scan, swingVersion: 'improved' });
  assert.equal(r.vwap.variants.find((x) => x.key === 'video').dayNet, 900);
  assert.equal(r.swing.signalsChecked, false, 'the scan is for another day');
  assert.equal(r.swing.open.length, 0, 'TATACONSUM was bought the next day');
  assert.equal(r.swing.newSignals.length, 0);
  assert.match(dayResults('2026-10-20', { vwap, breakfast, swing }).note, /closed/);
  const early = dayResults('2026-10-16', { vwap, breakfast, swing, now: new Date('2026-10-16T05:00:00Z') });
  assert.equal(early.pending, true);
  assert.match(early.note, /4:05 PM/);
  assert.throws(() => dayResults('16-10-2026', { vwap }), /YYYY-MM-DD/);
});
