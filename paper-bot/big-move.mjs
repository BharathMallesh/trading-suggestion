#!/usr/bin/env node
// Big-move odds (library + CLI): the chance the next session / next week moves
// more than ±k% — in EITHER direction. This is the predictable part: volatility
// clusters, and results days are known in advance. Direction is not predicted.
//
//   σ (how big)  : HAR volatility forecast for the horizon (won the vol replay)
//   shape (tails): the stock's own past h-day returns, standardised by the
//                  volatility known at the time (EWMA) — fat tails included
//   P(|move| > k) = share of past standardised moves that, scaled to today's σ,
//                  exceed k. A normal curve is shown alongside for reference.
//   Results due: one typical big-day move is added to the window's variance.
//
// Replay (evaluateBigMove): non-overlapping past moments, fitting universe +
// unseen holdout stocks; Brier vs "how often it happened over the past year".
// The odds are shown as validated only if they beat that with t ≤ −2 on the
// fitting universe AND are better on the holdout stocks.
// Research only — not investment advice.
//
//   node paper-bot/big-move.mjs RELIANCE.NS     # odds now
//   node paper-bot/big-move.mjs --eval          # replay + save verdict

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { harForecast } from './volatility.mjs';
import { normCdf } from '../blackscholes.mjs';
import { EVAL_UNIVERSE } from './config.mjs';
import { HOLDOUT_UNIVERSE } from './evaluate.mjs';
import { badRequest, mapLimit } from '../util.mjs';

const SAVED = () => process.env.BIG_MOVE_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'big-move-eval.json');
export const THRESHOLDS = { 1: [1, 2, 3], 5: [2, 4, 6] }; // % moves per horizon (sessions)
const LOOKBACK = 750; // ~3 years of history for the tail shape
const LAMBDA = 0.94;

const logReturns = (closes) => closes.slice(1).map((c, i) => Math.log(c / closes[i]));

/** EWMA daily vol known BEFORE each day (index i uses returns < i). */
export function ewmaPath(r) {
  const out = new Array(r.length).fill(null);
  if (r.length < 31) return out;
  let v = r.slice(0, 30).reduce((a, x) => a + x * x, 0) / 30;
  for (let i = 30; i < r.length; i++) {
    out[i] = Math.sqrt(v);
    v = LAMBDA * v + (1 - LAMBDA) * r[i] ** 2;
  }
  return out;
}

/** Standardised past h-day log returns ending before `end` (exclusive). */
export function standardisedMoves(r, sig, h, end, lookback = LOOKBACK) {
  const z = [];
  for (let j = Math.max(30, end - lookback); j + h <= end; j++) {
    if (!sig[j]) continue;
    let R = 0;
    for (let k = j; k < j + h; k++) R += r[k];
    z.push(R / (sig[j] * Math.sqrt(h)));
  }
  return z;
}

/** P(|h-day move| > k%) from standardised moves scaled to σ (daily). */
export function tailProb(z, sigmaDaily, h, kPct) {
  const s = sigmaDaily * Math.sqrt(h);
  const lim = Math.log(1 + kPct / 100); // up threshold in log terms
  const limDn = -Math.log(1 - kPct / 100) ; // down threshold magnitude
  let up = 0;
  let dn = 0;
  for (const x of z) {
    if (x * s > lim) up++;
    else if (-x * s > limDn) dn++;
  }
  return { both: (up + dn) / z.length, up: up / z.length, down: dn / z.length };
}

export function normalTail(sigmaDaily, h, kPct) {
  const s = sigmaDaily * Math.sqrt(h);
  const up = 1 - normCdf(Math.log(1 + kPct / 100) / s);
  const dn = normCdf(Math.log(1 - kPct / 100) / s);
  return up + dn;
}

/** How often |h-day move| > k% over the past `days` sessions before `end`. */
export function climatology(closes, end, h, kPct, days = 250) {
  let hit = 0;
  let n = 0;
  for (let j = Math.max(0, end - days); j + h <= end; j++) {
    n++;
    if (Math.abs(closes[j + h] / closes[j] - 1) * 100 > kPct) hit++;
  }
  return n ? (hit + 0.5) / (n + 1) : null;
}

/** Daily σ for the horizon from HAR, widened if results are due. */
function sigmaFor(r, h, eventPending) {
  let s = harForecast(r, h);
  if (!s) return null;
  if (eventPending) {
    const abs = r.slice(-252).map(Math.abs).sort((a, b) => a - b);
    const big = abs[Math.floor(abs.length * 0.9)] || 0;
    s = Math.sqrt((s * s * h + big * big) / h);
  }
  return s;
}

