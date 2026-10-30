#!/usr/bin/env node
// Momentum 10 + buffer (library + CLI) — the candidate found by the 50%-search
// agent (57 versions tried; the only one that beat Momentum 20 after tax in the
// search years, the check years AND the never-seen 2023→ years). Tracked on
// paper next to Momentum 20, not a replacement.
//   Score: half NSE-style momentum (6- and 12-month return ÷ 1-year volatility),
//   half "residual" momentum (the stock's own 12-month move after removing what
//   NIFTY explains, skipping the last month), as cross-sectional z-scores.
//   Hold 10 stocks in equal amounts; keep a holding while it ranks in the top 40
//   (the buffer — about half the trading of Momentum 20); fill the rest from the top.
// Same realistic test as Momentum 20. Research / paper only — not investment advice.
//
//   node paper-bot/momentum10.mjs           backtest (saved for the card)
//   node paper-bot/momentum10.mjs --paper   update the paper portfolio

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { RULES as MOM, simulate, loadAll, cagrOf, yearly, monthEnds, at, monthsBack, isEtf } from './momentum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.MOMENTUM10_PATH || join(HERE, 'data', 'momentum10.json');
const PAPER = () => process.env.MOMENTUM10_PAPER_PATH || join(HERE, 'data', 'momentum10-paper.json');

export const RULES = { top: 10, keep: 40, weights: { r6v: 0.25, r12v: 0.25, resMom: 0.5 }, skipDays: 21, costPct: 0.25, slipPct: 0.3, fill: 'mid' };
export const PERIODS = { dev: ['2010-01-01', '2017-12-31'], val: ['2018-01-01', '2022-12-31'], holdout: ['2023-01-01', null] };

// --------------------------------------------------------------- scores ---
/** Features of one stock at a month-end, from data up to that date only. */
export function features(p, me, niftyClose) {
  const i0 = at(p, me);
  const i12 = at(p, monthsBack(me, 12));
  if (i0 < 0 || p.dates[i0] < monthsBack(me, 0.2) || i12 < 0 || p.dates[i12] < monthsBack(me, 13) || i0 - i12 < 150) return null;
  const i6 = at(p, monthsBack(me, 6));
  const rets = [];
  const xs = [];
  const ns = [];
  for (let k = i12 + 1; k <= i0; k++) {
    const r = Math.log(p.close[k] / p.close[k - 1]);
    rets.push(r);
    const a = niftyClose.get(p.dates[k]);
    const b = niftyClose.get(p.dates[k - 1]);
    if (a && b) {
      xs.push(r);
      ns.push(Math.log(a / b));
    }
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
  if (!(vol > 0)) return null;
  // residual momentum: regress on NIFTY, sum the residuals except the last month, scale by their spread
  let resMom = 0;
  if (xs.length > 120) {
    const mx = ns.reduce((a, b) => a + b, 0) / ns.length;
    const my = xs.reduce((a, b) => a + b, 0) / xs.length;
    let cov = 0;
    let vn = 0;
    for (let k = 0; k < xs.length; k++) {
      cov += (ns[k] - mx) * (xs[k] - my);
      vn += (ns[k] - mx) ** 2;
    }
    const beta = vn > 0 ? cov / vn : 1;
    const res = xs.map((x, k) => x - beta * ns[k]);
    const rm = res.reduce((a, b) => a + b, 0) / res.length;
    const rsd = Math.sqrt(res.reduce((a, b) => a + (b - rm) ** 2, 0) / (res.length - 1));
    const body = res.slice(0, Math.max(1, res.length - RULES.skipDays));
    resMom = rsd > 0 ? body.reduce((a, b) => a + b, 0) / (rsd * Math.sqrt(body.length)) : 0;
  }
  const c0 = p.close[i0];
  return { close: c0, vol, ret12: c0 / p.close[i12] - 1, r6v: (c0 / p.close[i6] - 1) / vol, r12v: (c0 / p.close[i12] - 1) / vol, resMom };
}

/** Ranking function for simulate(): weighted cross-sectional z-scores. */
export const rankBy = (niftyClose, weights = RULES.weights) => (idx, syms, me) => {
  const rows = [];
  for (const s of syms) {
    if (isEtf(s)) continue;
    const p = idx.get(s);
    const f = p && features(p, me, niftyClose);
    if (f) rows.push({ symbol: s, ...f });
  }
  if (!rows.length) return [];
  const score = new Array(rows.length).fill(0);
  for (const [k, w] of Object.entries(weights)) {
    const v = rows.map((x) => x[k]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1)) || 1;
    v.forEach((x, i) => (score[i] += (w * (x - mean)) / sd));
  }
  return rows.map((x, i) => ({ ...x, score: score[i] })).sort((a, b) => b.score - a.score);
};

