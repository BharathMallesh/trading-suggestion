#!/usr/bin/env node
// Momentum 20 (library + CLI): the best-evidenced way of choosing stocks —
// hold the stocks that rose most over the past year, refreshed every month —
// tested survivorship-free on NSE's own daily files, then shown as a monthly
// screen and tracked as a paper portfolio.
//
// Rules (fixed before testing):
//   Universe   each month, the 200 most-traded NSE stocks as they were then
//              (bhav-history.mjs pointInTimeUniverse), with 13+ months of prices
//   Ranking    A "12-1":  return from 12 months ago to 1 month ago
//              B "NSE-style": average of the 6- and 12-month returns, each
//                 divided by the stock's 1-year daily volatility (annualised)
//              — the method is chosen on 2010–17 and judged once on 2018 →
//   Portfolio  the top 20, equal weights, bought at the open of the first
//              session of the month; held to the next month's first open; a
//              stock that stops trading is sold at its last close (cash after)
//   Costs      0.25% of the value traded per side (STT 0.1%, exchange, stamp,
//              GST, ₹0 brokerage) + 0.10% slippage per side
//   Tax        simplified: a stock sold within a year → short-term (15%, 20%
//              from 23 Jul 2024, +4% cess), later → long-term (10% / 12.5%
//              above the yearly exemption); netted per financial year
// Research / paper only — not investment advice.
//
//   node paper-bot/momentum.mjs           # backtest (saved for the app, ~1 min)
//   node paper-bot/momentum.mjs --paper   # this month's list + paper portfolio update

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.MOMENTUM_PATH || join(HERE, 'data', 'momentum.json');
const PAPER = () => process.env.MOMENTUM_PAPER_PATH || join(HERE, 'data', 'momentum-paper.json');

export const RULES = { top: 20, costPct: 0.25, slipPct: 0.1, split: '2018-01-01', from: '2010-01-01' };
const stcg = (d) => (d >= '2024-07-23' ? 0.2 : 0.15) * 1.04;
const ltcg = (d) => (d >= '2024-07-23' ? 0.125 : 0.1) * 1.04;
const ltEx = (d) => (d >= '2024-07-23' ? 125000 : 100000);

// ------------------------------------------------------------------ ETFs ---
// NSE lists ETFs (liquid, gold, index funds) alongside shares; they are not stocks
// and a liquid ETF's tiny steady gains look huge after the volatility adjustment.
const ETF_PATH = () => process.env.NSE_ETF_PATH || join(HERE, 'data', 'nse-etfs.json');
const ETF_NAME = /(BEES|ETF|IETF|SETF|LIQUID|CASE)$|^(SETF|LIQUID|NIFTY|SENSEX|BANKNIFTY|MON100|MAFANG|HNGSNG|NASDAQ|CPSE|BHARAT22)[A-Z0-9]*$|^(GOLD|SILVER)(BEES|ETF|IETF|CASE|1|ADD)$/;
let etfSet = null;
export function isEtf(symbol) {
  if (!etfSet) {
    try {
      etfSet = new Set(JSON.parse(readFileSync(ETF_PATH(), 'utf8')).symbols);
    } catch {
      etfSet = new Set();
    }
  }
  return etfSet.has(symbol) || ETF_NAME.test(symbol);
}
/** Download NSE's ETF list (weekly refit); keeps the old list on failure. */
export async function refreshEtfList({ fetchFn = fetch } = {}) {
  const res = await fetchFn('https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`NSE ETF list: HTTP ${res.status}`);
  const symbols = (await res.text()).split(/\r?\n/).slice(1).map((l) => l.split(',')[0].trim()).filter((x) => /^[A-Z0-9&-]+$/.test(x));
  if (symbols.length < 50) throw new Error('NSE ETF list looks empty');
  writeJsonAtomic(ETF_PATH(), { at: new Date().toISOString(), symbols });
  etfSet = new Set(symbols);
  return symbols.length;
}

// ---------------------------------------------------------------- prices ---
/** Per symbol: sorted dates, closes, opens — with a "price on or before" lookup. */
export function priceIndex(series) {
  const idx = new Map();
  for (const [sym, rows] of series) {
    const ok = rows.filter((r) => r.close > 0);
    idx.set(sym, { dates: ok.map((r) => r.date), close: ok.map((r) => r.close), open: ok.map((r) => r.open || r.close), last: ok.length ? ok[ok.length - 1].date : null });
  }
  return idx;
}
export const at = (p, date) => {
  // last index with dates[i] <= date
  let lo = 0;
  let hi = p.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.dates[mid] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
};
export const monthsBack = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - n, Math.min(d, 28)));
  return t.toISOString().slice(0, 10);
};

