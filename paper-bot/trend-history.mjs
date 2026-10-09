#!/usr/bin/env node
// Trend filter on the longest history available (library + CLI): is "halves
// the drawdown" a lasting property, or one lucky exit before the 2020 crash?
//   Sensex daily from 1997 · NIFTY daily from 2007 (Yahoo, explicit dates).
//   Same rules as Strategy A (200-day average, ±1% band, signal at close →
//   trade at the next close, liquid fund when out), month-end and daily checks.
//   Reported per crisis (fixed windows below) and per decade, plus a 4% cash-
//   yield row. Verdict rule (fixed in advance): "consistent" only if the
//   month-end filter cut the crisis drawdown by ≥ 5 points in at least two
//   thirds of the crises that fall inside each index's history.
// Research only — not investment advice.
//
//   node paper-bot/trend-history.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { trendStrategy, stats, ASSUMPTIONS } from './strategies.mjs';

const SAVED = () => process.env.TREND_HISTORY_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'trend-history.json');

export const CRISES = [
  { name: 'Dot-com bust 2000–03', from: '2000-01-01', to: '2003-04-30' },
  { name: 'Global financial crisis 2008–09', from: '2008-01-01', to: '2009-03-31' },
  { name: 'Euro debt / inflation 2010–11', from: '2010-11-01', to: '2011-12-31' },
  { name: 'Taper / China 2015–16', from: '2015-03-01', to: '2016-02-29' },
  { name: 'COVID crash 2020', from: '2020-01-01', to: '2020-04-30' },
  { name: 'Rate hikes 2021–22', from: '2021-10-01', to: '2022-06-30' },
  { name: 'Correction 2024–25', from: '2024-09-01', to: '2025-03-31' },
];

/** Max drawdown and return of an equity curve inside [from, to]. */
export function windowStats(curve, from, to) {
  const w = curve.filter((p) => p.date >= from && p.date <= to);
  if (w.length < 20) return null;
  let peak = w[0].equity;
  let dd = 0;
  for (const p of w) {
    peak = Math.max(peak, p.equity);
    dd = Math.max(dd, 1 - p.equity / peak);
  }
  return { maxDrawdownPct: dd * 100, returnPct: (w[w.length - 1].equity / w[0].equity - 1) * 100 };
}

function decades(curve) {
  const out = [];
  for (let y = 1990; y <= 2030; y += 10) {
    const w = curve.filter((p) => p.date >= `${y}-01-01` && p.date < `${y + 10}-01-01`);
    if (w.length > 500) out.push({ period: `${y}s`, ...stats(w) });
  }
  return out;
}

/** Run the filter on one index series. */
export function analyseIndex(name, rows) {
  const monthEnd = trendStrategy(rows, { monthEnd: true });
  const daily = trendStrategy(rows, { monthEnd: false });
  const lowCash = trendStrategy(rows, { monthEnd: true, a: { ...ASSUMPTIONS, liquidYield: 0.04 } });
  const bench = monthEnd.benchCurve;
  const firstDate = monthEnd.curve[0].date; // after the 200-day warm-up
  const crises = CRISES.map((c) => {
    if (c.from < firstDate) return null; // only crises the history fully covers
    const b = windowStats(bench, c.from, c.to);
    const m = windowStats(monthEnd.curve, c.from, c.to);
    const d = windowStats(daily.curve, c.from, c.to);
    return b && m ? { ...c, buyHold: b, monthEnd: m, daily: d, cutPts: b.maxDrawdownPct - m.maxDrawdownPct } : null;
  }).filter(Boolean);
  const helped = crises.filter((c) => c.cutPts >= 5).length;
  const skipped = CRISES.filter((c) => c.from < firstDate && c.to >= firstDate).map((c) => c.name);
  return {
    index: name,
    testedFrom: firstDate,
    partialCrisesSkipped: skipped,
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    all: {
      buyHold: monthEnd.benchmark.all,
      monthEnd: monthEnd.all,
      daily: daily.all,
      monthEnd4pctCash: lowCash.all,
    },
    switchesPerYear: { monthEnd: monthEnd.switchesPerYear, daily: daily.switchesPerYear },
    pctTimeInvested: monthEnd.pctTimeInvested,
    crises,
    decades: { buyHold: decades(bench), monthEnd: decades(monthEnd.curve) },
    crisesHelped: helped,
    crisesCounted: crises.length,
    consistent: crises.length >= 3 && helped / crises.length >= 2 / 3,
  };
}

