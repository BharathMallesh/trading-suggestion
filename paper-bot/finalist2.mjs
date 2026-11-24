#!/usr/bin/env node
// Finalist 2 "heavier momentum" (library + CLI) — PAPER ONLY. The loop-22 algo-search finalist
// R7-s0.500-n4a0.5k24u200, ported from the search engine (core.py, checked against indep.py):
//   • signal at the last NSE session of each month; trade the next session at (open + close) / 2;
//   • universe: the 200 most-traded stocks by median daily traded value of the signal month (≥ 15 sessions),
//     no ETFs, ≥ 260 sessions of history, traded in the last 5 sessions;
//   • score = 0.25·z(6-month return ÷ 1-year vol) + 0.25·z(12-month return ÷ 1-year vol)
//           + 0.5·z(residual 12-1 momentum vs NIFTY) + 0.5·z(share of the last 12 months it beat NIFTY), z clipped ±3;
//   • two tranches of 4 names: tranche 1 re-ranks on rebalances 1, 3, 5… (odd signal months from the Nov 2026
//     start), tranche 2 on 2, 4, 6…; on its month a tranche keeps holdings still in the top 24 and fills from the
//     top, skipping names the other tranche holds and names where one real share costs more than the slot; in its
//     off-month it holds and only fills an empty slot (so both tranches fill on the very first rebalance);
//   • stocks ½ (¼ each tranche), GOLDBEES ⅓, JUNIORBEES ⅙; whole real (unadjusted) shares; parts put back to
//     target only when one drifts more than 5 points; a kept holding is re-sized only when > 50% off its slot
//     (> 10% when the parts are reset);
//   • ₹1,00,000; charges per side 0.175% stocks (+0.15% outside the top 150), 0.15% ETFs, DP ₹15.93 per sell;
//     idle cash 6.5%/yr after tax; tax FIFO (STCG 15→20%, LTCG 10→12.5% above the exemption, gold as non-equity,
//     4% cess), paid at the first rebalance after each financial year.
// Research: won 2010–22, lost both never-seen periods (2023–24, 2025–26) to India mix — tracked on paper only to
// see whether heavier momentum comes back. India mix stays the plan. Not advice.
//
//   node --max-old-space-size=12000 paper-bot/finalist2.mjs --paper            update the paper record
//   node --max-old-space-size=12000 paper-bot/finalist2.mjs --backtest FROM TO  run the rule over FROM..TO

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { loadSeries, pointInTimeUniverse } from './bhav-history.mjs';
import { isEtf } from './momentum.mjs';
import { isTradingDay } from './market-calendar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = () => process.env.FINALIST2_PAPER_PATH || join(HERE, 'data', 'finalist2-paper.json');
const INDIA_PAPER = () => process.env.INDIA_MIX_PAPER_PATH || join(HERE, 'data', 'india-mix-paper.json');

export const RULE = {
  id: 'R7-s0.500-n4a0.5k24u200', name: 'Finalist 2 (heavier momentum)',
  w: { GOLD: 1 / 3, NN50: 1 / 6, S1: 0.25, S2: 0.25 },
  n: 4, keep: 24, universe: 200, minHistory: 260, band: 0.05,
  score: { r6v: 0.25, r12v: 0.25, res: 0.5, nsm: 0.5 },
  capital: 100000, cashYield: 0.065, driftTol: 0.5, resetTol: 0.10, affordPad: 0.004,
};
export const COSTS = { stockSide: 0.00175, illiqExtra: 0.0015, illiqRank: 150, etfSide: 0.0015, dp: 15.93, brokerage: 0 };
export const FUNDS = { GOLD: { symbol: 'GOLDBEES.NS', name: 'Gold (GOLDBEES)', kind: 'oth' }, NN50: { symbol: 'JUNIORBEES.NS', name: 'Nifty Next 50 (JUNIORBEES)', kind: 'eq' } };
export const TRANCHES = { S1: 'Tranche 1', S2: 'Tranche 2' };
export const START_MONTH = '2026-11'; // paper: first signal = the last NSE session of Nov 2026 (30 Nov) → buys 1 Dec 2026
// same ETF test as the search engine (core.py ETF_RE), on top of NSE's own ETF list (momentum.mjs isEtf)
export const ETF_RE = /(BEES|ETF|IETF|SETF|LIQUID|CASE)$|^(SETF|LIQUID|NIFTY|SENSEX|BANKNIFTY|MON100|MAFANG|HNGSNG|NASDAQ|CPSE|BHARAT22)[A-Z0-9]*$|^(GOLD|SILVER)(BEES|ETF|IETF|CASE|1|ADD)$/;
export const RESEARCH = {
  basis: '₹1 lakh, whole shares, after charges and tax, cashed out at the end; worst fall on daily values',
  rows: [
    { period: 'SEARCH 2010–19', f2: 0.1913, im: 0.1245, f2dd: 0.170, imdd: 0.190, seen: 'searched on' },
    { period: 'VALIDATION 2020–22', f2: 0.2859, im: 0.2039, f2dd: 0.242, imdd: 0.239, seen: 'checked once' },
    { period: 'VAL2 2023–24', f2: 0.2300, im: 0.2349, f2dd: 0.125, imdd: 0.116, seen: 'never seen', lost: true },
    { period: 'TEST 2025–26', f2: 0.1618, im: 0.1726, f2dd: 0.172, imdd: 0.159, seen: 'never seen', lost: true },
  ],
  verdict: 'won 2010–22, lost both never-seen periods — tracked on paper only to see whether heavier momentum comes back; India mix stays the plan',
};

