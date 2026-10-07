// Prediction log + hit-rate tracking (research calibration only).
// Stores each Call/Put forecast, later scores it against realized price moves.
// NOT investment advice. Hit-rates are descriptive, not guarantees.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { candles as yahooCandles } from '../market-data.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dir, 'prediction-history.json');

function loadLog() {
  try {
    if (!existsSync(LOG_PATH)) return { version: 1, entries: [] };
    const j = JSON.parse(readFileSync(LOG_PATH, 'utf8'));
    if (!Array.isArray(j.entries)) j.entries = [];
    return j;
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveLog(data) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {
    /* ok */
  }
  writeFileSync(LOG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function uid() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Append a prediction snapshot after a probability run.
 * @param {object} result - return value of growwProbability()
 */
export function logPrediction(result) {
  if (!result?.symbol || !result?.prediction) return null;
  const log = loadLog();
  const p = result.prediction;
  const entry = {
    id: uid(),
    ts: new Date().toISOString(),
    symbol: result.symbol,
    mode: result.mode || 'multi',
    intervalMinutes: result.intervalMinutes || 15,
    asOf: result.asOf,
    lastClose: Number(result.lastClose) || 0,
    bias: p.bias,
    probUp: p.probUp,
    probDown: p.probDown,
    probSideways: p.probSideways,
    confidence: p.confidence,
    techScore: result.hybrid?.techScore ?? null,
    atr: result.indicators?.atr14 ?? result.expectedMove?.atr ?? null,
    timeWindow: result.expectedMove?.timeWindow || null,
    // Filled later by evaluate
    evaluated: false,
    evalTs: null,
    futureClose: null,
    realizedRetPct: null,
    realizedLabel: null, // UP | DOWN | SIDEWAYS
    hitBias: null, // did realizedLabel match bias?
    hitTopProb: null, // did realized match the highest of up/down/side?
  };
  log.entries.push(entry);
  // Keep last 500
  if (log.entries.length > 500) log.entries = log.entries.slice(-500);
  saveLog(log);
  return entry;
}

function labelFromReturn(retPct, thresholdPct) {
  if (retPct > thresholdPct) return 'UP';
  if (retPct < -thresholdPct) return 'DOWN';
  return 'SIDEWAYS';
}

function topProbLabel(entry) {
  const u = entry.probUp || 0;
  const d = entry.probDown || 0;
  const s = entry.probSideways || 0;
  if (u >= d && u >= s) return 'UP';
  if (d >= s) return 'DOWN';
  return 'SIDEWAYS';
}

/**
 * Evaluate pending predictions that are old enough.
 * Uses Yahoo daily/intraday close after a minimum wait.
 *
 * @param {{ minAgeMinutes?: number, thresholdPct?: number, limit?: number }} [opts]
 */
export async function evaluatePending(opts = {}) {
  const minAgeMinutes = opts.minAgeMinutes ?? 60; // default: at least 1 hour later
  const thresholdPct = opts.thresholdPct ?? 0.15; // move larger than this => UP/DOWN else SIDEWAYS
  const limit = opts.limit ?? 30;
  const log = loadLog();
  const now = Date.now();
  let checked = 0;
  let updated = 0;

  for (const entry of log.entries) {
    if (entry.evaluated) continue;
    if (checked >= limit) break;
    const ageMin = (now - new Date(entry.ts).getTime()) / 60000;
    if (ageMin < minAgeMinutes) continue;
    checked++;

    try {
      const sym = String(entry.symbol).includes('.')
        ? entry.symbol
        : `${entry.symbol}.NS`;
      // Prefer recent intraday if prediction was intraday; else daily
      const interval = (entry.intervalMinutes || 15) <= 60 ? '15m' : '1d';
      const range = interval === '1d' ? '5d' : '5d';
      const rows = await yahooCandles(sym, { range, interval });
      if (!rows?.length) continue;
      const futureClose = Number(rows[rows.length - 1].close);
      if (!futureClose || !entry.lastClose) continue;

      const retPct = ((futureClose - entry.lastClose) / entry.lastClose) * 100;
      // Scale threshold a bit with ATR if present
      let thr = thresholdPct;
      if (entry.atr && entry.lastClose) {
        const atrPct = (entry.atr / entry.lastClose) * 100;
        thr = Math.max(thresholdPct, atrPct * 0.35);
      }
      const realizedLabel = labelFromReturn(retPct, thr);
      entry.evaluated = true;
      entry.evalTs = new Date().toISOString();
      entry.futureClose = futureClose;
      entry.realizedRetPct = retPct;
      entry.realizedLabel = realizedLabel;
      entry.hitBias = realizedLabel === entry.bias;
      entry.hitTopProb = realizedLabel === topProbLabel(entry);
      entry.evalThresholdPct = thr;
      updated++;
    } catch {
      /* skip this entry */
    }
  }

  saveLog(log);
  return { checked, updated, stats: computeStats(log.entries) };
}

export function computeStats(entries) {
  const all = entries || loadLog().entries;
  const evaluated = all.filter((e) => e.evaluated);
  const pending = all.filter((e) => !e.evaluated);
  const hitBias = evaluated.filter((e) => e.hitBias).length;
  const hitTop = evaluated.filter((e) => e.hitTopProb).length;

  const byBias = { UP: { n: 0, hits: 0 }, DOWN: { n: 0, hits: 0 }, SIDEWAYS: { n: 0, hits: 0 } };
  for (const e of evaluated) {
    const b = e.bias || 'SIDEWAYS';
    if (!byBias[b]) byBias[b] = { n: 0, hits: 0 };
    byBias[b].n++;
    if (e.hitBias) byBias[b].hits++;
  }

  // Calibration buckets by confidence
  const buckets = [
    { label: 'conf <50%', min: 0, max: 0.5, n: 0, hits: 0 },
    { label: 'conf 50–65%', min: 0.5, max: 0.65, n: 0, hits: 0 },
    { label: 'conf ≥65%', min: 0.65, max: 1.01, n: 0, hits: 0 },
  ];
  for (const e of evaluated) {
    const c = Number(e.confidence) || 0;
    for (const b of buckets) {
      if (c >= b.min && c < b.max) {
        b.n++;
        if (e.hitBias) b.hits++;
        break;
      }
    }
  }

  return {
    totalLogged: all.length,
    pending: pending.length,
    evaluated: evaluated.length,
    hitRateBias: evaluated.length ? hitBias / evaluated.length : null,
    hitRateTopProb: evaluated.length ? hitTop / evaluated.length : null,
    byBias: Object.fromEntries(
      Object.entries(byBias).map(([k, v]) => [
        k,
        { n: v.n, hits: v.hits, hitRate: v.n ? v.hits / v.n : null },
      ]),
    ),
    confidenceBuckets: buckets.map((b) => ({
      label: b.label,
      n: b.n,
      hits: b.hits,
      hitRate: b.n ? b.hits / b.n : null,
    })),
    recentEvaluated: evaluated.slice(-10).reverse(),
    recentPending: pending.slice(-10).reverse(),
  };
}

export function getHistory(limit = 50) {
  const log = loadLog();
  return log.entries.slice(-limit).reverse();
}
