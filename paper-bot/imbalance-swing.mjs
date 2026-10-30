#!/usr/bin/env node
// Imbalance swing (library + CLI) — the three-step setup from a YouTube interview
// with a fund-managing trader, coded with rules fixed BEFORE testing and tested once:
//   1. Identification move: within the last ~3 months the stock rose ≥ 30% in ≤ 20 sessions
//      on average volume ≥ 3× its normal (the 50 sessions before the move).
//   2. Base: ≥ 5 quiet sessions after the peak, giving back ≤ half the move, on average
//      volume ≤ 70% of the move's (sellers not pressing), never above the peak.
//   3. Entry: a green day closing above the base's high on volume ≥ 1.5× the base average;
//      buy at the next open. Stop at the base low (skip if more than 20% away).
//   "Trade to lose": 1% of capital at risk per trade; stop to breakeven at +1R, then a
//   3-ATR trailing stop from +2R; no profit target.
// Survivorship-free: NSE bhavcopy, each month's 300 most-traded stocks as they were then.
// Volume = traded value ÷ close. Research / paper only — not investment advice.
//
//   node paper-bot/imbalance-swing.mjs           backtest (saved for the card)
//   node paper-bot/imbalance-swing.mjs --paper   paper record + live scan

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { portfolio, summarise } from './ath-swing.mjs';
import { isEtf } from './momentum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.IMBALANCE_SWING_PATH || join(HERE, 'data', 'imbalance-swing.json');

export const RULES = {
  lookback: 60, moveMinPct: 30, moveMaxDays: 20, moveVolX: 3, normalDays: 50,
  baseMinDays: 5, baseMaxGiveBack: 0.5, baseVolMax: 0.7, triggerVolX: 1.5, maxRiskPct: 20,
  breakevenAtR: 1, trailFromR: 2, trailAtr: 3, atr: 14, maxHold: 250, slippagePct: 0.1,
  riskPct: 1, maxOpen: 10, maxPositionPct: 20, capital: 1000000, cashRatePct: 6, universe: 300,
};
export const PERIODS = { dev: ['2010-01-01', '2017-12-31'], val: ['2018-01-01', '2022-12-31'], holdout: ['2023-01-01', '2099-12-31'] };

/** Bars with shares traded (value ÷ close) and ATR. */
export function prepare(rows, r = RULES) {
  const out = rows.map((x) => ({ ...x, vol: x.val > 0 && x.close > 0 ? x.val / x.close : 0 }));
  const tr = [];
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    const pc = i ? out[i - 1].close : b.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
    if (tr.length > r.atr) tr.shift();
    b.atr = tr.length === r.atr ? tr.reduce((a, c) => a + c, 0) / r.atr : null;
  }
  return out;
}
const avg = (bars, a, b, f) => {
  let s = 0;
  for (let k = a; k <= b; k++) s += f(bars[k]);
  return s / (b - a + 1);
};

/** The setup at bar i (the trigger day), or null. Uses bars up to i only. With { forming: true }: steps 1–2 only (a base waiting for the trigger, today included in the base). */
export function setupAt(bars, i, r = RULES, { forming = false } = {}) {
  const t = bars[i];
  if (!forming && !(t.close > t.open)) return null;
  // the peak: the highest high in the look-back, at least baseMinDays sessions before today
  let p = -1;
  const last = forming ? i - r.baseMinDays : i - r.baseMinDays - 1;
  for (let k = Math.max(1, i - r.lookback); k <= last; k++) if (p < 0 || bars[k].high > bars[p].high) p = k;
  if (p < 0) return null;
  // the move: the lowest low in the moveMaxDays sessions before the peak
  let s = -1;
  for (let k = Math.max(0, p - r.moveMaxDays); k < p; k++) if (s < 0 || bars[k].low <= bars[s].low) s = k; // the latest of equal lows: the move starts there
  if (s < r.normalDays) return null;
  const move = bars[p].high / bars[s].low - 1;
  if (move < r.moveMinPct / 100) return null;
  const normalVol = avg(bars, s - r.normalDays, s - 1, (b) => b.vol);
  const moveVol = avg(bars, s + 1, p, (b) => b.vol);
  if (!(normalVol > 0) || moveVol < r.moveVolX * normalVol) return null;
  // the base: after the peak up to yesterday
  let baseHigh = -Infinity;
  let baseLow = Infinity;
  const baseEnd = forming ? i : i - 1;
  for (let k = p + 1; k <= baseEnd; k++) {
    baseHigh = Math.max(baseHigh, bars[k].high);
    baseLow = Math.min(baseLow, bars[k].low);
  }
  if (baseHigh > bars[p].high) return null; // already broke out
  baseLow = Math.min(baseLow, t.low);
  const giveBack = (bars[p].high - baseLow) / (bars[p].high - bars[s].low);
  if (giveBack > r.baseMaxGiveBack) return null;
  const baseVol = avg(bars, p + 1, baseEnd, (b) => b.vol);
  if (baseVol > r.baseVolMax * moveVol) return null;
  if (forming) return { moveStart: bars[s].date, peak: bars[p].date, movePct: move * 100, moveVolX: moveVol / normalVol, baseDays: i - p, giveBack, baseVolRatio: baseVol / moveVol, baseHigh, baseLow, triggerAbove: baseHigh, triggerVol: r.triggerVolX * baseVol };
  // the trigger: renewed strength out of the base
  if (!(t.close > baseHigh) || t.vol < r.triggerVolX * baseVol) return null;
  return { moveStart: bars[s].date, peak: bars[p].date, movePct: move * 100, moveVolX: moveVol / normalVol, baseDays: i - p - 1, giveBack, baseVolRatio: baseVol / moveVol, baseHigh, baseLow };
}

