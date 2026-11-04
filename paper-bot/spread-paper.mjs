#!/usr/bin/env node
// Spread paper tracker (library + CLI): ₹10,000 of practice money traded only on paper with the
// "Fits my budget" rules — each evening, after NSE's F&O file for the day is out, while fewer than `maxOpen`
// trades are open and cash allows, it buys the best-odds spread (highest chance of profit; calls for STRONG
// F&O stocks, puts for WEAK ones, NIFTY both ways) whose most-you-can-lose (cost + charges) is at most
// `perTrade`, one per stock, at most `maxPerSide` the same way, at THAT day's NSE closing prices.
// NIFTY spreads (cash-settled) are held to expiry and settled at NIFTY's close on the expiry day. Stock
// options settle by DELIVERY (a small account can't take or give the shares, and brokers close such
// positions in expiry week), so stock spreads are sold `exitSessionsBefore` sessions before expiry at
// that day's option closes, after charges. Open trades are valued each evening at the latest option
// closes less every charge already paid and the charges to close. Paper only.
//
//   node paper-bot/spread-paper.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { affordable, payoff, legCharges, latestChain, latestStockChain } from './fo-riskcheck.mjs';
import { foStocksDir, foBhav } from './vol-premium.mjs';
import { lastSessionDate, nseOpenNow, tradingDaysBetween } from './market-calendar.mjs';
import { loadSeries } from './bhav-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = () => process.env.SPREAD_PAPER_PATH || join(HERE, 'data', 'spread-paper.json');
const FO_DIR = () => process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
export const RULES = { capital: 10000, perTrade: 3000, maxOpen: 3, maxPerSide: 2, minSessions: 5, minVolume: 100, exitSessionsBefore: 2 };

export function loadSpreadPaper() {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
}
const readJson = (f) => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  } catch {
    return null;
  }
};
const stockOf = (t) => (t.symbol === 'NIFTY' ? null : { lot: t.lot });

/** Trade legs in the payoff format ({ k, t, q, p }) from a Fits-my-budget row. */
export const toLegs = (row) => row.legs.map((l) => ({ k: l.strike, t: l.type, q: l.side === 'buy' ? 1 : -1, p: l.price }));
/** Rupees for the whole position at a final underlying price (after charges). */
export const settleRs = (t, price) => payoff(t.legs, price, t.entryDate, stockOf(t)) * t.lot;
/** Rupees of charges paid to open (brokerage, STT, exchange, stamp, GST, slippage). */
export const entryChargesRs = (t) => t.legs.reduce((a, l) => a + legCharges(l.p, l.q, t.entryDate, stockOf(t)), 0) * t.lot;
/** Rupees of charges to close every leg at these prices (each leg traded the other way). */
const exitChargesRs = (t, pxs, date) => t.legs.reduce((a, l, i) => a + legCharges(pxs[i], -l.q, date, stockOf(t)), 0) * t.lot;
/** Option closes of the trade's legs in a chain for its expiry, or null. */
const legPrices = (t, chain) => {
  if (!chain || chain.expiry !== t.expiry) return null;
  const pxs = t.legs.map((l) => chain.chain?.[l.k]?.[l.t]);
  return pxs.every((p) => p >= 0) ? pxs : null;
};
/** The stock exit day: `n` sessions before expiry (stock options settle by delivery). */
export const exitDay = (entryDate, expiry, n = RULES.exitSessionsBefore) => {
  const s = tradingDaysBetween(entryDate, expiry).filter((d) => d > entryDate && d < expiry);
  return s[Math.max(0, s.length - n)] ?? expiry;
};

/** Gain vs the money paid if the spread were closed at these option closes: after the entry charges and the charges to close. */
export function markRs(t, chain) {
  const pxs = legPrices(t, chain);
  if (!pxs) return null;
  const value = t.legs.reduce((a, l, i) => a + l.q * pxs[i], 0) * t.lot;
  return value - t.cost - (t.entryCharges ?? entryChargesRs(t)) - exitChargesRs(t, pxs, chain.date);
}

