// Tests for: weekly NIFTY option pricing from the measured IV ratio, the
// Indian tax ledger and after-tax backtests, tax in the forward-test
// accounts, and the daily backup. Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r9-'));
process.env.STRATEGY_ACCOUNTS_PATH = join(TMP, 'accounts.json');
process.env.BACKUP_DIR = join(TMP, 'backups');
process.env.BACKUP_MIRROR = '';
after(() => rmSync(TMP, { recursive: true, force: true }));

const { volCheck } = await import('./paper-bot/volatility.mjs');
const { optionOdds } = await import('./paper-bot/option-odds.mjs');
const { TaxLedger, TAX_RULES, fyOf } = await import('./paper-bot/tax.mjs');
const { afterTaxSingle, momentumStrategy } = await import('./paper-bot/strategies.mjs');
const { rebalanceAccounts, resetAccounts, loadAccounts } = await import('./paper-bot/strategy-accounts.mjs');
const { backup, listBackups, KEEP } = await import('./paper-bot/backup.mjs');
const { healthChecks } = await import('./paper-bot/health.mjs');

const day = (i, from = Date.UTC(2020, 0, 1)) => new Date(from + i * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------- weekly option pricing

test('weekly NIFTY options are priced at the measured fraction of VIX; monthly stay at VIX', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ date: day(i), close: 20000 * Math.exp(0.01 * Math.sin(i)) }));
  const load = async (s) => (s === '^INDIAVIX' ? [{ date: '2026-10-08', close: 20 }] : rows);
  const model = { niftyWeeklyIvToVix: { recentMedian: 0.9, recentN: 52, to: '2026-09-30' } };
  const wk = await volCheck({ symbol: '^NSEI', days: 7, loadCandles: load, model });
  assert.ok(Math.abs(wk.pricingIvPct - 18) < 1e-9);
  assert.match(wk.pricingIvSource, /0\.90 × India VIX/);
  assert.equal(wk.impliedPct, 20, 'the VIX reading itself is unchanged');
  const mo = await volCheck({ symbol: '^NSEI', days: 25, loadCandles: load, model });
  assert.equal(mo.pricingIvPct, 20);
  const vol = (days) => volCheck({ symbol: '^NSEI', days, loadCandles: load, model });
  const o = await optionOdds({ symbol: '^NSEI', type: 'CE', strike: 20000, days: 7, loadCandles: load, vol: ({ days }) => vol(days) });
  assert.equal(o.impliedVolPct, 18);
  assert.equal(o.vixPct, 20);
  assert.match(o.premiumSource, /weekly options/);
});

// ------------------------------------------------------------ tax ledger

test('FY labels follow April–March', () => {
  assert.equal(fyOf('2025-03-31'), '2024-25');
  assert.equal(fyOf('2025-04-01'), '2025-26');
});

test('STCG vs LTCG by holding period, with the exemption and new/old rates', () => {
  const L = new TaxLedger();
  L.buy('X', 100, 1000, '2025-01-10');
  L.sell('X', 50, 1200, '2025-06-01'); // < 12 months: ST gain 10,000 (after Jul-2024 rate 20%)
  L.sell('X', 50, 5000, '2026-02-01'); // > 12 months: LT gain 200,000 (12.5% above 1.25L)
  assert.equal(L.settle('2024-25'), 0);
  const tax = L.settle('2025-26');
  const want = (10000 * 0.2 + (200000 - 125000) * 0.125) * 1.04;
  assert.ok(Math.abs(tax - want) < 1e-6, `${tax} vs ${want}`);
  // old regime
  const O = new TaxLedger();
  O.buy('Y', 10, 100, '2023-01-01');
  O.sell('Y', 10, 200, '2023-06-01'); // ST 1,000 at 15%
  assert.ok(Math.abs(O.settle('2023-24') - 1000 * 0.15 * 1.04) < 1e-9);
});