export function loadBigMoveEval() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Big-move odds now for one symbol. */
export async function bigMove({ symbol, eventPending = false, loadCandles = candles } = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) throw badRequest('symbol is required, e.g. ^NSEI or TCS.NS');
  const rows = (await loadCandles(sym, { range: '5y', interval: '1d' })).filter((x) => x.close > 0);
  if (rows.length < 400) throw badRequest(`Not enough daily history for ${sym} (need ~2 years).`);
  const closes = rows.map((x) => x.close);
  const r = logReturns(closes);
  const sig = ewmaPath(r);
  const ev = loadBigMoveEval();
  const horizons = {};
  for (const h of [1, 5]) {
    const s = sigmaFor(r, h, eventPending);
    const z = standardisedMoves(r, sig, h, r.length);
    const cal = ev?.horizons?.[`${h}d`]?.calibration || { scale: 1, shrink: 0 };
    horizons[`${h}d`] = {
      sessions: h,
      sigmaPct: s * cal.scale * Math.sqrt(h) * 100,
      calibration: cal,
      odds: THRESHOLDS[h].map((k) => {
        const pastYear = climatology(closes, closes.length - 1, h, k);
        const t = calibrated(z, s, h, k, pastYear, cal);
        return { movePct: k, prob: t.both, probUp: t.up, probDown: t.down, normal: normalTail(s * cal.scale, h, k), pastYear };
      }),
      validated: ev?.horizons?.[`${h}d`]?.verdict === 'skill',
    };
  }
  return {
    symbol: sym,
    asOf: rows[rows.length - 1].date,
    last: closes[closes.length - 1],
    eventPending,
    horizons,
    replay: ev ? { at: ev.at, verdicts: Object.fromEntries(Object.entries(ev.horizons).map(([k, v]) => [k, v.verdict])) } : null,
    note: 'Chance of a move bigger than the size shown, up OR down — not a direction call. "Past year" = how often it actually happened over the last ~250 sessions.',
  };
}

// Calibration candidates, chosen on the FIRST half of the fitting universe only:
// a scale on σ (the replay showed the raw odds run high) and an optional 50/50
// blend with the past-year rate. Judged out of sample (second half + holdout).
export const SCALES = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05];
export const SHRINKS = [0, 0.5];

/** Apply a chosen calibration to raw inputs. */
export function calibrated(z, sigmaDaily, h, k, pastYear, cal = { scale: 1, shrink: 0 }) {
  const p = tailProb(z, sigmaDaily * cal.scale, h, k);
  const w = pastYear == null ? 0 : cal.shrink;
  return { both: (1 - w) * p.both + w * pastYear, up: (1 - w) * p.up + (w * pastYear) / 2, down: (1 - w) * p.down + (w * pastYear) / 2 };
}

