#!/usr/bin/env node
// Up/Down outlook (library + CLI): a 1–3 month lean for any stock, with honest odds.
// Next-day direction is a coin flip (the app's scorecard and every replay showed it);
// over 1–3 months, strength persists a little. Each stock gets a label:
//   STRONG  — momentum (12-1 month return) in the top 20% of the NSE top 200, above its
//             200-day average and within 10% of its 52-week high
//   WEAK    — momentum in the bottom 20% and below its 200-day average
//   NEUTRAL — everything else
// The odds for each label (share of times up after 1 week / 1 month / 3 months, how often
// it beat NIFTY, the average move) come from 16 years of survivorship-free NSE data,
// shown for 2010–17 and 2018→ separately. A scorecard saves each week's lists and grades
// them later. Research only — a lean, not a prediction or advice.
//
//   node paper-bot/updown-outlook.mjs           today's labels + scorecard (after the NSE file)
//   node paper-bot/updown-outlook.mjs --table   rebuild the odds tables (Saturday)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { isEtf } from './momentum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = () => process.env.UPDOWN_TABLE_PATH || join(HERE, 'data', 'updown-table.json');
const LIVE = () => process.env.UPDOWN_LIVE_PATH || join(HERE, 'data', 'updown-live.json');
export const H = { '1w': 5, '1m': 21, '3m': 63 };
export const LABELS = { strong: 'STRONG', neutral: 'NEUTRAL', weak: 'WEAK' };

const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const loadUpdownTable = () => readJ(TABLE());
export const loadUpdownLive = () => readJ(LIVE());

/** Features at bar i from closes (needs ≥ 253 bars): above the 200-day average, 12-1 momentum, distance to the 52-week high, RSI(14). */
export function features(closes, i) {
  if (i < 252) return null;
  let s = 0;
  for (let k = i - 199; k <= i; k++) s += closes[k];
  let hi = 0;
  for (let k = i - 251; k <= i; k++) hi = Math.max(hi, closes[k]);
  let g = 0;
  let l = 0;
  for (let k = i - 13; k <= i; k++) {
    const ch = closes[k] - closes[k - 1];
    if (ch > 0) g += ch;
    else l -= ch;
  }
  return { above200: closes[i] > s / 200, sma200: s / 200, mom: closes[i - 21] / closes[i - 252] - 1, hi52: closes[i] / hi, rsi: l === 0 ? 100 : 100 - 100 / (1 + g / l) };
}

/** Label from features and the momentum percentile (0–1) within the top-200 universe that day. */
export function labelOf(f, pct) {
  if (!f || pct == null) return null;
  if (pct >= 0.8 && f.above200 && f.hi52 >= 0.9) return 'strong';
  if (pct < 0.2 && !f.above200) return 'weak';
  return 'neutral';
}
/**
 * Percentile of `x` in an ascending list: the share of the list below it. With { member: true }
 * (x is one of the list's own values) the share of the OTHER values below it, so the best of n is 1.
 */
export function percentile(sorted, x, { member = false } = {}) {
  if (!sorted?.length) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < x) lo = m + 1;
    else hi = m;
  }
  return member ? (sorted.length > 1 ? lo / (sorted.length - 1) : 0.5) : lo / sorted.length;
}

const statsOf = (g) => Object.fromEntries(Object.keys(H).map((k) => {
  const v = g.filter((x) => x.fwd[k] != null);
  const r = v.filter((x) => x.rel[k] != null);
  return [k, { n: v.length, up: v.length ? v.filter((x) => x.fwd[k] > 0).length / v.length : null, beatsNifty: r.length ? r.filter((x) => x.rel[k] > 0).length / r.length : null, avg: v.length ? v.reduce((a, x) => a + x.fwd[k], 0) / v.length : null }];
}));