test('set-off and carry-forward: ST loss offsets LT gain; LT loss only LT; losses carry forward', () => {
  const L = new TaxLedger();
  L.buy('A', 1, 1000, '2024-08-01');
  L.sell('A', 1, 600, '2025-01-01'); // ST loss 400
  L.buy('B', 1, 100, '2023-08-01');
  L.sell('B', 1, 126500, '2024-09-01'); // LT gain 126,400
  // ST loss 400 offsets LT → LT 126,000 → 1,000 above exemption
  assert.ok(Math.abs(L.settle('2024-25') - 1000 * 0.125 * 1.04) < 1e-6);
  const M = new TaxLedger();
  M.buy('C', 1, 1000, '2023-01-01');
  M.sell('C', 1, 500, '2024-05-01'); // LT loss 500
  M.buy('D', 1, 100, '2024-05-02');
  M.sell('D', 1, 400, '2024-06-01'); // ST gain 300 — LT loss can't offset it
  assert.ok(Math.abs(M.settle('2024-25') - 300 * 0.15 * 1.04) < 1e-9);
  assert.equal(M.carryLT[0].amount, 500);
  M.buy('E', 1, 0, '2023-01-01');
  M.sell('E', 1, 125000 + 700, '2025-05-01'); // LT 125,700 − 500 carried = 125,200 → 200 taxable
  assert.ok(Math.abs(M.settle('2025-26') - 200 * 0.125 * 1.04) < 1e-6);
});

test('slab tax on income, and ledger survives a save/load round trip', () => {
  const L = new TaxLedger();
  L.income(1000, '2025-05-01');
  L.buy('Z', 2, 10, '2025-05-01');
  const R = TaxLedger.from(JSON.parse(JSON.stringify(L.toJSON())));
  assert.equal(R.units('Z'), 2);
  assert.ok(Math.abs(R.settle('2025-26') - 1000 * TAX_RULES.slabRate * 1.04) < 1e-9);
});

// ----------------------------------------------------- after-tax backtests

const index = Array.from({ length: 1500 }, (_, i) => ({ date: day(i), close: 10000 * 1.0004 ** i }));

test('after tax: buy-and-hold defers gains; a strategy that switches pays more along the way', () => {
  const hold = afterTaxSingle(index, 0, index.map(() => 1), { capital: 1e6 });
  assert.ok(hold.cagrIfSoldPct < hold.cagrPct, 'selling at the end costs LTCG');
  const flip = index.map((_, k) => (Math.floor(k / 120) % 2 === 0 ? 1 : 0)); // in/out every ~4 months
  const sw = afterTaxSingle(index, 0, flip, { capital: 1e6 });
  assert.ok(sw.taxPaid > 0);
  // switching realises short-term gains early; holding pays mostly at the end
  assert.ok(sw.cagrPct < hold.cagrPct);
});

test('momentum backtest with tax returns lower CAGR and reports tax', () => {
  const dates = index.map((r) => r.date);
  const mk = (g, k) => ({ symbol: `S${k}`, dates, closes: dates.map((_, i) => 100 * (1 + g) ** i), at: new Map(dates.map((d, i) => [d, i])) });
  const series = Array.from({ length: 60 }, (_, k) => mk((k - 20) * 0.00003, k));
  const pre = momentumStrategy(series, index, { variant: 'B1', capital: 1e7 });
  const post = momentumStrategy(series, index, { variant: 'B1', capital: 1e7, tax: true });
  assert.ok(post.all.cagrPct < pre.all.cagrPct);
  assert.ok(post.taxPaidPctOfCapitalPerYear > 0 && post.cagrIfSoldPct != null);
});

// ------------------------------------------------ forward-test accounts tax