/** Replay: predicted odds vs what happened, against the past-year rate. */
export async function evaluateBigMove({ loadCandles = candles, symbols = EVAL_UNIVERSE, holdout = HOLDOUT_UNIVERSE } = {}) {
  const load = async (list, group) => (await mapLimit(list, 4, async (sym) => {
    try {
      const rows = (await loadCandles(sym, { range: '5y', interval: '1d' })).filter((x) => x.close > 0);
      return rows.length > 600 ? { sym, group, dates: rows.map((x) => x.date), closes: rows.map((x) => x.close) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const all = [...(await load(['^NSEI', ...symbols], 'main')), ...(await load(holdout, 'holdout'))];
  const variants = SCALES.flatMap((scale) => SHRINKS.map((shrink) => ({ scale, shrink })));
  const horizons = {};
  for (const h of [1, 5]) {
    const samples = [];
    for (const s of all) {
      const r = logReturns(s.closes);
      const sig = ewmaPath(r);
      // decide at close i (returns r[0..i-1] known), outcome close i → i+h
      for (let i = 400; i + h < s.closes.length; i += h) {
        const sd = harForecast(r.slice(0, i), h);
        if (!sd) continue;
        const z = standardisedMoves(r, sig, h, i);
        const move = Math.abs(s.closes[i + h] / s.closes[i] - 1) * 100;
        for (const k of THRESHOLDS[h]) {
          const clim = climatology(s.closes, i, h, k);
          const pv = variants.map((v) => Math.min(0.999, Math.max(0.001, calibrated(z, sd, h, k, clim, v).both)));
          samples.push({ group: s.group, date: s.dates[i], k, pv, normal: normalTail(sd, h, k), clim, y: move > k ? 1 : 0 });
        }
      }
    }
    const main = samples.filter((x) => x.group === 'main');
    const mid = [...main].map((x) => x.date).sort()[main.length >> 1];
    // Holdout stocks are scored only from the split date on: unseen in time as
    // well as in name (the calibration was chosen on main-universe data before `mid`).
    const hold = samples.filter((x) => x.group === 'holdout' && x.date >= mid);
    const first = main.filter((x) => x.date < mid);
    const second = main.filter((x) => x.date >= mid);
    const brier = (rows, f) => rows.reduce((a, x) => a + (f(x) - x.y) ** 2, 0) / (rows.length || 1);
    // choose on the first half only
    let best = 0;
    variants.forEach((v, j) => {
      if (brier(first, (x) => x.pv[j]) < brier(first, (x) => x.pv[best])) best = j;
    });
    const raw = variants.findIndex((v) => v.scale === 1 && v.shrink === 0);
    const score = (rows, j) => {
      if (!rows.length) return null;
      const d = rows.map((x) => (x.pv[j] - x.y) ** 2 - (x.clim - x.y) ** 2);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1));
      return {
        n: rows.length,
        brierModel: brier(rows, (x) => x.pv[j]),
        brierNormal: brier(rows, (x) => x.normal),
        brierPastYear: brier(rows, (x) => x.clim),
        skillPct: (1 - brier(rows, (x) => x.pv[j]) / brier(rows, (x) => x.clim)) * 100,
        tVsPastYear: sd > 0 ? mean / (sd / Math.sqrt(d.length)) : null,
      };
    };
    const reliability = (rows, j) => [[0, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 1.01]].map(([lo, hi]) => {
      const b = rows.filter((x) => x.pv[j] >= lo && x.pv[j] < hi);
      return b.length >= 30 ? { range: `${(lo * 100).toFixed(0)}–${Math.min(100, hi * 100).toFixed(0)}%`, n: b.length, predicted: b.reduce((a, x) => a + x.pv[j], 0) / b.length, observed: b.reduce((a, x) => a + x.y, 0) / b.length } : null;
    }).filter(Boolean);
    const oos = score(second, best);
    const ho = score(hold, best);
    horizons[`${h}d`] = {
      calibration: variants[best],
      chosenOn: `main universe before ${mid}`,
      outOfSample: oos,
      holdout: ho,
      rawOutOfSample: score(second, raw),
      perThreshold: Object.fromEntries(THRESHOLDS[h].map((k) => [`${k}%`, score(second.filter((x) => x.k === k), best)])),
      reliability: reliability(second, best),
      verdict: oos && ho && oos.tVsPastYear <= -2 && ho.brierModel < ho.brierPastYear ? 'skill' : oos && oos.tVsPastYear >= 2 ? 'worse' : 'no clear skill',
    };
    // keep the UI field names stable
    horizons[`${h}d`].main = oos;
  }
  return {
    at: new Date().toISOString(),
    series: all.length,
    horizons,
    rule: 'Calibration (σ scale, optional blend with the past-year rate) chosen on the first half of the fitting universe only; "skill" only if it then beats the past-year rate with t ≤ −2 on the second half AND is better on the unseen holdout stocks (scored from the split date on).',
  };
}

export function saveBigMoveEval(r) {
  mkdirSync(dirname(SAVED()), { recursive: true });
  writeFileSync(SAVED(), JSON.stringify(r, null, 2));
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const run = a.includes('--eval')
    ? evaluateBigMove().then((r) => {
      saveBigMoveEval(r);
      console.log(`\nBIG-MOVE ODDS REPLAY · ${r.series} series (5y, non-overlapping)`);
      for (const [h, x] of Object.entries(r.horizons)) {
        const m = x.main;
        console.log(`\n${h}: chosen on ${x.chosenOn}: σ × ${x.calibration.scale}, blend ${x.calibration.shrink} with past-year rate`);
        console.log(`   out of sample: Brier model ${m.brierModel.toFixed(4)} · normal ${m.brierNormal.toFixed(4)} · past-year rate ${m.brierPastYear.toFixed(4)} · skill ${m.skillPct.toFixed(1)}% (t ${m.tVsPastYear.toFixed(2)}, n ${m.n}) · raw odds skill ${x.rawOutOfSample.skillPct.toFixed(1)}%`);
        console.log(`   holdout: model ${x.holdout.brierModel.toFixed(4)} vs past-year ${x.holdout.brierPastYear.toFixed(4)} · skill ${x.holdout.skillPct.toFixed(1)}%`);
        for (const [k, v] of Object.entries(x.perThreshold)) console.log(`   >${k}: skill ${v.skillPct.toFixed(1)}% (t ${v.tVsPastYear.toFixed(2)})`);
        console.log(`   calibration: ${x.reliability.map((b) => `${b.range}: said ${pct(b.predicted)} → ${pct(b.observed)}`).join(' · ')}`);
        console.log(`   → ${x.verdict}`);
      }
      console.log(`\n${r.rule}`);
    })
    : bigMove({ symbol: a[0] || '^NSEI' }).then((r) => {
      console.log(`\n${r.symbol} · ${r.asOf} · last ${r.last.toFixed(2)}`);
      for (const [h, x] of Object.entries(r.horizons)) {
        console.log(`${h === '1d' ? 'Next session' : 'Next 5 sessions'} (σ ${x.sigmaPct.toFixed(2)}%)${x.validated ? ' · validated' : ''}`);
        for (const o of x.odds) console.log(`   move > ±${o.movePct}%: ${pct(o.prob)} (up ${pct(o.probUp)} / down ${pct(o.probDown)}) · normal ${pct(o.normal)} · past year ${pct(o.pastYear)}`);
      }
    });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
