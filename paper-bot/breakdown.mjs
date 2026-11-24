#!/usr/bin/env node
// Breakdown (library + CLI): every strategy's BACKTEST and PAPER results in one table, by weekday, week of the month
// (days 1–7 = week 1 … 29–31 = week 5), month, calendar quarter, Indian financial-year quarter (Apr–Jun = FY Q1) and year.
//
// - Adapters turn each strategy's own file into plain rows
//     { strategy, version, source: 'backtest' | 'paper', symbol, side, entryDate, exitDate, pnl, r, retPct, gross, charges, open }
//   (₹ after costs where the file has them; R = multiples of the risk taken; retPct in %). Accounts kept as a value
//   curve become daily-return rows { strategy, version, source, date, ret }. A file or a trade whose shape is not the
//   one expected is skipped with a warning — never guessed.
// - Every number is checked both ways (validate): each grouping adds back to the ungrouped total and to the total the
//   strategy's own card shows (its own summary function, or its saved backtest file), weekday = month = year totals,
//   and the trade counts match. Paper is set beside the backtest for the same strategy and bucket (compare).
// - The backtest files mostly keep summaries only, so `--build` re-runs the backtests with their own exported code and
//   saves the individual trades (paper-bot/data/breakdown-backtest.json); validation then checks those trades against
//   the summary each card shows, so a stale or different build shows ✗.
// Dates are IST calendar dates (the files store them that way); trading days from market-calendar.mjs.
// Paper research only — not investment advice.
//
//   node --max-old-space-size=12000 paper-bot/breakdown.mjs --build   # re-run the backtests and save their trades (~2–5 min)
//   node paper-bot/breakdown.mjs                                      # print the validation table

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { paperSummary as vwapPaperSummary } from './vwap-pullback.mjs';
import { summarise as bfSummarise } from './breakfast.mjs';
import { paperSummary as oneFifteenPaperSummary } from './one-fifteen.mjs';
import { summarise as foSummarise } from './fo-strangle.mjs';
import { summarise as athSummarise } from './ath-swing.mjs';
import { summarise as rsiSummarise } from './rsi-swing.mjs';
import { paperView as dipPaperView, versionOf as dipVersionOf } from './nifty-dip.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = () => process.env.BREAKDOWN_DATA_DIR || join(HERE, 'data');
export const BUILT_FILE = 'breakdown-backtest.json';

export const STRATEGIES = {
  vwap: 'YouTube intraday (VWAP)', breakfast: 'Breakfast', 'one-fifteen': '1:15 PM reversal', 'fo-strangle': 'NIFTY strangle / condor',
  'fo-spread': 'F&O spreads (₹10,000 practice)', 'rsi-swing': 'RSI swing', ath: 'Strong-stock swing', 'imbalance-swing': 'Imbalance swing',
  'e2-swing': 'Momentum breakout', 'lbb-swing': 'Leader box breakout', 'bonus-runup': 'Bonus/split run-up', 'ipo-apply': 'IPO apply',
  'nifty-dip': 'NIFTY dip-buy', 'ml-picks': 'ML stock picks', 'india-mix': 'India mix', 'steady-mix': 'Steady mix', momentum10: 'Momentum 10',
  momentum: 'Momentum 20', 'global-mix': 'Global mix', finalist2: 'Finalist 2',
};
export const GROUPS = ['weekday', 'weekOfMonth', 'month', 'quarter', 'fyQuarter', 'year'];
export const MIN_TRADES = 20; // fewer trades in a bucket: "too few to judge"
export const SMALL_SAMPLE = 100; // paper trades below this: a gap to the backtest is most likely luck (the app's trust meter also wants 100 trades)

