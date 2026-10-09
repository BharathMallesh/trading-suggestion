// Cross-sectional stock ranking over weeks–months (library + CLI).
//
// Instead of "will this stock go up tomorrow?" (no measurable skill), ask
// "which stocks in the universe are likely to do better than the others over
// the next 1–3 months?" — where documented effects (momentum, low volatility,
// nearness to 52-week high) exist in many markets including India.
//
// evaluateRanking() replays history at non-overlapping rebalance dates and
// reports, per signal: the information coefficient (rank correlation between
// the signal and the following return), its t-stat, the top-minus-bottom
// quintile spread, stability (both halves), and a top-N portfolio net of
// delivery costs vs the equal-weight universe and NIFTY 50.
// Signals are fixed rules (nothing is fitted), so the whole history is
// out-of-sample for them.
//
// Caveat: the universe is TODAY's NIFTY 50 — survivorship bias flatters
// results a little. Research only; not investment advice.
//
//   node paper-bot/ranking.mjs --horizon 20          # evaluate (1 month)
//   node paper-bot/ranking.mjs --live                # current ranking

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { badRequest, mapLimit } from '../util.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.INDEX_LIST_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data');
/** Official constituent CSVs published by NSE Indices. */
export const INDEX_LISTS = {
  nifty50: 'https://archives.nseindia.com/content/indices/ind_nifty50list.csv',
  nifty100: 'https://archives.nseindia.com/content/indices/ind_nifty100list.csv',
  nifty200: 'https://archives.nseindia.com/content/indices/ind_nifty200list.csv',
  nifty500: 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
};

/** Parse NSE's "Company Name,Industry,Symbol,Series,ISIN Code" CSV → ['SYMBOL.NS', …]. */
export function parseIndexCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const col = head.indexOf('symbol');
  if (col < 0) return [];
  return lines.map((l) => l.split(',')[col]?.trim()).filter(Boolean).map((s) => `${s}.NS`);
}

/** Same CSV → { 'SYMBOL.NS': 'Industry' } (empty when the column is missing). */
export function parseIndexIndustries(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const sc = head.indexOf('symbol');
  const ic = head.indexOf('industry');
  if (sc < 0 || ic < 0) return {};
  const out = {};
  for (const l of lines) {
    const f = l.split(',');
    if (f[sc]?.trim() && f[ic]?.trim()) out[`${f[sc].trim()}.NS`] = f[ic].trim();
  }
  return out;
}

/**
 * Current constituents of an NSE index (cached 7 days in paper-bot/data).
 * Falls back to the built-in NIFTY 50 list if NSE can't be reached.
 */
export async function loadIndexList(name = 'nifty50', { fetchFn = fetch } = {}) {
  const url = INDEX_LISTS[name];
  if (!url) throw badRequest(`Unknown universe "${name}". Use ${Object.keys(INDEX_LISTS).join(', ')}.`);
  const cacheFile = join(DATA, `index-${name}.json`);
  try {
    if (existsSync(cacheFile)) {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (Date.now() - c.at < 7 * 86400000 && c.symbols?.length && c.industries) return { symbols: c.symbols, industries: c.industries, source: 'cache' };
    }
  } catch {
    /* refetch */
  }
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = res.ok ? await res.text() : '';
    const symbols = parseIndexCsv(text);
    if (symbols.length >= 40) {
      const industries = parseIndexIndustries(text);
      mkdirSync(DATA, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), symbols, industries }));
      return { symbols, industries, source: 'NSE' };
    }
  } catch {
    /* fall through */
  }
  // NSE unreachable: an older cache (even without industries) beats the built-in list.
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (c.symbols?.length) return { symbols: c.symbols, industries: c.industries || {}, source: 'stale cache' };
  } catch {
    /* none */
  }
  return { symbols: NIFTY50, industries: {}, source: 'built-in NIFTY 50 (NSE list unavailable)' };
}

