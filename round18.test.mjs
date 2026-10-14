// Tests for the robustness fixes found when re-checking past sessions:
// daily trend with a missing daily bar, and "seen live" marking of paper trades.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r18-'));
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.VWAP_SEEN_PATH = join(TMP, 'vwap-live-seen.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const v = await import('./paper-bot/vwap-pullback.mjs');

test('daily trend works for a session whose daily bar is missing', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close: 100 + i });
  rows.push({ date: '2026-10-12', close: 90 }); // falls below the average; 13 Oct missing
  rows.push({ date: '2026-10-14', close: 95 });
  const d = v.dailyTrendLookup(rows);
  assert.equal(d.get('2026-09-30').aboveAvg20, true, 'uptrend: last close above its 20-day average');
  assert.equal(d.get('2026-10-13').aboveAvg20, false, 'missing day uses the last close before it (12 Oct)');
  assert.equal(d.get('2026-10-14').aboveAvg20, false);
  assert.equal(d.get('2026-09-10'), undefined, 'needs 20 earlier closes');
  // same answer as the old per-row rule where the row exists
  const i = rows.findIndex((r) => r.date === '2026-09-30');
  const prev = rows.slice(i - 20, i).map((r) => r.close);
  assert.equal(d.get('2026-09-30').aboveAvg20, rows[i - 1].close > prev.reduce((a, b) => a + b, 0) / 20);
});

test('seen live: snapshots record visible trades; recorded trades are marked', () => {
  const sig = { live: true, date: '2026-10-13', variants: { video: { trades: [{ symbol: 'MARUTI.NS', side: 'long', time: '10:00' }] } } };
  assert.equal(v.noteLiveSeen(sig, new Date('2026-10-13T05:00:00Z')), 1);
  assert.equal(v.noteLiveSeen(sig, new Date('2026-10-13T05:05:00Z')), 0, 'already seen');
  assert.equal(v.noteLiveSeen({ ...sig, live: false }), 0, 'after-close views are not snapshots');
  assert.equal(v.seenLiveFor({ date: '2026-10-13', variant: 'video', symbol: 'MARUTI.NS', side: 'long' }), true);
  assert.equal(v.seenLiveFor({ date: '2026-10-13', variant: 'video', symbol: 'TRENT.NS', side: 'short' }), false);
  assert.equal(v.seenLiveFor({ date: '2026-10-12', variant: 'video', symbol: 'TRENT.NS', side: 'short' }), null, 'no snapshots that day');
  const s = v.paperSummary({ startedAt: '2026-10-10', trades: [
    { variant: 'video', date: '2026-10-13', symbol: 'MARUTI.NS', side: 'long', net: -1145, gross: -1040, charges: 105, rNet: -1.1, reason: 'stop', seenLive: true },
    { variant: 'video', date: '2026-10-13', symbol: 'TITAN.NS', side: 'long', net: -1272, gross: -1170, charges: 102, rNet: -1.2, reason: 'stop', seenLive: false },
    { variant: 'video', date: '2026-10-12', symbol: 'BAJAJFINSV.NS', side: 'short', net: 1842, gross: 1947, charges: 105, rNet: 1.8, reason: 'target', seenLive: null },
  ] });
  assert.deepEqual(s.byVariant.video.live, { checked: 2, notSeen: 1, netNotSeen: -1272 });
});