/** Momentum scores of the eligible stocks at a month-end. */
export function scores(idx, symbols, monthEnd, method = 'a') {
  const out = [];
  for (const s of symbols) {
    if (isEtf(s)) continue;
    const p = idx.get(s);
    if (!p) continue;
    const i0 = at(p, monthEnd);
    if (i0 < 0 || p.dates[i0] < monthsBack(monthEnd, 0.2)) continue; // must have traded in the last week
    const i1 = at(p, monthsBack(monthEnd, 1));
    const i6 = at(p, monthsBack(monthEnd, 6));
    const i12 = at(p, monthsBack(monthEnd, 12));
    if (i12 < 0 || i1 < 0 || i6 < 0 || p.dates[i12] < monthsBack(monthEnd, 13)) continue; // 13 months of history
    if (method === 'a') {
      out.push({ symbol: s, score: p.close[i1] / p.close[i12] - 1, ret12: p.close[i0] / p.close[i12] - 1, close: p.close[i0] });
    } else {
      // NSE-style: 6m and 12m returns divided by 1-year volatility
      const rets = [];
      for (let k = Math.max(i12 + 1, 1); k <= i0; k++) rets.push(Math.log(p.close[k] / p.close[k - 1]));
      if (rets.length < 150) continue;
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
      if (!(vol > 0)) continue;
      out.push({ symbol: s, r6: (p.close[i0] / p.close[i6] - 1) / vol, r12: (p.close[i0] / p.close[i12] - 1) / vol, ret12: p.close[i0] / p.close[i12] - 1, vol, close: p.close[i0] });
    }
  }
  if (method !== 'a' && out.length) {
    const z = (k) => {
      const v = out.map((x) => x[k]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)) || 1;
      return (x) => (x[k] - m) / sd;
    };
    const z6 = z('r6');
    const z12 = z('r12');
    for (const x of out) x.score = (z6(x) + z12(x)) / 2;
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Month-end trading dates (the last stored date of each month) from a reference series. */
export function monthEnds(dates) {
  const out = [];
  for (let i = 0; i < dates.length; i++) if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) out.push(dates[i]);
  return out;
}
const nextMonthKey = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

// ------------------------------------------------------------- simulation ---
/**
 * Monthly rebalanced top-N portfolio. Returns the value at each rebalance, the
 * holdings, turnover and (simplified) tax. refDates = trading dates (e.g. NIFTY).
 */
