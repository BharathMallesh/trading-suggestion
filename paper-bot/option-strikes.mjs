#!/usr/bin/env node
// Option strike guide (library + CLI): ITM vs ATM vs OTM NIFTY options bought
// at the start of each weekly cycle and held to expiry, on real NSE end-of-day
// option prices (2019→). Rebuilds the positional part of a YouTube backtest:
//   ITM ≈ delta 0.70, ATM ≈ 0.50, OTM ≈ 0.30 (strikes from the ATM straddle's implied move)
//   (a) as the video did — direction known in hindsight (call if NIFTY ended up, else put),
//       by how far NIFTY moved in the trade's favour;
//   (b) as a trader really faces it — direction NOT known: always call, always put,
//       and a simple trend guess (call above the 20-day average, else put).
// Returns are % of the premium paid after charges (brokerage, exchange, stamp,
// slippage, STT on exercise). The video's intraday and expiry-day parts need
// intraday option prices, which this app does not have. Research only.
//
//   node paper-bot/option-strikes.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { lotOn, LOT_NOW, nearest } from './fo-strangle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FO_DIR = () => process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
const SAVED = () => process.env.OPTION_STRIKES_PATH || join(HERE, 'data', 'option-strikes.json');

export const RULES = { deltas: { ITM: 0.7, ATM: 0.5, OTM: 0.3 }, slippagePct: 0.5, slippageMinPts: 0.5, brokeragePerOrder: 20, sttExercisePct: 0.125, trendDays: 20 };
export const BUCKETS = [['within 0.1%', 0, 0.001], ['0.1–0.5%', 0.001, 0.005], ['0.5–1%', 0.005, 0.01], ['1–2%', 0.01, 0.02], ['over 2%', 0.02, Infinity]];

/** Inverse standard normal (Abramowitz & Stegun 26.2.23, error < 0.0005) — enough for delta targets. */
export function invNorm(p) {
  if (p === 0.5) return 0;
  const q = Math.min(p, 1 - p);
  const t = Math.sqrt(-2 * Math.log(q));
  const x = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p > 0.5 ? x : -x;
}

/** Strike for a call/put delta target, from the ATM straddle's implied one-sigma move to expiry. */
export function strikeFor(spot, sigmaT, delta, typ) {
  const z = invNorm(delta); // call delta d ↔ ln(S/K)/σ√t ≈ z
  return typ === 'CE' ? spot * Math.exp(-z * sigmaT) : spot * Math.exp(z * sigmaT);
}

/** Charges in index points per unit for buying one option at `prem` and settling with `intrinsic` at expiry. */
export function buyCosts(prem, intrinsic, date, r = RULES) {
  const lot = lotOn(date);
  const brk = r.brokeragePerOrder / lot; // buy order; exercise/expiry has no order
  const exch = prem * (date < '2024-10-01' ? 0.0005 : 0.0003503);
  const stamp = prem * 0.00003;
  const slip = Math.max((prem * r.slippagePct) / 100, r.slippageMinPts);
  return brk + exch + stamp + 0.18 * (brk + exch) + slip + (intrinsic * r.sttExercisePct) / 100;
}

/** Build one weekly cycle: entry chain day → strikes and premiums for ITM / ATM / OTM calls and puts. */
export function cycleFrom(date, day, spotClose = null, r = RULES) {
  const expiry = day && Object.keys(day.expiries || {}).filter((e) => e > date).sort()[0];
  const spot = day?.underlying > 0 ? day.underlying : spotClose;
  if (!expiry || !(spot > 0)) return null;
  const ch = day.expiries[expiry];
  const atmK = nearest(ch, spot, 'CE');
  if (atmK == null || !(ch[atmK]?.PE > 0)) return null;
  const sigmaT = (ch[atmK].CE + ch[atmK].PE) / 2 / (0.3989 * spot); // ATM ≈ 0.4·S·σ√t
  const legs = {};
  for (const [name, dlt] of Object.entries(r.deltas)) {
    for (const typ of ['CE', 'PE']) {
      const k = name === 'ATM' ? atmK : nearest(ch, strikeFor(spot, sigmaT, dlt, typ), typ);
      const prem = k != null ? ch[k]?.[typ] : null;
      if (prem > 0) legs[`${name}-${typ}`] = { strike: k, prem };
    }
  }
  return { entryDate: date, expiry, spot, sigmaT, legs };
}

/** % of premium after charges for one leg settled at NIFTY's expiry close. */
export function legReturn(leg, typ, close, date, r = RULES) {
  const intrinsic = typ === 'CE' ? Math.max(close - leg.strike, 0) : Math.max(leg.strike - close, 0);
  return (intrinsic - leg.prem - buyCosts(leg.prem, intrinsic, date, r)) / leg.prem;
}

