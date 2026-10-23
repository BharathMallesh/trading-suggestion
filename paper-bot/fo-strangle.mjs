#!/usr/bin/env node
// NIFTY weekly short strangle (library + CLI), paper only. The least-bad of 14
// F&O strategies in the 2026-10-23 study — and it still did NOT beat holding a
// NIFTY index fund: it wins most weeks, then one crash week (March 2020: −77%
// of margin) wipes out months of gains. Tracked on paper to watch that happen.
//
// Rules (fixed before testing):
//   Entry   at the close of the first session after each weekly expiry
//   Legs    sell 1 lot of the weekly call nearest 2% above NIFTY and the put
//           nearest 2% below (strikes with a traded price that day)
//   Exit    hold to expiry; cash-settled at NIFTY's close (no stop-loss: only
//           end-of-day option prices are available)
//   Costs   brokerage ₹20/order, STT on the sold premium (0.05% → 0.0625% from
//           Apr 2023 → 0.1% from Oct 2024), exchange, SEBI, GST, slippage
//           0.5% of premium (min 0.5 point) per leg
//   Money   margin ≈ 13% of the contract value (15% from 20 Nov 2024); the
//           account holds 3× the margin, the rest earning 6% in a liquid fund
// Prices: NSE's daily F&O bhavcopy (real closing prices, cached in
// paper-bot/data/fo-bhav by vol-premium.mjs) and NIFTY's daily close.
// Research only — not investment advice. F&O: ~9 in 10 individual traders lose (SEBI).
//
//   node paper-bot/fo-strangle.mjs           # backtest on the cached weeks (saved)
//   node paper-bot/fo-strangle.mjs --paper   # update the forward paper record

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { foBhav } from './vol-premium.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay, tradingDaysBetween } from './market-calendar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.FO_STRANGLE_PATH || join(HERE, 'data', 'fo-strangle.json');
const PAPER = () => process.env.FO_STRANGLE_PAPER_PATH || join(HERE, 'data', 'fo-strangle-paper.json');
const FO_DIR = () => process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');

export const RULES = { otmPct: 2, slippagePct: 0.5, slippageMinPts: 0.5, brokeragePerOrder: 20, accountShare: 1 / 3, liquidYield: 0.06, split: '2023-01-01' };
// NIFTY lot size and margin over time (NSE circulars)
export const lotOn = (d) => (d < '2021-07-29' ? 75 : d < '2024-04-26' ? 50 : d < '2024-12-26' ? 25 : d < '2026-01-06' ? 75 : 65);
export const LOT_NOW = 65;
const sttSell = (d) => (d < '2023-04-01' ? 0.05 : d < '2024-10-01' ? 0.0625 : 0.1);
const exch = (d) => (d < '2024-10-01' ? 0.05 : 0.03503);
export const marginPct = (d) => (d < '2024-11-20' ? 13 : 15);

/** Costs (index points per unit) to open one short leg. */
export function legCost(prem, d, r = RULES) {
  const brk = r.brokeragePerOrder / lotOn(d);
  const ex = (prem * exch(d)) / 100;
  const sebi = prem * 1e-6;
  return brk + (prem * sttSell(d)) / 100 + ex + sebi + 0.18 * (brk + ex + sebi) + Math.max((prem * r.slippagePct) / 100, r.slippageMinPts);
}

/** Nearest strike to `target` with a traded price for `typ`. */
export function nearest(chain, target, typ) {
  let best = null;
  for (const [k, row] of Object.entries(chain)) {
    const vol = typ === 'CE' ? row.ceVol : row.peVol;
    if (!(row[typ] > 0) || !(vol > 0)) continue;
    if (best == null || Math.abs(k - target) < Math.abs(best - target)) best = Number(k);
  }
  return best;
}

/** Open a strangle from one day's chain → trade skeleton, or null. `spotClose` = NIFTY's close (older NSE files lack the underlying). */
export function openTrade(date, day, r = RULES, spotClose = null) {
  const expiry = day && Object.keys(day.expiries || {}).filter((e) => e > date).sort()[0];
  const spot = day?.underlying > 0 ? day.underlying : spotClose;
  if (!expiry || !(spot > 0)) return null;
  const ch = day.expiries[expiry];
  const ck = nearest(ch, spot * (1 + r.otmPct / 100), 'CE');
  const pk = nearest(ch, spot * (1 - r.otmPct / 100), 'PE');
  if (ck == null || pk == null || ck <= spot || pk >= spot) return null;
  const ce = ch[ck].CE;
  const pe = ch[pk].PE;
  const costs = legCost(ce, date, r) + legCost(pe, date, r);
  return { entryDate: date, expiry, spot, callStrike: ck, putStrike: pk, callPrem: ce, putPrem: pe, credit: ce + pe, costs, lot: lotOn(date), margin: (spot * marginPct(date)) / 100 };
}