test('forward accounts: tax lots, after-tax value, and last year\'s tax paid in April', async () => {
  // NIFTY below its 200-day average → trend + momentum sit in the liquid fund (slab-taxed interest)
  const down = Array.from({ length: 450 }, (_, i) => ({ date: day(i, Date.UTC(2025, 0, 1)), close: 30000 - i * 15 }));
  let etf = 250;
  const load = async (s) => (s === '^NSEI' ? down : s === 'NIFTYBEES.NS' ? down.map((r) => ({ ...r, close: etf })) : down.map((r) => ({ ...r, close: 1000 * (1 + r.close / 1e6) })));
  resetAccounts(1e6);
  await rebalanceAccounts({ now: new Date('2026-03-02T06:00:00Z'), loadCandles: load });
  etf = 300; // the NIFTY account's ETF is up 20% (short-term gain)
  const r = await rebalanceAccounts({ now: new Date('2026-03-20T06:00:00Z'), loadCandles: load });
  const n = r.accounts.find((a) => a.key === 'nifty');
  assert.ok(n.afterTaxIfSold < n.equity, 'selling a short-term gain would cost tax');
  const gain = n.equity - 1e6;
  assert.ok(n.equity - n.afterTaxIfSold < gain * 0.25, 'tax is a fraction of the gain');
  assert.equal(loadAccounts().accounts.nifty.tax.lots['NIFTYBEES.NS'].length, 1);
  // first run of the new financial year pays last year's slab tax on liquid-fund interest
  const cashBefore = loadAccounts().accounts.trend.cash;
  await rebalanceAccounts({ now: new Date('2026-04-02T06:00:00Z'), loadCandles: load });
  const t = loadAccounts().accounts.trend;
  assert.ok(t.taxPaid > 0, 'tax on interest paid');
  assert.ok(t.trades.some((x) => x.side === 'tax' && /2025-26/.test(x.note)));
  assert.ok(t.cash < cashBefore * (1 + 0.06 * 13 / 365), 'cash reduced by the tax');
  assert.equal(t.taxFy, '2026-27');
});

// ------------------------------------------------------------------ backup

test('backup: archives the evidence, verifies, keeps the last 30, reports in health', async () => {
  const root = join(TMP, 'proj');
  mkdirSync(join(root, 'paper-bot', 'data', 'candles', '5m'), { recursive: true });
  writeFileSync(join(root, 'paper-bot', 'prediction-history.json'), '[]');
  writeFileSync(join(root, 'paper-bot', 'data', 'candles', '5m', 'X.json'), '{}');
  const s = await backup({ root, now: new Date('2026-10-08T12:00:00Z') });
  assert.ok(existsSync(s.file) && s.files >= 2);
  assert.equal(s.mirror.detail, 'off');
  // prune: create 32 old archives, back up again → 30 kept
  for (let i = 1; i <= 32; i++) writeFileSync(join(process.env.BACKUP_DIR, `trading-research-2026-08-${String(i).padStart(2, '0')}.tar.gz`.replace(/-08-3[12]/, (m) => `-07-${m.slice(-2)}`)), 'x');
  await backup({ root, now: new Date('2026-10-09T12:00:00Z') });
  assert.equal(listBackups().length, KEEP);
  assert.ok(listBackups().some((b) => b.date === '2026-10-09'));
  const base = { quoteFn: async () => ({ price: 1 }), newsProbe: async () => 1, diskFn: () => 50e9 };
  const ok = (await healthChecks({ ...base, backupFn: () => ({ at: new Date().toISOString(), bytes: 1e6, files: 9, mirror: { ok: true } }) })).checks.find((c) => c.name === 'backup');
  assert.equal(ok.level, 'ok');
  const old = (await healthChecks({ ...base, backupFn: () => ({ at: '2026-01-01T00:00:00Z', bytes: 1, files: 1, mirror: {} }) })).checks.find((c) => c.name === 'backup');
  assert.equal(old.level, 'warn');
  const none = (await healthChecks({ ...base, backupFn: () => null })).checks.find((c) => c.name === 'backup');
  assert.match(none.detail, /no backup yet/);
  assert.ok(readFileSync(join(process.env.BACKUP_DIR, 'status.json'), 'utf8').includes('"files"'));
});