const costPct = (entry, exit) => {
  const q = 1000;
  return (orderCharges({ side: 'buy', value: entry * q, product: 'delivery', costs: DEFAULT_COSTS }).total + orderCharges({ side: 'sell', value: exit * q, product: 'delivery', costs: DEFAULT_COSTS }).total) / (entry * q);
};

/** All trades for one stock (one at a time); `eligible(date)` limits signals to the point-in-time universe. */
export function tradesFor(symbol, rows, r = RULES, eligible = () => true) {
  const bars = prepare(rows, r);
  const out = [];
  const slip = r.slippagePct / 100;
  for (let i = r.normalDays + r.moveMaxDays; i + 1 < bars.length; i++) {
    if (!eligible(bars[i].date)) continue;
    const sig = setupAt(bars, i, r);
    if (!sig) continue;
    const e = bars[i + 1];
    const entry = e.open * (1 + slip);
    const stop0 = sig.baseLow;
    const risk = entry - stop0;
    if (!(risk > 0) || risk / entry > r.maxRiskPct / 100) continue;
    let stop = stop0;
    let hh = e.high;
    let exit = null;
    let exitIdx = null;
    let reason = null;
    for (let k = i + 1; k < bars.length; k++) {
      const c = bars[k];
      if (k > i + 1 && c.open <= stop) {
        exit = c.open;
        exitIdx = k;
        reason = stop >= entry ? 'breakeven / trail (gap)' : 'stop (gap)';
        break;
      }
      if (c.low <= stop) {
        exit = Math.min(stop, c.open);
        exitIdx = k;
        reason = stop > stop0 ? (stop >= entry && hh < entry + r.trailFromR * risk ? 'breakeven' : 'trailing stop') : 'initial stop';
        break;
      }
      hh = Math.max(hh, c.high);
      if (hh >= entry + r.breakevenAtR * risk) stop = Math.max(stop, entry);
      if (hh >= entry + r.trailFromR * risk && c.atr) stop = Math.max(stop, hh - r.trailAtr * c.atr);
      if (k - (i + 1) >= r.maxHold && k + 1 < bars.length) {
        exit = bars[k + 1].open;
        exitIdx = k + 1;
        reason = 'max hold';
        break;
      }
    }
    const open = exit == null;
    if (open) {
      exit = bars.at(-1).close;
      exitIdx = bars.length - 1;
      reason = 'open';
    }
    const exitFill = exit * (1 - slip);
    const retPct = exitFill / entry - 1 - costPct(entry, exitFill);
    out.push({ symbol, signalDate: bars[i].date, entryDate: e.date, exitDate: bars[exitIdx].date, entry, stop: stop0, exit: exitFill, reason, open, days: exitIdx - (i + 1), riskPct: risk / entry, retPct, r: (retPct * entry) / risk, trail: stop, ...sig });
    i = exitIdx;
  }
  return out;
}

