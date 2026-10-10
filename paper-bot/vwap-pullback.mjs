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
import { EVAL_UNIVERSE } from './config.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';

const SAVED = () => process.env.VWAP_PULLBACK_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'vwap-pullback.json');
export const VIDEO_STOCKS = ['BAJAJFINSV.NS', 'TRENT.NS', 'TITAN.NS', 'MARUTI.NS'];
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
    const nx = bars[i + 1];
    if (day(nx) !== d) continue;
    const slip = rules.slippagePct / 100;
    const entry = side === 'long' ? nx.open * (1 + slip) : nx.open * (1 - slip);
    // stop: 2 × ATR (default) or just beyond the pullback candle ("above the pullback area")
    const risk = rules.stopMode === 'swing'
      ? Math.max(0.25 * b.atr, side === 'long' ? entry - (b.low - 0.1 * b.atr) : (b.high + 0.1 * b.atr) - entry)
      : rules.stopAtr * b.atr;
    let stop = side === 'long' ? entry - risk : entry + risk;
    const target = side === 'long' ? entry + rules.rr * risk : entry - rules.rr * risk;
    const qty = Math.max(1, Math.floor(Math.min(rules.riskRs / risk, (rules.capital * rules.leverage) / entry)));
    // walk forward from the entry candle until stop / target / 15:00
    let exit = null;
    let reason = null;
    for (let j = i + 1; j < bars.length && day(bars[j]) === d; j++) {
      const c = bars[j];
      const hitStop = side === 'long' ? c.low <= stop : c.high >= stop;
      const hitTarget = side === 'long' ? c.high >= target : c.low <= target;
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
    trades.push({ symbol, date: d, time: hdr(nx), side, entry, stop, target, exit: exitFill, qty, reason, gross, charges, net: gross - charges, rNet: (gross - charges) / (risk * qty), rGross: gross / (risk * qty) });
    tradedToday = d;
  }
  return trades;
}
const hdr = (r) => hhmm(r);

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
    exits: Object.fromEntries(['target', 'stop', '15:00', 'close'].map((k) => [k, trades.filter((t) => t.reason === k).length])),
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
  const load = async (list) => (await mapLimit(list, 4, async (s) => {
    try {
      const rows = (await loadCandles(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
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
};

/** NIFTY 5-minute indicators keyed by candle time. */
async function niftyContext(loadCandles, p1) {
  try {
    const rows = (await loadCandles('^NSEI', { period1: p1, interval: '5m' })).filter((r) => r.close > 0);
    return new Map(indicators(rows).map((b) => [b.date, { close: b.close, ma: b.ma, vwap: b.vwap }]));
  } catch {
    return new Map();
  }
}

/** Stock vs its 20-day average at the PREVIOUS daily close (known before the session opens). */
async function dailyContext(loadCandles, sym) {
  try {
    const rows = (await loadCandles(sym, { range: '1y', interval: '1d' })).filter((r) => r.close > 0);
    const m = new Map();
    for (let i = 21; i < rows.length; i++) {
      const prev = rows.slice(i - 20, i).map((r) => r.close);
      m.set(rows[i].date, { aboveAvg20: rows[i - 1].close > prev.reduce((a, b) => a + b, 0) / 20 });
    }
    return m;
  } catch {
    return new Map();
  }
}

/**
 * Pick the best of the original rules, each filter, and each pair of filters
 * on the FIRST half of the sessions (video stocks only); judge the pick on the
 * second half and on the wider stock list. Adopted only if it is profitable
 * after costs in both out-of-sample sets with a date-clustered t ≥ 2 overall.
 */
export async function improveTest({ loadCandles = candles, stocks = VIDEO_STOCKS, wide = EVAL_UNIVERSE } = {}) {
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400;
  const nifty = await niftyContext(loadCandles, p1);
  const load = async (list) => (await mapLimit(list, 4, async (s) => {
    try {
      const rows = (await loadCandles(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
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
  return {
    at: new Date().toISOString(),
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
};

export async function paperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadPaper() || { startedAt: istNow(now).date, stocks: VIDEO_STOCKS, trades: [] };
  st.variants = Object.fromEntries(Object.entries(PAPER_VARIANTS).map(([k, v]) => [k, { label: v.label, rules: v.rules }]));
  const t = istNow(now);
  const lastComplete = t.mins >= 15 * 60 + 35 ? t.date : null; // today counts only after the close
  const p1 = Math.floor(now.getTime() / 1000) - 8 * 86400;
  const data = [];
  for (const s of st.stocks) {
    try {
      const rows = (await loadCandles(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
      data.push({ s, rows, daily: await dailyContext(loadCandles, s) });
    } catch {
      /* skip a stock with no data today */
    }
  }
  let added = 0;
  for (const [key, v] of Object.entries(PAPER_VARIANTS)) {
    const all = data.flatMap(({ s, rows, daily }) => backtestStock(s, rows, v.rules, { daily }));
    const mine = st.trades.filter((x) => (x.variant || 'video') === key);
    const have = new Set(mine.map((x) => `${x.symbol}|${x.date}`));
    const fresh = accountTrades(all, v.rules.maxPerDay)
      .filter((x) => x.date >= st.startedAt && (x.date < t.date || x.date === lastComplete) && !have.has(`${x.symbol}|${x.date}`));
    for (const x of fresh) {
      const already = st.trades.filter((y) => (y.variant || 'video') === key && y.date === x.date).length;
      if (already < v.rules.maxPerDay) {
        st.trades.push({ ...x, variant: key });
        added++;
      }
    }
  }
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { added, ...paperSummary(st) };
}

export function paperSummary(st = loadPaper()) {
  if (!st) return { startedAt: null, summary: { trades: 0 }, byVariant: {}, trades: [] };
  const byVariant = Object.fromEntries(Object.entries(PAPER_VARIANTS).map(([k, v]) => [k, { label: v.label, ...summarise(st.trades.filter((x) => (x.variant || 'video') === k)) }]));
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
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--paper')) {
  paperUpdate()
    .then((r) => console.log(`VWAP pullback paper: +${r.added} trades · since ${r.startedAt} · ${r.summary.trades} trades · total net ₹${Math.round(r.summary.totalNetRs || 0)}`))
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
