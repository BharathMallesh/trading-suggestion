// Prediction log + hit-rate tracking (research calibration only).
// Stores each Call/Put forecast, later scores it against realized price moves.
// NOT investment advice. Hit-rates are descriptive, not guarantees.

import { readJsonSafe, writeJsonAtomic, withFileLock } from '../util.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { candles as yahooCandles } from '../market-data.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// Overridable so tests never touch the real log.
const LOG_PATH = process.env.PREDICTION_LOG_PATH || join(__dir, 'prediction-history.json');

function loadLog() {
  const j = readJsonSafe(LOG_PATH, { version: 1, entries: [] });
  if (!j || !Array.isArray(j.entries)) return { version: 1, ...(j || {}), entries: [] };
  return j;
}

function saveLog(data) {
  writeJsonAtomic(LOG_PATH, data);
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
    // Probabilities BEFORE Ling's adjustment, so evaluation can measure
    // whether the adjustment helps (Brier final vs base).
    base: result.hybrid?.baseProbabilities
      ? { probUp: result.hybrid.baseProbabilities.probUp, probDown: result.hybrid.baseProbabilities.probDown, probSideways: result.hybrid.baseProbabilities.probSideways }
      : null,
    llmAdjusted: Boolean(p.adjustmentNote && p.adjustmentNote !== 'No LLM adjustment applied'),
    newsSentiment: result.news?.sentiment ?? null,
    newsFacts: result.news?.facts && Object.keys(result.news.facts).length ? result.news.facts : null,
    // Probabilities before the news tilt (null when no tilt was applied).
    preNews: result.newsTilt?.applied ? result.newsTilt.before : null,
    newsTiltPts: result.newsTilt?.applied ? result.newsTilt.shiftPts : 0,
    atr: result.indicators?.atr14 ?? result.expectedMove?.atr ?? null,
    timeWindow: result.expectedMove?.timeWindow || null,
    horizonMinutes: horizonFor(result.mode, result.intervalMinutes),
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

/**
 * Minutes until a prediction is scored. Single-timeframe runs are judged ~4
 * bars later (5m → 20 min, 15m → 1 h, 60m → 4 h); multi-horizon / daily runs
 * are judged on the next completed session's close (null = session-based).
 */
export function horizonFor(mode, intervalMinutes = 15) {
  if (mode === 'multi' || intervalMinutes >= 1440) return null;
  return Math.max(5, Number(intervalMinutes) || 15) * 4;
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
 * Price that settles one entry, or null if its horizon hasn't fully elapsed yet.
 * - Intraday horizon: OPEN of the first completed bar starting at/after
 *   prediction time + horizon (so a closed market can't score as "flat").
 * - Session horizon: close of the first COMPLETED daily session after the
 *   prediction's date.
 */
async function settlementPrice(entry, now) {
  const sym = String(entry.symbol); // stored already resolved to a Yahoo symbol
  const predMs = new Date(entry.ts).getTime();
  const horizon = entry.horizonMinutes !== undefined ? entry.horizonMinutes : horizonFor(entry.mode, entry.intervalMinutes);
  if (horizon != null) {
    const im = Number(entry.intervalMinutes) || 15;
    const interval = im <= 5 ? '5m' : im <= 15 ? '15m' : '60m';
    const barMs = (interval === '5m' ? 5 : interval === '15m' ? 15 : 60) * 60000;
    const target = predMs + horizon * 60000;
    if (now < target) return null;
    const rows = await yahooCandles(sym, { range: '1mo', interval });
    const bar = rows.find((r) => r.ts * 1000 >= target && r.ts * 1000 + barMs <= now);
    return bar ? { price: Number(bar.open), at: bar.date } : null;
  }
  const rows = await yahooCandles(sym, { range: '1mo', interval: '1d' });
  if (!rows.length) return null;
  // Exchange-local dates: candles() already labels daily bars in local time.
  const predDate = String(entry.asOf || '').slice(0, 10) || new Date(predMs).toISOString().slice(0, 10);
  const latest = rows[rows.length - 1].date; // may still be in progress
  const bar = rows.find((r) => r.date > predDate && r.date < latest);
  return bar ? { price: Number(bar.close), at: bar.date } : null;
}

/**
 * Score pending predictions whose horizon has elapsed. Entries that aren't due
 * yet stay pending — they are never scored against an unchanged price.
 *
 * @param {{ minAgeMinutes?: number, thresholdPct?: number, limit?: number }} [opts]
 */
export function evaluatePending(opts = {}) {
  // Serialized so two overlapping evaluations don't both settle the same entries.
  return withFileLock(LOG_PATH, () => evaluatePendingUnlocked(opts));
}

async function evaluatePendingUnlocked(opts = {}) {
  const minAgeMinutes = Number.isFinite(opts.minAgeMinutes) ? opts.minAgeMinutes : 0;
  const thresholdPct = Number.isFinite(opts.thresholdPct) ? opts.thresholdPct : 0.15; // move larger than this => UP/DOWN else SIDEWAYS
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 30;
  const log = loadLog();
  const patches = []; // applied to a fresh read at the end: logPrediction may have appended while we awaited prices
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
      const settled = await settlementPrice(entry, now);
      if (!settled || !settled.price || !entry.lastClose) continue; // not due yet

      const retPct = ((settled.price - entry.lastClose) / entry.lastClose) * 100;
      // Scale threshold a bit with ATR if present
      let thr = thresholdPct;
      if (entry.atr && entry.lastClose) {
        const atrPct = (entry.atr / entry.lastClose) * 100;
        thr = Math.max(thresholdPct, atrPct * 0.35);
      }
      const realizedLabel = labelFromReturn(retPct, thr);
      patches.push({
        id: entry.id,
        fields: {
          evaluated: true,
          evalTs: new Date().toISOString(),
          settledAt: settled.at,
          futureClose: settled.price,
          realizedRetPct: retPct,
          realizedLabel,
          hitBias: realizedLabel === entry.bias,
          hitTopProb: realizedLabel === topProbLabel(entry),
          evalThresholdPct: thr,
        },
      });
      updated++;
    } catch {
      /* skip this entry */
    }
  }

  const fresh = loadLog();
  const byId = new Map(fresh.entries.map((e) => [e.id, e]));
  for (const { id, fields } of patches) {
    const e = byId.get(id);
    if (e) Object.assign(e, fields);
  }
  saveLog(fresh);
  return { checked, updated, stats: computeStats(fresh.entries) };
}

/**
 * One scored prediction per stock per mode/interval per IST day (the earliest).
 * Repeated runs on the same day overlap heavily, so counting each one would
 * make hit-rates look more certain than they are.
 */
export function dedupeDaily(entries) {
  const seen = new Set();
  const out = [];
  for (const e of [...entries].sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
    const day = new Date(new Date(e.ts).getTime() + 19800_000).toISOString().slice(0, 10);
    const key = `${e.symbol}|${e.mode}|${e.intervalMinutes}|${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function computeStats(entries) {
  const all = entries || loadLog().entries;
  const evaluatedRaw = all.filter((e) => e.evaluated);
  const evaluated = dedupeDaily(evaluatedRaw);
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
    evaluatedRaw: evaluatedRaw.length, // before one-per-stock-per-day de-duplication
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
    ...valueOfAdditions(evaluated),
    recentEvaluated: evaluated.slice(-10).reverse(),
    recentPending: pending.slice(-10).reverse(),
  };
}

const KEYS = { UP: 'probUp', DOWN: 'probDown', SIDEWAYS: 'probSideways' };

/** Minimum scored tilted predictions before the auto-off rule can trigger. */
export const TILT_MIN_EVIDENCE = 20;

/** Brier with vs without the news tilt, on evaluated entries where a tilt was applied. */
function tiltEvidence(evaluated) {
  const t = evaluated.filter((e) => e.preNews);
  if (!t.length) return { n: 0, autoDisabled: false };
  const withTilt = t.reduce((a, e) => a + brierOf(e, e.realizedLabel), 0) / t.length;
  const without = t.reduce((a, e) => a + brierOf(e.preNews, e.realizedLabel), 0) / t.length;
  return {
    n: t.length,
    brierWithTilt: withTilt,
    brierWithout: without,
    verdict: withTilt < without ? 'helps' : 'does not help',
    autoDisabled: t.length >= TILT_MIN_EVIDENCE && withTilt >= without,
  };
}

/** For each extracted news fact, what actually followed (measurement only). */
function factOutcomes(evaluated) {
  const out = {};
  for (const e of evaluated) {
    if (!e.newsFacts) continue;
    for (const [k, v] of Object.entries(e.newsFacts)) {
      const key = `${k}:${v}`;
      out[key] ||= { n: 0, UP: 0, DOWN: 0, SIDEWAYS: 0 };
      out[key].n++;
      out[key][e.realizedLabel]++;
    }
  }
  return out;
}

/** Is the news tilt allowed right now? (false once evidence shows it hurts) */
export function newsTiltAllowed() {
  return !tiltEvidence(dedupeDaily(loadLog().entries.filter((e) => e.evaluated))).autoDisabled;
}
const brierOf = (p, label) => ['UP', 'DOWN', 'SIDEWAYS'].reduce((a, l) => a + ((Number(p?.[KEYS[l]]) || 0) - (l === label ? 1 : 0)) ** 2, 0);

/**
 * Does Ling's adjustment help, and does news sentiment carry information?
 * Measured on evaluated entries only.
 */
function valueOfAdditions(evaluated) {
  const adj = evaluated.filter((e) => e.llmAdjusted && e.base);
  const llm = adj.length
    ? {
        n: adj.length,
        brierAdjusted: adj.reduce((a, e) => a + brierOf(e, e.realizedLabel), 0) / adj.length,
        brierBase: adj.reduce((a, e) => a + brierOf(e.base, e.realizedLabel), 0) / adj.length,
      }
    : { n: 0 };
  if (llm.n) llm.verdict = llm.brierAdjusted < llm.brierBase ? 'helps' : 'does not help';
  // News: on entries that moved, how often did the sentiment sign match the direction?
  const moved = evaluated.filter((e) => e.newsSentiment != null && Math.abs(e.newsSentiment) >= 0.2 && e.realizedLabel !== 'SIDEWAYS');
  const news = {
    n: moved.length,
    directionHitRate: moved.length
      ? moved.filter((e) => (e.newsSentiment > 0 ? 'UP' : 'DOWN') === e.realizedLabel).length / moved.length
      : null,
    tilt: tiltEvidence(evaluated),
    facts: factOutcomes(evaluated),
  };
  return { llmValue: llm, newsValue: news };
}

export function getHistory(limit = 50) {
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 50));
  const log = loadLog();
  return log.entries.slice(-n).reverse();
}