export function simulate({ idx, universe, refDates, method = 'a', r = RULES, from = r.from, to = null, tax = false, rank = null, gate = null }) {
  // rank(idx, symbols, monthEnd) → sorted [{symbol, score}] replaces the momentum score;
  // gate(monthEnd) → false holds cash (a liquid fund at r.cashYield a year) until it says true again

  const ends = monthEnds(refDates).filter((d) => d >= monthsBack(from, 1) && (!to || d <= to));
  const firstAfter = (d) => refDates.find((x) => x > d) || null;
  let value = 1;
  let holdings = []; // { symbol, w (weight of value at entry), entry (price), entryDate }
  const curve = [];
  const lists = [];
  let turnoverSum = 0;
  let fy = null;
  let fyST = 0;
  let fyLT = 0;
  let taxPaid = 0;
  const side = (r.costPct + r.slipPct) / 100;
  // fill price on a trading day: the open (default) or the midpoint of open and close ("realistic")
  const fillAt = (p, i) => (r.fill === 'mid' ? (p.open[i] + p.close[i]) / 2 : p.open[i]);
  let cash = false;
  let prevDay = null;
  const every = r.rebalanceEvery || 1; // months between rebalances (3 = quarterly: after Mar, Jun, Sep, Dec)
  const payTax = (date) => {
    let t = 0;
    if (fyST > 0) t += fyST * stcg(date);
    if (fyLT > ltEx(date) / 1e6) t += (fyLT - ltEx(date) / 1e6) * ltcg(date); // value is per ₹10 lakh start
    taxPaid += t;
    value -= t;
    fyST = 0;
    fyLT = 0;
  };
  for (let k = 0; k < ends.length - 1; k++) {
    const signal = ends[k];
    const entryDay = firstAfter(signal);
    const exitSignal = ends[k + 1];
    const exitDay = firstAfter(exitSignal) || exitSignal;
    if (!entryDay || entryDay < from) continue;
    if (every > 1 && holdings.length && Number(signal.slice(5, 7)) % every !== 0) continue; // hold until the next rebalance month
    if (cash && prevDay) value *= (1 + (r.cashYield || 0)) ** ((Date.parse(entryDay) - Date.parse(prevDay)) / (365.25 * 86400000));
    prevDay = entryDay;
    // 1. value the current holdings at today's open (entryDay) — exits use the open, vanished stocks their last close
    if (holdings.length) {
      let v = 0;
      for (const h of holdings) {
        const p = idx.get(h.symbol);
        const i = at(p, entryDay);
        const px = i >= 0 && p.dates[i] === entryDay ? fillAt(p, i) : i >= 0 ? p.close[i] : h.entry;
        h.now = px;
        v += h.w * (px / h.entry);
      }
      value *= v;
      // weights after drift
      for (const h of holdings) h.wNow = (h.w * (h.now / h.entry)) / v;
    }
    // 2. new list (or cash when the gate says out)
    const elig = universe.get(nextMonthKey(signal.slice(0, 7)));
    if (!elig) continue;
    const fyHere = Number(entryDay.slice(5, 7)) >= 4 ? Number(entryDay.slice(0, 4)) : Number(entryDay.slice(0, 4)) - 1;
    if (gate && !gate(signal)) {
      if (holdings.length) {
        let sold = 0;
        for (const h of holdings) {
          sold += h.wNow;
          if (tax) {
            const gain = value * h.wNow * (1 - h.basis / h.now);
            if ((Date.parse(entryDay) - Date.parse(h.entryDate)) / 86400000 >= 365) fyLT += gain;
            else fyST += gain;
          }
        }
        turnoverSum += sold / 2;
        value *= 1 - sold * side;
        holdings = [];
      }
      if (tax && fy != null && fyHere !== fy) payTax(entryDay);
      fy = fyHere;
      cash = true;
      curve.push({ date: entryDay, value });
      lists.push({ signal, entryDay, exitDay, symbols: [] });
      continue;
    }
    cash = false;
    const ranked = rank ? rank(idx, [...elig].filter((s) => !isEtf(s)), signal) : scores(idx, [...elig], signal, method);
    const pick = ranked.slice(0, r.top).filter((x) => {
      const p = idx.get(x.symbol);
      const i = at(p, entryDay);
      return i >= 0 && p.dates[i] === entryDay; // tradable on the entry day
    });
    if (!pick.length) continue;
    const target = new Map(pick.map((x) => [x.symbol, 1 / pick.length]));
    // 3. turnover and costs; tax on every sale (full exits and trims back to equal weight) against the cost basis
    let turnover = 0;
    const cur = new Map(holdings.map((h) => [h.symbol, h]));
    for (const [s, w] of target) turnover += Math.abs(w - (cur.get(s)?.wNow || 0));
    const realise = (h, soldWeight) => {
      if (!tax || soldWeight <= 0) return;
      const gain = value * soldWeight * (1 - h.basis / h.now);
      const held = (Date.parse(entryDay) - Date.parse(h.entryDate)) / 86400000;
      if (held >= 365) fyLT += gain;
      else fyST += gain;
    };
    for (const h of holdings) {
      if (!target.has(h.symbol)) {
        turnover += h.wNow;
        realise(h, h.wNow);
      } else if (target.get(h.symbol) < h.wNow) realise(h, h.wNow - target.get(h.symbol));
    }
    if (!holdings.length) turnover = 1;
    turnoverSum += turnover / 2;
    value *= 1 - turnover * side;
    // financial year boundary: pay last year's tax
    const fyNow = Number(entryDay.slice(5, 7)) >= 4 ? Number(entryDay.slice(0, 4)) : Number(entryDay.slice(0, 4)) - 1;
    if (tax && fy != null && fyNow !== fy) payTax(entryDay);
    fy = fyNow;
    // 4. new holdings at today's open; kept names keep their entry date and cost basis
    //    (a top-up averages the basis with today's price)
    holdings = pick.map((x) => {
      const p = idx.get(x.symbol);
      const i = at(p, entryDay);
      const px = fillAt(p, i);
      const old = cur.get(x.symbol);
      const w = 1 / pick.length;
      let basis = px;
      if (old) {
        const add = Math.max(0, w - old.wNow);
        const keep = Math.min(w, old.wNow);
        basis = (keep / old.now * old.basis + add / px * px) / (keep / old.now + add / px);
      }
      return { symbol: x.symbol, w, entry: px, basis, entryDate: old?.entryDate || entryDay, score: x.score, ret12: x.ret12 };
    });
    curve.push({ date: entryDay, value });
    lists.push({ signal, entryDay, exitDay, symbols: pick.map((x) => x.symbol) });
  }
  // final valuation at the last reference date
  const lastDay = refDates[refDates.length - 1];
  if (holdings.length) {
    let v = 0;
    for (const h of holdings) {
      const p = idx.get(h.symbol);
      const i = at(p, to || lastDay);
      const px = i >= 0 ? p.close[i] : h.entry;
      v += h.w * (px / h.entry);
      if (tax) {
        const gain = value * h.w * (px / h.entry) * (1 - h.basis / px);
        const held = (Date.parse(to || lastDay) - Date.parse(h.entryDate)) / 86400000;
        if (held >= 365) fyLT += gain;
        else fyST += gain;
      }
    }
    value *= v;
    if (tax) payTax(to || lastDay);
  }
  curve.push({ date: to || lastDay, value });
  const years = curve.length > 1 ? (Date.parse(curve[curve.length - 1].date) - Date.parse(curve[0].date)) / (365.25 * 86400000) : 0;
  let peak = -Infinity;
  let dd = 0;
  for (const c of curve) {
    peak = Math.max(peak, c.value);
    dd = Math.max(dd, 1 - c.value / peak);
  }
  return { curve, lists, cagr: years > 0 ? curve[curve.length - 1].value ** (1 / years) - 1 : null, maxDrawdown: dd, turnoverPerYear: years > 0 ? turnoverSum / years : null, taxPaid, years };
}

