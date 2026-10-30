// Tests for the NIFTY dip-buy's second, "deep dip" version (−5% in 10 sessions), recorded beside the standard one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r29-'));
process.env.NIFTY_DIP_PATH = join(TMP, 'nifty-dip.json');
process.env.NIFTY_DIP_PAPER_PATH = join(TMP, 'nifty-dip-paper.json');
process.env.FO_STRANGLE_PATH = join(TMP, 'fo-strangle.json');
process.env.FO_STRANGLE_PAPER_PATH = join(TMP, 'fo-strangle-paper.json');
process.env.FNO_SPREADS_PATH = join(TMP, 'fno-spreads.json');
process.env.RSI_SWING_PATH = join(TMP, 'rsi-swing.json');
process.env.RSI_SWING_PAPER_PATH = join(TMP, 'rsi-swing-paper.json');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const d = await import('./paper-bot/nifty-dip.mjs');

// 210 rising days, then six −1% days (≈ −5.5% over 10 sessions), then a bounce
function series(tail = [-1, -1, -1, -1, -1, -1, -0.2, 2, 0.5, 0.5, 0.2]) {
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

test('versions: deep = standard with −5% over 10 sessions; labels', () => {
  assert.equal(d.VERSIONS.standard, d.RULES);
  assert.deepEqual(d.VERSIONS.deep, { ...d.RULES, dropPct: -5, lookback: 10 });
  assert.match(d.VERSION_LABELS.standard, /−3% in 5 days/);
  assert.match(d.VERSION_LABELS.deep, /−5% in 10 days.*1 trade a year/);
  assert.equal(d.versionOf({}), 'standard', 'old trades without a version are standard');
  assert.equal(d.ofVersion([{ version: 'deep' }, {}], 'standard').length, 1);
});

test('deep signal needs a bigger, longer fall', () => {
  const rows = series();
  const std = d.simulate(rows, d.VERSIONS.standard);
  const deep = d.simulate(rows, d.VERSIONS.deep);
  assert.ok(std.length >= 1 && deep.length >= 1);
  assert.ok(deep[0].signalChangePct <= -5);
  assert.ok(deep[0].signalDate > std[0].signalDate, 'the deep version fires later in the same fall');
  // a −3.5% fall fires the standard version only
  const small = series([-0.7, -0.7, -0.7, -0.7, -0.7, 1, 1]);
  assert.ok(d.simulate(small, d.VERSIONS.standard).length >= 1);
  assert.equal(d.simulate(small, d.VERSIONS.deep).length, 0);
});

test('backtest returns both versions; top-level fields stay the standard version', async () => {
  const rows = series();
  const r = await d.niftyDipTest({ loadCandles: async () => rows, now: new Date('2026-10-16T12:00:00Z') });
  assert.deepEqual(Object.keys(r.versions), ['standard', 'deep']);
  assert.equal(r.all.trades, r.versions.standard.all.trades);
  assert.equal(r.rules.lookback, 5);
  assert.equal(r.versions.deep.rules.lookback, 10);
  assert.equal(r.versions.deep.rules.dropPct, -5);
  assert.ok(r.versions.deep.all.trades >= 1);
  assert.match(r.versions.deep.label, /Deep dip/);
  for (const k of ['train', 'test', 'portfolio', 'perYear', 'recent']) assert.ok(k in r.versions.deep, k);
  d.saveNiftyDip(r);
  assert.ok(d.loadNiftyDip().versions.deep);
});

test('status per version reports its own lookback and trigger', () => {
  const rows = series([-1, -1, -1, -1, -1, -1]);
  const deep = d.statusFrom(rows, d.simulate(rows, d.VERSIONS.deep), d.VERSIONS.deep);
  assert.equal(deep.lookback, 10);
  assert.equal(deep.dropPct, -5);
  assert.equal(deep.pendingBuy, true);
  assert.match(deep.message, /in 10 sessions/);
  const std = d.statusFrom(rows, d.simulate(rows));
  assert.equal(std.lookback, 5);
  assert.ok(Math.abs(std.triggerLevel - rows[rows.length - 5].close * 0.97) < 1e-6);
});

test('paper record keeps both versions, tags each trade, keeps old standard trades', async () => {
  const rows = series();
  // an older paper file: no versions, one standard trade without `version`
  writeFileSync(process.env.NIFTY_DIP_PAPER_PATH, JSON.stringify({ startedAt: '2025-01-01', trades: [{ entryDate: d.simulate(rows)[0].entryDate, open: false }] }));
  const p = await d.niftyDipPaperUpdate({ loadCandles: async () => rows, now: new Date('2025-08-01T12:00:00Z') });
  const saved = JSON.parse(readFileSync(process.env.NIFTY_DIP_PAPER_PATH, 'utf8'));
  assert.ok(saved.trades.every((t) => t.version === 'standard' || t.version === 'deep'));
  assert.ok(saved.trades.some((t) => t.version === 'deep'));
  assert.equal(p.summary.trades, d.summarise(d.ofVersion(saved.trades, 'standard')).trades, 'top-level summary = standard');
  assert.ok(p.versions.deep.summary.trades >= 1);
  assert.deepEqual(saved.status, saved.statuses.standard);
  assert.equal(saved.statuses.deep.lookback, 10);
  assert.ok(p.bought.every((t) => t.version === 'deep'), 'the standard trade was already recorded; only the deep one is new');
  const view = d.paperView(saved);
  assert.deepEqual(Object.keys(view.byVersion), ['standard', 'deep']);
  assert.equal(view.summary, view.byVersion.standard.summary);
  assert.equal(view.byVersion.deep.status.lookback, 10);
  assert.equal(d.paperView({ startedAt: '2026-10-16', trades: [{ entryDate: '2026-10-20', open: true }] }).trades[0].version, 'standard');
  assert.equal(d.paperView(null), null);
});

test('consumers: evening, weekly, comparison and daily results show both versions', async () => {
  const dip = {
    startedAt: '2026-10-16', updatedAt: '2026-10-27T10:40:00Z',
    trades: [
      { entryDate: '2026-10-20', exitDate: '2026-10-23', entry: 24000, open: false, retPct: 0.9, net: 900, days: 3, reason: 'bounce' },
      { version: 'deep', entryDate: '2026-10-27', entry: 23500, open: true, retPct: 0.1, net: 100, signalChangePct: -5.4 },
    ],
    status: { date: '2026-10-27', message: 'No signal.' },
    statuses: { standard: { date: '2026-10-27', message: 'No signal.' }, deep: { date: '2026-10-27', message: 'Holding' } },
  };
  const { eveningLines } = await import('./paper-bot/evening.mjs');
  const line = eveningLines('2026-10-27', { vwap: { trades: [] }, breakfast: null, swing: null, dip })[3];
  assert.equal(line.short, 'Dip-buy: deep dip (−5% in 10 days) bought NIFTY ETF at 23500');
  assert.equal(eveningLines('2026-10-23', { vwap: { trades: [] }, breakfast: null, swing: null, dip })[3].short, 'Dip-buy: sold +0.9% (+₹900)');

  const w = await import('./paper-bot/weekly.mjs');
  const rows = w.strategyWeek(null, w.isoWeek('2026-10-20'), { swing: null, breakfast: null, dip });
  const std = rows.find((x) => x.key === 'nifty-dip');
  const deep = rows.find((x) => x.key === 'nifty-dip-deep');
  assert.equal(std.weekResult, 900);
  assert.equal(std.totalTrades, 1);
  assert.equal(deep.totalTrades, 0, 'open deep trade is not counted as closed');
  assert.match(deep.trust.verdict, /about 1 a year/);

  const { compareStrategies } = await import('./paper-bot/compare.mjs');
  const bt = { from: '2008-07-08', to: '2026-10-15', all: { trades: 61 }, test: { trades: 22, winRate: 0.73, avgRetPct: 0.92, tStat: 2.5, worstPct: -3.6 }, portfolio: { cagr: 0.085, niftyCagr: 0.102, cagrAfter: 0.061, niftyAfter: 0.092, timeInMarketPct: 3.9 } };
  bt.versions = { standard: bt, deep: { perYear: 0.9, test: { trades: 7, winRate: 0.86, avgRetPct: 1.68 }, portfolio: { cagrAfter: 0.054 } } };
  const row = compareStrategies({ vwap: null, vp: null, ath: null, ap: null, bf: null, bp: null, sv: null, dip: bt, dp: dip }).rows.find((x) => x.key === 'dip');
  assert.match(row.backtest, /^2019\+: 73% won/);
  assert.match(row.backtest, /Deep dip \(−5% in 10 days\): 86% won · \+1\.68% a trade/);
  assert.match(row.money, /deep dip 5\.4% after tax/);
  assert.match(row.paper, /^1 closed · 100% won/, 'paper numbers are the standard version');

  const { dayResults } = await import('./paper-bot/day-results.mjs');
  const dr = dayResults('2026-10-27', { vwap: { trades: [] }, breakfast: { trades: [] }, swing: { trades: [] }, dip });
  assert.equal(dr.dip.bought.length, 0, 'standard: nothing bought');
  assert.equal(dr.dip.total.trades, 1);
  assert.equal(dr.dip.deep.bought.length, 1);
  assert.equal(dr.dip.deep.holding.stillOpen, true);
  assert.equal(dr.dip.deep.status.message, 'Holding');
  assert.match(dr.dip.deep.label, /Deep dip/);
});
