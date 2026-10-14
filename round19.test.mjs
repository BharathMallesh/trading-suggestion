// Tests for "Analyse today": alignment, the follow-through history and the live scan.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r19-'));
process.env.TODAY_SCAN_STATS_PATH = join(TMP, 'stats.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const sc = await import('./paper-bot/today-scan.mjs');

const TIMES = [];
for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) TIMES.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
/** A steadily rising (dir 1) or falling (dir −1) session starting at `start`. */
function session(date, dir = 1, start = 100) {
  let p = start;
  return TIMES.map((t) => {
    const o = p;
    p += dir * 0.1;
    return { date: `${date} ${t}`, open: o, high: Math.max(o, p) + 0.02, low: Math.min(o, p) - 0.02, close: p, volume: 1000 };
  });
}

test('alignment: strong / partial / weak / mixed', () => {
  assert.equal(sc.alignment({ side: 1, dailyUp: true, gapPct: 0.8, niftySide: 1 }), 'strong');
  assert.equal(sc.alignment({ side: 1, dailyUp: true, gapPct: 0.1, niftySide: 1 }), 'strong', 'small morning move is neutral');
  assert.equal(sc.alignment({ side: -1, dailyUp: false, gapPct: -0.9, niftySide: null }), 'strong');
  assert.equal(sc.alignment({ side: 1, dailyUp: false, gapPct: 0.8, niftySide: 1 }), 'partial', 'daily trend against');
  assert.equal(sc.alignment({ side: 1, dailyUp: false, gapPct: -0.8, niftySide: -1 }), 'weak', 'everything against');
  assert.equal(sc.alignment({ side: 0, dailyUp: true, gapPct: 1, niftySide: 1 }), 'mixed');
});

test('check time: nearest earlier hour (10:00 before 10:00)', () => {
  assert.equal(sc.checkTimeFor('09:40'), '10:00');
  assert.equal(sc.checkTimeFor('11:55'), '11:00');
  assert.equal(sc.checkTimeFor('15:10'), '14:00');
});

test('follow-through history: trending days continue, reversing days do not; today is skipped', () => {
  // A rises steadily for two days; R rises on day 1 and until 10:30 on day 2, then falls hard
  const a = [...session('2026-10-08', 1, 100), ...session('2026-10-09', 1, 107.5)];
  const r1 = session('2026-10-08', 1, 100);
  const r2 = session('2026-10-09', 1, r1[r1.length - 1].close);
  const i = r2.findIndex((x) => x.date.endsWith('10:30'));
  let p = r2[i].close;
  for (let k = i + 1; k < r2.length; k++) {
    const o = p;
    p -= 0.3;
    r2[k] = { ...r2[k], open: o, high: o + 0.02, low: p - 0.02, close: p };
  }
  const today = session('2026-10-12', 1, 115);
  const nifty = [...session('2026-10-08', 1), ...session('2026-10-09', 1, 107.5)];
  const stats = sc.continuationStats([{ rows: [...a, ...today], daily: null }, { rows: [...r1, ...r2], daily: null }], nifty, { today: '2026-10-12' });
  const ten = stats['10:00'].all;
  assert.equal(ten.n, 2, 'day 1 has no 20-candle average yet at 10:00; today is skipped');
  assert.equal(ten.continued, 0.5, 'A kept going up, R reversed');
  assert.ok(stats['10:00'].all.avgMovePct < 0, 'R fell further than A rose');
  for (const t of sc.CHECK_TIMES) for (const l of [...sc.LEVELS, 'all']) assert.ok(stats[t][l].n >= 0);
});

test('live scan: groups, history attached, sorted by alignment', async () => {
  const loader = async (s, o) => {
    if (o.interval === '1d') return [];
    const dir = s === '^NSEI' || s.startsWith('A') || s.startsWith('B') ? 1 : -1;
    return [...session('2026-10-13', dir), ...session('2026-10-14', dir, 105)].filter((r) => r.date <= '2026-10-14 10:30');
  };
  const stats = { sessions: 40, stocks: 50, stats: Object.fromEntries(sc.CHECK_TIMES.map((t) => [t, { strong: { n: 10, continued: 0.54, avgMovePct: 0.07 }, partial: { n: 10, continued: 0.52, avgMovePct: 0.05 }, weak: { n: 10, continued: 0.5, avgMovePct: 0 }, all: { n: 30, continued: 0.52, avgMovePct: 0.04 } }])) };
  const r = await sc.todayScan({ loadCandles: loader, now: new Date('2026-10-14T05:05:00Z'), stats });
  assert.equal(r.date, '2026-10-14');
  assert.equal(r.live, true);
  assert.ok(r.stocks.length >= 4);
  assert.equal(r.nifty.trend, 'up');
  assert.equal(r.counts.up + r.counts.down + r.counts.mixed, r.stocks.length);
  const up = r.stocks.find((x) => x.trend === 'up');
  assert.equal(up.alignment, 'partial', 'trend + NIFTY agree; no daily data');
  assert.equal(up.history.checkTime, '10:00');
  assert.equal(up.history.continued, 0.52);
  const order = { strong: 0, partial: 1, weak: 2, mixed: 3 };
  for (let i = 1; i < r.stocks.length; i++) assert.ok(order[r.stocks[i - 1].alignment] <= order[r.stocks[i].alignment]);
  assert.match(r.note, /does not predict/);
});
