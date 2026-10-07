#!/usr/bin/env node
// Replay harness for the Call / Put / Sideways probabilities (library + CLI).
//
// Instead of waiting hours for live predictions to mature, replay history:
// at every past bar, compute the same technical score the live model uses,
// predict UP / DOWN / SIDEWAYS probabilities, and compare with what actually
// happened `horizon` bars later — using the same label rule as live scoring
// (move larger than max(0.15%, 0.35 × ATR%) → UP/DOWN, else SIDEWAYS).
//
// Models compared (chronological split: fit on the first 60%, score on the rest):
//   uniform      1/3 each — the "know nothing" floor
//   climatology  overall historical frequencies
//   persistence  frequencies conditioned on the previous move's label
//   current      the hand-written formula (baseProbabilities)
//   calibrated   score-bucket frequencies fitted on the training part
//
// Scores: Brier (lower is better; uniform ≈ 0.667), log loss, top-label
// accuracy, skill vs climatology (% Brier improvement; > 0 means better than
// just quoting base rates), and a reliability table (does "40%" happen 40%?).
//
// RESEARCH ONLY. A positive skill on past data is not a promise of future
// accuracy, and nothing here is investment advice.
//
//   node paper-bot/evaluate.mjs --interval 1d                 # report only
//   node paper-bot/evaluate.mjs --interval 15m --save         # fit + save calibration
//   node paper-bot/evaluate.mjs --interval 60m TCS.NS INFY.NS

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore, baseProbabilities, shortWindowScore } from './groww-predict.mjs';
import { PAPER } from './config.mjs';
import { fitBuckets, frequencies, lookup, saveCalibration, SCORE_EDGES } from './calibration.mjs';
import { badRequest } from '../util.mjs';

/** Data window + horizon per interval (horizon matches live scoring). */
export const EVAL_SETTINGS = {
  '1d': { range: '5y', interval: '1d', horizon: 1, label: 'daily · next session' },
  '60m': { range: '1y', interval: '60m', horizon: 4, label: '60-min · next 4 bars' },
  '15m': { range: '1mo', interval: '15m', horizon: 4, label: '15-min · next 4 bars (~1 hour)' },
  '5m': { range: '1mo', interval: '5m', horizon: 4, label: '5-min · next 4 bars (~20 min)' },
};

const LOOKBACK = 60; // bars fed to the indicators, like the live model
const WARMUP = 55; // SMA-50 + slack
const TRAIN_FRACTION = 0.6;
const MODELS = ['uniform', 'climatology', 'persistence', 'current', 'calibrated'];
const LABELS = ['UP', 'DOWN', 'SIDEWAYS'];
const KEYS = { UP: 'probUp', DOWN: 'probDown', SIDEWAYS: 'probSideways' };

/** Same rule as live hit-rate scoring (prediction-log.mjs). */
export function labelMove(retPct, atr, close) {
  const atrPct = atr && close ? (atr / close) * 100 : 0;
  const thr = Math.max(0.15, atrPct * 0.35);
  return retPct > thr ? 'UP' : retPct < -thr ? 'DOWN' : 'SIDEWAYS';
}

/**
 * Turn one symbol's candles into replay samples. Each sample is the score
 * known at bar i, the label of the move from close[i] to close[i+h], and the
 * label of the previous h-bar move (for the persistence baseline).
 */
export function buildSamples(rows, horizon) {
  const out = [];
  for (let i = Math.max(WARMUP, horizon); i < rows.length - horizon; i++) {
    const window = rows.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const ind = computeIndicators(window);
    const close = rows[i].close;
    const future = rows[i + horizon].close;
    const past = rows[i - horizon].close;
    if (!(close > 0) || !(future > 0) || !(past > 0)) continue;
    out.push({
      date: rows[i].date,
      score: techScore(ind),
      // Short price-action scores used by the live "last hour" / "last 15 min" windows.
      short12: shortWindowScore(rows.slice(i - 11, i + 1)),
      short3: shortWindowScore(rows.slice(i - 2, i + 1)),
      label: labelMove(((future - close) / close) * 100, ind.atr14, close),
      prevLabel: labelMove(((close - past) / past) * 100, ind.atr14, close),
    });
  }
  return out;
}

/** Multi-class Brier score of one probability vector against the truth. */
export function brier(p, label) {
  return LABELS.reduce((s, l) => s + (p[KEYS[l]] - (l === label ? 1 : 0)) ** 2, 0);
}

function topLabel(p) {
  if (p.probUp >= p.probDown && p.probUp >= p.probSideways) return 'UP';
  if (p.probDown >= p.probSideways) return 'DOWN';
  return 'SIDEWAYS';
}

