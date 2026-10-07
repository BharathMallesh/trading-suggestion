// Hybrid probability: technical base score → Ling adjusts within limits.
// Yahoo (default) or Groww candles. Experimental / paper research only.

import { chat } from '../ling-client.mjs';
import { historicalCandles } from '../groww-data.mjs';
import { candles as yahooCandles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { logPrediction } from './prediction-log.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';
import { calibratedProbs, intervalKey, loadCalibration } from './calibration.mjs';
import { prepare, featuresAt, isIndianListing, MARKET_INDEX, VIX_INDEX } from './features.mjs';
import { predictLogistic, toRow, moveOnly } from './context-model.mjs';
import { newsBrief } from './news.mjs';
import { HttpError, badRequest } from '../util.mjs';

const ADJUST_MAX = 0.15; // Ling may move each leg by at most ±15 percentage points (as fraction)

const SYSTEM = `
You are a quantitative research assistant for PAPER TRADING education only.
You receive a TECHNICAL BASE probability mix already computed from indicators.
Your job: lightly adjust those weights using the candle context, then explain.

Output ONLY a JSON object (no markdown fences):
{
  "probUp": 0.0,
  "probDown": 0.0,
  "probSideways": 0.0,
  "bias": "UP" | "DOWN" | "SIDEWAYS",
  "confidence": 0.0,
  "horizon": "next session",
  "summary": "2-4 sentences",
  "drivers": ["..."],
  "risks": ["..."],
  "adjustmentNote": "one sentence on how/why you adjusted the base"
}

Hard rules:
- Start from the provided base probabilities.
- Do NOT move any of probUp, probDown, probSideways by more than 0.15 from the base.
- After adjustment, values must still sum to 1.
- bias = whichever of up/down/sideways is largest after adjustment.
- confidence 0-1: higher when trend, RSI, and volume agree.
- Educational only — not a trade recommendation.
`.trim();

/** Strip Yahoo-style suffix for Groww trading symbol */
export function toGrowwSymbol(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, '')
    .replace(/\.BO$/i, '');
}

/** "YYYY-MM-DD HH:mm:ss" in IST (UTC+5:30), independent of this machine's timezone. */
export function formatIST(d) {
  return new Date(d.getTime() + 19800 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const yahooSymbolCache = new Map();

/**
 * Resolve user input to a Yahoo symbol. Anything already qualified (has a
 * suffix like .NS/.BO/.L, or is an index/crypto/FX like ^NSEI, BTC-USD,
 * INR=X) is used as-is. A bare ticker is tried as NSE first (HDFCBANK →
 * HDFCBANK.NS), then as-is (AAPL), so both Indian and US tickers work.
 * @param {string} symbol
 * @returns {Promise<string>}
 */
export async function resolveYahooSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) throw badRequest('symbol is required, e.g. HDFCBANK or RELIANCE.NS');
  if (/[.^=-]/.test(raw)) return raw;
  if (yahooSymbolCache.has(raw)) return yahooSymbolCache.get(raw);
  let resolved = raw;
  try {
    await yahooCandles(`${raw}.NS`, { range: '5d', interval: '1d' });
    resolved = `${raw}.NS`;
  } catch (err) {
    if (err.status !== 404) throw err; // network / rate-limit: surface it
  }
  yahooSymbolCache.set(raw, resolved);
  return resolved;
}

export async function fetchGrowwRecent(symbol, opts = {}) {
  const gSym = toGrowwSymbol(symbol);
  const intervalMinutes = opts.intervalMinutes || 15;
  const end = new Date();
  const endStr = opts.endTime || formatIST(end);
  const start = new Date(end.getTime() - (opts.lookbackDays || 10) * 86400000);
  const startStr = opts.startTime || formatIST(start);

  const rows = await historicalCandles({
    symbol: gSym,
    exchange: opts.exchange || 'NSE',
    segment: opts.segment || 'CASH',
    startTime: startStr,
    endTime: endStr,
    intervalMinutes,
  });

  const normalized = rows.map((r) => ({
    date: (r.time || '').slice(0, 10) || r.hhmm,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    time: r.time,
  }));

  return { symbol: gSym, source: 'groww', intervalMinutes, rows: normalized, rawCount: rows.length };
}

