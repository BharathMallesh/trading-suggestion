// Tests for the NIFTY weekly short strangle (F&O, paper only).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r32-'));
process.env.FO_STRANGLE_PATH = join(TMP, 'fo-strangle.json');
process.env.FO_STRANGLE_PAPER_PATH = join(TMP, 'fo-strangle-paper.json');
process.env.FNO_SPREADS_PATH = join(TMP, 'fno-spreads.json');
process.env.RSI_SWING_PATH = join(TMP, 'rsi-swing.json');
process.env.RSI_SWING_PAPER_PATH = join(TMP, 'rsi-swing-paper.json');
process.env.MOMENTUM10_PAPER_PATH = join(TMP, 'm10-paper.json');
process.env.STEADY_MIX_PAPER_PATH = join(TMP, 'steady-mix-paper.json');
process.env.INDIA_MIX_PAPER_PATH = join(TMP, 'india-mix-paper.json');
process.env.FO_BHAV_DIR = join(TMP, 'fo-bhav');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const f = await import('./paper-bot/fo-strangle.mjs');

// a chain around NIFTY 25,000 with strikes every 50 points
function chain(spot, expiry, prem = (k, typ) => Math.max(0, typ === 'CE' ? spot - k : k - spot) + 60) {
  const strikes = {};
  for (let k = spot - 1500; k <= spot + 1500; k += 50) strikes[k] = { CE: prem(k, 'CE'), PE: prem(k, 'PE'), ceVol: 100, peVol: 100 };
  return { underlying: spot, expiries: { [expiry]: strikes } };
}

test('strikes about 2% away, costs, lot size and margin by date', () => {
  const t = f.openTrade('2026-10-28', chain(25000, '2026-11-03'));
  assert.equal(t.callStrike, 25500);
  assert.equal(t.putStrike, 24500);
  assert.equal(t.expiry, '2026-11-03');
  assert.equal(t.lot, 65);
  assert.equal(t.margin, 25000 * 0.15);
  assert.ok(t.costs > 1 && t.costs < 3, 'a few points of costs for two legs');
  assert.equal(f.lotOn('2020-03-13'), 75);
  assert.equal(f.marginPct('2024-01-01'), 13);
  assert.equal(f.openTrade('2019-03-01', { underlying: null, expiries: chain(11000, '2019-03-07').expiries }, f.RULES, 11000).callStrike, 11200, 'older files: NIFTY close as the spot');
});

test('settling: both expire, one side breached; marking an open week', () => {
  const t = f.openTrade('2026-10-28', chain(25000, '2026-11-03'));
  const calm = f.settle(t, 25100);
  assert.equal(calm.breached, null);
  assert.ok(Math.abs(calm.pts - (t.credit - t.costs)) < 1e-9, 'keeps the whole premium less costs');
  const crash = f.settle(t, 23000);
  assert.equal(crash.breached, 'put');
  assert.ok(Math.abs(crash.pts - (t.credit - 1500 - t.costs)) < 1e-9);
  assert.ok(crash.retOnMargin < -0.3);
  const marked = f.markOpen({ ...t, open: true }, '2026-10-30', chain(25000, '2026-11-03', () => 10));
  assert.equal(marked.markDate, '2026-10-30');
  assert.ok(marked.pts > 0, 'premiums fell to 10 points each → a paper gain');
});

test('summary: win rate, worst week, account growth with idle cash', () => {
  const t = f.openTrade('2026-10-28', chain(25000, '2026-11-03'));
  const weeks = [f.settle(t, 25000), f.settle({ ...t, entryDate: '2026-11-04', expiry: '2026-11-10' }, 25050), f.settle({ ...t, entryDate: '2026-11-11', expiry: '2026-11-17' }, 23500)];
  const s = f.summarise(weeks);
  assert.equal(s.trades, 3);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  assert.equal(s.worst.date, '2026-11-11');
  assert.ok(s.accountMaxDrawdown > 0);
  assert.equal(s.breaches, 1);
});

test('backtest from cached NSE days: one strangle per weekly cycle, settled at NIFTY close', async () => {
  const dir = process.env.FO_BHAV_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-09-30.json'), JSON.stringify(chain(25000, '2026-10-06')));
  writeFileSync(join(dir, '2026-10-01.json'), JSON.stringify(chain(25100, '2026-10-06'))); // mid-week: no second trade
  writeFileSync(join(dir, '2026-10-07.json'), JSON.stringify(chain(25200, '2026-10-13')));
  const closes = { '2026-09-30': 25000, '2026-10-01': 25100, '2026-10-06': 25150, '2026-10-07': 25200, '2026-10-13': 26000 };
  const loadCandles = async () => Object.entries(closes).map(([date, close]) => ({ date, close }));
  const r = await f.foStrangleTest({ loadCandles, now: new Date('2026-10-20T12:00:00Z') });
  assert.equal(r.all.trades, 2);
  assert.equal(r.recent[0].breached, 'call', 'NIFTY +3.2% past the call strike');
  assert.equal(r.recent[1].breached, null);
  assert.ok(r.worstWeeks[0].rsAtTodaysSize < 0);
});

