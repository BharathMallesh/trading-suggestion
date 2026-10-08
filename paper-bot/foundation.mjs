#!/usr/bin/env node
// Time-series foundation models, run locally: Kronos (NeoQuasar/Kronos-small,
// trained on candlesticks) and Chronos-Bolt (amazon/chronos-bolt-small).
//
// - A Python worker (ml/forecast_worker.py) is started on first use and kept
//   alive; models stay in memory. No API, no credits, nothing leaves the Mac.
// - Each model's forecast is turned into the app's Call / Put / Sideways
//   probabilities with the SAME label rule used everywhere else (labelMove:
//   a move bigger than 0.35 × ATR is UP / DOWN, otherwise SIDEWAYS).
//     Kronos       → sampled future candles → share of samples in each bucket
//     Chronos-Bolt → forecast quantiles     → interpolated distribution
// - Replay: past moments (no future data), scored against what happened, vs
//   the app's current probabilities and vs base rates. Verdict rule fixed in
//   advance: "helps" only if Brier beats the current model with t ≤ −2 AND it
//   also beats it on the unseen holdout stocks.
// Research only — not investment advice.
//
//   node paper-bot/foundation.mjs replay kronos --n 200
//   node paper-bot/foundation.mjs forecast chronos RELIANCE.NS

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore, baseProbabilities } from './groww-predict.mjs';
import { calibratedProbs, loadCalibration } from './calibration.mjs';
import { labelMove, brier, HOLDOUT_UNIVERSE } from './evaluate.mjs';
import { EVAL_UNIVERSE } from './config.mjs';
import { HttpError, mapLimit } from '../util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'ml', 'forecast_worker.py');
const DATA = process.env.FOUNDATION_DIR || join(ROOT, 'paper-bot', 'data');

export const MODELS = {
  kronos: { label: 'Kronos', hf: 'NeoQuasar/Kronos-small', kind: 'sampled candles', by: 'Tsinghua (open source, 2025)' },
  chronos: { label: 'Chronos-Bolt', hf: 'amazon/chronos-bolt-small', kind: 'forecast quantiles', by: 'Amazon (open source)' },
};
export const CONTEXT_BARS = 250; // ~1 year of daily candles
export const STEPS = 5; // forecast 1–5 sessions ahead
export const SAMPLES = 20; // Kronos sampled futures per forecast

// ---------------------------------------------------------------- worker ---

let worker = null;

let python = null;

/**
 * The Python that has the model packages. $PYTHON wins; otherwise the first
 * candidate that can import them (Homebrew's python3 often shadows the one
 * the packages were installed into).
 */
export function pickPython() {
  if (python) return python;
  if (process.env.PYTHON) return (python = process.env.PYTHON);
  for (const c of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    const r = spawnSync(c, ['-c', 'import torch, chronos, einops, pandas'], { stdio: 'ignore', timeout: 60000 });
    if (r.status === 0) return (python = c);
  }
  throw new HttpError(503, 'No Python with the model packages found. Install: pip3 install --user torch chronos-forecasting einops pandas huggingface_hub safetensors — or set PYTHON=/path/to/python3.');
}

function startWorker() {
  const py = pickPython();
  const proc = spawn(py, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, pending: new Map(), nextId: 1, ready: null, stderr: '' };
  w.ready = new Promise((resolve, reject) => {
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // stray library output
      }
      if (msg.ready) return resolve();
      const p = w.pending.get(msg.id);
      if (!p) return;
      w.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.results) : p.reject(new HttpError(500, `${p.model} failed: ${msg.error}`));
    });
    proc.stderr.on('data', (d) => (w.stderr = (w.stderr + d).slice(-2000)));
    const fail = (why) => {
      const err = new HttpError(503, `Local model worker stopped (${why}). Check Python + packages: ${WORKER}. ${w.stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`);
      reject(err);
      for (const p of w.pending.values()) p.reject(err);
      w.pending.clear();
      if (worker === w) worker = null;
    };
    proc.on('error', (e) => fail(e.message));
    proc.on('exit', (code) => fail(`exit ${code}`));
  });
  w.ready.catch(() => {});
  return w;
}

