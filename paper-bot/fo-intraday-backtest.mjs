#!/usr/bin/env node
// NIFTY options on REAL 5-minute option prices (library + CLI), weekly expiries 2020 → now (Groww backtesting data).
// Fixed before the first run (no tuning afterwards); 2020–22 vs 2023 → judged once:
//   A. Short strangle 2% out of the money, sold at 15:15 on the first session after each weekly expiry:
//      held to expiry, or with a stop-loss when the two options together cost 2× the credit (checked every 5 minutes).
//   B. Iron condor: the same strangle + bought wings 500 points farther out; held, or the same stop-loss.
//   C. Debit spread: buy the at-the-money option, sell one 1% out (calls when NIFTY is above its 200-day average,
//      puts below); held to expiry, or take profit at half the maximum profit / stop at half the cost.
//   D. Intraday option buying on the opening-range breakout: NIFTY's 9:15–9:30 range; the first 5-minute close above
//      it (by 14:30) buys the at-the-money call of the next weekly expiry (below → the put); stop −30%, target +60%,
//      else sold at 15:15. One trade a day.
// Prices are 5-minute closes (an untraded option keeps its last price); exits happen at the close of the bar that
// triggers them; charges = the app's F&O cost model (brokerage, STT, exchange, GST, slippage; STT on exercise).
// ₹ use today's NIFTY lot (65). Research only.
//
//   node --max-old-space-size=8000 paper-bot/fo-intraday-backtest.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { readHist } from './groww-history.mjs';
import { expiries, contracts, fnoCandles } from './groww-fno.mjs';
import { legCost, wingCost, LOT_NOW, sttExercise } from './fo-strangle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.FO_INTRADAY_PATH || join(HERE, 'data', 'fo-intraday-test.json');
export const SPLIT = '2023-01-01';
export const loadFoIntradayTest = () => {
  try {
    return JSON.parse(readFileSync(SAVED(), 'utf8'));
  } catch {
    return null;
  }
};

/** Nearest listed strike to `target` that has a `type` contract (optionally only above / below `limit`). */
export function nearestStrike(chain, target, type, { above = null, below = null } = {}) {
  let best = null;
  for (const k of Object.keys(chain).map(Number)) {
    if (!chain[k][type]) continue;
    if (above != null && !(k > above)) continue;
    if (below != null && !(k < below)) continue;
    if (best == null || Math.abs(k - target) < Math.abs(best - target)) best = k;
  }
  return best;
}
/** Last close at or before `ts` from a bar list (null if none, or if `sameDay` and it is from another day). */
export function priceAt(bars, ts, sameDay = null) {
  let lo = 0;
  let hi = bars.length - 1;
  let at = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].ts <= ts) {
      at = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  if (at < 0) return null;
  if (sameDay && bars[at].date.slice(0, 10) !== sameDay) return null;
  return bars[at].close;
}
const intr = (type, k, s) => (type === 'CE' ? Math.max(s - k, 0) : Math.max(k - s, 0));

/**
 * One multi-leg position along a timeline of NIFTY bars. legs: [{ type, k, q (+1 bought / −1 sold), bars }].
 * exitRule(value, entryValue) → true to exit at that bar. Returns points per unit after charges.
 */
export function runPosition({ legs, entryTs, entryDay, timeline, settle, date, exitRule = null }) {
  const p0 = legs.map((l) => priceAt(l.bars, entryTs, entryDay));
  if (p0.some((p) => !(p > 0))) return null;
  const entryValue = legs.reduce((a, l, i) => a + l.q * p0[i], 0); // + paid (debit) / − received (credit)
  const entryCost = legs.reduce((a, l, i) => a + (l.q < 0 ? legCost(p0[i], date) : wingCost(p0[i], date)), 0);
  if (exitRule) {
    for (const b of timeline) {
      const px = legs.map((l) => priceAt(l.bars, b.ts));
      if (px.some((p) => p == null)) continue;
      const value = legs.reduce((a, l, i) => a + l.q * px[i], 0);
      if (exitRule(value, entryValue)) {
        const exitCost = legs.reduce((a, l, i) => a + (l.q > 0 ? legCost(px[i], date) : wingCost(px[i], date)), 0);
        return { pts: value - entryValue - entryCost - exitCost, how: 'exit', at: b.date };
      }
    }
  }
  const value = legs.reduce((a, l) => a + l.q * intr(l.type, l.k, settle), 0);
  const exerciseStt = legs.reduce((a, l) => a + (l.q > 0 ? (intr(l.type, l.k, settle) * sttExercise(date)) / 100 : 0), 0);
  return { pts: value - entryValue - entryCost - exerciseStt, how: 'expiry', at: null };
}

