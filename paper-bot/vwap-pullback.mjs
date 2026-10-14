#!/usr/bin/env node
// "Same stocks every day" intraday strategy (from a Dhan video), implemented
// exactly as described and tested honestly. Library + CLI.
//
// Rules (fixed before testing):
//   Stocks   Bajaj Finserv, Trent, Titan, Maruti — cash market, intraday
//   Chart    5-minute candles · 20-period moving average · VWAP (resets daily)
//   Long     price above BOTH the 20 MA and VWAP; wait for a PULLBACK to the
//            20 MA: a candle whose low touches the MA but closes back above it
//            (and above VWAP) → buy at the next candle's open
//   Short    mirror image (below both; candle high touches the MA, closes below)
//   Stop     2 × ATR(14) from entry ("allow at least two ATRs")
//   Target   2 × risk (1:2) — 1:1, 1:3 and 1:4 reported as sensitivity
//   Time     new trades 09:30–13:00 only; anything open is closed at 15:00
//   Limits   1 trade per stock per day; the account takes at most 2 a day
//   Costs    intraday: brokerage ₹20 or 0.03% (lower), STT 0.025% on sells,
//            exchange, SEBI, stamp 0.003% on buys, GST 18%, slippage 0.03%/fill
//   Sizing   risk ₹1,000 per trade (1% of ₹1 lakh), capped at 5× intraday leverage
// Verdict rule: "works" only if net profit per trade after costs is > 0 with a
// date-clustered t ≥ 2 AND positive in both halves of the period AND on the
// wider stock list too. Yahoo keeps ~60 days of 5-minute bars — a short sample.
// Research / paper only — not investment advice.
//
//   node paper-bot/vwap-pullback.mjs

import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { candles } from '../market-data.mjs';
import { orderCharges } from './costs.mjs';
import { EVAL_UNIVERSE, VIDEO_STOCKS } from './config.mjs';
import { mapLimit, writeJsonAtomic, badRequest } from '../util.mjs';
import { historyCandles } from './collector.mjs';
import { isTradingDay } from './market-calendar.mjs';

const SAVED = () => process.env.VWAP_PULLBACK_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'vwap-pullback.json');
export { VIDEO_STOCKS };
export const RULES = { ma: 20, maType: 'sma', stopMode: 'atr', atr: 14, stopAtr: 2, rr: 2, lastEntry: '13:00', exitAt: '15:00', firstEntry: '09:30', riskRs: 1000, capital: 100000, leverage: 5, slippagePct: 0.03, maxPerDay: 2 };
const COSTS = { brokerageDeliveryPct: 0, brokerageDeliveryCap: 0, brokerageIntradayPct: 0.03, brokerageIntradayCap: 20, dpChargePerSell: 0, slippagePct: 0 };

const hhmm = (r) => String(r.date).slice(11, 16);
const day = (r) => String(r.date).slice(0, 10);

/** Add SMA(ma), ATR(atr) and session VWAP to each 5-minute bar. */
export function indicators(rows, { ma = RULES.ma, atr = RULES.atr, maType = 'sma' } = {}) {
  const out = rows.map((r) => ({ ...r }));
  let cumPV = 0;
  let cumV = 0;
  let trSum = [];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (i === 0 || day(r) !== day(out[i - 1])) {
      cumPV = 0;
      cumV = 0;
    }
    const tp = (r.high + r.low + r.close) / 3;
    const v = r.volume > 0 ? r.volume : 0;
    cumPV += tp * v;
    cumV += v;
    r.vwap = cumV > 0 ? cumPV / cumV : tp;
    if (maType === 'ema') {
      const k = 2 / (ma + 1);
      r.ma = i === 0 ? r.close : out[i - 1].ma * (1 - k) + r.close * k;
      if (i < ma - 1) r.maReady = false;
    } else if (i >= ma - 1) {
      let s = 0;
      for (let k = i - ma + 1; k <= i; k++) s += out[k].close;
      r.ma = s / ma;
    }
    const prevClose = i > 0 ? out[i - 1].close : r.close;
    trSum.push(Math.max(r.high - r.low, Math.abs(r.high - prevClose), Math.abs(r.low - prevClose)));
    if (trSum.length > atr) trSum.shift();
    if (trSum.length === atr) r.atr = trSum.reduce((a, b) => a + b, 0) / atr;
  }
  return out;
}

/** Charges for one round trip (₹), intraday product. */
function roundTripCharges(entry, exit, qty, side) {
  const buyVal = (side === 'long' ? entry : exit) * qty;
  const sellVal = (side === 'long' ? exit : entry) * qty;
  return orderCharges({ side: 'buy', value: buyVal, product: 'intraday', costs: COSTS }).total + orderCharges({ side: 'sell', value: sellVal, product: 'intraday', costs: COSTS }).total;
}

/**
 * Signals and simulated trades for one stock (all sessions in `rows`).
 * Returns trades with gross / net ₹ and R.
 */
/**
 * @param {object} [ctx] optional context for the filters:
 *   nifty: Map('YYYY-MM-DD HH:MM' → { close, ma, vwap }) NIFTY 5-minute indicators
 *   daily: Map('YYYY-MM-DD' → { aboveAvg20 }) — stock vs its 20-day average at the PREVIOUS close
 */
