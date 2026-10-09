// Calibration tables: map a technical score to the UP / DOWN / SIDEWAYS
// frequencies actually observed after that score in past data (fitted by
// evaluate.mjs). Live predictions use these instead of the hand-written
// formula — but only for intervals where the fitted table beat the formula on
// held-out bars (`useCalibrated`).
// Research calibration only — not investment advice.

import { readJsonSafe, writeJsonAtomic } from '../util.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// Overridable so tests never touch the real file.
const CAL_PATH = process.env.CALIBRATION_PATH || join(__dir, 'calibration.json');

/** Score bucket edges (score is in [-1, 1]). */
export const SCORE_EDGES = [-1, -0.6, -0.35, -0.15, 0.15, 0.35, 0.6, 1];

/** Pseudo-count pulling sparse buckets toward the overall (climatology) mix. */
export const SHRINKAGE = 20;

/** Index of the bucket a score falls into. */
export function bucketIndex(score) {
  const s = Math.max(-1, Math.min(1, Number(score) || 0));
  for (let i = 1; i < SCORE_EDGES.length - 1; i++) if (s < SCORE_EDGES[i]) return i - 1;
  return SCORE_EDGES.length - 2;
}

/** Interval key used in calibration.json for a bar size in minutes. */
export function intervalKey(minutes) {
  const m = Number(minutes);
  if (m >= 1440) return '1d';
  if (m >= 60) return '60m';
  if (m >= 15) return '15m';
  return '5m';
}

/**
 * Fit bucket frequencies from samples [{score, label}], shrunk toward the
 * overall frequencies so a bucket with few samples can't claim certainty.
 * @param {{score:number, label:'UP'|'DOWN'|'SIDEWAYS'}[]} samples
 */
export function fitBuckets(samples) {
  const clim = frequencies(samples);
  const buckets = [];
  for (let b = 0; b < SCORE_EDGES.length - 1; b++) {
    const inB = samples.filter((s) => bucketIndex(s.score) === b);
    const n = inB.length;
    const c = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
    for (const s of inB) c[s.label]++;
    const k = SHRINKAGE;
    buckets.push({
      lo: SCORE_EDGES[b],
      hi: SCORE_EDGES[b + 1],
      n,
      probUp: (c.UP + k * clim.probUp) / (n + k),
      probDown: (c.DOWN + k * clim.probDown) / (n + k),
      probSideways: (c.SIDEWAYS + k * clim.probSideways) / (n + k),
    });
  }
  return { climatology: clim, buckets };
}

/** Overall label frequencies (uniform if there are no samples). */
export function frequencies(samples) {
  const n = samples.length;
  if (!n) return { probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 };
  const c = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  for (const s of samples) c[s.label]++;
  return { probUp: c.UP / n, probDown: c.DOWN / n, probSideways: c.SIDEWAYS / n };
}

/** Probabilities for a score from a fitted table. */
export function lookup(table, score) {
  const b = table.buckets[bucketIndex(score)];
  return { probUp: b.probUp, probDown: b.probDown, probSideways: b.probSideways };
}

/** Read calibration.json (or {} when missing / unreadable). */
export function loadCalibration() {
  return readJsonSafe(CAL_PATH, {}) || {};
}

/** Store one interval's fitted table + validation report. */
export function saveCalibration(key, entry) {
  const all = loadCalibration();
  all[key] = entry;
  writeJsonAtomic(CAL_PATH, all);
  return all;
}

/**
 * Calibrated probabilities for a score at an interval, or null when no table
 * exists for it or the table didn't beat the formula on held-out data.
 * @returns {{ probs: object, meta: object } | null}
 */
export function calibratedProbs(key, score, cal = loadCalibration(), variant = null) {
  const entry = cal[key];
  const t = variant ? entry?.variants?.[variant] : entry;
  if (!t || !t.useCalibrated || !Array.isArray(t.buckets)) return null;
  return {
    probs: lookup(t, score),
    meta: {
      key: variant ? `${key}/${variant}` : key,
      fittedAt: entry.fittedAt,
      samples: entry.samples,
      skillPct: t.test?.skillPct?.calibrated ?? null,
    },
  };
}