/** The odds tables: weekly samples of every top-200 stock since 2010, by label, for 2010–17, 2018→ and all. */
export function buildTable(series, uni, nifty) {
  const nIdx = new Map(nifty.map((x, i) => [x.date, i]));
  const nC = nifty.map((x) => x.close);
  const samples = [];
  for (const [s, rows] of series) {
    if (isEtf(s) || rows.length < 320) continue;
    const c = rows.map((r) => r.close);
    for (let i = 260; i + 5 < c.length; i += 5) {
      const d = rows[i].date;
      if (d < '2010-01-01' || !uni.get(d.slice(0, 7))?.has(s)) continue;
      const ni = nIdx.get(d);
      if (ni == null) continue;
      const f = features(c, i);
      const fwd = {};
      const rel = {};
      for (const [k, h] of Object.entries(H)) {
        if (i + h >= c.length) {
          fwd[k] = null;
          rel[k] = null;
          continue;
        }
        fwd[k] = c[i + h] / c[i] - 1;
        const nd = nIdx.get(rows[i + h].date);
        rel[k] = nd != null ? fwd[k] - (nC[nd] / nC[ni] - 1) : null;
      }
      samples.push({ d, mom: f.mom, f, fwd, rel });
    }
  }
  const byDate = new Map();
  for (const x of samples) (byDate.get(x.d) || byDate.set(x.d, []).get(x.d)).push(x);
  for (const arr of byDate.values()) {
    const sorted = arr.map((x) => x.mom).sort((a, b) => a - b);
    for (const x of arr) x.label = labelOf(x.f, percentile(sorted, x.mom, { member: true }));
  }
  const parts = { early: (x) => x.d < '2018-01-01', late: (x) => x.d >= '2018-01-01', all: () => true };
  const out = {};
  for (const lab of ['all', ...Object.keys(LABELS)]) {
    out[lab] = Object.fromEntries(Object.entries(parts).map(([p, f]) => [p, statsOf(samples.filter((x) => f(x) && (lab === 'all' || x.label === lab)))]));
  }
  // NIFTY: up-rates by its own trend
  const nf = [];
  let s = 0;
  for (let i = 0; i < nC.length; i++) {
    s += nC[i];
    if (i >= 200) s -= nC[i - 200];
    if (i < 260 || i % 5 || nifty[i].date < '2010-01-01') continue;
    nf.push({ d: nifty[i].date, above: nC[i] > s / 200, fwd: Object.fromEntries(Object.entries(H).map(([k, h]) => [k, i + h < nC.length ? nC[i + h] / nC[i] - 1 : null])), rel: {} });
  }
  const niftyOut = { all: statsOf(nf), above: statsOf(nf.filter((x) => x.above)), below: statsOf(nf.filter((x) => !x.above)) };
  return { at: new Date().toISOString(), from: samples[0]?.d, to: samples.reduce((a, x) => (x.d > a ? x.d : a), ''), samples: samples.length, labels: out, nifty: niftyOut };
}

/** Today's labels for the latest top-200, plus the momentum distribution to label any other stock. */
export function snapshot(series, uni) {
  const lastDate = [...series.values()].reduce((a, rows) => (rows.length && rows.at(-1).date > a ? rows.at(-1).date : a), '');
  const members = uni.get(lastDate.slice(0, 7)) || uni.get([...uni.keys()].sort().at(-1)) || new Set();
  const rows = [];
  for (const s of members) {
    const r = series.get(s);
    if (!r || isEtf(s) || r.at(-1).date !== lastDate || r.length < 260) continue;
    const c = r.map((x) => x.close);
    const f = features(c, c.length - 1);
    if (f) rows.push({ symbol: s, close: c.at(-1), ...f });
  }
  const momSorted = rows.map((x) => x.mom).sort((a, b) => a - b);
  for (const x of rows) {
    x.momPct = percentile(momSorted, x.mom, { member: true });
    x.label = labelOf(x, x.momPct);
  }
  return { date: lastDate, rows: rows.sort((a, b) => b.mom - a.mom), momSorted };
}

/** Grade saved weekly lists once 1 / 4 / 13 weeks have passed: share up and average move per label. */
export function scorecard(snapshots, series) {
  const res = { strong: {}, weak: {} };
  for (const lab of ['strong', 'weak']) {
    for (const [k, h] of Object.entries(H)) {
      const moves = [];
      for (const snap of snapshots) {
        for (const x of snap[lab] || []) {
          const rows = series.get(x.symbol);
          const i = rows?.findIndex((r) => r.date === snap.date);
          if (i == null || i < 0 || i + h >= rows.length) continue;
          moves.push(rows[i + h].close / rows[i].close - 1);
        }
      }
      res[lab][k] = { n: moves.length, up: moves.length ? moves.filter((m) => m > 0).length / moves.length : null, avg: moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null };
    }
  }
  return res;
}