/** The interview's measures: win rate, average win ÷ average loss, largest winner vs loser, skew, losses ≥ 30. */
export function measures(trades) {
  const done = trades.filter((t) => !t.open);
  const s = summarise(done);
  if (!done.length) return s;
  const wins = done.filter((t) => t.r > 0);
  const losses = done.filter((t) => t.r <= 0);
  const m = done.reduce((a, t) => a + t.r, 0) / done.length;
  const sd = Math.sqrt(done.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, done.length - 1));
  const skew = sd > 0 ? done.reduce((a, t) => a + ((t.r - m) / sd) ** 3, 0) / done.length : null;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.r, 0) / wins.length : 0;
  const avgLoss = losses.length ? -losses.reduce((a, t) => a + t.r, 0) / losses.length : 0;
  return { ...s, losses: losses.length, avgWinR: avgWin, avgLossR: avgLoss, winLossRatio: avgLoss > 0 ? avgWin / avgLoss : null, skew, enoughLosses: losses.length >= 30 };
}

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const saveImbalanceSwing = (r) => writeJsonAtomic(SAVED(), r);
export const loadImbalanceSwing = () => readJ(SAVED());
const PAPER = () => process.env.IMBALANCE_SWING_PAPER_PATH || join(HERE, 'data', 'imbalance-swing-paper.json');
export const loadImbalancePaper = () => readJ(PAPER());

/**
 * Paper record + live scan from the NSE daily files (run each evening after they are added):
 * every trade the rules take from the start date (recomputed from the data, so it can't drift),
 * today's entry signals (bought at the next open on paper) and setups still forming.
 */
export function imbalancePaper(series, uni, { startedAt, r = RULES } = {}) {
  const lastDate = [...series.values()].reduce((a, rows) => (rows.length && rows.at(-1).date > a ? rows.at(-1).date : a), '');
  const latest = uni.get(lastDate.slice(0, 7)) || uni.get([...uni.keys()].sort().at(-1)) || new Set();
  const trades = [];
  const triggered = [];
  const forming = [];
  for (const [sym, rows] of series) {
    if (isEtf(sym) || rows.length < 100) continue;
    for (const t of tradesFor(sym, rows.filter((x) => x.date >= addDays(startedAt, -200)), r, (d) => d >= startedAt && uni.get(d.slice(0, 7))?.has(sym))) trades.push(t);
    if (!latest.has(sym) || rows.at(-1).date !== lastDate) continue;
    const bars = prepare(rows.slice(-200), r);
    const i = bars.length - 1;
    const sig = setupAt(bars, i, r);
    if (sig && (bars[i].close - sig.baseLow) / bars[i].close <= r.maxRiskPct / 100) triggered.push({ symbol: sym, close: bars[i].close, stop: sig.baseLow, riskPct: ((bars[i].close - sig.baseLow) / bars[i].close) * 100, ...sig });
    else {
      const f = setupAt(bars, i, r, { forming: true });
      if (f) forming.push({ symbol: sym, close: bars[i].close, ...f });
    }
  }
  trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  return { startedAt, lastDate, trades, summary: measures(trades), scan: { date: lastDate, triggered, forming: forming.sort((a, b) => b.movePct - a.movePct).slice(0, 20) } };
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function imbalancePaperUpdate({ now = new Date() } = {}) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const series = loadSeries();
  const uni = pointInTimeUniverse(series, RULES.universe);
  const startedAt = loadImbalancePaper()?.startedAt || new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = { ...imbalancePaper(series, uni, { startedAt }), updatedAt: now.toISOString() };
  writeJsonAtomic(PAPER(), st);
  return st;
}

