#!/usr/bin/env node
// Longer-horizon direction research (library + CLI) — where finance research
// finds SOME predictability, unlike next-day moves:
//
//  1. Valuation → next 1 / 3 years (NIFTY 50, monthly, 2012 → today):
//     earnings yield (1 / P/E), book yield (1 / P/B) and dividend yield from
//     NSE's daily index files (archives start in 2012). Regression of the
//     forward total return on each, with Newey–West standard errors (windows
//     overlap), plus an out-of-sample check: an expanding-window forecast vs
//     the historical average (Campbell–Thompson R²_OS > 0 = better).
//  2. Trend → next 1 / 3 months (Sensex 1997 → today, monthly): sign of the
//     past 3 / 6 / 12-month return. Up-rate after up vs down trends, and the
//     same out-of-sample comparison of a trend-conditional forecast against
//     the historical average.
//  Verdict rule (fixed in advance): "evidence" needs |NW t| ≥ 2 AND R²_OS > 0
//  (beats the historical average out of sample); otherwise "inconclusive".
// Research only — not investment advice.
//
//   node paper-bot/direction-long.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAL_DIR = () => process.env.INDEX_VAL_DIR || join(HERE, 'data', 'index-val');
const SAVED = () => process.env.DIRECTION_LONG_PATH || join(HERE, 'data', 'direction-long.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DIV = 0.012; // index prices exclude dividends

// ---------------------------------------------------------------- stats ---

/** OLS y = a + b x with Newey–West (Bartlett, `lags`) standard error for b. */
export function olsNW(x, y, lags) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  const u = x.map((xi, i) => (xi - mx) * (y[i] - a - b * xi));
  let s = u.reduce((acc, v) => acc + v * v, 0);
  for (let l = 1; l <= lags; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += u[i] * u[i - l];
    s += 2 * (1 - l / (lags + 1)) * g;
  }
  const se = Math.sqrt(s) / sxx;
  const yhat = x.map((xi) => a + b * xi);
  const ssr = y.reduce((acc, yi, i) => acc + (yi - yhat[i]) ** 2, 0);
  const sst = y.reduce((acc, yi) => acc + (yi - my) ** 2, 0);
  return { a, b, se, t: se > 0 ? b / se : null, r2: sst ? 1 - ssr / sst : null, n };
}

/**
 * Out-of-sample R² (Campbell–Thompson): expanding-window regression forecast
 * vs the expanding historical mean, using only data whose outcome was known
 * at the forecast date (gap = horizon in periods). > 0 means the predictor beat the mean.
 */
export function r2OutOfSample(x, y, gap, minTrain = 36) {
  let sseModel = 0;
  let sseMean = 0;
  let n = 0;
  for (let t = minTrain + gap; t < x.length; t++) {
    const end = t - gap; // outcomes y[0..end] were complete by time t
    const xs = x.slice(0, end + 1);
    const ys = y.slice(0, end + 1);
    const { a, b } = olsNW(xs, ys, 0);
    const mean = ys.reduce((p, q) => p + q, 0) / ys.length;
    sseModel += (y[t] - (a + b * x[t])) ** 2;
    sseMean += (y[t] - mean) ** 2;
    n++;
  }
  return n ? { r2os: 1 - sseModel / sseMean, n } : { r2os: null, n: 0 };
}

const verdict = (t, r2os) => (t != null && Math.abs(t) >= 2 && r2os != null && r2os > 0 ? 'evidence' : 'inconclusive');

// ------------------------------------------------------------ valuation ---