async function fetchYahooRecent(symbol, opts = {}) {
  const intervalMinutes = opts.intervalMinutes || 15;
  const interval =
    intervalMinutes <= 5 ? '5m' : intervalMinutes <= 15 ? '15m' : intervalMinutes <= 60 ? '60m' : '1d';
  const range = interval === '1d' ? '3mo' : '5d';
  const yahooSym = await resolveYahooSymbol(symbol);
  const rows = await yahooCandles(yahooSym, { range, interval });
  return {
    symbol: yahooSym,
    source: 'yahoo-fallback',
    intervalMinutes,
    rows,
    rawCount: rows.length,
    range,
    interval,
  };
}

/**
 * Context-model probabilities for the LAST bar of `rows`, when a validated
 * context model exists for `key` (see evaluate.mjs) and the symbol is an
 * Indian listing. Fetches NIFTY + India VIX at the same interval/range.
 * In "move" mode the model supplies only the chance of a real move; up vs
 * down comes from the calibrated table (context showed no direction skill).
 * @returns {Promise<{probs:object, meta:object}|null>}
 */
export async function contextProbs(key, rows, yahooSym, { range, interval }, cal = loadCalibration()) {
  const model = cal[key]?.context;
  if (!model?.useContext || !isIndianListing(yahooSym) || !rows?.length || rows[0].ts == null) return null;
  try {
    const [index, vix] = await Promise.all([
      yahooCandles(MARKET_INDEX, { range, interval }),
      yahooCandles(VIX_INDEX, { range, interval }),
    ]);
    const f = featuresAt(prepare(rows, { index, vix }), rows.length - 1);
    if (!f) return null;
    const ctxP = predictLogistic(model, toRow(f, model.features));
    const dir = calibratedProbs(key, f.score, cal)?.probs ?? baseProbabilities(f.score);
    return {
      probs: model.mode === 'move' ? moveOnly(ctxP, dir) : ctxP,
      meta: {
        key: `${key}/context-${model.mode}`,
        fittedAt: cal[key].fittedAt,
        samples: cal[key].samples,
        skillPct: cal[key].test?.skillPct?.[model.mode === 'move' ? 'contextMove' : 'context'] ?? null,
      },
    };
  } catch {
    return null; // context is an enhancement; fall back to calibration
  }
}

/**
 * Technical score in [-1, +1].
 * +1 = strong bullish structure, -1 = strong bearish, 0 = mixed/chop.
 */
export function techScore(ind) {
  if (!ind || ind.close == null) return 0;
  let score = 0;
  let weight = 0;

  // Trend vs SMAs
  if (ind.sma20 != null) {
    const w = 0.3;
    if (ind.aboveSma20) score += w;
    else score -= w;
    weight += w;
  }
  if (ind.sma50 != null) {
    const w = 0.25;
    if (ind.aboveSma50) score += w;
    else score -= w;
    weight += w;
  }
  if (ind.sma20 != null && ind.sma50 != null) {
    const w = 0.15;
    if (ind.sma20AboveSma50) score += w;
    else score -= w;
    weight += w;
  }

  // RSI: mid is neutral; extremes push opposite (mean-reversion pressure) but mild trend with RSI
  if (ind.rsi14 != null) {
    const w = 0.2;
    if (ind.rsi14 >= 55 && ind.rsi14 <= 68) score += w * 0.8; // healthy up momentum
    else if (ind.rsi14 > 68 && ind.rsi14 < 80) score += w * 0.2; // overbought — weak long bias
    else if (ind.rsi14 >= 80) score -= w * 0.5; // extreme OB — pullback risk
    else if (ind.rsi14 <= 45 && ind.rsi14 >= 32) score -= w * 0.8;
    else if (ind.rsi14 < 32 && ind.rsi14 > 20) score -= w * 0.2;
    else if (ind.rsi14 <= 20) score += w * 0.5; // extreme OS — bounce risk
    weight += w;
  }

  // Short-term return
  if (ind.ret5 != null) {
    const w = 0.1;
    if (ind.ret5 > 1.5) score += w;
    else if (ind.ret5 < -1.5) score -= w;
    else score += (ind.ret5 / 5) * w; // scaled small contribution
    weight += w;
  }

  if (weight <= 0) return 0;
  // Normalize roughly into [-1,1]
  let s = score / Math.max(weight, 0.01);
  // Soft volume: low volume pulls toward 0 (less conviction)
  if (ind.volRatio != null && ind.volRatio < 0.7) s *= 0.7;
  if (ind.volRatio != null && ind.volRatio > 1.3) s *= 1.1;
  return Math.max(-1, Math.min(1, s));
}

