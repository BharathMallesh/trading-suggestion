// Tests for the strategy follow-ups: live "today's signals", the after-close
// summary, the "when can we trust it?" meter, strategy questions in Ask the
// app, and the 5-minute history gap check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r14-'));
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.CANDLE_STORE = join(TMP, 'candles');
after(() => rmSync(TMP, { recursive: true, force: true }));

const v = await import('./paper-bot/vwap-pullback.mjs');

const TIMES = [];
for (let m = 9 * 60 + 15; m <= 15 * 60 + 25; m += 5) TIMES.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
function session(date) {
  const rows = [];
  let p = 100;
  for (const t of TIMES) {
    const o = p;
    let c = p + 0.1;
    if (t === '11:00') c = p - 0.6;
    if (t > '11:00' && t < '12:00') c = p + 0.4;
    const lo = Math.min(o, c) - 0.05;
    const hi = Math.max(o, c) + 0.05;
    rows.push({ date: `${date} ${t}`, open: o, high: hi, low: t === '11:00' ? lo - 0.5 : lo, close: t === '11:00' ? p + 0.05 : c, volume: 1000 });
    p = t === '11:00' ? p + 0.05 : c;
  }
  return rows;
}

test('trust meter: early, early stop, pass, fail and unclear', () => {
  assert.equal(v.trustMeter({ trades: 0 }).verdict, 'No trades yet.');
  const early = v.trustMeter({ trades: 10, days: 6, avgNetRs: 50, tStat: 1 });
  assert.equal(early.level, 'early');
  assert.match(early.verdict, /10 of 100 trades.*ahead of break-even/);
  assert.equal(v.trustMeter({ trades: 35, days: 20, avgNetRs: -300, tStat: -2.5 }).level, 'fail', 'clear loser stops early');
  assert.equal(v.trustMeter({ trades: 120, days: 45, avgNetRs: 150, tStat: 2.3 }).level, 'pass');
  assert.equal(v.trustMeter({ trades: 120, days: 45, avgNetRs: -10, tStat: -0.3 }).level, 'fail');
  assert.equal(v.trustMeter({ trades: 120, days: 45, avgNetRs: 40, tStat: 0.8 }).level, 'unclear');
  // both conditions needed: many trades over too few days is still early
  assert.equal(v.trustMeter({ trades: 150, days: 20, avgNetRs: 200, tStat: 3 }).level, 'early');
  assert.equal(v.paperSummary({ startedAt: '2026-10-10', trades: [] }).byVariant.video.trust.level, 'early');
});

test('after-close summary: one line per version', () => {
  const st = { trades: [
    { variant: 'video', date: '2026-10-12', symbol: 'TRENT.NS', reason: 'target', net: 1900.4 },
    { variant: 'video', date: '2026-10-12', symbol: 'TITAN.NS', reason: 'stop', net: -1100 },
    { variant: 'improved', date: '2026-10-11', symbol: 'TRENT.NS', reason: 'stop', net: -900 },
  ] };
  const lines = v.closeSummary(st, '2026-10-12');
  assert.equal(lines.length, Object.keys(v.PAPER_VARIANTS).length);
  assert.equal(lines[0], 'Video rules: 2 trades +₹800 (TRENT target, TITAN stop)');
  assert.equal(lines[1], 'Improved: no trades');
});

