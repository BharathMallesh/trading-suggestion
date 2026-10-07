// Feature extraction for the context model: everything a prediction at bar i
// could know at that bar's close — the stock's own technicals and regime, the
// market (NIFTY 50), volatility (India VIX), and session/calendar effects.
// No look-ahead: every value uses bars at or before i only.
// Research only — not investment advice.

import { computeIndicators } from './indicators.mjs';
import { techScore } from './groww-predict.mjs';

export const MARKET_INDEX = '^NSEI';
export const VIX_INDEX = '^INDIAVIX';

/** Feature groups, in the order the ablation adds them. */
export const FEATURE_GROUPS = {
  tech: ['score'],
  stock: ['rsi', 'ret5', 'ret20', 'atrPct', 'atrRank', 'trend', 'logVol'],
  market: ['idxRet5', 'idxRet20', 'idxScore', 'relStr20'],
  vix: ['vixZ', 'vixChg5'],
  session: ['gapPct', 'firstHalfHour', 'lastHalfHour', 'resultsSeason'],
};
export const ALL_FEATURES = Object.values(FEATURE_GROUPS).flat();

const LOOKBACK = 60;
const clip = (x, lim) => Math.max(-lim, Math.min(lim, Number.isFinite(x) ? x : 0));

/** True when the context model applies: Indian listings (the model is fitted on NSE data). */
export const isIndianListing = (sym) => /\.(NS|BO)$/i.test(String(sym || ''));

/**
 * Indian results season (quarterly earnings cluster): roughly the 10th of
 * Jan/Apr/Jul/Oct through mid next month. A calendar proxy, because exact
 * earnings dates aren't available from the free data source.
 */
export function inResultsSeason(dateStr) {
  const m = Number(String(dateStr).slice(5, 7));
  const d = Number(String(dateStr).slice(8, 10));
  if ([1, 4, 7, 10].includes(m)) return d >= 10 ? 1 : 0;
  if ([2, 5, 8, 11].includes(m)) return d <= 15 ? 1 : 0;
  return 0;
}

/** ATR% series (14-bar simple average true range / close), one value per bar. */
function atrPctSeries(rows) {
  const out = new Array(rows.length).fill(null);
  let sum = 0;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const pc = rows[i - 1].close;
    const tr = Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - pc), Math.abs(rows[i].low - pc));
    trs.push(tr);
    sum += tr;
    if (trs.length > 14) sum -= trs[trs.length - 15];
    if (trs.length >= 14) out[i] = (sum / 14 / rows[i].close) * 100;
  }
  return out;
}

/** Index of the last bar with ts <= t (as-of join), or -1. */
function asOf(rows, t) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Precompute per-series helpers once, so per-bar features are cheap.
 * @param {object[]} rows   stock candles (oldest first, with ts)
 * @param {{ index?: object[], vix?: object[] }} ctx  NIFTY / VIX candles at the same interval
 */
export function prepare(rows, ctx = {}) {
  const idxCache = new Map();
  const index = ctx.index || [];
  const vix = ctx.vix || [];
  return {
    rows,
    atrPct: atrPctSeries(rows),
    index,
    vix,
    indexAt(j) {
      if (!idxCache.has(j)) {
        const ind = computeIndicators(index.slice(Math.max(0, j - LOOKBACK + 1), j + 1));
        idxCache.set(j, { ret5: ind.ret5, ret20: ind.ret20, score: techScore(ind) });
      }
      return idxCache.get(j);
    },
  };
}

/**
 * Feature vector (object) at bar i, or null when the market context for that
 * bar is missing (index/VIX not available as of that time).
 */
export function featuresAt(prep, i) {
  const { rows } = prep;
  const bar = rows[i];
  const window = rows.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
  const ind = computeIndicators(window);
  const close = bar.close;
  const atr = ind.atr14;

  const j = prep.index.length ? asOf(prep.index, bar.ts) : -1;
  const k = prep.vix.length ? asOf(prep.vix, bar.ts) : -1;
  if (j < 25 || k < 60) return null;
  const idx = prep.indexAt(j);
  const vixNow = prep.vix[k].close;
  const vixWin = prep.vix.slice(k - 59, k + 1).map((r) => r.close);
  const vMean = vixWin.reduce((a, b) => a + b, 0) / vixWin.length;
  const vStd = Math.sqrt(vixWin.reduce((a, b) => a + (b - vMean) ** 2, 0) / vixWin.length) || 1;

  const hist = prep.atrPct.slice(Math.max(0, i - 99), i + 1).filter((v) => v != null);
  const cur = prep.atrPct[i];
  const atrRank = cur != null && hist.length ? hist.filter((v) => v < cur).length / hist.length : 0.5;

  const hhmm = String(bar.date).slice(11, 16); // '' for daily bars
  const prevClose = i > 0 ? rows[i - 1].close : bar.open;

  return {
    score: techScore(ind),
    rsi: ind.rsi14 != null ? (ind.rsi14 - 50) / 50 : 0,
    ret5: clip(ind.ret5, 20),
    ret20: clip(ind.ret20, 40),
    atrPct: clip(atr && close ? (atr / close) * 100 : 0, 20),
    atrRank,
    trend: clip(ind.sma20 != null && ind.sma50 != null && atr ? (ind.sma20 - ind.sma50) / atr : 0, 10),
    logVol: clip(ind.volRatio ? Math.log(ind.volRatio) : 0, 3),
    idxRet5: clip(idx.ret5, 20),
    idxRet20: clip(idx.ret20, 40),
    idxScore: idx.score,
    relStr20: clip((ind.ret20 ?? 0) - (idx.ret20 ?? 0), 40),
    vixZ: clip((vixNow - vMean) / vStd, 5),
    vixChg5: clip(k >= 5 ? (vixNow / prep.vix[k - 5].close - 1) * 100 : 0, 50),
    gapPct: clip(prevClose ? ((bar.open - prevClose) / prevClose) * 100 : 0, 20),
    firstHalfHour: hhmm && hhmm < '09:45' ? 1 : 0,
    lastHalfHour: hhmm && hhmm >= '15:00' ? 1 : 0,
    resultsSeason: inResultsSeason(bar.date),
  };
}