/**
 * Map tech score → base probability triangle (sums to 1).
 * Symmetric and monotone: score 0 → 25% up / 25% down / 50% sideways; as
 * |score| grows, sideways shrinks (to 20%) and the winning side takes a
 * larger share of the directional mass (to ~72% / 8%).
 */
export function baseProbabilities(score) {
  const abs = Math.min(1, Math.abs(Number(score) || 0));
  const side = 0.5 - 0.3 * abs;
  const directional = 1 - side;
  const win = directional * (0.5 + 0.4 * abs);
  const lose = directional - win;
  const up = score >= 0 ? win : lose;
  const down = score >= 0 ? lose : win;
  return { probUp: up, probDown: down, probSideways: side };
}

function normalizeProbs(up, down, side) {
  up = Math.max(0.05, up);
  down = Math.max(0.05, down);
  side = Math.max(0.05, side);
  const sum = up + down + side;
  return {
    probUp: up / sum,
    probDown: down / sum,
    probSideways: side / sum,
  };
}

/**
 * Keep each leg within ±maxDelta of the base AND make the legs sum to 1.
 * (Clamping then re-normalizing would push legs back past the cap.)
 * Iteratively clamps and spreads the leftover over legs that still have room.
 */
export function clampToBase(adjusted, base, maxDelta = ADJUST_MAX) {
  const keys = ['probUp', 'probDown', 'probSideways'];
  const lo = keys.map((k) => Math.max(0, base[k] - maxDelta));
  const hi = keys.map((k) => Math.min(1, base[k] + maxDelta));
  let p = keys.map((k, i) => Math.min(hi[i], Math.max(lo[i], Number(adjusted[k]) || 0)));
  for (let iter = 0; iter < 50; iter++) {
    const diff = 1 - p.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) < 1e-12) break;
    const free = p.map((v, i) => (diff > 0 ? v < hi[i] - 1e-12 : v > lo[i] + 1e-12));
    const n = free.filter(Boolean).length;
    if (!n) break;
    p = p.map((v, i) => (free[i] ? Math.min(hi[i], Math.max(lo[i], v + diff / n)) : v));
  }
  return { probUp: p[0], probDown: p[1], probSideways: p[2] };
}

/** Which leg is largest. */
export function topLabel(pr) {
  if (pr.probUp >= pr.probDown && pr.probUp >= pr.probSideways) return 'UP';
  if (pr.probDown >= pr.probSideways) return 'DOWN';
  return 'SIDEWAYS';
}

export function parseProb(raw, base, llmError = null) {
  const text = String(raw || '').trim();
  const p = extractJson(text, (o) => 'probUp' in o || 'probDown' in o || 'probSideways' in o);
  if (p) {
    let up = Math.max(0, Number(p.probUp) || 0);
    let down = Math.max(0, Number(p.probDown) || 0);
    let side = Math.max(0, Number(p.probSideways) || 0);
    if (up > 1 || down > 1 || side > 1) {
      up /= 100;
      down /= 100;
      side /= 100;
    }
    let adj = normalizeProbs(up, down, side);
    if (base) adj = clampToBase(adj, base);
    return {
      ...adj,
      // Bias is derived from the FINAL numbers, never trusted from the model,
      // so the label can't contradict the probabilities shown next to it.
      bias: topLabel(adj),
      confidence: normalizeConfidence(p.confidence, 0.45),
      summary: String(p.summary || '').slice(0, 900),
      drivers: Array.isArray(p.drivers) ? p.drivers.map(String).slice(0, 6) : [],
      risks: Array.isArray(p.risks) ? p.risks.map(String).slice(0, 6) : [],
      adjustmentNote: String(p.adjustmentNote || '').slice(0, 300),
    };
  }
  // Fallback: pure technical base
  const b = base || { probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 };
  let why;
  if (llmError && /OPENROUTER_API_KEY/.test(llmError)) why = 'AI adjustment skipped — OPENROUTER_API_KEY is not set on the server.';
  else if (llmError) why = `AI adjustment unavailable (${llmError.slice(0, 120)}).`;
  else if (text) why = `Model reply could not be parsed (${text.slice(0, 80)}).`;
  else why = 'Model returned an empty reply.';
  return {
    ...b,
    bias: topLabel(b),
    confidence: 0.4,
    summary: `${why} Showing the technical base probabilities only.`,
    drivers: ['Technical base score (SMA / RSI / returns)'],
    risks: ['Ling adjustment unavailable'],
    adjustmentNote: 'No LLM adjustment applied',
  };
}