/** NSE's official close for a stock on a date from the cash-market files (null when not saved). */
function eqCloseNse(symbol, date) {
  try {
    return loadSeries({ months: [date.slice(0, 7)] }).get(symbol)?.find((r) => r.date === date)?.close ?? null;
  } catch {
    return null;
  }
}

export async function spreadPaperUpdate({ now = new Date(), loadCandles = candles, rules = RULES, pick = (o) => affordable(o), fetchDay = (d) => foBhav(d), eqClose = eqCloseNse } = {}) {
  rules = { ...RULES, ...rules };
  const t0 = new Date(now.getTime() + 19800_000);
  const today = t0.toISOString().slice(0, 10);
  const st = loadSpreadPaper() || { startedAt: today, rules, cash: rules.capital, trades: [] };
  const session = lastSessionDate(now);
  // 0. the day's NSE F&O file (it also saves every stock's chain), when it is out
  if (!nseOpenNow(now)) {
    try {
      await fetchDay(session);
    } catch {
      /* not out yet / NSE blocked: the older files are used for marks only */
    }
  }
  // 1a. stock spreads: sold at the option closes of the exit day (or the first later day before expiry with prices)
  for (const t of st.trades.filter((x) => x.open && x.symbol !== 'NIFTY' && x.exitBy && x.exitBy <= session)) {
    for (const d of tradingDaysBetween(t.exitBy, t.expiry).filter((x) => x < t.expiry && x <= session)) {
      const o = readJson(join(foStocksDir(), `${d}.json`))?.[t.symbol];
      const pxs = o && legPrices(t, { expiry: t.expiry, chain: o.expiries?.[t.expiry] });
      if (!pxs) continue;
      const value = t.legs.reduce((a, l, i) => a + l.q * pxs[i], 0) * t.lot;
      Object.assign(t, { open: false, unsettled: false, settleDate: d, settleHow: 'sold before expiry', exitPrices: pxs, settlePrice: o.underlying ?? null });
      t.pnl = value - t.cost - (t.entryCharges ?? entryChargesRs(t)) - exitChargesRs(t, pxs, d);
      st.cash += t.cost + t.pnl;
      break;
    }
  }
  // 1b. held to expiry (NIFTY; a stock only if no price was saved before expiry): settled once the expiry day has
  //     CLOSED, at that day's official close — NSE's own price from the expiry day's files, else Yahoo's bar for exactly that date
  const afterClose = t0.getUTCHours() * 60 + t0.getUTCMinutes() >= 15 * 60 + 45;
  for (const t of st.trades.filter((x) => x.open && (x.expiry < today || (x.expiry === today && afterClose)))) {
    try {
      let price = null;
      if (t.symbol === 'NIFTY') price = readJson(join(FO_DIR(), `${t.expiry}.json`))?.underlying ?? null;
      else price = readJson(join(foStocksDir(), `${t.expiry}.json`))?.[t.symbol]?.underlying ?? eqClose(t.symbol, t.expiry);
      if (!(price > 0)) {
        const yahoo = t.symbol === 'NIFTY' ? '^NSEI' : `${t.symbol}.NS`;
        const rows = (await loadCandles(yahoo, { period1: Math.floor(Date.parse(`${t.entryDate}T00:00:00Z`) / 1000), interval: '1d' })).filter((r) => r.close > 0);
        price = rows.find((r) => r.date === t.expiry)?.close ?? null;
      }
      if (!(price > 0)) {
        // the expiry day's close isn't available yet: try again next run; flag it after 3 sessions
        t.unsettled = tradingDaysBetween(t.expiry, today).filter((d) => d > t.expiry).length >= 3;
        continue;
      }
      Object.assign(t, { open: false, unsettled: false, settleDate: t.expiry, settleHow: 'expiry close', settlePrice: price });
      t.pnl = settleRs(t, price);
      st.cash += t.cost + t.pnl;
    } catch {
      /* try again next run */
    }
  }
  // 2. mark the open ones at the latest NSE option closes
  for (const t of st.trades.filter((x) => x.open)) {
    const chain = t.symbol === 'NIFTY' ? latestChain() : latestStockChain(t.symbol);
    const m = markRs(t, chain);
    if (m != null) {
      t.mark = m;
      t.markDate = chain.date;
    }
  }
  // 3. open new spreads at the CLOSING prices of the session just ended (never older prices, never while the market
  //    is open), while slots and cash allow: one per stock, at most `maxPerSide` calls or puts, at least `minSessions`
  //    to expiry, both legs traded at least `minVolume` contracts, and cash kept for every open trade's full worst case
  const open = st.trades.filter((x) => x.open);
  let opened = 0;
  const reserved = open.reduce((a, x) => a + Math.max(0, (x.maxLoss ?? x.cost) - x.cost), 0); // charges etc. still to come
  let free = st.cash - reserved;
  if (open.length < rules.maxOpen && free >= 500 && !nseOpenNow(now) && !st.trades.some((x) => x.entryDate === session)) {
    let res = { rows: [] };
    try {
      res = await pick({ capital: rules.capital, perTrade: Math.min(rules.perTrade, free) });
    } catch {
      /* prices unavailable: settlements and marks above are still saved */
    }
    const held = new Set(open.map((x) => x.symbol));
    const side = (s) => [...open, ...st.trades.slice(st.trades.length - opened)].filter((x) => x.open && x.strategy === s).length;
    for (const row of (res.rows || []).filter((x) => x.kind === 'spread').sort((a, b) => b.chanceOfProfit - a.chanceOfProfit)) { // best chance first
      if (open.length + opened >= rules.maxOpen) break;
      const maxLoss = row.maxLoss ?? Infinity;
      if (row.date !== session || !(row.expiry > today) || !(row.sessions >= rules.minSessions) || !((row.minVolume ?? 0) >= rules.minVolume)) continue;
      if (held.has(row.symbol) || maxLoss > free || maxLoss > rules.perTrade || side(row.strategy) >= rules.maxPerSide) continue;
      const t = { symbol: row.symbol, lean: row.lean, strategy: row.strategy, legs: toLegs(row), lot: row.lot, cost: row.cost, maxLoss, maxProfit: row.maxProfit, chanceOfProfit: row.chanceOfProfit, entryDate: row.date, expiry: row.expiry, spot: row.spot, minVolume: row.minVolume, open: true };
      t.entryCharges = entryChargesRs(t);
      if (t.symbol !== 'NIFTY') t.exitBy = exitDay(t.entryDate, t.expiry, rules.exitSessionsBefore);
      t.mark = -t.entryCharges; // what it is worth now: the charges are already spent
      t.markDate = t.entryDate;
      st.trades.push(t);
      st.cash -= row.cost;
      free -= maxLoss;
      held.add(row.symbol);
      opened++;
    }
  }
  const closed = st.trades.filter((x) => !x.open);
  const openNow = st.trades.filter((x) => x.open);
  st.rules = rules;
  st.summary = {
    closed: closed.length, won: closed.filter((x) => x.pnl > 0).length, winRate: closed.length ? closed.filter((x) => x.pnl > 0).length / closed.length : null,
    realised: closed.reduce((a, x) => a + x.pnl, 0), open: openNow.length, openCost: openNow.reduce((a, x) => a + x.cost, 0), openMark: openNow.reduce((a, x) => a + (x.mark ?? -(x.entryCharges ?? 0)), 0),
    value: st.cash + openNow.reduce((a, x) => a + x.cost + (x.mark ?? -(x.entryCharges ?? 0)), 0),
    unsettled: openNow.filter((x) => x.unsettled).length,
  };
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { st, opened };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { st, opened } = await spreadPaperUpdate();
    const s = st.summary;
    console.log(`Spread paper: since ${st.startedAt} · value ₹${Math.round(s.value).toLocaleString('en-IN')} · cash ₹${Math.round(st.cash).toLocaleString('en-IN')} · ${s.open} open (${opened} new) · ${s.closed} closed, won ${s.won}${s.unsettled ? ` · ${s.unsettled} waiting for an expiry price` : ''}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