/** NIFTY 50 constituents (approximate, Oct 2026). Missing tickers are skipped. */
export const NIFTY50 = [
  'RELIANCE.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'INFY.NS', 'TCS.NS', 'BHARTIARTL.NS', 'ITC.NS', 'LT.NS', 'SBIN.NS', 'AXISBANK.NS',
  'KOTAKBANK.NS', 'HINDUNILVR.NS', 'BAJFINANCE.NS', 'M&M.NS', 'SUNPHARMA.NS', 'MARUTI.NS', 'HCLTECH.NS', 'NTPC.NS', 'TITAN.NS', 'ULTRACEMCO.NS',
  'ASIANPAINT.NS', 'POWERGRID.NS', 'TATASTEEL.NS', 'ONGC.NS', 'BAJAJFINSV.NS', 'NESTLEIND.NS', 'ADANIPORTS.NS', 'COALINDIA.NS', 'WIPRO.NS', 'JSWSTEEL.NS',
  'GRASIM.NS', 'TECHM.NS', 'HINDALCO.NS', 'ADANIENT.NS', 'CIPLA.NS', 'DRREDDY.NS', 'SBILIFE.NS', 'HDFCLIFE.NS', 'BRITANNIA.NS', 'EICHERMOT.NS',
  'HEROMOTOCO.NS', 'APOLLOHOSP.NS', 'TATACONSUM.NS', 'BAJAJ-AUTO.NS', 'INDUSINDBK.NS', 'SHRIRAMFIN.NS', 'BEL.NS', 'TRENT.NS', 'ETERNAL.NS', 'JIOFIN.NS',
];

const DAY = 1; // trading-day units

/** Signal definitions: name → (closes up to and incl. t) → value (higher = rank higher). */
export const SIGNALS = {
  mom12_1: (c) => (c.length > 252 ? c[c.length - 22] / c[c.length - 253] - 1 : null),
  mom6_1: (c) => (c.length > 127 ? c[c.length - 22] / c[c.length - 127] - 1 : null),
  mom3: (c) => (c.length > 63 ? c[c.length - 1] / c[c.length - 64] - 1 : null),
  reversal1m: (c) => (c.length > 21 ? -(c[c.length - 1] / c[c.length - 22] - 1) : null),
  lowVol: (c) => {
    if (c.length < 61) return null;
    const r = [];
    for (let i = c.length - 60; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return -Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  },
  high52: (c) => (c.length >= 252 ? c[c.length - 1] / Math.max(...c.slice(-252)) : null),
  trend: (c) => {
    if (c.length < 200) return null;
    const avg = (n) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
    return avg(50) / avg(200) - 1;
  },
};
/** The composite averages the cross-sectional z-scores of these (fixed, equal weights). */
export const COMPOSITE = ['mom12_1', 'lowVol', 'high52'];
export const ALL_SIGNALS = [...Object.keys(SIGNALS), 'composite'];

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 0;
};