/** Weights for multi-horizon blend (must sum ~1). Longer horizons = structure; short = timing. */
const HORIZON_WEIGHTS = {
  m2: 0.2, // ~2 months daily
  m1: 0.2, // ~1 month daily
  today: 0.25, // today's session
  h1: 0.2, // last ~1 hour
  m15: 0.15, // last ~15 minutes
};

/**
 * Score for windows too short for SMA-20 / RSI-14 (e.g. the last hour or the
 * last 15 minutes): net move across the window (0.5% ≈ full strength) plus
 * where the last close sits in the window's high-low range.
 */
export function shortWindowScore(rows) {
  if (!rows || rows.length < 2) return 0;
  const first = Number(rows[0].open ?? rows[0].close);
  const last = Number(rows[rows.length - 1].close);
  if (!(first > 0)) return 0;
  const hi = Math.max(...rows.map((r) => r.high));
  const lo = Math.min(...rows.map((r) => r.low));
  const retScore = Math.max(-1, Math.min(1, ((last / first - 1) * 100) / 0.5));
  const pos = hi > lo ? ((last - lo) / (hi - lo)) * 2 - 1 : 0;
  return Math.max(-1, Math.min(1, 0.6 * retScore + 0.4 * pos));
}

/**
 * Score one window and turn it into probabilities. Windows long enough for the
 * full indicator score use the fitted calibration table for `calKey` when one
 * exists and beat the formula in replay (see evaluate.mjs); otherwise the
 * formula. Short price-action windows always use the formula.
 */
function scoreWindow(rows, label, minBars = 5, calKey = null, cal = {}, shortVariant = null) {
  if (!rows || rows.length < minBars) return null;
  const ind = computeIndicators(rows);
  // Full indicator score needs ~20 bars; shorter windows use price action only.
  const full = rows.length >= 20;
  const score = full ? techScore(ind) : shortWindowScore(rows);
  const fitted = !calKey ? null : full ? calibratedProbs(calKey, score, cal) : shortVariant ? calibratedProbs(calKey, score, cal, shortVariant) : null;
  const base = fitted ? fitted.probs : baseProbabilities(score);
  return {
    label,
    bars: rows.length,
    score,
    base,
    calibrated: fitted ? fitted.meta : null,
    rsi: ind.rsi14,
    close: ind.close,
    ret5: ind.ret5,
  };
}

function weightedBlend(windows) {
  // windows: [{ weight, base, score }]
  let up = 0;
  let down = 0;
  let side = 0;
  let score = 0;
  let wSum = 0;
  for (const w of windows) {
    if (!w?.base) continue;
    up += w.base.probUp * w.weight;
    down += w.base.probDown * w.weight;
    side += w.base.probSideways * w.weight;
    score += w.score * w.weight;
    wSum += w.weight;
  }
  if (wSum <= 0) {
    return {
      base: { probUp: 0.33, probDown: 0.33, probSideways: 0.34 },
      score: 0,
    };
  }
  // Renormalize if some windows missing
  up /= wSum;
  down /= wSum;
  side /= wSum;
  score /= wSum;
  return { base: normalizeProbs(up, down, side), score };
}

