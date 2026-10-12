// Tests for round 2 of the VWAP + 20 MA pullback improvements: limit entry,
// trailing exit, volume confirmation, morning gap, trend day, the morning
// scanner paper variant and the saved-history loader.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r13-'));
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.CANDLE_STORE = join(TMP, 'candles');
after(() => rmSync(TMP, { recursive: true, force: true }));

const v = await import('./paper-bot/vwap-pullback.mjs');

const TIMES = [];
for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) TIMES.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

/**
 * One session of 5-minute bars: steady uptrend (+0.1/candle), a dip to the
 * average at 11:00, a rally to 12:00, then optionally a fall.
 */
function session(date, { start = 100, fallFrom = null, volume = () => 1000 } = {}) {
  const rows = [];
  let p = start;
  for (const t of TIMES) {
    const o = p;
    let c = p + 0.1;
    if (t === '11:00') c = p - 0.6;
    if (t > '11:00' && t < '12:00') c = p + 0.4;
    if (fallFrom && t >= fallFrom) c = p - 0.5;
    const lo = Math.min(o, c) - 0.05;
    const hi = Math.max(o, c) + 0.05;
    rows.push({ date: `${date} ${t}`, open: o, high: hi, low: t === '11:00' ? lo - 0.5 : lo, close: t === '11:00' ? p + 0.05 : c, volume: volume(t) });
    p = t === '11:00' ? p + 0.05 : c;
  }
  return rows;
}

test('base case: the video rules take one long trade on the pullback day', () => {
  const tr = v.backtestStock('X.NS', session('2026-10-12'));
  assert.equal(tr.length, 1);
  assert.equal(tr[0].side, 'long');
});

test('limit entry at the 20 MA: no fill when price never trades back through it', () => {
  // after the pullback candle the rally keeps every low above the average
  assert.equal(v.backtestStock('X.NS', session('2026-10-12'), { ...v.RULES, limitEntry: true }).length, 0);
});

test('limit entry: when filled, entry is at the limit (or a better open) with no entry slippage', () => {
  const rows = session('2026-10-12');
  const i = rows.findIndex((r) => r.date.endsWith('11:00'));
  const ma = v.indicators(rows)[i].ma;
  rows[i + 1] = { ...rows[i + 1], low: ma - 0.2 }; // next candle dips through the average
  const [t] = v.backtestStock('X.NS', rows, { ...v.RULES, limitEntry: true });
  assert.ok(t, 'filled');
  assert.ok(Math.abs(t.entry - Math.min(ma, rows[i + 1].open)) < 1e-9);
});

test('trailing exit: no fixed target; out at the next open after a close back below the MA', () => {
  const rows = session('2026-10-12', { fallFrom: '12:30' });
  const [t] = v.backtestStock('X.NS', rows, { ...v.RULES, trailMa: true });
  assert.equal(t.reason, 'trail');
  const bars = v.indicators(rows);
  const k = bars.findIndex((b) => b.date > '2026-10-12 11:30' && b.ma != null && b.close < b.ma);
  assert.ok(Math.abs(t.exit - rows[k + 1].open * (1 - v.RULES.slippagePct / 100)) < 1e-9);
  // the fixed-target version exits differently on the same day
  assert.notEqual(v.backtestStock('X.NS', rows)[0].reason, 'trail');
});

test('volume confirmation: flat volume blocks the trade; quiet pullback + busy bounce allows it', () => {
  assert.equal(v.backtestStock('X.NS', session('2026-10-12'), { ...v.RULES, volumeConfirm: true }).length, 0);
  const vol = (t) => (t >= '10:45' && t < '11:00' ? 400 : t === '11:00' ? 3000 : 1000);
  assert.equal(v.backtestStock('X.NS', session('2026-10-12', { volume: vol }), { ...v.RULES, volumeConfirm: true }).length, 1);
});

test('morning gap: trades only in the direction of the move from yesterday’s close', () => {
  const d1 = session('2026-10-09');
  const c1 = d1[d1.length - 1].close;
  const up = [...d1, ...session('2026-10-12', { start: c1 + 1.5 })];
  const down = [...d1, ...session('2026-10-12', { start: c1 - 1.5 })];
  const rules = { ...v.RULES, morningGapPct: 0.5 };
  const day2 = (tr) => tr.filter((t) => t.date === '2026-10-12');
  assert.equal(day2(v.backtestStock('X.NS', up)).length, 1, 'base rules trade day 2');
  assert.equal(day2(v.backtestStock('X.NS', up, rules)).length, 1, 'gap up allows the long');
  assert.equal(day2(v.backtestStock('X.NS', down, rules)).filter((t) => t.side === 'long').length, 0, 'gap down blocks the long');
  // first session has no previous close → no trade
  assert.equal(v.backtestStock('X.NS', d1, rules).length, 0);
});

test('trend day: needs the first 30 minutes to move enough, and no entries before 09:45', () => {
  const rows = session('2026-10-12'); // first 30 min: +0.6 on 100 = +0.6%
  const [t] = v.backtestStock('X.NS', rows, { ...v.RULES, trendDayPct: 0.5 });
  assert.ok(t && t.side === 'long' && t.time >= '09:45');
  assert.equal(v.backtestStock('X.NS', rows, { ...v.RULES, trendDayPct: 1 }).length, 0);
});

test('round 2 filters are registered and the scanner paper variant covers 20 stocks', () => {
  for (const k of v.ROUND2) assert.ok(v.FILTERS[k], k);
  assert.equal(v.PAPER_VARIANTS.scanner.stocks.length, 20);
  assert.ok(v.PAPER_VARIANTS.scanner.rules.morningGapPct > 0);
  assert.equal(v.PAPER_VARIANTS.video.stocks, undefined, 'video variant keeps the four stocks');
});

test('paper update: the scanner variant reads its own stock list', async () => {
  const seen = new Set();
  const loader = async (s, o) => {
    seen.add(s);
    return o.interval === '5m' ? session('2026-10-12') : [];
  };
  const r = await v.paperUpdate({ loadCandles: loader, now: new Date('2026-10-12T12:00:00Z') });
  assert.ok(seen.size >= 20, 'loaded every scanner stock');
  assert.ok(r.byVariant.scanner);
});

test('saved history: stored bars are merged with fresh ones (longer tests over time)', async () => {
  const c = await import('./paper-bot/collector.mjs');
  const fresh = async () => [{ ts: 300, date: '2026-10-12 09:20', close: 2 }];
  const now = 2_000_000_000_000;
  await c.collect({ symbols: ['A.NS'], intervals: ['5m'], loadCandles: async () => [{ ts: 0, date: '2026-08-01 09:15', close: 1 }], now });
  const merged = await c.historyCandles('A.NS', { interval: '5m' }, fresh);
  assert.deepEqual(merged.map((b) => b.ts), [0, 300]);
});