/** The buffer: holdings still ranked within `keep` stay; the rest of the `top` slots fill from the top. */
export function bufferPick(ranked, held, top = RULES.top, keep = RULES.keep) {
  const kept = ranked.slice(0, keep).filter((x) => held.has(x.symbol)).slice(0, top);
  const fill = ranked.filter((x) => !kept.includes(x)).slice(0, top - kept.length);
  return [...kept, ...fill];
}
/** A stateful ranking for simulate() that applies the buffer month to month. */
export const buffered = (rank, top = RULES.top, keep = RULES.keep) => {
  let held = new Set();
  return (idx, syms, me) => {
    const out = bufferPick(rank(idx, syms, me), held, top, keep);
    held = new Set(out.map((x) => x.symbol));
    return out;
  };
};

// ---------------------------------------------------------------- test ---
export async function momentum10Test({ loadCandles = candles } = {}) {
  const data = await loadAll(loadCandles);
  const { idx, universe, refDates, nifty, lastBhav } = data;
  const nClose = new Map(nifty.map((x) => [x.date, x.close]));
  const base = { ...MOM, fill: 'mid', slipPct: 0.3 };
  const versions = {
    m10: { label: 'Momentum 10 + buffer (candidate)', r: { ...base, top: RULES.top }, rank: () => buffered(rankBy(nClose)) },
    m20: { label: 'Momentum 20 (current)', r: { ...base, top: 20 }, rank: () => null },
  };
  const res = {};
  for (const [k, v] of Object.entries(versions)) {
    const pre = simulate({ idx, universe, refDates, method: 'b', r: v.r, rank: v.rank() });
    const post = simulate({ idx, universe, refDates, method: 'b', r: v.r, rank: v.rank(), tax: true });
    const periods = {};
    for (const [p, [from, to]] of Object.entries(PERIODS)) {
      const t = simulate({ idx, universe, refDates, method: 'b', r: v.r, rank: v.rank(), tax: true, from, to: to || null });
      periods[p] = { cagrAfterTax: t.cagr, maxDrawdown: t.maxDrawdown };
    }
    res[k] = {
      label: v.label, cagr: pre.cagr, cagrAfterTax: post.cagr, maxDrawdown: pre.maxDrawdown, turnoverPerYear: pre.turnoverPerYear,
      periods, yearly: yearly(pre.curve), since2020: cagrOf(pre.curve, '2020-08-01', lastBhav), lastList: pre.lists.at(-1)?.symbols || [],
    };
  }
  // NIFTY on the same periods (price + ≈1.2% a year dividends, before tax)
  const index = {};
  for (const [p, [from, to]] of Object.entries(PERIODS)) {
    const n = nifty.filter((x) => x.date >= from && (!to || x.date <= to) && x.date <= lastBhav);
    let v = 1;
    let peak = 1;
    let dd = 0;
    n.forEach((x, i) => {
      if (i) v *= (x.close / n[i - 1].close) * (1 + 0.012 / 252);
      peak = Math.max(peak, v);
      dd = Math.max(dd, 1 - v / peak);
    });
    const yrs = (Date.parse(n.at(-1).date) - Date.parse(n[0].date)) / (365.25 * 86400000);
    index[p] = { cagr: v ** (1 / yrs) - 1, maxDrawdown: dd };
  }
  const a = res.m10.periods;
  const b = res.m20.periods;
  const allThree = ['dev', 'val', 'holdout'].every((p) => a[p].cagrAfterTax > b[p].cagrAfterTax);
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  return {
    at: new Date().toISOString(), from: MOM.from, to: lastBhav, rules: RULES, periods: PERIODS, results: res, index,
    beatsAllThree: allThree,
    verdict: `${allThree ? 'Beat' : 'Did not beat'} Momentum 20 after tax in all three periods: ${pc(a.dev.cagrAfterTax)} / ${pc(a.val.cagrAfterTax)} / ${pc(a.holdout.cagrAfterTax)} a year (2010–17 / 2018–22 / 2023→) against ${pc(b.dev.cagrAfterTax)} / ${pc(b.val.cagrAfterTax)} / ${pc(b.holdout.cagrAfterTax)}. Worst fall since 2023: ${pc(a.holdout.maxDrawdown)} vs ${pc(b.holdout.maxDrawdown)}.`,
    caution: 'Found after 57 tries: a best-of-57 result this good is about what luck alone would give, and the extra return is not statistically proven. Only 10 stocks, so single stocks matter more and falls can be deeper. Much of the gain came in strong years (2020–21). That is why it is a paper candidate, not a replacement for Momentum 20.',
    note: 'Survivorship-free top 200 NSE stocks as they were each month; monthly at the midpoint of the next day’s range, 0.55% a side (charges + slippage); Indian tax (sales netted per financial year). Research only.',
  };
}

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const saveMomentum10 = (r) => writeJsonAtomic(SAVED(), r);
export const loadMomentum10 = () => readJ(SAVED());
export const loadMomentum10Paper = () => readJ(PAPER());

