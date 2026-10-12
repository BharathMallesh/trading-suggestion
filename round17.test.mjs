// Tests for the factor lab (NSE tilts vs NIFTY 50) and "did my trading beat NIFTY?".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r17-'));
process.env.HOLDINGS_PATH = join(TMP, 'holdings.json');
process.env.FACTOR_DIR = join(TMP, 'factor-idx');
process.env.FACTOR_LAB_PATH = join(TMP, 'factor-lab.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const f = await import('./paper-bot/factor-lab.mjs');
const vi = await import('./paper-bot/vs-index.mjs');

test('factor lab: NSE names across renames, CSV parsing', () => {
  assert.equal(f.normName('CNX Nifty'), 'nifty 50');
  assert.equal(f.normName('S&P CNX Nifty'), 'nifty 50');
  assert.equal(f.normName('Nifty 50'), 'nifty 50');
  assert.equal(f.normName('CNX Alpha Index'), 'nifty alpha index');
  assert.equal(f.normName('"NIFTY100 Quality 30"'), 'nifty100 quality 30');
  const csv = 'Index Name,Index Date,Open,High,Low,Closing Index Value\nNifty 50,30-09-2026,1,1,1,22620.45\nNifty200 Momentum 30,30-09-2026,1,1,1,29518.95\nBad,30-09-2026,1,1,1,-\n';
  assert.deepEqual(f.parseIndexCsv(csv), { 'nifty 50': 22620.45, 'nifty200 momentum 30': 29518.95 });
});

test('factor lab: series building splices a rebase, stats vs NIFTY', () => {
  const snaps = [];
  for (let i = 0; i < 72; i++) {
    const y = 2015 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    const closes = { 'nifty 50': 100 * 1.01 ** i };
    // momentum: +1.5%/month, published from month 12; rebased ×10 at month 40 (rename)
    if (i >= 12) closes['nifty200 momentum 30'] = 1000 * 1.015 ** i * (i >= 40 ? 10 : 1);
    snaps.push({ date: `${y}-${m}-28`, closes });
  }
  const s = f.buildSeries(snaps);
  assert.equal(s.momentum30.length, 60, 'only published months');
  assert.ok(Math.abs(s.momentum30[28].close / s.momentum30[27].close - 1) < 1e-9, 'rebase removed (that month counted as flat)');
  const r = f.compare(s.momentum30, s.nifty50);
  assert.ok(Math.abs(r.cagr - (1.015 ** 12 - 1)) < 0.005);
  assert.ok(Math.abs(r.niftyCagr - (1.01 ** 12 - 1)) < 1e-9);
  assert.ok(r.excess > 0.06);
  assert.equal(r.roll3.pctBeat, 1);
  assert.ok(r.longestBehindMonths <= 3, 'only the flat rebase month put it briefly behind');
  assert.equal(r.maxDrawdown, 0);
  assert.equal(f.verdictFor(r), 'beat NIFTY most of the time without deeper falls');
  assert.equal(f.compare(s.momentum30.slice(0, 20), s.nifty50), null, 'needs 3+ years');
  assert.match(f.verdictFor(null), /not enough/);
  assert.equal(f.verdictFor({ excess: -0.01, roll3: { pctBeat: 0.3 }, roll5: { pctBeat: 0.2 }, maxDrawdown: 0.2, niftyMaxDrawdown: 0.3, longestBehindMonths: 50 }), 'did not beat NIFTY');
});

test('xirr: matches a simple annual return', () => {
  const r = vi.xirr([{ date: '2024-01-01', amount: -100000 }, { date: '2025-01-01', amount: 112000 }]);
  assert.ok(Math.abs(r - 0.12) < 0.002);
  assert.equal(vi.xirr([{ date: '2024-01-01', amount: -1 }]), null);
});

const flatIndexBetween = (from, to, growth) => {
  // daily rows from `from` to `to`, growing smoothly by `growth` overall
  const rows = [];
  const d0 = Date.parse(from);
  const days = (Date.parse(to) - d0) / 86400000;
  for (let k = 0; k <= days; k++) rows.push({ date: new Date(d0 + k * 86400000).toISOString().slice(0, 10), close: 100 * growth ** (k / days) });
  return vi.totalReturnIndex(rows);
};

test('compare with NIFTY: a stock that beat the index wins, one that lagged loses', () => {
  const index = flatIndexBetween('2024-01-01', '2026-01-01', 1.2); // NIFTY +20% (+ dividends)
  const buy = { symbol: 'A.NS', date: '2024-01-01', side: 'buy', qty: 100, price: 1000 };
  const win = vi.compareWithIndex({ trades: [buy], prices: { 'A.NS': 1500 }, index, today: '2026-01-01' });
  assert.equal(win.beat, true);
  assert.ok(win.pme > 1.2);
  assert.ok(win.differenceRs > 20000 && win.differenceRs < 30000, 'held ₹1.5L vs mirror ≈ ₹1.25L');
  assert.ok(win.charges > 0);
  assert.ok(win.yourXirr > win.niftyXirr);
  const lose = vi.compareWithIndex({ trades: [buy], prices: { 'A.NS': 1050 }, index, today: '2026-01-01' });
  assert.equal(lose.beat, false);
  assert.ok(lose.differenceRs < 0);
});

test('compare with NIFTY: round trips, sells without buys, unpriced stocks', () => {
  const index = flatIndexBetween('2024-01-01', '2026-01-01', 1.0);
  const trades = [
    { symbol: 'A.NS', date: '2024-01-01', side: 'buy', qty: 10, price: 100 },
    { symbol: 'A.NS', date: '2025-01-01', side: 'sell', qty: 10, price: 150 },
    { symbol: 'B.NS', date: '2025-02-01', side: 'sell', qty: 5, price: 200 }, // bought before the file
    { symbol: 'C.NS', date: '2025-03-01', side: 'buy', qty: 1, price: 50 },
  ];
  const r = vi.compareWithIndex({ trades, prices: {}, index, today: '2026-01-01' });
  assert.equal(r.skippedSells, 5);
  assert.deepEqual(r.unpriced, ['C.NS']);
  const a = r.perStock.find((s) => s.symbol === 'A.NS');
  assert.ok(a.pnl > 450 && a.pnl < 500, 'gain ₹500 minus charges');
  assert.ok(r.proceeds < 1500, 'B.NS sale not counted');
});

test('tradebook import keeps the raw trades; vs-index reads them', async () => {
  const h = await import('./paper-bot/holdings.mjs');
  const csv = 'symbol,trade_date,trade_type,quantity,price\nINFY,2024-01-10,buy,10,1500\nINFY,2024-06-10,sell,4,1600\nTCS,2024-02-01,buy,2,3800\n';
  h.importTradebook({ csv, now: new Date('2026-10-12T06:00:00Z') });
  const st = h.loadHoldings();
  assert.equal(st.trades.length, 3);
  assert.deepEqual(st.trades[0], { symbol: 'INFY.NS', date: '2024-01-10', side: 'buy', qty: 10, price: 1500 });
  const loader = async (sym, o) => {
    if (sym === '^NSEI') return [{ date: '2024-01-01', close: 100 }, { date: '2026-10-09', close: 130 }];
    return [{ date: '2026-10-09', close: sym === 'INFY.NS' ? 1700 : 4000 }];
  };
  const r = await vi.tradesVsIndex({ loadCandles: loader, now: new Date('2026-10-12T06:00:00Z') });
  assert.equal(r.trades, 3);
  assert.ok(r.openValue === 6 * 1700 + 2 * 4000);
  assert.match(r.verdict, /NIFTY/);
  const empty = await vi.tradesVsIndex({ loadCandles: loader, st: { lots: [] } });
  assert.equal(empty.empty, true);
});