export async function updownUpdate({ table = false, loadCandles = candles, now = new Date() } = {}) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const series = loadSeries();
  if (!series.size) throw new Error('No NSE history yet: run node paper-bot/bhav-history.mjs first.');
  const uni = pointInTimeUniverse(series);
  if (table) {
    const nifty = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2008-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0);
    writeJsonAtomic(TABLE(), buildTable(series, uni, nifty));
  }
  const snap = snapshot(series, uni);
  const live = loadUpdownLive() || { startedAt: snap.date, snapshots: [] };
  // one saved list a week (the first update of each ISO week)
  const week = (d) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  };
  if (!live.snapshots.some((x) => week(x.date) === week(snap.date))) {
    live.snapshots.push({ date: snap.date, strong: snap.rows.filter((x) => x.label === 'strong').map((x) => ({ symbol: x.symbol, close: x.close })), weak: snap.rows.filter((x) => x.label === 'weak').map((x) => ({ symbol: x.symbol, close: x.close })) });
  }
  live.date = snap.date;
  live.rows = snap.rows.map((x) => ({ symbol: x.symbol, close: x.close, label: x.label, momPct: x.momPct, mom: x.mom, above200: x.above200, hi52: x.hi52, rsi: x.rsi }));
  live.momSorted = snap.momSorted;
  live.score = scorecard(live.snapshots, series);
  live.updatedAt = now.toISOString();
  writeJsonAtomic(LIVE(), live);
  return live;
}

/** The outlook for one stock: from today's list, or computed from Yahoo daily candles against today's momentum spread. */
export async function outlookFor(symbol, { loadCandles = candles, live = loadUpdownLive(), table = loadUpdownTable() } = {}) {
  const sym = String(symbol).trim().toUpperCase().replace(/\.NS$/, '');
  let row = live?.rows?.find((x) => x.symbol === sym);
  let source = 'NSE top 200 (latest close)';
  if (!row) {
    const rows = (await loadCandles(`${sym}.NS`, { range: '2y', interval: '1d' })).filter((x) => x.close > 0);
    const c = rows.map((x) => x.close);
    const f = features(c, c.length - 1);
    if (!f) throw new Error(`Not enough price history for ${sym} (needs about a year).`);
    const momPct = percentile(live?.momSorted, f.mom);
    row = { symbol: sym, close: c.at(-1), ...f, momPct, label: labelOf(f, momPct) };
    source = 'Yahoo daily (ranked against the NSE top 200)';
  }
  const odds = table?.labels?.[row.label] || null;
  const base = table?.labels?.all || null;
  const why = [
    `momentum (12-1 months ${row.mom >= 0 ? '+' : ''}${(row.mom * 100).toFixed(0)}%) in the ${row.momPct >= 0.8 ? 'top 20%' : row.momPct < 0.2 ? 'bottom 20%' : `middle (${Math.round(row.momPct * 100)}th percentile)`}`,
    `${row.above200 ? 'above' : 'below'} its 200-day average`,
    `${((1 - row.hi52) * 100).toFixed(0)}% below its 52-week high`,
    `RSI ${row.rsi.toFixed(0)}${row.rsi > 70 ? ' (strong, not a sell sign: high-RSI stocks did better than average afterwards)' : row.rsi < 30 ? ' (oversold)' : ''}`,
  ];
  return { symbol: sym, date: live?.date, source, close: row.close, label: row.label, why, odds, base };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const live = await updownUpdate({ table: process.argv.includes('--table') });
    const n = (l) => live.rows.filter((x) => x.label === l).length;
    console.log(`Up/Down outlook ${live.date}: ${n('strong')} strong · ${n('neutral')} neutral · ${n('weak')} weak · ${live.snapshots.length} weekly list(s) saved`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