// ------------------------------------------------------------------ dates and buckets ---
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
/** An IST calendar date (YYYY-MM-DD) from 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM' or an ISO timestamp; null if not a date. */
export function istDate(x) {
  const s = String(x ?? '');
  if (/^\d{4}-\d\d-\d\d(?:$|[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$)/.test(s)) return s.slice(0, 10); // already a local (IST) date / time
  if (/^\d{4}-\d\d-\d\dT.*(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t + 19800_000).toISOString().slice(0, 10) : null;
  }
  return null;
}
/** The bucket of a date for a grouping → { key, label, order }. */
export function bucketOf(date, groupBy) {
  const [y, m, d] = date.split('-').map(Number);
  switch (groupBy) {
    case 'weekday': {
      const w = DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
      return { key: w, label: w, order: DAY_ORDER[w] };
    }
    case 'weekOfMonth': {
      const w = Math.ceil(d / 7);
      return { key: `W${w}`, label: `Week ${w} (days ${(w - 1) * 7 + 1}–${w === 5 ? '31' : w * 7})`, order: w };
    }
    case 'month':
      return { key: String(m).padStart(2, '0'), label: MONTHS[m - 1], order: m };
    case 'quarter': {
      const q = Math.ceil(m / 3);
      return { key: `Q${q}`, label: `Q${q} (${MONTHS[(q - 1) * 3]}–${MONTHS[q * 3 - 1]})`, order: q };
    }
    case 'fyQuarter': {
      const q = m >= 4 ? Math.ceil((m - 3) / 3) : 4; // Indian FY: Apr–Jun = Q1 … Jan–Mar = Q4
      const first = [3, 6, 9, 0][q - 1];
      return { key: `FYQ${q}`, label: `FY Q${q} (${MONTHS[first]}–${MONTHS[first + 2]})`, order: q };
    }
    case 'year':
      return { key: String(y), label: String(y), order: y };
    default:
      throw new Error(`unknown groupBy: ${groupBy}`);
  }
}

// ------------------------------------------------------------------------ adapters ---
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const SYM = (s) => String(s ?? '').replace(/\.NS$/, '');
/** A trade row from a raw trade, or null when it has no valid date or no result at all. */
function makeRow(base, t) {
  const entryDate = istDate(t.entryDate);
  const exitDate = istDate(t.exitDate) || (t.open ? null : entryDate);
  const row = {
    strategy: base.strategy, version: String(base.version), source: base.source, symbol: SYM(t.symbol), side: t.side || null,
    entryDate, exitDate, pnl: num(t.pnl), r: num(t.r), retPct: num(t.retPct), gross: num(t.gross), charges: num(t.charges), open: !!t.open,
  };
  if (!row.entryDate) return null;
  if (!row.open && row.pnl == null && row.r == null && row.retPct == null) return null;
  return row;
}
/** Collects rows for one source; counts what it had to skip. */
function collector(out, file) {
  return (base, raw, map) => {
    let bad = 0;
    for (const t of raw) {
      const row = t && typeof t === 'object' ? makeRow(base, map(t)) : null;
      if (row) out.rows.push(row);
      else bad++;
    }
    if (bad) out.warnings.push(`${file}: skipped ${bad} ${base.strategy}/${base.version} trade(s) without a valid date or result`);
  };
}
/** Daily-return rows from a value curve [{ date, value }], starting from `base` (the capital). */
function curveRows(out, file, meta, curve, valueKey, base) {
  if (!Array.isArray(curve)) return out.warnings.push(`${file}: no curve array — skipped`);
  if (!curve.length) return out.skipped.push({ file, strategy: meta.strategy, version: meta.version, source: meta.source, why: 'no daily values yet' });
  let prev = num(base);
  let bad = 0;
  const rows = [];
  for (const [i, c] of curve.entries()) {
    const date = istDate(Array.isArray(c) ? c[0] : c?.date);
    const v = num(Array.isArray(c) ? c[1] : c?.[valueKey]);
    if (!date || v == null || v <= 0) { bad++; continue; }
    if (prev == null) { prev = v; continue; } // no starting capital: the first value is the base
    rows.push({ strategy: meta.strategy, version: String(meta.version), source: meta.source, date, ret: v / prev - 1, value: v, ...(i === 0 ? { fromStart: true } : {}) });
    prev = v;
  }
  if (bad) out.warnings.push(`${file}: skipped ${bad} curve point(s) without a date / value`);
  out.curves.push(...rows);
  const first = num(base) ?? num(Array.isArray(curve[0]) ? curve[0][1] : curve[0]?.[valueKey]);
  return first;
}
const report = (out, r) => out.reported.push(r);

/** Each adapter: (json, out, file) → fills out.rows / out.curves / out.reported. `paper` adapters read *-paper.json. */
export const PAPER_ADAPTERS = {
  'vwap-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const add = collector(out, f);
    const versions = [...new Set(st.trades.map((t) => t.variant || 'video'))];
    for (const v of versions) add({ strategy: 'vwap', version: v, source: 'paper' }, st.trades.filter((t) => (t.variant || 'video') === v), (t) => ({ ...t, entryDate: t.date, exitDate: t.date, pnl: t.net, r: t.rNet }));
    const sum = vwapPaperSummary(st).byVariant;
    for (const [v, s] of Object.entries(sum)) report(out, { strategy: 'vwap', version: v, source: 'paper', unit: '₹', trades: s.trades || 0, net: s.totalNetRs || 0, by: 'vwap-pullback.mjs paperSummary()' });
    if (st.revisedOnly?.length) out.skipped.push({ file: f, strategy: 'vwap', version: 'revisedOnly', source: 'paper', why: `${st.revisedOnly.length} "revised rules only" trades are a side list, not part of any version's record` });
  },
  'breakfast-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    collector(out, f)({ strategy: 'breakfast', version: 'all', source: 'paper' }, st.trades, (t) => ({ ...t, entryDate: t.date, exitDate: t.date, pnl: t.net }));
    const s = bfSummarise(st.trades);
    report(out, { strategy: 'breakfast', version: 'all', source: 'paper', unit: '₹', trades: s.trades || 0, net: s.totalNetRs || 0, by: 'breakfast.mjs summarise()' });
  },
  'one-fifteen-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const ver = (t) => (t.symbol === '^NSEI' ? 'I' : t.version);
    const add = collector(out, f);
    for (const v of [...new Set(st.trades.map(ver))]) add({ strategy: 'one-fifteen', version: v, source: 'paper' }, st.trades.filter((t) => ver(t) === v), (t) => ({ ...t, entryDate: t.date, exitDate: t.exitDate || t.date, pnl: t.net, r: t.rNet }));
    for (const [v, s] of Object.entries(oneFifteenPaperSummary(st).byVersion)) report(out, { strategy: 'one-fifteen', version: v, source: 'paper', unit: '₹', trades: s.trades || 0, net: s.totalNetRs || 0, by: 'one-fifteen.mjs paperSummary()' });
  },
  'fo-strangle-paper.json': (st, out, f) => foPaper(st, out, f, 'strangle'),
  'fo-condor-paper.json': (st, out, f) => foPaper(st, out, f, 'condor'),
  'spread-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    collector(out, f)({ strategy: 'fo-spread', version: 'rules', source: 'paper' }, st.trades, (t) => ({ ...t, side: t.strategy, exitDate: t.settleDate, pnl: t.open ? null : t.pnl, charges: t.entryCharges }));
    report(out, { strategy: 'fo-spread', version: 'rules', source: 'paper', unit: '₹', trades: st.summary?.closed ?? 0, net: st.summary?.realised ?? 0, by: 'spread-paper.json summary (the card)' });
  },
  'rsi-swing-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const add = collector(out, f);
    for (const v of [...new Set(st.trades.map((t) => t.version || 'b'))]) {
      const list = st.trades.filter((t) => (t.version || 'b') === v);
      add({ strategy: 'rsi-swing', version: v, source: 'paper' }, list, (t) => ({ ...t, retPct: num(t.retPct) != null ? t.retPct * 100 : null }));
      const s = rsiSummarise(list);
      report(out, { strategy: 'rsi-swing', version: v, source: 'paper', unit: 'R', trades: s.trades || 0, totalR: s.trades ? s.avgR * s.trades : 0, by: 'rsi-swing.mjs summarise()' });
    }
  },
  'ath-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const add = collector(out, f);
    for (const v of [...new Set(st.trades.map((t) => t.version || 'original'))]) {
      const list = st.trades.filter((t) => (t.version || 'original') === v);
      add({ strategy: 'ath', version: v, source: 'paper' }, list, (t) => ({ ...t, side: 'long', retPct: num(t.retPct) != null ? t.retPct * 100 : null }));
      const s = athSummarise(list);
      report(out, { strategy: 'ath', version: v, source: 'paper', unit: 'R', trades: s.trades || 0, totalR: s.trades ? s.avgR * s.trades : 0, by: 'ath-swing.mjs summarise() (the card)' });
    }
  },
  'imbalance-swing-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const add = collector(out, f);
    for (const v of [...new Set(st.trades.map((t) => t.version || 'original'))]) add({ strategy: 'imbalance-swing', version: v, source: 'paper' }, st.trades.filter((t) => (t.version || 'original') === v), (t) => ({ ...t, side: 'long', retPct: num(t.retPct) != null ? t.retPct * 100 : null }));
    for (const [v, s] of Object.entries(st.byVersion || {})) report(out, { strategy: 'imbalance-swing', version: v, source: 'paper', unit: 'R', trades: s.trades || 0, totalR: s.trades ? s.avgR * s.trades : 0, by: 'imbalance-swing-paper.json byVersion (the card)' });
  },
  'e2-swing-paper.json': (st, out, f) => swingAccount(st, out, f, 'e2-swing'),
  'lbb-swing-paper.json': (st, out, f) => swingAccount(st, out, f, 'lbb-swing'),
  'bonus-runup-paper.json': (st, out, f) => {
    if (!Array.isArray(st.closed)) throw new Error('no closed array');
    collector(out, f)({ strategy: 'bonus-runup', version: 'paper', source: 'paper' }, [...st.closed, ...(st.open || []).map((p) => ({ ...p, open: true }))], (t) => ({ ...t, side: 'long', pnl: t.open ? null : t.pnl }));
    report(out, { strategy: 'bonus-runup', version: 'paper', source: 'paper', unit: '₹', trades: st.summary?.closed ?? 0, net: st.summary?.realised ?? 0, by: 'bonus-runup-paper.json summary (the card)' });
    accountCurve(st, out, f, 'bonus-runup', 'value', st.rules?.capital);
  },
  'ipo-apply-paper.json': (st, out, f) => {
    if (!st.applications || typeof st.applications !== 'object') throw new Error('no applications');
    const apps = Object.values(st.applications);
    const settled = apps.filter((a) => a.status === 'settled');
    const pending = apps.filter((a) => !['settled', 'no listing', 'no data'].includes(a.status));
    collector(out, f)({ strategy: 'ipo-apply', version: 'expected', source: 'paper' }, [...settled, ...pending.map((a) => ({ ...a, open: true }))], (a) => ({ symbol: a.symbol, side: 'long', entryDate: a.closeDate, exitDate: a.listingDate, pnl: a.open ? null : a.expPnl, open: a.open }));
    report(out, { strategy: 'ipo-apply', version: 'expected', source: 'paper', unit: '₹', trades: st.totals?.settled ?? 0, net: st.totals?.expected?.pnl ?? 0, by: 'ipo-apply-paper.json totals.expected (expected value, the card)' });
  },
  'nifty-dip-paper.json': (st, out, f) => {
    if (!Array.isArray(st.trades)) throw new Error('no trades array');
    const add = collector(out, f);
    for (const v of [...new Set(st.trades.map(dipVersionOf))]) add({ strategy: 'nifty-dip', version: v, source: 'paper' }, st.trades.filter((t) => dipVersionOf(t) === v), (t) => ({ ...t, symbol: 'NIFTYBEES', side: 'long', pnl: t.open ? null : t.net }));
    for (const [v, x] of Object.entries(dipPaperView(st).byVersion)) report(out, { strategy: 'nifty-dip', version: v, source: 'paper', unit: '₹', trades: x.summary.trades || 0, net: x.summary.totalNetRs || 0, by: 'nifty-dip.mjs paperView()' });
  },
  'ml-picks-paper.json': (st, out, f) => accountCurve(st, out, f, 'ml-picks', 'value', st.capital, st.value),
  'india-mix-paper.json': (st, out, f) => accountCurve(st, out, f, 'india-mix', 'value', st.capital),
  'steady-mix-paper.json': (st, out, f) => accountCurve(st, out, f, 'steady-mix', 'value', st.capital),
  'momentum10-paper.json': (st, out, f) => accountCurve(st, out, f, 'momentum10', 'value', st.capital),
  'momentum-paper.json': (st, out, f) => accountCurve(st, out, f, 'momentum', 'value', st.capital),
  'global-mix-paper.json': (st, out, f) => accountCurve(st, out, f, 'global-mix', 'value', st.capital),
  'finalist2-paper.json': (st, out, f) => accountCurve(st, out, f, 'finalist2', 'value', st.capital),
};
function foPaper(st, out, f, version) {
  if (!Array.isArray(st.trades)) throw new Error('no trades array');
  collector(out, f)({ strategy: 'fo-strangle', version, source: 'paper' }, st.trades, (t) => {
    const charges = num(t.costs) != null && num(t.lot) != null ? t.costs * t.lot : null;
    return { symbol: 'NIFTY', side: 'short', entryDate: t.entryDate, exitDate: t.expiry, open: t.open, pnl: t.open ? null : t.rupees, charges, gross: !t.open && charges != null && num(t.rupees) != null ? t.rupees + charges : null, retPct: num(t.retOnMargin) != null ? t.retOnMargin * 100 : null };
  });
  const s = foSummarise(st.trades);
  report(out, { strategy: 'fo-strangle', version, source: 'paper', unit: '₹', trades: s.trades || 0, net: s.totalRs || 0, by: 'fo-strangle.mjs summarise() (the card)' });
}
function swingAccount(st, out, f, strategy) {
  if (!Array.isArray(st.closed)) throw new Error('no closed array');
  collector(out, f)({ strategy, version: 'paper', source: 'paper' }, [...st.closed, ...(st.open || []).map((p) => ({ ...p, open: true }))], (t) => ({ ...t, side: 'long', pnl: t.open ? null : t.pnl, r: t.open ? null : t.r }));
  report(out, { strategy, version: 'paper', source: 'paper', unit: '₹', trades: st.summary?.closed ?? 0, net: st.summary?.realised ?? 0, tolerance: Math.max(1, 0.5 * (st.summary?.closed ?? 0)), by: `${f} summary (the card; ₹ rounded per trade)` });
  accountCurve(st, out, f, strategy, 'equity', st.rules?.capital);
}
/** A paper account kept as a value curve: daily-return rows, and the card's "value now vs capital". */
function accountCurve(st, out, f, strategy, key, capital, valueNow = null) {
  const meta = { strategy, version: 'account', source: 'paper' };
  if (num(capital) == null) return out.warnings.push(`${f}: no starting capital — curve skipped`);
  curveRows(out, f, meta, st.curve, key, capital);
  const last = num(valueNow) ?? num(st.curve?.at?.(-1)?.[key]);
  if (st.curve?.length && last != null) report(out, { ...meta, unit: 'curve', days: st.curve.length, compounded: last / capital - 1, by: valueNow != null ? `${f} value / capital (the card)` : `${f} last curve value / capital (the card)` });
}