export const cagrOf = (curve, from, to) => {
  const seg = curve.filter((c) => c.date >= from && c.date <= to);
  if (seg.length < 2) return null;
  const y = (Date.parse(seg[seg.length - 1].date) - Date.parse(seg[0].date)) / (365.25 * 86400000);
  return y > 0 ? (seg[seg.length - 1].value / seg[0].value) ** (1 / y) - 1 : null;
};
/** Calendar-year returns from a curve. */
export function yearly(curve) {
  const out = {};
  const byYear = new Map();
  for (const c of curve) byYear.set(c.date.slice(0, 4), c);
  const years = [...byYear.keys()].sort();
  for (let k = 0; k < years.length; k++) {
    const prev = k ? byYear.get(years[k - 1]).value : curve[0].value;
    out[years[k]] = byYear.get(years[k]).value / prev - 1;
  }
  return out;
}

// ---------------------------------------------------------------- the test ---
export async function loadAll(loadCandles) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const series = loadSeries();
  if (!series.size) throw new Error('No NSE history yet: run node paper-bot/bhav-history.mjs first.');
  const universe = pointInTimeUniverse(series);
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2008-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const lastBhav = [...series.values()].reduce((a, rows) => (rows.length && rows[rows.length - 1].date > a ? rows[rows.length - 1].date : a), '');
  const refDates = nifty.map((x) => x.date).filter((d) => d <= lastBhav);
  return { series, universe, idx: priceIndex(series), nifty, refDates, lastBhav };
}

