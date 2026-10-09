#!/usr/bin/env node
// What to expect from long-term index investing (library + CLI): for EVERY
// monthly start date in the history, what a lump sum and a monthly SIP in the
// index actually returned over 3 / 5 / 10 / 15 years — best, median, worst,
// how often it lost money, and the deepest fall you'd have sat through.
//   Sensex daily from 1997 · NIFTY 50 daily from 2007 (Yahoo).
//   Index prices exclude dividends: ~1.2%/yr is added; an index fund's cost
//   (0.2%/yr) is subtracted. Before tax. Past ranges, not a forecast.
// Research / education only — not investment advice.
//
//   node paper-bot/expectations.mjs

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';

export const YEARS = [3, 5, 10, 15];
const DIV = 0.012;
const FEE = 0.002;

/** Month-end total-return-ish series: [{month:'YYYY-MM', tr}] from daily closes. */
export function monthlyTotalReturn(rows) {
  const out = [];
  let tr = 1;
  let prev = null;
  for (let i = 0; i < rows.length; i++) {
    if (prev) tr *= rows[i].close / prev.close * (1 + (DIV - FEE) / 252);
    prev = rows[i];
    const m = rows[i].date.slice(0, 7);
    if (!out.length || out[out.length - 1].month !== m) out.push({ month: m, tr, date: rows[i].date });
    else out[out.length - 1] = { month: m, tr, date: rows[i].date };
  }
  return out;
}

/** Annualised internal rate of return for monthly cash flows (bisection). */
export function xirrMonthly(flows) {
  // flows[k] at month k (negative = invested), last entry includes final value
  const npv = (r) => flows.reduce((a, f, k) => a + f / (1 + r) ** (k / 12), 0);
  let lo = -0.99;
  let hi = 2;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const pctl = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
};

/** Rolling lump-sum and SIP outcomes for one index. */
export function rollingOutcomes(monthly, years) {
  const n = years * 12;
  const lump = [];
  const sip = [];
  const dd = [];
  for (let s = 0; s + n < monthly.length; s++) {
    const w = monthly.slice(s, s + n + 1);
    lump.push((w[n].tr / w[0].tr) ** (1 / years) - 1);
    // deepest fall during the window (lump sum)
    let peak = w[0].tr;
    let worst = 0;
    for (const x of w) {
      peak = Math.max(peak, x.tr);
      worst = Math.max(worst, 1 - x.tr / peak);
    }
    dd.push(worst);
    // SIP: 1 unit invested at each month end for n months, valued at the end
    let units = 0;
    const flows = [];
    for (let k = 0; k < n; k++) {
      units += 1 / w[k].tr;
      flows.push(-1);
    }
    const value = units * w[n].tr;
    flows.push(value);
    sip.push({ irr: xirrMonthly(flows), multiple: value / n });
  }
  if (!lump.length) return null;
  const irr = sip.map((x) => x.irr).filter((x) => x != null);
  return {
    years,
    windows: lump.length,
    from: monthly[0].month,
    lumpSum: {
      worstPct: Math.min(...lump) * 100,
      p10Pct: pctl(lump, 0.1) * 100,
      medianPct: pctl(lump, 0.5) * 100,
      bestPct: Math.max(...lump) * 100,
      pctWindowsLosing: (lump.filter((x) => x < 0).length / lump.length) * 100,
      pctWindowsBelowFd: (lump.filter((x) => x < 0.065).length / lump.length) * 100,
      medianDeepestFallPct: pctl(dd, 0.5) * 100,
      worstDeepestFallPct: Math.max(...dd) * 100,
    },
    sip: {
      worstPct: Math.min(...irr) * 100,
      p10Pct: pctl(irr, 0.1) * 100,
      medianPct: pctl(irr, 0.5) * 100,
      bestPct: Math.max(...irr) * 100,
      pctWindowsLosing: (sip.filter((x) => x.multiple < 1).length / sip.length) * 100,
    },
  };
}

export async function expectations({ loadCandles = candles } = {}) {
  const p1 = Date.UTC(1990, 0, 1) / 1000;
  const out = [];
  for (const [name, sym] of [['Sensex', '^BSESN'], ['NIFTY 50', '^NSEI']]) {
    const rows = (await loadCandles(sym, { period1: p1, interval: '1d' })).filter((r) => r.close > 0);
    const m = monthlyTotalReturn(rows);
    out.push({ index: name, from: rows[0].date, to: rows[rows.length - 1].date, horizons: YEARS.map((y) => rollingOutcomes(m, y)).filter(Boolean) });
  }
  return {
    at: new Date().toISOString(),
    indices: out,
    note: 'Every monthly start date in the history. Index prices + ~1.2%/yr dividends − 0.2%/yr index-fund cost, before tax. "Below FD" = under 6.5% a year. Overlapping windows: they are not independent, so read the ranges as what happened, not as odds for the future.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  expectations()
    .then((r) => {
      for (const x of r.indices) {
        console.log(`\n${x.index} · ${x.from} → ${x.to}`);
        console.log('years  windows | LUMP SUM: worst  10th  median  best  %lost  %<FD  typical fall / worst fall | SIP: worst  10th  median  best  %lost');
        for (const h of x.horizons) {
          const l = h.lumpSum;
          const s = h.sip;
          console.log(`${String(h.years).padStart(5)}  ${String(h.windows).padStart(7)} | ${l.worstPct.toFixed(1).padStart(14)}% ${l.p10Pct.toFixed(1).padStart(5)}% ${l.medianPct.toFixed(1).padStart(6)}% ${l.bestPct.toFixed(1).padStart(5)}% ${l.pctWindowsLosing.toFixed(0).padStart(5)}% ${l.pctWindowsBelowFd.toFixed(0).padStart(4)}%  ${l.medianDeepestFallPct.toFixed(0).padStart(5)}% / ${l.worstDeepestFallPct.toFixed(0)}% | ${s.worstPct.toFixed(1).padStart(10)}% ${s.p10Pct.toFixed(1).padStart(5)}% ${s.medianPct.toFixed(1).padStart(6)}% ${s.bestPct.toFixed(1).padStart(5)}% ${s.pctWindowsLosing.toFixed(0).padStart(5)}%`);
        }
      }
      console.log(`\n${r.note}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