/** Backtests whose trades are saved in their own files, and the built file (re-run backtests, see buildBacktest). */
export const BACKTEST_ADAPTERS = {
  'one-fifteen.json': (d, out, f) => {
    if (!d.index || typeof d.index !== 'object') throw new Error('no index section');
    for (const [k, x] of Object.entries(d.index)) {
      if (!Array.isArray(x.trades)) { out.warnings.push(`${f}: index ${k} has no trades — skipped`); continue; }
      const version = k === '1|reversal' ? 'I' : `I:${k}`;
      collector(out, f)({ strategy: 'one-fifteen', version, source: 'backtest' }, x.trades, (t) => ({ ...t, symbol: 'NIFTY', entryDate: t.date, exitDate: t.exitDate || t.date, pnl: t.net, r: t.rNet }));
      report(out, { strategy: 'one-fifteen', version, source: 'backtest', unit: '₹', trades: x.all?.trades ?? 0, net: x.all?.totalNetRs ?? 0, tolerance: Math.max(1, 0.5 * x.trades.length), by: `${f} index.${k}.all (the card; file keeps ₹ rounded per trade)` });
    }
    out.skipped.push({ file: f, strategy: 'one-fifteen', version: 'V / S (stocks)', source: 'backtest', why: 'the file keeps summaries only for the stock versions — their trades come from the --build run' });
  },
  'fo-stock-test.json': (d, out, f) => {
    if (!d.variants || typeof d.variants !== 'object') throw new Error('no variants');
    for (const [v, x] of Object.entries(d.variants)) {
      if (!Array.isArray(x.trades)) { out.warnings.push(`${f}: variant ${v} has no trades — skipped`); continue; }
      collector(out, f)({ strategy: 'fo-spread', version: v, source: 'backtest' }, x.trades, (t) => ({ ...t, side: t.strategy }));
      report(out, { strategy: 'fo-spread', version: v, source: 'backtest', unit: '₹', trades: x.all?.trades ?? 0, net: x.all?.total ?? 0, by: `${f} variants.${v}.all (the card)` });
    }
  },
  'momentum.json': (d, out, f) => {
    if (!d.methods || typeof d.methods !== 'object') throw new Error('no methods');
    for (const [m, x] of Object.entries(d.methods)) {
      if (!Array.isArray(x.curve) || x.curve.length < 2) { out.warnings.push(`${f}: method ${m} has no curve — skipped`); continue; }
      const meta = { strategy: 'momentum', version: `method ${m} (monthly)`, source: 'backtest' };
      const base = curveRows(out, f, meta, x.curve, 1, null);
      const last = num(x.curve.at(-1)[1]);
      if (base && last) report(out, { ...meta, unit: 'curve', days: x.curve.length - 1, compounded: last / base - 1, by: `${f} methods.${m}.curve, first → last value` });
    }
  },
  [BUILT_FILE]: (d, out, f, { read }) => {
    if (!Array.isArray(d.sources)) throw new Error('no sources array');
    for (const s of d.sources) {
      if (s.error) { out.skipped.push({ file: f, strategy: s.strategy, version: s.version, source: 'backtest', why: `build failed: ${s.error}` }); continue; }
      if (!Array.isArray(s.rows)) { out.warnings.push(`${f}: ${s.strategy}/${s.version} has no rows — skipped`); continue; }
      collector(out, f)({ strategy: s.strategy, version: s.version, source: 'backtest' }, s.rows, (t) => ({ symbol: t.s, side: t.sd, entryDate: t.e, exitDate: t.x, pnl: t.p, r: t.r, retPct: t.rp, gross: t.g, charges: t.c, open: t.o }));
      const card = CARD_TOTALS[`${s.strategy}|${s.version}`];
      const c = card ? card(read) : null;
      if (c) report(out, { strategy: s.strategy, version: s.version, source: 'backtest', ...c, builtAt: d.at, cardAt: c.at });
      else report(out, { strategy: s.strategy, version: s.version, source: 'backtest', unit: s.unit, missing: true, by: 'no saved card total to compare with' });
    }
  },
};
/** The total each backtest card shows, from its own saved file (what the --build trades must add up to). */
const CARD_TOTALS = {
  ...Object.fromEntries(['video', 'improved', 'scanner'].map((v) => [`vwap|${v}`, (read) => { const d = read('intraday-5y.json'); const a = d?.vwap?.[v]; return a?.all ? { unit: '₹', trades: a.all.trades, net: a.all.total, byYear: a.byYear, at: d.at, by: `intraday-5y.json vwap.${v} (the 5-year card)` } : null; }])),
  'breakfast|all': (read) => { const d = read('intraday-5y.json'); const a = d?.breakfast; return a?.all ? { unit: '₹', trades: a.all.trades, net: a.all.total, byYear: a.byYear, at: d.at, by: 'intraday-5y.json breakfast (the 5-year card)' } : null; },
  ...Object.fromEntries(['V', 'S'].map((v) => [`one-fifteen|${v}`, (read) => { const d = read('one-fifteen.json'); const a = d?.results?.[`${v}|3|reversal`]?.account; return a?.all ? { unit: '₹', trades: a.all.trades, net: a.all.totalNetRs, at: d.at, by: `one-fifteen.json results.${v}|3|reversal.account (the card)` } : null; }])),
  ...Object.fromEntries(['standard', 'deep'].map((v) => [`nifty-dip|${v}`, (read) => { const d = read('nifty-dip.json'); const a = d?.versions?.[v]?.all; return a ? { unit: '₹', trades: a.trades, net: a.totalNetRs, at: d.at, by: `nifty-dip.json versions.${v}.all (the card)` } : null; }])),
  'fo-strangle|strangle': (read) => { const d = read('fo-strangle.json'); return d?.all ? { unit: '₹', trades: d.all.trades, net: d.all.totalRs, at: d.at, by: 'fo-strangle.json all (the card)' } : null; },
  'fo-strangle|condor': (read) => { const d = read('fo-strangle.json'); return d?.condor?.all ? { unit: '₹', trades: d.condor.all.trades, net: d.condor.all.totalRs, at: d.at, by: 'fo-strangle.json condor.all (the card)' } : null; },
  'ath|original': (read) => { const d = read('ath-swing.json'); return d?.all ? { unit: 'R', trades: d.all.trades, totalR: d.all.avgR * d.all.trades, at: d.at, by: 'ath-swing.json all (the card)' } : null; },
  'ath|wide': (read) => { const d = read('ath-swing.json'); const a = d?.wideTrail?.all; return a ? { unit: 'R', trades: a.trades, totalR: a.avgR * a.trades, at: d.at, by: 'ath-swing.json wideTrail.all (the card)' } : null; },
  ...Object.fromEntries(['original', 'nobe'].map((v) => [`imbalance-swing|${v}`, (read) => { const d = read('imbalance-swing.json'); const a = d?.versions?.[v]?.all; return a ? { unit: 'R', trades: a.trades, totalR: a.avgR * a.trades, at: d.at, by: `imbalance-swing.json versions.${v}.all (the card)` } : null; }])),
  ...Object.fromEntries(['a', 'b', 'c', 'd'].map((v) => [`rsi-swing|${v}`, (read) => { const d = read('rsi-swing.json'); const a = d?.results?.[`long-${v}`]?.all; return a ? { unit: 'R', trades: a.trades, totalR: a.trades ? a.avgR * a.trades : 0, at: d.at, by: `rsi-swing.json results.long-${v}.all (the card)` } : null; }])),
};