export async function momentumTest({ loadCandles = candles } = {}) {
  const { idx, universe, nifty, refDates, lastBhav } = await loadAll(loadCandles);
  const r = RULES;
  const methods = { a: '12-1 month return', b: 'NSE-style (6 and 12 months, volatility-adjusted)' };
  const res = {};
  for (const m of Object.keys(methods)) {
    const pre = simulate({ idx, universe, refDates, method: m });
    const post = simulate({ idx, universe, refDates, method: m, tax: true });
    res[m] = {
      label: methods[m], cagr: pre.cagr, cagrAfterTax: post.cagr, maxDrawdown: pre.maxDrawdown, turnoverPerYear: pre.turnoverPerYear,
      early: cagrOf(pre.curve, r.from, r.split), late: cagrOf(pre.curve, r.split, lastBhav), yearly: yearly(pre.curve), curve: pre.curve.map((c) => [c.date, +c.value.toFixed(5)]),
    };
  }
  // the method chosen on 2010–17 only
  const chosen = (res.a.early ?? -1) >= (res.b.early ?? -1) ? 'a' : 'b';
  // realistic versions of the chosen method: worse fills (midpoint of the day), 0.3% slippage a side,
  // and fewer rebalances (quarterly) / more stocks (30, like NSE's index)
  const since2020 = '2020-08-01';
  const realistic = {};
  for (const [key, label, extra] of [
    ['monthly', 'Realistic: monthly, 20 stocks', { fill: 'mid', slipPct: 0.3 }],
    ['quarterly', 'Realistic: quarterly, 20 stocks', { fill: 'mid', slipPct: 0.3, rebalanceEvery: 3 }],
    ['quarterly30', 'Realistic: quarterly, 30 stocks (like NSE Momentum 30)', { fill: 'mid', slipPct: 0.3, rebalanceEvery: 3, top: 30 }],
  ]) {
    const rr = { ...r, ...extra };
    const pre = simulate({ idx, universe, refDates, method: chosen, r: rr });
    const post = simulate({ idx, universe, refDates, method: chosen, r: rr, tax: true });
    realistic[key] = { label, cagr: pre.cagr, cagrAfterTax: post.cagr, maxDrawdown: pre.maxDrawdown, turnoverPerYear: pre.turnoverPerYear, early: cagrOf(pre.curve, r.from, r.split), late: cagrOf(pre.curve, r.split, lastBhav), since2020: cagrOf(pre.curve, since2020, lastBhav) };
  }
  for (const m of Object.values(res)) m.since2020 = cagrOf(m.curve.map(([date, value]) => ({ date, value })), since2020, lastBhav);
  // NIFTY total return (≈1.2%/yr dividends) over the same dates
  const n = nifty.filter((x) => x.date >= r.from && x.date <= lastBhav);
  const tr = [];
  let v = 1;
  n.forEach((x, i) => {
    if (i) v *= (x.close / n[i - 1].close) * (1 + 0.012 / 252);
    tr.push({ date: x.date, value: v });
  });
  const yrs = (Date.parse(tr[tr.length - 1].date) - Date.parse(tr[0].date)) / (365.25 * 86400000);
  const end = 1e6 * tr[tr.length - 1].value;
  const niftyAfter = (1e6 * tr[tr.length - 1].value - Math.max(0, end - 1e6 - ltEx(lastBhav)) * ltcg(lastBhav)) / 1e6;
  let peak = -Infinity;
  let dd = 0;
  for (const c of tr) {
    peak = Math.max(peak, c.value);
    dd = Math.max(dd, 1 - c.value / peak);
  }
  const index = { since2020: cagrOf(tr, '2020-08-01', lastBhav), cagr: tr[tr.length - 1].value ** (1 / yrs) - 1, cagrAfterTax: niftyAfter ** (1 / yrs) - 1, maxDrawdown: dd, early: cagrOf(tr, r.from, r.split), late: cagrOf(tr, r.split, lastBhav), yearly: yearly(tr.filter((c, i, a) => i === a.length - 1 || a[i + 1].date.slice(0, 7) !== c.date.slice(0, 7))) };
  // NSE's own factor indices (from the Market tilts study), for reference
  let nse = null;
  try {
    const f = JSON.parse(readFileSync(join(HERE, 'data', 'factor-lab.json'), 'utf8'));
    nse = f.rows.filter((x) => ['momentum30', 'alpha50'].includes(x.key)).map((x) => ({ key: x.key, label: x.label, from: x.from, cagr: x.cagr, niftyCagr: x.niftyCagr, maxDrawdown: x.maxDrawdown }));
  } catch {
    /* no factor study yet */
  }
  const c = res[chosen];
  const beats = c.late != null && index.late != null && c.late > index.late && c.early > index.early;
  return {
    at: new Date().toISOString(), from: r.from, to: lastBhav, rules: r, methods: res, chosen, index, nse, realistic,
    verdict: beats
      ? `The ${methods[chosen]} method (chosen on 2010–17) beat NIFTY in both halves: ${(c.early * 100).toFixed(1)}% / ${(c.late * 100).toFixed(1)}% a year against ${(index.early * 100).toFixed(1)}% / ${(index.late * 100).toFixed(1)}%. After tax ${(c.cagrAfterTax * 100).toFixed(1)}% vs ${(index.cagrAfterTax * 100).toFixed(1)}%. Worst fall ${(c.maxDrawdown * 100).toFixed(0)}% vs ${(index.maxDrawdown * 100).toFixed(0)}%.`
      : `The ${methods[chosen]} method (chosen on 2010–17) did not beat NIFTY in both halves: ${(c.early * 100).toFixed(1)}% / ${(c.late * 100).toFixed(1)}% a year against ${(index.early * 100).toFixed(1)}% / ${(index.late * 100).toFixed(1)}%.`,
    passed: beats,
    note: 'Survivorship-free: each month the 200 most-traded NSE stocks as they were then, including ones that later collapsed or were delisted (sold at their last price). Prices adjusted for splits / bonuses, not dividends (both sides miss them; NIFTY gets ≈1.2%/yr added). Rebalanced monthly at the next open, 0.35% cost per side on the value traded. Tax simplified (sales netted per financial year). Research only.',
  };
}

