#!/usr/bin/env node
// Steady mix (library + CLI): the steadiest of 120 tested mixes of stocks, gold
// and a liquid fund, picked on 2010–17 only (most positive 12-month windows,
// then the smallest fall, among mixes earning ≥ 10% a year), checked on 2018→.
//   30% Momentum 10 + buffer, moved to the liquid fund while NIFTY is below its
//       200-day average (±1% band, checked at month-end)
//   10% gold (GOLDBEES)
//   60% liquid fund (≈6% a year)
//   back to 30 / 10 / 60 at the start of each month.
// Research / paper only — not investment advice.
//
//   node paper-bot/steady-mix.mjs           backtest (saved for the card)
//   node paper-bot/steady-mix.mjs --paper   update the paper portfolio

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { RULES as MOM, simulate, loadAll, monthEnds } from './momentum.mjs';
import { rankBy, buffered, loadMomentum10Paper } from './momentum10.mjs';
import { trendGate } from './new-ideas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.STEADY_MIX_PATH || join(HERE, 'data', 'steady-mix.json');
const PAPER = () => process.env.STEADY_MIX_PAPER_PATH || join(HERE, 'data', 'steady-mix-paper.json');

export const MIX = { stocks: 0.3, gold: 0.1, liquid: 0.6, liquidYield: 0.06, rebalanceDragPct: 0.05, goldSymbol: 'GOLDBEES.NS' };
export const PERIODS = { dev: ['2010-02', '2017-12'], val: ['2018-01', '2022-12'], holdout: ['2023-01', '9999-12'] };

// -------------------------------------------------------------- helpers ---
/** Month → return, from month-end values. */
export function monthlyReturns(rows) {
  const last = new Map();
  for (const r of rows) last.set(r.date.slice(0, 7), r.close ?? r.value);
  const ks = [...last.keys()].sort();
  const out = new Map();
  for (let i = 1; i < ks.length; i++) out.set(ks[i], last.get(ks[i]) / last.get(ks[i - 1]) - 1);
  return out;
}
/** The mix's monthly returns from its parts (re-balanced monthly, small drag for the re-balance). */
export function mixReturns(months, parts, w = MIX) {
  const cash = (1 + w.liquidYield) ** (1 / 12) - 1;
  return months.map((m) => ({ m, r: w.stocks * (parts.stocks.get(m) ?? 0) + w.gold * (parts.gold.get(m) ?? 0) + w.liquid * cash - w.rebalanceDragPct / 100 }));
}
/** Return, worst fall, share of positive months and of positive 12- / 24-month windows, worst month. */
export function stats(rs) {
  if (!rs.length) return null;
  const v = [1];
  let peak = 1;
  let dd = 0;
  for (const x of rs) {
    v.push(v.at(-1) * (1 + x.r));
    peak = Math.max(peak, v.at(-1));
    dd = Math.max(dd, 1 - v.at(-1) / peak);
  }
  const win = (k) => {
    let p = 0;
    let t = 0;
    for (let i = k; i < v.length; i++) {
      t++;
      if (v[i] > v[i - k]) p++;
    }
    return t ? p / t : null;
  };
  return { cagr: v.at(-1) ** (12 / rs.length) - 1, maxDrawdown: dd, upMonths: rs.filter((x) => x.r > 0).length / rs.length, pos12: win(12), pos24: win(24), worstMonth: Math.min(...rs.map((x) => x.r)) };
}
const byYear = (rs) => {
  const y = {};
  for (const x of rs) y[x.m.slice(0, 4)] = (y[x.m.slice(0, 4)] ?? 1) * (1 + x.r);
  return Object.fromEntries(Object.entries(y).map(([k, g]) => [k, g - 1]));
};

