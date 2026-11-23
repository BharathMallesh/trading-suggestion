// Tests for the Breakdown tab: the calendar buckets (weekday, week of month, month, quarter, FY quarter, year), the
// adapters on small synthetic files (odd shapes skipped with a warning, never guessed), aggregate(), the both-ways
// validation (sums match; a deliberately broken card total shows ✗), paper vs backtest, the API's filters and the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const b = await import('./paper-bot/breakdown.mjs');
const close = (a, x, eps = 1e-9) => assert.ok(Math.abs(a - x) < eps, `${a} ≈ ${x}`);

// trading days used below: 2025-03-03 Mon, 2025-03-04 Tue, 2025-04-07 Mon, 2025-07-29 Tue, 2026-01-30 Fri
const vwapTrade = (date, net, variant, side = 'long') => ({ symbol: 'TCS.NS', date, time: '10:00', side, entry: 100, stop: 99, target: 102, exit: 101, qty: 10, reason: 'target', gross: net + 50, charges: 50, net, rNet: net / 1000, rGross: (net + 50) / 1000, variant });
function fixtureDir({ brokenCard = false, junk = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bd-'));
  const w = (n, o) => writeFileSync(join(dir, n), JSON.stringify(o));
  w('vwap-paper.json', {
    startedAt: '2025-03-01', trades: [vwapTrade('2025-03-03', 1500, 'video'), vwapTrade('2025-03-04', -400, 'video', 'short'), vwapTrade('2025-04-07', 300, 'video'), vwapTrade('2025-03-03', -200, 'improved'), ...(junk ? [{ symbol: 'X', net: 5, variant: 'video' }] : [])],
  });
  w('ath-paper.json', { trades: [{ symbol: 'A.NS', entryDate: '2025-03-03', exitDate: '2025-04-07', r: 1.5, retPct: 0.1, open: false, version: 'original' }, { symbol: 'B.NS', entryDate: '2025-07-29', exitDate: null, r: 0.2, retPct: 0.01, open: true, version: 'original' }] });
  w('fo-strangle-paper.json', { trades: [{ entryDate: '2025-03-04', expiry: '2025-03-11', costs: 2, lot: 65, open: false, pts: -10, retOnMargin: -0.1, rupees: -650, rupeesNowLot: -650 }, { entryDate: '2025-03-12', expiry: '2025-03-18', costs: 2, lot: 65, open: true, pts: 5, retOnMargin: 0.05, rupees: 325, rupeesNowLot: 325 }] });
  w('india-mix-paper.json', { capital: 100000, curve: [{ date: '2025-03-03', value: 101000 }, { date: '2025-03-04', value: 99990 }, { date: '2025-04-07', value: 102000 }] });
  w('breakfast-paper.json', { trades: 'oops' }); // odd shape: skipped with a warning
  w('one-fifteen.json', { index: { '1|reversal': { all: { trades: 2, totalNetRs: 100 }, trades: [{ symbol: '^NSEI', date: '2025-03-03', side: 'short', exitDate: '2025-03-03', rNet: 0.2, net: 200 }, { symbol: '^NSEI', date: '2026-01-30', side: 'long', exitDate: '2026-01-30', rNet: -0.1, net: -100 }] } } });
  w('intraday-5y.json', { at: brokenCard ? '2025-03-01T00:00:00Z' : '2025-01-01T00:00:00Z', vwap: { video: { all: { trades: 3, total: brokenCard ? 9999 : -900 }, byYear: { 2024: { trades: 1, total: -1000 }, 2025: { trades: 2, total: 100 } } } } });
  w('breakdown-backtest.json', {
    at: '2025-02-01T00:00:00Z',
    sources: [
      { strategy: 'vwap', version: 'video', unit: '₹', rows: [{ s: 'TCS', sd: 'long', e: '2024-05-06', x: '2024-05-06', p: -1000, r: -1 }, { s: 'TCS', sd: 'short', e: '2025-03-03', x: '2025-03-03', p: -300, r: -0.3 }, { s: 'INFY', sd: 'long', e: '2025-07-29', x: '2025-07-29', p: 400, r: 0.4 }] },
      { strategy: 'ath', version: 'original', error: 'no data' },
    ],
  });
  return dir;
}

test('bucketOf: weekday, week of month (1–5), month, calendar quarter, Indian FY quarter, year', () => {
  assert.equal(b.bucketOf('2026-11-23', 'weekday').key, 'Mon');
  assert.equal(b.bucketOf('2026-11-20', 'weekday').key, 'Fri');
  assert.deepEqual(['2025-03-01', '2025-03-07', '2025-03-08', '2025-03-28', '2025-03-29', '2025-03-31'].map((d) => b.bucketOf(d, 'weekOfMonth').key), ['W1', 'W1', 'W2', 'W4', 'W5', 'W5']);
  assert.equal(b.bucketOf('2025-03-29', 'weekOfMonth').label, 'Week 5 (days 29–31)');
  assert.equal(b.bucketOf('2025-03-29', 'month').label, 'Mar');
  assert.deepEqual(['2025-01-15', '2025-03-31', '2025-04-01', '2025-12-31'].map((d) => b.bucketOf(d, 'quarter').key), ['Q1', 'Q1', 'Q2', 'Q4']);
  assert.deepEqual(['2025-04-01', '2025-06-30', '2025-07-01', '2025-12-31', '2026-01-01', '2026-03-31'].map((d) => b.bucketOf(d, 'fyQuarter').key), ['FYQ1', 'FYQ1', 'FYQ2', 'FYQ3', 'FYQ4', 'FYQ4']);
  assert.equal(b.bucketOf('2026-02-10', 'fyQuarter').label, 'FY Q4 (Jan–Mar)');
  assert.equal(b.bucketOf('2026-02-10', 'year').key, '2026');
  assert.throws(() => b.bucketOf('2026-02-10', 'hour'));
});

test('istDate: plain dates and local times pass through, UTC timestamps move to IST, junk is null', () => {
  assert.equal(b.istDate('2026-11-06'), '2026-11-06');
  assert.equal(b.istDate('2026-11-06 13:15'), '2026-11-06');
  assert.equal(b.istDate('2026-11-15T20:00:00.000Z'), '2026-11-16', '20:00 UTC = 01:30 IST the next day');
  assert.equal(b.istDate('2026-11-15T10:00:00+05:30'), '2026-11-15');
  for (const x of [null, '', 'soon', 20261106, '06-11-2026']) assert.equal(b.istDate(x), null);
});

test('adapters: rows from each shape; odd files and dateless trades skipped with a warning; curves become daily returns', () => {
  const d = b.loadAll({ dir: fixtureDir() });
  const of = (s, v, src) => d.rows.filter((r) => r.strategy === s && r.version === v && r.source === src);
  assert.equal(of('vwap', 'video', 'paper').length, 3, 'the trade without a date is skipped');
  assert.ok(d.warnings.some((w) => /vwap-paper\.json: skipped 1 vwap\/video/.test(w)));
  assert.ok(d.warnings.some((w) => /breakfast-paper\.json: unexpected shape/.test(w)), 'odd shape skipped, not guessed');
  assert.equal(of('breakfast', 'all', 'paper').length, 0);
  const v = of('vwap', 'video', 'paper')[0];
  assert.deepEqual({ symbol: v.symbol, side: v.side, entryDate: v.entryDate, exitDate: v.exitDate, pnl: v.pnl, r: v.r, gross: v.gross, charges: v.charges, open: v.open }, { symbol: 'TCS', side: 'long', entryDate: '2025-03-03', exitDate: '2025-03-03', pnl: 1500, r: 1.5, gross: 1550, charges: 50, open: false });
  const ath = of('ath', 'original', 'paper');
  assert.equal(ath.length, 2);
  assert.equal(ath.find((r) => r.open).pnl, null);
  close(ath.find((r) => !r.open).retPct, 10, 1e-9); // fraction → %
  const fo = of('fo-strangle', 'strangle', 'paper');
  assert.equal(fo[0].pnl, -650);
  assert.equal(fo[0].charges, 130);
  assert.equal(fo[0].exitDate, '2025-03-11', 'exit = expiry');
  assert.equal(fo[1].open, true);
  assert.equal(fo[1].pnl, null, 'an open position\'s mark is not a result');
  const curve = d.curves.filter((r) => r.strategy === 'india-mix');
  assert.equal(curve.length, 3);
  close(curve[0].ret, 0.01);
  close(curve[1].ret, 99990 / 101000 - 1);
  assert.equal(of('one-fifteen', 'I', 'backtest').length, 2);
  assert.equal(of('vwap', 'video', 'backtest').length, 3);
  assert.ok(d.skipped.some((s) => s.strategy === 'ath' && /build failed: no data/.test(s.why)));
});

test('aggregate: per bucket trades, won, win %, net, avg, R, best / worst, t — every grouping', () => {
  const rows = b.loadAll({ dir: fixtureDir() }).rows.filter((r) => r.strategy === 'vwap' && r.version === 'video' && r.source === 'paper');
  const wd = b.aggregate(rows, { groupBy: 'weekday' });
  assert.deepEqual(wd.buckets.map((x) => [x.key, x.trades, x.net]), [['Mon', 2, 1800], ['Tue', 1, -400]]);
  const mon = wd.buckets[0];
  assert.equal(mon.won, 2);
  assert.equal(mon.winPct, 100);
  assert.equal(mon.avg, 900);
  close(mon.avgR, 0.9);
  close(mon.totalR, 1.8);
  assert.equal(mon.best, 1500);
  assert.equal(mon.worst, 300);
  close(mon.t, 900 / (Math.sqrt(((1500 - 900) ** 2 + (300 - 900) ** 2) / 1) / Math.sqrt(2)));
  assert.equal(mon.few, true, '< 20 trades');
  assert.equal(wd.total.trades, 3);
  assert.equal(wd.total.net, 1400);
  assert.deepEqual(b.aggregate(rows, { groupBy: 'weekOfMonth' }).buckets.map((x) => [x.key, x.trades]), [['W1', 3]]);
  assert.deepEqual(b.aggregate(rows, { groupBy: 'month' }).buckets.map((x) => [x.label, x.net]), [['Mar', 1100], ['Apr', 300]]);
  assert.deepEqual(b.aggregate(rows, { groupBy: 'quarter' }).buckets.map((x) => [x.key, x.net]), [['Q1', 1100], ['Q2', 300]]);
  assert.deepEqual(b.aggregate(rows, { groupBy: 'fyQuarter' }).buckets.map((x) => [x.key, x.net]), [['FYQ1', 300], ['FYQ4', 1100]]);
  assert.deepEqual(b.aggregate(rows, { groupBy: 'year' }).buckets.map((x) => [x.key, x.net]), [['2025', 1400]]);
  // exit date instead of entry date (a swing trade bought in March, sold in April)
  const ath = b.loadAll({ dir: fixtureDir() }).rows.filter((r) => r.strategy === 'ath');
  assert.equal(b.aggregate(ath, { groupBy: 'month' }).buckets[0].label, 'Mar');
  assert.equal(b.aggregate(ath, { groupBy: 'month', dateField: 'exit' }).buckets[0].label, 'Apr');
  assert.equal(b.aggregate(ath, { groupBy: 'month' }).unit, 'R', 'no ₹ in the record: measured in R');
  assert.equal(b.aggregate(ath, { groupBy: 'month', filters: { includeOpen: true } }).total.trades, 2);
  // curve rows: days, average daily return, compounded
  const cv = b.loadAll({ dir: fixtureDir() }).curves.filter((r) => r.strategy === 'india-mix');
  const c = b.aggregate(cv, { groupBy: 'month' });
  assert.equal(c.unit, 'curve');
  assert.deepEqual(c.buckets.map((x) => [x.label, x.days]), [['Mar', 2], ['Apr', 1]]);
  close(c.total.compounded, 0.02);
  close(c.buckets[0].compounded, 99990 / 100000 - 1);
});

test('validate: every grouping adds back, weekday = month = year, counts match, total = card; a broken card total shows ✗', () => {
  const good = b.validate(b.loadAll({ dir: fixtureDir({ junk: false }) }));
  const vv = good.find((x) => x.strategy === 'vwap' && x.version === 'video' && x.source === 'paper');
  assert.equal(vv.total, 1400);
  assert.equal(vv.reported, 1400, 'from vwap-pullback paperSummary()');
  for (const g of b.GROUPS) close(vv.byGroup[g], 1400, 1e-6);
  assert.deepEqual(vv.ok, { sums: true, cross: true, counts: true, reported: true, years: null });
  const bt = good.find((x) => x.strategy === 'vwap' && x.version === 'video' && x.source === 'backtest');
  assert.equal(bt.reported, -900);
  assert.equal(bt.ok.years, true, 'matches the card\'s by-year table');
  assert.equal(bt.pass, true);
  const curve = good.find((x) => x.strategy === 'india-mix');
  assert.equal(curve.unit, 'curve');
  assert.equal(curve.pass, true);
  close(curve.byGroup.weekday, 0.02);
  assert.equal(good.find((x) => x.strategy === 'one-fifteen' && x.version === 'I').pass, true, '±₹0.50 a trade for a rounded file');
  assert.ok(good.every((x) => x.pass), JSON.stringify(good.filter((x) => !x.pass)));
  // deliberately broken: the card says 9,999
  const bad = b.validate(b.loadAll({ dir: fixtureDir({ brokenCard: true }) })).find((x) => x.strategy === 'vwap' && x.source === 'backtest');
  assert.equal(bad.ok.reported, false);
  assert.equal(bad.ok.sums, true, 'the groups still add up to the rows');
  assert.equal(bad.pass, false);
  assert.match(bad.reportedBy, /re-run after the breakdown build/);
  // a trade the adapter had to skip (no date) is still in the card's total: ✗, so a skipped trade can't hide
  const skipped = b.validate(b.loadAll({ dir: fixtureDir() })).find((x) => x.strategy === 'vwap' && x.version === 'video' && x.source === 'paper');
  assert.equal(skipped.reported, 1405);
  assert.equal(skipped.reportedTrades, 4);
  assert.equal(skipped.pass, false);
  // a hand-made series whose card count is off: counts ✗
  const d = { rows: [{ strategy: 's', version: 'v', source: 'paper', entryDate: '2025-03-03', exitDate: '2025-03-03', pnl: 10, r: null, retPct: null, open: false }], curves: [], reported: [{ strategy: 's', version: 'v', source: 'paper', unit: '₹', trades: 2, net: 10 }] };
  assert.equal(b.validate(d)[0].ok.reported, false);
});

test('compare: paper beside the backtest per bucket; a live result with the other sign is flagged as likely luck', () => {
  const rows = b.loadAll({ dir: fixtureDir() }).rows;
  const c = b.compare(rows, { groupBy: 'weekday' });
  const v = c.find((x) => x.strategy === 'vwap' && x.version === 'video');
  assert.equal(v.overall.paperTrades, 3);
  assert.equal(v.overall.backtestTrades, 3);
  close(v.overall.paperAvg, 1400 / 3, 1e-9);
  close(v.overall.backtestAvg, -300, 1e-9);
  assert.equal(v.overall.differs, true);
  assert.match(v.overall.note, /live result differs from long-run test — likely luck \/ sample size/);
  assert.deepEqual(v.buckets.map((x) => x.key), ['Mon', 'Tue']);
  assert.ok(!c.some((x) => x.strategy === 'vwap' && x.version === 'improved'), 'no backtest for that version: not compared');
});

test('API: filters by strategy, source, side, date range, exit date; bad groupBy falls back; validation stays unfiltered', () => {
  const dir = fixtureDir();
  b.clearCache();
  const q = (x) => b.breakdownQuery(x, { dir });
  const all = q({ strategy: 'vwap' });
  assert.equal(all.groupBy, 'weekday');
  assert.deepEqual(all.series.map((s) => `${s.version}/${s.source}`).sort(), ['improved/paper', 'video/backtest', 'video/paper']);
  assert.ok(all.options.vwap.versions.video.includes('backtest') && all.options.vwap.versions.video.includes('paper'));
  assert.ok(all.compare.length >= 1);
  const paper = q({ strategy: 'vwap', source: 'paper', version: 'video' });
  assert.deepEqual(paper.series.map((s) => s.source), ['paper']);
  assert.equal(paper.combined.total.net, 1400);
  assert.equal(q({ strategy: 'vwap', source: 'paper', version: 'video', side: 'short' }).series[0].total.net, -400);
  assert.equal(q({ strategy: 'vwap', source: 'paper', version: 'video', from: '2025-03-04', to: '2025-03-31' }).series[0].total.trades, 1);
  const g = q({ strategy: 'vwap', source: 'paper', version: 'video', groupBy: 'fyQuarter' });
  assert.deepEqual(g.series[0].buckets.map((x) => x.key), ['FYQ1', 'FYQ4']);
  assert.equal(q({ strategy: 'ath', dateField: 'exit', groupBy: 'month' }).series[0].buckets[0].label, 'Apr');
  assert.equal(q({ groupBy: 'minute' }).groupBy, 'weekday');
  const mixed = q({ strategy: 'vwap,india-mix,fo-strangle' });
  assert.deepEqual([...new Set(mixed.series.map((s) => s.strategy))].sort(), ['fo-strangle', 'india-mix', 'vwap']);
  assert.equal(mixed.series.find((s) => s.strategy === 'india-mix').kind, 'curve');
  assert.ok(mixed.validation.every((v) => ['vwap', 'india-mix', 'fo-strangle'].includes(v.strategy)));
  assert.equal(q({ strategy: 'vwap', from: '2030-01-01' }).validation.find((v) => v.source === 'paper' && v.version === 'video').total, 1400, 'validation ignores the filters');
  assert.ok(all.skipped.length && all.warnings.length);
  assert.match(all.note, /not investment advice/);
});

test('wiring: route, top-level tab, view, card with filters, script; every block ends with "Not advice"', () => {
  const server = readFileSync('server.mjs', 'utf8');
  assert.match(server, /url\.pathname === '\/api\/breakdown'\) return json\(res, 200, breakdownQuery\(Object\.fromEntries\(url\.searchParams\)\)\)/);
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /data-view="breakdown"[^>]*>Breakdown<\/button>/);
  for (const id of ['bdStrats', 'bdGroup', 'bdSource', 'bdVersion', 'bdSide', 'bdDate', 'bdFrom', 'bdTo', 'bdRun', 'bdOut']) assert.match(html, new RegExp(`id="${id}"`));
  for (const g of b.GROUPS) assert.match(html, new RegExp(`<option value="${g}"`));
  assert.match(html, /<script src="\/static\/js\/45-breakdown\.js"><\/script>/);
  assert.match(readFileSync('static/js/06-home-views.js', 'utf8'), /key: 'breakdown', match: \/\^Breakdown\//);
  const js = readFileSync('static/js/45-breakdown.js', 'utf8');
  assert.match(js, /lazy\('Breakdown', bdLoad\)/);
  assert.match(js, /\/api\/breakdown\?/);
  assert.match(js, /too few to judge/);
  assert.match(js, /overflow-x:auto/);
  assert.ok((js.match(/BD_NOT_ADVICE/g) || []).length >= 3 && /Not advice\./.test(js));
});
