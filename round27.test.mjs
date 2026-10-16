// Tests for the NIFTY dip-buy strategy (high win rate, index ETF, paper only).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r27-'));
process.env.NIFTY_DIP_PATH = join(TMP, 'nifty-dip.json');
process.env.NIFTY_DIP_PAPER_PATH = join(TMP, 'nifty-dip-paper.json');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const d = await import('./paper-bot/nifty-dip.mjs');

// synthetic daily series: 210 rising days, then a ~3.2% dip over 5 days, then a bounce
function series(tail) {
  const rows = [];
  let px = 10000;
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 210; i++) {
    px *= 1.001;
    rows.push({ date: day(i), open: px, high: px, low: px, close: px });
  }
  for (const [k, c] of tail.entries()) {
    px *= 1 + c / 100;
    rows.push({ date: day(210 + k), open: px * (1 - c / 200), high: px, low: px, close: px });
  }
  return rows;
}

test('signal: above the 200-day average and down ≥3% in 5 sessions', () => {
  const rows = series([-0.6, -0.6, -0.6, -0.6, -0.8]);
  const s = d.signalAt(rows, rows.length - 1);
  assert.equal(s.aboveMa, true);
  assert.ok(s.changePct <= -3);
  assert.equal(s.fired, true);
  assert.equal(d.signalAt(series([-0.5, -0.5, -0.5, -0.5, -0.5]), 214).fired, false, 'only −2.5%');
  assert.equal(d.signalAt(rows.slice(0, 150), 149), null, 'needs 200 days');
});

test('trade: buy next open, sell at the first close above the 5-day average, ETF costs', () => {
  const rows = series([-0.6, -0.6, -0.6, -0.6, -0.8, -0.2, 2, 0.5, 0.5]);
  const [t] = d.simulate(rows);
  assert.equal(t.signalDate, rows[214].date, 'first day the 5-session fall reaches 3%');
  assert.equal(t.entryDate, rows[215].date);
  assert.equal(t.reason, 'bounce');
  assert.equal(t.exitDate, rows[217].date, 'close above the 5-day average on day 2 → sell next open');
  assert.ok(t.charges > 0 && t.charges < 150, 'ETF charges on ₹1 lakh are small');
  assert.ok(Math.abs(t.net - (t.gross - t.charges)) < 1e-6);
  assert.equal(t.open, false);
});

test('trade: time exit after the 10th session; open and pending positions', () => {
  const down = series([-0.6, -0.6, -0.6, -0.6, -0.8, ...Array(12).fill(-0.3)]);
  const [t] = d.simulate(down);
  assert.equal(t.reason, '10 days');
  assert.equal(t.days, 10);
  const open = d.simulate(series([-0.6, -0.6, -0.6, -0.6, -0.8, -0.3, -0.3]));
  assert.equal(open[0].open, true);
  const pend = d.simulate(series([-0.6, -0.6, -0.6, -0.6, -0.8]));
  assert.equal(pend[0].pending, true, 'signal on the last close → buy at the next open');
  const st = d.statusFrom(series([-0.6, -0.6, -0.6, -0.6, -0.8]), pend);
  assert.equal(st.pendingBuy, true);
  assert.match(st.message, /buys at the next open/);
});

test('summary, portfolio vs NIFTY and tax', () => {
  const trades = [
    { open: false, net: 1000, retPct: 1, days: 3, entryDate: '2025-01-10', exitDate: '2025-01-14', reason: 'bounce' },
    { open: false, net: -500, retPct: -0.5, days: 10, entryDate: '2025-06-10', exitDate: '2025-06-24', reason: '10 days' },
    { open: false, net: 800, retPct: 0.8, days: 4, entryDate: '2025-09-10', exitDate: '2025-09-15', reason: 'bounce' },
  ];
  const s = d.summarise(trades);
  assert.equal(s.trades, 3);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  assert.equal(s.worstPct, -0.5);
  assert.equal(s.profitFactor, 1800 / 500);
  assert.deepEqual(s.exits, { bounce: 2, timeout: 1 });
  const rows = Array.from({ length: 366 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: 100 + i * 0.03 }));
  const p = d.portfolio(rows, trades, '2025-01-01');
  assert.ok(p.cagr > 0.06 && p.cagr < 0.09, 'cash yield plus ~1.3% from trades');
  assert.ok(p.cagrAfter < p.cagr);
  assert.ok(p.niftyAfter < p.niftyCagr);
  assert.ok(p.timeInMarketPct < 10);
});

test('backtest and paper record from a candle loader (no network)', async () => {
  const rows = series([-0.6, -0.6, -0.6, -0.6, -0.8, -0.2, 2, 0.5, 0.5, 0.2]);
  const loadCandles = async () => rows;
  const r = await d.niftyDipTest({ loadCandles, now: new Date('2026-10-16T12:00:00Z') });
  assert.equal(r.all.trades, 1);
  d.saveNiftyDip(r);
  assert.equal(d.loadNiftyDip().all.trades, 1);
  const p = await d.niftyDipPaperUpdate({ loadCandles, now: new Date('2025-01-01T12:00:00Z') });
  assert.equal(p.startedAt, '2025-01-01');
  assert.equal(p.summary.trades, 1);
  assert.equal(JSON.parse(readFileSync(process.env.NIFTY_DIP_PAPER_PATH, 'utf8')).trades.length, 1);
  assert.ok(p.status.message);
});

test('evening line, weekly row, comparison and daily results include the dip-buy', async () => {
  const dip = { startedAt: '2026-10-16', updatedAt: '2026-10-20T10:40:00Z', trades: [{ entryDate: '2026-10-20', entry: 24000, open: true, retPct: 0.2, net: 200 }], status: { date: '2026-10-20', message: 'Holding' } };
  const { eveningLines } = await import('./paper-bot/evening.mjs');
  const line = eveningLines('2026-10-20', { vwap: { trades: [] }, breakfast: null, swing: null, dip })[3];
  assert.equal(line.short, 'Dip-buy: bought NIFTY ETF at 24000');
  const w = await import('./paper-bot/weekly.mjs');
  const rows = w.strategyWeek(null, w.isoWeek('2026-10-20'), { swing: null, breakfast: null, dip: { trades: [{ open: false, exitDate: '2026-10-21', net: 900, retPct: 0.9, days: 3 }] } });
  assert.equal(rows.find((x) => x.key === 'nifty-dip').weekResult, 900);
  const { compareStrategies } = await import('./paper-bot/compare.mjs');
  const c = compareStrategies({ vwap: null, vp: null, ath: null, ap: null, bf: null, bp: null, sv: null, dip: { from: '2008-07-08', to: '2026-10-15', all: { trades: 61 }, test: { trades: 22, winRate: 0.73, avgRetPct: 0.92, tStat: 2.5, worstPct: -3.6 }, portfolio: { cagr: 0.085, niftyCagr: 0.102, cagrAfter: 0.061, niftyAfter: 0.092, timeInMarketPct: 3.9 } }, dp: null });
  const row = c.rows.find((x) => x.key === 'dip');
  assert.match(row.backtest, /73% won/);
  assert.equal(row.reliable, false);
  const { dayResults } = await import('./paper-bot/day-results.mjs');
  const dr = dayResults('2026-10-20', { vwap: { trades: [] }, breakfast: { trades: [] }, swing: { trades: [] }, dip });
  assert.equal(dr.dip.bought.length, 1);
  assert.equal(dr.dip.holding.stillOpen, true);
});