// ---------------------------------------------------------------- test ---
export async function steadyMixTest({ loadCandles = candles } = {}) {
  const d = await loadAll(loadCandles);
  const nClose = new Map(d.nifty.map((x) => [x.date, x.close]));
  const r = { ...MOM, fill: 'mid', slipPct: 0.3, cashYield: MIX.liquidYield, top: 10 };
  const curve = simulate({ idx: d.idx, universe: d.universe, refDates: d.refDates, method: 'b', r, rank: buffered(rankBy(nClose)), gate: trendGate(d.nifty) }).curve;
  // the portfolio is re-made at the first session of each month: the change to the next point is that month's return
  const stocks = new Map();
  for (let i = 1; i < curve.length; i++) stocks.set(curve[i - 1].date.slice(0, 7), curve[i].value / curve[i - 1].value - 1);
  const gold = monthlyReturns((await loadCandles(MIX.goldSymbol, { period1: Math.floor(Date.parse('2009-06-01') / 1000), interval: '1d' })).filter((x) => x.close > 0));
  const nifty = monthlyReturns(d.nifty);
  for (const [k, v] of nifty) nifty.set(k, v + 0.001); // ≈1.2% a year dividends
  const months = [...stocks.keys()].filter((m) => m >= '2010-02').sort();
  const mix = mixReturns(months, { stocks, gold });
  const niftyRs = months.map((m) => ({ m, r: nifty.get(m) ?? 0 }));
  const cut = (rs, [a, b]) => rs.filter((x) => x.m >= a && x.m <= b);
  const res = { mix: { label: 'Steady mix (30% Momentum 10 with filter · 10% gold · 60% liquid)' }, nifty: { label: 'NIFTY 50 index fund' } };
  for (const [k, rs] of [['mix', mix], ['nifty', niftyRs]]) {
    res[k].all = stats(rs);
    res[k].yearly = byYear(rs);
    for (const [p, range] of Object.entries(PERIODS)) res[k][p] = stats(cut(rs, range));
  }
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const m = res.mix;
  const passed = m.holdout.cagr > 0.06 && m.holdout.maxDrawdown < res.nifty.holdout.maxDrawdown && m.val.maxDrawdown < res.nifty.val.maxDrawdown;
  return {
    at: new Date().toISOString(), from: months[0], to: d.lastBhav, mix: MIX, results: res, passed, tried: 120,
    verdict: `${pc(m.all.cagr)} a year with a worst fall of ${pc(m.all.maxDrawdown)} (NIFTY ${pc(res.nifty.all.cagr)}, ${pc(res.nifty.all.maxDrawdown)}). Positive over ${pc(m.all.pos24)} of all 2-year stretches and ${pc(m.all.pos12)} of 12-month ones. On years not used to pick it (2018→): ${pc(m.val.cagr)} and ${pc(m.holdout.cagr)} a year, worst falls ${pc(m.val.maxDrawdown)} and ${pc(m.holdout.maxDrawdown)}.`,
    caution: 'Still has losing months (about 1 in 3) and small losing years. Before tax (tax takes roughly 1–1.5 points a year). Gold did unusually well in 2023–26. Picked from 120 mixes on 2010–17 only.',
    note: 'Stock part: Momentum 10 + buffer on the survivorship-free top 200, realistic fills and charges, in a liquid fund (6%) while NIFTY is below its 200-day average. Gold: GOLDBEES. Re-balanced to 30/10/60 monthly with a 0.05% drag. Research only.',
  };
}

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const saveSteadyMix = (r) => writeJsonAtomic(SAVED(), r);
export const loadSteadyMix = () => readJ(SAVED());
export const loadSteadyMixPaper = () => readJ(PAPER());

// --------------------------------------------------------------- paper ---
/** NIFTY market-filter state at a month-end, replaying the ±1% band from the start of the data. */
export function filterAt(nifty, monthEnd) {
  const gate = trendGate(nifty);
  let state = true;
  for (const me of monthEnds(nifty.map((x) => x.date))) {
    if (me > monthEnd) break;
    state = gate(me);
  }
  return state;
}

/**
 * Paper portfolio from the start date: at the first session after each
 * month-end, re-balance to 30% stocks (the Momentum 10 paper list for that
 * month-end, or the liquid fund when the filter is out) / 10% gold / 60%
 * liquid. Valued daily: stocks and gold at Yahoo closes, liquid at 6% a year.
 */
