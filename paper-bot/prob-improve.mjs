#!/usr/bin/env node
// Probability improvements (library + CLI), each held to the same rule fixed
// in advance: candidates are chosen on the FIRST half of the fitting universe
// (by date) only; a candidate is adopted only if, on the SECOND half and on the
// unseen holdout stocks (same dates), it beats what the app shows today with a
// paired, date-clustered t ≤ −2 (holdout must also improve). Adopted settings
// are saved to paper-bot/prob-calibration.json and used live.
//
//   A. Up / Down / Sideways — direction has no skill, but SIDEWAYS ("moves
//      less than 0.35×ATR") is a volatility question. P(move) from the HAR
//      forecast + the stock's own fat-tailed moves; UP/DOWN split by the
//      stock's trailing up-share. Baseline = trailing 250-day base rates
//      (what the calibrated output effectively is).
//   B. Big-move odds, next week — the audit found them 2–5 points high: a
//      2-parameter logistic recalibration of the current odds.
//   C. Option payoff odds — volatility input: HAR / EWMA / trailing 1-year /
//      50-50 HAR+1-year / VIX-scaled (NIFTY). Baseline = trailing 1-year.
// Research only — not investment advice.
//
//   node paper-bot/prob-improve.mjs          # run all, save adopted settings

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { labelMove, brier, HOLDOUT_UNIVERSE } from './evaluate.mjs';
import { EVAL_UNIVERSE } from './config.mjs';
import { harForecast, FORECASTERS, loadVolModel } from './volatility.mjs';
import { ewmaPath, standardisedMoves, tailProb, calibrated, climatology, loadBigMoveEval, THRESHOLDS } from './big-move.mjs';
import { probAboveHistory } from './option-odds.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';

const PATH = () => process.env.PROB_CAL_PATH || join(dirname(fileURLToPath(import.meta.url)), 'prob-calibration.json');
export const SCALES = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1];
export const SHRINKS = [0, 0.25, 0.5];
// ~14 years of daily data (explicit dates; 5 years left the weekly tests short of power)
const HISTORY = { period1: Date.UTC(2012, 0, 1) / 1000, interval: '1d' };

export function loadProbCalibration() {
  try {
    return existsSync(PATH()) ? JSON.parse(readFileSync(PATH(), 'utf8')) : {};
  } catch {
    return {};
  }
}

const logReturns = (c) => c.slice(1).map((x, i) => Math.log(x / c[i]));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clip = (p) => Math.min(0.999, Math.max(0.001, p));

/** Paired, date-clustered comparison of per-sample losses a vs b (negative mean = a better). */
export function clusteredT(rows, lossA, lossB) {
  const per = new Map();
  for (const x of rows) {
    if (!per.has(x.date)) per.set(x.date, []);
    per.get(x.date).push(lossA(x) - lossB(x));
  }
  const d = [...per.values()].map((a) => a.reduce((p, q) => p + q, 0) / a.length);
  const n = d.length;
  if (n < 3) return { n, mean: null, t: null };
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : null };
}

const avg = (rows, f) => rows.reduce((a, x) => a + f(x), 0) / (rows.length || 1);

/** Split samples: main first half / main second half / holdout second half (by date). */
function splits(samples) {
  const main = samples.filter((x) => x.group === 'main');
  const mid = [...main].map((x) => x.date).sort()[main.length >> 1];
  return { mid, first: main.filter((x) => x.date < mid), second: main.filter((x) => x.date >= mid), holdout: samples.filter((x) => x.group === 'holdout' && x.date >= mid) };
}

