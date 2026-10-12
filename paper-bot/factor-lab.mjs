#!/usr/bin/env node
// Factor lab (library + CLI): do NSE's "smart beta" indices — momentum,
// quality, low volatility, value, alpha, equal weight, mid / small caps —
// actually beat NIFTY 50, and what does it cost in falls and bad years?
//
// Data: NSE's own month-end index closes (nsearchives ind_close_all files)
// from May 2012. An index counts only from the month it first appears in
// NSE's daily files, so years NSE back-filled before launch (common for
// factor indices) are NOT used — only history that was actually published.
//
// Caveats, stated in the output too:
//   - Price indices: dividends are excluded. Value and low-volatility stocks
//     pay more than NIFTY, momentum stocks less, so value / low-vol are
//     understated and momentum slightly overstated (≈ ±0.5–1%/yr).
//   - Index-fund costs (≈0.3–1%/yr for factor funds) are not deducted.
//   - Factors go through long losing stretches; past premiums can shrink once
//     widely known. Research / education only — not investment advice.
//
//   node paper-bot/factor-lab.mjs

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = () => process.env.FACTOR_DIR || join(HERE, 'data', 'factor-idx');
const SAVED = () => process.env.FACTOR_LAB_PATH || join(HERE, 'data', 'factor-lab.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Normalise NSE's changing index names ("CNX Nifty" → "nifty 50", "S&P CNX …", case). */
export function normName(n) {
  let s = String(n).replace(/"/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  s = s.replace(/^s&p /, '').replace(/^cnx /, 'nifty ').replace(/^nifty nifty\b/, 'nifty');
  if (s === 'nifty' || s === 'nifty 50') return 'nifty 50';
  return s;
}

// Series to study: key → { label, group, match(normalised name), fund: index funds / ETFs exist }
export const SERIES = {
  nifty50: { label: 'NIFTY 50', group: 'benchmark', names: ['nifty 50'] },
  nifty500: { label: 'NIFTY 500 (whole market)', group: 'size', names: ['nifty 500'], fund: true },
  midcap150: { label: 'Midcap 150', group: 'size', names: ['nifty midcap 150'], fund: true },
  smallcap250: { label: 'Smallcap 250', group: 'size', names: ['nifty smallcap 250'], fund: true },
  momentum30: { label: 'Momentum: NIFTY200 Momentum 30', group: 'factor', names: ['nifty200 momentum 30'], fund: true },
  quality30: { label: 'Quality: NIFTY100 Quality 30', group: 'factor', names: ['nifty100 quality 30', 'nifty quality 30'], fund: true },
  lowvol30: { label: 'Low volatility: NIFTY100 Low Volatility 30', group: 'factor', names: ['nifty100 low volatility 30'], fund: true },
  lowvol50: { label: 'Low volatility: NIFTY Low Volatility 50', group: 'factor', names: ['nifty low volatility 50', 'nifty low volatility'] },
  value20: { label: 'Value: NIFTY50 Value 20', group: 'factor', names: ['nifty50 value 20', 'nifty 50 value 20', 'nifty value 20'], fund: true },
  alpha50: { label: 'Alpha (past outperformers): NIFTY Alpha 50', group: 'factor', names: ['nifty alpha 50', 'nifty alpha index', 'nifty alpha'], fund: true },
  equal50: { label: 'Equal weight: NIFTY50 Equal Weight', group: 'factor', names: ['nifty50 equal weight', 'nifty 50 equal weight'], fund: true },
  dividend: { label: 'Dividend: NIFTY Dividend Opportunities 50', group: 'factor', names: ['nifty dividend opportunities 50', 'nifty dividend opportunities'] },
};

/** Parse one ind_close_all CSV → { normalisedName: close }. */
export function parseIndexCsv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    const close = Number(c[5] ?? c[2]);
    if (c[0] && close > 0) out[normName(c[0])] = close;
  }
  return out;
}