export async function steadyMixPaperUpdate({ loadCandles = candles, now = new Date(), capital = 100000, m10 = loadMomentum10Paper() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadSteadyMixPaper() || { startedAt: today, capital, rebalances: [], curve: [] };
  const nifty = (await loadCandles('^NSEI', { range: '2y', interval: '1d' })).filter((x) => x.close > 0);
  const ends = monthEnds(nifty.map((x) => x.date));
  const completed = ends.filter((d) => nifty.some((x) => x.date > d)).pop();
  const side = (MOM.costPct + 0.3) / 100;
  const closeOn = async (symbol, after = null) => {
    try {
      const rows = after
        ? (await loadCandles(symbol, { period1: Math.floor(Date.parse(after) / 1000), interval: '1d' })).filter((r) => r.date > after && r.open > 0)
        : (await loadCandles(symbol, { range: '5d', interval: '1d' })).filter((r) => r.close > 0);
      if (!rows.length) return null;
      return after ? { date: rows[0].date, px: rows[0].open } : { date: rows.at(-1).date, px: rows.at(-1).close };
    } catch {
      return null;
    }
  };
  const liquidGrowth = (from, to) => (1 + MIX.liquidYield) ** Math.max(0, (Date.parse(to) - Date.parse(from)) / (365.25 * 86400000));
  // value of a set of holdings, marked at a price function
  const valueOf = async (reb, mark) => {
    let v = 0;
    const marks = [];
    for (const h of reb.holdings) {
      if (h.kind === 'liquid') {
        const g = liquidGrowth(reb.date, mark.date);
        v += h.amount * g;
        marks.push({ ...h, last: null, retPct: (g - 1) * 100 });
        continue;
      }
      const p = await mark.price(h.symbol);
      const ret = p ? p / h.entry - 1 : h.lastRet || 0;
      h.lastRet = ret;
      v += h.amount * (1 + ret);
      marks.push({ ...h, last: p, retPct: ret * 100 });
    }
    return { v, marks };
  };
  const last = st.rebalances.at(-1);
  if (completed && completed >= st.startedAt.slice(0, 7) + '-00' && (!last || last.monthEnd < completed)) {
    const gold = await closeOn(MIX.goldSymbol, completed);
    if (gold) {
      const date = gold.date;
      let value = st.capital;
      if (last) value = (await valueOf(last, { date, price: async (s) => (await closeOn(s, completed))?.px ?? null })).v * (1 - MIX.rebalanceDragPct / 100);
      const inMarket = filterAt(nifty, completed);
      const list = m10?.monthEnd === completed ? m10.list : null;
      const holdings = [];
      const stockMoney = value * MIX.stocks;
      if (inMarket && list?.length) {
        const per = stockMoney / list.length;
        for (const x of list) {
          const o = await closeOn(`${x.symbol}.NS`, completed);
          if (o) holdings.push({ kind: 'stock', symbol: `${x.symbol}.NS`, name: x.symbol, amount: per, entry: o.px * (1 + side) });
          else holdings.push({ kind: 'liquid', name: `${x.symbol} (no price; liquid)`, amount: per });
        }
      } else holdings.push({ kind: 'liquid', name: inMarket ? 'Stock part (no Momentum 10 list yet; liquid)' : 'Stock part (market filter OUT; liquid)', amount: stockMoney });
      holdings.push({ kind: 'gold', symbol: MIX.goldSymbol, name: 'Gold (GOLDBEES)', amount: value * MIX.gold, entry: gold.px * (1 + side) });
      holdings.push({ kind: 'liquid', name: 'Liquid fund', amount: value * MIX.liquid });
      st.rebalances.push({ monthEnd: completed, date, value, inMarket, holdings });
    }
  }
  const cur = st.rebalances.at(-1);
  if (cur) {
    const { v, marks } = await valueOf(cur, { date: today, price: async (s) => (await closeOn(s))?.px ?? null });
    st.curve = [...st.curve.filter((c) => c.date !== today), { date: today, value: v }];
    st.marks = marks;
  }
  st.filter = { monthEnd: completed, inMarket: completed ? filterAt(nifty, completed) : null, today: filterAt(nifty, nifty.at(-1).date) };
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--paper')) {
      const st = await steadyMixPaperUpdate();
      console.log(`Steady mix paper: since ${st.startedAt} · ${st.rebalances.length} re-balance(s) · value ₹${Math.round(st.curve.at(-1)?.value ?? st.capital).toLocaleString('en-IN')} · market filter ${st.filter.inMarket ? 'IN' : 'OUT'} at ${st.filter.monthEnd}`);
    } else {
      const r = await steadyMixTest();
      saveSteadyMix(r);
      console.log(r.verdict);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