function buildUserPayload(meta, rows, ind, base, score, horizons) {
  const last = rows[rows.length - 1];
  const tail = rows.slice(-6);
  const lines = tail
    .map(
      (r) =>
        `${r.time || r.date}: O=${Number(r.open).toFixed(2)} H=${Number(r.high).toFixed(2)} L=${Number(r.low).toFixed(2)} C=${Number(r.close).toFixed(2)}`,
    )
    .join('\n');

  const horizonLines = (horizons || [])
    .filter(Boolean)
    .map(
      (h) =>
        `  ${h.label}: score=${h.score.toFixed(2)} up=${(h.base.probUp * 100).toFixed(0)}% down=${(h.base.probDown * 100).toFixed(0)}% side=${(h.base.probSideways * 100).toFixed(0)}% (n=${h.bars})`,
    )
    .join('\n');

  return [
    `Symbol: ${meta.symbol} | Primary interval: ${meta.intervalMinutes}m | Source: ${meta.source}`,
    `Latest close: ${Number(last.close).toFixed(2)} (${last.time || last.date})`,
    `SMA-20: ${ind.sma20?.toFixed(2) ?? 'n/a'} | SMA-50: ${ind.sma50?.toFixed(2) ?? 'n/a'}`,
    `RSI-14: ${ind.rsi14?.toFixed(1) ?? 'n/a'} | Vol: ${ind.volRatio != null ? ind.volRatio.toFixed(2) + 'x' : 'n/a'}`,
    '',
    'MULTI-HORIZON technical scores:',
    horizonLines || '  (none)',
    '',
    `COMBINED tech score: ${score.toFixed(3)} (−1 bear … +1 bull)`,
    `BASE probabilities (do not move any leg by more than 0.15):`,
    `  probUp=${base.probUp.toFixed(3)}  probDown=${base.probDown.toFixed(3)}  probSideways=${base.probSideways.toFixed(3)}`,
    '',
    'Recent primary candles:',
    lines,
    '',
    'Return adjusted probability JSON for near-term direction now.',
  ].join('\n');
}

/**
 * Fetch multi-horizon windows and build combined base probabilities.
 */
async function buildMultiHorizon(symbol, cal = loadCalibration()) {
  const yahooSym = await resolveYahooSymbol(symbol);
  const horizons = [];

  // Daily: ~2 months and ~1 month
  let daily = [];
  try {
    daily = await yahooCandles(yahooSym, { range: '3mo', interval: '1d' });
  } catch {
    daily = [];
  }
  if (daily.length >= 20) {
    const m2 = scoreWindow(daily.slice(-45), '2-month (daily)', 5, '1d', cal);
    const m1 = scoreWindow(daily.slice(-22), '1-month (daily)', 5, '1d', cal);
    // Context model (next-session horizon) scores the latest daily bar once;
    // it applies to both daily windows.
    const dctx = await contextProbs('1d', daily, yahooSym, { range: '3mo', interval: '1d' }, cal);
    for (const w of [m2, m1]) if (w && dctx) Object.assign(w, { base: dctx.probs, calibrated: dctx.meta });
    if (m2) horizons.push({ key: 'm2', weight: HORIZON_WEIGHTS.m2, ...m2 });
    if (m1) horizons.push({ key: 'm1', weight: HORIZON_WEIGHTS.m1, ...m1 });
  }

  // Intraday 5m for today / 1h / 15m (more bars)
  let intra = [];
  let intraKey = '5m';
  try {
    intra = await yahooCandles(yahooSym, { range: '5d', interval: '5m' });
  } catch {
    try {
      intraKey = '15m';
      intra = await yahooCandles(yahooSym, { range: '5d', interval: '15m' });
    } catch {
      intra = [];
    }
  }

  if (intra.length >= 8) {
    // Today: bars from last calendar date in series
    // Intraday bar dates are "YYYY-MM-DD HH:MM"; group by the day part.
    const lastDate = String(intra[intra.length - 1].date || '').slice(0, 10);
    const todayBars = intra.filter((r) => String(r.date || '').slice(0, 10) === lastDate);
    const todayWin = scoreWindow(todayBars.length >= 8 ? todayBars : intra.slice(-78), 'Today (session)', 5, intraKey, cal);
    const tctx = todayWin ? await contextProbs(intraKey, intra, yahooSym, { range: '5d', interval: intraKey }, cal) : null;
    if (tctx) Object.assign(todayWin, { base: tctx.probs, calibrated: tctx.meta });
    if (todayWin) horizons.push({ key: 'today', weight: HORIZON_WEIGHTS.today, ...todayWin });

    // Last ~1 hour: 12 x 5m or 4 x 15m
    const h1Bars = intra.slice(-12);
    // Short-window tables are fitted on 5m bars only.
    const h1 = scoreWindow(h1Bars, 'Last ~1 hour', 5, intraKey === '5m' ? '5m' : null, cal, 'short12');
    if (h1) horizons.push({ key: 'h1', weight: HORIZON_WEIGHTS.h1, ...h1 });

    // Last ~15 min: 3 x 5m (allow short window)
    const m15Bars = intra.slice(-3);
    const m15 = scoreWindow(m15Bars, 'Last ~15 min', 2, intraKey === '5m' ? '5m' : null, cal, 'short3');
    if (m15) horizons.push({ key: 'm15', weight: HORIZON_WEIGHTS.m15, ...m15 });
  }

  const { base, score } = weightedBlend(horizons);
  return { yahooSym, horizons, base, score, daily, intra };
}