/** Settle at NIFTY's close on expiry (points per unit after costs). */
export function settle(t, close) {
  const intrinsic = Math.max(close - t.callStrike, 0) + Math.max(t.putStrike - close, 0);
  const pts = t.credit - intrinsic - t.costs;
  return { ...t, open: false, settle: close, intrinsic, pts, retOnMargin: pts / t.margin, rupees: pts * t.lot, rupeesNowLot: pts * LOT_NOW, move: close / t.spot - 1, breached: close > t.callStrike ? 'call' : close < t.putStrike ? 'put' : null };
}

/** Value an open strangle at one day's option closes. */
export function markOpen(t, date, day) {
  const ch = day?.expiries?.[t.expiry];
  const c = ch?.[t.callStrike]?.CE;
  const p = ch?.[t.putStrike]?.PE;
  if (!(c >= 0) || !(p >= 0)) return t;
  const pts = t.credit - (c + p) - t.costs;
  return { ...t, markDate: date, markCall: c, markPut: p, markSpot: day.underlying || null, pts, retOnMargin: pts / t.margin, rupees: pts * t.lot, rupeesNowLot: pts * LOT_NOW };
}

export function summarise(trades, r = RULES) {
  const done = trades.filter((t) => !t.open);
  if (!done.length) return { trades: 0 };
  const rets = done.map((t) => t.retOnMargin);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1));
  // account: margin is `accountShare` of it, the rest in a liquid fund
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const t of done) {
    const days = (Date.parse(t.expiry) - Date.parse(t.entryDate)) / 86400000 + 1;
    eq = Math.max(0, eq * (1 + t.retOnMargin * r.accountShare + (1 - r.accountShare) * ((1 + r.liquidYield) ** (days / 365) - 1)));
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  const years = (Date.parse(done[done.length - 1].expiry) - Date.parse(done[0].entryDate)) / (365.25 * 86400000);
  const worst = done.reduce((a, b) => (b.retOnMargin < a.retOnMargin ? b : a));
  return {
    trades: done.length, winRate: done.filter((t) => t.pts > 0).length / done.length, avgRetOnMarginPct: m * 100, tStat: sd > 0 ? m / (sd / Math.sqrt(rets.length)) : null,
    avgRsNowLot: done.reduce((a, t) => a + t.rupeesNowLot, 0) / done.length, totalRs: done.reduce((a, t) => a + t.rupees, 0),
    worst: { date: worst.entryDate, retOnMarginPct: worst.retOnMargin * 100, rsNowLot: worst.rupeesNowLot, move: worst.move },
    breaches: done.filter((t) => t.breached).length,
    accountCagr: years > 0.2 ? eq ** (1 / years) - 1 : null, accountMaxDrawdown: dd,
  };
}

const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
const cached = (d) => readJ(join(FO_DIR(), `${d}.json`));

async function niftyCloses(loadCandles, from = '2019-01-01') {
  const rows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse(from) / 1000), interval: '1d' })).filter((x) => x.close > 0);
  return new Map(rows.map((x) => [x.date, x.close]));
}

