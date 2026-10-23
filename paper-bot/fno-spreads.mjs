#!/usr/bin/env node
// F&O spread strategies from "FNO_Strategy_Specification.docx" (library + CLI),
// paper only. Two defined-risk logics on liquid NSE stocks, priced with
// Black-Scholes (no real option-chain data):
//
//   momentum-debit  bull call / bear put debit spread when 5- and 20-day
//                   momentum, the SMA-20/50 trend, RSI and volume all agree
//   ivrank-credit   put / call credit spread when "IV rank" (realised vol vs its
//                   last 60 readings) is ≥ 60, with an RSI mean-reversion tilt
//
// Implemented as written (section numbers refer to the document), with these
// choices where it is silent — each is listed in `assumptions` of the result:
//   • credit spreads sell the strike about 1 ATR out of the money (not specified)
//   • a "strike step" ladder by price: <500 → 5, <1500 → 10, <3000 → 20, else 50
//   • "brokerage 0.04% + slippage 0.08% round trip" = 0.12% of the premium
//     value of every leg, charged on close
//   • DTE counts calendar days; "IV" for pricing = 20-day realised vol × 1.08
// Two settings are offered:
//   spec       exactly the document: any DTE, any quantity, its costs
//   realistic  NSE reality: stock options are monthly (enter only when the
//              monthly expiry is 7–17 days away), quantities in whole lots,
//              ₹20/order + STT/exchange/GST + 1% slippage per leg per fill
// The model can only say what happens if options were priced off realised
// volatility; real premiums (skew, the volatility risk premium, wide stock
// option spreads) are not tested. Research only — not investment advice.
//
//   node paper-bot/fno-spreads.mjs          # backtests + real-price check (saved for the app)
// No daily paper record: it would be priced by the same model, so it could only
// repeat what the model already says.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { greeks } from '../blackscholes.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';
import { completedOnly } from './ath-swing.mjs';
import { readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.FNO_SPREADS_PATH || join(HERE, 'data', 'fno-spreads.json');

export const SYMBOLS = ['RELIANCE.NS', 'HDFCBANK.NS', 'TCS.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'ITC.NS'];
// NSE stock option lot sizes (approximate, 2025–26 circulars); used by the "realistic" setting
export const LOTS = { 'RELIANCE.NS': 500, 'HDFCBANK.NS': 550, 'TCS.NS': 175, 'INFY.NS': 400, 'ICICIBANK.NS': 700, 'SBIN.NS': 750, 'BHARTIARTL.NS': 475, 'ITC.NS': 1600 };

export const RULES = {
  capital: 100000, maxOpen: 3, rate: 0.065, ivMult: 1.08,
  targetR: 1.3, stopR: 0.55, timeStopDte: 3,
  debit: { dte: 12, riskPct: 1.25, otmSteps: 2, minDebit: 0.7, maxDebitOfWidth: 0.6, ret5: 1.2, ret20: 3, rsiLong: [55, 72], rsiShort: [28, 45], volRatio: 1.1, maxIvOverRv: 1.4 },
  credit: { dte: 10, riskPct: 1, minRank: 60, minIv: 0.18, midRank: 75, rsiLow: 40, rsiHigh: 60, guard5: 2.5, otmAtr: 1, minWidth: 10, maxWidth: 40, minCredit: 1.2, minLossOverCredit: 0.8 },
  costPct: 0.12, // spec: brokerage 0.04% + slippage 0.08%, of premium value, on close
};

// ---------------------------------------------------------------- helpers ---
export const strikeStep = (px) => (px < 500 ? 5 : px < 1500 ? 10 : px < 3000 ? 20 : 50);
const roundStep = (x, s) => Math.round(x / s) * s;

/** Indicators of section 3.2 for every day (no look-ahead: day i uses closes up to i). */
export function indicators(rows) {
  const out = [];
  const lr = rows.map((r, i) => (i ? Math.log(r.close / rows[i - 1].close) : 0));
  let gain = 0;
  let loss = 0;
  const rvHist = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sma = (n) => (i >= n - 1 ? rows.slice(i - n + 1, i + 1).reduce((a, x) => a + x.close, 0) / n : null);
    // Wilder RSI-14
    if (i > 0) {
      const ch = r.close - rows[i - 1].close;
      const g = Math.max(ch, 0);
      const l = Math.max(-ch, 0);
      if (i <= 14) {
        gain += g / 14;
        loss += l / 14;
      } else {
        gain = (gain * 13 + g) / 14;
        loss = (loss * 13 + l) / 14;
      }
    }
    const rsi = i >= 14 ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null;
    // ATR-14 (simple average of true range)
    let atr = null;
    if (i >= 14) {
      let s = 0;
      for (let k = i - 13; k <= i; k++) s += Math.max(rows[k].high - rows[k].low, Math.abs(rows[k].high - rows[k - 1].close), Math.abs(rows[k].low - rows[k - 1].close));
      atr = s / 14;
    }
    let rv = null;
    if (i >= 20) {
      const w = lr.slice(i - 19, i + 1);
      const m = w.reduce((a, b) => a + b, 0) / 20;
      rv = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 19) * Math.sqrt(252);
      rvHist.push(rv);
    }
    const last60 = rvHist.slice(-60);
    const ivRank = rv != null && last60.length >= 60 ? (last60.filter((v) => v < rv).length / last60.length) * 100 : null;
    const vol20 = i >= 20 ? rows.slice(i - 20, i).reduce((a, x) => a + (x.volume || 0), 0) / 20 : null;
    out.push({
      date: r.date, close: r.close, sma20: sma(20), sma50: sma(50), rsi, atr,
      volRatio: vol20 > 0 ? (r.volume || 0) / vol20 : null,
      ret5: i >= 5 ? (r.close / rows[i - 5].close - 1) * 100 : null,
      ret20: i >= 20 ? (r.close / rows[i - 20].close - 1) * 100 : null,
      rv, iv: rv != null ? rv * RULES.ivMult : null, ivRank,
    });
  }
  return out;
}