/**
 * Main entry: technical base (+ optional multi-horizon) + Ling adjustment (±15%).
 * @param {string} symbol
 * @param {{ intervalMinutes?: number, preferYahoo?: boolean, mode?: '15m'|'multi' }} [opts]
 *   mode '15m'   = single timeframe (primary interval only)
 *   mode 'multi' = 2m + 1m + today + 1h + 15m weighted blend (default)
 */
export async function growwProbability(symbol, opts = {}) {
  if (!String(symbol || '').trim()) throw badRequest('symbol is required, e.g. HDFCBANK or RELIANCE.NS');
  const intervalMinutes = [5, 15, 60, 1440].includes(Number(opts.intervalMinutes)) ? Number(opts.intervalMinutes) : 15;
  const mode = opts.mode === '15m' ? '15m' : 'multi';
  let meta;
  let usedFallback = false;

  // Primary display series (user-selected interval)
  if (opts.preferYahoo || !process.env.GROWW_ACCESS_TOKEN) {
    meta = await fetchYahooRecent(symbol, { intervalMinutes });
    usedFallback = meta.source.includes('yahoo');
  } else {
    try {
      meta = await fetchGrowwRecent(symbol, {
        intervalMinutes,
        lookbackDays: opts.lookbackDays || 10,
      });
    } catch (err) {
      meta = await fetchYahooRecent(symbol, { intervalMinutes });
      usedFallback = true;
      meta.growwError = err.message;
    }
  }

  if (!meta.rows?.length || meta.rows.length < 15) {
    throw new HttpError(
      400,
      `Not enough candles from ${meta.source} for ${symbol} (${meta.rows?.length || 0} bars). ` +
        (meta.growwError ? `Groww: ${meta.growwError}` : ''),
    );
  }

  const ind = computeIndicators(meta.rows);

  const cal = loadCalibration();
  let score = techScore(ind);
  const primaryCal =
    (meta.range && (await contextProbs(intervalKey(intervalMinutes), meta.rows, meta.symbol, meta, cal))) ||
    calibratedProbs(intervalKey(intervalMinutes), score, cal);
  let base = primaryCal ? primaryCal.probs : baseProbabilities(score);
  let horizons = [];
  // ATR used for the expected-move bands; multi-horizon mode switches to the
  // DAILY ATR because its window is "1–3 sessions" (a 15-min ATR would
  // understate the range several-fold).
  let moveAtr = ind.atr14;

  // Multi-horizon only when mode === 'multi'
  if (mode === 'multi') {
    let multi;
    try {
      multi = await buildMultiHorizon(symbol, cal);
    } catch {
      multi = null;
    }
    if (multi?.horizons?.length) {
      base = multi.base;
      score = multi.score;
      horizons = multi.horizons;
    }
    if (multi?.daily?.length >= 15) moveAtr = computeIndicators(multi.daily.slice(-60)).atr14 ?? moveAtr;
  } else {
    // Single-horizon label for UI transparency
    horizons = [
      {
        key: '15m',
        label: `Primary ${intervalMinutes}m only`,
        weight: 1,
        score,
        bars: meta.rows.length,
        base,
        probUp: base.probUp,
        probDown: base.probDown,
        probSideways: base.probSideways,
        rsi: ind.rsi14,
        calibrated: primaryCal ? primaryCal.meta : null,
      },
    ];
  }

  const user = buildUserPayload(meta, meta.rows, ind, base, score, horizons);

  let raw = '';
  let llmError = null;
  try {
    raw = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      { temperature: 0.15, timeoutMs: 45_000, jsonKeys: ['probUp', 'probDown'], retryEmpty: 0 },
    );
  } catch (err) {
    raw = '';
    llmError = err.message || String(err);
  }

  // Retry once with a compact prompt if the reply was empty / not JSON —
  // but not when the key is missing (it would fail identically).
  if (!/OPENROUTER_API_KEY/.test(llmError || '') && (!String(raw || '').trim() || !String(raw).match(/\{[\s\S]*\}/))) {
    try {
      raw = await chat(
        [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `${meta.symbol} multiHorizonScore=${score.toFixed(2)} base up=${base.probUp.toFixed(2)} down=${base.probDown.toFixed(2)} side=${base.probSideways.toFixed(2)} RSI=${ind.rsi14?.toFixed(1)}. Adjust ≤0.15 and return JSON.`,
          },
        ],
        { temperature: 0.1, timeoutMs: 30_000, jsonKeys: ['probUp', 'probDown'], retryEmpty: 0 },
      );
      llmError = null;
    } catch (err) {
      llmError = err.message || String(err);
    }
  }

  const prediction = parseProb(raw, base, llmError);
  const last = meta.rows[meta.rows.length - 1];
  const move = expectedMoveEstimate({
    close: last.close,
    atr: moveAtr,
    mode,
    intervalMinutes,
    bias: prediction.bias,
  });

  // Signal strength: how far the final numbers are from the historical base
  // rates for this horizon. Near base rates = the model has nothing to add.
  const climKey = mode === 'multi' ? '1d' : intervalKey(intervalMinutes);
  const clim = cal[climKey]?.climatology || { probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 };
  const devPts = Math.max(
    Math.abs(prediction.probUp - clim.probUp),
    Math.abs(prediction.probDown - clim.probDown),
    Math.abs(prediction.probSideways - clim.probSideways),
  ) * 100;
  const edge = {
    level: devPts < 5 ? 'none' : devPts < 10 ? 'weak' : 'moderate',
    maxDeviationPts: devPts,
    baseRates: clim,
    note:
      devPts < 5
        ? 'Close to historical base rates — no meaningful edge for this stock right now.'
        : devPts < 10
          ? 'Slightly different from base rates — a weak lean, treat with caution.'
          : 'Noticeably different from base rates — still a probability, not a forecast.',
  };

  // One horizon, stated once: the time window the ATR bands describe. The
  // model's own horizon text is dropped so the two labels can't disagree.
  prediction.horizon = move.horizonLabel;
  delete move.horizonLabel;

  const out = {
    symbol: meta.symbol,
    source: meta.source,
    usedFallback,
    growwError: meta.growwError || null,
    intervalMinutes: meta.intervalMinutes,
    mode,
    bars: meta.rawCount,
    asOf: last.time || last.date,
    lastClose: last.close,
    hybrid: {
      techScore: score,
      baseProbabilities: base,
      maxAdjust: ADJUST_MAX,
      multiHorizon: mode === 'multi',
      mode,
      horizons: horizons.map((h) => ({
        key: h.key,
        label: h.label,
        weight: h.weight,
        score: h.score,
        bars: h.bars,
        probUp: (h.base || h).probUp,
        probDown: (h.base || h).probDown,
        probSideways: (h.base || h).probSideways,
        rsi: h.rsi,
        calibrated: h.calibrated || null,
      })),
      // How many of the windows used probabilities fitted on past data
      // (paper-bot/evaluate.mjs) rather than the hand-written formula.
      calibration: {
        windowsCalibrated: horizons.filter((h) => h.calibrated).length,
        windows: horizons.length,
        fittedAt: horizons.find((h) => h.calibrated)?.calibrated.fittedAt || null,
      },
    },
    indicators: {
      sma20: ind.sma20,
      sma50: ind.sma50,
      rsi14: ind.rsi14,
      atr14: ind.atr14,
      volRatio: ind.volRatio,
    },
    /** ATR-based research range + time window — not a price target guarantee */
    expectedMove: move,
    edge,
    prediction,
    disclaimer:
      mode === 'multi'
        ? 'Multi-horizon hybrid + ATR range estimate. Experimental research only. Not investment advice. Ranges are volatility bands, not promises.'
        : 'Single-timeframe hybrid + ATR range estimate. Experimental research only. Not investment advice. Ranges are volatility bands, not promises.',
  };

  // Optional news brief: shown and logged (so its value can be measured), but
  // it does not change the probabilities.
  if (opts.includeNews && /\.(NS|BO)$/i.test(out.symbol)) {
    try {
      out.news = await newsBrief(out.symbol);
    } catch (err) {
      out.news = { headlines: [], brief: null, sentiment: null, note: `News unavailable: ${err.message.slice(0, 100)}` };
    }
  }

  // Auto-log for hit-rate calibration (research)
  try {
    const logged = logPrediction(out);
    if (logged) out.logId = logged.id;
  } catch {
    /* non-fatal */
  }
  return out;
}