/** Backtest on every cached week: one strangle opened on the first cached session after each expiry. */
export async function foStrangleTest({ loadCandles = candles, now = new Date(), r = RULES } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const close = await niftyCloses(loadCandles);
  const files = existsSync(FO_DIR()) ? readdirSync(FO_DIR()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort() : [];
  const trades = [];
  let lastExpiry = '';
  for (const d of files) {
    if (d <= lastExpiry) continue;
    const t = openTrade(d, cached(d), r, close.get(d));
    if (!t) continue;
    lastExpiry = t.expiry;
    if (t.expiry >= today || !close.has(t.expiry)) continue; // not settled yet
    trades.push(settle(t, close.get(t.expiry)));
  }
  const marginNow = ([...close].pop()?.[1] || 0) * LOT_NOW * (marginPct(today) / 100); // one lot's margin at today's NIFTY level
  for (const t of trades) t.rsAtTodaysSize = t.retOnMargin * marginNow;
  const nifty = [...close].filter(([d]) => trades.length && d >= trades[0].entryDate && d <= trades[trades.length - 1].expiry);
  const yrs = nifty.length > 1 ? (Date.parse(nifty[nifty.length - 1][0]) - Date.parse(nifty[0][0])) / (365.25 * 86400000) : 0;
  const niftyCagr = yrs > 0 ? (nifty[nifty.length - 1][1] / nifty[0][1]) ** (1 / yrs) * 1.013 - 1 : null; // + ~1.3%/yr dividends
  return {
    at: new Date().toISOString(), from: trades[0]?.entryDate, to: trades[trades.length - 1]?.expiry, rules: r,
    all: summarise(trades, r), early: summarise(trades.filter((t) => t.entryDate < r.split), r), later: summarise(trades.filter((t) => t.entryDate >= r.split), r),
    niftyCagr,
    marginNow,
    worstWeeks: [...trades].sort((a, b) => a.retOnMargin - b.retOnMargin).slice(0, 5).map((t) => ({ entryDate: t.entryDate, expiry: t.expiry, move: t.move, retOnMarginPct: t.retOnMargin * 100, rsNowLot: t.rupeesNowLot, rsAtTodaysSize: t.rsAtTodaysSize, breached: t.breached })),
    recent: trades.slice(-10).reverse(),
    note: `Real NSE weekly NIFTY option closing prices; one lot per week, opened at the close of the first session after each expiry and held to expiry (no stop-loss). ₹ per lot use today's lot of ${LOT_NOW}. Account = 3× the margin (the rest in a liquid fund at 6%). Rules fixed before testing; ${r.split.slice(0, 4)} onward was judged once. NIFTY includes ≈1.3%/yr dividends. Research only — not investment advice.`,
  };
}

export const saveFoStrangle = (r) => writeJsonAtomic(SAVED(), r);
export const loadFoStrangle = () => readJ(SAVED());
export const loadFoStranglePaper = () => readJ(PAPER());

/**
 * Forward paper record. Starts with the first weekly cycle after the start
 * date; each run downloads any missing NSE days (published in the evening, so
 * a day may be picked up on the next run), opens / marks / settles trades.
 */
export async function foStranglePaperUpdate({ loadCandles = candles, now = new Date(), fetchFn = fetch, getDay = (d) => foBhav(d, { fetchFn }) } = {}) {
  const t0 = new Date(now.getTime() + 19800_000);
  const today = t0.toISOString().slice(0, 10);
  // NSE publishes the day's F&O file in the evening; asking earlier would cache "no file" for good
  const lastAsk = t0.getUTCHours() >= 20 ? today : new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const st = loadFoStranglePaper() || { startedAt: today, trades: [], waitAfter: null };
  const close = await niftyCloses(loadCandles, st.startedAt < '2026-01-01' ? st.startedAt : '2026-01-01');
  const days = tradingDaysBetween(st.startedAt, lastAsk).filter((d) => isTradingDay(d));
  let last = null;
  for (const d of days) {
    let day = null;
    try {
      day = await getDay(d);
    } catch {
      day = null; // NSE blocked / offline: try again next run
    }
    if (!day) continue; // not published yet (or a holiday)
    last = d;
    // first run: wait for the next weekly cycle (no mid-week entry)
    if (st.waitAfter == null) st.waitAfter = Object.keys(day.expiries || {}).filter((e) => e > d).sort()[0] || d;
    let open = st.trades.find((t) => t.open);
    if (open && d <= open.expiry && d !== open.entryDate) {
      const i = st.trades.indexOf(open);
      st.trades[i] = markOpen(open, d, day);
    }
    open = st.trades.find((t) => t.open);
    if (!open && d > st.waitAfter && !st.trades.some((t) => t.entryDate === d)) {
      const t = openTrade(d, day, RULES, close.get(d));
      if (t) {
        st.trades.push({ ...t, open: true, pts: -t.costs, retOnMargin: -t.costs / t.margin, rupees: -t.costs * t.lot, rupeesNowLot: -t.costs * LOT_NOW });
        st.waitAfter = t.expiry;
      }
    }
  }
  // settle at NIFTY's close on expiry day
  st.trades = st.trades.map((t) => (t.open && close.has(t.expiry) && t.expiry <= today ? settle(t, close.get(t.expiry)) : t));
  const open = st.trades.find((t) => t.open) || null;
  st.status = open
    ? { message: `Holding: short ${open.callStrike} call + ${open.putStrike} put, expiry ${open.expiry}. ${open.markDate ? `Value on ${open.markDate}: ${open.rupees >= 0 ? '+' : '−'}₹${Math.abs(Math.round(open.rupees)).toLocaleString('en-IN')} per lot.` : 'Opened at the close.'}`, open }
    : { message: `No position. The next strangle opens at the close of the first session after the ${st.waitAfter || 'next'} expiry.`, open: null };
  st.lastDataDate = last || st.lastDataDate || null;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { startedAt: st.startedAt, summary: summarise(st.trades), status: st.status, lastDataDate: st.lastDataDate };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const pc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
  if (process.argv.includes('--paper')) {
    foStranglePaperUpdate()
      .then((r) => console.log(`NIFTY short strangle paper: since ${r.startedAt} · ${r.summary.trades} closed · NSE data up to ${r.lastDataDate || '–'} · ${r.status.message}`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    foStrangleTest()
      .then((r) => {
        saveFoStrangle(r);
        const line = (n, x) => console.log(`${n.padEnd(12)} ${String(x.trades).padStart(3)} weeks · won ${pc(x.winRate, 0)} · avg ${rs(x.avgRsNowLot)}/lot · ${x.avgRetOnMarginPct?.toFixed(2)}% of margin · t ${x.tStat?.toFixed(2)} · worst ${rs(x.worst?.rsNowLot)} (${x.worst?.date}) · account ${pc(x.accountCagr)}/yr, max fall ${pc(x.accountMaxDrawdown, 0)}`);
        console.log(`\nNIFTY WEEKLY SHORT STRANGLE ±${r.rules.otmPct}% · ${r.from} → ${r.to}`);
        line('All', r.all);
        line('2019–2022', r.early);
        line('2023 onward', r.later);
        console.log(`NIFTY held over the same span: ${pc(r.niftyCagr)}/yr`);
        console.log(`\n${r.note}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