// --------------------------------------------------------------- paper ---
/** Ranked list at a date (top 40, so the buffer can be applied). */
export async function rankedAt({ loadCandles = candles } = {}) {
  const { idx, universe, refDates, nifty, lastBhav } = await loadAll(loadCandles);
  const nClose = new Map(nifty.map((x) => [x.date, x.close]));
  const rank = rankBy(nClose);
  const ends = monthEnds(refDates);
  const completed = ends.filter((d) => refDates.some((x) => x > d)).pop();
  const make = (date) => {
    const ym = date.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const elig = universe.get(next) || universe.get(ym);
    return rank(idx, [...(elig || [])], date).slice(0, RULES.keep).map((x, i) => ({ rank: i + 1, symbol: x.symbol, score: x.score, ret12: x.ret12, close: x.close }));
  };
  return { monthEnd: completed, ranked: make(completed), preview: { date: lastBhav, ranked: make(lastBhav) } };
}

/**
 * Paper portfolio: starts at the first month-end after the start date, then
 * once a month applies the buffer to the held names. New names are bought at
 * the next open plus costs; dropped names are sold at that open less costs;
 * kept names stay (re-weighted to equal, trim costs ignored). Valued daily.
 */
export async function momentum10PaperUpdate({ loadCandles = candles, now = new Date(), capital = 100000, ranked = null } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadMomentum10Paper() || { startedAt: today, capital, rebalances: [], curve: [] };
  const live = ranked || (await rankedAt({ loadCandles }));
  const side = (RULES.costPct + RULES.slipPct) / 100;
  const last = st.rebalances.at(-1);
  const openAfter = async (symbol, date) => {
    try {
      const rows = (await loadCandles(`${symbol}.NS`, { period1: Math.floor(Date.parse(date) / 1000), interval: '1d' })).filter((r) => r.date > date && r.open > 0);
      return rows.length ? { date: rows[0].date, open: rows[0].open } : null;
    } catch {
      return null;
    }
  };
  if (live.monthEnd && live.monthEnd >= st.startedAt.slice(0, 7) + '-00' && (!last || last.monthEnd < live.monthEnd)) {
    const held = new Set((last?.holdings || []).map((h) => h.symbol));
    const pick = bufferPick(live.ranked, held);
    let value = st.curve.length ? st.curve.at(-1).value : st.capital;
    const holdings = [];
    const sells = (last?.holdings || []).filter((h) => !pick.some((x) => x.symbol === h.symbol)).map((h) => h.symbol);
    let date = null;
    for (const x of pick) {
      const o = await openAfter(x.symbol, live.monthEnd);
      if (!o) continue;
      date = date || o.date;
      const old = last?.holdings.find((h) => h.symbol === x.symbol);
      // kept names are re-based at today's open (no cost); new names pay costs on entry
      holdings.push({ symbol: x.symbol, rank: x.rank, entryDate: old?.entryDate || o.date, entry: old ? o.open : o.open * (1 + side), kept: !!old });
    }
    if (holdings.length) {
      // the value carried into the new month is the old holdings marked at this open
      if (last) {
        let v = 0;
        for (const h of last.holdings) {
          const o = await openAfter(h.symbol, live.monthEnd);
          v += h.weight * (o ? o.open / h.entry : 1 + (h.lastRet || 0));
        }
        value = last.value * v * (1 - (sells.length / RULES.top) * side);
      }
      st.rebalances.push({ monthEnd: live.monthEnd, date, value, bought: holdings.filter((h) => !h.kept).map((h) => h.symbol), sold: sells, holdings: holdings.map((h) => ({ ...h, weight: 1 / holdings.length })) });
    }
  }
  const cur = st.rebalances.at(-1);
  if (cur) {
    let v = 0;
    const marks = [];
    for (const h of cur.holdings) {
      let px = null;
      try {
        const rows = (await loadCandles(`${h.symbol}.NS`, { range: '5d', interval: '1d' })).filter((r) => r.close > 0);
        px = rows.length ? rows.at(-1).close : null;
      } catch {
        px = null;
      }
      const ret = px ? px / h.entry - 1 : 0;
      h.lastRet = ret;
      marks.push({ symbol: h.symbol, entry: h.entry, entryDate: h.entryDate, last: px, retPct: ret * 100 });
      v += h.weight * (1 + ret);
    }
    st.curve = [...st.curve.filter((c) => c.date !== today), { date: today, value: cur.value * v }];
    st.marks = marks;
  }
  const heldNow = new Set((cur?.holdings || []).map((h) => h.symbol));
  st.list = bufferPick(live.ranked, heldNow);
  st.preview = { date: live.preview.date, list: bufferPick(live.preview.ranked, heldNow.size ? heldNow : new Set(st.list.map((x) => x.symbol))) };
  st.monthEnd = live.monthEnd;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  try {
    if (process.argv.includes('--paper')) {
      const st = await momentum10PaperUpdate();
      console.log(`Momentum 10 + buffer paper: since ${st.startedAt} · ${st.rebalances.length} rebalance(s) · value ₹${Math.round(st.curve.at(-1)?.value ?? st.capital).toLocaleString('en-IN')} · list (ranked ${st.monthEnd}): ${st.list.map((x) => x.symbol).join(', ')}`);
    } else {
      const r = await momentum10Test();
      saveMomentum10(r);
      for (const x of Object.values(r.results)) console.log(`${x.label.padEnd(36)} ${pc(x.cagr)}/yr (after tax ${pc(x.cagrAfterTax)}) · worst fall ${pc(x.maxDrawdown)} · turnover ${(x.turnoverPerYear * 100).toFixed(0)}%/yr · after tax dev/val/holdout ${pc(x.periods.dev.cagrAfterTax)} / ${pc(x.periods.val.cagrAfterTax)} / ${pc(x.periods.holdout.cagrAfterTax)} · holdout fall ${pc(x.periods.holdout.maxDrawdown)}`);
      console.log(`NIFTY (before tax) dev/val/holdout ${pc(r.index.dev.cagr)} / ${pc(r.index.val.cagr)} / ${pc(r.index.holdout.cagr)}`);
      console.log(r.verdict);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