/**
 * Rough expected move bands from ATR (research only).
 * Not a forecast that price will hit these levels.
 */
function expectedMoveEstimate({ close, atr, mode, intervalMinutes, bias }) {
  const px = Number(close) || 0;
  const a = Number(atr) || 0;
  const horizonLabel =
    mode === 'multi' ? 'next 1–3 sessions'
      : intervalMinutes <= 5 ? 'next 15–45 minutes'
        : intervalMinutes <= 15 ? 'next 30–90 minutes'
          : intervalMinutes <= 60 ? 'next 2–6 hours'
            : 'next 1–3 sessions';
  if (px <= 0 || a <= 0) {
    return {
      available: false,
      horizonLabel,
      timeWindow: mode === 'multi' ? '1–3 sessions (mixed horizons)' : `next few ${intervalMinutes}m bars`,
      note: 'ATR unavailable — cannot size a range.',
    };
  }

  // Soft / typical / extended multiples of ATR
  const soft = 0.5 * a;
  const typical = 1.0 * a;
  const extended = 1.5 * a;

  const pct = (x) => ((x / px) * 100);

  let timeWindow;
  if (mode === 'multi') {
    timeWindow = 'About 1 session to 1–3 sessions (mix of intraday + daily structure)';
  } else if (intervalMinutes <= 5) {
    timeWindow = 'About next 15–45 minutes (several 5m bars)';
  } else if (intervalMinutes <= 15) {
    timeWindow = 'About next 30–90 minutes (several 15m bars)';
  } else if (intervalMinutes <= 60) {
    timeWindow = 'About next 2–6 hours';
  } else {
    timeWindow = 'About next 1–3 daily sessions';
  }

  const lean =
    bias === 'UP' ? 'upside band slightly emphasized' : bias === 'DOWN' ? 'downside band slightly emphasized' : 'balanced bands (sideways bias)';

  return {
    available: true,
    horizonLabel,
    lastClose: px,
    atr: a,
    timeWindow,
    lean,
    upside: {
      soft: px + soft,
      typical: px + typical,
      extended: px + extended,
      softPct: pct(soft),
      typicalPct: pct(typical),
      extendedPct: pct(extended),
    },
    downside: {
      soft: px - soft,
      typical: px - typical,
      extended: px - extended,
      softPct: pct(soft),
      typicalPct: pct(typical),
      extendedPct: pct(extended),
    },
    note:
      'Ranges = 0.5× / 1× / 1.5× ATR from last close. Volatility bands for research — not targets, stops, or trade instructions.',
  };
}
