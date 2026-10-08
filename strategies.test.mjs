// Tests for strategy backtests (paper-bot/strategies.mjs) and the forward-test
// paper accounts (paper-bot/strategy-accounts.mjs). Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-strat-'));
process.env.STRATEGY_ACCOUNTS_PATH = join(TMP, 'accounts.json');
process.env.INDEX_LIST_DIR = TMP;
after(() => rmSync(TMP, { recursive: true, force: true }));

const { stats, trendStrategy, momentumStrategy } = await import('./paper-bot/strategies.mjs');
const { rebalanceAccounts, resetAccounts } = await import('./paper-bot/strategy-accounts.mjs');
const { orderCharges } = await import('./paper-bot/costs.mjs');

const day = (i) => new Date(Date.UTC(2015, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('stats: CAGR, drawdown and Sharpe on a known curve', () => {
  const curve = Array.from({ length: 253 }, (_, i) => ({ date: day(i), equity: 100 * 1.1 ** (i / 252) }));
  curve[100].equity = curve[99].equity * 0.8; // one-day 20% dip, then recovery path resumes
  const s = stats(curve);
  assert.ok(Math.abs(s.cagrPct - 10) < 0.5, `cagr ${s.cagrPct}`);
  assert.ok(s.maxDrawdownPct > 19 && s.maxDrawdownPct < 21);
});

test('trend filter sidesteps a long crash and lowers drawdown', () => {
  // up 400 days, crash 40% over 200 days, recover over 400 days
  const closes = [];
  let c = 100;
  for (let i = 0; i < 1000; i++) {
    c *= i < 400 ? 1.0015 : i < 600 ? 0.9975 : 1.0013;
    closes.push({ date: day(i), close: c });
  }
  const r = trendStrategy(closes, { monthEnd: false });
  assert.ok(r.all.maxDrawdownPct < r.benchmark.all.maxDrawdownPct * 0.7, `${r.all.maxDrawdownPct} vs ${r.benchmark.all.maxDrawdownPct}`);
  assert.ok(r.pctTimeInvested < 90 && r.switchesPerYear > 0);
});

test('momentum beats the equal-weight control only when winners keep winning', () => {
  const mk = (drift, seed) => {
    let x = seed;
    const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    let c = 100;
    const rows = [];
    for (let i = 0; i < 700; i++) {
      c *= 1 + drift + (rnd() - 0.5) * 0.02;
      rows.push({ date: day(i), close: c });
    }
    return rows;
  };
  const toSeries = (rows, sym) => ({ symbol: sym, dates: rows.map((r) => r.date), closes: rows.map((r) => r.close), at: new Map(rows.map((r, k) => [r.date, k])) });
  const index = mk(0.0003, 99);
  const persistent = Array.from({ length: 60 }, (_, k) => toSeries(mk((k - 30) * 0.00004, k + 1), `S${k}`));
  const mom = momentumStrategy(persistent, index, { variant: 'B1', capital: 1e7 });
  const ew = momentumStrategy(persistent, index, { variant: 'EW', capital: 1e7 });
  assert.ok(mom.all.cagrPct > ew.all.cagrPct, `momentum ${mom.all.cagrPct} vs EW ${ew.all.cagrPct}`);
  assert.ok(mom.chargesPctPerYear > 0 && mom.turnoverPerYear > 0);
});

test('ETF orders pay ETF STT, far below stock delivery', () => {
  const rt = (product) => orderCharges({ side: 'buy', value: 1e5, product }).total + orderCharges({ side: 'sell', value: 1e5, product }).total;
  assert.ok(rt('etf') < 50 && rt('delivery') > 230);
});

test('forward-test accounts: buy-and-hold once, filters hold cash in a downtrend, monthly cadence', async () => {
  // NIFTY falling below its 200-day average; ETF and 12 stocks with 2y of data
  const down = Array.from({ length: 450 }, (_, i) => ({ date: day(i), close: 30000 - i * 15 }));
  const flat = (p) => Array.from({ length: 450 }, (_, i) => ({ date: day(i), close: p * (1 + i * 0.001) }));
  const load = async (s) => (s === '^NSEI' ? down : s === 'NIFTYBEES.NS' ? flat(250) : flat(1000));
  const fetchFn = async () => ({ ok: false });
  void fetchFn;
  resetAccounts(1e6);
  const now = new Date('2026-10-08T06:00:00Z');
  const r = await rebalanceAccounts({ now, loadCandles: load });
  const by = Object.fromEntries(r.accounts.map((a) => [a.key, a]));
  assert.equal(by.nifty.holdings[0].symbol, 'NIFTYBEES.NS');
  assert.equal(by.trend.holdings.length, 0, 'trend in liquid fund below the 200-day average');
  assert.equal(by.momentum.holdings.length, 0, 'momentum all cash under the market filter');
  const again = await rebalanceAccounts({ now: new Date('2026-10-09T06:00:00Z'), loadCandles: load });
  assert.equal(again.actions.length, 0, 'no trades again within the same month');
  assert.ok(again.accounts.find((a) => a.key === 'trend').cash > 1e6, 'cash accrues the liquid-fund rate');
  assert.throws(() => resetAccounts(5000), /between/);
});