/** Persistence baseline: label frequencies conditioned on the previous move. */
function fitPersistence(train) {
  const clim = frequencies(train);
  const table = {};
  for (const prev of LABELS) {
    const sub = train.filter((s) => s.prevLabel === prev);
    const f = frequencies(sub);
    const n = sub.length;
    const k = 20; // shrink toward climatology like the bucket fit
    table[prev] = {
      probUp: (f.probUp * n + k * clim.probUp) / (n + k),
      probDown: (f.probDown * n + k * clim.probDown) / (n + k),
      probSideways: (f.probSideways * n + k * clim.probSideways) / (n + k),
    };
  }
  return table;
}

/** Reliability table for one model: per class, predicted-probability bins vs observed rate. */
function reliability(test, predict) {
  const out = {};
  for (const l of LABELS) {
    const bins = Array.from({ length: 10 }, (_, b) => ({ lo: b / 10, hi: (b + 1) / 10, n: 0, sumP: 0, hits: 0 }));
    for (const s of test) {
      const p = predict(s)[KEYS[l]];
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.n++;
      bin.sumP += p;
      if (s.label === l) bin.hits++;
    }
    out[l] = bins
      .filter((b) => b.n > 0)
      .map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, meanPredicted: b.sumP / b.n, observed: b.hits / b.n }));
  }
  return out;
}

/**
 * Replay one interval across symbols and score every model.
 * @param {{ interval?: string, symbols?: string[], loadCandles?: Function }} [opts]
 *   `loadCandles(symbol, {range, interval})` is injectable for tests.
 */
export async function evaluateModels(opts = {}) {
  const key = opts.interval || '1d';
  const cfg = EVAL_SETTINGS[key];
  if (!cfg) throw badRequest(`Unsupported interval "${key}". Use ${Object.keys(EVAL_SETTINGS).join(', ')}.`);
  const symbols = opts.symbols?.length ? opts.symbols : PAPER.symbols;
  const load = opts.loadCandles || candles;

  const train = [];
  const test = [];
  const used = [];
  const skipped = [];
  for (const sym of symbols) {
    try {
      const rows = await load(sym, { range: cfg.range, interval: cfg.interval });
      const samples = buildSamples(rows, cfg.horizon);
      if (samples.length < 30) {
        skipped.push(`${sym}: only ${samples.length} samples`);
        continue;
      }
      // Chronological split per symbol: no future information leaks into the fit.
      const cut = Math.floor(samples.length * TRAIN_FRACTION);
      train.push(...samples.slice(0, cut));
      test.push(...samples.slice(cut));
      used.push(sym);
    } catch (err) {
      skipped.push(`${sym}: ${err.message}`);
    }
  }
  if (train.length < 100 || test.length < 50) {
    throw badRequest(`Not enough history to evaluate (${train.length} train / ${test.length} test samples). ${skipped.join(' ')}`.trim());
  }

  const clim = frequencies(train);
  const persistence = fitPersistence(train);
  const fitted = fitBuckets(train);
  const predictors = {
    uniform: () => ({ probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 }),
    climatology: () => clim,
    persistence: (s) => persistence[s.prevLabel],
    current: (s) => baseProbabilities(s.score),
    calibrated: (s) => lookup(fitted, s.score),
  };

  const metrics = {};
  for (const m of MODELS) {
    let b = 0;
    let ll = 0;
    let acc = 0;
    for (const s of test) {
      const p = predictors[m](s);
      b += brier(p, s.label);
      ll += -Math.log(Math.max(1e-6, p[KEYS[s.label]]));
      if (topLabel(p) === s.label) acc++;
    }
    metrics[m] = { brier: b / test.length, logLoss: ll / test.length, accuracyPct: (acc / test.length) * 100 };
  }
  const climBrier = metrics.climatology.brier;
  for (const m of MODELS) metrics[m].skillPct = (1 - metrics[m].brier / climBrier) * 100;

  // Final table for live use: refit on ALL samples once validated.
  const all = [...train, ...test];
  const finalFit = fitBuckets(all);
  const useCalibrated = metrics.calibrated.brier < metrics.current.brier;

  // Variants: the short price-action windows of the live multi-horizon mix
  // (12 and 3 bars), fitted the same way. Only meaningful on 5m bars.
  const variants = {};
  if (key === '5m') {
    for (const v of ['short12', 'short3']) {
      const tr = train.map((x) => ({ score: x[v], label: x.label }));
      const te = test.map((x) => ({ score: x[v], label: x.label }));
      const fit = fitBuckets(tr);
      const score = (pred) => te.reduce((a, x) => a + brier(pred(x), x.label), 0) / te.length;
      const b = {
        climatology: score(() => clim),
        current: score((x) => baseProbabilities(x.score)),
        calibrated: score((x) => lookup(fit, x.score)),
      };
      variants[v] = {
        brier: b,
        skillPct: Object.fromEntries(Object.entries(b).map(([m, x]) => [m, (1 - x / b.climatology) * 100])),
        useCalibrated: b.calibrated < b.current,
        table: fitBuckets(all.map((x) => ({ score: x[v], label: x.label }))),
      };
    }
  }

  return {
    interval: key,
    settings: cfg,
    symbols: used,
    skipped,
    samples: { train: train.length, test: test.length },
    period: {
      from: all.reduce((a, s) => (s.date < a ? s.date : a), all[0].date),
      to: all.reduce((a, s) => (s.date > a ? s.date : a), all[0].date),
    },
    testBaseRates: frequencies(test),
    metrics,
    best: MODELS.reduce((a, m) => (metrics[m].brier < metrics[a].brier ? m : a), MODELS[0]),
    useCalibrated,
    reliability: { current: reliability(test, predictors.current), calibrated: reliability(test, predictors.calibrated) },
    calibrationTable: { edges: SCORE_EDGES, ...finalFit },
    variants,
    disclaimer:
      'Replay of past data for research calibration. Skill on history is not a promise of future accuracy. Not investment advice.',
  };
}

