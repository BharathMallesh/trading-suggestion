#!/usr/bin/env node
// Strong-stock swing strategy (library + CLI), from a trader interview: trade
// only structurally strong stocks, enter on daily-chart setups, risk a fixed
// amount below an ATR-padded pivot low, and let winners run with a Chandelier
// (ATR) trailing stop. "90% of the profit comes from 10% of the trades."
//
// Rules (fixed before testing):
//   Strong stock  the all-time high (since data start) was made within the last
//                 12 months and the price is within 30% of it — "the latest major
//                 turning point is an all-time high" (SBI yes, Yes Bank no)
//   Setup A       oversold base breakout: the WEEKLY RSI(14) was ≤ 35 within the
//                 last 15 sessions; the 20-day low was made at least 5 sessions
//                 ago (the fall stopped for ~a week); buy when a close breaks
//                 above the highest high since that low (the first breakout)
//   Setup B       flag breakout: a pole (close up ≥ 4 ATR within ≤ 10 sessions),
//                 then a 3–15 session flag that stays below the pole top and
//                 holds the upper half of the pole; buy when a close breaks
//                 above the pole top
//   Entry         next session's open (skipped if it opens below the stop)
//   Stop          1 ATR(14) below the base / flag low
//   Exit          Chandelier: highest high since entry − 3 ATR (never below the
//                 initial stop); out at the next open after a close below it.
//                 No fixed target — limited downside, open-ended upside
//   Costs         delivery: STT, stamp, exchange, GST, DP + 0.1% slippage a side
//   Sizing        1% of equity risked per trade, at most 10 open positions and
//                 20% of equity in any one (portfolio test)
// Honest caveats: the universe is TODAY's NIFTY 200 (survivorship bias — stocks
// that collapsed and left the index are missing, which flatters a "strong stock"
// strategy); chart patterns are approximated by rules.
// Research / paper only — not investment advice.
//
//   node paper-bot/ath-swing.mjs             # backtest, save, show
//   node paper-bot/ath-swing.mjs --paper     # update the forward paper record

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { loadIndexList } from './ranking.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.ATH_SWING_PATH || join(HERE, 'data', 'ath-swing.json');
const PAPER = () => process.env.ATH_PAPER_PATH || join(HERE, 'data', 'ath-paper.json');

export const RULES = {
  athWithinDays: 252, athMaxDrawdown: 0.30,
  rsiPeriod: 14, rsiOversold: 35, oversoldWithin: 15, baseLookback: 20, baseMinAge: 5,
  poleAtr: 4, poleMaxDays: 10, flagMin: 3, flagMax: 15, flagHoldHalf: 0.5,
  atr: 14, stopAtr: 1, chandelierAtr: 3, maxHold: 250, slippagePct: 0.1,
  riskPct: 1, maxOpen: 10, maxPositionPct: 20, capital: 1000000, cashRatePct: 6,
  marketFilter: false, // only trade while NIFTY is above its 200-day average (tested as an improvement)
  setups: 'both', // 'both' | 'flag' | 'base'
};

// ------------------------------------------------------------ indicators ---

