// Tests for the NSE trading calendar, the strategy section in the weekly
// scorecard, and sizing the strategy to your own capital / risk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r15-'));
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
process.env.CANDLE_STORE = join(TMP, 'candles');
process.env.MONITOR_DIR = join(TMP, 'monitor');
process.env.VWAP_PAPER_PATH = join(TMP, 'vwap-paper.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
process.env.BREAKFAST_PAPER_PATH = join(TMP, 'breakfast-paper.json');
process.env.NIFTY_DIP_PAPER_PATH = join(TMP, 'nifty-dip-paper.json');
process.env.NIFTY_DIP_PATH = join(TMP, 'nifty-dip.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const cal = await import('./paper-bot/market-calendar.mjs');
const IST = (d, hm) => new Date(`${d}T${hm}:00+05:30`);

test('calendar: weekends and NSE holidays are not trading days', () => {
  assert.equal(cal.isTradingDay('2026-10-12'), true); // Monday
  assert.equal(cal.isTradingDay('2026-10-10'), false); // Saturday
  assert.equal(cal.isTradingDay('2026-10-02'), false); // Gandhi Jayanti (Friday)
  assert.equal(cal.isTradingDay('2026-10-20'), false); // Dussehra
  assert.equal(cal.nseOpenNow(IST('2026-10-20', '11:00')), false, 'closed on a holiday');
  assert.equal(cal.nseOpenNow(IST('2026-10-21', '11:00')), true);
  assert.equal(cal.nseOpenNow(IST('2026-10-21', '15:30')), false, 'closes at 15:30');
});

test('calendar: last completed session skips holidays and weekends', () => {
  assert.equal(cal.lastSessionDate(IST('2026-10-05', '10:00')), '2026-10-01', 'Mon morning → Thu (Fri 2 Oct holiday)');
  assert.equal(cal.lastSessionDate(IST('2026-10-12', '15:31')), '2026-10-12', 'today once closed');
  assert.equal(cal.lastSessionDate(IST('2026-10-21', '09:00')), '2026-10-19', 'Dussehra skipped');
  assert.deepEqual(cal.tradingDaysBetween('2026-09-30', '2026-10-06'), ['2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06']);
});

test('calendar: NSE list is parsed (weekday holidays only) and saved over the built-in one', async () => {
  assert.equal(cal.nseDate('03-Mar-2026'), '2026-03-03');
  const fetchFn = async (url) => (url.includes('/api/')
    ? { ok: true, json: async () => ({ CM: [{ tradingDate: '05-Jan-2027', description: 'Test holiday' }, { tradingDate: '09-Jan-2027', description: 'A Saturday' }] }) }
    : { ok: false, headers: { getSetCookie: () => ['nsit=abc; Path=/', 'bm=xyz; Path=/'] } });
  const list = await cal.refreshHolidays({ fetchFn });
  assert.deepEqual(Object.keys(list), ['2027-01-05']);
  assert.equal(cal.isTradingDay('2027-01-05'), false);
  assert.equal(cal.isTradingDay('2026-10-20'), false, 'built-in list still applies');
  assert.deepEqual(JSON.parse(readFileSync(process.env.NSE_HOLIDAYS_PATH, 'utf8')).holidays, { '2027-01-05': 'Test holiday' });
  await assert.rejects(() => cal.refreshHolidays({ fetchFn: async (u) => (u.includes('/api/') ? { ok: true, json: async () => ({ CM: [] }) } : { headers: {} }) }), /empty/);
});

test('health / prediction log / monitor use the calendar', async () => {
  const h = await import('./paper-bot/health.mjs');
  assert.equal(h.lastSessionDate(IST('2026-10-05', '10:00')), '2026-10-01');
  const { nseOpen } = await import('./paper-bot/prediction-log.mjs');
  assert.equal(nseOpen(IST('2026-10-20', '11:00')), false);
  const { marketStatus } = await import('./paper-bot/monitor.mjs');
  const m = marketStatus(IST('2026-10-20', '11:00'));
  assert.equal(m.open, false);
  assert.equal(m.holiday, 'Dussehra');
});

test('gap check: holidays are not reported as missed collections', async () => {
  const c = await import('./paper-bot/collector.mjs');
  const dir = join(TMP, 'candles', '5m');
  mkdirSync(dir, { recursive: true });
  const bars = (days) => days.map((d, i) => ({ ts: i, date: `${d} 09:15`, close: 1 }));
  writeFileSync(join(dir, '^NSEI.json'), JSON.stringify(bars(['2026-09-30', '2026-10-01', '2026-10-05', '2026-10-07'])));
  const g = c.storeGaps('2026-10-07');
  assert.equal(g.length, 1);
  assert.match(g[0], /1 trading day \(2026-10-06\)/, '2 Oct (holiday) and the weekend are fine; 6 Oct is missing');
});

test('weekly scorecard: last trading day of the week, strategy section, refresh after the close', async () => {
  const w = await import('./paper-bot/weekly.mjs');
  assert.equal(w.lastTradingDayOfWeek('2026-10-09'), true); // Friday
  assert.equal(w.lastTradingDayOfWeek('2026-10-08'), false);
  assert.equal(w.lastTradingDayOfWeek('2026-10-01'), true, 'Thursday when Friday is a holiday');
  const week = w.isoWeek('2026-10-14');
  const paper = { trades: [
    { variant: 'video', date: '2026-10-12', symbol: 'A', net: 1500, gross: 1600, charges: 100, rNet: 1.5, reason: 'target' },
    { variant: 'video', date: '2026-10-13', symbol: 'B', net: -1100, gross: -1000, charges: 100, rNet: -1.1, reason: 'stop' },
    { variant: 'video', date: '2026-10-05', symbol: 'C', net: 200, gross: 300, charges: 100, rNet: 0.2, reason: '15:00' },
  ] };
  const rows = w.strategyWeek(paper, week);
  const v = rows.find((r) => r.key === 'video');
  assert.equal(v.weekTrades, 2);
  assert.equal(v.weekNetRs, 400);
  assert.equal(v.totalNetRs, 600);
  assert.equal(v.totalTrades, 3);
  const built = w.buildWeekly({ reports: [], entries: [], week, paper });
  assert.match(built.markdown, /Trading strategies \(paper\) · recorded up to 2026-10-13/);
  assert.match(built.summary, /video \+₹400/);
  // written at 15:00 Friday, then the evening's trades are added in place
  const wk = w.maybeWeekly({ entries: [], now: IST('2026-10-16', '15:05'), paper });
  assert.ok(wk);
  paper.trades.push({ variant: 'video', date: '2026-10-16', symbol: 'D', net: 900, gross: 1000, charges: 100, rNet: 0.9, reason: 'target' });
  const r = w.refreshWeeklyStrategy(paper, IST('2026-10-16', '16:10'));
  assert.equal(r.strategy.find((x) => x.key === 'video').weekNetRs, 1300);
  const md = readFileSync(join(TMP, 'monitor', 'weekly', `${week.label}.md`), 'utf8');
  assert.equal(md.split('<!-- strategy -->').length, 2, 'section replaced, not duplicated');
  assert.match(md, /recorded up to 2026-10-16/);
});

test('your size: position sizing, leverage cap, charges, validation', async () => {
  const v = await import('./paper-bot/vwap-pullback.mjs');
  const r = v.sizeTrade({ entry: 1000, stop: 990, capital: 100000, riskPct: 1 });
  assert.equal(r.side, 'long');
  assert.equal(r.qty, 100);
  assert.equal(r.target, 1020);
  assert.ok(r.lossAtStop > 1000 && r.lossAtStop < 1150, 'stop loss plus charges');
  assert.ok(r.gainAtTarget < 2000 && r.gainAtTarget > 1850);
  const capped = v.sizeTrade({ entry: 1000, stop: 999.9, capital: 100000, riskPct: 1 });
  assert.equal(capped.qty, 500, '5× leverage: ₹5 lakh / ₹1,000');
  assert.equal(capped.cappedByLeverage, true);
  assert.equal(v.sizeTrade({ entry: 1000, stop: 1010, capital: 100000, riskPct: 1 }).side, 'short');
  assert.throws(() => v.sizeTrade({ entry: 100, stop: 100 }), /different stop/);
  assert.throws(() => v.parseSizing(5000, 1), /Capital/);
  assert.throws(() => v.parseSizing(100000, 9), /Risk/);
  assert.equal(v.parseSizing(), null);
  assert.deepEqual(v.parseSizing(500000, 0.5), { capital: 500000, riskPct: 0.5, riskRs: 2500 });
  // re-sizing recorded trades: 2.5× the risk ≈ 2.5× the gross, charges recomputed
  const t = { side: 'long', entry: 1000, stop: 990, exit: 1020, qty: 100, gross: 2000, charges: 100, net: 1900 };
  const [big] = v.resizeTrades([t], { riskRs: 2500, capital: 500000 });
  assert.equal(big.qty, 250);
  assert.equal(big.gross, 5000);
  assert.ok(big.charges > 100 && big.net < 5000);
  const s = v.paperSummary({ startedAt: '2026-10-10', trades: [{ ...t, variant: 'video', date: '2026-10-12', rNet: 1.9, reason: 'target' }] }, { riskRs: 2500, capital: 500000 });
  assert.equal(s.byVariant.video.yours.trades, 1);
  assert.ok(s.byVariant.video.yours.totalNetRs > s.byVariant.video.totalNetRs);
});