/** Read every source in `dir` → { rows, curves, reported, warnings, skipped, files: { name: mtimeMs } }. */
export function loadAll({ dir = DATA_DIR() } = {}) {
  const out = { rows: [], curves: [], reported: [], warnings: [], skipped: [], files: {} };
  const cache = new Map();
  const read = (name) => {
    if (cache.has(name)) return cache.get(name);
    let v = null;
    try {
      v = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      v = null;
    }
    cache.set(name, v);
    return v;
  };
  for (const [name, adapter] of [...Object.entries(PAPER_ADAPTERS), ...Object.entries(BACKTEST_ADAPTERS)]) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      if (name === BUILT_FILE) out.skipped.push({ file: name, strategy: 'several', version: '', source: 'backtest', why: 'not built yet: run node --max-old-space-size=12000 paper-bot/breakdown.mjs --build' });
      continue;
    }
    out.files[name] = statSync(p).mtimeMs;
    const d = read(name);
    if (!d || typeof d !== 'object') { out.warnings.push(`${name}: not readable JSON — skipped`); continue; }
    try {
      adapter(d, out, name, { read });
    } catch (err) {
      out.warnings.push(`${name}: unexpected shape (${err.message}) — skipped`);
    }
  }
  for (const name of ['intraday-5y.json', 'intraday-test.json', 'fo-intraday-test.json', 'steady-mix.json', 'india-mix.json', 'momentum10.json', 'fno-spreads.json', 'matrix-calendar.json']) {
    if (existsSync(join(dir, name))) out.files[name] = statSync(join(dir, name)).mtimeMs;
  }
  out.skipped.push(
    { file: 'fo-intraday-test.json', strategy: 'fo-strangle', version: 'intraday variants', source: 'backtest', why: 'keeps yearly summaries only (no individual trades or dates)' },
    { file: 'intraday-test.json', strategy: 'direction test', version: '', source: 'backtest', why: 'an up / down prediction test, not a strategy with trades' },
    { file: 'steady-mix.json · india-mix.json · momentum10.json', strategy: 'mixes', version: '', source: 'backtest', why: 'keep yearly summaries only (no daily / monthly values)' },
    { file: 'fno-spreads.json · matrix-calendar.json', strategy: 'F&O research', version: '', source: 'backtest', why: 'keep only the most recent / worst trades, not the full list' },
  );
  const notTrading = out.rows.filter((r) => !isTradingDay(r.entryDate));
  if (notTrading.length) {
    const dates = [...new Set(notTrading.map((r) => r.entryDate))].sort();
    out.warnings.push(`${notTrading.length} trade(s) on ${dates.length} date(s) that are not regular NSE trading days (${dates.slice(0, 8).join(', ')}${dates.length > 8 ? ', …' : ''}) — usually special sessions (Budget-day Saturdays, exchange DR drills); kept as recorded, weekday shows Sat / Sun`);
  }
  return out;
}

