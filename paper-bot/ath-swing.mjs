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

/** Setup on day i (signal at its close), or null. */
export function setupAt(bars, i, r = RULES) {
  const b = bars[i];
  if (!b.atr || !isStrong(b, r)) return null;
  // A: oversold base breakout
  const recentRsi = bars.slice(Math.max(0, i - r.oversoldWithin), i + 1).map((x) => x.weeklyRsi).filter((x) => x != null);
  if (recentRsi.length && Math.min(...recentRsi) <= r.rsiOversold && i >= r.baseLookback) {
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
  for (let flagLen = r.flagMin; flagLen <= r.flagMax; flagLen++) {
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
export function tradesFor(symbol, rows, r = RULES) {
  const bars = indicators(rows, r);
  const out = [];
  const slip = r.slippagePct / 100;
  for (let i = 30; i + 1 < bars.length; i++) {
    const sig = setupAt(bars, i, r);
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
    });
    i = exitIdx; // one position per stock at a time
  }
  return out;
}

// ------------------------------------------------------------- portfolio ---

/** Portfolio: 1% risk per trade, max open positions and position size; trades taken in date order. */
export function portfolio(trades, r = RULES) {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));
  let cash = r.capital;
  let cashDate = sorted[0]?.entryDate ?? null;
  const open = [];
  const taken = [];
  const curve = [];
  let investedDays = 0; // sum over time of (share of equity invested × days), for "time in the market"
  // idle cash earns a liquid-fund rate (≈6%/yr, before tax) between events
  const accrue = (date) => {
    if (!cashDate || date <= cashDate) return;
    const days = (Date.parse(date) - Date.parse(cashDate)) / 86400000;
    const eq = cash + open.reduce((a, p) => a + p.value, 0);
    if (eq > 0) investedDays += (1 - cash / eq) * days;
    cash *= (1 + r.cashRatePct / 100) ** (days / 365);
    cashDate = date;
  };
  const closeUpTo = (date) => {
    open.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    while (open.length && open[0].exitDate <= date) {
      const p = open.shift();
      accrue(p.exitDate);
      cash += p.value * (1 + p.t.retPct);
    }
    accrue(date);
  };
  const equityAt = () => cash + open.reduce((a, p) => a + p.value, 0); // open positions at cost (conservative)
  for (const t of sorted) {
    closeUpTo(t.entryDate);
    if (open.length >= r.maxOpen) continue;
    const eq = equityAt();
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
  return { taken, finalEquity: cash, curve, timeInMarket: span > 0 ? investedDays / span : null };
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

/** Full backtest: trades on every stock, summaries by setup / half / year, a portfolio, NIFTY comparison. */
export async function athSwingTest({ loadCandles = candles, from = '2005-01-01', testFrom = '2010-01-01' } = {}) {
  const symbols = await universe();
  const data = await loadDaily(loadCandles, symbols, from);
  const all = data.flatMap(({ s, rows }) => tradesFor(s, rows)).filter((t) => t.entryDate >= testFrom);
  const done = all.filter((t) => !t.open);
  const dates = done.map((t) => t.entryDate).sort();
  const mid = dates[dates.length >> 1];
  const byYear = {};
  for (const t of done) (byYear[t.entryDate.slice(0, 4)] ||= []).push(t);
  const pf = portfolio(all);
  const pfFlag = portfolio(all.filter((t) => t.setup === 'flag breakout'));
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse(testFrom) / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const yrs = (Date.parse(nifty[nifty.length - 1].date) - Date.parse(nifty[0].date)) / (365.25 * 86400000);
  const pfDone = pf.taken.filter((t) => !t.open);
  return {
    at: new Date().toISOString(), rules: RULES, stocks: data.length, from: testFrom, to: nifty[nifty.length - 1].date,
    all: summarise(all), firstHalf: summarise(done.filter((t) => t.entryDate < mid)), secondHalf: summarise(done.filter((t) => t.entryDate >= mid)), splitDate: mid,
    bySetup: { 'oversold base breakout': summarise(done.filter((t) => t.setup === 'oversold base breakout')), 'flag breakout': summarise(done.filter((t) => t.setup === 'flag breakout')) },
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, v]) => [y, summarise(v)])),
    portfolio: {
      trades: pfDone.length, startCapital: RULES.capital, finalEquity: pf.finalEquity,
      cagr: cagr(RULES.capital, pf.finalEquity, yrs), maxDrawdown: maxDrawdown(pf.curve),
      niftyCagr: cagr(nifty[0].close, nifty[nifty.length - 1].close, yrs) + 0.012, // + ≈1.2%/yr dividends
      years: yrs, timeInMarket: pf.timeInMarket, cashRatePct: RULES.cashRatePct,
      flagOnly: { trades: pfFlag.taken.filter((t) => !t.open).length, finalEquity: pfFlag.finalEquity, cagr: cagr(RULES.capital, pfFlag.finalEquity, yrs), maxDrawdown: maxDrawdown(pfFlag.curve), timeInMarket: pfFlag.timeInMarket },
    },
    topTrades: [...done].sort((a, b) => b.r - a.r).slice(0, 10),
    note: 'Universe = today\'s NIFTY 200 (survivorship bias: stocks that collapsed and left the index are missing, which flatters a strong-stock strategy). Patterns are approximated by fixed rules. Entries next open, exits next open after a close below the Chandelier stop, delivery charges + 0.1% slippage a side. Portfolio: 1% risk per trade, ≤10 open, ≤20% per stock; idle cash earns 6%/yr (liquid fund); open positions valued at cost. NIFTY includes ≈1.2%/yr dividends. Research only.',
  };
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
export async function athSwingScan({ loadCandles = candles, now = new Date() } = {}) {
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
    if (!b.atr || !isStrong(b)) continue;
    const fromAth = 1 - b.close / b.ath;
    strong.push({ symbol: s, close: b.close, ath: b.ath, fromAthPct: fromAth * 100, athDaysAgo: b.athAge, weeklyRsi: b.weeklyRsi, atrPct: (b.atr / b.close) * 100 });
    const sig = setupAt(bars, i);
    if (sig) {
      const stop = sig.pivotLow - RULES.stopAtr * b.atr;
      triggered.push({ symbol: s, date: b.date, setup: sig.setup, close: b.close, trigger: sig.trigger, stop, riskPct: ((b.close - stop) / b.close) * 100, chandelier: b.close - RULES.chandelierAtr * b.atr });
    } else if (b.weeklyRsi != null && b.weeklyRsi <= RULES.rsiOversold + 5) {
      forming.push({ symbol: s, note: `weekly RSI ${b.weeklyRsi.toFixed(0)} — oversold in a strong stock; waiting for a base of 5+ days and a breakout`, close: b.close });
    }
  }
  strong.sort((a, b) => a.fromAthPct - b.fromAthPct);
  return {
    at: new Date().toISOString(), date: lastDate, universe: data.length, strongCount: strong.length,
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

/** Forward paper record: every trade the rules take with entry on or after the start date; exits updated daily. */
export async function athPaperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadAthPaper() || { startedAt: new Date(now.getTime() + 19800_000).toISOString().slice(0, 10), trades: [] };
  const symbols = await universe();
  const data = await loadDaily(loadCandles, symbols, '2005-01-01', now);
  const fresh = data.flatMap(({ s, rows }) => tradesFor(s, rows)).filter((t) => t.entryDate >= st.startedAt);
  const key = (t) => `${t.symbol}|${t.entryDate}`;
  const prev = new Map(st.trades.map((t) => [key(t), t]));
  st.trades = fresh.map((t) => ({ ...t, firstSeen: prev.get(key(t))?.firstSeen || now.toISOString() }));
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { startedAt: st.startedAt, trades: st.trades.length, open: st.trades.filter((t) => t.open).length, summary: summarise(st.trades) };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--paper')) {
    athPaperUpdate()
      .then((r) => console.log(`Strong-stock swing paper: since ${r.startedAt} · ${r.trades} trades (${r.open} open)`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
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
        console.log(`\n${r.note}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