/** Persist a report's fitted table so live predictions can use it. */
export function saveReport(report) {
  return saveCalibration(report.interval, {
    fittedAt: new Date().toISOString(),
    horizonBars: report.settings.horizon,
    symbols: report.symbols,
    samples: report.samples.train + report.samples.test,
    period: report.period,
    useCalibrated: report.useCalibrated,
    edges: report.calibrationTable.edges,
    climatology: report.calibrationTable.climatology,
    buckets: report.calibrationTable.buckets,
    variants: Object.fromEntries(
      Object.entries(report.variants || {}).map(([v, x]) => [
        v,
        { useCalibrated: x.useCalibrated, buckets: x.table.buckets, climatology: x.table.climatology, test: { brier: x.brier, skillPct: x.skillPct } },
      ]),
    ),
    test: {
      brier: Object.fromEntries(Object.entries(report.metrics).map(([m, v]) => [m, v.brier])),
      skillPct: Object.fromEntries(Object.entries(report.metrics).map(([m, v]) => [m, v.skillPct])),
    },
  });
}

// ---------------------------------------------------------------------------
// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const iIdx = args.indexOf('--interval');
  const interval = iIdx >= 0 ? args[iIdx + 1] : '1d';
  const save = args.includes('--save');
  const symbols = args.filter((a, i) => !a.startsWith('--') && i !== iIdx + 1);
  const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
  evaluateModels({ interval, symbols })
    .then((r) => {
      console.log(`\nREPLAY · ${r.settings.label} · ${r.symbols.length} symbols · ${r.period.from} → ${r.period.to}`);
      console.log(`Samples: ${r.samples.train} fit / ${r.samples.test} scored`);
      const b = r.testBaseRates;
      console.log(`Actual outcomes in the scored part: UP ${(b.probUp * 100).toFixed(0)}% · DOWN ${(b.probDown * 100).toFixed(0)}% · SIDEWAYS ${(b.probSideways * 100).toFixed(0)}%\n`);
      console.log('model         Brier   logLoss  accuracy  skill vs base rates');
      for (const [m, v] of Object.entries(r.metrics)) {
        console.log(`${m.padEnd(12)}  ${v.brier.toFixed(4)}  ${v.logLoss.toFixed(4)}   ${v.accuracyPct.toFixed(1).padStart(5)}%   ${pct(v.skillPct)}${m === r.best ? '   ← best' : ''}`);
      }
      console.log(`\nCalibrated table ${r.useCalibrated ? 'BEATS' : 'does NOT beat'} the current formula on held-out bars.`);
      console.log('\nFitted table (score bucket → UP / DOWN / SIDEWAYS, n):');
      for (const k of r.calibrationTable.buckets) {
        console.log(`  [${k.lo.toFixed(2)}, ${k.hi.toFixed(2)})  ${(k.probUp * 100).toFixed(0).padStart(3)}% / ${(k.probDown * 100).toFixed(0).padStart(3)}% / ${(k.probSideways * 100).toFixed(0).padStart(3)}%   n=${k.n}`);
      }
      for (const [v, x] of Object.entries(r.variants || {})) {
        console.log(`\nVariant ${v}: Brier formula ${x.brier.current.toFixed(4)} · calibrated ${x.brier.calibrated.toFixed(4)} · base rates ${x.brier.climatology.toFixed(4)} → ${x.useCalibrated ? 'calibrated wins' : 'formula kept'}`);
      }
      if (r.skipped.length) console.log(`\nSkipped: ${r.skipped.join(' · ')}`);
      if (save) {
        saveReport(r);
        console.log(`\nSaved to paper-bot/calibration.json (${r.useCalibrated ? 'live predictions will use it' : 'stored, but live keeps the formula because it did not win'}).`);
      }
      console.log(`\n${r.disclaimer}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