/** Pick the best candidate on `first`, then judge it out of sample vs the baseline. */
function judge(samples, candidates, lossOf, baseLoss) {
  const { mid, first, second, holdout } = splits(samples);
  let best = 0;
  candidates.forEach((_, j) => {
    if (avg(first, (x) => lossOf(x, j)) < avg(first, (x) => lossOf(x, best))) best = j;
  });
  const cmp = (rows) => {
    const t = clusteredT(rows, (x) => lossOf(x, best), baseLoss);
    const m = avg(rows, (x) => lossOf(x, best));
    const b = avg(rows, baseLoss);
    return { n: rows.length, dates: t.n, loss: m, baseline: b, skillPct: b ? (1 - m / b) * 100 : null, t: t.t };
  };
  const oos = cmp(second);
  const ho = cmp(holdout);
  const adopt = oos.t != null && oos.t <= -2 && ho.loss < ho.baseline;
  return { chosen: candidates[best], chosenOn: `fitting universe before ${mid}`, outOfSample: oos, holdout: ho, adopt };
}

async function loadAll(loadCandles) {
  const load = async (list, group) => (await mapLimit(list, 4, async (sym) => {
    try {
      const rows = (await loadCandles(sym, HISTORY)).filter((r) => r.close > 0 && r.high > 0 && r.low > 0);
      return rows.length > 600 ? { sym, group, rows } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  return [...(await load(EVAL_UNIVERSE, 'main')), ...(await load(HOLDOUT_UNIVERSE, 'holdout'))];
}

// ------------------------------------------------- A. Up / Down / Sideways

/** Vol-driven 3-class probabilities. */
export function volSidewaysProbs({ z, sigma1, thrPct, upShare, pastSide, scale = 1, shrink = 0 }) {
  const pMoveRaw = tailProb(z, sigma1 * scale, 1, thrPct).both;
  const side = (1 - shrink) * (1 - pMoveRaw) + shrink * pastSide;
  const move = 1 - side;
  return { probUp: move * upShare, probDown: move * (1 - upShare), probSideways: side };
}

export async function experimentA(all) {
  const samples = [];
  for (const s of all) {
    const c = s.rows.map((r) => r.close);
    const r = logReturns(c);
    const sig = ewmaPath(r);
    const labels = [];
    for (let i = 60; i + 1 < s.rows.length; i++) {
      const atr = computeIndicators(s.rows.slice(i - 59, i + 1)).atr14;
      const thr = Math.max(0.15, ((atr || 0) / c[i]) * 100 * 0.35);
      labels[i] = { thr, label: labelMove(((c[i + 1] - c[i]) / c[i]) * 100, atr, c[i]) };
    }
    for (let i = 400; i + 1 < s.rows.length; i += 2) {
      const sd = harForecast(r.slice(0, i), 1);
      if (!sd || !labels[i]) continue;
      // trailing base rates and up-share from labels already known at i
      const past = labels.slice(Math.max(60, i - 250), i).filter(Boolean);
      const cnt = { UP: 1, DOWN: 1, SIDEWAYS: 1 };
      for (const p of past) cnt[p.label]++;
      const tot = cnt.UP + cnt.DOWN + cnt.SIDEWAYS;
      const base = { probUp: cnt.UP / tot, probDown: cnt.DOWN / tot, probSideways: cnt.SIDEWAYS / tot };
      const upShare = cnt.UP / (cnt.UP + cnt.DOWN);
      const z = standardisedMoves(r, sig, 1, i);
      const cands = [];
      for (const scale of SCALES) for (const shrink of SHRINKS) cands.push(volSidewaysProbs({ z, sigma1: sd, thrPct: labels[i].thr, upShare, pastSide: base.probSideways, scale, shrink }));
      samples.push({ group: s.group, date: s.rows[i].date, label: labels[i].label, base, cands });
    }
  }
  const candidates = SCALES.flatMap((scale) => SHRINKS.map((shrink) => ({ scale, shrink })));
  const res = judge(samples, candidates, (x, j) => brier(x.cands[j], x.label), (x) => brier(x.base, x.label));
  // reliability of the chosen candidate's SIDEWAYS probability, out of sample
  const j = candidates.indexOf(res.chosen);
  const { second } = splits(samples);
  const bins = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01]].map(([lo, hi]) => {
    const b = second.filter((x) => x.cands[j].probSideways >= lo && x.cands[j].probSideways < hi);
    return b.length >= 50 ? { range: `${lo * 100}–${Math.min(100, hi * 100)}%`, n: b.length, stated: avg(b, (x) => x.cands[j].probSideways), actual: avg(b, (x) => (x.label === 'SIDEWAYS' ? 1 : 0)) } : null;
  }).filter(Boolean);
  return { ...res, samples: samples.length, sidewaysReliability: bins };
}

// ----------------------------------------- B. Big-move odds, next week

export async function experimentB(all) {
  const ev = loadBigMoveEval();
  const cal = ev?.horizons?.['5d']?.calibration || { scale: 1, shrink: 0 };
  const h = 5;
  const samples = [];
  for (const s of all) {
    const c = s.rows.map((r) => r.close);
    const r = logReturns(c);
    const sig = ewmaPath(r);
    for (let i = 400; i + h < c.length; i += h) {
      const sd = harForecast(r.slice(0, i), h);
      if (!sd) continue;
      const z = standardisedMoves(r, sig, h, i);
      const move = Math.abs(c[i + h] / c[i] - 1) * 100;
      for (const k of THRESHOLDS[h]) {
        const clim = climatology(c, i, h, k);
        samples.push({ group: s.group, date: s.rows[i].date, p: clip(calibrated(z, sd, h, k, clim, cal).both), y: move > k ? 1 : 0 });
      }
    }
  }
  const candidates = [];
  for (let a = -0.4; a <= 0.401; a += 0.05) for (let b = 0.7; b <= 1.301; b += 0.05) candidates.push({ a: +a.toFixed(2), b: +b.toFixed(2) });
  const map = (p, c) => sigmoid(c.a + c.b * logit(p));
  const res = judge(samples, candidates, (x, j) => (map(x.p, candidates[j]) - x.y) ** 2, (x) => (x.p - x.y) ** 2);
  const { second } = splits(samples);
  const rel = (f) => [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 1.01]].map(([lo, hi]) => {
    const bb = second.filter((x) => f(x) >= lo && f(x) < hi);
    return bb.length >= 30 ? { range: `${lo * 100}–${Math.min(100, hi * 100)}%`, n: bb.length, stated: avg(bb, f), actual: avg(bb, (x) => x.y) } : null;
  }).filter(Boolean);
  return { ...res, samples: samples.length, reliabilityBefore: rel((x) => x.p), reliabilityAfter: rel((x) => map(x.p, res.chosen)) };
}

// ------------------------------------------------ C. Option payoff odds

export async function experimentC(all, loadCandles) {
  const model = loadVolModel();
  let vix = null;
  try {
    vix = new Map((await loadCandles('^INDIAVIX', HISTORY)).map((r) => [r.date, r.close]));
  } catch {
    /* no VIX: that candidate is skipped */
  }
  let nifty = null;
  try {
    nifty = (await loadCandles('^NSEI', HISTORY)).filter((r) => r.close > 0);
  } catch {
    /* ignore */
  }
  const series = nifty ? [...all, { sym: '^NSEI', group: 'main', rows: nifty }] : all;
  const h = 5;
  const names = ['har', 'ewma', 'trailing1y', 'har+1y', 'vixScaled'];
  const samples = [];
  for (const s of series) {
    const c = s.rows.map((r) => r.close);
    const r = logReturns(c);
    for (let t = 301; t + h < r.length; t += h) {
      const past = r.slice(0, t);
      const naive = Math.sqrt(past.slice(-252).reduce((a, x) => a + x * x, 0) / 252);
      const har = harForecast(past, h) || FORECASTERS.ewma(past, h);
      const ew = FORECASTERS.ewma(past, h);
      const v = s.sym === '^NSEI' && vix && model.niftyTypicalRatio ? vix.get(s.rows[t].date) : null;
      const sig = {
        har,
        ewma: ew,
        trailing1y: naive,
        'har+1y': Math.sqrt((har * har + naive * naive) / 2),
        vixScaled: v ? v / 100 / model.niftyTypicalRatio / Math.sqrt(252) : null,
      };
      const spot = c[t];
      const end = c[t + h];
      for (const k of [-1, -0.5, 0.5, 1]) {
        const level = spot * Math.exp(k * naive * Math.sqrt(h)); // neutral levels
        const y = end > level ? 1 : 0;
        const p = names.map((n) => (sig[n] ? probAboveHistory(spot, level, sig[n], h, past) : null));
        if (p[2] == null) continue;
        samples.push({ group: s.group, date: s.rows[t + 1]?.date || String(t), y, p: p.map((x, i) => (x == null ? p[2] : x)) });
      }
    }
  }
  const candidates = names.map((n) => ({ sigma: n }));
  const res = judge(samples, candidates, (x, j) => (x.p[j] - x.y) ** 2, (x) => (x.p[2] - x.y) ** 2);
  return { ...res, samples: samples.length, note: 'VIX-scaled only differs from trailing 1-year for NIFTY.' };
}

export async function runAll({ loadCandles = candles } = {}) {
  const all = await loadAll(loadCandles);
  const A = await experimentA(all);
  const B = await experimentB(all);
  const C = await experimentC(all, loadCandles);
  const saved = {
    fittedAt: new Date().toISOString(),
    rule: 'Chosen on the first half of the fitting universe; adopted only if it beats the current output out of sample (second half) with a date-clustered paired t ≤ −2 and also improves on the unseen holdout stocks.',
    direction: A.adopt ? { method: 'volSideways', ...A.chosen } : null,
    bigMove5d: B.adopt ? B.chosen : null,
    optionSigma: C.adopt ? C.chosen.sigma : null,
    evidence: {
      direction: { adopt: A.adopt, chosen: A.chosen, outOfSample: A.outOfSample, holdout: A.holdout, sidewaysReliability: A.sidewaysReliability },
      bigMove5d: { adopt: B.adopt, chosen: B.chosen, outOfSample: B.outOfSample, holdout: B.holdout, reliabilityBefore: B.reliabilityBefore, reliabilityAfter: B.reliabilityAfter },
      optionSigma: { adopt: C.adopt, chosen: C.chosen, outOfSample: C.outOfSample, holdout: C.holdout },
    },
  };
  return { A, B, C, saved };
}

export function saveProbCalibration(saved) {
  writeJsonAtomic(PATH(), saved);
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  runAll()
    .then(({ A, B, C, saved }) => {
      const line = (name, x) => console.log(`${name}: chosen ${JSON.stringify(x.chosen)} on ${x.chosenOn}\n   out of sample: loss ${x.outOfSample.loss.toFixed(4)} vs baseline ${x.outOfSample.baseline.toFixed(4)} · skill ${x.outOfSample.skillPct.toFixed(2)}% · t ${x.outOfSample.t?.toFixed(2)} (${x.outOfSample.dates} dates)\n   holdout:       loss ${x.holdout.loss.toFixed(4)} vs ${x.holdout.baseline.toFixed(4)} · skill ${x.holdout.skillPct.toFixed(2)}%\n   → ${x.adopt ? 'ADOPTED' : 'not adopted'}`);
      line('A · Up/Down/Sideways (vol-driven sideways)', A);
      console.log(`   sideways reliability (out of sample): ${A.sidewaysReliability.map((b) => `${b.range}: said ${(b.stated * 100).toFixed(0)}% → ${(b.actual * 100).toFixed(0)}%`).join(' · ')}`);
      line('B · Big-move odds, next week (recalibration)', B);
      console.log(`   before: ${B.reliabilityBefore.map((b) => `${(b.stated * 100).toFixed(0)}→${(b.actual * 100).toFixed(0)}`).join(' · ')}\n   after:  ${B.reliabilityAfter.map((b) => `${(b.stated * 100).toFixed(0)}→${(b.actual * 100).toFixed(0)}`).join(' · ')}`);
      line('C · Option payoff odds (volatility input)', C);
      saveProbCalibration(saved);
      console.log(`\nSaved ${PATH()} · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