/** NIFTY 50 close / P/E / P/B / dividend yield on one date (cached). null = no file. */
export async function niftyValuation(date, { fetchFn = fetch } = {}) {
  const f = join(VAL_DIR(), `${date}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
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
    // renamed from "CNX Nifty" to "Nifty 50" in Nov 2015
    const line = text.split(/\r?\n/).find((l) => /^"?(Nifty 50|CNX Nifty|S&P CNX Nifty)"?,/i.test(l));
    if (line) {
      const c = line.split(',');
      const pe = Number(c[10]);
      const pb = Number(c[11]);
      const dy = Number(c[12]);
      out = { date, close: Number(c[5]), pe: pe > 0 ? pe : null, pb: pb > 0 ? pb : null, dy: dy > 0 ? dy : null };
    } else if (!/Index Name/i.test(text)) return undefined; // unexpected page: don't cache
  } else if (res.status !== 404) return undefined;
  mkdirSync(VAL_DIR(), { recursive: true });
  writeFileSync(f, JSON.stringify(out));
  return out;
}

/** Last trading day of each month from daily rows. */
function monthEnds(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) if (i + 1 === rows.length || rows[i + 1].date.slice(0, 7) !== rows[i].date.slice(0, 7)) out.push({ ...rows[i], idx: i });
  return out;
}

export async function valuationTest({ loadCandles = candles, fetchFn = fetch, onProgress = () => {} } = {}) {
  const nifty = (await loadCandles('^NSEI', { period1: Date.UTC(2012, 0, 1) / 1000, interval: '1d' })).filter((r) => r.close > 0);
  const ends = monthEnds(nifty).filter((r) => r.date >= '2012-05-01');
  const pts = [];
  let k = 0;
  for (const e of ends) {
    // try the month-end, then up to 3 earlier sessions (archive gaps)
    let v = null;
    for (let back = 0; back < 4 && !v; back++) {
      const row = nifty[e.idx - back];
      if (!row) break;
      const got = await niftyValuation(row.date, { fetchFn });
      if (got) v = { ...got, idx: e.idx - back };
      if (fetchFn === fetch && got === undefined) await new Promise((r) => setTimeout(r, 200));
    }
    if (v?.pe) pts.push(v);
    if (++k % 20 === 0) onProgress(k, ends.length);
  }
  const fwd = (p, months) => {
    const target = p.idx + Math.round(months * 21);
    if (target >= nifty.length) return null;
    const yrs = months / 12;
    return (nifty[target].close / nifty[p.idx].close) ** (1 / yrs) * (1 + DIV) - 1; // annualised, + dividends
  };
  const out = {};
  for (const months of [12, 36]) {
    const rows = pts.map((p) => ({ ...p, ret: fwd(p, months) })).filter((p) => p.ret != null);
    const res = {};
    for (const [name, f] of [['earningsYield', (p) => 100 / p.pe], ['bookYield', (p) => 100 / p.pb], ['dividendYield', (p) => p.dy]]) {
      const r = rows.filter((p) => f(p) != null && Number.isFinite(f(p)));
      if (r.length < 40) continue;
      const x = r.map(f);
      const y = r.map((p) => p.ret * 100);
      const fit = olsNW(x, y, months);
      const oos = r2OutOfSample(x, y, months);
      // Robustness: drop start months in the COVID crash (Feb–Jun 2020), the one
      // episode where yields spiked and the following year boomed.
      const keep = r.map((p) => !(p.date >= '2020-02-01' && p.date <= '2020-06-30'));
      const xr = x.filter((_, i) => keep[i]);
      const yr = y.filter((_, i) => keep[i]);
      const fitR = olsNW(xr, yr, months);
      const oosR = r2OutOfSample(xr, yr, months);
      const v = verdict(fit.t, oos.r2os);
      res[name] = {
        n: r.length, slope: fit.b, t: fit.t, r2: fit.r2, r2os: oos.r2os, oosForecasts: oos.n,
        withoutCovidCrash: { t: fitR.t, r2os: oosR.r2os, verdict: verdict(fitR.t, oosR.r2os) },
        // NSE moved index P/E and P/B from standalone to consolidated earnings in 2021: a level break
        seriesBreak2021: name !== 'dividendYield',
        verdict: v === 'evidence' && name !== 'dividendYield' ? 'unreliable (2021 series break)' : v === 'evidence' && verdict(fitR.t, oosR.r2os) !== 'evidence' ? 'fragile (depends on the 2020 crash)' : v,
      };
    }
    out[`${months / 12}y`] = { months: rows.length, independentPeriods: Math.floor(rows.length / months), predictors: res };
  }
  const latest = pts[pts.length - 1];
  const all = pts.map((p) => p.pe).sort((a, b) => a - b);
  return {
    from: pts[0]?.date,
    to: latest?.date,
    monthsWithData: pts.length,
    latest: latest && { date: latest.date, pe: latest.pe, pb: latest.pb, dy: latest.dy, pePercentile: (all.filter((x) => x <= latest.pe).length / all.length) * 100 },
    horizons: out,
  };
}

// ---------------------------------------------------------------- trend ---

export async function trendTest({ loadCandles = candles } = {}) {
  const sensex = (await loadCandles('^BSESN', { period1: Date.UTC(1990, 0, 1) / 1000, interval: '1d' })).filter((r) => r.close > 0);
  const m = monthEnds(sensex).map((r) => r.close);
  const out = {};
  for (const look of [3, 6, 12]) {
    for (const ahead of [1, 3]) {
      const x = [];
      const y = [];
      for (let i = look; i + ahead < m.length; i++) {
        x.push(m[i] / m[i - look] - 1 > 0 ? 1 : 0);
        y.push((m[i + ahead] / m[i] - 1 + (DIV * ahead) / 12) * 100);
      }
      const fit = olsNW(x, y, ahead);
      const oos = r2OutOfSample(x, y, ahead, 60);
      const up = y.filter((_, i) => x[i] === 1);
      const dn = y.filter((_, i) => x[i] === 0);
      const rate = (a) => a.filter((v) => v > 0).length / (a.length || 1);
      out[`past${look}m_next${ahead}m`] = {
        n: y.length,
        avgAfterUpTrendPct: up.reduce((a, b) => a + b, 0) / (up.length || 1),
        avgAfterDownTrendPct: dn.reduce((a, b) => a + b, 0) / (dn.length || 1),
        upRateAfterUpTrend: rate(up),
        upRateAfterDownTrend: rate(dn),
        t: fit.t,
        r2os: oos.r2os,
        verdict: verdict(fit.t, oos.r2os),
      };
    }
  }
  return { index: 'Sensex', from: sensex[0].date, to: sensex[sensex.length - 1].date, signals: out };
}

export async function directionLong(opts = {}) {
  const valuation = await valuationTest(opts);
  const trend = await trendTest(opts);
  const ev = [
    ...Object.entries(valuation.horizons).flatMap(([h, x]) => Object.entries(x.predictors).filter(([, v]) => v.verdict === 'evidence').map(([k]) => `${k} → next ${h} (≈${x.independentPeriods} independent years — weak sample)`)),
    ...Object.entries(trend.signals).filter(([, v]) => v.verdict === 'evidence').map(([k]) => k),
  ];
  return {
    at: new Date().toISOString(),
    valuation,
    trend,
    verdict: ev.length ? `Evidence (|NW t| ≥ 2 and beats the historical average out of sample): ${ev.join(', ')}.` : 'No signal met both bars — inconclusive on this history.',
    rule: 'Each predictor needs |Newey–West t| ≥ 2 AND a positive out-of-sample R² (expanding-window forecast beats the historical average) to count as evidence. Overlapping windows are handled by Newey–West; short histories make the 3-year valuation test weak.',
  };
}

export function saveDirectionLong(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadDirectionLong() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  directionLong({ onProgress: (d, t) => process.stdout.write(`  valuation files ${d}/${t}…\r`) })
    .then((r) => {
      saveDirectionLong(r);
      const v = r.valuation;
      console.log(`\nVALUATION → future NIFTY returns · ${v.from} → ${v.to} · ${v.monthsWithData} months · today P/E ${v.latest?.pe} (${v.latest?.pePercentile?.toFixed(0)}th percentile of this history), P/B ${v.latest?.pb}, div yield ${v.latest?.dy}%`);
      for (const [h, x] of Object.entries(v.horizons)) {
        console.log(`  next ${h} (${x.months} monthly points, ~${x.independentPeriods} independent periods)`);
        for (const [k, p] of Object.entries(x.predictors)) console.log(`    ${k.padEnd(14)} slope ${p.slope.toFixed(2)} · NW t ${p.t?.toFixed(2)} · in-sample R² ${(p.r2 * 100).toFixed(0)}% · out-of-sample R² ${(p.r2os * 100).toFixed(1)}% · without Covid crash: t ${p.withoutCovidCrash.t?.toFixed(2)}, R²os ${(p.withoutCovidCrash.r2os * 100).toFixed(1)}% → ${p.verdict}`);
      }
      console.log(`\nTREND → future Sensex returns · ${r.trend.from} → ${r.trend.to}`);
      for (const [k, s] of Object.entries(r.trend.signals)) console.log(`  ${k.padEnd(18)} after up-trend ${s.avgAfterUpTrendPct.toFixed(2)}% (up ${(s.upRateAfterUpTrend * 100).toFixed(0)}%) · after down-trend ${s.avgAfterDownTrendPct.toFixed(2)}% (up ${(s.upRateAfterDownTrend * 100).toFixed(0)}%) · NW t ${s.t?.toFixed(2)} · R²os ${(s.r2os * 100).toFixed(1)}% → ${s.verdict}`);
      console.log(`\n${r.verdict}\n${r.rule}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