export function backtestStock(symbol, rows, rules = RULES, ctx = {}) {
  const bars = indicators(rows, rules);
  const trades = [];
  let tradedToday = null;
  const dayInfo = sessionInfo(bars);
  for (let i = 1; i + 1 < bars.length; i++) {
    const b = bars[i];
    const d = day(b);
    const t = hhmm(b);
    if (tradedToday === d) continue;
    if (t < rules.firstEntry || t >= rules.lastEntry) continue;
    if (b.ma == null || b.atr == null || !(b.atr > 0)) continue;
    const prev = bars[i - 1];
    if (prev.ma == null) continue;
    // alignment on the previous candle, pullback-and-hold on this one
    let side = null;
    if (prev.close > prev.ma && prev.close > prev.vwap && b.low <= b.ma && b.close > b.ma && b.close > b.vwap) side = 'long';
    else if (prev.close < prev.ma && prev.close < prev.vwap && b.high >= b.ma && b.close < b.ma && b.close < b.vwap) side = 'short';
    if (!side) continue;
    // optional filters (all off in the video's rules)
    const dir = side === 'long' ? 1 : -1;
    if (rules.vwapSlope) {
      const back = bars[i - 6];
      if (!back || day(back) !== d || dir * (b.vwap - back.vwap) <= 0) continue; // VWAP must slope with the trade
    }
    if (rules.marketAlign) {
      const n = ctx.nifty?.get(b.date);
      if (!n || n.ma == null || dir * (n.close - n.ma) <= 0 || dir * (n.close - n.vwap) <= 0) continue; // NIFTY on the same side of both
    }
    if (rules.dailyTrend) {
      const dt = ctx.daily?.get(d);
      if (!dt || (side === 'long') !== dt.aboveAvg20) continue;
    }
    if (rules.volumeConfirm) {
      // quiet pullback (3 candles before the signal below the average of up to 20 candles before them)
      // and a bounce with participation (signal candle above those 3)
      const back = bars.slice(Math.max(0, i - 23), i - 3).map((x) => x.volume || 0);
      const pull = bars.slice(i - 3, i).map((x) => x.volume || 0);
      const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
      if (back.length < 10 || !(avg(back) > 0) || !(avg(pull) < avg(back)) || !((b.volume || 0) > avg(pull))) continue;
    }
    if (rules.morningGapPct) {
      // "in play" this morning: moved ≥ X% from yesterday's close by 09:30, trade only that way
      const g = dayInfo.get(d)?.gapPct;
      if (g == null || dir * g < rules.morningGapPct) continue;
    }
    if (rules.trendDayPct) {
      // trend day: first 30 minutes (09:15–09:45) moved ≥ X%, trade only that way, from 09:45
      const m = dayInfo.get(d)?.first30Pct;
      if (t < '09:45' || m == null || dir * m < rules.trendDayPct) continue;
    }
    const nx = bars[i + 1];
    if (day(nx) !== d) continue;
    const slip = rules.slippagePct / 100;
    let entry;
    let k0 = i + 1; // candle the trade starts in
    if (rules.limitEntry) {
      // limit order at the signal candle's 20 MA, valid for the next 3 candles; no
      // entry slippage, but filled only if price trades THROUGH the limit
      const lim = b.ma;
      entry = null;
      for (let k = i + 1; k <= i + 3 && k < bars.length && day(bars[k]) === d; k++) {
        const c = bars[k];
        if (side === 'long' ? c.low < lim : c.high > lim) {
          entry = side === 'long' ? Math.min(lim, c.open) : Math.max(lim, c.open);
          k0 = k;
          break;
        }
      }
      if (entry == null) continue; // not filled → no trade, the stock can signal again
    } else entry = side === 'long' ? nx.open * (1 + slip) : nx.open * (1 - slip);
    const fill = bars[k0];
    // stop: 2 × ATR (default) or just beyond the pullback candle ("above the pullback area")
    const risk = rules.stopMode === 'swing'
      ? Math.max(0.25 * b.atr, side === 'long' ? entry - (b.low - 0.1 * b.atr) : (b.high + 0.1 * b.atr) - entry)
      : rules.stopAtr * b.atr;
    let stop = side === 'long' ? entry - risk : entry + risk;
    const target = rules.trailMa ? (side === 'long' ? Infinity : -Infinity) : side === 'long' ? entry + rules.rr * risk : entry - rules.rr * risk;
    const qty = Math.max(1, Math.floor(Math.min(rules.riskRs / risk, (rules.capital * rules.leverage) / entry)));
    // walk forward from the entry candle until stop / target / 15:00
    let exit = null;
    let reason = null;
    for (let j = k0; j < bars.length && day(bars[j]) === d; j++) {
      const c = bars[j];
      const hitStop = side === 'long' ? c.low <= stop : c.high >= stop;
      // a limit fill's own candle: its high/low may have come before the fill, so no target there
      const hitTarget = !(rules.limitEntry && j === k0) && (side === 'long' ? c.high >= target : c.low <= target);
      if (hitStop) {
        // if both inside one candle, assume the stop came first (conservative)
        exit = side === 'long' ? Math.min(stop, c.open) : Math.max(stop, c.open); // gap through the stop fills at the open
        reason = 'stop';
        break;
      }
      if (hitTarget) {
        exit = target;
        reason = 'target';
        break;
      }
      // breakeven: once the trade is +1R, the stop moves to the entry (from the next candle)
      if (rules.breakeven && (side === 'long' ? c.high >= entry + risk : c.low <= entry - risk)) stop = entry;
      // trailing exit: a candle closes back across the 20 MA → out at the next candle's open
      if (rules.trailMa && c.ma != null && (side === 'long' ? c.close < c.ma : c.close > c.ma)) {
        const n2 = bars[j + 1];
        if (n2 && day(n2) === d) {
          exit = n2.open;
          reason = 'trail';
          break;
        }
      }
      if (hhmm(c) >= rules.exitAt) {
        exit = c.close;
        reason = '15:00';
        break;
      }
    }
    if (exit == null) {
      const lastBar = bars.filter((x) => day(x) === d).pop();
      exit = lastBar.close;
      reason = 'close';
    }
    const exitFill = side === 'long' ? exit * (1 - slip) : exit * (1 + slip);
    const gross = (side === 'long' ? exitFill - entry : entry - exitFill) * qty;
    const charges = roundTripCharges(entry, exitFill, qty, side);
    // conditions at the signal, for the signal-odds model (vwap-odds.mjs)
    const n = ctx.nifty?.get(b.date);
    const feat = {
      atrPct: (b.atr / b.close) * 100,
      gapPct: dayInfo.get(d)?.gapPct ?? null,
      dailyUp: ctx.daily?.get(d) ? ctx.daily.get(d).aboveAvg20 : null,
      niftySide: n && n.ma != null ? (n.close > n.ma && n.close > n.vwap ? 1 : n.close < n.ma && n.close < n.vwap ? -1 : 0) : null,
    };
    trades.push({ feat, symbol, date: d, time: hdr(fill), side, entry, stop, target, exit: exitFill, qty, reason, gross, charges, net: gross - charges, rNet: (gross - charges) / (risk * qty), rGross: gross / (risk * qty) });
    tradedToday = d;
  }
  return trades;
}
const hdr = (r) => hhmm(r);