test('today’s signals: per-stock position and each version’s trades; forming candle dropped', async () => {
  const rows = session('2026-10-12');
  const loader = async (s, o) => (o.interval === '5m' ? [...rows, { ...rows[rows.length - 1], date: '2026-10-12 15:27' }] : []);
  // a Monday after the close: not live
  const r = await v.todaySignals({ loadCandles: loader, now: new Date('2026-10-12T11:00:00Z') });
  assert.equal(r.date, '2026-10-12');
  assert.equal(r.live, false);
  assert.equal(r.lastBar, '15:25', 'the 15:27 forming candle is ignored');
  assert.ok(r.stocks.length >= 4);
  assert.equal(r.stocks[0].trend, 'up');
  assert.equal(r.variants.video.trades.length, 2, 'account limit: 2 a day');
  assert.ok(r.variants.video.trades.every((t) => t.open === false));
  // during market hours the same trade with no exit yet shows as open
  const cut = rows.filter((x) => x.date <= '2026-10-12 11:05');
  const live = await v.todaySignals({ loadCandles: async (s, o) => (o.interval === '5m' ? cut : []), now: new Date('2026-10-12T05:42:00Z') });
  assert.equal(live.live, true);
  assert.ok(live.variants.video.trades.some((t) => t.open));
  assert.equal(live.variants.video.slotsLeft, 0);
});

test('Ask the app: strategy questions are recognised and answered', async () => {
  const a = await import('./paper-bot/assistant.mjs');
  for (const q of ['How did the strategy do today?', 'any signal on trent', 'vwap pullback paper record']) {
    assert.equal(a.detectIntent(q, await a.resolveSymbol(q)), 'strategy', q);
  }
  assert.equal(a.detectIntent('tell me about trent', 'TRENT.NS'), 'stock');
  const signals = async () => ({
    date: '2026-10-12', live: true, lastBar: '11:30',
    stocks: [{ symbol: 'TRENT.NS', video: true, price: 2900, ma: 2910, vwap: 2920, trend: 'down', dailyTrend: 'up', gapPct: 1.2, inPlay: true }],
    variants: { video: { label: 'Video rules', trades: [{ symbol: 'TRENT.NS', side: 'short', time: '10:40', open: true, reason: 'close', net: 741 }] } },
  });
  const r = await a.strategyAnswer('TRENT.NS', { loadSignals: signals, loadPaper: () => ({ startedAt: '2026-10-10', byVariant: { video: { label: 'Video rules', trades: 0, trust: { verdict: 'No trades yet.' } } } }) });
  assert.match(r.summary[0], /TRENT short at 10:40 \(open\) \+₹741/);
  assert.equal(r.sections[0].rows[0][4], 'below both (shorts only)');
  assert.equal(r.sections[1].rows[0][3], 'No trades yet.');
  const other = await a.strategyAnswer('INFY.NS', { loadSignals: signals, loadPaper: () => ({ byVariant: {} }) });
  assert.match(other.summary[0], /not on the strategy's lists/);
});

test('5-minute history gaps: stale series, missing days, long breaks', async () => {
  const c = await import('./paper-bot/collector.mjs');
  const dir = join(TMP, 'candles', '5m');
  mkdirSync(dir, { recursive: true });
  const bars = (days) => days.map((d, i) => ({ ts: i, date: `${d} 09:15`, close: 1 }));
  writeFileSync(join(dir, '^NSEI.json'), JSON.stringify(bars(['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-12'])));
  writeFileSync(join(dir, 'A.NS.json'), JSON.stringify(bars(['2026-10-01', '2026-10-06', '2026-10-12'])));
  writeFileSync(join(dir, 'B.NS.json'), JSON.stringify(bars(['2026-10-05', '2026-10-06'])));
  const g = c.storeGaps('2026-10-12');
  assert.ok(g.some((x) => /3 trading days \(2026-10-07, 2026-10-08, 2026-10-09\)/.test(x)), 'missed trading days (2 Oct holiday not counted)');
  assert.ok(g.some((x) => /not updated since the last session: B\.NS/.test(x)));
  assert.ok(g.some((x) => /A\.NS missing 1 day \(2026-10-05\)/.test(x)));
  assert.ok(!g.some((x) => /B\.NS missing/.test(x)), 'days before a series started are not gaps');
  rmSync(join(TMP, 'candles'), { recursive: true, force: true });
  assert.deepEqual(c.storeGaps('2026-10-12'), []);
});
