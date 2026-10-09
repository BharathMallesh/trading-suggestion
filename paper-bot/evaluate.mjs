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
//   context      logistic regression on technicals + market (NIFTY), India VIX,
//                stock regime and session/calendar features (NSE/BSE symbols)
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
import { PAPER, EVAL_UNIVERSE } from './config.mjs';
import { fitBuckets, frequencies, lookup, saveCalibration, SCORE_EDGES } from './calibration.mjs';
import { badRequest } from '../util.mjs';
import { prepare, featuresAt, FEATURE_GROUPS, ALL_FEATURES, MARKET_INDEX, VIX_INDEX, isIndianListing } from './features.mjs';
import { fitLogistic, predictLogistic, toRow, moveOnly } from './context-model.mjs';
import { historyCandles } from './collector.mjs';

/** Data window + horizon per interval (horizon matches live scoring). */
export const EVAL_SETTINGS = {
  '1d': { range: '5y', interval: '1d', horizon: 1, label: 'daily · next session' },
  '60m': { range: '1y', interval: '60m', horizon: 4, label: '60-min · next 4 bars' },
  '15m': { range: '1mo', interval: '15m', horizon: 4, label: '15-min · next 4 bars (~1 hour)' },
  '5m': { range: '1mo', interval: '5m', horizon: 4, label: '5-min · next 4 bars (~20 min)' },
};

/**
 * Replication set: NIFTY 50 names NOT in the fitting universe. The context
 * model must also beat calibration here (never seen in training) to go live.
 */
export const HOLDOUT_UNIVERSE = [
  'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS', 'ULTRACEMCO.NS', 'TATASTEEL.NS',
  'JSWSTEEL.NS', 'ONGC.NS', 'CIPLA.NS', 'NESTLEIND.NS', 'POWERGRID.NS',
];