/** Month-end index closes for `date` (cached). null = no file for that day. */
export async function monthEndCloses(date, { fetchFn = fetch } = {}) {
  const f = join(RAW(), `${date}.json`);
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, 'utf8'));
    return c && Object.fromEntries(Object.entries(c).map(([k, v]) => [normName(k), v])); // names re-normalised on read
  }
  const [y, m, d] = date.split('-');
  let res;
  try {
    res = await fetchFn(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}${m}${y}.csv`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  } catch {
    return undefined; // network: retry later
  }
  if (res.status === 403 || res.status === 429) throw new Error('NSE is blocking downloads — try again later.');
  let out = null;
  if (res.ok) {
    const text = await res.text();
    if (!/Index Name/i.test(text)) return undefined;
    out = parseIndexCsv(text);
  } else if (res.status !== 404) return undefined;
  mkdirSync(RAW(), { recursive: true });
  writeFileSync(f, JSON.stringify(out));
  return out;
}

/** Monthly closes per series: { key: [{ month, close }] } from month-end snapshots. */
export function buildSeries(snapshots) {
  const out = {};
  for (const [key, def] of Object.entries(SERIES)) {
    const pts = [];
    for (const s of snapshots) {
      const name = def.names.find((n) => s.closes[n] != null);
      if (name) pts.push({ month: s.date.slice(0, 7), close: s.closes[name] });
    }
    // splice over a rename that changed the base value: a >40% one-month jump is a rebase, not a return
    // (that month is counted as flat — conservative)
    for (let i = 1; i < pts.length; i++) {
      const r = pts[i].close / pts[i - 1].close;
      if (r > 1.4 || r < 0.6) for (let j = 0; j < i; j++) pts[j] = { ...pts[j], close: pts[j].close * r };
    }
    out[key] = pts;
  }
  return out;
}

const cagr = (a, b, months) => (b / a) ** (12 / months) - 1;
const sd = (x) => {
  const m = x.reduce((p, q) => p + q, 0) / x.length;
  return Math.sqrt(x.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, x.length - 1));
};

/** One series vs NIFTY 50 over the months both exist. */
export function compare(series, bench) {
  const bm = new Map(bench.map((p) => [p.month, p.close]));
  const pts = series.filter((p) => bm.has(p.month));
  if (pts.length < 37) return null;
  const n = pts.length - 1;
  const rets = [];
  const brets = [];
  for (let i = 1; i < pts.length; i++) {
    rets.push(pts[i].close / pts[i - 1].close - 1);
    brets.push(bm.get(pts[i].month) / bm.get(pts[i - 1].month) - 1);
  }
  const dd = (closes) => {
    let peak = closes[0];
    let worst = 0;
    for (const c of closes) {
      peak = Math.max(peak, c);
      worst = Math.max(worst, 1 - c / peak);
    }
    return worst;
  };
  const roll = (months) => {
    const ex = [];
    for (let i = 0; i + months < pts.length; i++) {
      const a = cagr(pts[i].close, pts[i + months].close, months);
      const b = cagr(bm.get(pts[i].month), bm.get(pts[i + months].month), months);
      ex.push(a - b);
    }
    if (!ex.length) return null;
    return { windows: ex.length, pctBeat: ex.filter((x) => x > 0).length / ex.length, worst: Math.min(...ex), best: Math.max(...ex) };
  };
  const yrs = n / 12;
  const c = cagr(pts[0].close, pts[n].close, n);
  const b = cagr(bm.get(pts[0].month), bm.get(pts[n].month), n);
  // longest stretch (months) spent behind NIFTY since a previous relative high
  let relPeak = 1;
  let rel = 1;
  let under = 0;
  let longestUnder = 0;
  for (let i = 0; i < rets.length; i++) {
    rel *= (1 + rets[i]) / (1 + brets[i]);
    if (rel >= relPeak) {
      relPeak = rel;
      under = 0;
    } else longestUnder = Math.max(longestUnder, ++under);
  }
  return {
    from: pts[0].month, to: pts[n].month, years: yrs,
    cagr: c, niftyCagr: b, excess: c - b,
    vol: sd(rets) * Math.sqrt(12), niftyVol: sd(brets) * Math.sqrt(12),
    maxDrawdown: dd(pts.map((p) => p.close)), niftyMaxDrawdown: dd(pts.map((p) => bm.get(p.month))),
    roll3: roll(36), roll5: roll(60),
    longestBehindMonths: longestUnder,
    growthOf1L: 100000 * (pts[n].close / pts[0].close), niftyGrowthOf1L: 100000 * (bm.get(pts[n].month) / bm.get(pts[0].month)),
  };
}

/** Plain-language verdict for one factor. */
export function verdictFor(r) {
  if (!r) return 'not enough published history (needs 3+ years)';
  const beat5 = r.roll5?.pctBeat;
  const ok = r.excess > 0.01 && (beat5 == null ? r.roll3?.pctBeat >= 0.6 : beat5 >= 0.6);
  const rough = r.maxDrawdown > r.niftyMaxDrawdown + 0.05 || r.longestBehindMonths >= 24;
  if (ok && !rough) return 'beat NIFTY most of the time without deeper falls';
  if (ok) return `beat NIFTY over time, but with ${r.maxDrawdown > r.niftyMaxDrawdown + 0.05 ? 'deeper falls' : ''}${r.maxDrawdown > r.niftyMaxDrawdown + 0.05 && r.longestBehindMonths >= 24 ? ' and ' : ''}${r.longestBehindMonths >= 24 ? `a ${Math.round(r.longestBehindMonths / 12 * 10) / 10}-year losing stretch vs NIFTY` : ''}`;
  if (r.excess > 0) return 'slightly ahead of NIFTY, not reliably';
  return 'did not beat NIFTY';
}

/** Month-end trading days from NIFTY daily data (May 2012 →). */
async function monthEndDates(loadCandles) {
  const rows = (await loadCandles('^NSEI', { period1: Date.UTC(2012, 4, 1) / 1000, interval: '1d' })).filter((r) => r.close > 0);
  const out = [];
  for (let i = 0; i < rows.length; i++) if (i + 1 === rows.length || rows[i + 1].date.slice(0, 7) !== rows[i].date.slice(0, 7)) out.push({ date: rows[i].date, back: rows.slice(Math.max(0, i - 3), i).map((r) => r.date).reverse() });
  // the current, unfinished month is skipped
  const thisMonth = new Date(Date.now() + 19800_000).toISOString().slice(0, 7);
  return out.filter((x) => x.date.slice(0, 7) < thisMonth);
}

export async function factorLab({ loadCandles = candles, fetchFn = fetch, onProgress = () => {} } = {}) {
  const ends = await monthEndDates(loadCandles);
  const snaps = [];
  let k = 0;
  for (const e of ends) {
    let got = null;
    for (const d of [e.date, ...e.back]) {
      got = await monthEndCloses(d, { fetchFn });
      if (got) {
        snaps.push({ date: d, closes: got });
        break;
      }
      if (fetchFn === fetch && got === undefined) await new Promise((r) => setTimeout(r, 200));
    }
    onProgress(++k, ends.length);
  }
  const series = buildSeries(snaps);
  const rows = Object.entries(SERIES).filter(([k2]) => k2 !== 'nifty50').map(([k2, def]) => {
    const r = compare(series[k2], series.nifty50);
    return { key: k2, label: def.label, group: def.group, fundsExist: !!def.fund, ...(r || { from: series[k2][0]?.month ?? null }), enough: !!r, verdict: verdictFor(r) };
  });
  return {
    at: new Date().toISOString(),
    months: snaps.length, from: snaps[0]?.date, to: snaps[snaps.length - 1]?.date,
    rows,
    note: 'NSE month-end closes, each index only from when NSE first published it daily (no back-filled history). Price indices: dividends excluded — value and low-volatility are understated, momentum slightly overstated. Index-fund costs (≈0.3–1%/yr) not deducted. Factors have long losing stretches and premiums can shrink. Research only, not advice.',
  };
}

export function saveFactorLab(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadFactorLab() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}
export const cachedMonths = () => (existsSync(RAW()) ? readdirSync(RAW()).length : 0);

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  factorLab({ onProgress: (i, n) => process.stdout.write(`\r  NSE month-end files ${i}/${n}`) })
    .then((r) => {
      saveFactorLab(r);
      const p = (x, d = 1) => (x == null ? '   –  ' : `${(x * 100).toFixed(d)}%`);
      console.log(`\n\nFACTOR LAB · ${r.months} month-ends · ${r.from} → ${r.to}`);
      console.log('index'.padEnd(46), 'since    yrs   CAGR  NIFTY  extra | worst fall (NIFTY) | beat NIFTY in 3y / 5y windows | longest behind');
      for (const x of r.rows) {
        if (!x.enough) {
          console.log(`${x.label.padEnd(46)} ${x.verdict}`);
          continue;
        }
        console.log(`${x.label.padEnd(46)} ${x.from}  ${x.years.toFixed(1).padStart(4)} ${p(x.cagr).padStart(6)} ${p(x.niftyCagr).padStart(6)} ${p(x.excess).padStart(6)} | ${p(x.maxDrawdown, 0).padStart(4)} (${p(x.niftyMaxDrawdown, 0)}) | ${p(x.roll3?.pctBeat, 0).padStart(4)} / ${p(x.roll5?.pctBeat, 0).padStart(4)} | ${x.longestBehindMonths} mo → ${x.verdict}`);
      }
      console.log(`\n${r.note}`);
    })
    .catch((err) => {
      console.error('\nError:', err.message);
      process.exit(1);
    });
}