export async function imbalanceSwingTest({ loadCandles = candles, r = RULES } = {}) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const series = loadSeries();
  if (!series.size) throw new Error('No NSE history yet: run node paper-bot/bhav-history.mjs first.');
  const uni = pointInTimeUniverse(series, r.universe);
  const trades = [];
  for (const [sym, rows] of series) {
    if (isEtf(sym) || rows.length < 100) continue;
    trades.push(...tradesFor(sym, rows, r, (d) => uni.get(d.slice(0, 7))?.has(sym)));
  }
  const tested = trades.filter((t) => t.entryDate >= PERIODS.dev[0]);
  const lastBhav = [...series.values()].reduce((a, rows) => (rows.length && rows.at(-1).date > a ? rows.at(-1).date : a), '');
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2009-06-01') / 1000), interval: '1d' })).filter((x) => x.close > 0 && x.date <= lastBhav);
  const days = nifty.map((x) => x.date);
  const closeMaps = new Map();
  const closes = (s) => {
    if (!closeMaps.has(s)) closeMaps.set(s, new Map((series.get(s) || []).map((x) => [x.date, x.close])));
    return closeMaps.get(s);
  };
  const byPeriod = {};
  for (const [p, [a, b]] of Object.entries(PERIODS)) {
    const tp = tested.filter((t) => t.entryDate >= a && t.entryDate <= b);
    const pf = tp.length ? portfolio(tp, r, { closes, days: days.filter((d) => d >= a && d <= b) }) : null;
    const yrs = pf?.curve?.length > 1 ? (Date.parse(pf.curve.at(-1).date) - Date.parse(pf.curve[0].date)) / (365.25 * 86400000) : 0;
    let peak = -Infinity;
    let dd = 0;
    for (const c of pf?.curve || []) {
      peak = Math.max(peak, c.equity);
      dd = Math.max(dd, 1 - c.equity / peak);
    }
    const n = nifty.filter((x) => x.date >= a && x.date <= b);
    const nyrs = n.length > 1 ? (Date.parse(n.at(-1).date) - Date.parse(n[0].date)) / (365.25 * 86400000) : 0;
    byPeriod[p] = {
      ...measures(tp), perYear: yrs > 0 ? tp.length / yrs : null,
      cagr: yrs > 0 ? (pf.curve.at(-1).equity / r.capital) ** (1 / yrs) - 1 : null, maxDrawdown: dd, timeInMarket: pf?.timeInMarket ?? null,
      niftyCagr: nyrs > 0 ? (n.at(-1).close / n[0].close) ** (1 / nyrs) * 1.012 - 1 : null,
    };
  }
  const all = measures(tested);
  const v = byPeriod;
  const passed = ['dev', 'val', 'holdout'].every((p) => v[p].avgR > 0) && (all.tStat ?? 0) >= 2 && ['dev', 'val', 'holdout'].every((p) => v[p].losses >= 30);
  const pc = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  return {
    at: new Date().toISOString(), from: tested[0]?.entryDate, to: lastBhav, rules: r, periods: PERIODS, all, byPeriod, passed,
    verdict: `${passed ? 'Passed' : 'Did not pass'}: ${all.trades} trades, won ${pc(all.winRate)}, ${all.avgR?.toFixed(2)} R a trade after charges (t ${all.tStat?.toFixed(1)}). By period (2010–17 / 2018–22 / 2023→): ${['dev', 'val', 'holdout'].map((p) => `${v[p].avgR?.toFixed(2)} R`).join(' / ')}; at 1% risk ${['dev', 'val', 'holdout'].map((p) => pc(v[p].cagr)).join(' / ')} a year vs NIFTY ${['dev', 'val', 'holdout'].map((p) => pc(v[p].niftyCagr)).join(' / ')}.`,
    recent: tested.slice().sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, 15),
    best: tested.filter((t) => !t.open).sort((a, b) => b.r - a.r).slice(0, 5),
    note: 'Rules fixed before testing, tested once (no tuning). Survivorship-free NSE daily data, each month’s 300 most-traded stocks; delivery charges + 0.1% slippage a side; 1% of capital at risk, up to 10 positions, ≤ 20% of capital each, idle cash at 6%. Before tax. The interviewer’s own screen uses 1-minute volume, which this app does not have for past years; daily volume is used instead. Research only.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--paper')) {
      const st = await imbalancePaperUpdate();
      console.log(`Imbalance swing paper: since ${st.startedAt} · ${st.trades.length} trade(s) · signals at ${st.scan.date}: ${st.scan.triggered.map((x) => x.symbol).join(', ') || 'none'} · forming: ${st.scan.forming.length}`);
      process.exit(0);
    }
    const r = await imbalanceSwingTest();
    saveImbalanceSwing(r);
    const f = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
    for (const [p, x] of Object.entries(r.byPeriod)) console.log(`${p.padEnd(8)} trades ${x.trades} (${f(x.perYear, 0)}/yr) · won ${f(x.winRate * 100, 0)}% · avg ${f(x.avgR)} R (t ${f(x.tStat, 1)}) · avg win ${f(x.avgWinR)} R / avg loss ${f(x.avgLossR)} R · best ${f(x.bestR, 1)} R worst ${f(x.worstR, 1)} R · losses ${x.losses} · skew ${f(x.skew, 1)} · 1% risk: ${f(x.cagr * 100, 1)}%/yr, fall ${f(x.maxDrawdown * 100, 0)}% · NIFTY ${f(x.niftyCagr * 100, 1)}%`);
    console.log(r.verdict);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