// Real runs add the locally saved 5-minute history (collector) to Yahoo's ~60
// days, so every test gets longer as days are collected; injected loaders (tests) are used as-is.
export const withStore = (loadCandles) => (loadCandles === candles ? (s, o) => historyCandles(s, o) : loadCandles);

/** Per session: % move from the previous session's close to 09:30, and over 09:15–09:45. */
function sessionInfo(bars) {
  const m = new Map();
  let prevClose = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = day(b);
    let x = m.get(d);
    if (!x) {
      x = { prevClose, open: b.open };
      m.set(d, x);
    }
    const t = hhmm(b);
    if (t === '09:25' && x.prevClose) x.gapPct = (b.close / x.prevClose - 1) * 100;
    if (t === '09:40') x.first30Pct = (b.close / x.open - 1) * 100;
    if (i + 1 === bars.length || day(bars[i + 1]) !== d) prevClose = b.close;
  }
  return m;
}

/** Account-level: at most `maxPerDay` trades across the stocks (earliest signals first). */
export function accountTrades(trades, maxPerDay = RULES.maxPerDay) {
  const byDay = new Map();
  for (const t of [...trades].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const list = byDay.get(t.date) || [];
    if (list.length < maxPerDay) list.push(t);
    byDay.set(t.date, list);
  }
  return [...byDay.values()].flat();
}

/** Summary stats with a date-clustered t-stat on net ₹ per trade. */
export function summarise(trades) {
  if (!trades.length) return { trades: 0 };
  const per = new Map();
  for (const t of trades) per.set(t.date, (per.get(t.date) || 0) + t.net);
  const daily = [...per.values()];
  const n = daily.length;
  const m = daily.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const v of daily) {
    eq += v;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  return {
    trades: trades.length,
    days: n,
    winRate: wins.length / trades.length,
    avgNetRs: sum(trades, (t) => t.net) / trades.length,
    avgGrossRs: sum(trades, (t) => t.gross) / trades.length,
    avgChargesRs: sum(trades, (t) => t.charges) / trades.length,
    avgNetR: sum(trades, (t) => t.rNet) / trades.length,
    totalNetRs: sum(trades, (t) => t.net),
    profitFactor: losses.length ? sum(wins, (t) => t.net) / Math.abs(sum(losses, (t) => t.net)) : null,
    maxDrawdownRs: dd,
    tStat: sd > 0 ? m / (sd / Math.sqrt(n)) : null,
    exits: Object.fromEntries(['target', 'stop', 'trail', '15:00', 'close'].map((k) => [k, trades.filter((t) => t.reason === k).length])),
  };
}

function verdict(all, first, second, wide) {
  if (!all.trades || all.trades < 20) return 'not enough trades to judge';
  const ok = all.avgNetRs > 0 && all.tStat >= 2 && first.avgNetRs > 0 && second.avgNetRs > 0 && wide?.avgNetRs > 0;
  return ok ? 'works on this sample (net profit, t ≥ 2, both halves, wider list too) — paper-test it forward before real money'
    : all.avgNetRs > 0 ? 'net positive but not reliable (fails t ≥ 2, a half, or the wider list)'
      : 'loses money after costs';
}