/** Send one request to the Python worker. */
export async function runWorker(model, series, { steps = STEPS, samples = SAMPLES, timeoutMs = 600000 } = {}) {
  if (!worker) worker = startWorker();
  const w = worker;
  await w.ready;
  const id = w.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      reject(new HttpError(504, `${model} took longer than ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    w.pending.set(id, { resolve, reject, timer, model });
    w.proc.stdin.write(JSON.stringify({ id, model, series, steps, samples }) + '\n');
  });
}

export function stopWorker() {
  if (worker) worker.proc.kill();
  worker = null;
}

// --------------------------------------------------------- probabilities ---

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Share of sampled future closes in each bucket, per step. */
export function probsFromPaths(paths, close, thrPct) {
  const steps = paths[0].length;
  return Array.from({ length: steps }, (_, s) => {
    const r = paths.map((p) => ((p[s] - close) / close) * 100);
    const up = r.filter((x) => x > thrPct).length / r.length;
    const down = r.filter((x) => x < -thrPct).length / r.length;
    return { probUp: up, probDown: down, probSideways: 1 - up - down, medianPct: median(r), lowPct: quantile(r, 0.1), highPct: quantile(r, 0.9) };
  });
}

/**
 * P(close ≤ x) from forecast quantiles, linear between quantiles; beyond the
 * outer quantiles the slope of the nearest segment is extended (clamped).
 */
export function cdfFromQuantiles(levels, q, x) {
  const n = levels.length;
  const seg = (i) => {
    const dx = q[i + 1] - q[i];
    return dx > 0 ? (levels[i + 1] - levels[i]) / dx : Infinity;
  };
  if (x <= q[0]) return clamp01(levels[0] - (q[0] - x) * Math.min(seg(0), 1e9));
  if (x >= q[n - 1]) return clamp01(levels[n - 1] + (x - q[n - 1]) * Math.min(seg(n - 2), 1e9));
  for (let i = 0; i < n - 1; i++) {
    if (x <= q[i + 1]) {
      const dx = q[i + 1] - q[i];
      return dx > 0 ? levels[i] + ((x - q[i]) / dx) * (levels[i + 1] - levels[i]) : levels[i + 1];
    }
  }
  return 1;
}

export function probsFromQuantiles(levels, quantiles, close, thrPct) {
  return quantiles.map((q) => {
    const hi = close * (1 + thrPct / 100);
    const lo = close * (1 - thrPct / 100);
    const down = cdfFromQuantiles(levels, q, lo);
    const up = 1 - cdfFromQuantiles(levels, q, hi);
    const pct = (v) => ((v - close) / close) * 100;
    return { probUp: up, probDown: down, probSideways: Math.max(0, 1 - up - down), medianPct: pct(q[levels.indexOf(0.5)]), lowPct: pct(q[0]), highPct: pct(q[q.length - 1]) };
  });
}

function median(a) {
  return quantile(a, 0.5);
}
function quantile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
}

const toBar = (r) => ({ date: String(r.date).slice(0, 10), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0 });

/** Run a model on several windows (each ends at "now" for that window). */
async function forecastWindows(model, windows, opts) {
  if (!MODELS[model]) throw new HttpError(400, 'model must be kronos or chronos');
  const res = await runWorker(model, windows.map((w) => w.map(toBar)), opts);
  return windows.map((w, k) => {
    const close = w[w.length - 1].close;
    const atr = computeIndicators(w.slice(-60)).atr14;
    const thrPct = Math.max(0.15, ((atr || 0) / close) * 100 * 0.35);
    const steps = model === 'kronos' ? probsFromPaths(res[k].paths, close, thrPct) : probsFromQuantiles(res[k].levels, res[k].quantiles, close, thrPct);
    return { close, thrPct, steps };
  });
}

// --------------------------------------------------------------- live use ---

/**
 * The app makes no multi-day Call / Put probability, so beyond the next
 * session the only fair yardstick is base rates — drop the stand-in.
 */
function noAppForecast(x) {
  for (const o of [x, x.holdout]) {
    if (!o) continue;
    o.brierCurrent = null;
    o.meanDiffVsCurrent = null;
    o.tVsCurrent = null;
    o.noAppForecast = true;
  }
  return x;
}

export function loadReplay(model) {
  const f = join(DATA, `foundation-replay-${model}.json`);
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  for (const [h, x] of Object.entries(r.horizons || {})) if (h !== '1d') noAppForecast(x);
  // How often the model's confident calls (top probability ≥ 80%) came true.
  for (const h of Object.keys(r.horizons || {})) {
    const conf = (r.samples || []).filter((x) => `${x.h}d` === h).map((x) => {
      const [label, p] = [['UP', x.model.probUp], ['DOWN', x.model.probDown], ['SIDEWAYS', x.model.probSideways]].sort((a, b) => b[1] - a[1])[0];
      return { p, hit: label === x.label };
    }).filter((x) => x.p >= 0.8);
    r.horizons[h].confident = conf.length
      ? { n: conf.length, avgStated: conf.reduce((a, x) => a + x.p, 0) / conf.length, cameTrue: conf.filter((x) => x.hit).length / conf.length }
      : null;
  }
  delete r.samples;
  // Confirmation runs on fresh moments (CLI --seed N) — shown next to the main
  // result so a lucky first run can't stand on its own.
  r.confirmations = readdirSync(DATA)
    .filter((n) => n.startsWith(`foundation-replay-${model}-seed`) && n.endsWith('.json'))
    .map((n) => {
      const c = JSON.parse(readFileSync(join(DATA, n), 'utf8'));
      const d = c.horizons['1d'];
      return { seed: c.seed, at: c.at, moments: c.moments, verdict: c.verdict, tVsCurrent: d.tVsCurrent, directionHitRate: d.directionHitRate, directionN: d.directionN, directionZ: d.directionZ, holdoutDirectionHitRate: d.holdout.directionHitRate };
    });
  return r;
}

/** Forecast one symbol now with one model. */
export async function foundationForecast({ symbol, model, loadCandles = candles }) {
  if (!MODELS[model]) throw new HttpError(400, 'model must be kronos or chronos');
  if (!symbol) throw new HttpError(400, 'symbol is required');
  const rows = (await loadCandles(symbol, { range: '2y', interval: '1d' })).filter((r) => r.close > 0);
  if (rows.length < 120) throw new HttpError(400, `Not enough daily history for ${symbol}`);
  const window = rows.slice(-CONTEXT_BARS);
  const t0 = Date.now();
  const [f] = await forecastWindows(model, [window]);
  const pick = (s) => ({ ...f.steps[s - 1], session: s });
  const replay = loadReplay(model);
  return {
    model,
    modelLabel: MODELS[model].label,
    source: `${MODELS[model].hf} · ${MODELS[model].kind} · run locally on this Mac`,
    symbol,
    asOf: window[window.length - 1].date,
    lastClose: f.close,
    contextBars: window.length,
    sidewaysBandPct: f.thrPct,
    horizons: { '1d': pick(1), '5d': pick(STEPS) },
    seconds: (Date.now() - t0) / 1000,
    replay: replay && { verdict: replay.verdict, at: replay.at, n: replay.horizons?.['1d']?.n, summary: replay.summary },
    note: replay?.verdict === 'helps'
      ? 'Passed the replay test — still research only.'
      : 'Shown for comparison only: this model has not passed the replay test, so the app does not use it for its Call / Put probabilities.',
  };
}

// ----------------------------------------------------------------- replay ---

function pickMoments(seriesList, n, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const s = seriesList[Math.floor(rnd() * seriesList.length)];
    const i = CONTEXT_BARS + Math.floor(rnd() * (s.rows.length - CONTEXT_BARS - STEPS - 1));
    if (i < CONTEXT_BARS) continue;
    if (!out.some((o) => o.s === s && Math.abs(o.i - i) < STEPS)) out.push({ s, i });
  }
  return out;
}

/** Base-rate probabilities from the 250 bars before the moment (no look-ahead). */
function climatology(rows, i, h) {
  const counts = { UP: 1, DOWN: 1, SIDEWAYS: 1 };
  for (let j = Math.max(60, i - 250); j <= i - h; j++) {
    const atr = computeIndicators(rows.slice(j - 59, j + 1)).atr14;
    counts[labelMove(((rows[j + h].close - rows[j].close) / rows[j].close) * 100, atr, rows[j].close)]++;
  }
  const t = counts.UP + counts.DOWN + counts.SIDEWAYS;
  return { probUp: counts.UP / t, probDown: counts.DOWN / t, probSideways: counts.SIDEWAYS / t };
}

function pairedT(diffs) {
  const n = diffs.length;
  if (n < 3) return { mean: null, t: null };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : null };
}

function summarise(rows) {
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / (rows.length || 1);
  const vsCurrent = pairedT(rows.map((r) => r.brierModel - r.brierCurrent));
  // Direction: did the model's median move have the right sign? (ignores tiny moves)
  const dir = rows.filter((r) => Math.abs(r.actualPct) > 0.05 && r.medianPct !== 0);
  const hits = dir.filter((r) => Math.sign(r.medianPct) === Math.sign(r.actualPct)).length;
  const hitRate = dir.length ? hits / dir.length : null;
  return {
    n: rows.length,
    brierModel: avg('brierModel'),
    brierCurrent: avg('brierCurrent'),
    brierClimatology: avg('brierClimatology'),
    meanDiffVsCurrent: vsCurrent.mean,
    tVsCurrent: vsCurrent.t,
    directionHitRate: hitRate,
    directionN: dir.length,
    // z of the hit rate vs a coin flip
    directionZ: hitRate == null ? null : (hitRate - 0.5) / Math.sqrt(0.25 / dir.length),
  };
}

/**
 * Replay a model over past moments in the fitting universe and the unseen
 * holdout universe.
 */
export async function foundationReplay({ model, n = 200, seed = 7, loadCandles = candles, batch = 8, onProgress = () => {} } = {}) {
  if (!MODELS[model]) throw new HttpError(400, 'model must be kronos or chronos');
  const load = async (syms, group) => (await mapLimit(syms, 4, async (sym) => {
    try {
      const rows = (await loadCandles(sym, { range: '5y', interval: '1d' })).filter((r) => r.close > 0);
      return rows.length > CONTEXT_BARS + 60 ? { sym, rows, group } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const main = await load(EVAL_UNIVERSE, 'main');
  const hold = await load(HOLDOUT_UNIVERSE, 'holdout');
  if (!main.length) throw new HttpError(503, 'No market data available for the replay');
  const nHold = hold.length ? Math.round(n * 0.3) : 0;
  const moments = [...pickMoments(main, n - nHold, seed), ...pickMoments(hold, nHold, seed + 4)];
  const cal = loadCalibration();
  const results = [];
  for (let b = 0; b < moments.length; b += batch) {
    const chunk = moments.slice(b, b + batch);
    const windows = chunk.map(({ s, i }) => s.rows.slice(i - CONTEXT_BARS + 1, i + 1));
    const fc = await forecastWindows(model, windows);
    chunk.forEach(({ s, i }, k) => {
      const close = s.rows[i].close;
      const ind = computeIndicators(s.rows.slice(i - 59, i + 1));
      const score = techScore(ind);
      for (const h of [1, STEPS]) {
        const actualPct = ((s.rows[i + h].close - close) / close) * 100;
        const label = labelMove(actualPct, ind.atr14, close);
        const key = h === 1 ? '1d' : null;
        const current = (key && calibratedProbs(key, score, cal)?.probs) || baseProbabilities(score);
        const clim = climatology(s.rows, i, h);
        const p = fc[k].steps[h - 1];
        results.push({
          symbol: s.sym, group: s.group, date: s.rows[i].date, h, label, actualPct,
          medianPct: p.medianPct,
          model: { probUp: p.probUp, probDown: p.probDown, probSideways: p.probSideways },
          brierModel: brier(p, label), brierCurrent: brier(current, label), brierClimatology: brier(clim, label),
        });
      }
    });
    onProgress(Math.min(b + batch, moments.length), moments.length);
  }
  const horizons = {};
  for (const h of [1, STEPS]) {
    const r = results.filter((x) => x.h === h);
    horizons[`${h}d`] = {
      ...summarise(r.filter((x) => x.group === 'main')),
      holdout: summarise(r.filter((x) => x.group === 'holdout')),
    };
  }
  for (const [h, x] of Object.entries(horizons)) if (h !== '1d') noAppForecast(x);
  const d1 = horizons['1d'];
  const helps = d1.tVsCurrent != null && d1.tVsCurrent <= -2 && d1.holdout.n > 0 && d1.holdout.meanDiffVsCurrent < 0;
  const hurts = d1.tVsCurrent != null && d1.tVsCurrent >= 2;
  const verdict = helps ? 'helps' : hurts ? 'hurts' : 'inconclusive';
  const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
  return {
    model,
    modelLabel: MODELS[model].label,
    source: MODELS[model].hf,
    at: new Date().toISOString(),
    seed,
    moments: moments.length,
    horizons,
    verdict,
    summary: `${MODELS[model].label}, next session: Brier ${d1.brierModel.toFixed(4)} vs app ${d1.brierCurrent.toFixed(4)} vs base rates ${d1.brierClimatology.toFixed(4)} (t = ${d1.tVsCurrent?.toFixed(2)}); direction right ${pct(d1.directionHitRate)} of ${d1.directionN} (z = ${d1.directionZ?.toFixed(2)}).`,
    rule: '"helps" only if next-session Brier beats the app\'s current probabilities with t ≤ −2 AND also beats them on the unseen holdout stocks; "hurts" if t ≥ 2; otherwise inconclusive. Lower Brier is better.',
    samples: results,
  };
}

export function saveReplay(r, suffix = '') {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, `foundation-replay-${r.model}${suffix}.json`), JSON.stringify(r, null, 2));
}

// -------------------------------------------------------------------- CLI ---

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, model, arg] = process.argv.slice(2);
  const nIdx = process.argv.indexOf('--n');
  const n = nIdx > 0 ? Number(process.argv[nIdx + 1]) : 200;
  const sIdx = process.argv.indexOf('--seed');
  const seed = sIdx > 0 ? Number(process.argv[sIdx + 1]) : 7;
  const t0 = Date.now();
  const done = () => stopWorker();
  const run = cmd === 'forecast'
    ? foundationForecast({ symbol: arg || '^NSEI', model }).then((r) => console.log(JSON.stringify(r, null, 2)))
    : foundationReplay({ model, n, seed, onProgress: (d, t) => process.stdout.write(`  ${model}: ${d}/${t} moments…\r`) }).then((r) => {
      saveReplay(r, seed === 7 ? '' : `-seed${seed}`);
      console.log(`\n${r.summary}`);
      for (const [h, x] of Object.entries(r.horizons)) {
        console.log(`  ${h}: main n=${x.n} model ${x.brierModel.toFixed(4)} app ${x.brierCurrent?.toFixed(4) ?? '–'} base ${x.brierClimatology.toFixed(4)} t=${x.tVsCurrent?.toFixed(2)} dir ${(x.directionHitRate * 100).toFixed(1)}% (z ${x.directionZ?.toFixed(2)}) | holdout n=${x.holdout.n} model ${x.holdout.brierModel.toFixed(4)} app ${x.holdout.brierCurrent?.toFixed(4) ?? '–'} dir ${(x.holdout.directionHitRate * 100).toFixed(1)}%`);
      }
      console.log(`Verdict: ${r.verdict.toUpperCase()} · ${((Date.now() - t0) / 60000).toFixed(1)} min · ${r.rule}`);
    });
  run.then(done).catch((err) => {
    console.error('Error:', err.message);
    done();
    process.exit(1);
  });
}