export const saveMomentum = (r) => writeJsonAtomic(SAVED(), r);
const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
export const loadMomentum = () => readJ(SAVED());
export const loadMomentumPaper = () => readJ(PAPER());

// ------------------------------------------------------- live list + paper ---
/**
 * This month's list (ranked at the last completed month-end) and a preview
 * ranked at the latest stored day. Uses the chosen method of the saved test.
 */
export async function currentLists({ loadCandles = candles } = {}) {
  const { idx, universe, refDates, lastBhav } = await loadAll(loadCandles);
  const method = loadMomentum()?.chosen || 'a';
  const ends = monthEnds(refDates);
  const lastMonthEnd = lastBhav.slice(0, 7) === ends[ends.length - 1].slice(0, 7) && ends[ends.length - 1] === lastBhav && refDates[refDates.length - 1] === lastBhav
    ? ends[ends.length - 1] : ends[ends.length - 2];
  // a month-end counts as completed only when the next month has started in the data
  const completed = ends.filter((d) => refDates.some((x) => x > d)).pop();
  const make = (date) => {
    const elig = universe.get(nextMonthKey(date.slice(0, 7))) || universe.get(date.slice(0, 7));
    return scores(idx, [...(elig || [])], date, method).slice(0, 40).map((x, i) => ({ rank: i + 1, symbol: x.symbol, score: x.score, ret12: x.ret12, vol: x.vol ?? null, close: x.close }));
  };
  void lastMonthEnd;
  return { method, monthEnd: completed, list: make(completed).slice(0, RULES.top), preview: { date: lastBhav, list: make(lastBhav).slice(0, RULES.top) }, nextRebalance: 'the first session after the month-end' };
}

/**
 * Paper portfolio: rebalanced on the first session after each month-end from
 * the start date; valued daily at Yahoo closes (NSE file prices as a fallback).
 */