/** ATR (simple average of true range), all-time high so far and its age, weekly RSI known at each day. */
export function indicators(rows, r = RULES) {
  const out = rows.map((x) => ({ ...x }));
  let ath = -Infinity;
  let athIdx = -1;
  const tr = [];
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    const pc = i ? out[i - 1].close : b.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
    if (tr.length > r.atr) tr.shift();
    b.atr = tr.length === r.atr ? tr.reduce((a, c) => a + c, 0) / r.atr : null;
    if (b.high > ath) {
      ath = b.high;
      athIdx = i;
    }
    b.ath = ath;
    b.athAge = i - athIdx;
  }
  // weekly RSI: weeks end on the last session of each ISO week; a day sees the RSI of the last COMPLETED week
  const weekKey = (d) => {
    const t = new Date(`${d}T00:00:00Z`);
    const day = (t.getUTCDay() + 6) % 7;
    return new Date(t.getTime() - day * 86400000).toISOString().slice(0, 10);
  };
  const weeks = [];
  for (let i = 0; i < out.length; i++) {
    const k = weekKey(out[i].date);
    if (!weeks.length || weeks[weeks.length - 1].k !== k) weeks.push({ k, close: out[i].close, last: i });
    else Object.assign(weeks[weeks.length - 1], { close: out[i].close, last: i });
  }
  let gain = 0;
  let loss = 0;
  const rsiAt = new Map(); // index of the week's last day → RSI
  for (let w = 1; w < weeks.length; w++) {
    const ch = weeks[w].close - weeks[w - 1].close;
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    if (w <= r.rsiPeriod) {
      gain += g / r.rsiPeriod;
      loss += l / r.rsiPeriod;
      if (w < r.rsiPeriod) continue;
    } else {
      gain = (gain * (r.rsiPeriod - 1) + g) / r.rsiPeriod;
      loss = (loss * (r.rsiPeriod - 1) + l) / r.rsiPeriod;
    }
    rsiAt.set(weeks[w].last, loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  let last = null;
  for (let i = 0; i < out.length; i++) {
    out[i].weeklyRsi = last; // completed weeks only
    if (rsiAt.has(i)) last = rsiAt.get(i);
  }
  return out;
}

/** Structurally strong on day i: recent all-time high and not far below it. */
export const isStrong = (b, r = RULES) => b.athAge <= r.athWithinDays && b.close >= b.ath * (1 - r.athMaxDrawdown);

/** NIFTY above its 200-day average on each date (known at that day's close). */
export function marketMap(niftyRows) {
  const m = new Map();
  let sum = 0;
  for (let i = 0; i < niftyRows.length; i++) {
    sum += niftyRows[i].close;
    if (i >= 200) sum -= niftyRows[i - 200].close;
    if (i >= 199) m.set(niftyRows[i].date, niftyRows[i].close > sum / 200);
  }
  return m;
}

/** Setup on day i (signal at its close), or null. */
export function setupAt(bars, i, r = RULES, ctx = {}) {
  const b = bars[i];
  if (!b.atr || !isStrong(b, r)) return null;
  if (r.marketFilter && ctx.market && !ctx.market.get(b.date)) return null; // NIFTY below its 200-day average
  const allowBase = r.setups !== 'flag';
  const allowFlag = r.setups !== 'base';
  // A: oversold base breakout
  const recentRsi = bars.slice(Math.max(0, i - r.oversoldWithin), i + 1).map((x) => x.weeklyRsi).filter((x) => x != null);
  if (allowBase && recentRsi.length && Math.min(...recentRsi) <= r.rsiOversold && i >= r.baseLookback) {
    let lowIdx = i - r.baseLookback;
    for (let k = i - r.baseLookback; k < i; k++) if (bars[k].low < bars[lowIdx].low) lowIdx = k;
    const age = i - lowIdx;
    if (age >= r.baseMinAge) {
      const baseHigh = Math.max(...bars.slice(lowIdx, i).map((x) => x.high));
      const prevClose = bars[i - 1].close;
      if (b.close > baseHigh && prevClose <= baseHigh) {
        return { setup: 'oversold base breakout', pivotLow: bars[lowIdx].low, trigger: baseHigh, baseDays: age };
      }
    }
  }
  // B: flag breakout
  for (let flagLen = r.flagMin; allowFlag && flagLen <= r.flagMax; flagLen++) {
    const top = i - flagLen - 1; // pole top candle
    if (top - r.poleMaxDays < 0) break;
    const poleTop = bars[top].high;
    const flag = bars.slice(top + 1, i);
    if (Math.max(...flag.map((x) => x.high)) > poleTop) continue; // already broke out earlier
    let poleStart = top;
    for (let k = top - 1; k >= top - r.poleMaxDays; k--) if (bars[k].low < bars[poleStart].low) poleStart = k;
    const height = poleTop - bars[poleStart].low;
    const atr = bars[top].atr;
    if (!atr || bars[top].close - bars[poleStart].close < r.poleAtr * atr) continue;
    const flagLow = Math.min(...flag.map((x) => x.low));
    if (flagLow < poleTop - r.flagHoldHalf * height) continue; // gave back more than half the pole
    if (b.close > poleTop && bars[i - 1].close <= poleTop) return { setup: 'flag breakout', pivotLow: flagLow, trigger: poleTop, flagDays: flagLen };
    break; // the most recent pole only
  }
  return null;
}

/** Charges + slippage for a delivery round trip. */
function costs(entry, exit, qty) {
  return orderCharges({ side: 'buy', value: entry * qty, product: 'delivery', costs: DEFAULT_COSTS }).total + orderCharges({ side: 'sell', value: exit * qty, product: 'delivery', costs: DEFAULT_COSTS }).total;
}

/** All trades for one stock (one position at a time). R and % results; sizing is done by the portfolio. */
export function tradesFor(symbol, rows, r = RULES, ctx = {}) {
  const bars = ctx.bars || indicators(rows, r); // ctx.bars: precomputed (same ATR / RSI settings) to test many variants quickly
  const out = [];
  const slip = r.slippagePct / 100;
  for (let i = 30; i + 1 < bars.length; i++) {
    const sig = setupAt(bars, i, r, ctx);
    if (!sig) continue;
    const e = bars[i + 1];
    const stop0 = sig.pivotLow - r.stopAtr * bars[i].atr;
    const entry = e.open * (1 + slip);
    if (!(entry > stop0)) continue; // opened below the stop
    let trail = stop0;
    let hh = e.high;
    let exit = null;
    let exitIdx = null;
    let reason = null;
    for (let k = i + 1; k < bars.length; k++) {
      const c = bars[k];
      if (k > i + 1 && c.open <= trail) {
        exit = c.open; // gap through the stop
        exitIdx = k;
        reason = 'gap below stop';
        break;
      }
      if (c.low <= stop0 && trail === stop0) {
        exit = Math.min(stop0, c.open);
        exitIdx = k;
        reason = 'initial stop';
        break;
      }
      hh = Math.max(hh, c.high);
      if (c.atr) trail = Math.max(trail, hh - r.chandelierAtr * c.atr);
      if (c.close < trail && k + 1 < bars.length) {
        exit = bars[k + 1].open;
        exitIdx = k + 1;
        reason = 'chandelier';
        break;
      }
      if (k - (i + 1) >= r.maxHold && k + 1 < bars.length) {
        exit = bars[k + 1].open;
        exitIdx = k + 1;
        reason = 'max hold';
        break;
      }
    }
    const open = exit == null;
    if (open) {
      exit = bars[bars.length - 1].close;
      exitIdx = bars.length - 1;
      reason = 'open';
    }
    const exitFill = exit * (1 - slip);
    const riskPerShare = entry - stop0;
    // costs as a % of the position, so results are size-free
    const costPct = costs(entry, exitFill, 1000) / (entry * 1000);
    const retPct = exitFill / entry - 1 - costPct;
    out.push({
      symbol, setup: sig.setup, signalDate: bars[i].date, entryDate: e.date, exitDate: bars[exitIdx].date,
      entry, stop: stop0, exit: exitFill, reason, open, days: exitIdx - (i + 1),
      riskPct: riskPerShare / entry, retPct, r: (retPct * entry) / riskPerShare,
      trail, // trailing stop at the exit (for an open trade: the stop to watch now)
    });
    i = exitIdx; // one position per stock at a time
  }
  return out;
}

// ------------------------------------------------------------- portfolio ---

// Indian tax (for the after-tax comparison): short-term gains 15% → 20% from 23 Jul 2024,
// long-term 10% → 12.5% above ₹1 lakh → ₹1.25 lakh, plus 4% cess; liquid-fund interest at a 30% slab.
export const stcgRate = (d) => (d >= '2024-07-23' ? 0.2 : 0.15) * 1.04;
export const ltcgRate = (d) => (d >= '2024-07-23' ? 0.125 : 0.1) * 1.04;
export const ltcgExemption = (d) => (d >= '2024-07-23' ? 125000 : 100000);
const SLAB = 0.3 * 1.04;

/**
 * Portfolio: 1% risk per trade, max open positions and position size; trades taken in date order.
 * Idle cash earns a liquid-fund rate. With { tax: true }: each financial year's net trading gain is
 * taxed as short-term (losses carried forward) and interest at the slab rate, paid on 1 April.
 * yearEquity: equity on 1 January each year (open positions at cost), for yearly comparisons.
 */
export function portfolio(trades, r = RULES, { tax = false } = {}) {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));
  let cash = r.capital;
  let cashDate = sorted[0]?.entryDate ?? null;
  const open = [];
  const taken = [];
  const curve = [];
  const yearEquity = {};
  if (cashDate) yearEquity[cashDate.slice(0, 4)] = r.capital;
  let investedDays = 0;
  let fyGain = 0;
  let fyInterest = 0;
  let carryLoss = 0;
  let taxPaid = 0;
  const equity = () => cash + open.reduce((a, p) => a + p.value, 0);
  const grow = (to) => {
    const days = (Date.parse(to) - Date.parse(cashDate)) / 86400000;
    if (days <= 0) return;
    const eq = equity();
    if (eq > 0) investedDays += (1 - cash / eq) * days;
    const interest = cash * ((1 + r.cashRatePct / 100) ** (days / 365) - 1);
    cash += interest;
    fyInterest += interest;
    cashDate = to;
  };
  // move the clock to `date`, stopping at 1 January (snapshot) and 1 April (tax) on the way
  const accrue = (date) => {
    if (!cashDate || date <= cashDate) return;
    for (let y = Number(cashDate.slice(0, 4)); y <= Number(date.slice(0, 4)); y++) {
      for (const b of [`${y}-01-01`, `${y}-04-01`]) {
        if (b <= cashDate || b > date) continue;
        grow(b);
        if (b.endsWith('01-01')) yearEquity[String(y)] = equity();
        else if (tax) {
          const taxable = fyGain - carryLoss;
          const t = (taxable > 0 ? taxable * stcgRate(`${y}-03-31`) : 0) + Math.max(0, fyInterest) * SLAB;
          carryLoss = taxable > 0 ? 0 : -taxable;
          cash -= t;
          taxPaid += t;
          fyGain = 0;
          fyInterest = 0;
        }
      }
    }
    grow(date);
  };
  const closeUpTo = (date) => {
    open.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    while (open.length && open[0].exitDate <= date) {
      const p = open.shift();
      accrue(p.exitDate);
      cash += p.value * (1 + p.t.retPct);
      fyGain += p.value * p.t.retPct;
    }
    accrue(date);
  };
  for (const t of sorted) {
    closeUpTo(t.entryDate);
    if (open.length >= r.maxOpen) continue;
    const eq = equity();
    const value = Math.min((eq * r.riskPct) / 100 / t.riskPct, (eq * r.maxPositionPct) / 100, cash);
    if (value < eq * 0.01) continue;
    cash -= value;
    open.push({ t, value, exitDate: t.exitDate });
    taken.push({ ...t, value, pnl: value * t.retPct });
    curve.push({ date: t.entryDate, equity: eq });
  }
  const lastDate = sorted.reduce((a, t) => (t.exitDate > a ? t.exitDate : a), cashDate || '');
  closeUpTo(lastDate);
  const span = cashDate && sorted.length ? (Date.parse(lastDate) - Date.parse(sorted[0].entryDate)) / 86400000 : 0;
  return { taken, finalEquity: cash, curve, yearEquity, endDate: lastDate, taxPaid, timeInMarket: span > 0 ? investedDays / span : null };
}

