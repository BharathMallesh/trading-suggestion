// Tests for the intraday history collector (paper-bot/collector.mjs). Offline, temp store.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-store-'));
process.env.CANDLE_STORE = TMP;
after(() => rmSync(TMP, { recursive: true, force: true }));

const { mergeBars, collect, historyCandles, readStore, backfillGroww, storeStatus } = await import('./paper-bot/collector.mjs');

const bar = (ts, c = 1) => ({ date: new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' '), ts, open: c, high: c, low: c, close: c });

test('mergeBars de-duplicates by timestamp (later source wins) and sorts', () => {
  const out = mergeBars([bar(300, 1), bar(100, 1)], [bar(300, 2), bar(200, 2)]);
  assert.deepEqual(out.map((b) => [b.ts, b.close]), [[100, 1], [200, 2], [300, 2]]);
});

test('collect grows the store across runs and never stores an in-progress bar', async () => {
  const day1 = [bar(1000), bar(1300), bar(1600)];
  const now1 = (1600 + 299) * 1000; // last 5m bar still in progress
  await collect({ symbols: ['A.NS'], intervals: ['5m'], loadCandles: async () => day1, now: now1 });
  assert.deepEqual(readStore('A.NS', '5m').map((b) => b.ts), [1000, 1300]);
  const day2 = [bar(1600), bar(1900)]; // Yahoo window moved on; older bars no longer served
  const r = await collect({ symbols: ['A.NS'], intervals: ['5m'], loadCandles: async () => day2, now: 10_000_000 });
  assert.deepEqual(readStore('A.NS', '5m').map((b) => b.ts), [1000, 1300, 1600, 1900]);
  assert.equal(r[0].added, 2);
  assert.equal(storeStatus().find((s) => s.symbol === 'A.NS').bars, 4);
});

test('historyCandles merges the store for stored intervals only', async () => {
  const fresh = async () => [bar(1900, 5), bar(2200, 5)];
  const merged = await historyCandles('A.NS', { range: '1mo', interval: '5m' }, fresh);
  assert.deepEqual(merged.map((b) => b.ts), [1000, 1300, 1600, 1900, 2200]);
  const daily = await historyCandles('A.NS', { range: '5y', interval: '1d' }, fresh);
  assert.equal(daily.length, 2);
});

test('Groww backfill converts IST times and merges without clobbering Yahoo bars', async () => {
  const session = async (sym, date, { intervalMinutes }) => [{ time: `${date} 09:15`, open: 1, high: 1, low: 1, close: 1, volume: 10 }];
  const rep = await backfillGroww({ symbols: ['B.NS', 'AAPL'], days: 3, intervals: ['15m'], session, today: new Date('2026-10-08T12:00:00Z') });
  assert.equal(rep.length, 1); // non-Indian symbols skipped
  const rows = readStore('B.NS', '15m');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ts, Math.floor(Date.parse('2026-10-05T09:15:00+05:30') / 1000));
  await assert.rejects(
    () => backfillGroww({ symbols: ['B.NS'], days: 1, session: async () => { throw new Error('Missing GROWW_ACCESS_TOKEN'); } }),
    /GROWW_ACCESS_TOKEN/,
  );
});
