#!/usr/bin/env node
// Matrix Calendar (library + CLI) — the positional option-selling setup from a
// YouTube interview, rebuilt on real NSE NIFTY option closing prices (2019→):
//   Entry: the session before the weekly expiry (Monday now that NIFTY expires on
//   Tuesday; Wednesday when it expired on Thursday), at the close (≈ the 3:16 pm entry),
//   using the NEXT weekly expiry, not the one a day away.
//   Sell 2 lots of the ≈0.23-delta call and put (100-point strikes); buy 1 lot of each
//   500 points farther out (same weekly expiry); buy 1 lot of the monthly expiry at
//   each sold strike (the calendar legs: positive vega). Six legs.
//   Exit: the next session (the expiry day of the near week). Skip the week when that
//   expiry day is moved by a holiday (the "Tuesday holiday" rule).
// Compared with an iron condor on the same sold strikes (no monthly legs).
// End-of-day prices only: the interview's 1% target / 1% stop during the day can't be
// replayed, so each trade is held from one close to the next. Research only.
//
//   node paper-bot/matrix-calendar.mjs             download what's missing (cached) + test

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { downloadBhav, parseFoBhav, FoBlockedError } from './vol-premium.mjs';
import { lotOn, LOT_NOW } from './fo-strangle.mjs';
import { invNorm } from './option-strikes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.FO_BHAV_MC_DIR || join(HERE, 'data', 'fo-bhav-mc');
const NEAR_DIR = () => process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
const SAVED = () => process.env.MATRIX_CALENDAR_PATH || join(HERE, 'data', 'matrix-calendar.json');

export const RULES = { delta: 0.23, step: 100, wing: 500, sellLots: 2, slippagePct: 0.5, slippageMinPts: 0.5, brokeragePerOrder: 20, capitalPerSet: 300000, tuesdayFrom: '2025-09-01' };

// ---------------------------------------------------------------- data ---
/** The expiry list in a day's chain: weeklies in date order; the monthly = the last expiry of its calendar month. */
export function monthlyAfter(expiries, after) {
  const ex = [...expiries].sort();
  const monthlies = ex.filter((e, i) => i === ex.length - 1 || ex[i + 1].slice(0, 7) !== e.slice(0, 7));
  return monthlies.find((e) => e > after) || null;
}

/** Keep a compact copy of one day's NIFTY chain: the next 3 weeklies + the next 2 monthlies, strikes within ±12%. */
export function compact(parsed, date) {
  const ex = Object.keys(parsed.expiries).filter((e) => e >= date).sort();
  const spot = parsed.underlying;
  const keepEx = new Set(ex.slice(0, 3));
  for (const m of [monthlyAfter(ex, date), monthlyAfter(ex, monthlyAfter(ex, date) || date)]) if (m) keepEx.add(m);
  const out = { underlying: spot, all: ex, expiries: {} };
  for (const e of keepEx) {
    out.expiries[e] = {};
    for (const [k, r] of Object.entries(parsed.expiries[e])) {
      if (spot && Math.abs(Number(k) / spot - 1) > 0.12) continue;
      out.expiries[e][k] = { CE: r.CE, PE: r.PE, ceVol: r.ceVol, peVol: r.peVol };
    }
  }
  return out;
}