/** Calendar-year returns from {year: equity on 1 Jan} plus the final equity. */
export function yearlyReturns(yearEquity, finalEquity, endYear) {
  const ys = Object.keys(yearEquity).sort();
  const out = {};
  for (let k = 0; k < ys.length; k++) {
    const next = k + 1 < ys.length ? yearEquity[ys[k + 1]] : finalEquity;
    if (k + 1 >= ys.length && ys[k] >= endYear) break;
    out[ys[k]] = next / yearEquity[ys[k]] - 1;
  }
  return out;
}

/** Mix two yearly-return series with yearly rebalancing: CAGR, worst year, deepest fall (yearly steps). */
export function mixYears(a, b, wA) {
  const years = Object.keys(a).filter((y) => b[y] != null).sort();
  let v = 1;
  let peak = 1;
  let dd = 0;
  let worst = Infinity;
  for (const y of years) {
    const ret = wA * a[y] + (1 - wA) * b[y];
    v *= 1 + ret;
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
    worst = Math.min(worst, ret);
  }
  return { years: years.length, cagr: years.length ? v ** (1 / years.length) - 1 : null, worstYear: years.length ? worst : null, maxDrawdown: dd };
}

// ----------------------------------------------------------------- stats ---

/** Probability that a sequence of n trades with win rate p contains a losing streak ≥ k (exact DP). */
export function streakProb(n, p, k) {
  if (k <= 0) return 1;
  // state: current run of losses (0..k-1); absorbing when it reaches k
  let dist = new Array(k).fill(0);
  dist[0] = 1;
  let absorbed = 0;
  for (let i = 0; i < n; i++) {
    const next = new Array(k).fill(0);
    for (let s = 0; s < k; s++) {
      next[0] += dist[s] * p;
      if (s + 1 >= k) absorbed += dist[s] * (1 - p);
      else next[s + 1] += dist[s] * (1 - p);
    }
    dist = next;
  }
  return absorbed;
}

