#!/usr/bin/env node
// "NIFTY dip-buy" (library + CLI): a high-win-rate index strategy found by the
// 75%-win research run (26 variants, chosen on 2010–2018, tested on 2019–2026).
//
// Rules (fixed before the test period):
//   Signal   after the close: NIFTY above its 200-day average of closes, and
//            down 3% or more over the last 5 sessions
//   Entry    buy a NIFTY ETF (NIFTYBEES) at the next session's open, all of the
//            strategy's paper capital (₹1 lakh), one position at a time
//   Exit     at the first close above the 5-day average (entry day included),
//            or after the 10th session held → sell at the next open
//   Stop     none (the 200-day filter and the 10-day exit are the protection)
//   Costs    ETF delivery charges (orderCharges 'etf') + 0.05% slippage per fill
// Prices: ^NSEI daily candles stand in for NIFTYBEES (Yahoo's NIFTYBEES history
// has an unadjusted jump); the ETF tracks the index closely.
//
// What it is: ~3 trades a year, ~70–75% of them winners, small average gain;
// in the market ~4% of the time, so it is expected to TRAIL a NIFTY index fund.
// Kept as a paper experiment for learning. Research only — not investment advice.
//
//   node paper-bot/nifty-dip.mjs           # backtest (saved for the app)
//   node paper-bot/nifty-dip.mjs --paper   # update the forward paper record

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { orderCharges } from './costs.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { completedOnly } from './ath-swing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.NIFTY_DIP_PATH || join(HERE, 'data', 'nifty-dip.json');
const PAPER = () => process.env.NIFTY_DIP_PAPER_PATH || join(HERE, 'data', 'nifty-dip-paper.json');

export const RULES = { trendMa: 200, lookback: 5, dropPct: -3, exitMa: 5, maxDays: 10, capital: 100000, slippagePct: 0.05, cashYieldPct: 6, testFrom: '2019-01-01' };

const sma = (rows, i, n) => {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += rows[k].close;
  return s / n;
};

/** Signal check on the close of day i. */
export function signalAt(rows, i, r = RULES) {
  const ma = sma(rows, i, r.trendMa);
  if (ma == null || i < r.lookback) return null;
  const chg = (rows[i].close / rows[i - r.lookback].close - 1) * 100;
  return { date: rows[i].date, close: rows[i].close, ma200: ma, changePct: chg, aboveMa: rows[i].close > ma, fired: rows[i].close > ma && chg <= r.dropPct };
}

/** Value-based trade with ETF charges and slippage on both fills. */
export function costTrade(entryPx, exitPx, r = RULES) {
  const buy = entryPx * (1 + r.slippagePct / 100);
  const sell = exitPx * (1 - r.slippagePct / 100);
  const units = r.capital / buy;
  const value = units * sell;
  const charges = orderCharges({ side: 'buy', value: r.capital, product: 'etf' }).total + orderCharges({ side: 'sell', value, product: 'etf' }).total;
  const gross = value - r.capital;
  const net = gross - charges;
  return { entry: buy, exit: sell, gross, charges, net, retPct: (net / r.capital) * 100 };
}

/** All trades on a daily series (open ones valued at the last close). */
export function simulate(rows, r = RULES) {
  const trades = [];
  let i = r.trendMa;
  while (i < rows.length) {
    const sig = signalAt(rows, i, r);
    if (!sig?.fired) {
      i++;
      continue;
    }
    const e = i + 1;
    if (e >= rows.length) {
      trades.push({ signalDate: sig.date, signalChangePct: sig.changePct, pending: true, open: true });
      break;
    }
    let exitIdx = null;
    let reason = null;
    let j = e;
    for (; j < rows.length; j++) {
      const ma = sma(rows, j, r.exitMa);
      if (ma != null && rows[j].close > ma) reason = 'bounce';
      else if (j - e + 1 >= r.maxDays) reason = `${r.maxDays} days`;
      if (reason) {
        exitIdx = j + 1;
        break;
      }
    }
    const open = exitIdx == null || exitIdx >= rows.length;
    const last = Math.min(j, rows.length - 1);
    const px = open ? rows[last].close : rows[exitIdx].open;
    trades.push({
      signalDate: sig.date, signalChangePct: sig.changePct, entryDate: rows[e].date, exitDate: open ? null : rows[exitIdx].date,
      lastDate: rows[open ? last : exitIdx].date, ...costTrade(rows[e].open, px, r), reason: open ? (reason ? `${reason} (sell at the next open)` : 'open') : reason, open,
      days: (open ? last : exitIdx) - e + (open ? 1 : 0),
      exitDue: open && !!reason,
    });
    if (open) break;
    i = exitIdx; // a new signal can fire from the exit day's close
  }
  return trades;
}