export async function momentumPaperUpdate({ loadCandles = candles, now = new Date(), capital = 100000 } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadMomentumPaper() || { startedAt: today, capital, rebalances: [], curve: [] };
  const live = await currentLists({ loadCandles });
  // rebalance when a month-end has completed since the last rebalance (and after the start)
  const last = st.rebalances[st.rebalances.length - 1];
  if (live.monthEnd && live.monthEnd >= st.startedAt.slice(0, 7) + '-00' && (!last || last.monthEnd < live.monthEnd)) {
    const value = st.curve.length ? st.curve[st.curve.length - 1].value : st.capital;
    const picks = [];
    for (const x of live.list) {
      try {
        const rows = (await loadCandles(`${x.symbol}.NS`, { period1: Math.floor(Date.parse(live.monthEnd) / 1000), interval: '1d' })).filter((r) => r.date > live.monthEnd && r.open > 0);
        if (rows.length) picks.push({ symbol: x.symbol, entryDate: rows[0].date, entry: rows[0].open * (1 + (RULES.costPct + RULES.slipPct) / 100) });
      } catch {
        /* skip a symbol Yahoo does not know */
      }
    }
    if (picks.length) st.rebalances.push({ monthEnd: live.monthEnd, date: picks[0].entryDate, value, holdings: picks.map((p) => ({ ...p, weight: 1 / picks.length })) });
  }
  // value the current holdings at the latest close
  const cur = st.rebalances[st.rebalances.length - 1];
  if (cur) {
    let v = 0;
    const marks = [];
    for (const h of cur.holdings) {
      let px = null;
      try {
        const rows = (await loadCandles(`${h.symbol}.NS`, { range: '5d', interval: '1d' })).filter((r) => r.close > 0);
        px = rows.length ? rows[rows.length - 1].close : null;
      } catch {
        px = null;
      }
      const ret = px ? px / h.entry - 1 : 0;
      marks.push({ symbol: h.symbol, entry: h.entry, last: px, retPct: ret * 100 });
      v += h.weight * (1 + ret);
    }
    const value = cur.value * v;
    st.curve = [...st.curve.filter((c) => c.date !== today), { date: today, value }];
    st.marks = marks;
  }
  st.list = live.list;
  st.preview = live.preview;
  st.method = live.method;
  st.monthEnd = live.monthEnd;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  if (process.argv.includes('--paper')) {
    momentumPaperUpdate()
      .then((st) => console.log(`Momentum 20 paper: since ${st.startedAt} · ${st.rebalances.length} rebalance(s) · value ₹${Math.round(st.curve.at(-1)?.value ?? st.capital).toLocaleString('en-IN')} · this month's list (ranked ${st.monthEnd}): ${st.list.slice(0, 5).map((x) => x.symbol).join(', ')}…`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    try {
      console.log(`NSE ETF list: ${await refreshEtfList()} ETFs excluded`);
    } catch (err) {
      console.log(`NSE ETF list not refreshed (${err.message}); using the saved list + name patterns`);
    }
    momentumTest()
      .then((r) => {
        saveMomentum(r);
        console.log(`\nMOMENTUM 20 · ${r.from} → ${r.to} · survivorship-free top 200`);
        for (const [k, m] of Object.entries(r.methods)) console.log(`  ${k} ${m.label.padEnd(48)} ${pc(m.cagr)}/yr (after tax ${pc(m.cagrAfterTax)}) · 2010–17 ${pc(m.early)} · 2018 → ${pc(m.late)} · worst fall ${pc(m.maxDrawdown)} · turnover ${(m.turnoverPerYear * 100).toFixed(0)}%/yr${k === r.chosen ? '  ← chosen on 2010–17' : ''}`);
        console.log(`  NIFTY (total return)                                ${pc(r.index.cagr)}/yr (after tax ${pc(r.index.cagrAfterTax)}) · 2010–17 ${pc(r.index.early)} · 2018 → ${pc(r.index.late)} · worst fall ${pc(r.index.maxDrawdown)}`);
        for (const x of r.nse || []) console.log(`  NSE ${x.label} since ${x.from}: ${pc(x.cagr)}/yr vs NIFTY ${pc(x.niftyCagr)}`);
        console.log('  Realistic versions (chosen method):');
        for (const x of Object.values(r.realistic)) console.log(`    ${x.label.padEnd(56)} ${pc(x.cagr)}/yr (after tax ${pc(x.cagrAfterTax)}) · 2010–17 ${pc(x.early)} · 2018 → ${pc(x.late)} · since Aug 2020 ${pc(x.since2020)} · worst fall ${pc(x.maxDrawdown)} · turnover ${(x.turnoverPerYear * 100).toFixed(0)}%/yr`);
        console.log(`    since Aug 2020: as tested ${pc(r.methods[r.chosen].since2020)} · NIFTY ${pc(r.index.since2020)}`);
        console.log(`\n${r.verdict}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