export function summarise(trades) {
  const done = trades.filter((t) => !t.open);
  if (!done.length) return { trades: 0 };
  const wins = done.filter((t) => t.retPct > 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const rs = done.map((t) => t.r).sort((a, b) => b - a);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const top10 = rs.slice(0, Math.max(1, Math.round(rs.length * 0.1))).reduce((a, b) => a + b, 0);
  const grossWinR = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  // longest losing streak in date order
  let run = 0;
  let longest = 0;
  for (const t of [...done].sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    run = t.retPct > 0 ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  const winRate = wins.length / done.length;
  const mean = totalR / done.length;
  const sd = Math.sqrt(done.reduce((a, t) => a + (t.r - mean) ** 2, 0) / Math.max(1, done.length - 1));
  return {
    trades: done.length, winRate, avgR: mean, medianR: rs[rs.length >> 1], bestR: rs[0], worstR: rs[rs.length - 1],
    avgRetPct: sum(done, (t) => t.retPct) / done.length, avgDays: sum(done, (t) => t.days) / done.length,
    profitFactor: sum(done.filter((t) => t.r <= 0), (t) => -t.r) > 0 ? grossWinR / sum(done.filter((t) => t.r <= 0), (t) => -t.r) : null,
    top10ShareOfR: totalR > 0 ? top10 / totalR : null, // "90% of profit from 10% of trades"?
    top10ShareOfWins: grossWinR > 0 ? top10 / grossWinR : null,
    longestLosingStreak: longest,
    // how surprising that streak is for this win rate over this many trades
    streakProbability: streakProb(done.length, winRate, longest),
    tStat: sd > 0 ? mean / (sd / Math.sqrt(done.length)) : null,
    exits: Object.fromEntries(['initial stop', 'gap below stop', 'chandelier', 'max hold'].map((k) => [k, done.filter((t) => t.reason === k).length])),
  };
}

const cagr = (a, b, years) => (years > 0 ? (b / a) ** (1 / years) - 1 : null);
function maxDrawdown(curve) {
  let peak = -Infinity;
  let dd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    dd = Math.max(dd, 1 - p.equity / peak);
  }
  return dd;
}

async function universe() {
  try {
    const idx = await loadIndexList('nifty200');
    return (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`));
  } catch {
    const idx = await loadIndexList('nifty50');
    return (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`));
  }
}

/** Drop today's daily candle until the session has closed (15:35 IST): a breakout on it isn't confirmed yet. */
export function completedOnly(rows, now = new Date()) {
  const t = new Date(now.getTime() + 19800_000);
  const today = t.toISOString().slice(0, 10);
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  return rows.length && rows[rows.length - 1].date === today && mins < 15 * 60 + 35 ? rows.slice(0, -1) : rows;
}