// ------------------------------------------------------------------ maths ---
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
/** Standard deviation (ddof 1 = sample, as numpy std(ddof=1); ddof 0 = numpy nanstd). */
export function std(a, ddof = 1) {
  const m = mean(a);
  let s = 0;
  for (const x of a) s += (x - m) ** 2;
  return Math.sqrt(s / (a.length - ddof));
}
/** numpy median (mean of the two middle values for an even count). */
export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
/** Cross-sectional z-scores (population sd, as numpy nanstd), clipped at ±3; all zero when there is no spread. */
export function zscores(a) {
  const m = mean(a);
  const s = std(a, 0);
  return s > 0 ? a.map((x) => Math.max(-3, Math.min(3, (x - m) / s))) : a.map(() => 0);
}
/** Drop a close more than thr off both the last kept close and the median of the next 3 closes (bad ticks). */
export function cleanRows(rows, thr = 0.10) {
  const out = [];
  let last = null;
  for (let i = 0; i < rows.length; i++) {
    const nx = rows.slice(i + 1, i + 4).map((r) => r.close).sort((a, b) => a - b);
    const med = nx.length ? nx[nx.length >> 1] : null;
    if (last != null && med != null && Math.abs(rows[i].close / last - 1) > thr && Math.abs(rows[i].close / med - 1) > thr) continue;
    out.push(rows[i]);
    last = rows[i].close;
  }
  return out;
}
const fyStart = (d) => (+d.slice(5, 7) >= 4 ? +d.slice(0, 4) : +d.slice(0, 4) - 1);
function longTerm(buy, sell, months) {
  const y = +buy.slice(0, 4);
  let m2 = +buy.slice(5, 7) + months;
  let dd = +buy.slice(8, 10);
  const y2 = y + Math.floor((m2 - 1) / 12);
  m2 = ((m2 - 1) % 12) + 1;
  dd = m2 === 2 ? Math.min(dd, 28) : [4, 6, 9, 11].includes(m2) ? Math.min(dd, 30) : dd;
  return sell > `${String(y2).padStart(4, '0')}-${String(m2).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const pmod = (a, b) => ((a % b) + b) % b;

// ------------------------------------------------------------------- tax ---
const CHANGE = '2024-07-23';
const CESS = 1.04;
const SLAB = 0.30;
const CII = { 2008: 137, 2009: 148, 2010: 167, 2011: 184, 2012: 200, 2013: 220, 2014: 240, 2015: 254, 2016: 264, 2017: 272, 2018: 280, 2019: 289, 2020: 301, 2021: 317, 2022: 331, 2023: 348, 2024: 363, 2025: 376, 2026: 390, 2027: 404 };
/** FIFO lots; equity per the app's tax rules; gold ETF as non-equity under each period's rules (port of alloc7.Ledger). */
export class Ledger {
  constructor(s = null) {
    this.lots = s?.lots ? structuredClone(s.lots) : {}; // name → [[units, cost, date, kind]]
    this.fy = s?.fy ? structuredClone(s.fy) : {};
    this.carrySt = s?.carrySt ? structuredClone(s.carrySt) : [];
    this.carryLt = s?.carryLt ? structuredClone(s.carryLt) : [];
    this.paid = s?.paid || 0;
  }
  year(fy) {
    return (this.fy[fy] ??= { eqSt: [], eqLt: [], othSt: 0, othLt: [], income: 0 });
  }
  buy(name, units, price, date, kind) {
    if (units > 1e-12) (this.lots[name] ??= []).push([units, price, date, kind]);
  }
  sell(name, units, price, date) {
    const y = this.year(fyStart(date));
    const regime = date >= CHANGE ? 'after' : 'before';
    const L = (this.lots[name] ??= []);
    let left = units;
    while (left > 1e-12 && L.length) {
      const lot = L[0];
      const u = Math.min(lot[0], left);
      const [, cost, bdate, kind] = lot;
      if (kind === 'eq') {
        (longTerm(bdate, date, 12) ? y.eqLt : y.eqSt).push([u * (price - cost), regime]);
      } else if (date < CHANGE) {
        if (bdate >= '2023-04-01') y.othSt += u * (price - cost);
        else if (longTerm(bdate, date, 36)) y.othLt.push([u * (price - (cost * CII[fyStart(date)]) / CII[fyStart(bdate)]), 0.20]);
        else y.othSt += u * (price - cost);
      } else if (bdate >= '2023-04-01' && date < '2025-04-01') y.othSt += u * (price - cost);
      else if (longTerm(bdate, date, 12)) y.othLt.push([u * (price - cost), 0.125]);
      else y.othSt += u * (price - cost);
      lot[0] -= u;
      left -= u;
      if (lot[0] <= 1e-12) L.shift();
    }
  }
  settle(fy) {
    if (!(fy in this.fy)) return 0;
    const y = this.fy[fy];
    delete this.fy[fy];
    const sum = (arr) => arr.reduce((s, [g]) => s + g, 0);
    let eqSt = sum(y.eqSt);
    let eqLt = sum(y.eqLt);
    let othSt = y.othSt;
    let othLt = sum(y.othLt);
    const posLt = y.othLt.filter(([g]) => g > 0);
    const othLtRate = othLt > 0 ? posLt.reduce((s, [g, r]) => s + g * r, 0) / Math.max(1e-9, posLt.reduce((s, [g]) => s + g, 0)) : 0;
    let stLoss = -Math.min(0, eqSt) - Math.min(0, othSt);
    let ltLoss = -Math.min(0, eqLt) - Math.min(0, othLt);
    [eqSt, othSt, eqLt, othLt] = [Math.max(0, eqSt), Math.max(0, othSt), Math.max(0, eqLt), Math.max(0, othLt)];
    const absorb = (loss, gains) => {
      const out = [];
      for (const g of gains) {
        const u = Math.min(loss, g);
        loss -= u;
        out.push(g - u);
      }
      return [loss, out];
    };
    [stLoss, [othSt, eqSt, othLt, eqLt]] = absorb(stLoss, [othSt, eqSt, othLt, eqLt]);
    [ltLoss, [othLt, eqLt]] = absorb(ltLoss, [othLt, eqLt]);
    this.carrySt = this.carrySt.filter((c) => fy - c[0] <= 8 && c[1] > 1e-9);
    this.carryLt = this.carryLt.filter((c) => fy - c[0] <= 8 && c[1] > 1e-9);
    for (const c of this.carrySt) [c[1], [othSt, eqSt, othLt, eqLt]] = absorb(c[1], [othSt, eqSt, othLt, eqLt]);
    for (const c of this.carryLt) [c[1], [othLt, eqLt]] = absorb(c[1], [othLt, eqLt]);
    if (stLoss > 0) this.carrySt.push([fy, stLoss]);
    if (ltLoss > 0) this.carryLt.push([fy, ltLoss]);
    const shareAfter = (arr) => {
      const pos = arr.filter(([g]) => g > 0);
      const tot = pos.reduce((s, [g]) => s + g, 0);
      return tot ? pos.filter(([, r]) => r === 'after').reduce((s, [g]) => s + g, 0) / tot : fy >= 2024 ? 1 : 0;
    };
    const aSt = shareAfter(y.eqSt);
    const aLt = shareAfter(y.eqLt);
    const stRate = aSt * 0.20 + (1 - aSt) * 0.15;
    const ltRate = aLt * 0.125 + (1 - aLt) * 0.10;
    const exemption = `${fy + 1}-03-31` >= CHANGE ? 125000 : 100000;
    const tax = (eqSt * stRate + Math.max(0, eqLt - exemption) * ltRate + othSt * SLAB + othLt * othLtRate + Math.max(0, y.income) * SLAB) * CESS;
    this.paid += tax;
    return tax;
  }
  toJSON() {
    return { lots: this.lots, fy: this.fy, carrySt: this.carrySt, carryLt: this.carryLt, paid: this.paid };
  }
}

// ----------------------------------------------------------------- world ---
const NaNArr = (n) => new Float64Array(n).fill(NaN);
/**
 * Daily panel on the NSE calendar (NIFTY's sessions): for each stock adjusted open / close (NaN when not traded),
 * last close carried, traded value, and F = real close ÷ adjusted close (carried) to turn adjusted units into real
 * shares. series: Map(sym → [{date, open, close, val, rawClose}]) from loadSeries({ keepRaw: true }).
 * funds: { GOLD: {open: [], close: []}, NN50: {...} } aligned to dates.
 */
export function buildWorld({ series, dates, niftyClose, funds, symbols = null, isStock = (s) => !isEtf(s) && !ETF_RE.test(s) }) {
  const n = dates.length;
  const di = new Map(dates.map((d, i) => [d, i]));
  const to = dates[n - 1];
  let syms = symbols;
  if (!syms) {
    // the panel the search used: every symbol that was ever among the 300 most traded in a month up to `to`
    const keep = new Set();
    for (const [ym, set] of pointInTimeUniverse(series, 300)) if (ym <= to.slice(0, 7)) for (const s of set) keep.add(s);
    syms = [...keep];
  }
  syms = syms.filter((s) => series.has(s) && isStock(s)).sort();
  const S = syms.map((sym) => {
    const O = NaNArr(n), Cr = NaNArr(n), V = NaNArr(n), C = NaNArr(n), F = NaNArr(n);
    let first = -1;
    for (const r of series.get(sym)) {
      const i = di.get(r.date);
      if (i === undefined) continue;
      O[i] = r.open;
      Cr[i] = r.close;
      V[i] = r.val;
      if (r.rawClose != null) F[i] = r.rawClose / r.close;
      if (first < 0 || i < first) first = i;
    }
    let last = NaN;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(Cr[i])) last = Cr[i];
      C[i] = last;
    }
    // F: carried forward, then back-filled before the first day; 1 when unknown
    let f = NaN;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(F[i])) f = F[i];
      F[i] = f;
    }
    const k = F.findIndex(Number.isFinite);
    for (let i = 0; i < n; i++) if (!Number.isFinite(F[i])) F[i] = k >= 0 && i < k ? F[k] : 1;
    return { sym, O, Cr, C, V, F, first: first < 0 ? 0 : first };
  });
  const nifty = Float64Array.from(niftyClose);
  for (let i = 1; i < n; i++) if (!Number.isFinite(nifty[i])) nifty[i] = nifty[i - 1];
  const monthEnds = dates.filter((d, i) => i === n - 1 || dates[i + 1].slice(0, 7) !== d.slice(0, 7));
  return { dates, di, syms, S, si: new Map(syms.map((s, j) => [s, j])), nifty, funds, monthEnds, rankCache: new Map() };
}

/** Rank (1 = most traded) of every stock by median daily traded value over the calendar month ym (≥ 15 sessions); Infinity if none. */
export function rankForMonth(W, ym) {
  if (W.rankCache.has(ym)) return W.rankCache.get(ym);
  const idx = [];
  W.dates.forEach((d, i) => d.slice(0, 7) === ym && idx.push(i));
  const r = new Float64Array(W.syms.length).fill(Infinity);
  if (idx.length) {
    const meds = [];
    W.S.forEach((s, j) => {
      const v = [];
      for (const i of idx) if (Number.isFinite(s.V[i])) v.push(s.V[i]);
      if (v.length >= 15) meds.push([j, median(v)]);
    });
    meds.sort((a, b) => b[1] - a[1]);
    meds.forEach(([j], k) => (r[j] = k + 1));
  }
  W.rankCache.set(ym, r);
  return r;
}

/** Score features of one stock at session t (closes up to t only); null when it lacks the history. */
export function features(W, j, t) {
  const s = W.S[j];
  const C = s.C;
  if (!(t >= 252) || !(C[t] > 0)) return null;
  const R = new Array(252);
  const x = new Array(252);
  for (let k = 0; k < 252; k++) {
    const i = t - 251 + k;
    const a = C[i] > 0 ? Math.log(C[i]) : NaN;
    const b = C[i - 1] > 0 ? Math.log(C[i - 1]) : NaN;
    const r = a - b;
    R[k] = Number.isFinite(r) ? r : 0;
    const q = Math.log(W.nifty[i]) - Math.log(W.nifty[i - 1]);
    x[k] = Number.isFinite(q) ? q : 0;
  }
  const vol = std(R, 1) * Math.sqrt(252);
  const r6 = C[t] / C[t - 126] - 1;
  const r12 = C[t] / C[t - 252] - 1;
  const xm = mean(x);
  const Rm = mean(R);
  let num = 0;
  let den = 0;
  for (let k = 0; k < 252; k++) {
    num += (x[k] - xm) * (R[k] - Rm);
    den += (x[k] - xm) ** 2;
  }
  const beta = num / den;
  const res = R.map((r, k) => r - beta * x[k]);
  const body = res.slice(0, 252 - 21);
  const resScore = body.reduce((a, b) => a + b, 0) / (std(res, 1) * Math.sqrt(body.length));
  let beat = 0;
  for (let k = 12; k >= 1; k--) {
    const a = t - 21 * k;
    const b = t - 21 * (k - 1);
    if (C[b] / C[a] - 1 > W.nifty[b] / W.nifty[a] - 1) beat++;
  }
  return { r6, r12, vol, r6v: r6 / vol, r12v: r12 / vol, res: resScore, nsm: beat / 12, beta };
}

/** The ranked candidate list at signal session t: universe filter, the four z-scored terms, best first. */
export function rankedList(W, t, rank, rule = RULE) {
  const cand = [];
  for (let j = 0; j < W.syms.length; j++) {
    const s = W.S[j];
    if (!(rank[j] <= rule.universe) || t - s.first < rule.minHistory) continue;
    let recent = false;
    for (let i = Math.max(0, t - 4); i <= t; i++) if (Number.isFinite(s.Cr[i])) recent = true;
    if (!recent) continue;
    const f = features(W, j, t);
    if (!f || !Object.keys(rule.score).every((k) => Number.isFinite(f[k])) || !Number.isFinite(f.r12)) continue;
    cand.push({ j, f });
  }
  if (!cand.length) return { order: [], scores: new Map() };
  const sc = new Array(cand.length).fill(0);
  for (const [k, wt] of Object.entries(rule.score)) zscores(cand.map((c) => c.f[k])).forEach((z, i) => (sc[i] += wt * z));
  const idx = cand.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b); // stable: ties keep symbol order
  return { order: idx.map((i) => cand[i].j), scores: new Map(idx.map((i) => [cand[i].j, { score: sc[i], ...cand[i].f }])) };
}

// --------------------------------------------------------------- account ---
const fundMid = (W, k, t) => {
  const o = W.funds[k].open[t];
  const c = W.funds[k].close[t];
  return o > 0 ? (o + c) / 2 : c;
};
const stockMid = (W, j, t) => {
  const s = W.S[j];
  const o = s.O[t];
  const c = s.Cr[t];
  if (!Number.isFinite(c)) return NaN;
  return Number.isFinite(o) && o > 0 ? (o + c) / 2 : c;
};

/**
 * The whole-share ₹ account (port of core.simulate + search.make_plan for this rule). Holds ADJUSTED units
 * internally (as the engine does); real shares = units ÷ F. step(t) runs one session: cash interest, the tax
 * year-end, and the rebalance when t is the session after a month-end signal.
 */
export class Account {
  constructor(W, { rule = RULE, costs = COSTS, capital = rule.capital, startMonth = null, logTrades = true, ranker = null } = {}) {
    // ranker(W, t, rank) → ordered stock indices; default = the rule's score (tests may pass a fixed order)
    Object.assign(this, { W, rule, costs, logTrades, startMonth, ranker: ranker || ((w, t, r) => rankedList(w, t, r, rule).order) });
    this.cash = capital;
    this.capital = capital;
    this.units = new Map(); // 'F:GOLD' | 'S:SYM' → adjusted units
    this.sleeveOf = new Map(); // 'S:SYM' → 'S1' | 'S2'
    this.entry = new Map(); // key → { date, px (adjusted mid incl. nothing), units }
    this.ledger = new Ledger();
    this.pendingTax = 0;
    this.taxes = 0;
    this.k = 0;
    this.last = null; // last session index stepped
    this.trades = [];
    this.rebalances = [];
    this.turnover = 0;
    this.sellOrders = 0;
    this.entries = new Map();
    for (const sig of W.monthEnds) {
      const i = W.di.get(sig);
      if (i + 1 < W.dates.length) this.entries.set(i + 1, sig);
    }
  }
  price(key, t) {
    if (key.startsWith('F:')) return fundMid(this.W, key.slice(2), t);
    const j = this.W.si.get(key.slice(2));
    const p = stockMid(this.W, j, t);
    return Number.isFinite(p) ? p : this.W.S[j].C[t];
  }
  close(key, t) {
    return key.startsWith('F:') ? this.W.funds[key.slice(2)].close[t] : this.W.S[this.W.si.get(key.slice(2))].C[t];
  }
  value(t) {
    let v = this.cash;
    for (const [k, u] of this.units) v += u * this.close(k, t);
    return v;
  }
  step(t) {
    const W = this.W;
    const ds = W.dates;
    if (this.last != null && t > this.last) {
      const dt = (Date.parse(ds[t]) - Date.parse(ds[t - 1])) / (365.25 * 86400000);
      this.cash *= (1 + this.rule.cashYield) ** dt;
      if (fyStart(ds[t - 1]) !== fyStart(ds[t])) this.pendingTax += this.ledger.settle(fyStart(ds[t - 1]));
    }
    this.last = t;
    const sig = this.entries.get(t);
    if (sig && (!this.startMonth || sig.slice(0, 7) >= this.startMonth)) this.rebalance(t, sig);
    return this.value(t);
  }
  rebalance(t, sig) {
    const { W, rule, costs } = this;
    const d = W.dates[t];
    this.k++;
    const rank = rankForMonth(W, sig.slice(0, 7));
    const ranked = this.ranker(W, W.di.get(sig), rank);
    const heldSet = new Set([...this.units].filter(([k, u]) => k.startsWith('S:') && u > 0).map(([k]) => W.si.get(k.slice(2))));
    const held = [...heldSet];
    const plan = {};
    const reranked = [];
    for (const [s, offset] of [['S1', 0], ['S2', 1]]) {
      const off = pmod(this.k - 1 - offset, 2) !== 0;
      if (off) plan[s] = { lst: [...held, ...ranked.filter((j) => !heldSet.has(j))], keep: 1e6 };
      else {
        plan[s] = { lst: ranked, keep: rule.keep };
        reranked.push(s);
      }
    }
    let taxPaid = 0;
    if (this.pendingTax > 0) {
      this.cash -= this.pendingTax;
      this.taxes += this.pendingTax;
      taxPaid = this.pendingTax;
      this.pendingTax = 0;
    }
    const pr = new Map();
    const sv = new Map();
    for (const [k, u] of this.units) {
      if (u === 0) continue;
      pr.set(k, this.price(k, t));
      const s = k.startsWith('F:') ? k.slice(2) : this.sleeveOf.get(k);
      sv.set(s, (sv.get(s) || 0) + u * pr.get(k));
    }
    const total = this.cash + [...sv.values()].reduce((a, b) => a + b, 0);
    const fresh = sv.size === 0;
    const w = rule.w;
    const sleeves = [...new Set([...Object.keys(w), ...sv.keys()])].sort();
    const cur = Object.fromEntries(sleeves.map((s) => [s, (sv.get(s) || 0) / total]));
    let reb = fresh || rule.band == null || sleeves.some((s) => Math.abs((cur[s] || 0) - (w[s] || 0)) > rule.band);
    if ([...sv.keys()].some((s) => !w[s] && sv.get(s) > 0)) reb = true;
    const goal = Object.fromEntries(sleeves.map((s) => [s, reb ? total * (w[s] || 0) : sv.get(s) || 0]));
    const orders = [];
    for (const s of sleeves) {
      if (!(s in FUNDS)) continue;
      const k = `F:${s}`;
      const p = fundMid(W, s, t);
      const have = this.units.get(k) || 0;
      if (reb) {
        let want = Math.floor(goal[s] / (p * (1 + costs.etfSide)));
        if (goal[s] > 0 && have > 0 && Math.abs(want - have) * p < 0.005 * goal[s]) want = have;
        if (want !== have) orders.push({ k, du: want - have, p, kind: 'etf' });
      }
    }
    const sideOf = (j) => costs.stockSide + (rank[j] > costs.illiqRank ? costs.illiqExtra : 0);
    const claimed = new Set();
    const picks = {};
    for (const s of sleeves) {
      if (!s.startsWith('S')) continue;
      const { lst, keep } = plan[s] || { lst: [], keep: 0 };
      const n = rule.n;
      const mine = [...this.units].filter(([k, u]) => k.startsWith('S:') && u > 0 && this.sleeveOf.get(k) === s).map(([k]) => k);
      const g = w[s] > 0 ? goal[s] || 0 : 0;
      if (g <= 0 || n === 0) {
        for (const k of mine) orders.push({ k, du: -this.units.get(k), p: this.price(k, t), kind: 'stk' });
        continue;
      }
      const slot = g / n;
      const pos = new Map(lst.map((j, i) => [j, i]));
      const jOf = (k) => W.si.get(k.slice(2));
      const keepers = mine.filter((k) => (pos.has(jOf(k)) ? pos.get(jOf(k)) : 1e9) < keep).sort((a, b) => pos.get(jOf(a)) - pos.get(jOf(b))).slice(0, n);
      const chosen = keepers.map(jOf);
      const other = new Set([...this.units].filter(([k, u]) => k.startsWith('S:') && u > 0 && this.sleeveOf.get(k) !== s).map(([k]) => jOf(k)));
      for (const j of claimed) other.add(j);
      for (const j of lst) {
        if (chosen.length >= n) break;
        if (chosen.includes(j) || other.has(j)) continue;
        const p = stockMid(W, j, t);
        if (!Number.isFinite(p) || p <= 0) continue;
        if (p * W.S[j].F[t] * (1 + rule.affordPad) > slot) continue; // one real share costs more than the slot
        chosen.push(j);
      }
      for (const j of chosen) claimed.add(j);
      picks[s] = { kept: keepers.map((k) => k.slice(2)), chosen: chosen.map((j) => W.syms[j]), slot };
      const chosenSet = new Set(chosen);
      for (const k of mine) if (!chosenSet.has(jOf(k))) orders.push({ k, du: -this.units.get(k), p: this.price(k, t), kind: 'stk' });
      if (chosen.length) {
        const per = g / chosen.length;
        for (const j of chosen) {
          const k = `S:${W.syms[j]}`;
          let p = stockMid(W, j, t);
          if (!Number.isFinite(p)) p = W.S[j].C[t];
          const have = this.units.get(k) || 0;
          const side = sideOf(j);
          if (have > 0 && !reb && Math.abs((have * p) / per - 1) <= rule.driftTol) continue;
          if (have > 0 && reb && Math.abs((have * p) / per - 1) <= rule.resetTol) continue;
          const fr = W.S[j].F[t];
          const want = Math.floor(per / (p * (1 + side)) / fr) * fr; // whole REAL shares
          if (Math.abs(want - have) > 1e-9) orders.push({ k, du: want - have, p, kind: 'stk', side });
          this.sleeveOf.set(k, s);
        }
      }
    }
    orders.sort((a, b) => a.du - b.du); // sells first (stable)
    let cost = 0;
    const done = [];
    for (const o of orders) {
      let { du } = o;
      const { k, p } = o;
      const isFund = o.kind === 'etf';
      const j = isFund ? null : W.si.get(k.slice(2));
      const side = isFund ? costs.etfSide : o.side ?? sideOf(j);
      const kind = isFund ? FUNDS[k.slice(2)].kind : 'eq';
      const name = isFund ? k.slice(2) : k;
      const fr = isFund ? 1 : W.S[j].F[t];
      if (du < 0) {
        const sp = p * (1 - side);
        this.ledger.sell(name, -du, sp, d);
        this.cash += -du * sp - costs.dp - costs.brokerage;
        cost += -du * p * side + costs.dp + costs.brokerage;
        this.sellOrders++;
      } else {
        const bp = p * (1 + side);
        let c = du * bp + costs.brokerage;
        if (this.cash - c < -1e-6) {
          du = Math.floor(Math.max(0, this.cash - costs.brokerage) / (bp * fr)) * fr;
          if (du <= 0) continue;
          c = du * bp + costs.brokerage;
        }
        this.ledger.buy(name, du, bp, d, kind);
        this.cash -= c;
        cost += du * p * side + costs.brokerage;
        const e = this.entry.get(k);
        const have = this.units.get(k) || 0;
        this.entry.set(k, have > 0 && e ? { date: e.date, px: (e.px * have + p * du) / (have + du) } : { date: d, px: p });
      }
      this.turnover += Math.abs(du) * p;
      const nu = (this.units.get(k) || 0) + du;
      this.units.set(k, nu <= 1e-12 ? 0 : nu);
      const trade = { date: d, signal: sig, name: isFund ? k.slice(2) : k.slice(2), units: du, shares: du / fr, mid: p, realMid: p * fr };
      done.push(trade);
      if (this.logTrades) this.trades.push(trade);
    }
    for (const [k, u] of [...this.units]) {
      if (u === 0) {
        this.units.delete(k);
        this.sleeveOf.delete(k);
        this.entry.delete(k);
      }
    }
    const rec = {
      monthEnd: sig, date: d, k: this.k, reranked, reset: reb, fresh, weightsBefore: cur, total, cost, taxPaid,
      picks, orders: done, holdings: this.holdings(t), cash: this.cash, value: this.value(t),
    };
    this.rebalances.push(rec);
    return rec;
  }
  /** Holdings in real shares at session t (stocks with tranche, entry and last real price). */
  holdings(t) {
    const out = [];
    for (const [k, u] of this.units) {
      if (k.startsWith('F:')) {
        const f = k.slice(2);
        const e = this.entry.get(k);
        out.push({ kind: f === 'GOLD' ? 'gold' : 'fund', part: f, symbol: FUNDS[f].symbol, name: FUNDS[f].name, shares: u, entry: e?.px ?? null, entryDate: e?.date ?? null, last: this.W.funds[f].close[t], value: u * this.W.funds[f].close[t] });
      } else {
        const j = this.W.si.get(k.slice(2));
        const F = this.W.S[j].F[t];
        const e = this.entry.get(k);
        out.push({ kind: 'stock', part: this.sleeveOf.get(k), symbol: k.slice(2), name: k.slice(2), shares: u / F, entry: e ? e.px * F : null, entryDate: e?.date ?? null, last: this.W.S[j].C[t] * F, value: u * this.W.S[j].C[t] });
      }
    }
    return out;
  }
  /** Sell everything at session t's close and pay the remaining tax (the search's "cashed out" figure). */
  cashOut(t) {
    const d = this.W.dates[t];
    let liq = this.cash;
    for (const [k, u] of this.units) {
      const isFund = k.startsWith('F:');
      const sp = this.close(k, t) * (1 - (isFund ? this.costs.etfSide : this.costs.stockSide));
      this.ledger.sell(isFund ? k.slice(2) : k, u, sp, d);
      liq += u * sp - this.costs.dp - this.costs.brokerage;
    }
    const ft = this.ledger.settle(fyStart(d));
    return { liq: liq - ft - this.pendingTax, taxes: this.taxes + ft + this.pendingTax };
  }
  /** Persistable state in REAL shares / prices as of session t (adjusted prices change when a later split arrives). */
  toState(t) {
    const fOf = (k) => (k.startsWith('S:') ? this.W.S[this.W.si.get(k.slice(2))].F[t] : 1);
    const lots = {};
    for (const [name, L] of Object.entries(this.ledger.lots)) {
      if (!L.length) continue;
      const f = fOf(name);
      lots[name] = L.map(([u, c, dt, kind]) => [u / f, c * f, dt, kind]);
    }
    return {
      asOf: this.W.dates[t], k: this.k, cash: this.cash, pendingTax: this.pendingTax, taxes: this.taxes, capital: this.capital,
      positions: [...this.units].map(([k, u]) => {
        const f = fOf(k);
        const e = this.entry.get(k);
        return { key: k, sleeve: k.startsWith('S:') ? this.sleeveOf.get(k) : k.slice(2), shares: u / f, entry: e ? { date: e.date, px: e.px * f } : null };
      }),
      ledger: { ...this.ledger.toJSON(), lots },
    };
  }
  /** Rebuild from toState() on a fresh world (re-reads F at the saved date, so splits since then carry over). */
  static fromState(W, st, opts = {}) {
    const a = new Account(W, { ...opts, capital: st.capital });
    const t = W.di.get(st.asOf);
    if (t === undefined) throw new Error(`saved date ${st.asOf} is not in the calendar`);
    const fOf = (k) => (k.startsWith('S:') ? (W.si.has(k.slice(2)) ? W.S[W.si.get(k.slice(2))].F[t] : 1) : 1);
    Object.assign(a, { k: st.k, cash: st.cash, pendingTax: st.pendingTax, taxes: st.taxes, last: t });
    for (const p of st.positions) {
      if (p.key.startsWith('S:') && !W.si.has(p.key.slice(2))) throw new Error(`${p.key.slice(2)} missing from the stock data`);
      const f = fOf(p.key);
      a.units.set(p.key, p.shares * f);
      if (p.key.startsWith('S:')) a.sleeveOf.set(p.key, p.sleeve);
      if (p.entry) a.entry.set(p.key, { date: p.entry.date, px: p.entry.px / f });
    }
    const lots = {};
    for (const [name, L] of Object.entries(st.ledger?.lots || {})) {
      const f = fOf(name);
      lots[name] = L.map(([u, c, dt, kind]) => [u * f, c / f, dt, kind]);
    }
    a.ledger = new Ledger({ ...st.ledger, lots });
    return a;
  }
}

/** Backtest over [from, to] (entries on sessions from..to), cashed out at the last session — as core.simulate. */
export function simulate(W, from, to, opts = {}) {
  const a = new Account(W, opts);
  const ds = W.dates;
  const starts = [...a.entries.keys()].filter((i) => ds[i] >= from && ds[i] <= to);
  const t0 = Math.min(...starts);
  let tE = 0;
  for (let i = 0; i < ds.length; i++) if (ds[i] <= to) tE = i;
  a.entries = new Map([...a.entries].filter(([i]) => starts.includes(i)));
  const values = [];
  for (let t = t0; t <= tE; t++) values.push({ date: ds[t], value: a.step(t) });
  const { liq, taxes } = a.cashOut(tE);
  const yrs = (Date.parse(ds[tE]) - Date.parse(ds[t0 > 0 ? t0 - 1 : t0])) / (365.25 * 86400000);
  let peak = 0;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v.value);
    dd = Math.max(dd, 1 - v.value / peak);
  }
  return { account: a, values, liq, taxes, cagr: (liq / a.capital) ** (1 / yrs) - 1, dd, years: yrs, rebalances: a.rebalances, trades: a.trades, turnoverPerYear: a.turnover / a.capital / yrs, sellOrders: a.sellOrders };
}

// ------------------------------------------------------------- app data ---
/** Real ETF / index candles on the calendar (carried forward over missing days). */
export function onCalendar(rows, dates) {
  const m = new Map(rows.map((r) => [r.date, r]));
  const open = NaNArr(dates.length);
  const close = NaNArr(dates.length);
  let last = null;
  dates.forEach((d, i) => {
    if (m.has(d)) last = m.get(d);
    if (last) {
      open[i] = last.open;
      close[i] = last.close;
    }
  });
  return { open, close };
}
/** World from the app's data: bhav store (stocks, real + adjusted prices), ^NSEI (calendar, NIFTY), GOLDBEES and JUNIORBEES. */
export async function loadWorld({ to = null, loadCandles = candles, series = null } = {}) {
  const sr = series || loadSeries({ keepRaw: true });
  let lastBhav = '';
  for (const rows of sr.values()) if (rows.length && rows.at(-1).date > lastBhav) lastBhav = rows.at(-1).date;
  const p1 = Math.floor(Date.parse('2007-09-01') / 1000);
  const cut = to && to < lastBhav ? to : lastBhav;
  const nifty = (await loadCandles('^NSEI', { period1: p1, interval: '1d' })).filter((r) => r.close > 0 && r.date <= cut);
  const dates = nifty.map((r) => r.date);
  const funds = {};
  for (const [k, f] of Object.entries(FUNDS)) funds[k] = onCalendar(cleanRows((await loadCandles(f.symbol, { period1: p1, interval: '1d' })).filter((r) => r.close > 0)), dates);
  return buildWorld({ series: sr, dates, niftyClose: nifty.map((r) => r.close), funds });
}

// ---------------------------------------------------------------- paper ---
const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const loadFinalist2Paper = () => readJ(PAPER());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The next month-end signal (last NSE session of the month) on or after `date`, the session after it, and the tranche that re-ranks. */
export function nextRebalance(date, k, startMonth = START_MONTH, tradingDay = isTradingDay) {
  let ym = date.slice(0, 7) < startMonth ? startMonth : date.slice(0, 7);
  for (let guard = 0; guard < 3; guard++) {
    const [y, m] = ym.split('-').map(Number);
    let d = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last calendar day of ym
    while (!tradingDay(d)) d = addDays(d, -1);
    if (d >= date) {
      let e = addDays(d, 1);
      while (!tradingDay(e)) e = addDays(e, 1);
      const next = k + 1;
      const tranche = next === 1 ? 'both tranches (first month: the portfolio starts fully invested)' : next % 2 ? 'Tranche 1 re-ranks' : 'Tranche 2 re-ranks';
      return { signal: d, trade: e, k: next, tranche };
    }
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return null;
}
/** Paper value vs India mix paper and NIFTY since the first rebalance (from the signal-day closes). */
export function compareSinceStart(paper, india) {
  const first = paper?.rebalances?.[0];
  const last = paper?.curve?.at(-1);
  if (!first || !last) return null;
  const base = first.monthEnd;
  const im = (india?.curve || []).filter((c) => c.date <= last.date);
  const imBase = [...im].reverse().find((c) => c.date <= base) || null;
  const imLast = im.at(-1) || null;
  return {
    from: base, to: last.date,
    finalist2: last.value / paper.capital - 1,
    indiaMix: imBase && imLast && imLast.date > imBase.date ? imLast.value / imBase.value - 1 : null,
    indiaMixFrom: imBase?.date ?? null,
    nifty: paper.niftyAtStart && last.nifty ? last.nifty / paper.niftyAtStart - 1 : null,
  };
}
/**
 * Update the paper record: restore the account at its last session, run every new session up to the latest
 * NSE file (rebalancing after each month-end from Nov 2026), mark it at the close, save.
 */
export async function finalist2PaperUpdate({ world = null, loadCandles = candles, now = new Date(), path = PAPER(), indiaPath = INDIA_PAPER() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = readJ(path) || { startedAt: today, capital: RULE.capital, rule: RULE.id, startMonth: START_MONTH, rebalances: [], curve: [], marks: [], account: null };
  const W = world || (await loadWorld({ loadCandles }));
  const ds = W.dates;
  const lastT = ds.length - 1;
  let a;
  let t0;
  if (st.account) {
    a = Account.fromState(W, st.account, { startMonth: st.startMonth });
    t0 = W.di.get(st.account.asOf) + 1;
  } else {
    a = new Account(W, { capital: st.capital, startMonth: st.startMonth });
    t0 = Math.min(Infinity, ...[...a.entries].filter(([, sig]) => sig.slice(0, 7) >= st.startMonth).map(([i]) => i));
  }
  for (let t = t0; t <= lastT; t++) {
    const v = a.step(t);
    const rec = a.rebalances.at(-1);
    if (rec && rec.date === ds[t] && !st.rebalances.some((r) => r.date === rec.date)) {
      if (!st.rebalances.length) st.niftyAtStart = W.nifty[W.di.get(rec.monthEnd)];
      st.rebalances.push({ ...rec, total: Math.round(rec.total * 100) / 100, value: Math.round(rec.value * 100) / 100 });
    }
    st.curve = [...st.curve.filter((c) => c.date !== ds[t]), { date: ds[t], value: v, nifty: W.nifty[t] }];
  }
  if (a.last != null) {
    st.account = a.toState(a.last);
    st.marks = a.holdings(a.last).map((h) => ({ ...h, retPct: h.entry ? (h.last / h.entry - 1) * 100 : null }));
    st.cash = a.cash;
  }
  st.dataTo = ds[lastT];
  st.next = nextRebalance(addDays(ds[lastT], 1), a.k, st.startMonth);
  st.compare = compareSinceStart(st, readJ(indiaPath));
  st.updatedAt = now.toISOString();
  writeJsonAtomic(path, st);
  return st;
}

/** What the card shows: the paper record (without the tax ledger), the live comparison, the next rebalance, the research. */
export function finalist2View({ now = new Date(), paper = loadFinalist2Paper(), india = readJ(INDIA_PAPER()) } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const { account, ...p } = paper || {};
  const k = account?.k ?? 0;
  return {
    rule: { id: RULE.id, name: RULE.name, weights: { stocks: RULE.w.S1 + RULE.w.S2, gold: RULE.w.GOLD, next50: RULE.w.NN50 }, n: RULE.n, keep: RULE.keep, band: RULE.band, capital: RULE.capital, startMonth: START_MONTH },
    paper: paper ? { ...p, k, cash: account?.cash ?? null, taxesPaid: account?.taxes ?? 0 } : null,
    compare: paper ? compareSinceStart(paper, india) : null,
    next: nextRebalance(paper?.dataTo && paper.dataTo >= today ? addDays(paper.dataTo, 1) : today, k, paper?.startMonth || START_MONTH),
    research: RESEARCH,
    firstMonth: 'First rebalance (signal 30 Nov 2026 → buys Tue 1 Dec 2026): both tranches are filled at once — tranche 1 takes the top 4 names it can afford and tranche 2 (not its re-rank month) fills its empty slots with the next 4 — so the portfolio starts fully invested. After that they alternate: tranche 2 re-ranks at the December month-end, tranche 1 at January\'s, and so on.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rs = (x) => `₹${Math.round(x).toLocaleString('en-IN')}`;
    if (process.argv.includes('--backtest')) {
      const [from = '2023-01-01', to = '2026-11-04'] = process.argv.slice(process.argv.indexOf('--backtest') + 1);
      const W = await loadWorld({ to });
      const r = simulate(W, from, to);
      console.log(`Finalist 2 backtest ${from} → ${to}: ${rs(r.liq)} after tax (${(r.cagr * 100).toFixed(2)}%/yr), worst fall ${(r.dd * 100).toFixed(1)}%, ${r.rebalances.length} rebalances, ${r.trades.length} trades. Not advice.`);
    } else {
      const st = await finalist2PaperUpdate();
      const v = st.curve.at(-1)?.value ?? st.capital;
      const n = st.next;
      console.log(`Finalist 2 paper: since ${st.startedAt} · ${st.rebalances.length} rebalance(s) · value ${rs(v)} · data to ${st.dataTo}${n ? ` · next: signal ${n.signal} → trade ${n.trade} (${n.tranche})` : ''} · paper only, not advice`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