// ----------------------------------------------------------------------- aggregate ---
const dateOf = (row, dateField) => (row.date ? row.date : dateField === 'exit' ? row.exitDate : row.entryDate);
/** Rows that pass the filters (strategy / version: arrays or comma lists; source; side; from / to on the chosen date). */
export function applyFilters(rows, { strategy, version, source, side, from, to, dateField = 'entry', includeOpen = false } = {}) {
  const list = (x) => (x == null || x === '' ? null : new Set(Array.isArray(x) ? x : String(x).split(',').filter(Boolean)));
  const S = list(strategy);
  const V = list(version);
  return rows.filter((r) => {
    if (S && !S.has(r.strategy)) return false;
    if (V && !V.has(r.version)) return false;
    if (source && source !== 'both' && r.source !== source) return false;
    if (side && side !== 'all' && r.side !== side) return false;
    if (!includeOpen && r.open) return false;
    const d = dateOf(r, dateField);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}
function tStat(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return sd > 0 ? m / (sd / Math.sqrt(n)) : null;
}
const sd = (xs) => {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
};
/** The unit a set of trade rows is measured in: ₹ when every row has ₹, else R, else %. */
export function unitOf(rows) {
  if (!rows.length) return '₹';
  if (rows.every((r) => r.pnl != null)) return '₹';
  if (rows.every((r) => r.r != null)) return 'R';
  return '%';
}
const valueIn = (unit) => (r) => (unit === '₹' ? r.pnl : unit === 'R' ? r.r : r.retPct);
/** Stats of one group of trade rows (or curve rows). */
export function statsOf(rows, unit = unitOf(rows)) {
  if (rows.length && rows[0].ret != null && rows[0].pnl === undefined) {
    const rets = rows.map((r) => r.ret);
    return { days: rows.length, avgRet: rets.reduce((a, b) => a + b, 0) / rets.length, compounded: rets.reduce((a, r) => a * (1 + r), 1) - 1, best: Math.max(...rets), worst: Math.min(...rets), won: rets.filter((x) => x > 0).length, t: tStat(rets), unit: 'curve' };
  }
  const v = rows.map(valueIn(unit)).filter((x) => x != null);
  const withPnl = rows.filter((r) => r.pnl != null);
  const withR = rows.filter((r) => r.r != null);
  const net = withPnl.reduce((a, r) => a + r.pnl, 0);
  const totalR = withR.reduce((a, r) => a + r.r, 0);
  const won = v.filter((x) => x > 0).length;
  return {
    unit, trades: rows.length, won, winPct: v.length ? (won / v.length) * 100 : null,
    net: withPnl.length ? net : null, avg: withPnl.length ? net / withPnl.length : null,
    avgR: withR.length ? totalR / withR.length : null, totalR: withR.length ? totalR : null,
    avgRetPct: rows.some((r) => r.retPct != null) ? rows.filter((r) => r.retPct != null).reduce((a, r) => a + r.retPct, 0) / rows.filter((r) => r.retPct != null).length : null,
    gross: rows.some((r) => r.gross != null) ? rows.reduce((a, r) => a + (r.gross ?? 0), 0) : null,
    charges: rows.some((r) => r.charges != null) ? rows.reduce((a, r) => a + (r.charges ?? 0), 0) : null,
    best: v.length ? Math.max(...v) : null, worst: v.length ? Math.min(...v) : null, t: tStat(v), sd: sd(v),
  };
}
/**
 * Group rows by a calendar bucket → { groupBy, dateField, unit, total, buckets: [{ key, label, …stats, few }] }.
 * `groupBy` null = ungrouped (total only). Buckets are seasonal (all Mondays together, all Marches together…) except year.
 */
export function aggregate(rows, { groupBy = 'weekday', dateField = 'entry', filters = {} } = {}) {
  const list = applyFilters(rows, { dateField, ...filters });
  const unit = list.length && list[0].ret != null && list[0].pnl === undefined ? 'curve' : unitOf(list);
  const total = statsOf(list, unit === 'curve' ? undefined : unit);
  if (!groupBy) return { groupBy: null, dateField, unit, total, buckets: [] };
  const g = new Map();
  for (const r of list) {
    const b = bucketOf(dateOf(r, dateField), groupBy);
    if (!g.has(b.key)) g.set(b.key, { ...b, rows: [] });
    g.get(b.key).rows.push(r);
  }
  const buckets = [...g.values()].sort((a, b) => a.order - b.order).map(({ rows: rs, ...b }) => {
    const s = statsOf(rs, unit === 'curve' ? undefined : unit);
    return { ...b, ...s, few: (s.trades ?? s.days) < MIN_TRADES };
  });
  return { groupBy, dateField, unit, total, buckets };
}

// ---------------------------------------------------------------------- validation ---
const seriesKey = (r) => `${r.strategy}|${r.version}|${r.source}`;
/** All rows split into series (one per strategy / version / source). */
export function seriesOf(data) {
  const m = new Map();
  for (const r of [...data.rows, ...data.curves]) {
    const k = seriesKey(r);
    if (!m.has(k)) m.set(k, { strategy: r.strategy, version: r.version, source: r.source, rows: [] });
    m.get(k).rows.push(r);
  }
  for (const rep of data.reported) {
    const k = seriesKey(rep);
    if (!m.has(k)) m.set(k, { strategy: rep.strategy, version: rep.version, source: rep.source, rows: [] });
    m.get(k).reported = rep;
  }
  return [...m.values()].sort((a, b) => a.strategy.localeCompare(b.strategy) || a.source.localeCompare(b.source) || a.version.localeCompare(b.version));
}
/**
 * Both-ways check of every series (closed trades, unfiltered, by entry date):
 * (a) each grouping adds back to the ungrouped total, and the total equals the card's; (b) weekday = month = year totals;
 * (c) trade counts match (every grouping, and the card's count). Curves: compounded returns multiply back the same way.
 */
export function validate(data, { dateField = 'entry' } = {}) {
  const out = [];
  for (const s of seriesOf(data)) {
    const rep = s.reported || null;
    const isCurve = (s.rows[0]?.ret != null && s.rows[0]?.pnl === undefined) || rep?.unit === 'curve';
    const base = aggregate(s.rows, { groupBy: null, dateField });
    const unit = isCurve ? 'curve' : s.rows.length ? base.unit : rep?.unit || base.unit;
    const pick = (st) => (isCurve ? st.compounded ?? 0 : unit === '₹' ? st.net ?? 0 : unit === 'R' ? st.totalR ?? 0 : (st.avgRetPct ?? 0) * (st.trades ?? 0));
    const count = (st) => (isCurve ? st.days ?? 0 : st.trades ?? 0);
    const total = s.rows.length ? pick(base.total) : 0;
    const n = s.rows.length ? count(base.total) : 0;
    const eps = isCurve ? 1e-9 : unit === '₹' ? 0.01 : 1e-9;
    const by = {};
    const counts = {};
    for (const g of GROUPS) {
      const a = aggregate(s.rows, { groupBy: g, dateField });
      by[g] = isCurve ? a.buckets.reduce((x, b) => x * (1 + b.compounded), 1) - 1 : a.buckets.reduce((x, b) => x + pick(b), 0);
      counts[g] = a.buckets.reduce((x, b) => x + count(b), 0);
    }
    const sumsOk = GROUPS.every((g) => Math.abs(by[g] - total) <= eps * Math.max(1, isCurve ? 1 : Math.abs(total) / 1e6));
    const crossOk = Math.abs(by.weekday - by.month) <= eps * 10 && Math.abs(by.month - by.year) <= eps * 10;
    const countsOk = GROUPS.every((g) => counts[g] === n);
    let reported = null;
    let reportedOk = null;
    let reportedTrades = null;
    let note = rep?.by || 'no card total';
    if (rep && !rep.missing) {
      reported = isCurve ? rep.compounded : unit === '₹' ? rep.net : rep.totalR;
      reportedTrades = isCurve ? rep.days : rep.trades;
      const tol = isCurve ? 1e-6 : unit === '₹' ? rep.tolerance ?? 1 : 1e-6 * Math.max(1, Math.abs(reported ?? 0));
      const tradesOk = isCurve ? true : reportedTrades === n; // a curve's point count includes its starting value
      reportedOk = reported != null && Math.abs(total - reported) <= tol && tradesOk;
      if (rep.unit !== unit && !isCurve && n) { reportedOk = false; note += ` · units differ (card ${rep.unit}, rows ${unit})`; }
      if (!reportedOk && rep.cardAt && rep.builtAt && rep.cardAt > rep.builtAt) note += ' · the card was re-run after the breakdown build: rebuild (--build)';
    }
    // the card's own by-year table, where it has one (5-year intraday): each year must match too
    let yearsOk = null;
    if (rep?.byYear && !isCurve) {
      const yb = aggregate(s.rows, { groupBy: 'year', dateField: 'entry' }).buckets;
      yearsOk = Object.entries(rep.byYear).every(([y, v]) => {
        const b = yb.find((x) => x.key === y);
        return b ? b.trades === v.trades && Math.abs(b.net - v.total) <= (rep.tolerance ?? 1) : v.trades === 0;
      }) && yb.every((b) => rep.byYear[b.key]);
    }
    out.push({
      strategy: s.strategy, version: s.version, source: s.source, unit, trades: n, total, byGroup: by, counts,
      reported, reportedTrades, reportedBy: note,
      ok: { sums: sumsOk, cross: crossOk, counts: countsOk, reported: reportedOk, years: yearsOk },
      pass: sumsOk && crossOk && countsOk && reportedOk !== false && yearsOk !== false,
    });
  }
  return out;
}

// ------------------------------------------------------------------ paper vs backtest ---
/**
 * Paper beside the backtest for the same strategy, version and calendar bucket (closed trades, the series' own unit).
 * Flags a bucket when paper's average has the other sign, or is 2+ standard errors from the backtest's.
 */
export function compare(rows, { groupBy = 'weekday', dateField = 'entry', filters = {} } = {}) {
  const f = { ...filters, source: 'both' };
  const pairs = new Map();
  for (const r of applyFilters(rows, { dateField, ...f })) {
    if (r.ret != null && r.pnl === undefined) continue;
    const k = `${r.strategy}|${r.version}`;
    if (!pairs.has(k)) pairs.set(k, { strategy: r.strategy, version: r.version, paper: [], backtest: [] });
    pairs.get(k)[r.source].push(r);
  }
  const out = [];
  for (const p of pairs.values()) {
    if (!p.paper.length || !p.backtest.length) continue;
    const unit = unitOf(p.paper) === unitOf(p.backtest) ? unitOf(p.paper) : unitOf(p.paper) !== '%' && unitOf(p.backtest) !== '%' ? 'R' : '%';
    if (unit === 'R' && (!p.paper.every((r) => r.r != null) || !p.backtest.every((r) => r.r != null))) continue;
    const val = valueIn(unit);
    const cell = (pr, bt, label, key) => {
      const pv = pr.map(val);
      const bv = bt.map(val);
      const pAvg = pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : null;
      const bAvg = bv.length ? bv.reduce((a, b) => a + b, 0) / bv.length : null;
      const bSd = sd(bv);
      const z = pAvg != null && bAvg != null && bSd ? (pAvg - bAvg) / (bSd / Math.sqrt(pv.length)) : null;
      const differs = pv.length > 0 && bv.length > 0 && ((pAvg > 0 && bAvg < 0) || (pAvg < 0 && bAvg > 0) || (z != null && Math.abs(z) >= 2));
      return {
        key, label, paperTrades: pv.length, paperTotal: pv.reduce((a, b) => a + b, 0), paperAvg: pAvg, backtestTrades: bv.length, backtestAvg: bAvg, z, differs,
        note: !pv.length || !bv.length ? '' : differs ? `live result differs from long-run test${pv.length < SMALL_SAMPLE ? ' — likely luck / sample size' : ''}` : 'in line with the long-run test',
      };
    };
    const buckets = [];
    if (groupBy) {
      const keys = new Map();
      for (const r of [...p.paper, ...p.backtest]) {
        const b = bucketOf(dateOf(r, dateField), groupBy);
        keys.set(b.key, b);
      }
      for (const b of [...keys.values()].sort((x, y) => x.order - y.order)) {
        const inB = (r) => bucketOf(dateOf(r, dateField), groupBy).key === b.key;
        buckets.push(cell(p.paper.filter(inB), p.backtest.filter(inB), b.label, b.key));
      }
    }
    const pd = p.paper.map((r) => dateOf(r, dateField)).sort();
    out.push({ strategy: p.strategy, version: p.version, unit, overall: cell(p.paper, p.backtest, 'All', 'all'), buckets, paperFrom: pd[0], paperTo: pd.at(-1) });
  }
  return out;
}

// -------------------------------------------------------------------------- the API ---
let CACHE = null; // { dir, stamp, data, validation }
/** The normalised rows, re-read only when a source file changes (mtimes). */
export function cachedData({ dir = DATA_DIR() } = {}) {
  const names = [...Object.keys(PAPER_ADAPTERS), ...Object.keys(BACKTEST_ADAPTERS), 'intraday-5y.json', 'nifty-dip.json', 'fo-strangle.json', 'ath-swing.json', 'imbalance-swing.json', 'rsi-swing.json'];
  const stamp = names.map((n) => {
    try {
      return `${n}:${statSync(join(dir, n)).mtimeMs}`;
    } catch {
      return `${n}:-`;
    }
  }).join('|');
  if (CACHE && CACHE.dir === dir && CACHE.stamp === stamp) return CACHE;
  const data = loadAll({ dir });
  CACHE = { dir, stamp, data, validation: validate(data), at: new Date().toISOString() };
  return CACHE;
}
export const clearCache = () => { CACHE = null; };

/** GET /api/breakdown?strategy=&version=&source=&groupBy=&from=&to=&side=&dateField= */
export function breakdownQuery(q = {}, { dir = DATA_DIR(), cache = cachedData({ dir }) } = {}) {
  const groupBy = GROUPS.includes(q.groupBy) ? q.groupBy : 'weekday';
  const dateField = q.dateField === 'exit' ? 'exit' : 'entry';
  const source = ['backtest', 'paper', 'both'].includes(q.source) ? q.source : 'both';
  const filters = { strategy: q.strategy || null, version: q.version || null, source, side: q.side || null, from: istDate(q.from) || null, to: istDate(q.to) || null };
  const { data, validation } = cache;
  const all = [...data.rows, ...data.curves];
  const series = [];
  for (const s of seriesOf(data)) {
    if (!s.rows.length) continue;
    const rows = applyFilters(s.rows, { ...filters, dateField });
    if (!applyFilters(s.rows, { strategy: filters.strategy, version: filters.version, source, dateField, includeOpen: true }).length) continue; // not selected
    const a = aggregate(rows, { groupBy, dateField });
    series.push({
      strategy: s.strategy, label: STRATEGIES[s.strategy] || s.strategy, version: s.version, source: s.source, kind: a.unit === 'curve' ? 'curve' : 'trades',
      unit: a.unit, total: a.total, buckets: a.buckets, open: s.rows.filter((r) => r.open).length,
      from: rows.map((r) => dateOf(r, dateField)).sort()[0] || null, to: rows.map((r) => dateOf(r, dateField)).sort().at(-1) || null,
    });
  }
  // ₹ across every selected trade series (₹ only: R and % are not added to rupees)
  const rupeeRows = applyFilters(data.rows, { ...filters, dateField }).filter((r) => r.pnl != null);
  const combined = source !== 'both' && rupeeRows.length ? aggregate(rupeeRows, { groupBy, dateField }) : null;
  const options = {};
  for (const r of all) {
    const o = (options[r.strategy] ||= { label: STRATEGIES[r.strategy] || r.strategy, versions: {}, sides: new Set() });
    (o.versions[r.version] ||= new Set()).add(r.source);
    if (r.side) o.sides.add(r.side);
  }
  return {
    groupBy, dateField, filters, groups: GROUPS, minTrades: MIN_TRADES,
    series, combined: combined ? { unit: '₹', total: combined.total, buckets: combined.buckets } : null,
    compare: compare(all, { groupBy, dateField, filters: { strategy: filters.strategy, version: filters.version, side: filters.side, from: filters.from, to: filters.to } }),
    validation: validation.filter((v) => !filters.strategy || String(filters.strategy).split(',').includes(v.strategy)),
    validationAll: { series: validation.length, failed: validation.filter((v) => !v.pass).length },
    options: Object.fromEntries(Object.entries(options).map(([k, o]) => [k, { label: o.label, versions: Object.fromEntries(Object.entries(o.versions).map(([v, s]) => [v, [...s].sort()])), sides: [...o.sides].sort() }])),
    skipped: data.skipped, warnings: data.warnings, files: data.files, builtAt: readBuiltAt(dir), loadedAt: cache.at,
    note: 'Closed trades only (open positions are listed, not counted). Buckets are seasonal: every Monday together, every March together; year is the calendar year. Buckets with fewer than 20 trades are too few to judge. Backtest ₹ use each test\'s own sizing (the same standard size as its paper record). Paper research only — not investment advice.',
  };
}
function readBuiltAt(dir) {
  try {
    const p = join(dir, BUILT_FILE);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).at || null : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ build: backtest trades ---
const rd = (x, k = 4) => (num(x) == null ? null : +x.toFixed(k));
const compact = (t) => ({ s: SYM(t.symbol), sd: t.side || null, e: t.entryDate, x: t.exitDate ?? null, p: rd(t.pnl), r: rd(t.r, 6), rp: rd(t.retPct, 6), g: rd(t.gross), c: rd(t.charges), ...(t.open ? { o: true } : {}) });
/**
 * Re-run the backtests with their own exported code (same data, same rules) and save the individual trades, so the
 * Breakdown tab can group them. Each part is independent: a failure is saved as `error` and shown as skipped.
 */
export async function buildBacktest({ log = console.log, only = null, file = join(DATA_DIR(), BUILT_FILE) } = {}) {
  const { candles } = await import('../market-data.mjs');
  const { readHist } = await import('./groww-history.mjs');
  const sources = [];
  const want = (k) => !only || only.includes(k);
  const part = async (key, fn) => {
    if (!want(key)) return;
    const t0 = Date.now();
    try {
      const got = await fn();
      for (const g of got) sources.push({ ...g, rows: g.rows.map(compact) });
      log(`${key}: ${got.map((g) => `${g.version} ${g.rows.length} trades`).join(' · ')} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } catch (err) {
      log(`${key}: failed — ${err.message}`);
      sources.push({ strategy: key, version: 'all', error: err.message });
    }
  };
  const p2019 = Math.floor(Date.parse('2019-01-01') / 1000);

  // YouTube intraday (VWAP), the three paper versions — the loop of intraday-5y.mjs
  await part('vwap', async () => {
    const vp = await import('./vwap-pullback.mjs');
    const daily = async (s) => {
      try {
        return vp.dailyTrendLookup((await candles(s, { period1: p2019, interval: '1d' })).filter((r) => r.close > 0));
      } catch {
        return new Map();
      }
    };
    const outv = [];
    for (const [key, v] of Object.entries(vp.PAPER_VARIANTS)) {
      const data = [];
      for (const s of v.stocks || vp.VIDEO_STOCKS) {
        const rows = readHist(s).filter((r) => r.close > 0 && r.high > 0);
        if (rows.length) data.push({ s, rows, daily: await daily(s) });
      }
      const trades = vp.accountTrades(data.flatMap(({ s, rows, daily: d }) => vp.backtestStock(s, rows, v.rules, { daily: d })), v.rules.maxPerDay);
      outv.push({ strategy: 'vwap', version: key, unit: '₹', builtFrom: 'intraday-5y.mjs loop (Groww 5-minute history)', rows: trades.map((t) => ({ ...t, entryDate: t.date, exitDate: t.date, pnl: t.net, r: t.rNet })) });
    }
    return outv;
  });

  // Breakfast, 5 years — the loop of intraday-5y.mjs
  await part('breakfast', async () => {
    const bf = await import('./breakfast.mjs');
    const { loadIndexList } = await import('./ranking.mjs');
    const idx = await loadIndexList('nifty200');
    const ind = idx.industries || {};
    const stocks = [];
    for (const s of (idx.symbols || []).map((x) => (/\.(NS|BO)$/.test(x) ? x : `${x}.NS`))) {
      const rows = readHist(s).filter((b) => b.close > 0 && b.high > 0);
      if (rows.length) stocks.push({ s, sector: ind[s] || ind[s.replace('.NS', '')] || 'Other', sessions: bf.sessionsOf(rows) });
    }
    const nifty = bf.sessionsOf(readHist('^NSEI').filter((b) => b.close > 0));
    const trades = [];
    for (const d of [...nifty.keys()].sort()) {
      const p = bf.picksFor(d, stocks, nifty);
      for (const [side, pick] of [['long', p.long], ['short', p.short]]) {
        if (!pick) continue;
        const t = bf.simulate({ ...pick, date: d }, side, stocks.find((x) => x.s === pick.symbol)?.sessions.get(d), p.niftyMove);
        if (t) trades.push(t);
      }
    }
    return [{ strategy: 'breakfast', version: 'all', unit: '₹', builtFrom: 'intraday-5y.mjs loop (Groww 5-minute history)', rows: trades.map((t) => ({ ...t, entryDate: t.date, exitDate: t.date, pnl: t.net })) }];
  });

  // 1:15 PM reversal, stock versions V and S at the 3% threshold — the loop of one-fifteen.mjs backtest()
  await part('one-fifteen', async () => {
    const of = await import('./one-fifteen.mjs');
    const { histSymbols } = await import('./groww-history.mjs');
    const fo = of.foSet();
    const raw = { V: [], S: [] };
    for (const s of histSymbols().filter((x) => x.endsWith('.NS'))) {
      const ses = of.sessionsOf(await of.longRows(s));
      if (ses.length < 2) continue;
      for (const v of ['V', 'S']) raw[v].push(...of.simulate(s, ses, { version: v, mode: 'reversal', fno: fo.has(s), rules: { ...of.RULES, moveMin: 3 } }).filter((t) => !t.open));
    }
    return ['V', 'S'].map((v) => ({ strategy: 'one-fifteen', version: v, unit: '₹', builtFrom: 'one-fifteen.mjs backtest() loop', rows: of.accountTrades(raw[v]).map((t) => ({ ...t, entryDate: t.date, exitDate: t.exitDate || t.date, pnl: t.net, r: t.rNet })) }));
  });

  // NIFTY dip-buy, both versions — nifty-dip.mjs testRules()
  await part('nifty-dip', async () => {
    const dip = await import('./nifty-dip.mjs');
    const { completedOnly } = await import('./ath-swing.mjs');
    const rows = completedOnly((await candles('^NSEI', { period1: Math.floor(Date.parse('2007-01-01') / 1000), interval: '1d' })).filter((x) => x.open > 0 && x.close > 0));
    return Object.entries(dip.VERSIONS).map(([v, r]) => ({ strategy: 'nifty-dip', version: v, unit: '₹', builtFrom: 'nifty-dip.mjs simulate()', rows: dip.simulate(rows, r).filter((t) => !t.open).map((t) => ({ ...t, symbol: 'NIFTYBEES', side: 'long', pnl: t.net })) }));
  });

  // NIFTY strangle and iron condor — the loop of fo-strangle.mjs foStrangleTest()
  await part('fo-strangle', async () => {
    const fs = await import('./fo-strangle.mjs');
    const dirFo = process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
    const now = new Date();
    const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
    const close = new Map((await candles('^NSEI', { period1: p2019, interval: '1d' })).filter((x) => x.close > 0).map((x) => [x.date, x.close]));
    const files = existsSync(dirFo) ? readdirSync(dirFo).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort() : [];
    const day = (d) => {
      try {
        return JSON.parse(readFileSync(join(dirFo, `${d}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    return [['strangle', fs.RULES], ['condor', fs.CONDOR]].map(([v, r]) => {
      const trades = [];
      let lastExpiry = '';
      for (const d of files) {
        if (d <= lastExpiry) continue;
        const t = fs.openTrade(d, day(d), r, close.get(d));
        if (!t) continue;
        lastExpiry = t.expiry;
        if (t.expiry >= today || !close.has(t.expiry)) continue;
        trades.push(fs.settle(t, close.get(t.expiry)));
      }
      return { strategy: 'fo-strangle', version: v, unit: '₹', builtFrom: 'fo-strangle.mjs foStrangleTest() loop (NSE option prices)', rows: trades.map((t) => ({ symbol: 'NIFTY', side: 'short', entryDate: t.entryDate, exitDate: t.expiry, pnl: t.rupees, charges: t.costs * t.lot, gross: t.rupees + t.costs * t.lot, retPct: t.retOnMargin * 100 })) };
    });
  });

  // Imbalance swing, both paper versions — imbalance-swing.mjs imbalanceSwingTest()
  await part('imbalance-swing', async () => {
    const im = await import('./imbalance-swing.mjs');
    const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
    const { isEtf } = await import('./momentum.mjs');
    const series = loadSeries();
    if (!series.size) throw new Error('no NSE history (bhav-history) on this Mac');
    const uni = pointInTimeUniverse(series, im.RULES.universe);
    return Object.entries(im.VERSIONS).map(([v, { rules }]) => {
      const list = [...series].flatMap(([sym, rows]) => (isEtf(sym) || rows.length < 100 ? [] : im.tradesFor(sym, rows, rules, (d) => uni.get(d.slice(0, 7))?.has(sym)))).filter((t) => t.entryDate >= im.PERIODS.dev[0]);
      return { strategy: 'imbalance-swing', version: v, unit: 'R', builtFrom: 'imbalance-swing.mjs tradesFor() on the survivorship-free NSE history', rows: list.map((t) => ({ ...t, side: 'long', retPct: t.retPct * 100 })) };
    });
  });

  // Strong-stock swing: original rules and the wide trail — ath-swing.mjs athSwingTest()
  await part('ath', async () => {
    const ath = await import('./ath-swing.mjs');
    const data = (await ath.loadDaily(candles, await ath.universe(), '2005-01-01')).map((x) => ({ ...x, bars: ath.indicators(x.rows) }));
    const market = ath.marketMap(ath.completedOnly((await candles('^NSEI', { period1: Math.floor(Date.parse('2005-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0)));
    const run = (rules) => data.flatMap(({ s, rows, bars }) => ath.tradesFor(s, rows, rules, { bars, market })).filter((t) => t.entryDate >= '2010-01-01');
    return [['original', ath.RULES], ['wide', ath.wideRules()]].map(([v, r]) => ({ strategy: 'ath', version: v, unit: 'R', builtFrom: 'ath-swing.mjs tradesFor() on the NIFTY 200 daily history', rows: run(r).map((t) => ({ ...t, side: 'long', retPct: num(t.retPct) != null ? t.retPct * 100 : null })) }));
  });

  // RSI swing, the four buy versions — rsi-swing.mjs rsiSwingTest()
  await part('rsi-swing', async () => {
    const rsi = await import('./rsi-swing.mjs');
    const data = await rsi.loadData({});
    return Object.keys(rsi.VERSIONS).map((v) => ({ strategy: 'rsi-swing', version: v, unit: 'R', builtFrom: 'rsi-swing.mjs tradesFor() (2 years of hourly bars)', rows: data.flatMap(({ symbol, hourly, daily }) => rsi.tradesFor(symbol, hourly, daily, { version: v, side: 'long' })).map((t) => ({ ...t, retPct: num(t.retPct) != null ? t.retPct * 100 : null })) }));
  });

  // keep earlier parts that were not re-run this time
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    prev = null;
  }
  const keep = (prev?.sources || []).filter((s) => !sources.some((n) => n.strategy === s.strategy));
  const out = { at: new Date().toISOString(), note: 'Individual backtest trades for the Breakdown tab, re-run with each strategy\'s own code. Checked against each card\'s saved totals on the page.', sources: [...keep, ...sources] };
  writeJsonAtomic(file, out, 0);
  return out;
}

// ---------------------------------------------------------------------------- CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--build')) {
      const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') || null;
      await buildBacktest({ only });
    }
    const data = loadAll();
    const v = validate(data);
    const f = (x, u) => (x == null ? '–' : u === '₹' ? `₹${Math.round(x).toLocaleString('en-IN')}` : u === 'curve' ? `${(x * 100).toFixed(2)}%` : `${x.toFixed(2)} ${u}`);
    for (const x of v) console.log(`${x.pass ? '✓' : '✗'} ${`${x.strategy}/${x.version} (${x.source})`.padEnd(44)} ${String(x.trades).padStart(5)} · rows ${f(x.total, x.unit).padStart(14)} · card ${f(x.reported, x.unit).padStart(14)}${x.reportedTrades != null ? ` (${x.reportedTrades})` : ''}${x.pass ? '' : `  ${JSON.stringify(x.ok)} ${x.reportedBy}`}`);
    for (const w of data.warnings) console.log(`warning: ${w}`);
    for (const s of data.skipped) console.log(`skipped: ${s.file} ${s.strategy} ${s.version} — ${s.why}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