async function chainOn(date, { fetchFn = fetch, spot = null, download = true } = {}) {
  const f = join(DIR(), `${date}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  if (!download) return null;
  const d = await downloadBhav(date, { fetchFn });
  if (!d) return null;
  mkdirSync(DIR(), { recursive: true });
  if (d.missing) {
    writeFileSync(f, 'null');
    return null;
  }
  const parsed = parseFoBhav(d.csv);
  if (!parsed) return null;
  if (!parsed.underlying) parsed.underlying = spot; // older NSE files lack the underlying
  const c = compact(parsed, date);
  writeFileSync(f, JSON.stringify(c));
  return c;
}

// --------------------------------------------------------------- trade ---
const round = (x, step) => Math.round(x / step) * step;
const px = (ch, k, typ, traded = false) => {
  const row = ch?.[k];
  const v = row?.[typ];
  if (traded && !((typ === 'CE' ? row?.ceVol : row?.peVol) > 0)) return null; // no trades that day: the close is stale
  return v > 0 ? v : null;
};

/** Six legs from the entry chain: [{ expiry, strike, typ, qty (+ buy / − sell), entry }]. */
export function buildLegs(chain, date, r = RULES) {
  const ex = Object.keys(chain.expiries).sort();
  const weekly = ex.filter((e) => e > date)[1]; // the NEXT weekly, not the one a day away
  if (!weekly) return null;
  const monthly = monthlyAfter(chain.all || ex, weekly);
  const W = chain.expiries[weekly];
  const M = monthly && chain.expiries[monthly];
  const S = chain.underlying;
  if (!W || !M || !(S > 0)) return null;
  // implied one-sigma move to the weekly expiry from its ATM straddle
  const atm = round(S, 50);
  const straddle = (px(W, atm, 'CE') ?? px(W, atm + 50, 'CE')) + (px(W, atm, 'PE') ?? px(W, atm - 50, 'PE'));
  if (!(straddle > 0)) return null;
  const sigmaT = straddle / 2 / (0.3989 * S);
  const z = invNorm(1 - r.delta);
  const kc = round(S * Math.exp(z * sigmaT), r.step);
  const kp = round(S * Math.exp(-z * sigmaT), r.step);
  const legs = [
    { expiry: weekly, strike: kc, typ: 'CE', qty: -r.sellLots },
    { expiry: weekly, strike: kp, typ: 'PE', qty: -r.sellLots },
    { expiry: weekly, strike: kc + r.wing, typ: 'CE', qty: 1 },
    { expiry: weekly, strike: kp - r.wing, typ: 'PE', qty: 1 },
    { expiry: monthly, strike: kc, typ: 'CE', qty: 1, calendar: true },
    { expiry: monthly, strike: kp, typ: 'PE', qty: 1, calendar: true },
  ];
  for (const l of legs) {
    l.entry = px(chain.expiries[l.expiry], l.strike, l.typ, true); // entry only at a strike that traded
    if (l.entry == null) return { untraded: true };
  }
  return { weekly, monthly, spot: S, sigmaT, legs };
}

/** Charges for one leg opened and closed (index points per unit). */
export function legCharges(l, exitPx, date, r = RULES) {
  const lot = lotOn(date);
  const brk = (2 * r.brokeragePerOrder) / lot;
  const sell = l.qty < 0 ? l.entry : exitPx; // STT on the sell side
  const stt = sell * (date < '2023-04-01' ? 0.0005 : date < '2024-10-01' ? 0.000625 : 0.001);
  const exch = (l.entry + exitPx) * (date < '2024-10-01' ? 0.0005 : 0.0003503);
  const stamp = (l.qty > 0 ? l.entry : exitPx) * 0.00003;
  const slip = Math.max((l.entry * r.slippagePct) / 100, r.slippageMinPts) + Math.max((exitPx * r.slippagePct) / 100, r.slippageMinPts);
  return brk + stt + exch + stamp + 0.18 * (brk + exch) + slip;
}

/** Close at the exit chain: points and ₹ for one set at today's lot; the iron condor = the same without the monthly legs. */
export function settleAt(trade, exitChain, entryDate, r = RULES) {
  let mc = 0;
  let ic = 0;
  let mcCost = 0;
  let icCost = 0;
  for (const l of trade.legs) {
    const x = px(exitChain?.expiries?.[l.expiry], l.strike, l.typ);
    if (x == null) return null;
    const pts = l.qty * (x - l.entry);
    const cost = Math.abs(l.qty) * legCharges(l, x, entryDate, r);
    mc += pts;
    mcCost += cost;
    if (!l.calendar) {
      ic += pts;
      icCost += cost;
    }
    l.exit = x;
  }
  return { mcPts: mc - mcCost, icPts: ic - icCost, mcRs: (mc - mcCost) * LOT_NOW, icRs: (ic - icCost) * LOT_NOW, exitSpot: exitChain.underlying };
}

const summary = (xs) => {
  const n = xs.length;
  if (!n) return { n: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  const w = xs.filter((x) => x > 0);
  const l = xs.filter((x) => x <= 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const x of xs) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return { n, avg: m, total: xs.reduce((a, b) => a + b, 0), win: w.length / n, avgWin: w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0, avgLoss: l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0, worst: Math.min(...xs), best: Math.max(...xs), t: sd > 0 ? m / (sd / Math.sqrt(n)) : null, maxDrawdown: dd };
};

// ---------------------------------------------------------------- test ---
export async function matrixCalendarTest({ loadCandles = candles, fetchFn = fetch, r = RULES, onProgress = () => {}, download = true } = {}) {
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2019-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const vix = new Map((await loadCandles('^INDIAVIX', { period1: Math.floor(Date.parse('2019-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0).map((x) => [x.date, x.close]));
  const days = nifty.map((x) => x.date);
  const close = new Map(nifty.map((x) => [x.date, x.close]));
  // the weekly expiry dates, from the near-expiry files the app already keeps
  const expiries = new Set();
  if (existsSync(NEAR_DIR())) for (const f of readdirSync(NEAR_DIR()).filter((x) => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(NEAR_DIR(), f), 'utf8'));
      for (const e of Object.keys(d?.expiries || {})) expiries.add(e);
    } catch {
      /* skip */
    }
  }
  const trades = [];
  const skipped = [];
  let blocked = null;
  let fetched = 0;
  for (const E of [...expiries].sort()) {
    const iE = days.indexOf(E);
    if (iE < 1) continue;
    const entry = days[iE - 1];
    const normal = E >= r.tuesdayFrom ? 2 : 4; // Tuesday from Sep 2025, Thursday before
    if (new Date(`${E}T00:00:00Z`).getUTCDay() !== normal) {
      skipped.push({ expiry: E, why: 'expiry moved by a holiday' });
      continue;
    }
    let a;
    let b;
    try {
      const had = existsSync(join(DIR(), `${entry}.json`)) && existsSync(join(DIR(), `${E}.json`));
      a = await chainOn(entry, { fetchFn, spot: close.get(entry), download });
      b = await chainOn(E, { fetchFn, spot: close.get(E), download });
      if (!had && download) {
        onProgress(++fetched, E);
        if (fetchFn === fetch) await new Promise((res) => setTimeout(res, 300));
      }
    } catch (err) {
      if (err instanceof FoBlockedError) {
        blocked = err.message;
        break;
      }
      throw err;
    }
    if (!a || !b) continue;
    const t = buildLegs(a, entry, r);
    if (!t) continue;
    if (t.untraded) {
      skipped.push({ expiry: E, why: 'a leg did not trade on the entry day' });
      continue;
    }
    const s = settleAt(t, b, entry, r);
    if (!s) continue;
    trades.push({ entryDate: entry, exitDate: E, ...t, ...s, move: b.underlying && t.spot ? b.underlying / t.spot - 1 : null, vix: vix.get(entry) ?? null });
  }
  const part = (f) => ({ matrix: summary(trades.filter(f).map((t) => t.mcRs)), condor: summary(trades.filter(f).map((t) => t.icRs)) });
  const yrs = trades.length > 1 ? (Date.parse(trades.at(-1).exitDate) - Date.parse(trades[0].entryDate)) / (365.25 * 86400000) : 0;
  const all = part(() => true);
  const byYear = Object.fromEntries([...new Set(trades.map((t) => t.entryDate.slice(0, 4)))].map((y) => [y, part((t) => t.entryDate.startsWith(y))]));
  const byVix = { 'VIX below 15': part((t) => t.vix != null && t.vix < 15), 'VIX 15–25': part((t) => t.vix >= 15 && t.vix <= 25), 'VIX above 25': part((t) => t.vix > 25) };
  const halves = { '2019–22': part((t) => t.entryDate < '2023-01-01'), '2023→': part((t) => t.entryDate >= '2023-01-01'), 'Monday entries (Sep 2025→)': part((t) => t.entryDate >= r.tuesdayFrom) };
  const perYear = yrs > 0 ? all.matrix.total / yrs : null;
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const rs = (x) => `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
  const passed = all.matrix.avg > 0 && (all.matrix.t ?? 0) >= 2 && halves['2019–22'].matrix.avg > 0 && halves['2023→'].matrix.avg > 0;
  return {
    at: new Date().toISOString(), from: trades[0]?.entryDate, to: trades.at(-1)?.exitDate, rules: r, blocked, weeks: trades.length, skipped: skipped.length, skippedWhy: Object.fromEntries([...new Set(skipped.map((x) => x.why))].map((w) => [w, skipped.filter((x) => x.why === w).length])),
    all, halves, byYear, byVix, perYear, returnOnCapital: perYear != null ? perYear / r.capitalPerSet : null, passed,
    worst: [...trades].sort((a, b) => a.mcRs - b.mcRs).slice(0, 5).map((t) => ({ entryDate: t.entryDate, move: t.move, vix: t.vix, matrix: t.mcRs, condor: t.icRs })),
    recent: trades.slice(-8).reverse().map((t) => ({ entryDate: t.entryDate, exitDate: t.exitDate, weekly: t.weekly, monthly: t.monthly, legs: t.legs, move: t.move, matrix: t.mcRs, condor: t.icRs })),
    verdict: `${passed ? 'Made money' : 'Did not make money reliably'} close to close after charges: ${trades.length} weeks, won ${pc(all.matrix.win || 0)}, average ${rs(all.matrix.avg || 0)} a set (2 lots a side, today's lot of ${LOT_NOW}; t ${all.matrix.t?.toFixed(1) ?? '–'}), about ${perYear != null ? rs(perYear) : '–'} a year (${perYear != null ? pc(perYear / r.capitalPerSet) : '–'} on ₹${(r.capitalPerSet / 1e5).toFixed(0)} lakh). Iron condor on the same strikes: ${rs(all.condor.avg || 0)} a week. 2019–22 vs 2023→: ${rs(halves['2019–22'].matrix.avg || 0)} / ${rs(halves['2023→'].matrix.avg || 0)} a week.`,
    note: `Real NSE NIFTY option closes. Entry at the close of the session before the weekly expiry (≈ the 3:16 pm entry), exit at the next close; the interview exits intraday at +1% / −1% of capital, which needs intraday prices this app doesn't have. Charges: ₹20 an order, STT, exchange, stamp, GST and 0.5% (min 0.5 pt) slippage each way on every leg. Capital per set assumed ₹${(r.capitalPerSet / 1e5).toFixed(0)} lakh (hedged margin estimate). Weeks whose expiry moved for a holiday are skipped, and so are weeks where a leg had no trades on the entry day (its closing price would be stale). Research only.`,
  };
}

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const saveMatrixCalendar = (x) => writeJsonAtomic(SAVED(), x);
export const loadMatrixCalendar = () => readJ(SAVED());

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const x = await matrixCalendarTest({ onProgress: (n, d) => n % 20 === 0 && console.log(`downloaded ${n} weeks (up to ${d})`) });
    saveMatrixCalendar(x);
    if (x.blocked) console.log(`Stopped early: ${x.blocked}`);
    const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
    const line = (l, p) => console.log(`${l.padEnd(28)} matrix n${p.matrix.n} won ${Math.round((p.matrix.win || 0) * 100)}% avg ${rs(p.matrix.avg)} (win ${rs(p.matrix.avgWin)} / loss ${rs(p.matrix.avgLoss)}, worst ${rs(p.matrix.worst)}, t ${p.matrix.t?.toFixed(1)}) | condor avg ${rs(p.condor.avg)} worst ${rs(p.condor.worst)}`);
    line('All', x.all);
    for (const [k, v] of Object.entries(x.halves)) line(k, v);
    for (const [k, v] of Object.entries(x.byVix)) line(k, v);
    for (const [k, v] of Object.entries(x.byYear)) line(k, v);
    console.log(x.verdict);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