const bs = (spot, strike, dteDays, iv, type, rate) => greeks({ spot, strike, tYears: Math.max(dteDays, 0.01) / 365, iv: Math.max(iv, 0.01), type: type === 'call' ? 'CE' : 'PE', rate }).price;

/** Value per unit of a spread to its holder (debit: long − short; credit: what it costs to buy back). */
export function spreadValue(p, spot, dte, iv, rate = RULES.rate) {
  const a = bs(spot, p.longStrike, dte, iv, p.type, rate);
  const b = bs(spot, p.shortStrike, dte, iv, p.type, rate);
  return p.kind === 'debit' ? a - b : b - a;
}

/** Monthly stock-option expiry: last Thursday (last Tuesday from Sep 2025), as YYYY-MM-DD. */
export function monthlyExpiry(y, m) {
  const tue = y > 2025 || (y === 2025 && m >= 9);
  const target = tue ? 2 : 4;
  const d = new Date(Date.UTC(y, m, 0)); // last day of month m (1-based)
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function nextMonthlyExpiry(date) {
  let [y, m] = date.split('-').map(Number);
  for (let k = 0; k < 3; k++) {
    const e = monthlyExpiry(y, m);
    if (e > date) return e;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null;
}

// ------------------------------------------------------------------ entries ---
/** Section 4.1 / 4.2: a debit spread on day b, or null. */
export function debitSignal(b, r = RULES) {
  const d = r.debit;
  if ([b.ret5, b.ret20, b.sma20, b.sma50, b.rsi, b.volRatio, b.iv, b.rv].some((x) => x == null)) return null;
  if (b.volRatio < d.volRatio || b.iv > d.maxIvOverRv * b.rv) return null;
  const long = b.ret5 > d.ret5 && b.ret20 > d.ret20 && b.close > b.sma20 && b.close > b.sma50 && b.sma20 > b.sma50 && b.rsi >= d.rsiLong[0] && b.rsi <= d.rsiLong[1];
  const short = b.ret5 < -d.ret5 && b.ret20 < -d.ret20 && b.close < b.sma20 && b.close < b.sma50 && b.sma20 < b.sma50 && b.rsi >= d.rsiShort[0] && b.rsi <= d.rsiShort[1];
  if (!long && !short) return null;
  return { strategy: 'momentum-debit', kind: 'debit', type: long ? 'call' : 'put', side: long ? 'bull call debit spread' : 'bear put debit spread' };
}

/** Section 5.1 / 5.2: a credit spread on day b, or null. */
export function creditSignal(b, r = RULES) {
  const c = r.credit;
  if ([b.ivRank, b.iv, b.rsi, b.ret5, b.atr].some((x) => x == null)) return null;
  if (b.ivRank < c.minRank || b.iv < c.minIv) return null;
  let dir = null;
  if (b.rsi <= c.rsiLow) dir = 'put';
  else if (b.rsi >= c.rsiHigh) dir = 'call';
  else if (b.ivRank >= c.midRank) dir = b.rsi < 50 ? 'put' : 'call';
  if (!dir) return null;
  if (dir === 'put' && b.ret5 < -c.guard5) return null;
  if (dir === 'call' && b.ret5 > c.guard5) return null;
  return { strategy: 'ivrank-credit', kind: 'credit', type: dir, side: dir === 'put' ? 'put credit spread' : 'call credit spread' };
}

/** Strikes, price per unit, max loss per unit and quantity → a position, or null (with the reason). */
export function buildPosition(sig, b, symbol, equity, { r = RULES, dte, lot = 1 } = {}) {
  const step = strikeStep(b.close);
  const atm = roundStep(b.close, step);
  let p;
  if (sig.kind === 'debit') {
    const longStrike = atm;
    const shortStrike = sig.type === 'call' ? atm + r.debit.otmSteps * step : atm - r.debit.otmSteps * step;
    p = { ...sig, longStrike, shortStrike, width: Math.abs(shortStrike - longStrike) };
    const debit = spreadValue(p, b.close, dte, b.iv, r.rate);
    if (!(debit > r.debit.minDebit) || debit > r.debit.maxDebitOfWidth * p.width) return { skip: `debit ${debit.toFixed(2)} outside 0.7 … 60% of width` };
    p.entryPrice = debit;
    p.maxLoss = debit;
  } else {
    const off = roundStep(r.credit.otmAtr * b.atr, step) || step;
    const shortStrike = sig.type === 'put' ? atm - off : atm + off;
    const width = Math.min(r.credit.maxWidth, Math.max(r.credit.minWidth, roundStep(2 * step, step)));
    const w = Math.max(step, roundStep(width, step));
    const longStrike = sig.type === 'put' ? shortStrike - w : shortStrike + w;
    p = { ...sig, longStrike, shortStrike, width: w };
    const credit = spreadValue(p, b.close, dte, b.iv, r.rate);
    const maxLoss = w - credit;
    if (!(credit >= r.credit.minCredit)) return { skip: `credit ${credit.toFixed(2)} below 1.2` };
    if (!(maxLoss > credit * r.credit.minLossOverCredit)) return { skip: 'reward-to-risk check failed' };
    p.entryPrice = credit;
    p.maxLoss = maxLoss;
  }
  const riskPct = sig.kind === 'debit' ? r.debit.riskPct : r.credit.riskPct;
  let qty = Math.floor((equity * riskPct) / 100 / p.maxLoss);
  if (lot > 1) qty = Math.floor(qty / lot) * lot;
  if (qty < 1) return { skip: lot > 1 ? `one lot (${lot}) risks ₹${Math.round(lot * p.maxLoss).toLocaleString('en-IN')}, more than ${riskPct}% of equity` : 'quantity below 1' };
  return { ...p, symbol, entryDate: b.date, entrySpot: b.close, entryIv: b.iv, dte, qty, lot, step, riskRs: qty * p.maxLoss };
}

// ------------------------------------------------------------------ costs ---
/** Round-trip costs in ₹ for a closed position. */
export function positionCosts(p, exitPrice, mode, r = RULES) {
  // premium value of each leg at entry and exit (approximate: legs priced at entry/exit spot & IV)
  const legs = [p.legsEntry, p.legsExit].flat();
  const value = legs.reduce((a, x) => a + x, 0) * p.qty;
  if (mode !== 'realistic') return (value * r.costPct) / 100;
  // realistic: ₹20 per order (4 orders), STT 0.1% on sold premium, exchange 0.035%, GST 18%, stamp 0.003% on buys, 1% slippage per leg per fill
  const sold = (p.kind === 'debit' ? p.legsEntry[1] + p.legsExit[0] : p.legsEntry[0] + p.legsExit[1]) * p.qty;
  const bought = value - sold;
  const brk = 4 * 20;
  const exch = value * 0.0003503;
  return brk + sold * 0.001 + exch + 0.18 * (brk + exch) + bought * 0.00003 + value * 0.01;
}

// ------------------------------------------------------------- simulation ---
/**
 * Walk forward day by day across all symbols (section 6): update → manage open
 * positions (target / stop / time) → new entries (max 3 open, one per symbol).
 * data: [{ symbol, bars: indicators(rows) }]
 */
export function simulate(data, strategy, { r = RULES, mode = 'spec', from = null, to = null, holdToExpiry = false } = {}) {
  const dates = [...new Set(data.flatMap((x) => x.bars.map((b) => b.date)))].sort().filter((d) => (!from || d >= from) && (!to || d <= to));
  const at = new Map(data.map((x) => [x.symbol, new Map(x.bars.map((b) => [b.date, b]))]));
  let equity = r.capital;
  let peak = equity;
  let maxDd = 0;
  const open = [];
  const trades = [];
  const skips = {};
  const curve = [];
  const close = (p, b, reason, dteLeft) => {
    const exitPrice = Math.max(0, spreadValue(p, b.close, dteLeft, b.iv ?? p.entryIv, r.rate));
    const pl = p.kind === 'debit' ? exitPrice - p.entryPrice : p.entryPrice - exitPrice;
    const legsExit = [bs(b.close, p.longStrike, dteLeft, b.iv ?? p.entryIv, p.type, r.rate), bs(b.close, p.shortStrike, dteLeft, b.iv ?? p.entryIv, p.type, r.rate)];
    const costs = positionCosts({ ...p, legsExit }, exitPrice, mode, r);
    const net = pl * p.qty - costs;
    equity += net;
    trades.push({ symbol: p.symbol, strategy: p.strategy, structure: p.side, entryDate: p.entryDate, exitDate: b.date, entrySpot: p.entrySpot, exitSpot: b.close, longStrike: p.longStrike, shortStrike: p.shortStrike, qty: p.qty, entryPrice: p.entryPrice, exitPrice, maxLoss: p.maxLoss, riskRs: p.riskRs, gross: pl * p.qty, costs, net, r: net / p.riskRs, reason, days: daysBetween(p.entryDate, b.date) });
  };
  for (const d of dates) {
    // manage open positions
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      const b = at.get(p.symbol).get(d);
      if (!b) continue;
      const dteLeft = p.dte - daysBetween(p.entryDate, d);
      const v = spreadValue(p, b.close, Math.max(dteLeft, 0), b.iv ?? p.entryIv, r.rate);
      const pl = p.kind === 'debit' ? v - p.entryPrice : p.entryPrice - v;
      // holdToExpiry: no model-priced exits; settle at the real payoff (intrinsic value) on expiry
      const reason = holdToExpiry ? (dteLeft <= 0 ? 'expiry' : null) : pl >= r.targetR * p.maxLoss ? 'target' : pl <= -r.stopR * p.maxLoss ? 'stop' : dteLeft <= r.timeStopDte ? 'time' : null;
      if (reason) {
        close(p, b, reason, Math.max(dteLeft, 0));
        open.splice(k, 1);
      }
    }
    // new entries
    for (const { symbol } of data) {
      if (open.length >= r.maxOpen) break;
      if (open.some((p) => p.symbol === symbol)) continue;
      const b = at.get(symbol).get(d);
      if (!b) continue;
      const sig = strategy === 'momentum-debit' ? debitSignal(b, r) : creditSignal(b, r);
      if (!sig) continue;
      let dte = strategy === 'momentum-debit' ? r.debit.dte : r.credit.dte;
      if (mode === 'realistic') {
        const e = nextMonthlyExpiry(d);
        dte = e ? daysBetween(d, e) : null;
        if (!dte || dte < 7 || dte > 17) { skips['no monthly expiry 7–17 days away'] = (skips['no monthly expiry 7–17 days away'] || 0) + 1; continue; }
      }
      const pos = buildPosition(sig, b, symbol, equity, { r, dte, lot: mode === 'realistic' ? LOTS[symbol] || 1 : 1 });
      if (pos.skip) { const key = pos.skip.replace(/[\d.,₹()]+/g, '#'); skips[key] = (skips[key] || 0) + 1; continue; }
      pos.legsEntry = [bs(b.close, pos.longStrike, dte, b.iv, pos.type, r.rate), bs(b.close, pos.shortStrike, dte, b.iv, pos.type, r.rate)];
      open.push(pos);
    }
    // mark to market
    let mtm = 0;
    for (const p of open) {
      const b = at.get(p.symbol).get(d);
      if (!b) continue;
      const v = spreadValue(p, b.close, Math.max(p.dte - daysBetween(p.entryDate, d), 0), b.iv ?? p.entryIv, r.rate);
      mtm += (p.kind === 'debit' ? v - p.entryPrice : p.entryPrice - v) * p.qty;
    }
    const eq = equity + mtm;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    curve.push({ date: d, equity: eq });
  }
  // end of test: close what is left on its last bar
  for (const p of open) {
    const bars = data.find((x) => x.symbol === p.symbol).bars.filter((b) => b.date <= dates[dates.length - 1]);
    const b = bars[bars.length - 1];
    close(p, b, 'end of test', Math.max(p.dte - daysBetween(p.entryDate, b.date), 0));
  }
  return { trades, finalEquity: equity, maxDrawdown: maxDd, curve, skips, from: dates[0], to: dates[dates.length - 1] };
}

export function summarise(sim, capital = RULES.capital) {
  const t = sim.trades;
  const wins = t.filter((x) => x.net > 0);
  const gw = wins.reduce((a, x) => a + x.net, 0);
  const gl = -t.filter((x) => x.net <= 0).reduce((a, x) => a + x.net, 0);
  const rs = t.map((x) => x.r);
  const m = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1)) : null;
  const yrs = sim.from && sim.to ? (Date.parse(sim.to) - Date.parse(sim.from)) / (365.25 * 86400000) : 0;
  return {
    trades: t.length, from: sim.from, to: sim.to, returnPct: (sim.finalEquity / capital - 1) * 100, cagr: yrs > 0.5 ? (sim.finalEquity / capital) ** (1 / yrs) - 1 : null,
    winRate: t.length ? wins.length / t.length : null, profitFactor: gl > 0 ? gw / gl : null, maxDrawdownPct: sim.maxDrawdown * 100,
    avgR: m, tStat: sd > 0 ? m / (sd / Math.sqrt(rs.length)) : null, costsRs: t.reduce((a, x) => a + x.costs, 0),
    exits: Object.fromEntries(['target', 'stop', 'time', 'expiry', 'end of test'].map((k) => [k, t.filter((x) => x.reason === k).length]).filter(([, n]) => n)),
    skipped: sim.skips,
  };
}