/** Ranks (1..n, average for ties). */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation. */
export function spearman(x, y) {
  if (x.length < 3) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/** Cross-sectional z-scores; null stays null. */
function zscores(vals) {
  const ok = vals.filter((v) => v != null);
  const m = mean(ok);
  const s = std(ok) || 1;
  return vals.map((v) => (v == null ? null : (v - m) / s));
}

/** Signal values for every stock at one date (by index into each close series). */
function signalSnapshot(series, at) {
  // series: [{ symbol, closes, dateIndex: Map(date → i) }]; at: date string
  const rows = [];
  for (const s of series) {
    const i = s.dateIndex.get(at);
    if (i == null) continue;
    const c = s.closes.slice(0, i + 1);
    const v = {};
    for (const [k, f] of Object.entries(SIGNALS)) v[k] = f(c);
    rows.push({ symbol: s.symbol, i, values: v });
  }
  // composite = mean of available component z-scores
  const zs = Object.fromEntries(COMPOSITE.map((k) => [k, zscores(rows.map((r) => r.values[k]))]));
  rows.forEach((r, n) => {
    const parts = COMPOSITE.map((k) => zs[k][n]).filter((z) => z != null);
    r.values.composite = parts.length === COMPOSITE.length ? mean(parts) : null;
  });
  return rows;
}

async function loadUniverse(symbols, load) {
  const loaded = await mapLimit(symbols, 4, async (sym) => {
    try {
      const rows = await load(sym, { range: '5y', interval: '1d' });
      return rows.length > 300 ? { symbol: sym, rows } : { skip: `${sym}: only ${rows.length} bars` };
    } catch (err) {
      return { skip: `${sym}: ${err.message.slice(0, 60)}` };
    }
  });
  const series = loaded.filter((x) => x.symbol).map(({ symbol, rows }) => ({
    symbol,
    dates: rows.map((r) => r.date),
    closes: rows.map((r) => r.close),
    dateIndex: new Map(rows.map((r, i) => [r.date, i])),
  }));
  return { series, skipped: loaded.filter((x) => x.skip).map((x) => x.skip) };
}

/**
 * Replay rankings at non-overlapping rebalance dates.
 * @param {{ horizon?: number, symbols?: string[], topN?: number, costPct?: number, loadCandles?: Function }} [opts]
 *   costPct: round-trip cost per unit of turnover (default 0.25% ≈ delivery STT + charges + slippage)
 */
export async function evaluateRanking(opts = {}) {
  const horizon = Number(opts.horizon) || 20;
  if (![20, 40, 60].includes(horizon)) throw badRequest('horizon must be 20, 40 or 60 trading days.');
  const load = opts.loadCandles || candles;
  const list = opts.symbols?.length ? { symbols: opts.symbols, source: 'custom' } : await loadIndexList(opts.universe || 'nifty50');
  const symbols = list.symbols;
  // Wider universes hold more names in the top bucket (≈ top decile, min 5).
  const topN = opts.topN || Math.max(5, Math.round(symbols.length / 10));
  const costPct = opts.costPct ?? 0.25;
  const { series, skipped } = await loadUniverse(symbols, load);
  if (series.length < 10) throw badRequest(`Need at least 10 stocks with 5y history; got ${series.length}. ${skipped.join(' · ')}`);

  let index = null;
  try {
    const idx = await load('^NSEI', { range: '5y', interval: '1d' });
    index = new Map(idx.map((r) => [r.date, r.close]));
  } catch {
    /* benchmark optional */
  }

  // Calendar: dates present for most stocks; first rebalance once 12m+ history exists.
  const counts = new Map();
  for (const s of series) for (const d of s.dates) counts.set(d, (counts.get(d) || 0) + 1);
  const calendar = [...counts.entries()].filter(([, n]) => n >= series.length * 0.8).map(([d]) => d).sort();
  const start = 260;
  const periods = [];
  let prevTop = new Set();
  for (let k = start; k + horizon < calendar.length; k += horizon) {
    const at = calendar[k];
    const end = calendar[k + horizon];
    const snap = signalSnapshot(series, at);
    const fwd = new Map();
    for (const r of snap) {
      const s = series.find((x) => x.symbol === r.symbol);
      const j = s.dateIndex.get(end);
      if (j != null) fwd.set(r.symbol, s.closes[j] / s.closes[r.i] - 1);
    }
    const rows = snap.filter((r) => fwd.has(r.symbol));
    if (rows.length < 10) continue;
    const per = { date: at, end, n: rows.length, avgRet: mean(rows.map((r) => fwd.get(r.symbol))), signals: {} };
    for (const sig of ALL_SIGNALS) {
      const ok = rows.filter((r) => r.values[sig] != null);
      if (ok.length < 10) continue;
      const x = ok.map((r) => r.values[sig]);
      const y = ok.map((r) => fwd.get(r.symbol));
      const sorted = [...ok].sort((a, b) => b.values[sig] - a.values[sig]);
      const q = Math.max(1, Math.floor(sorted.length / 5));
      const top = sorted.slice(0, q).map((r) => fwd.get(r.symbol));
      const bottom = sorted.slice(-q).map((r) => fwd.get(r.symbol));
      per.signals[sig] = {
        ic: spearman(x, y),
        spread: mean(top) - mean(bottom),
        topN: sorted.slice(0, topN).map((r) => r.symbol),
        topNRet: mean(sorted.slice(0, topN).map((r) => fwd.get(r.symbol))),
      };
    }
    if (index?.has(at) && index?.has(end)) per.indexRet = index.get(end) / index.get(at) - 1;
    periods.push(per);
    prevTop = new Set(per.signals.composite?.topN || []);
  }
  void prevTop;
  if (periods.length < 6) throw badRequest(`Only ${periods.length} rebalance periods — not enough history for horizon ${horizon}.`);

  const perYear = 252 / horizon;
  const summary = {};
  for (const sig of ALL_SIGNALS) {
    const ps = periods.filter((p) => p.signals[sig]?.ic != null);
    if (!ps.length) continue;
    const ics = ps.map((p) => p.signals[sig].ic);
    const half = Math.floor(ps.length / 2);
    // top-N portfolio: equal weight, cost charged on the fraction of names replaced
    let equity = 1;
    let prev = new Set();
    for (const p of ps) {
      const cur = p.signals[sig].topN;
      const turnover = prev.size ? cur.filter((s) => !prev.has(s)).length / cur.length : 1;
      equity *= 1 + p.signals[sig].topNRet - (turnover * costPct) / 100;
      prev = new Set(cur);
    }
    summary[sig] = {
      periods: ps.length,
      meanIC: mean(ics),
      tStat: std(ics) ? (mean(ics) / std(ics)) * Math.sqrt(ics.length) : null,
      pctPositive: (ics.filter((v) => v > 0).length / ics.length) * 100,
      meanICFirstHalf: mean(ics.slice(0, half)),
      meanICSecondHalf: mean(ics.slice(half)),
      spreadPerPeriodPct: mean(ps.map((p) => p.signals[sig].spread)) * 100,
      topNCagrPct: (equity ** (perYear / ps.length) - 1) * 100,
    };
  }
  let ew = 1;
  let idx = 1;
  let idxN = 0;
  for (const p of periods) {
    ew *= 1 + p.avgRet;
    if (p.indexRet != null) {
      idx *= 1 + p.indexRet;
      idxN++;
    }
  }
  const benchmark = {
    equalWeightCagrPct: (ew ** (perYear / periods.length) - 1) * 100,
    niftyCagrPct: idxN ? (idx ** (perYear / idxN) - 1) * 100 : null,
  };
  // "Evidence" flag: positive mean IC, |t| ≥ 2, positive in both halves.
  for (const v of Object.values(summary)) {
    v.evidence = v.tStat != null && v.tStat >= 2 && v.meanICFirstHalf > 0 && v.meanICSecondHalf > 0
      ? 'strong'
      : v.meanIC > 0 && v.meanICFirstHalf > 0 && v.meanICSecondHalf > 0
        ? 'weak'
        : 'none';
  }
  return {
    horizon,
    topN,
    costPct,
    universe: series.length,
    universeName: opts.symbols?.length ? 'custom' : opts.universe || 'nifty50',
    universeSource: list.source,
    skipped,
    from: periods[0].date,
    to: periods[periods.length - 1].end,
    periods: periods.length,
    summary,
    benchmark,
    caveats: [
      "Universe is today's index list (survivorship bias flatters results; wider lists reduce but don't remove it).",
      'Signals are fixed rules — nothing is fitted — but 5 years is still a short sample.',
      'Costs are approximate (round trip on replaced names). Research only, not investment advice.',
    ],
  };
}

/** Current ranking for a universe (latest common date). */
export async function liveRanking(opts = {}) {
  if (opts.sortBy != null && !ALL_SIGNALS.includes(opts.sortBy)) throw badRequest(`sortBy must be one of: ${ALL_SIGNALS.join(', ')}.`);
  const load = opts.loadCandles || candles;
  const symbols = opts.symbols?.length ? opts.symbols : (await loadIndexList(opts.universe || 'nifty50')).symbols;
  const { series, skipped } = await loadUniverse(symbols, load);
  if (series.length < 5) throw badRequest('Need at least 5 stocks with enough history.');
  const latest = series.map((s) => s.dates[s.dates.length - 1]).sort().reverse();
  const at = latest.find((d) => series.filter((s) => s.dateIndex.has(d)).length >= series.length * 0.8) || latest[0];
  const snap = signalSnapshot(series, at);
  const sortBy = ALL_SIGNALS.includes(opts.sortBy) ? opts.sortBy : 'composite';
  const order = [...snap].filter((r) => r.values[sortBy] != null && r.values.composite != null).sort((a, b) => b.values[sortBy] - a.values[sortBy]);
  return {
    asOf: at,
    universe: series.length,
    sortBy,
    skipped,
    ranking: order.map((r, i) => ({
      rank: i + 1,
      symbol: r.symbol,
      composite: r.values.composite,
      score: r.values[sortBy],
      mom12_1Pct: r.values.mom12_1 != null ? r.values.mom12_1 * 100 : null,
      vol60Pct: r.values.lowVol != null ? -r.values.lowVol * Math.sqrt(252) * 100 : null,
      pctOf52wHigh: r.values.high52 != null ? r.values.high52 * 100 : null,
    })),
    note: 'Composite = average z-score of 12-1 month momentum, low volatility and nearness to 52-week high. Relative ranking, not a forecast of absolute returns. Not investment advice.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const hIdx = args.indexOf('--horizon');
  const horizon = hIdx >= 0 ? Number(args[hIdx + 1]) : 20;
  const uIdx = args.indexOf('--universe');
  const universe = uIdx >= 0 ? args[uIdx + 1] : 'nifty50';
  const run = args.includes('--live')
    ? liveRanking({ universe }).then((r) => {
        console.log(`\nRANKING · ${r.asOf} · ${r.universe} stocks (composite: momentum 12-1, low vol, 52w high)`);
        console.log('rank symbol           composite  mom12-1   vol(ann)  %52wH');
        for (const x of r.ranking) console.log(`${String(x.rank).padStart(4)} ${x.symbol.padEnd(16)} ${x.composite.toFixed(2).padStart(8)}  ${x.mom12_1Pct?.toFixed(1).padStart(7)}%  ${x.vol60Pct?.toFixed(1).padStart(6)}%  ${x.pctOf52wHigh?.toFixed(0).padStart(4)}%`);
        if (r.skipped.length) console.log(`Skipped: ${r.skipped.join(' · ')}`);
        console.log(r.note);
      })
    : evaluateRanking({ horizon, universe }).then((r) => {
        console.log(`\nRANKING REPLAY · horizon ${r.horizon} trading days · ${r.universe} stocks · ${r.from} → ${r.to} · ${r.periods} rebalances · top ${r.topN}, cost ${r.costPct}%/turnover`);
        console.log('signal       meanIC   t-stat  %pos  IC 1st/2nd half   top-bottom/period  top-N CAGR  evidence');
        for (const [k, v] of Object.entries(r.summary)) {
          console.log(`${k.padEnd(11)} ${v.meanIC.toFixed(3).padStart(7)}  ${v.tStat?.toFixed(2).padStart(6)}  ${v.pctPositive.toFixed(0).padStart(3)}%  ${v.meanICFirstHalf.toFixed(3).padStart(6)} / ${v.meanICSecondHalf.toFixed(3).padEnd(6)}   ${v.spreadPerPeriodPct.toFixed(2).padStart(6)}%            ${v.topNCagrPct.toFixed(1).padStart(6)}%   ${v.evidence}`);
        }
        console.log(`Benchmarks: equal-weight universe ${r.benchmark.equalWeightCagrPct.toFixed(1)}% CAGR · NIFTY 50 ${r.benchmark.niftyCagrPct?.toFixed(1)}% CAGR`);
        if (r.skipped.length) console.log(`Skipped: ${r.skipped.join(' · ')}`);
        console.log(r.caveats.join(' '));
      });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