/** Default fitting universe (defined in config.mjs; re-exported for callers). */
export { EVAL_UNIVERSE };

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
export function buildSamples(rows, horizon, prep = null) {
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
      f: prep ? featuresAt(prep, i) : null,
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
  const symbols = opts.symbols?.length ? opts.symbols : EVAL_UNIVERSE;
  // Intraday intervals merge the local collector store (longer than Yahoo's ~1 month).
  const load = opts.loadCandles || ((s, o) => historyCandles(s, o));

  // Market context (NIFTY 50 + India VIX at the same interval). The context
  // model is evaluated only when every symbol is an Indian listing, so all
  // models are scored on exactly the same bars.
  let ctx = null;
  let contextNote = null;
  if (symbols.every(isIndianListing)) {
    try {
      ctx = {
        index: await load(MARKET_INDEX, { range: cfg.range, interval: cfg.interval }),
        vix: await load(VIX_INDEX, { range: cfg.range, interval: cfg.interval }),
      };
    } catch (err) {
      contextNote = `Market context unavailable (${err.message}) — context model skipped.`;
    }
  } else {
    contextNote = 'Context model needs NSE/BSE symbols only (it uses NIFTY and India VIX) — skipped for this list.';
  }

  const train = [];
  const test = [];
  // Inner split of the train period (fit / validation) used ONLY to choose
  // between context variants, so the test slice never influences the choice.
  const innerFit = [];
  const innerVal = [];
  const used = [];
  const skipped = [];
  for (const sym of symbols) {
    try {
      const rows = await load(sym, { range: cfg.range, interval: cfg.interval });
      let samples = buildSamples(rows, cfg.horizon, ctx ? prepare(rows, ctx) : null);
      if (ctx) samples = samples.filter((x) => x.f); // same bars for every model
      if (samples.length < 30) {
        skipped.push(`${sym}: only ${samples.length} samples`);
        continue;
      }
      // Chronological split per symbol: no future information leaks into the fit.
      // Embargo: a sample's label looks `horizon` bars ahead, so drop the last
      // `horizon` train samples — their labels would overlap the test period.
      const cut = Math.floor(samples.length * TRAIN_FRACTION);
      const trSyms = samples.slice(0, Math.max(0, cut - cfg.horizon));
      train.push(...trSyms);
      test.push(...samples.slice(cut));
      // Inner validation = last 20% of this symbol's train period (same embargo).
      const innerCut = Math.floor(trSyms.length * 0.8);
      innerFit.push(...trSyms.slice(0, Math.max(0, innerCut - cfg.horizon)));
      innerVal.push(...trSyms.slice(innerCut));
      used.push(sym);
    } catch (err) {
      skipped.push(`${sym}: ${err.message}`);
    }
  }
  if (train.length < 100 || test.length < 50) {
    throw badRequest(`Not enough history to evaluate (${train.length} train / ${test.length} test samples). ${skipped.join(' ')}`.trim());
  }

  const all0 = () => [...train, ...test];
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

  // Context model + ablation: add one feature group at a time.
  const models = [...MODELS];
  const ablation = [];
  if (ctx) {
    let names = [];
    for (const [group, feats] of Object.entries(FEATURE_GROUPS)) {
      names = [...names, ...feats];
      const cols = [...names];
      const model = fitLogistic(train.map((x) => toRow(x.f, cols)), train.map((x) => x.label));
      const pred = (x) => predictLogistic(model, toRow(x.f, cols));
      let b = 0;
      for (const x of test) b += brier(pred(x), x.label);
      ablation.push({ group, features: cols.length, brier: b / test.length, predict: pred });
    }
    predictors.context = ablation[ablation.length - 1].predict;
    // "Move" model: keep the context model's chance of a real move (its
    // sideways probability) but split up vs down by the calibrated table —
    // for when context predicts volatility but not direction.
    predictors.contextMove = (x) => moveOnly(predictors.context(x), predictors.calibrated(x));
    models.push('context', 'contextMove');
  }

  // Direction-only diagnostic: on bars that actually moved (UP or DOWN), does
  // the model's up-vs-down split beat the base-rate split? This separates
  // "predicts whether it moves" (volatility) from "predicts which way".
  const trainDir = train.filter((x) => x.label !== 'SIDEWAYS');
  const upShare = trainDir.length ? trainDir.filter((x) => x.label === 'UP').length / trainDir.length : 0.5;
  const testDir = test.filter((x) => x.label !== 'SIDEWAYS');
  const dirBrier = (pred) => {
    let b = 0;
    for (const x of testDir) {
      const p = pred(x);
      const pu = p.probUp + p.probDown > 0 ? p.probUp / (p.probUp + p.probDown) : 0.5;
      b += (pu - (x.label === 'UP' ? 1 : 0)) ** 2;
    }
    return testDir.length ? b / testDir.length : NaN;
  };
  const dirBase = dirBrier(() => ({ probUp: upShare, probDown: 1 - upShare, probSideways: 0 }));

  const metrics = {};
  for (const m of models) {
    let b = 0;
    let ll = 0;
    let acc = 0;
    for (const s of test) {
      const p = predictors[m](s);
      b += brier(p, s.label);
      ll += -Math.log(Math.max(1e-6, p[KEYS[s.label]]));
      if (topLabel(p) === s.label) acc++;
    }
    metrics[m] = {
      brier: b / test.length,
      logLoss: ll / test.length,
      accuracyPct: (acc / test.length) * 100,
      directionSkillPct: (1 - dirBrier(predictors[m]) / dirBase) * 100,
    };
  }
  const climBrier = metrics.climatology.brier;
  for (const m of models) metrics[m].skillPct = (1 - metrics[m].brier / climBrier) * 100;
  const ablationReport = ablation.map(({ group, features, brier: b }) => ({ group, features, brier: b, skillPct: (1 - b / climBrier) * 100 }));
  // Use the context model live only if it beats calibration by a margin that
  // isn't just noise (≥ 0.2 points of skill on held-out bars).
  // Pick which context variant (if any) to use live: it must beat calibration
  // by ≥ 0.2 points of skill on held-out bars — otherwise noise.
  // It must also win in BOTH halves of the held-out period (stability), so a
  // lucky stretch can't switch it on.
  let contextMode = null;
  let stability = null;
  let holdout = null;
  if (ctx) {
    // Choose the variant on the inner validation slice (models refit on the
    // inner-fit part only), not on the held-out test slice.
    let best = 'context';
    if (innerFit.length >= 50 && innerVal.length >= 20) {
      const mIn = fitLogistic(innerFit.map((x) => toRow(x.f, ALL_FEATURES)), innerFit.map((x) => x.label));
      const calIn = fitBuckets(innerFit);
      const vb = (fn) => innerVal.reduce((a, x) => a + brier(fn(x), x.label), 0) / innerVal.length;
      const bCtx = vb((x) => predictLogistic(mIn, toRow(x.f, ALL_FEATURES)));
      const bMove = vb((x) => moveOnly(predictLogistic(mIn, toRow(x.f, ALL_FEATURES)), lookup(calIn, x.score)));
      if (bMove <= bCtx) best = 'contextMove';
    }
    const sorted = [...test].sort((a, b) => (a.date < b.date ? -1 : 1));
    const halves = [sorted.slice(0, sorted.length >> 1), sorted.slice(sorted.length >> 1)];
    const gain = (part) => part.reduce((a, x) => a + brier(predictors.calibrated(x), x.label) - brier(predictors[best](x), x.label), 0) / part.length;
    stability = { model: best, gainFirstHalf: gain(halves[0]), gainSecondHalf: gain(halves[1]) };
    const stable = stability.gainFirstHalf > 0 && stability.gainSecondHalf > 0;
    let replicated = true;
    const lastTrainDate = train.reduce((a, x) => (x.date > a ? x.date : a), train[0].date);
    if (opts.holdout !== false) {
      // Replication on stocks the model never saw (fitted parts unchanged).
      const hs = [];
      for (const sym of opts.holdoutSymbols || HOLDOUT_UNIVERSE) {
        try {
          const rows = await load(sym, { range: cfg.range, interval: cfg.interval });
          // Only bars AFTER the latest train date: out of sample in time too.
          hs.push(...buildSamples(rows, cfg.horizon, prepare(rows, ctx)).filter((x) => x.f && x.date > lastTrainDate));
        } catch {
          /* skip */
        }
      }
      if (hs.length >= 100) {
        const b = (pred) => hs.reduce((a, x) => a + brier(pred(x), x.label), 0) / hs.length;
        const cal = b(predictors.calibrated);
        const ctxB = b(predictors[best]);
        holdout = { symbols: (opts.holdoutSymbols || HOLDOUT_UNIVERSE).length, n: hs.length, brierCalibrated: cal, brierContext: ctxB, gainPct: (1 - ctxB / cal) * 100 };
        replicated = ctxB < cal;
      } else {
        holdout = { n: hs.length, note: 'too few hold-out samples — replication not checked' };
      }
    }
    if (stable && replicated && metrics[best].skillPct - metrics.calibrated.skillPct >= 0.2) contextMode = best === 'contextMove' ? 'move' : 'full';
  }
  const useContext = Boolean(contextMode);
  const contextModel = ctx ? fitLogistic(all0().map((x) => toRow(x.f, ALL_FEATURES)), all0().map((x) => x.label)) : null;

  // Final table for live use: refit on ALL samples once validated.
  const all = [...train, ...test];
  const finalFit = fitBuckets(all);
  // Same bar as the context gate: beat the current formula by >= 0.2 skill
  // points AND in both halves of the test period.
  const sortedT = [...test].sort((a, b) => (a.date < b.date ? -1 : 1));
  const halvesT = [sortedT.slice(0, sortedT.length >> 1), sortedT.slice(sortedT.length >> 1)];
  const calGain = (part) => part.reduce((a, x) => a + brier(predictors.current(x), x.label) - brier(predictors.calibrated(x), x.label), 0) / (part.length || 1);
  const useCalibrated =
    metrics.calibrated.skillPct - metrics.current.skillPct >= 0.2 &&
    calGain(halvesT[0]) > 0 &&
    calGain(halvesT[1]) > 0;

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
    best: models.reduce((a, m) => (metrics[m].brier < metrics[a].brier ? m : a), models[0]),
    useCalibrated,
    contextEnabled: Boolean(ctx),
    contextNote,
    ablation: ablationReport,
    useContext,
    contextMode,
    stability,
    holdout,
    contextModel: contextModel && { features: ALL_FEATURES, ...contextModel },
    reliability: {
      current: reliability(test, predictors.current),
      calibrated: reliability(test, predictors.calibrated),
      ...(ctx ? { context: reliability(test, predictors.context), contextMove: reliability(test, predictors.contextMove) } : {}),
    },
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
    context: report.contextModel
      ? { useContext: report.useContext, mode: report.contextMode, ...report.contextModel, ablation: report.ablation }
      : null,
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
      console.log('model         Brier   logLoss  accuracy  skill vs base rates  direction skill');
      for (const [m, v] of Object.entries(r.metrics)) {
        console.log(`${m.padEnd(12)}  ${v.brier.toFixed(4)}  ${v.logLoss.toFixed(4)}   ${v.accuracyPct.toFixed(1).padStart(5)}%   ${pct(v.skillPct).padStart(7)}              ${pct(v.directionSkillPct).padStart(7)}${m === r.best ? '   ← best' : ''}`);
      }
      console.log(`\nCalibrated table ${r.useCalibrated ? 'BEATS' : 'does NOT beat'} the current formula on held-out bars.`);
      if (r.ablation?.length) {
        console.log('\nAblation (context model, adding one feature group at a time):');
        for (const a of r.ablation) console.log(`  + ${a.group.padEnd(8)} ${String(a.features).padStart(2)} features  Brier ${a.brier.toFixed(4)}  skill ${pct(a.skillPct)}`);
        if (r.holdout) console.log(r.holdout.gainPct != null ? `Replication on ${r.holdout.symbols} unseen stocks (n=${r.holdout.n}): context ${r.holdout.gainPct >= 0 ? 'beats' : 'loses to'} calibration by ${Math.abs(r.holdout.gainPct).toFixed(2)}%` : `Replication: ${r.holdout.note}`);
        if (r.stability) console.log(`Stability (Brier gain vs calibration, ${r.stability.model}): first half ${r.stability.gainFirstHalf.toFixed(4)} · second half ${r.stability.gainSecondHalf.toFixed(4)}`);
        console.log(r.useContext
          ? `Context model BEATS calibration (≥0.2 pts) → live would use it in "${r.contextMode}" mode${r.contextMode === 'move' ? ' (move-vs-sideways from context, up/down split from calibration)' : ''}.`
          : 'Context model does NOT beat calibration by ≥0.2 pts → live keeps calibration.');
      } else if (r.contextNote) console.log(`\n${r.contextNote}`);
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
