// Tests for the Groww long-history downloader (paper-bot/groww-history.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r63-'));
process.env.CANDLE_HIST_DIR = TMP;
process.env.GROWW_ACCESS_TOKEN = 'test-token'; // a fixed token: no login call in tests
after(() => rmSync(TMP, { recursive: true, force: true }));
const h = await import('./paper-bot/groww-history.mjs');

test('Groww candles become the store\'s bars; only regular-session bars are kept', () => {
  const b = h.toBar(['2020-11-02T09:15:00', 2027, 2027, 1990.55, 1999.75, 2419909, null]);
  assert.deepEqual(b, { date: '2020-11-02 09:15', ts: Math.floor(Date.parse('2020-11-02T09:15:00+05:30') / 1000), open: 2027, high: 2027, low: 1990.55, close: 1999.75, volume: 2419909 });
  assert.ok(h.inSession(b));
  assert.ok(!h.inSession(h.toBar(['2020-11-02T15:30:00', 1, 1, 1, 1, 1])), 'the 15:30 closing print is dropped');
  assert.equal(h.growwSymbol('TCS.NS'), 'NSE-TCS');
  assert.equal(h.growwSymbol('^NSEI'), 'NSE-NIFTY');
  assert.equal(h.growwSymbol('M&M.NS'), 'NSE-M&M');
});

test('30-day request windows cover the range without gaps', () => {
  const c = h.chunks('2020-01-01', '2020-03-15');
  assert.deepEqual(c[0], ['2020-01-01', '2020-01-30']);
  assert.deepEqual(c[1], ['2020-01-31', '2020-02-29']);
  assert.equal(c.at(-1)[1], '2020-03-15');
  for (let i = 1; i < c.length; i++) assert.equal(Date.parse(c[i][0]) - Date.parse(c[i - 1][1]), 86400000);
});

test('downloads, retries after a rate limit, saves, and resumes without re-downloading finished chunks', async () => {
  let calls = 0;
  let limited = false;
  const fake = async (url) => {
    calls++;
    if (!limited) {
      limited = true;
      return { status: 429, ok: false, json: async () => ({}) };
    }
    const q = new URL(url).searchParams;
    const day = q.get('start_time').slice(0, 10);
    return { status: 200, ok: true, json: async () => ({ payload: { candles: [[`${day}T09:15:00`, 10, 11, 9, 10.5, 100], [`${day}T09:20:00`, 10.5, 12, 10, 11, 100]] } }) };
  };
  const now = new Date('2020-03-20T12:00:00Z');
  const r = await h.backfillHistory({ symbols: ['ABC.NS'], from: '2020-01-01', now, delayMs: 0, fetchFn: fake });
  assert.equal(r[0].errors, 0);
  const bars = h.readHist('ABC.NS');
  assert.equal(bars.length, 3 * 2, '3 windows × 2 bars');
  assert.ok(limited, 'the 429 was retried');
  const before = calls;
  await h.backfillHistory({ symbols: ['ABC.NS'], from: '2020-01-01', now, delayMs: 0, fetchFn: fake });
  assert.equal(calls - before, 1, 'only the newest window (ending yesterday) is fetched again');
  assert.equal(h.readHist('ABC.NS').length, 6, 'no duplicates');
});

test('5-year test summary: totals, halves (2020–22 / 2023 →) and years', async () => {
  const { periods } = await import('./paper-bot/intraday-5y.mjs');
  const p = periods([{ date: '2021-03-01', net: 100 }, { date: '2022-05-01', net: -300 }, { date: '2024-01-02', net: 500 }]);
  assert.equal(p.all.total, 300);
  assert.equal(p.early.total, -200);
  assert.equal(p.late.trades, 1);
  assert.deepEqual(Object.keys(p.byYear), ['2021', '2022', '2024']);
  assert.equal(p.from, '2021-03-01');
});

test('a day with impossible prices is dropped (the 12 May 2025 glitch: ~100× too high)', () => {
  // one bar of the bad day is printed ~100× too high
  const day = (d, glitch = false) => [0, 1, 2].map((i) => ({ date: `${d} 09:${15 + i * 5}`, ts: i, open: 100, high: glitch && i === 1 ? 10100 : 101, low: 99, close: glitch && i === 1 ? 10000 : 100 }));
  const ok = day('2025-05-09');
  const bad = day('2025-05-12', true);
  const kept = h.cleanBars([...ok, ...bad]);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((b) => b.date.startsWith('2025-05-09')));
});