export function summary(trades) {
  const s = (xs) => {
    const v = xs.map((t) => t.rs);
    const n = v.length;
    if (!n) return { trades: 0 };
    const m = v.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
    const sorted = [...v].sort((a, b) => a - b);
    return { trades: n, winRate: v.filter((x) => x > 0).length / n, total: m * n, avg: m, tStat: sd ? m / (sd / Math.sqrt(n)) : null, worst: sorted[0], best: sorted.at(-1), exits: xs.filter((t) => t.how === 'exit').length };
  };
  const byYear = {};
  for (const t of trades) (byYear[t.date.slice(0, 4)] ||= []).push(t);
  return { all: s(trades), early: s(trades.filter((t) => t.date < SPLIT)), late: s(trades.filter((t) => t.date >= SPLIT)), byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, v]) => [y, s(v)])) };
}

export async function foIntradayTest({ now = new Date(), loadCandles = candles, onProgress = () => {} } = {}) {
  const N = readHist('^NSEI');
  if (!N.length) throw new Error('No NIFTY 5-minute history: run node paper-bot/groww-history.mjs ^NSEI first.');
  const byDay = new Map();
  for (const b of N) {
    const d = b.date.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  const days = [...byDay.keys()].sort();
  const lastDay = days.at(-1);
  // 200-day average from daily closes (Yahoo, from 2019 so it is ready by 2020)
  const daily = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2019-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const smaBefore = (d) => {
    const c = daily.filter((x) => x.date < d).slice(-200).map((x) => x.close);
    return c.length === 200 ? c.reduce((a, b) => a + b, 0) / 200 : null;
  };
  const prevClose = (d) => daily.filter((x) => x.date < d).at(-1)?.close ?? null;
  let exps = [];
  for (let y = 2020; y <= Number(lastDay.slice(0, 4)); y++) exps.push(...(await expiries('NIFTY', y)));
  exps = [...new Set(exps)].filter((e) => e <= lastDay && byDay.has(e)).sort();

  const res = { strangle: [], strangleStop: [], condor: [], condorStop: [], spread: [], spreadExit: [], orb: [] };
  const timelineFrom = (ts, untilDay) => N.filter((b) => b.ts > ts && b.date.slice(0, 10) <= untilDay);
  // A–C: one position a week
  for (let i = 1; i < exps.length; i++) {
    const exp = exps[i];
    const entryDay = days.find((d) => d > exps[i - 1]);
    if (!entryDay || entryDay >= exp) continue;
    const eb = byDay.get(entryDay);
    const entry = eb.find((b) => b.date.endsWith('15:15')) || eb.at(-1);
    const S = entry.close;
    const settle = byDay.get(exp).at(-1).close;
    const chain = await contracts('NIFTY', exp);
    if (!Object.keys(chain).length) continue;
    const timeline = timelineFrom(entry.ts, exp);
    const legBars = async (k, type) => (k == null ? null : fnoCandles(chain[k][type], entryDay, exp));
    const base = { entryTs: entry.ts, entryDay, timeline, settle, date: entryDay };
    const push = (key, r, extra = {}) => r && res[key].push({ date: entryDay, expiry: exp, pts: r.pts, rs: r.pts * LOT_NOW, how: r.how, ...extra });
    // A / B
    const kc = nearestStrike(chain, S * 1.02, 'CE', { above: S });
    const kp = nearestStrike(chain, S * 0.98, 'PE', { below: S });
    if (kc != null && kp != null) {
      const ce = await legBars(kc, 'CE');
      const pe = await legBars(kp, 'PE');
      const legs = [{ type: 'CE', k: kc, q: -1, bars: ce }, { type: 'PE', k: kp, q: -1, bars: pe }];
      const stop = (value, entryValue) => -value >= 2 * -entryValue; // cost to buy back ≥ 2 × the credit
      push('strangle', runPosition({ ...base, legs }), { strikes: `${kp}/${kc}` });
      push('strangleStop', runPosition({ ...base, legs, exitRule: stop }), { strikes: `${kp}/${kc}` });
      const wc = nearestStrike(chain, kc + 500, 'CE', { above: kc });
      const wp = nearestStrike(chain, kp - 500, 'PE', { below: kp });
      if (wc != null && wp != null) {
        const legs4 = [...legs, { type: 'CE', k: wc, q: 1, bars: await legBars(wc, 'CE') }, { type: 'PE', k: wp, q: 1, bars: await legBars(wp, 'PE') }];
        push('condor', runPosition({ ...base, legs: legs4 }), { strikes: `${wp}/${kp}/${kc}/${wc}` });
        push('condorStop', runPosition({ ...base, legs: legs4, exitRule: stop }), { strikes: `${wp}/${kp}/${kc}/${wc}` });
      }
    }
    // C
    const sma = smaBefore(entryDay);
    const pc = prevClose(entryDay);
    if (sma && pc) {
      const up = pc > sma;
      const type = up ? 'CE' : 'PE';
      const k1 = nearestStrike(chain, S, type);
      const k2 = up ? nearestStrike(chain, S * 1.01, type, { above: k1 }) : nearestStrike(chain, S * 0.99, type, { below: k1 });
      if (k1 != null && k2 != null) {
        const legs = [{ type, k: k1, q: 1, bars: await legBars(k1, type) }, { type, k: k2, q: -1, bars: await legBars(k2, type) }];
        const width = Math.abs(k2 - k1);
        const tpsl = (value, cost) => value >= cost + 0.5 * (width - cost) || value <= 0.5 * cost;
        push('spread', runPosition({ ...base, legs }), { side: up ? 'call' : 'put' });
        push('spreadExit', runPosition({ ...base, legs, exitRule: tpsl }), { side: up ? 'call' : 'put' });
      }
    }
    onProgress({ week: exp, i, of: exps.length - 1 });
  }
  // D: intraday opening-range breakout, one trade a day
  for (const d of days) {
    const bars = byDay.get(d);
    if (bars.length < 70) continue;
    const or = bars.filter((b) => b.date.slice(11) <= '09:25');
    if (or.length < 3) continue;
    const hi = Math.max(...or.map((b) => b.high));
    const lo = Math.min(...or.map((b) => b.low));
    const trig = bars.find((b) => b.date.slice(11) >= '09:30' && b.date.slice(11) <= '14:30' && (b.close > hi || b.close < lo));
    if (!trig) continue;
    const type = trig.close > hi ? 'CE' : 'PE';
    const exp = exps.find((e) => e > d);
    if (!exp) continue;
    const chain = await contracts('NIFTY', exp);
    const k = nearestStrike(chain, trig.close, type);
    if (k == null) continue;
    const ob = await fnoCandles(chain[k][type], d, d);
    const e = priceAt(ob, trig.ts, d);
    if (!(e > 0)) continue;
    let x = null;
    for (const b of ob.filter((b) => b.ts > trig.ts && b.date.slice(11) <= '15:15')) {
      x = b.close;
      if (b.close <= e * 0.7 || b.close >= e * 1.6) break;
    }
    if (x == null) continue;
    const pts = x - e - wingCost(e, d) - legCost(x, d);
    res.orb.push({ date: d, pts, rs: pts * LOT_NOW, how: x <= e * 0.7 ? 'stop' : x >= e * 1.6 ? 'target' : '15:15', side: type });
    if (res.orb.length % 50 === 0) onProgress({ orbDay: d, trades: res.orb.length });
  }
  const LABELS = {
    strangle: 'A. Short strangle 2% out, held to expiry', strangleStop: 'A. Short strangle, stop at 2× the credit',
    condor: 'B. Iron condor (+500-point wings), held', condorStop: 'B. Iron condor, stop at 2× the credit',
    spread: 'C. Debit spread (trend side), held to expiry', spreadExit: 'C. Debit spread, take profit ½ max / stop ½ cost',
    orb: 'D. Intraday option buying, opening-range breakout',
  };
  const out = { at: now.toISOString(), from: days[0], to: lastDay, weeks: exps.length - 1, lot: LOT_NOW, split: SPLIT, results: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { label: LABELS[k], ...summary(v) }])) };
  writeJsonAtomic(SAVED(), out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v || 0)).toLocaleString('en-IN')}`;
  try {
    const r = await foIntradayTest({ onProgress: (p) => console.error(JSON.stringify(p)) });
    console.log(`NIFTY options on real 5-minute prices, ${r.from} → ${r.to} (${r.weeks} weekly expiries), 1 lot of ${r.lot}, after charges:`);
    for (const x of Object.values(r.results)) console.log(`  ${x.label.padEnd(52)} ${String(x.all.trades).padStart(5)} trades · won ${Math.round((x.all.winRate || 0) * 100)}% · ${rs(x.all.total)} (avg ${rs(x.all.avg)}, t ${x.all.tStat?.toFixed(2)}) · worst ${rs(x.all.worst)} · 2020–22 ${rs(x.early.total)} · 2023→ ${rs(x.late.total)}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
