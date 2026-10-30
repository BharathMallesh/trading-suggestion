#!/usr/bin/env node
// India mix (library + CLI): Indian investments only, in three equal parts,
// put back to ⅓ each at the start of every month:
//   ⅓ Nifty Next 50 (index fund / JUNIORBEES)
//   ⅓ gold (GOLDBEES)
//   ⅓ Momentum 10 + buffer stocks
// From a test of 62 mixes of NIFTY 50, Nifty Next 50, Midcap 50, gold,
// Momentum 10 and a liquid fund. Gold tends to rise when Indian stocks fall,
// so the monthly re-balance trims what rose and adds to what fell.
// Research / paper only — not investment advice.
//
//   node paper-bot/india-mix.mjs           backtest (saved for the card)
//   node paper-bot/india-mix.mjs --paper   update the paper portfolio

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { RULES as MOM, simulate, loadAll, monthEnds } from './momentum.mjs';
import { rankBy, buffered, loadMomentum10Paper } from './momentum10.mjs';
import { monthlyReturns, stats, PERIODS } from './steady-mix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.INDIA_MIX_PATH || join(HERE, 'data', 'india-mix.json');
const PAPER = () => process.env.INDIA_MIX_PAPER_PATH || join(HERE, 'data', 'india-mix-paper.json');

export const MIX = { next50: 1 / 3, gold: 1 / 3, stocks: 1 / 3, next50Symbol: 'JUNIORBEES.NS', goldSymbol: 'GOLDBEES.NS', liquidYield: 0.06, rebalanceDragPct: 0.05 };

/** The mix's monthly returns from its three parts (re-balanced monthly, small drag for the re-balance). */
export function indiaMixReturns(months, parts, w = MIX) {
  return months.map((m) => ({ m, r: w.next50 * (parts.next50.get(m) ?? 0) + w.gold * (parts.gold.get(m) ?? 0) + w.stocks * (parts.stocks.get(m) ?? 0) - w.rebalanceDragPct / 100 }));
}
const byYear = (rs) => {
  const y = {};
  for (const x of rs) y[x.m.slice(0, 4)] = (y[x.m.slice(0, 4)] ?? 1) * (1 + x.r);
  return Object.fromEntries(Object.entries(y).map(([k, g]) => [k, g - 1]));
};
const withDividends = (m, perMonth) => new Map([...m].map(([k, v]) => [k, v + perMonth]));

// ---------------------------------------------------------------- test ---
export async function indiaMixTest({ loadCandles = candles } = {}) {
  const d = await loadAll(loadCandles);
  const nClose = new Map(d.nifty.map((x) => [x.date, x.close]));
  const curve = simulate({ idx: d.idx, universe: d.universe, refDates: d.refDates, method: 'b', r: { ...MOM, fill: 'mid', slipPct: 0.3, top: 10 }, rank: buffered(rankBy(nClose)) }).curve;
  // the portfolio is re-made at the first session of each month: the change to the next point is that month's return
  const stocks = new Map();
  for (let i = 1; i < curve.length; i++) stocks.set(curve[i - 1].date.slice(0, 7), curve[i].value / curve[i - 1].value - 1);
  const p1 = Math.floor(Date.parse('2008-01-01') / 1000);
  const next50 = withDividends(monthlyReturns((await loadCandles('^NSMIDCP', { period1: p1, interval: '1d' })).filter((x) => x.close > 0)), 0.001); // ≈1.2% a year dividends
  const gold = monthlyReturns((await loadCandles(MIX.goldSymbol, { period1: p1, interval: '1d' })).filter((x) => x.close > 0));
  const nifty = withDividends(monthlyReturns(d.nifty), 0.001);
  const months = [...stocks.keys()].filter((m) => m >= '2010-02' && next50.has(m) && gold.has(m)).sort();
  const res = {
    mix: { label: 'India mix (⅓ Nifty Next 50 · ⅓ gold · ⅓ Momentum 10)', rs: indiaMixReturns(months, { next50, gold, stocks }) },
    simple: { label: '½ Nifty Next 50 · ½ gold (no stock picking)', rs: months.map((m) => ({ m, r: 0.5 * next50.get(m) + 0.5 * gold.get(m) - MIX.rebalanceDragPct / 100 })) },
    nifty: { label: 'NIFTY 50 index fund', rs: months.map((m) => ({ m, r: nifty.get(m) ?? 0 })) },
  };
  const cut = (rs, [a, b]) => rs.filter((x) => x.m >= a && x.m <= b);
  for (const x of Object.values(res)) {
    x.all = stats(x.rs);
    x.yearly = byYear(x.rs);
    for (const [p, range] of Object.entries(PERIODS)) x[p] = stats(cut(x.rs, range));
    delete x.rs;
  }
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const m = res.mix;
  const n = res.nifty;
  return {
    at: new Date().toISOString(), from: months[0], to: d.lastBhav, mix: MIX, results: res, tried: 62,
    passed: ['dev', 'val', 'holdout'].every((p) => m[p].cagr > n[p].cagr) && m.all.maxDrawdown < n.all.maxDrawdown,
    verdict: `${pc(m.all.cagr)} a year with a worst fall of ${pc(m.all.maxDrawdown)} (NIFTY ${pc(n.all.cagr)}, ${pc(n.all.maxDrawdown)}). By period: ${pc(m.dev.cagr)} / ${pc(m.val.cagr)} / ${pc(m.holdout.cagr)} (2010–17 / 2018–22 / 2023→) vs NIFTY ${pc(n.dev.cagr)} / ${pc(n.val.cagr)} / ${pc(n.holdout.cagr)}. Positive over ${pc(m.all.pos24)} of 2-year stretches.`,
    caution: 'Chosen from 62 mixes after seeing all the years (it ranked near the top on 2010–17 too), so expect it to look a little better here than it will be. Gold had a very strong 2019–26 and Momentum 10 came from a search. Before tax; falls measured month-end to month-end, so real falls are a bit deeper.',
    note: 'Nifty Next 50 index with ≈1.2% a year dividends; gold = GOLDBEES; Momentum 10 + buffer on the survivorship-free top 200 with realistic fills and charges. Put back to ⅓ each monthly with a 0.05% drag. Research only.',
  };
}

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const saveIndiaMix = (r) => writeJsonAtomic(SAVED(), r);
export const loadIndiaMix = () => readJ(SAVED());
export const loadIndiaMixPaper = () => readJ(PAPER());