export async function trendHistory({ loadCandles = candles } = {}) {
  const p1 = Date.UTC(1990, 0, 1) / 1000;
  const out = [];
  for (const [name, sym] of [['Sensex', '^BSESN'], ['NIFTY 50', '^NSEI']]) {
    const rows = (await loadCandles(sym, { period1: p1, interval: '1d' })).filter((r) => r.close > 0);
    if (rows.length > 1000) out.push(analyseIndex(name, rows));
  }
  const allConsistent = out.length && out.every((x) => x.consistent);
  return {
    at: new Date().toISOString(),
    indices: out,
    verdict: allConsistent
      ? 'Consistent: the month-end trend filter cut the drawdown by 5+ points in most crises on both indices — a lasting property, not one lucky exit.'
      : `Not consistent: the drawdown cut held in ${out.map((x) => `${x.crisesHelped}/${x.crisesCounted} crises (${x.index})`).join(' and ')} — weaker than a single headline number suggests.`,
    rule: 'Crisis drawdowns measured inside each fixed window (peak-to-trough). "Consistent" needs a ≥ 5-point cut in at least two thirds of the crises on every index. Signals at the close trade at the next close; cash earns 6% (4% row shown). Index prices exclude dividends; 1.2%/yr is added while invested.',
  };
}

export function saveTrendHistory(r) {
  mkdirSync(dirname(SAVED()), { recursive: true });
  writeFileSync(SAVED(), JSON.stringify(r, null, 2));
}
export function loadTrendHistory() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  trendHistory()
    .then((r) => {
      saveTrendHistory(r);
      const f = (x) => `${x.cagrPct.toFixed(1)}% CAGR, max DD ${x.maxDrawdownPct.toFixed(1)}%, Sharpe ${x.sharpe?.toFixed(2)}`;
      for (const x of r.indices) {
        console.log(`\n${x.index} · ${x.from} → ${x.to} · month-end filter invested ${x.pctTimeInvested.toFixed(0)}% of the time`);
        console.log(`  buy-and-hold       ${f(x.all.buyHold)}`);
        console.log(`  trend month-end    ${f(x.all.monthEnd)}  (${x.switchesPerYear.monthEnd.toFixed(1)} switches/yr)`);
        console.log(`  trend daily        ${f(x.all.daily)}  (${x.switchesPerYear.daily.toFixed(1)} switches/yr)`);
        console.log(`  month-end, 4% cash ${f(x.all.monthEnd4pctCash)}  (Sharpe vs a 4% risk-free rate)`);
        console.log('  crisis                              B&H DD   month-end DD   daily DD   cut');
        for (const c of x.crises) console.log(`  ${c.name.padEnd(34)} ${c.buyHold.maxDrawdownPct.toFixed(1).padStart(6)}%  ${c.monthEnd.maxDrawdownPct.toFixed(1).padStart(10)}%  ${(c.daily?.maxDrawdownPct ?? NaN).toFixed(1).padStart(8)}%  ${c.cutPts >= 0 ? '+' : ''}${c.cutPts.toFixed(1)}`);
        if (x.partialCrisesSkipped.length) console.log(`  (skipped, history starts mid-crisis: ${x.partialCrisesSkipped.join(', ')})`);
        console.log(`  helped in ${x.crisesHelped}/${x.crisesCounted} crises → ${x.consistent ? 'consistent' : 'not consistent'}`);
      }
      console.log(`\n${r.verdict}\n${r.rule}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