test('paper record: waits for the next cycle, opens after expiry, marks, settles; never asks NSE before 8 PM', async () => {
  const days = {
    '2026-10-23': chain(25000, '2026-10-27'),
    '2026-10-26': chain(25000, '2026-10-27'),
    '2026-10-28': chain(25000, '2026-11-03'),
    '2026-10-29': chain(25000, '2026-11-03', () => 20),
  };
  const asked = [];
  const getDay = async (d) => { asked.push(d); return days[d] || null; };
  const closes = { '2026-10-23': 25000, '2026-10-27': 25010, '2026-10-28': 25000, '2026-11-03': 25060 };
  const loadCandles = async () => Object.entries(closes).map(([date, close]) => ({ date, close }));
  // Fri 23 Oct, 21:00 IST: start; the cycle in progress (expiry 27 Oct) is skipped
  await f.foStranglePaperUpdate({ loadCandles, getDay, now: new Date('2026-10-23T15:30:00Z') });
  let st = JSON.parse(readFileSync(process.env.FO_STRANGLE_PAPER_PATH, 'utf8'));
  assert.equal(st.trades.length, 0);
  assert.equal(st.waitAfter, '2026-10-27');
  // Thu 29 Oct, 16:05 IST: only up to Wed 28 Oct is asked → opens on 28 Oct
  asked.length = 0;
  await f.foStranglePaperUpdate({ loadCandles, getDay, now: new Date('2026-10-29T10:35:00Z') });
  assert.ok(!asked.includes('2026-10-29'), 'today is not asked before 8 PM');
  st = JSON.parse(readFileSync(process.env.FO_STRANGLE_PAPER_PATH, 'utf8'));
  assert.equal(st.trades.length, 1);
  assert.equal(st.trades[0].entryDate, '2026-10-28');
  assert.equal(st.trades[0].open, true);
  // Wed 4 Nov: marked on 29 Oct and settled at the 3 Nov close
  const r = await f.foStranglePaperUpdate({ loadCandles, getDay, now: new Date('2026-11-04T10:35:00Z') });
  st = JSON.parse(readFileSync(process.env.FO_STRANGLE_PAPER_PATH, 'utf8'));
  assert.equal(st.trades[0].open, false);
  assert.equal(st.trades[0].settle, 25060);
  assert.equal(r.summary.trades, 1);
});

test('consumers: comparison row, evening line, weekly row, daily results', async () => {
  const t = f.settle(f.openTrade('2026-10-28', chain(25000, '2026-11-03')), 25000);
  const fp = { startedAt: '2026-10-23', lastDataDate: '2026-11-03', trades: [t], status: { message: 'No position.' } };
  const { compareStrategies } = await import('./paper-bot/compare.mjs');
  const c = compareStrategies({ vwap: null, vp: null, ath: null, ap: null, bf: null, bp: null, sv: null, dip: null, dp: null, fo: { from: '2019-03-01', to: '2026-10-19', all: { trades: 10, winRate: 0.8, avgRsNowLot: 800, tStat: 1, accountCagr: 0.09, accountMaxDrawdown: 0.44 }, early: { tStat: 0.4 }, later: { tStat: 2.4 }, niftyCagr: 0.117, marginNow: 220000, worstWeeks: [{ entryDate: '2020-03-13', retOnMarginPct: -77, rsAtTodaysSize: -170000 }] }, fp });
  const row = c.rows.find((x) => x.key === 'fo');
  assert.equal(row.reliable, false);
  assert.match(row.backtest, /-77% of margin/);
  const { eveningLines } = await import('./paper-bot/evening.mjs');
  const line = eveningLines('2026-11-03', { vwap: { trades: [] }, breakfast: null, swing: null, dip: null, fo: fp }).find((l) => l.title === 'NIFTY short strangle');
  assert.match(line.short, /^Strangle: week \+₹/);
  const w = await import('./paper-bot/weekly.mjs');
  const rows = w.strategyWeek(null, w.isoWeek('2026-11-03'), { swing: null, breakfast: null, dip: null, fo: fp });
  assert.equal(rows.find((x) => x.key === 'fo-strangle').weekTrades, 1);
  const { dayResults } = await import('./paper-bot/day-results.mjs');
  const dr = dayResults('2026-11-03', { vwap: { trades: [] }, breakfast: { trades: [] }, swing: { trades: [] }, dip: null, fo: fp });
  assert.equal(dr.fo.settled.length, 1);
});