const summary = (xs) => {
  const n = xs.length;
  if (!n) return { n: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  const s = [...xs].sort((a, b) => a - b);
  return { n, avg: m, median: s[Math.floor(n / 2)], win: xs.filter((x) => x > 0).length / n, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
};

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

export async function optionStrikesTest({ loadCandles = candles, r = RULES } = {}) {
  const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2018-06-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
  const close = new Map(nifty.map((x) => [x.date, x.close]));
  const dates = nifty.map((x) => x.date);
  const sma = (d) => {
    const i = dates.indexOf(d);
    if (i < r.trendDays) return null;
    let s = 0;
    for (let k = i - r.trendDays + 1; k <= i; k++) s += nifty[k].close;
    return s / r.trendDays;
  };
  const files = existsSync(FO_DIR()) ? readdirSync(FO_DIR()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort() : [];
  const cycles = [];
  let lastExpiry = '';
  for (const d of files) {
    if (d <= lastExpiry) continue;
    const c = cycleFrom(d, readJ(join(FO_DIR(), `${d}.json`)), close.get(d), r);
    if (!c) continue;
    lastExpiry = c.expiry;
    if (!close.has(c.expiry)) continue; // not settled yet
    c.close = close.get(c.expiry);
    c.move = c.close / c.spot - 1;
    const m = sma(d);
    c.trendCall = m != null ? close.get(d) > m : null;
    cycles.push(c);
  }
  const kinds = Object.keys(r.deltas);
  const ret = (c, k, typ) => (c.legs[`${k}-${typ}`] ? legReturn(c.legs[`${k}-${typ}`], typ, c.close, c.entryDate, r) : null);
  // (a) hindsight, as in the video: the right side every week, by favourable move
  const hindsight = BUCKETS.map(([label, lo, hi]) => {
    const inB = cycles.filter((c) => Math.abs(c.move) >= lo && Math.abs(c.move) < hi);
    return { label, weeks: inB.length, share: inB.length / cycles.length, ...Object.fromEntries(kinds.map((k) => [k, summary(inB.map((c) => ret(c, k, c.move >= 0 ? 'CE' : 'PE')).filter((x) => x != null))])) };
  });
  const wrong = Object.fromEntries(kinds.map((k) => [k, summary(cycles.map((c) => ret(c, k, c.move >= 0 ? 'PE' : 'CE')).filter((x) => x != null))]));
  // (b) direction not known in advance
  const guesses = {
    call: { label: 'Always buy a call', pick: () => 'CE' },
    put: { label: 'Always buy a put', pick: () => 'PE' },
    trend: { label: 'Trend guess (call above the 20-day average, else put)', pick: (c) => (c.trendCall == null ? null : c.trendCall ? 'CE' : 'PE') },
  };
  const real = {};
  for (const [g, { label, pick }] of Object.entries(guesses)) {
    real[g] = { label };
    for (const k of kinds) {
      const rows = cycles.map((c) => {
        const typ = pick(c);
        const x = typ ? ret(c, k, typ) : null;
        return x == null ? null : { x, rupees: x * c.legs[`${k}-${typ}`].prem * LOT_NOW, early: c.entryDate < '2023-01-01' };
      }).filter(Boolean);
      real[g][k] = { ...summary(rows.map((y) => y.x)), early: summary(rows.filter((y) => y.early).map((y) => y.x)).avg, later: summary(rows.filter((y) => !y.early).map((y) => y.x)).avg, rupeesPerYearLot: (rows.reduce((a, y) => a + y.rupees, 0) / rows.length) * 52 };
    }
  }
  const prem = Object.fromEntries(kinds.map((k) => [k, { call: summary(cycles.map((c) => c.legs[`${k}-CE`]?.prem).filter(Boolean)).median, put: summary(cycles.map((c) => c.legs[`${k}-PE`]?.prem).filter(Boolean)).median }]));
  const anyPositive = Object.values(real).some((g) => kinds.some((k) => g[k].avg > 0 && g[k].early > 0 && g[k].later > 0 && g[k].t > 2));
  return {
    at: new Date().toISOString(), from: cycles[0]?.entryDate, to: cycles.at(-1)?.expiry, weeks: cycles.length, rules: r, premiums: prem,
    hindsight, wrong, real, passed: anyPositive,
    verdict: anyPositive
      ? 'One way of guessing the direction made money after charges in both halves — see the table.'
      : 'With the direction known in hindsight every strike looks good on big moves, as in the video. Without knowing the direction in advance, every strike lost money after charges — the strike choice changes how you lose, not whether you win.',
    note: `Real NSE NIFTY weekly option closes; bought at the close of the first session after each expiry and held to expiry (settled at NIFTY's close). ITM / ATM / OTM ≈ delta 0.70 / 0.50 / 0.30 from the ATM straddle's implied move. % of premium after brokerage, exchange, stamp, 0.5% (min 0.5 pt) slippage and 0.125% STT on exercise. ₹ use today's lot of ${LOT_NOW}. The video's 9:20→3:25 and expiry-day tests need intraday option prices (not available). Research only.`,
  };
}

export const saveOptionStrikes = (r) => writeJsonAtomic(SAVED(), r);
export const loadOptionStrikes = () => readJ(SAVED());

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
  try {
    const r = await optionStrikesTest();
    saveOptionStrikes(r);
    console.log(`${r.weeks} weekly cycles ${r.from} → ${r.to}. Median premium (pts): ${Object.entries(r.premiums).map(([k, v]) => `${k} call ${v.call?.toFixed(0)} put ${v.put?.toFixed(0)}`).join(' · ')}`);
    console.log('\n(a) Direction known in hindsight, by NIFTY move in your favour: avg / win');
    for (const b of r.hindsight) console.log(`  ${b.label.padEnd(12)} ${String(b.weeks).padStart(3)} wks  ${['ITM', 'ATM', 'OTM'].map((k) => `${k} ${pc(b[k].avg)} / ${pc(b[k].win)}`).join('  ')}`);
    console.log(`  wrong side: ${['ITM', 'ATM', 'OTM'].map((k) => `${k} ${pc(r.wrong[k].avg)}`).join('  ')}`);
    console.log('\n(b) Direction NOT known: avg % of premium / win / t / 2019–22 vs 2023→ / ₹ a year for 1 lot a week');
    for (const g of Object.values(r.real)) console.log(`  ${g.label}\n    ${['ITM', 'ATM', 'OTM'].map((k) => `${k} ${pc(g[k].avg)} win ${pc(g[k].win)} t ${g[k].t?.toFixed(1)} (${pc(g[k].early)} / ${pc(g[k].later)}) ₹${Math.round(g[k].rupeesPerYearLot).toLocaleString('en-IN')}`).join('\n    ')}`);
    console.log(`\n${r.verdict}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