export function summarise(trades) {
  const done = trades.filter((t) => !t.open);
  if (!done.length) return { trades: 0 };
  const rets = done.map((t) => t.retPct);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1));
  const wins = done.filter((t) => t.net > 0);
  const gw = wins.reduce((a, t) => a + t.net, 0);
  const gl = -done.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0);
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const x of rets) {
    eq *= 1 + x / 100;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  return {
    trades: done.length, winRate: wins.length / done.length, avgRetPct: m, avgNetRs: done.reduce((a, t) => a + t.net, 0) / done.length,
    totalNetRs: done.reduce((a, t) => a + t.net, 0), worstPct: Math.min(...rets), bestPct: Math.max(...rets), profitFactor: gl > 0 ? gw / gl : null,
    maxDrawdownPct: dd * 100, tStat: sd > 0 ? m / (sd / Math.sqrt(rets.length)) : null, avgDays: done.reduce((a, t) => a + t.days, 0) / done.length,
    exits: { bounce: done.filter((t) => t.reason === 'bounce').length, timeout: done.filter((t) => t.reason !== 'bounce').length },
  };
}

const stcgRate = (date) => (date >= '2024-07-23' ? 0.2 : 0.15) * 1.04;
const fyOf = (date) => (Number(date.slice(5, 7)) >= 4 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1);

/** Yearly return of the strategy (idle cash in a liquid fund) vs holding NIFTY, before and after tax. */
export function portfolio(rows, trades, from, r = RULES) {
  const span = rows.filter((x) => x.date >= from);
  if (span.length < 2) return null;
  const years = (Date.parse(span[span.length - 1].date) - Date.parse(span[0].date)) / (365.25 * 86400000);
  const done = trades.filter((t) => !t.open && t.entryDate >= from);
  const inDays = done.reduce((a, t) => a + t.days, 0);
  const idleYears = Math.max(0, years - inDays / 252);
  const cash = r.cashYieldPct / 100;
  // before tax
  const tradeGrowth = done.reduce((a, t) => a * (1 + t.retPct / 100), 1);
  const cagr = (tradeGrowth * (1 + cash) ** idleYears) ** (1 / years) - 1;
  // after tax: each FY's net trading gain as short-term gain (losses carried forward), liquid-fund interest at 30% slab
  let eq = 1;
  let carry = 0;
  const byFy = new Map();
  for (const t of done) byFy.set(fyOf(t.exitDate), [...(byFy.get(fyOf(t.exitDate)) || []), t]);
  for (const list of byFy.values()) {
    let gain = 0;
    for (const t of list) gain += eq * (t.retPct / 100);
    const taxable = Math.max(0, gain + carry);
    carry = Math.min(0, gain + carry);
    eq += gain - taxable * stcgRate(list[list.length - 1].exitDate);
  }
  const cashAfter = cash * (1 - 0.3 * 1.04);
  const cagrAfter = (eq * (1 + cashAfter) ** idleYears) ** (1 / years) - 1;
  const niftyGrowth = span[span.length - 1].close / span[0].close;
  const niftyCagr = niftyGrowth ** (1 / years) - 1;
  const niftyAfter = (1 + (niftyGrowth - 1) * (1 - 0.125 * 1.04)) ** (1 / years) - 1;
  return { from: span[0].date, to: span[span.length - 1].date, years, timeInMarketPct: (inDays / 252 / years) * 100, cagr, cagrAfter, tradeOnlyCagr: tradeGrowth ** (1 / years) - 1, niftyCagr, niftyAfter };
}

async function loadNifty(loadCandles, now) {
  const rows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2007-01-01') / 1000), interval: '1d' })).filter((x) => x.open > 0 && x.close > 0);
  return completedOnly(rows, now);
}

export async function niftyDipTest({ loadCandles = candles, now = new Date(), r = RULES } = {}) {
  const rows = await loadNifty(loadCandles, now);
  const trades = simulate(rows, r);
  const done = trades.filter((t) => !t.open);
  const before = done.filter((t) => t.entryDate < r.testFrom && t.entryDate >= '2010-01-01');
  const test = done.filter((t) => t.entryDate >= r.testFrom);
  return {
    at: new Date().toISOString(), from: rows[r.trendMa]?.date, to: rows[rows.length - 1]?.date, rules: r,
    all: summarise(done), train: summarise(before), test: summarise(test),
    portfolio: portfolio(rows, trades, r.testFrom, r),
    perYear: test.length ? +(test.length / ((Date.parse(rows[rows.length - 1].date) - Date.parse(r.testFrom)) / (365.25 * 86400000))).toFixed(1) : 0,
    recent: done.slice(-12).reverse(),
    note: '^NSEI daily candles stand in for NIFTYBEES; ₹1 lakh per trade with ETF charges and 0.05% slippage per fill. Rules were chosen on 2010–2018 and the 2019+ period is the honest test. Idle cash assumed in a liquid fund at 6% (taxed at a 30% slab); trading gains taxed as short-term (15%, 20% from 23 Jul 2024, +4% cess); NIFTY held throughout pays 12.5% long-term tax once at the end (the ₹1.25 lakh exemption is ignored). Price index only: dividends would add about 1.3% a year to NIFTY. Research only.',
  };
}