async function loadDaily(loadCandles, symbols, from = '2005-01-01', now = new Date()) {
  const p1 = Math.floor(Date.parse(from) / 1000);
  return (await mapLimit(symbols, 6, async (s) => {
    try {
      const rows = completedOnly((await loadCandles(s, { period1: p1, interval: '1d' })).filter((x) => x.close > 0 && x.high > 0 && x.low > 0 && x.open > 0), now);
      return rows.length > 300 ? { s, rows } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
}

async function wideUniverse(exclude) {
  try {
    const idx = await loadIndexList('nifty500');
    const ex = new Set(exclude);
    return (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`)).filter((s) => !ex.has(s));
  } catch {
    return [];
  }
}

/** Improvement grid: the market filter and a few stop / trailing settings, per setup choice. */
export const VARIANTS = (() => {
  const out = [];
  for (const setups of ['both', 'flag']) {
    for (const marketFilter of [false, true]) {
      for (const chandelierAtr of [2.5, 3, 4]) {
        for (const stopAtr of [1, 1.5]) {
          out.push({ name: `${setups === 'flag' ? 'flags only' : 'both setups'}${marketFilter ? ' · market filter' : ''} · trail ${chandelierAtr} ATR · stop ${stopAtr} ATR`, rules: { ...RULES, setups, marketFilter, chandelierAtr, stopAtr } });
        }
      }
    }
  }
  return out;
})();

/** NIFTY total-return level (≈1.2%/yr dividends added) by date. */
function niftyTR(rows) {
  let tr = 1;
  return rows.map((x, i) => {
    if (i) tr *= (x.close / rows[i - 1].close) * (1 + 0.012 / 252);
    return { date: x.date, tr };
  });
}

/**
 * Full backtest: trades on every stock, summaries by setup / half / year, a portfolio vs NIFTY,
 * plus: improvement test (chosen on the first half, judged on the second and on NIFTY 500 stocks
 * outside the NIFTY 200), after-tax comparison and an index + strategy (core + satellite) mix.
 */
export async function athSwingTest({ loadCandles = candles, from = '2005-01-01', testFrom = '2010-01-01', now = new Date() } = {}) {
  const symbols = await universe();
  const data = (await loadDaily(loadCandles, symbols, from, now)).map((x) => ({ ...x, bars: indicators(x.rows) }));
  const wdata = (await loadDaily(loadCandles, await wideUniverse(symbols), from, now)).map((x) => ({ ...x, bars: indicators(x.rows) }));
  const niftyAll = completedOnly((await loadCandles('^NSEI', { period1: Math.floor(Date.parse(from) / 1000), interval: '1d' })).filter((x) => x.close > 0), now);
  const market = marketMap(niftyAll);
  const run = (dset, rules) => dset.flatMap(({ s, rows, bars }) => tradesFor(s, rows, rules, { bars, market })).filter((t) => t.entryDate >= testFrom);

  const all = run(data, RULES);
  const done = all.filter((t) => !t.open);
  const dates = done.map((t) => t.entryDate).sort();
  const mid = dates[dates.length >> 1];
  const byYear = {};
  for (const t of done) (byYear[t.entryDate.slice(0, 4)] ||= []).push(t);
  const pf = portfolio(all);
  const pfFlag = portfolio(all.filter((t) => t.setup === 'flag breakout'));
  const pfTax = portfolio(all, RULES, { tax: true });
  const nifty = niftyAll.filter((x) => x.date >= testFrom);
  const yrs = (Date.parse(nifty[nifty.length - 1].date) - Date.parse(nifty[0].date)) / (365.25 * 86400000);
  const pfDone = pf.taken.filter((t) => !t.open);

  // 1 + 2: improvement test
  const rows = VARIANTS.map((v) => {
    const tr = run(data, v.rules).filter((t) => !t.open);
    return { name: v.name, rules: v.rules, train: summarise(tr.filter((t) => t.entryDate < mid)), test: summarise(tr.filter((t) => t.entryDate >= mid)) };
  });
  const eligible = rows.filter((x) => x.train.trades >= 60);
  const pickRow = [...eligible].sort((a, b) => (b.train.tStat ?? -9) - (a.train.tStat ?? -9))[0];
  const wideTrades = run(wdata, pickRow.rules).filter((t) => !t.open);
  const wideTest = summarise(wideTrades.filter((t) => t.entryDate >= mid));
  const combined = summarise([...run(data, pickRow.rules).filter((t) => !t.open && t.entryDate >= mid), ...wideTrades.filter((t) => t.entryDate >= mid)]);
  const adopt = pickRow.test.avgR > 0 && wideTest.avgR > 0 && combined.tStat >= 2;
  const marketOnly = rows.find((x) => x.rules.setups === 'both' && x.rules.marketFilter && x.rules.chandelierAtr === 3 && x.rules.stopAtr === 1);
  const pickAll = run(data, pickRow.rules);
  const pfPick = portfolio(pickAll);
  const pfPickTax = portfolio(pickAll, pickRow.rules, { tax: true });

  // 3: the same base rules on NIFTY 500 stocks outside the NIFTY 200
  const wideBase = summarise(run(wdata, RULES));

  // 4: after tax (strategy: short-term gains each year; NIFTY fund: long-term gain once at the end)
  const tr = niftyTR(nifty);
  const idxEnd = RULES.capital * (tr[tr.length - 1].tr / tr[0].tr);
  const idxGain = idxEnd - RULES.capital;
  const endDate = nifty[nifty.length - 1].date;
  const idxAfterTax = idxEnd - Math.max(0, idxGain - ltcgExemption(endDate)) * ltcgRate(endDate);

  // 5: core + satellite (calendar years, yearly rebalancing)
  const thisYear = String(new Date(now.getTime() + 19800_000).getUTCFullYear());
  const idxYear = {};
  for (let i = 0; i < tr.length; i++) {
    const y = tr[i].date.slice(0, 4);
    if (!(y in idxYear)) idxYear[y] = tr[i].tr;
  }
  const idxYearly = {};
  const iy = Object.keys(idxYear).sort();
  for (let k = 0; k + 1 < iy.length; k++) if (iy[k] < thisYear) idxYearly[iy[k]] = idxYear[iy[k + 1]] / idxYear[iy[k]] - 1;
  const swYearly = yearlyReturns(pf.yearEquity, pf.finalEquity, thisYear);
  const mixes = [1, 0.9, 0.8, 0.7, 0].map((w) => ({ indexPct: Math.round(w * 100), strategyPct: Math.round((1 - w) * 100), ...mixYears(idxYearly, swYearly, w) }));
  const pkYearly = yearlyReturns(pfPick.yearEquity, pfPick.finalEquity, thisYear);
  const mixesPick = [1, 0.9, 0.8, 0.7, 0].map((w) => ({ indexPct: Math.round(w * 100), strategyPct: Math.round((1 - w) * 100), ...mixYears(idxYearly, pkYearly, w) }));

  return {
    at: new Date().toISOString(), rules: RULES, stocks: data.length, wideStocks: wdata.length, from: testFrom, to: endDate,
    all: summarise(all), firstHalf: summarise(done.filter((t) => t.entryDate < mid)), secondHalf: summarise(done.filter((t) => t.entryDate >= mid)), splitDate: mid,
    bySetup: { 'oversold base breakout': summarise(done.filter((t) => t.setup === 'oversold base breakout')), 'flag breakout': summarise(done.filter((t) => t.setup === 'flag breakout')) },
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, v]) => [y, summarise(v)])),
    portfolio: {
      trades: pfDone.length, startCapital: RULES.capital, finalEquity: pf.finalEquity,
      cagr: cagr(RULES.capital, pf.finalEquity, yrs), maxDrawdown: maxDrawdown(pf.curve),
      niftyCagr: cagr(tr[0].tr, tr[tr.length - 1].tr, yrs),
      years: yrs, timeInMarket: pf.timeInMarket, cashRatePct: RULES.cashRatePct,
      flagOnly: { trades: pfFlag.taken.filter((t) => !t.open).length, finalEquity: pfFlag.finalEquity, cagr: cagr(RULES.capital, pfFlag.finalEquity, yrs), maxDrawdown: maxDrawdown(pfFlag.curve), timeInMarket: pfFlag.timeInMarket },
    },
    improve: {
      variants: rows.map((x) => ({ name: x.name, train: x.train, test: x.test })),
      pick: { name: pickRow.name, rules: pickRow.rules, train: pickRow.train, test: pickRow.test, wideTest, combined, adopt, portfolioCagr: cagr(RULES.capital, pfPick.finalEquity, yrs), portfolioMaxDrawdown: maxDrawdown(pfPick.curve) },
      marketFilter: marketOnly ? { train: marketOnly.train, test: marketOnly.test } : null,
      rule: 'Each version is scored on trades before the split date only (by t-statistic, needing 60+ trades); the pick is then judged on later trades, and on NIFTY 500 stocks outside the NIFTY 200 that were never used. Adopted only if both are profitable and the combined t ≥ 2.',
    },
    wide: { stocks: wdata.length, base: wideBase },
    afterTax: {
      strategy: { preTax: pf.finalEquity, afterTax: pfTax.finalEquity, taxPaid: pfTax.taxPaid, cagrPre: cagr(RULES.capital, pf.finalEquity, yrs), cagrAfter: cagr(RULES.capital, pfTax.finalEquity, yrs) },
      improved: { preTax: pfPick.finalEquity, afterTax: pfPickTax.finalEquity, taxPaid: pfPickTax.taxPaid, cagrPre: cagr(RULES.capital, pfPick.finalEquity, yrs), cagrAfter: cagr(RULES.capital, pfPickTax.finalEquity, yrs) },
      index: { preTax: idxEnd, afterTax: idxAfterTax, cagrPre: cagr(RULES.capital, idxEnd, yrs), cagrAfter: cagr(RULES.capital, idxAfterTax, yrs) },
      note: 'Strategy: each financial year\'s net trading gain taxed as short-term (15%, 20% from 23 Jul 2024, +4% cess; losses carried forward) and liquid-fund interest at a 30% slab. NIFTY fund held throughout: long-term tax once at the end (12.5% above ₹1.25 lakh). Simplified; check with a tax professional.',
    },
    coreSatellite: { mixes, mixesPick, years: Object.keys(idxYearly).filter((y) => swYearly[y] != null).length, note: 'Calendar years with yearly rebalancing, before tax. Yearly steps understate falls inside a year.' },
    topTrades: [...done].sort((a, b) => b.r - a.r).slice(0, 10),
    note: 'Universe = today\'s NIFTY 200 (survivorship bias: stocks that collapsed and left the index are missing, which flatters a strong-stock strategy). Patterns are approximated by fixed rules. Entries next open, exits next open after a close below the Chandelier stop, delivery charges + 0.1% slippage a side. Portfolio: 1% risk per trade, ≤10 open, ≤20% per stock; idle cash earns 6%/yr (liquid fund); open positions valued at cost. NIFTY includes ≈1.2%/yr dividends. Research only.',
  };
}

/** Rules in use for live signals: the improvement-test pick if it was adopted, else the original rules. */
export function activeRules(saved = loadAthSwing()) {
  const p = saved?.improve?.pick;
  return p?.adopt && p.rules ? { ...RULES, ...p.rules } : RULES;
}

export function saveAthSwing(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadAthSwing() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------- live scan + paper record ---

/** Today's watchlist: strong stocks, setups that triggered at the latest close, and ones forming. */
export async function athSwingScan({ loadCandles = candles, now = new Date(), rules = activeRules() } = {}) {
  const symbols = await universe();
  const data = await loadDaily(loadCandles, symbols, '2005-01-01', now);
  const strong = [];
  const triggered = [];
  const forming = [];
  let lastDate = null;
  for (const { s, rows } of data) {
    const bars = indicators(rows);
    const i = bars.length - 1;
    const b = bars[i];
    lastDate = lastDate && lastDate > b.date ? lastDate : b.date;
    if (!b.atr || !isStrong(b, rules)) continue;
    const fromAth = 1 - b.close / b.ath;
    strong.push({ symbol: s, close: b.close, ath: b.ath, fromAthPct: fromAth * 100, athDaysAgo: b.athAge, weeklyRsi: b.weeklyRsi, atrPct: (b.atr / b.close) * 100 });
    const sig = setupAt(bars, i, rules);
    if (sig) {
      const stop = sig.pivotLow - rules.stopAtr * b.atr;
      triggered.push({ symbol: s, date: b.date, setup: sig.setup, close: b.close, trigger: sig.trigger, stop, riskPct: ((b.close - stop) / b.close) * 100, chandelier: b.close - rules.chandelierAtr * b.atr });
    } else if (rules.setups !== 'flag' && b.weeklyRsi != null && b.weeklyRsi <= rules.rsiOversold + 5) {
      forming.push({ symbol: s, note: `weekly RSI ${b.weeklyRsi.toFixed(0)} — oversold in a strong stock; waiting for a base of 5+ days and a breakout`, close: b.close });
    }
  }
  strong.sort((a, b) => a.fromAthPct - b.fromAthPct);
  return {
    at: new Date().toISOString(), date: lastDate, universe: data.length, strongCount: strong.length,
    rules: { chandelierAtr: rules.chandelierAtr, stopAtr: rules.stopAtr, setups: rules.setups, marketFilter: rules.marketFilter, improved: rules !== RULES },
    triggered, forming, strong: strong.slice(0, 40),
    note: 'Signals use completed daily candles: a "triggered" stock closed above its breakout level today; the strategy would buy at the next open with the stop shown. Paper only.',
  };
}

export function loadAthPaper() {
  try {
    return existsSync(PAPER()) ? JSON.parse(readFileSync(PAPER(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Forward paper record: every trade each version takes with entry on or after the start date; exits updated daily. */
export async function athPaperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadAthPaper() || { startedAt: new Date(now.getTime() + 19800_000).toISOString().slice(0, 10), trades: [] };
  const symbols = await universe();
  const data = await loadDaily(loadCandles, symbols, '2005-01-01', now);
  const versions = { original: RULES };
  const act = activeRules();
  if (act !== RULES) versions.improved = act;
  const key = (t) => `${t.version}|${t.symbol}|${t.entryDate}`;
  const prev = new Map(st.trades.map((t) => [key({ version: 'original', ...t }), t]));
  const fresh = [];
  for (const [v, rules] of Object.entries(versions)) {
    for (const t of data.flatMap(({ s, rows }) => tradesFor(s, rows, rules)).filter((x) => x.entryDate >= st.startedAt)) fresh.push({ ...t, version: v });
  }
  const before = new Set(st.trades.map((t) => key({ version: 'original', ...t })));
  st.trades = fresh.map((t) => ({ ...t, firstSeen: prev.get(key(t))?.firstSeen || now.toISOString() }));
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  const newOnes = st.trades.filter((t) => !before.has(key(t)));
  const exitsToday = st.trades.filter((t) => !t.open && t.exitDate === new Date(now.getTime() + 19800_000).toISOString().slice(0, 10));
  return {
    startedAt: st.startedAt, trades: st.trades.length, open: st.trades.filter((t) => t.open).length,
    byVersion: Object.fromEntries(Object.keys(versions).map((v) => [v, summarise(st.trades.filter((t) => t.version === v))])),
    summary: summarise(st.trades.filter((t) => t.version === (versions.improved ? 'improved' : 'original'))),
    newOnes, exitsToday,
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--paper')) {
    athPaperUpdate()
      .then(async (r) => {
        console.log(`Strong-stock swing paper: since ${r.startedAt} · ${r.trades} trades (${r.open} open)`);
        if (!process.argv.includes('--alerts')) return;
        const ver = activeRules() !== RULES ? 'improved' : 'original';
        // price alerts at the trailing stops of open paper positions (My trades → Price alerts)
        const { syncSourceAlerts } = await import('./journal.mjs');
        const open = loadAthPaper()?.trades.filter((x) => x.open && x.version === ver && x.trail > 0) || [];
        const n = await syncSourceAlerts('swing-paper', open.map((x) => ({ symbol: x.symbol, op: 'below', price: x.trail, note: `Swing paper: trailing stop (bought ${x.entryDate})` })));
        console.log(`Trailing-stop alerts for open swing paper positions: ${n}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else if (!process.argv.includes('--survivorship')) {
    athSwingTest()
      .then((r) => {
        saveAthSwing(r);
        const p = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
        const line = (n, x) => console.log(`${n.padEnd(26)} ${String(x.trades).padStart(5)} trades · win ${p(x.winRate)} · avg ${x.avgR?.toFixed(2)} R (median ${x.medianR?.toFixed(2)}) · avg ${p(x.avgRetPct, 1)} · ${x.avgDays?.toFixed(0)} days · PF ${x.profitFactor?.toFixed(2)} · t ${x.tStat?.toFixed(2)} · top 10% = ${p(x.topTenShare ?? x.top10ShareOfR)} of net R · longest losing run ${x.longestLosingStreak} (chance ${p(x.streakProbability)})`);
        console.log(`\nSTRONG-STOCK SWING · ${r.stocks} stocks · ${r.from} → ${r.to}`);
        line('All trades', r.all);
        line(`  before ${r.splitDate}`, r.firstHalf);
        line(`  from ${r.splitDate}`, r.secondHalf);
        for (const [k, v] of Object.entries(r.bySetup)) line(`  ${k}`, v);
        console.log('By year:');
        for (const [y, v] of Object.entries(r.byYear)) console.log(`  ${y}: ${v.trades} trades · win ${p(v.winRate)} · avg ${v.avgR?.toFixed(2)} R`);
        const pf = r.portfolio;
        console.log(`Portfolio (1% risk, ≤10 open, cash at 6%): ${pf.trades} trades · ₹${(pf.startCapital / 1e5).toFixed(0)}L → ₹${(pf.finalEquity / 1e5).toFixed(1)}L · CAGR ${p(pf.cagr, 1)} vs NIFTY ${p(pf.niftyCagr, 1)} · max drawdown ${p(pf.maxDrawdown)} · invested ${p(pf.timeInMarket)} of the time`);
        console.log(`  flag breakouts only: ${pf.flagOnly.trades} trades · CAGR ${p(pf.flagOnly.cagr, 1)} · max drawdown ${p(pf.flagOnly.maxDrawdown)} · invested ${p(pf.flagOnly.timeInMarket)}`);
        console.log(`Exits: ${JSON.stringify(r.all.exits)}`);
        const im = r.improve.pick;
        console.log(`\nIMPROVEMENT TEST (pick on trades before ${r.splitDate}): ${im.name}`);
        line('  train', im.train);
        line('  test (same stocks, later)', im.test);
        line(`  test (${r.wideStocks} other NIFTY 500)`, im.wideTest);
        console.log(`  combined t ${im.combined.tStat?.toFixed(2)} → ${im.adopt ? 'ADOPTED' : 'not adopted'} · portfolio CAGR ${p(im.portfolioCagr, 1)} · max drawdown ${p(im.portfolioMaxDrawdown)}`);
        if (r.improve.marketFilter) {
          line('  market filter: train', r.improve.marketFilter.train);
          line('  market filter: test', r.improve.marketFilter.test);
        }
        line(`NIFTY 500 ex-200 (${r.wide.stocks})`, r.wide.base);
        const at = r.afterTax;
        console.log(`After tax: strategy ${p(at.strategy.cagrPre, 1)} → ${p(at.strategy.cagrAfter, 1)} a year · NIFTY fund ${p(at.index.cagrPre, 1)} → ${p(at.index.cagrAfter, 1)}`);
        console.log('Core + satellite (index % / strategy %: CAGR · worst year · deepest fall):');
        for (const m of r.coreSatellite.mixes) console.log(`  ${m.indexPct}/${m.strategyPct}: ${p(m.cagr, 1)} · ${p(m.worstYear, 1)} · ${p(m.maxDrawdown)}`);
        console.log(`\n${r.note}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}

// ------------------------------------------------- survivorship check ---

const SURV = () => process.env.ATH_SURV_PATH || join(HERE, 'data', 'ath-survivorship.json');

/**
 * The same strategy on a survivorship-free universe: every month's 200 most-traded
 * NSE stocks as they were THEN (from NSE's own daily files, including companies
 * that later collapsed or were delisted), prices adjusted for splits / bonuses.
 * `series` / `universe` come from bhav-history.mjs.
 */
export function survivorshipRun(series, universe, market, { testFrom = '2010-01-01', rulesList = { original: RULES, improved: activeRules() } } = {}) {
  const lastDate = [...series.values()].reduce((a, rows) => (rows.length && rows[rows.length - 1].date > a ? rows[rows.length - 1].date : a), '');
  const goneBefore = new Date(Date.parse(lastDate) - 30 * 86400000).toISOString().slice(0, 10);
  const gone = new Set([...series].filter(([, rows]) => rows.length && rows[rows.length - 1].date < goneBefore).map(([s]) => s));
  const prepared = [...series].filter(([, rows]) => rows.length > 300).map(([s, rows]) => ({ s, rows, bars: indicators(rows), first: rows[0].date }));
  const out = {};
  for (const [name, rules] of Object.entries(rulesList)) {
    const trades = prepared.flatMap(({ s, rows, bars, first }) => tradesFor(s, rows, rules, { bars, market })
      .filter((t) => t.entryDate >= testFrom
        && universe.get(t.signalDate.slice(0, 7))?.has(s)
        // the all-time-high test needs history: at least a year of stored prices before the signal
        && Date.parse(t.signalDate) - Date.parse(first) >= 365 * 86400000));
    const done = trades.filter((t) => !t.open);
    const dates = done.map((t) => t.entryDate).sort();
    const mid = dates[dates.length >> 1];
    const pf = portfolio(trades, rules);
    const yrs = dates.length ? (Date.parse(pf.endDate || lastDate) - Date.parse(dates[0])) / (365.25 * 86400000) : 0;
    out[name] = {
      all: summarise(trades), firstHalf: summarise(done.filter((t) => t.entryDate < mid)), secondHalf: summarise(done.filter((t) => t.entryDate >= mid)),
      inLaterGoneStocks: summarise(done.filter((t) => gone.has(t.symbol))),
      portfolioCagr: yrs > 0 ? cagr(rules.capital, pf.finalEquity, yrs) : null, maxDrawdown: maxDrawdown(pf.curve),
    };
  }
  const members = new Set([...universe.values()].flatMap((x) => [...x]));
  return {
    at: new Date().toISOString(), from: testFrom, to: lastDate,
    stocksEverInUniverse: members.size, laterGone: [...members].filter((s) => gone.has(s)).length,
    results: out,
    note: 'Universe each month = the 200 most-traded NSE stocks of the previous month, as they were then (NSE daily files, including stocks that later collapsed, were suspended or delisted). Prices adjusted for splits / bonuses with NSE\'s adjusted previous close. A stock that changed its NSE symbol appears as two. Compare with the main backtest, which uses today\'s NIFTY 200.',
  };
}

export async function survivorshipTest({ loadCandles = candles } = {}) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const series = loadSeries();
  if (!series.size) throw new Error('No NSE history yet: run node paper-bot/bhav-history.mjs first.');
  const universe = pointInTimeUniverse(series);
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2005-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const r = survivorshipRun(series, universe, marketMap(nifty));
  writeJsonAtomic(SURV(), r);
  return r;
}

export function loadSurvivorship() {
  try {
    return existsSync(SURV()) ? JSON.parse(readFileSync(SURV(), 'utf8')) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--survivorship')) {
  survivorshipTest()
    .then((r) => {
      const p = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
      console.log(`\nSURVIVORSHIP-FREE CHECK · ${r.from} → ${r.to} · ${r.stocksEverInUniverse} stocks were in the top 200 at some point · ${r.laterGone} of them later stopped trading`);
      for (const [k, v] of Object.entries(r.results)) {
        console.log(`  ${k.padEnd(9)} ${v.all.trades} trades · win ${p(v.all.winRate, 0)} · ${v.all.avgR?.toFixed(2)} R (t ${v.all.tStat?.toFixed(2)}) · halves ${v.firstHalf.avgR?.toFixed(2)} / ${v.secondHalf.avgR?.toFixed(2)} R · in later-gone stocks: ${v.inLaterGoneStocks.trades} trades ${v.inLaterGoneStocks.avgR?.toFixed(2) ?? '–'} R · portfolio ${p(v.portfolioCagr)} · max DD ${p(v.maxDrawdown, 0)}`);
      }
      console.log(`\n${r.note}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