// --------------------------------------------------------------- paper ---
/**
 * Paper portfolio from the start date: at the first session after each
 * month-end, put back to ⅓ JUNIORBEES / ⅓ GOLDBEES / ⅓ the Momentum 10 paper
 * list for that month-end (in the liquid fund until a list exists). Valued
 * daily at Yahoo closes.
 */
export async function indiaMixPaperUpdate({ loadCandles = candles, now = new Date(), capital = 100000, m10 = loadMomentum10Paper() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadIndiaMixPaper() || { startedAt: today, capital, rebalances: [], curve: [] };
  const nifty = (await loadCandles('^NSEI', { range: '1y', interval: '1d' })).filter((x) => x.close > 0);
  const completed = monthEnds(nifty.map((x) => x.date)).filter((d) => nifty.some((x) => x.date > d)).pop();
  const side = (MOM.costPct + 0.3) / 100;
  const priceOf = async (symbol, after = null) => {
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
    const gold = await priceOf(MIX.goldSymbol, completed);
    const next50 = await priceOf(MIX.next50Symbol, completed);
    if (gold && next50) {
      const date = gold.date;
      let value = st.capital;
      if (last) value = (await valueOf(last, { date, price: async (s) => (await priceOf(s, completed))?.px ?? null })).v * (1 - MIX.rebalanceDragPct / 100);
      const holdings = [
        { kind: 'fund', symbol: MIX.next50Symbol, name: 'Nifty Next 50 (JUNIORBEES)', amount: value * MIX.next50, entry: next50.px * (1 + side) },
        { kind: 'gold', symbol: MIX.goldSymbol, name: 'Gold (GOLDBEES)', amount: value * MIX.gold, entry: gold.px * (1 + side) },
      ];
      const list = m10?.monthEnd === completed ? m10.list : null;
      const stockMoney = value * MIX.stocks;
      if (list?.length) {
        const per = stockMoney / list.length;
        for (const x of list) {
          const o = await priceOf(`${x.symbol}.NS`, completed);
          holdings.push(o ? { kind: 'stock', symbol: `${x.symbol}.NS`, name: x.symbol, amount: per, entry: o.px * (1 + side) } : { kind: 'liquid', name: `${x.symbol} (no price; liquid)`, amount: per });
        }
      } else holdings.push({ kind: 'liquid', name: 'Stock part (no Momentum 10 list yet; liquid)', amount: stockMoney });
      st.rebalances.push({ monthEnd: completed, date, value, holdings });
    }
  }
  const cur = st.rebalances.at(-1);
  if (cur) {
    const { v, marks } = await valueOf(cur, { date: today, price: async (s) => (await priceOf(s))?.px ?? null });
    st.curve = [...st.curve.filter((c) => c.date !== today), { date: today, value: v }];
    st.marks = marks;
  }
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--paper')) {
      const st = await indiaMixPaperUpdate();
      console.log(`India mix paper: since ${st.startedAt} · ${st.rebalances.length} re-balance(s) · value ₹${Math.round(st.curve.at(-1)?.value ?? st.capital).toLocaleString('en-IN')}`);
    } else {
      const r = await indiaMixTest();
      saveIndiaMix(r);
      console.log(r.verdict);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