export function saveNiftyDip(r) {
  writeJsonAtomic(SAVED(), r);
}
const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
export const loadNiftyDip = () => readJ(SAVED());
export const loadNiftyDipPaper = () => readJ(PAPER());

/** Where NIFTY stands against the rules at the latest completed close. */
export function statusFrom(rows, trades, r = RULES) {
  const i = rows.length - 1;
  const s = signalAt(rows, i, r);
  if (!s) return null;
  const pos = trades.find((t) => t.open && !t.pending) || null;
  const pending = trades.find((t) => t.pending) || null;
  const exitMa = sma(rows, i, r.exitMa);
  // NIFTY level that would trigger tomorrow-evening's check (close ≤ close 5 sessions before tomorrow × 0.97)
  const triggerLevel = rows[i + 1 - r.lookback].close * (1 + r.dropPct / 100);
  return {
    date: s.date, close: s.close, ma200: s.ma200, aboveMa: s.aboveMa, changePct: s.changePct, fired: s.fired,
    exitMa, triggerLevel, triggerFallPct: (triggerLevel / s.close - 1) * 100,
    position: pos ? { entryDate: pos.entryDate, entry: pos.entry, last: rows[i].close, netRs: pos.net, retPct: pos.retPct, days: pos.days, exitDue: pos.exitDue } : null,
    pendingBuy: !!pending,
    message: pos
      ? (pos.exitDue ? 'Exit rule met at today\'s close: the paper record sells at the next open.' : `Holding: sells at the first close above the 5-day average (${exitMa.toFixed(0)}) or after day ${r.maxDays}.`)
      : pending ? `Signal today: NIFTY fell ${s.changePct.toFixed(1)}% in 5 sessions while above its 200-day average. The paper record buys at the next open.`
        : !s.aboveMa ? 'No signal possible: NIFTY is below its 200-day average (the rule only buys dips in a rising market).'
          : `No signal. A close at or below about ${triggerLevel.toFixed(0)} next session (${((triggerLevel / s.close - 1) * 100).toFixed(1)}% from here) would trigger it.`,
  };
}

export async function niftyDipToday({ loadCandles = candles, now = new Date() } = {}) {
  const rows = await loadNifty(loadCandles, now);
  const st = loadNiftyDipPaper();
  const trades = simulate(rows).filter((t) => !st || t.pending || t.entryDate >= st.startedAt);
  return statusFrom(rows, trades);
}

/** Forward paper record: trades entered on or after the start date; re-valued daily. */
export async function niftyDipPaperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadNiftyDipPaper() || { startedAt: new Date(now.getTime() + 19800_000).toISOString().slice(0, 10), trades: [] };
  const rows = await loadNifty(loadCandles, now);
  const all = simulate(rows);
  const before = new Set(st.trades.map((t) => t.entryDate));
  st.trades = all.filter((t) => !t.pending && t.entryDate >= st.startedAt);
  st.status = statusFrom(rows, all.filter((t) => t.pending || t.entryDate >= st.startedAt));
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  return { startedAt: st.startedAt, summary: summarise(st.trades), status: st.status, bought: st.trades.filter((t) => !before.has(t.entryDate)), sold: st.trades.filter((t) => !t.open && t.exitDate === today) };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x, d = 1) => (x == null ? '–' : `${x.toFixed(d)}%`);
  if (process.argv.includes('--paper')) {
    niftyDipPaperUpdate()
      .then((r) => console.log(`NIFTY dip-buy paper: since ${r.startedAt} · ${r.summary.trades} closed trades · ${r.status?.message || ''}`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    niftyDipTest()
      .then((r) => {
        saveNiftyDip(r);
        const line = (n, x) => console.log(`${n.padEnd(18)} ${String(x.trades).padStart(3)} trades · win ${x.winRate != null ? Math.round(x.winRate * 100) : '–'}% · avg ${pc(x.avgRetPct, 2)} · worst ${pc(x.worstPct)} · PF ${x.profitFactor?.toFixed(2) ?? '–'} · DD ${pc(x.maxDrawdownPct)} · t ${x.tStat?.toFixed(2) ?? '–'}`);
        console.log(`\nNIFTY DIP-BUY · ${r.from} → ${r.to}`);
        line('2010–2018 (chosen)', r.train);
        line('2019+ (test)', r.test);
        const p = r.portfolio;
        console.log(`Test period: ${r.perYear} trades/yr · in the market ${pc(p.timeInMarketPct)} of the time · ${pc(p.cagr * 100)}/yr (after tax ${pc(p.cagrAfter * 100)}) vs NIFTY ${pc(p.niftyCagr * 100)} (after tax ${pc(p.niftyAfter * 100)})`);
        console.log(`\n${r.note}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