export async function vwapPullbackTest({ loadCandles = candles, stocks = VIDEO_STOCKS, wide = EVAL_UNIVERSE } = {}) {
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400; // Yahoo keeps ~60 days of 5-minute bars
  const get = withStore(loadCandles);
  const load = async (list) => (await mapLimit(list, 4, async (s) => {
    try {
      const rows = (await get(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
      return rows.length > 500 ? { s, rows } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const run = (data, rules) => data.flatMap(({ s, rows }) => backtestStock(s, rows, rules));
  const main = await load(stocks);
  const wider = await load(wide.filter((s) => !stocks.includes(s)));
  const base = run(main, RULES);
  const dates = [...new Set(base.map((t) => t.date))].sort();
  const mid = dates[dates.length >> 1];
  const acct = accountTrades(base);
  const all = summarise(base);
  const first = summarise(base.filter((t) => t.date < mid));
  const second = summarise(base.filter((t) => t.date >= mid));
  const wideAll = summarise(run(wider, RULES));
  const sensitivity = {};
  for (const rr of [1, 2, 3, 4]) {
    const tr = run(main, { ...RULES, rr });
    sensitivity[`1:${rr}`] = summarise(tr);
  }
  const noCosts = summarise(base.map((t) => ({ ...t, net: t.gross, rNet: t.rGross })));
  // other readings of the video's loose wording (reported, not used for the verdict)
  const variants = {
    'EMA 20 instead of SMA': summarise(run(main, { ...RULES, maType: 'ema' })),
    'stop beyond pullback candle': summarise(run(main, { ...RULES, stopMode: 'swing' })),
    'EMA + candle stop': summarise(run(main, { ...RULES, maType: 'ema', stopMode: 'swing' })),
  };
  const sessions = new Set(main.flatMap(({ rows }) => rows.map(day))).size;
  return {
    at: new Date().toISOString(),
    stocks: main.map((x) => x.s),
    sessions,
    from: dates[0],
    to: dates[dates.length - 1],
    rules: RULES,
    perTrade: all,
    firstHalf: first,
    secondHalf: second,
    account2PerDay: summarise(acct),
    beforeCosts: noCosts,
    sensitivity,
    variants,
    widerList: { stocks: wider.length, ...wideAll },
    perStock: Object.fromEntries(main.map(({ s }) => [s, summarise(base.filter((t) => t.symbol === s))])),
    recentTrades: base.slice(-15).map((t) => ({ ...t })),
    verdict: verdict(all, first, second, wideAll),
    note: 'Only ~60 days of 5-minute history are available for free, so this is a short sample. Fills: next candle open + 0.03% slippage; if stop and target fall inside one candle the stop is assumed first. Research / paper only.',
  };
}

// ---------------------------------------------------- improvement test ---

export const FILTERS = {
  vwapSlope: { vwapSlope: true },
  marketAlign: { marketAlign: true },
  dailyTrend: { dailyTrend: true },
  window945to12: { firstEntry: '09:45', lastEntry: '12:00' },
  stop3atr: { stopAtr: 3 },
  breakeven: { breakeven: true },
  // round 2 (added 12 Oct 2026)
  limitEntry: { limitEntry: true },
  trailMa: { trailMa: true },
  volumeConfirm: { volumeConfirm: true },
  morningGap: { morningGapPct: 0.5 },
  trendDay: { trendDayPct: 0.5 },
};
export const ROUND2 = ['limitEntry', 'trailMa', 'volumeConfirm', 'morningGap', 'trendDay'];

/** NIFTY 5-minute indicators keyed by candle time. */
export async function niftyContext(loadCandles, p1) {
  try {
    const rows = (await loadCandles('^NSEI', { period1: p1, interval: '5m' })).filter((r) => r.close > 0);
    return new Map(indicators(rows).map((b) => [b.date, { close: b.close, ma: b.ma, vwap: b.vwap }]));
  } catch {
    return new Map();
  }
}

/** Stock vs its 20-day average at the PREVIOUS daily close (known before the session opens). */
export async function dailyContext(loadCandles, sym) {
  try {
    const rows = (await loadCandles(sym, { range: '1y', interval: '1d' })).filter((r) => r.close > 0);
    return dailyTrendLookup(rows);
  } catch {
    return new Map();
  }
}

/**
 * Daily trend for any session date d: the last daily close BEFORE d vs the
 * average of the 20 closes up to it. Works even when the data source is
 * missing the daily bar for d itself (Yahoo sometimes drops a day).
 */
export function dailyTrendLookup(rows) {
  const dates = rows.map((r) => r.date);
  const cache = new Map();
  return {
    get(d) {
      if (cache.has(d)) return cache.get(d);
      let lo = 0;
      let hi = dates.length - 1;
      let last = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] < d) {
          last = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      let out;
      if (last >= 20) {
        const prev = rows.slice(last - 19, last + 1).map((r) => r.close);
        out = { aboveAvg20: rows[last].close > prev.reduce((a, b) => a + b, 0) / 20 };
      }
      cache.set(d, out);
      return out;
    },
    has(d) {
      return this.get(d) !== undefined;
    },
  };
}

/**
 * Pick the best of the original rules, each filter, and each pair of filters
 * on the FIRST half of the sessions (video stocks only); judge the pick on the
 * second half and on the wider stock list. Adopted only if it is profitable
 * after costs in both out-of-sample sets with a date-clustered t ≥ 2 overall.
 */
export async function improveTest({ loadCandles = candles, stocks = VIDEO_STOCKS, wide = EVAL_UNIVERSE } = {}) {
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400;
  const get = withStore(loadCandles);
  const nifty = await niftyContext(get, p1);
  const load = async (list) => (await mapLimit(list, 4, async (s) => {
    try {
      const rows = (await get(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
      return rows.length > 500 ? { s, rows, daily: await dailyContext(loadCandles, s) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const main = await load(stocks);
  const wider = await load(wide.filter((x) => !stocks.includes(x)));
  const names = Object.keys(FILTERS);
  const variants = [{ name: 'video rules', rules: RULES }];
  for (const a of names) variants.push({ name: a, rules: { ...RULES, ...FILTERS[a] } });
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) variants.push({ name: `${names[i]} + ${names[j]}`, rules: { ...RULES, ...FILTERS[names[i]], ...FILTERS[names[j]] } });
  const run = (data, rules) => data.flatMap(({ s, rows, daily }) => backtestStock(s, rows, rules, { nifty, daily }));
  const dates = [...new Set(main.flatMap(({ rows }) => rows.map(day)))].sort();
  const mid = dates[dates.length >> 1];
  const rows = variants.map((v) => {
    const tr = run(main, v.rules);
    const train = tr.filter((t) => t.date < mid);
    return { name: v.name, rules: v.rules, train: summarise(train), test: summarise(tr.filter((t) => t.date >= mid)) };
  });
  // choose on the training half: highest total net, needing ≥ 15 trades
  const eligible = rows.filter((r) => r.train.trades >= 15);
  const pick = eligible.sort((a, b) => b.train.totalNetRs - a.train.totalNetRs)[0];
  const wideTest = run(wider, pick.rules).filter((t) => t.date >= mid);
  const vidTest = run(main, pick.rules).filter((t) => t.date >= mid);
  const combined = summarise([...vidTest, ...wideTest]);
  const W = summarise(wideTest);
  const V = summarise(vidTest);
  const adopt = V.avgNetRs > 0 && W.avgNetRs > 0 && combined.tStat >= 2;
  // round 2: each new idea on its own and on top of the paper-tracked "improved"
  // version, read on the unseen half — video stocks AND the other stocks
  const base2 = { ...RULES, ...FILTERS.dailyTrend, ...FILTERS.stop3atr };
  const read = (rules) => ({
    video: summarise(run(main, rules).filter((t) => t.date >= mid)),
    others: summarise(run(wider, rules).filter((t) => t.date >= mid)),
  });
  const round2 = [{ name: 'video rules', ...read(RULES) }, { name: 'improved (daily trend + 3×ATR)', ...read(base2) }];
  for (const k of ROUND2) {
    round2.push({ name: k, ...read({ ...RULES, ...FILTERS[k] }) });
    round2.push({ name: `improved + ${k}`, ...read({ ...base2, ...FILTERS[k] }) });
  }
  const allNew = { ...base2, ...Object.assign({}, ...ROUND2.filter((k) => k !== 'morningGap').map((k) => FILTERS[k])) };
  round2.push({ name: 'improved + all except morningGap', ...read(allNew) });
  const sessions = dates.length;
  return {
    at: new Date().toISOString(),
    sessions,
    from: dates[0],
    to: dates[dates.length - 1],
    round2,
    splitDate: mid,
    variants: rows.map((r) => ({ name: r.name, train: r.train, test: r.test })),
    pick: { name: pick.name, train: pick.train, testVideoStocks: V, testWiderStocks: W, testCombined: combined, adopt },
    rule: 'The best version is chosen on the first half of the sessions (video stocks only), then judged on the second half and on 16 other stocks; adopted only if both are profitable after costs with a date-clustered t ≥ 2 combined. With ~20 sessions per half, the sample is small.',
  };
}

// ------------------------------------------------- forward paper record ---

const PAPER = () => process.env.VWAP_PAPER_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'vwap-paper.json');
const istNow = (d = new Date()) => {
  const t = new Date(d.getTime() + 19800_000);
  return { date: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
};

export function loadPaper() {
  try {
    return existsSync(PAPER()) ? JSON.parse(readFileSync(PAPER(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * After the close, apply the same rules to the latest sessions and record the
 * trades the strategy would have taken (account limit applied), from the
 * paper start date on. The rules act candle by candle on completed candles,
 * so this equals running live with orders at the next candle's open.
 */
// Paper-tracked side by side: the video's rules, and the best variant from the
// improvement test (daily trend + 3×ATR stop — promising, NOT proven).
export const PAPER_VARIANTS = {
  video: { label: 'Video rules', rules: RULES },
  improved: { label: 'Improved: daily trend + 3×ATR stop (unproven)', rules: { ...RULES, ...FILTERS.dailyTrend, ...FILTERS.stop3atr } },
  // round 2's best (12 Oct 2026): scan 20 stocks each morning, trade only those that already
  // moved ≥ 0.5% from yesterday's close by 09:30, in that direction. Break-even in the test
  // (+₹40/trade, t 0.23) — tracked to see if it holds, NOT proven.
  scanner: { label: 'Morning scanner: 20 stocks, gap ≥ 0.5% + daily trend + 3×ATR (unproven)', rules: { ...RULES, ...FILTERS.dailyTrend, ...FILTERS.stop3atr, ...FILTERS.morningGap }, stocks: [...new Set([...VIDEO_STOCKS, ...EVAL_UNIVERSE])] },
};

export async function paperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadPaper() || { startedAt: istNow(now).date, stocks: VIDEO_STOCKS, trades: [] };
  st.variants = Object.fromEntries(Object.entries(PAPER_VARIANTS).map(([k, v]) => [k, { label: v.label, rules: v.rules }]));
  const t = istNow(now);
  const lastComplete = t.mins >= 15 * 60 + 35 ? t.date : null; // today counts only after the close
  const p1 = Math.floor(now.getTime() / 1000) - 8 * 86400;
  const data = [];
  const symbols = [...new Set([...st.stocks, ...Object.values(PAPER_VARIANTS).flatMap((v) => v.stocks || [])])];
  for (const s of symbols) {
    try {
      const rows = (await loadCandles(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
      data.push({ s, rows, daily: await dailyContext(loadCandles, s) });
    } catch {
      /* skip a stock with no data today */
    }
  }
  let added = 0;
  for (const [key, v] of Object.entries(PAPER_VARIANTS)) {
    const list = v.stocks || st.stocks;
    const all = data.filter((x) => list.includes(x.s)).flatMap(({ s, rows, daily }) => backtestStock(s, rows, v.rules, { daily }));
    const mine = st.trades.filter((x) => (x.variant || 'video') === key);
    const have = new Set(mine.map((x) => `${x.symbol}|${x.date}`));
    const fresh = accountTrades(all, v.rules.maxPerDay)
      .filter((x) => x.date >= st.startedAt && (x.date < t.date || x.date === lastComplete) && !have.has(`${x.symbol}|${x.date}`));
    for (const x of fresh) {
      const already = st.trades.filter((y) => (y.variant || 'video') === key && y.date === x.date).length;
      if (already < v.rules.maxPerDay) {
        st.trades.push({ ...x, variant: key, seenLive: seenLiveFor({ ...x, variant: key }) });
        added++;
      }
    }
  }
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { added, ...paperSummary(st) };
}

// ------------------------------------------------------------ your size ---

/** Validate a capital / risk-% choice → { capital, riskPct, riskRs } (null = use the standard ₹1 lakh / 1%). */
export function parseSizing(capital, riskPct) {
  if (capital == null && riskPct == null) return null;
  const c = Number(capital ?? RULES.capital);
  const r = Number(riskPct ?? 1);
  if (!(c >= 10000 && c <= 1e9)) throw badRequest('Capital must be between ₹10,000 and ₹100 crore.');
  if (!(r > 0 && r <= 5)) throw badRequest('Risk per trade must be between 0.1% and 5% of capital.');
  return { capital: c, riskPct: r, riskRs: (c * r) / 100 };
}

/**
 * Position size for one trade: risk a fixed % of capital between entry and
 * stop, capped by intraday leverage. Includes the round-trip charges at the
 * stop and at a 1:2 target, so "loss at stop" is what you'd really lose.
 */
export function sizeTrade({ entry, stop, capital = RULES.capital, riskPct = 1, leverage = RULES.leverage, rr = RULES.rr }) {
  entry = Number(entry);
  stop = Number(stop);
  if (!(entry > 0) || !(stop > 0) || entry === stop) throw badRequest('Enter an entry price and a different stop price.');
  const { riskRs } = parseSizing(capital, riskPct);
  const side = stop < entry ? 'long' : 'short';
  const perShare = Math.abs(entry - stop);
  const byRisk = Math.floor(riskRs / perShare);
  const byLeverage = Math.floor((capital * leverage) / entry);
  const qty = Math.max(0, Math.min(byRisk, byLeverage));
  const target = side === 'long' ? entry + rr * perShare : entry - rr * perShare;
  const lossAtStop = qty ? perShare * qty + roundTripCharges(entry, stop, qty, side) : 0;
  const gainAtTarget = qty ? rr * perShare * qty - roundTripCharges(entry, target, qty, side) : 0;
  return {
    side, qty, riskRs, perShareRisk: perShare, positionValue: qty * entry, marginNeeded: (qty * entry) / leverage,
    cappedByLeverage: byLeverage < byRisk, target, lossAtStop, gainAtTarget,
    note: qty ? null : 'Risk too small for even one share at this stop distance.',
  };
}

/** Re-size recorded / simulated trades to your risk per trade (same entries, stops and exits; charges recomputed). */
export function resizeTrades(trades, { riskRs, capital }, leverage = RULES.leverage) {
  return trades.map((t) => {
    const perShare = Math.abs(t.entry - t.stop);
    if (!(perShare > 0)) return t;
    const qty = Math.max(1, Math.floor(Math.min(riskRs / perShare, (capital * leverage) / t.entry)));
    const gross = (t.side === 'long' ? t.exit - t.entry : t.entry - t.exit) * qty;
    const charges = roundTripCharges(t.entry, t.exit, qty, t.side);
    return { ...t, qty, gross, charges, net: gross - charges };
  });
}

// "When can we trust it?": a fixed finish line, set before the results come in.
export const TRUST = { trades: 100, days: 40, earlyStopTrades: 30 };

/** Verdict on a paper record so far (one version). */
export function trustMeter(sum) {
  const n = sum.trades || 0;
  const days = sum.days || 0;
  const progress = Math.min(1, n / TRUST.trades, days / TRUST.days);
  const base = { trades: n, days, needTrades: TRUST.trades, needDays: TRUST.days, progress, avgNetRs: sum.avgNetRs ?? null, tStat: sum.tStat ?? null };
  if (n >= TRUST.earlyStopTrades && sum.tStat != null && sum.tStat <= -2) return { ...base, level: 'fail', verdict: 'Losing clearly after costs — this version does not work. Stop tracking it.' };
  if (progress < 1) {
    const ahead = n ? (sum.avgNetRs > 0 ? 'ahead of' : 'behind') : null;
    return { ...base, level: 'early', verdict: n ? `Too early: ${n} of ${TRUST.trades} trades, ${days} of ${TRUST.days} days. So far ${ahead} break-even after costs — luck can't be ruled out yet.` : 'No trades yet.' };
  }
  if (sum.avgNetRs > 0 && sum.tStat >= 2) return { ...base, level: 'pass', verdict: 'Profitable after costs with a reliable margin (t ≥ 2) over enough trades. Next step: a tiny real size, still tracked.' };
  if (sum.avgNetRs <= 0) return { ...base, level: 'fail', verdict: 'Enough trades, and it lost money after costs — it does not work.' };
  return { ...base, level: 'unclear', verdict: 'Enough trades, slightly profitable but not reliably (t < 2) — keep paper trading, no real money.' };
}

/** One line per version for a session's paper trades, e.g. for the after-close alert. */
export function closeSummary(st, date) {
  return Object.entries(PAPER_VARIANTS).map(([k, v]) => {
    const tr = (st?.trades || []).filter((x) => (x.variant || 'video') === k && x.date === date);
    const short = { video: 'Video rules', improved: 'Improved', scanner: 'Scanner' }[k] || v.label;
    if (!tr.length) return `${short}: no trades`;
    const net = tr.reduce((a, x) => a + x.net, 0);
    return `${short}: ${tr.length} trade${tr.length > 1 ? 's' : ''} ${net >= 0 ? '+' : '−'}₹${Math.abs(Math.round(net)).toLocaleString('en-IN')} (${tr.map((x) => `${x.symbol.replace('.NS', '')} ${x.reason}`).join(', ')})`;
  });
}

/**
 * Live view of today's session (or the latest one): each stock's position vs
 * its 20 MA and VWAP, and the trades each paper version has taken so far,
 * valued at the latest candle (after charges, as if closed now).
 */
export async function todaySignals({ loadCandles = candles, now = new Date(), sizing = null, oddsLookup = null } = {}) {
  const t = istNow(now);
  const p1 = Math.floor(now.getTime() / 1000) - 8 * 86400;
  const symbols = [...new Set([...VIDEO_STOCKS, ...Object.values(PAPER_VARIANTS).flatMap((v) => v.stocks || [])])];
  const data = (await mapLimit(symbols, 4, async (s) => {
    try {
      // only whole 5-minute candles: Yahoo's still-forming candle (e.g. 12:07) is dropped
      const rows = (await loadCandles(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0 && Number(hhmm(r).slice(3)) % 5 === 0);
      return rows.length ? { s, rows, daily: await dailyContext(loadCandles, s) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  if (!data.length) return { at: now.toISOString(), date: null, stocks: [], variants: {}, note: 'No 5-minute data available right now.' };
  const date = data.map(({ rows }) => day(rows[rows.length - 1])).sort().pop();
  const live = isTradingDay(t.date) && date === t.date && t.mins >= 555 && t.mins < 930;
  const stocks = data.map(({ s, rows, daily }) => {
    const bars = indicators(rows, RULES).filter((b) => day(b) === date);
    const b = bars[bars.length - 1];
    if (!b) return null;
    const info = sessionInfo(indicators(rows, RULES)).get(date) || {};
    const trend = b.ma == null ? 'unknown' : b.close > b.ma && b.close > b.vwap ? 'up' : b.close < b.ma && b.close < b.vwap ? 'down' : 'mixed';
    const dt = daily.get(date);
    return {
      symbol: s, video: VIDEO_STOCKS.includes(s), time: hhmm(b), price: b.close, ma: b.ma ?? null, vwap: b.vwap, trend,
      dailyTrend: dt ? (dt.aboveAvg20 ? 'up' : 'down') : null, gapPct: info.gapPct ?? null,
      inPlay: info.gapPct != null && Math.abs(info.gapPct) >= FILTERS.morningGap.morningGapPct,
    };
  }).filter(Boolean);
  const variants = {};
  for (const [k, v] of Object.entries(PAPER_VARIANTS)) {
    const list = v.stocks || VIDEO_STOCKS;
    const rules = sizing ? { ...v.rules, riskRs: sizing.riskRs, capital: sizing.capital } : v.rules;
    const all = data.filter((x) => list.includes(x.s)).flatMap(({ s, rows, daily }) => backtestStock(s, rows, rules, { daily }));
    const trades = accountTrades(all, v.rules.maxPerDay).filter((x) => x.date === date)
      .map((x) => ({ ...x, open: x.reason === 'close' && live, odds: oddsLookup ? oddsLookup(x) : null }));
    variants[k] = { label: v.label, trades, netRs: trades.reduce((a, x) => a + x.net, 0), slotsLeft: Math.max(0, v.rules.maxPerDay - trades.length), stocks: list.length };
  }
  return {
    at: now.toISOString(), date, live,
    lastBar: stocks.map((x) => x.time).sort().pop(),
    newEntriesUntil: RULES.lastEntry, exitAt: RULES.exitAt,
    stocks, variants, sizing: sizing || { capital: RULES.capital, riskPct: 1, riskRs: RULES.riskRs, standard: true },
    note: 'Same rules as the paper record, on the 5-minute candles so far. Open trades are valued at the latest candle after charges (as if closed now); they end at the stop, the target or 15:00. The official record is written after the close. Paper only — not a signal to trade.',
  };
}

// ---------------------------------------------- seen live vs recorded ---
// Yahoo sometimes corrects intraday candles after the close, so a trade in the
// after-close record may never have been visible to someone watching live.
// During the session the server snapshots today's signals every 5 minutes;
// each recorded trade is then marked seenLive true / false (null = no snapshots that day).
const SEEN = () => process.env.VWAP_SEEN_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'vwap-live-seen.json');
const seenKey = (date, variant, t) => `${date}|${variant}|${t.symbol}|${t.side}`;
export function loadSeen() {
  try {
    return existsSync(SEEN()) ? JSON.parse(readFileSync(SEEN(), 'utf8')) : { days: {}, keys: {} };
  } catch {
    return { days: {}, keys: {} };
  }
}
/** Record the trades visible in a live snapshot (from todaySignals). */
export function noteLiveSeen(sig, now = new Date()) {
  if (!sig?.live || !sig.date) return 0;
  const st = loadSeen();
  st.days[sig.date] = (st.days[sig.date] || 0) + 1;
  let added = 0;
  for (const [k, v] of Object.entries(sig.variants || {})) {
    for (const t of v.trades || []) {
      const key = seenKey(sig.date, k, t);
      if (!st.keys[key]) {
        st.keys[key] = { firstSeen: now.toISOString(), time: t.time };
        added++;
      }
    }
  }
  const cutoff = new Date(now.getTime() - 120 * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(st.days)) if (d < cutoff) delete st.days[d];
  for (const key of Object.keys(st.keys)) if (key.slice(0, 10) < cutoff) delete st.keys[key];
  writeJsonAtomic(SEEN(), st);
  return added;
}
/** true = visible live, false = only after the close, null = no live snapshots that day. */
export function seenLiveFor(t, seen = loadSeen()) {
  if (!seen.days?.[t.date]) return null;
  return !!seen.keys?.[seenKey(t.date, t.variant || 'video', t)];
}

export function paperSummary(st = loadPaper(), sizing = null) {
  if (!st) return { startedAt: null, summary: { trades: 0 }, byVariant: {}, trades: [] };
  const byVariant = Object.fromEntries(Object.entries(PAPER_VARIANTS).map(([k, v]) => {
    const mine = st.trades.filter((x) => (x.variant || 'video') === k);
    const sum = summarise(mine);
    // the record is kept at the standard ₹1,000 risk; "yours" re-sizes it to your capital / risk %
    const checked = mine.filter((x) => x.seenLive != null);
    const live = { checked: checked.length, notSeen: checked.filter((x) => x.seenLive === false).length, netNotSeen: checked.filter((x) => x.seenLive === false).reduce((a, x) => a + x.net, 0) };
    return [k, { label: v.label, ...sum, trust: trustMeter(sum), live, ...(sizing ? { yours: summarise(resizeTrades(mine, sizing)) } : {}) }];
  }));
  return { startedAt: st.startedAt, updatedAt: st.updatedAt, summary: byVariant.video, byVariant, trades: st.trades.slice(-20).reverse() };
}

export function loadImprove() {
  try {
    const f = join(dirname(SAVED()), 'vwap-improve.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function saveVwapPullback(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadVwapPullback() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--improve')) {
  improveTest()
    .then((r) => {
      writeJsonAtomic(join(dirname(SAVED()), 'vwap-improve.json'), r);
      const rs = (v) => (v == null ? '–' : `${v >= 0 ? '' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
      console.log(`\nIMPROVEMENT TEST · split ${r.splitDate} (train before, test after)`);
      console.log('version'.padEnd(36), 'TRAIN trades  win   avg net   total  |  TEST trades  win   avg net   total');
      for (const v of [...r.variants].sort((a, b) => b.train.totalNetRs - a.train.totalNetRs)) {
        const f = (x) => `${String(x.trades).padStart(5)} ${x.winRate != null ? String(Math.round(x.winRate * 100)).padStart(4) + '%' : '   – '} ${rs(x.avgNetRs).padStart(8)} ${rs(x.totalNetRs).padStart(8)}`;
        console.log(v.name.padEnd(36), f(v.train), ' | ', f(v.test));
      }
      const p = r.pick;
      console.log(`\nPicked on the training half: ${p.name}`);
      console.log(`  test, video stocks: ${p.testVideoStocks.trades} trades · avg net ${rs(p.testVideoStocks.avgNetRs)} · total ${rs(p.testVideoStocks.totalNetRs)}`);
      console.log(`  test, 16 other stocks: ${p.testWiderStocks.trades} trades · avg net ${rs(p.testWiderStocks.avgNetRs)} · total ${rs(p.testWiderStocks.totalNetRs)}`);
      console.log(`  combined t ${p.testCombined.tStat?.toFixed(2)} → ${p.adopt ? 'ADOPTED' : 'not adopted'}`);
      console.log(r.rule);
      if (r.round2) {
        console.log(`\nROUND 2 · unseen half only (${r.splitDate} →) · ${r.sessions} sessions in all`);
        console.log('version'.padEnd(40), 'VIDEO STOCKS trades  win  avg net  |  OTHER STOCKS trades  win  avg net');
        const g = (x) => `${String(x.trades).padStart(6)} ${x.winRate != null ? String(Math.round(x.winRate * 100)).padStart(4) + '%' : '   – '} ${rs(x.avgNetRs).padStart(8)}`;
        for (const v of r.round2) console.log(v.name.padEnd(40), g(v.video), '              |', g(v.others));
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--paper')) {
  paperUpdate()
    .then(async (r) => {
      console.log(`VWAP pullback paper: +${r.added} trades · since ${r.startedAt} · ${r.summary.trades} trades · total net ₹${Math.round(r.summary.totalNetRs || 0)}`);
      const t = istNow();
      const lines = closeSummary(loadPaper(), t.date);
      console.log(lines.join('\n'));
      if (process.argv.includes('--notify') && isTradingDay(t.date) && t.mins >= 15 * 60 + 35) {
        const { notify } = await import('./monitor.mjs');
        notify(`Strategy paper · ${t.date}`, lines.join(' · '));
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  vwapPullbackTest()
    .then((r) => {
      saveVwapPullback(r);
      const rs = (v) => (v == null ? '–' : `${v >= 0 ? '' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
      const line = (n, x) => console.log(`${n.padEnd(30)} trades ${String(x.trades).padStart(4)} · win ${x.winRate != null ? (x.winRate * 100).toFixed(0) : '–'}% · avg net ${rs(x.avgNetRs)} (gross ${rs(x.avgGrossRs)}, charges ${rs(x.avgChargesRs)}) · ${x.avgNetR?.toFixed(2)} R · total ${rs(x.totalNetRs)} · PF ${x.profitFactor?.toFixed(2)} · t ${x.tStat?.toFixed(2)} · max DD ${rs(x.maxDrawdownRs)}`);
      console.log(`\nVWAP + 20-MA PULLBACK · ${r.stocks.join(', ')} · ${r.sessions} sessions · ${r.from} → ${r.to}`);
      line('All trades (1:2)', r.perTrade);
      line('  first half', r.firstHalf);
      line('  second half', r.secondHalf);
      line('Account (max 2 trades/day)', r.account2PerDay);
      line('Same trades, before costs', r.beforeCosts);
      for (const [k, v] of Object.entries(r.sensitivity)) line(`Target ${k}`, v);
      for (const [k, v] of Object.entries(r.variants)) line(k, v);
      line(`Wider list (${r.widerList.stocks} stocks)`, r.widerList);
      for (const [s, v] of Object.entries(r.perStock)) line(`  ${s}`, v);
      console.log(`Exits: ${JSON.stringify(r.perTrade.exits)}`);
      console.log(`\nVerdict: ${r.verdict}\n${r.note}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