// ---------------------------------------------------------------- data ---
export async function loadData({ loadCandles = candles, symbols = SYMBOLS, from = '2005-01-01', now = new Date() } = {}) {
  return (await mapLimit(symbols, 4, async (symbol) => {
    try {
      const rows = completedOnly((await loadCandles(symbol, { period1: Math.floor(Date.parse(from) / 1000), interval: '1d' })).filter((x) => x.close > 0 && x.high > 0 && x.low > 0), now);
      return rows.length > 120 ? { symbol, bars: indicators(rows) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
}

/**
 * Real-price check: the ivrank-credit logic on NIFTY weekly options with REAL
 * NSE closing prices (cached by vol-premium.mjs), held to expiry. Also compares
 * real NIFTY at-the-money implied vol with the model's "IV" (realised × 1.08).
 */
export async function realNiftyCheck({ loadCandles = candles, foDir = process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav'), r = RULES } = {}) {
  if (!existsSync(foDir)) return null;
  const rows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2017-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0 && x.high > 0);
  const at = new Map(indicators(rows).map((b) => [b.date, b]));
  const close = new Map(rows.map((x) => [x.date, x.close]));
  const ivFrom = (price, spot, k, days, typ) => {
    let lo = 0.01;
    let hi = 2;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (greeks({ spot, strike: k, tYears: days / 365, iv: m, type: typ, rate: r.rate }).price > price) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  };
  const ratio = { high: [], low: [] };
  const trades = [];
  let lastExp = '';
  for (const d of readdirSync(foDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort()) {
    if (d <= lastExp) continue;
    let day = null;
    try {
      day = JSON.parse(readFileSync(join(foDir, `${d}.json`), 'utf8'));
    } catch {
      continue;
    }
    const b = at.get(d);
    if (!day || !b || b.rv == null || b.ivRank == null || b.atr == null) continue;
    const exp = Object.keys(day.expiries).filter((e) => e > d).sort()[0];
    if (!exp || !close.has(exp)) continue;
    lastExp = exp;
    const spot = day.underlying || b.close;
    const ch = day.expiries[exp];
    const days = (Date.parse(exp) - Date.parse(d)) / 86400000;
    const atm = Object.keys(ch).map(Number).reduce((a, k) => (Math.abs(k - spot) < Math.abs(a - spot) ? k : a));
    if (ch[atm]?.CE > 0 && ch[atm]?.PE > 0) (b.ivRank >= r.credit.minRank ? ratio.high : ratio.low).push((ivFrom(ch[atm].CE, spot, atm, days, 'CE') + ivFrom(ch[atm].PE, spot, atm, days, 'PE')) / 2 / b.iv);
    const sig = creditSignal(b, r);
    if (!sig) continue;
    const off = Math.round((r.credit.otmAtr * b.atr) / 50) * 50 || 50;
    const shortK = Math.round((sig.type === 'put' ? spot - off : spot + off) / 50) * 50;
    const longK = sig.type === 'put' ? shortK - 100 : shortK + 100;
    const T = sig.type === 'put' ? 'PE' : 'CE';
    const sp = ch[shortK]?.[T];
    const lp = ch[longK]?.[T];
    if (!(sp > 0) || !(lp > 0)) continue;
    const credit = sp - lp;
    const modelCredit = bs(spot, shortK, days, b.iv, sig.type, r.rate) - bs(spot, longK, days, b.iv, sig.type, r.rate);
    const st = close.get(exp);
    const intr = (k) => (T === 'CE' ? Math.max(st - k, 0) : Math.max(k - st, 0));
    const costs = (4 * 20) / 65 + (sp + lp) * 0.01 + sp * 0.001;
    const pts = credit - (intr(shortK) - intr(longK)) - costs;
    trades.push({ date: d, expiry: exp, type: sig.type, shortStrike: shortK, longStrike: longK, credit, modelCredit, pts, r: pts / (100 - credit) });
  }
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
  const n = trades.length;
  const m = n ? trades.reduce((a, t) => a + t.r, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.r - m) ** 2, 0) / (n - 1)) : null;
  const gw = trades.filter((t) => t.pts > 0).reduce((a, t) => a + t.pts, 0);
  const gl = -trades.filter((t) => t.pts <= 0).reduce((a, t) => a + t.pts, 0);
  return {
    weeks: ratio.high.length + ratio.low.length,
    ivRatioHighRank: med(ratio.high), ivRatioOther: med(ratio.low),
    credit: { trades: n, winRate: n ? trades.filter((t) => t.pts > 0).length / n : null, avgR: m, tStat: sd > 0 ? m / (sd / Math.sqrt(n)) : null, profitFactor: gl > 0 ? gw / gl : null, realOverModelCredit: med(trades.map((t) => t.credit / t.modelCredit)) },
    worst: [...trades].sort((a, b) => a.r - b.r).slice(0, 3),
    note: 'NIFTY weekly options, real NSE closing prices on the session after each expiry, held to expiry; 100-point spread with the short strike about 1 ATR away; ₹20/order, 1% slippage per leg, STT on the sold leg.',
  };
}

/** The document's test (last 2 years, its 8 stocks) plus honesty checks. */
export async function fnoSpreadsTest({ loadCandles = candles, now = new Date(), extraSymbols = null } = {}) {
  const data = await loadData({ loadCandles, now });
  const last = data.reduce((a, x) => (x.bars[x.bars.length - 1].date > a ? x.bars[x.bars.length - 1].date : a), '');
  const twoYears = new Date(Date.parse(last) - 2 * 365.25 * 86400000).toISOString().slice(0, 10);
  const out = { at: new Date().toISOString(), to: last, symbols: data.map((x) => x.symbol), runs: {} };
  const run = (key, label, d, strategy, opts) => {
    const sim = simulate(d, strategy, opts);
    out.runs[key] ||= { label, results: {} };
    out.runs[key].results[strategy] = summarise(sim, opts?.r?.capital);
    return sim;
  };
  const strategies = ['momentum-debit', 'ivrank-credit'];
  const sims = {};
  for (const s of strategies) {
    sims[s] = run('spec2y', 'As written: last 2 years, 8 stocks, Black-Scholes prices, the document\'s costs', data, s, { from: twoYears });
    run('specEarlier', 'As written, earlier years it never saw (2010 → 2 years ago)', data, s, { from: '2010-01-01', to: twoYears });
    run('realistic2y', 'Realistic: monthly expiries, whole NSE lots, Indian charges + 1% slippage (last 2 years)', data, s, { from: twoYears, mode: 'realistic' });
    run('realistic10L', 'Realistic with ₹10 lakh capital (so whole lots fit the 1% risk), last 2 years', data, s, { from: twoYears, mode: 'realistic', r: { ...RULES, capital: 1000000 } });
    run('expiry2y', 'Held to expiry and settled at the real payoff (no model prices on exit), last 2 years', data, s, { from: twoYears, holdToExpiry: true });
    run('expiryEarlier', 'Held to expiry, earlier years (2010 → 2 years ago)', data, s, { from: '2010-01-01', to: twoYears, holdToExpiry: true });
  }
  if (extraSymbols?.length) {
    const other = await loadData({ loadCandles, now, symbols: extraSymbols });
    for (const s of strategies) run('otherStocks', `As written, ${other.length} other NIFTY 50 stocks (last 2 years)`, other, s, { from: twoYears });
  }
  try {
    out.realCheck = await realNiftyCheck({ loadCandles });
  } catch {
    out.realCheck = null;
  }
  out.recentTrades = Object.fromEntries(strategies.map((s) => [s, sims[s].trades.slice(-12).reverse()]));
  out.assumptions = [
    'Credit spreads sell the strike about 1 ATR out of the money (the document does not say how far).',
    'Strike step by price: below ₹500 → 5, below ₹1,500 → 10, below ₹3,000 → 20, else 50.',
    'Costs "brokerage 0.04% + slippage 0.08%" taken as 0.12% of the premium value of every leg, charged on close.',
    'Days to expiry are calendar days; the option "IV" is 20-day realised volatility × 1.08 (as written).',
    'Realistic setting: NSE stock options expire monthly (last Thursday, last Tuesday from Sep 2025), lots are fixed (e.g. RELIANCE 500), ₹20 per order + STT + exchange + GST, 1% slippage per leg per fill.',
  ];
  out.caveat = 'All option prices here come from Black-Scholes with realised volatility, not from real NSE option prices; the model cannot know the volatility risk premium, skew or the wide bid-ask spreads of stock options. A good result is evidence about the model, not about the market.';
  return out;
}

export const saveFnoSpreads = (r) => writeJsonAtomic(SAVED(), r);
const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
export const loadFnoSpreads = () => readJ(SAVED());

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x, d = 1) => (x == null ? '–' : `${x.toFixed(d)}%`);
  {
    const extra = ['LT.NS', 'AXISBANK.NS', 'KOTAKBANK.NS', 'MARUTI.NS', 'SUNPHARMA.NS', 'HINDUNILVR.NS', 'TITAN.NS', 'NTPC.NS', 'BAJFINANCE.NS', 'ASIANPAINT.NS', 'TATAMOTORS.NS', 'M&M.NS'];
    fnoSpreadsTest({ extraSymbols: extra })
      .then((r) => {
        saveFnoSpreads(r);
        console.log(`\nF&O SPREADS (document spec) · data to ${r.to} · ${r.symbols.length} stocks`);
        for (const [, run] of Object.entries(r.runs)) {
          console.log(`\n${run.label}`);
          for (const [s, x] of Object.entries(run.results)) console.log(`  ${s.padEnd(15)} ${String(x.trades).padStart(4)} trades · return ${pc(x.returnPct)} · win ${x.winRate != null ? pc(x.winRate * 100, 0) : '–'} · PF ${x.profitFactor?.toFixed(2) ?? '–'} · max DD ${pc(x.maxDrawdownPct)} · avg ${x.avgR?.toFixed(2) ?? '–'} R (t ${x.tStat?.toFixed(2) ?? '–'}) · exits ${JSON.stringify(x.exits)}${Object.keys(x.skipped).length ? ` · skipped ${JSON.stringify(x.skipped)}` : ''}`);
        }
        const rc = r.realCheck;
        if (rc) console.log(`\nREAL NSE PRICES (NIFTY weekly): real ATM implied vol ÷ model IV = ${rc.ivRatioHighRank?.toFixed(2)} when IV rank ≥ 60 (${rc.ivRatioOther?.toFixed(2)} otherwise) · ivrank-credit with real prices: ${rc.credit.trades} trades · win ${pc(rc.credit.winRate * 100, 0)} · avg ${rc.credit.avgR?.toFixed(2)} R (t ${rc.credit.tStat?.toFixed(2)}) · PF ${rc.credit.profitFactor?.toFixed(2)} · real credit = ${rc.credit.realOverModelCredit?.toFixed(2)} × the model's`);
        console.log(`\n${r.caveat}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
