#!/usr/bin/env node
// New investing ideas (library + CLI), tested exactly like Momentum 20 so they
// can be compared fairly: the 200 most-traded NSE stocks as they were each month
// (survivorship-free bhavcopy), monthly rebalance, realistic fills (midpoint of
// the day, 0.3% slippage + 0.25% charges a side), Indian tax.
//   1. Low volatility — the 20 / 30 calmest stocks (1-year daily volatility)
//   2. Momentum + low volatility — strong stocks that are also calm
//   3. Momentum with a market filter — Momentum 20 only while NIFTY is above its
//      200-day average (±1% band, checked at month-end), else a liquid fund
//   4. Index inclusion — needs a history of NIFTY 50 additions; not testable
//      from this data (reported as such)
// Versions are picked on 2010–17 only (return per unit of worst fall) and judged
// once on 2018–now. Research only — not investment advice.
//
//   node paper-bot/new-ideas.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { candles } from '../market-data.mjs';
import { RULES as MOM, simulate, scores, loadAll, cagrOf, yearly } from './momentum.mjs';
import { writeJsonAtomic } from '../util.mjs';

const SAVED = () => process.env.NEW_IDEAS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'new-ideas.json');
export const SETTINGS = { split: '2018-01-01', cashYield: 0.05, smaDays: 200, bandPct: 1 };
const REAL = { ...MOM, fill: 'mid', slipPct: 0.3, cashYield: SETTINGS.cashYield };

// ------------------------------------------------------------- rankings ---
const zs = (rows, key) => {
  const v = rows.map((x) => x[key]);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)) || 1;
  return (x) => (x[key] - m) / sd;
};
/** Calmest first (1-year daily volatility). */
export const lowVol = (idx, syms, me) => scores(idx, syms, me, 'b').sort((a, b) => a.vol - b.vol).map((x) => ({ ...x, score: -x.vol }));
/** Average of the momentum z-score and the calmness z-score. */
export const momLowVolBlend = (idx, syms, me) => {
  const s = scores(idx, syms, me, 'b');
  if (!s.length) return s;
  const zm = zs(s, 'score');
  const zv = zs(s, 'vol');
  return s.map((x) => ({ ...x, score: (zm(x) - zv(x)) / 2 })).sort((a, b) => b.score - a.score);
};
/** The 50 strongest by momentum, then the calmest of those first. */
export const momThenLowVol = (pool) => (idx, syms, me) => scores(idx, syms, me, 'b').slice(0, pool).sort((a, b) => a.vol - b.vol);

/** Month-end NIFTY trend gate: in above SMA×(1+band), out below SMA×(1−band), else unchanged. */
export function trendGate(nifty, { smaDays = SETTINGS.smaDays, bandPct = SETTINGS.bandPct } = {}) {
  const dates = nifty.map((x) => x.date);
  const close = nifty.map((x) => x.close);
  let state = true;
  return (date) => {
    let i = dates.length - 1;
    while (i >= 0 && dates[i] > date) i--;
    if (i < smaDays) return state;
    let sum = 0;
    for (let k = i - smaDays + 1; k <= i; k++) sum += close[k];
    const sma = sum / smaDays;
    if (close[i] > sma * (1 + bandPct / 100)) state = true;
    else if (close[i] < sma * (1 - bandPct / 100)) state = false;
    return state;
  };
}

// --------------------------------------------------------------- stats ---
function ddOf(curve, from, to) {
  let peak = -Infinity;
  let dd = 0;
  for (const c of curve.filter((x) => x.date >= from && x.date <= to)) {
    peak = Math.max(peak, c.value);
    dd = Math.max(dd, 1 - c.value / peak);
  }
  return dd;
}
function run(data, { rank = null, gate = null, top = 20 }) {
  const { idx, universe, refDates, lastBhav } = data;
  const r = { ...REAL, top };
  const pre = simulate({ idx, universe, refDates, method: 'b', r, rank, gate: gate ? gate() : null });
  const post = simulate({ idx, universe, refDates, method: 'b', r, rank, gate: gate ? gate() : null, tax: true });
  const s = SETTINGS.split;
  const early = cagrOf(pre.curve, MOM.from, s);
  const earlyDd = ddOf(pre.curve, MOM.from, s);
  return {
    cagr: pre.cagr, cagrAfterTax: post.cagr, maxDrawdown: pre.maxDrawdown, turnoverPerYear: pre.turnoverPerYear,
    early, late: cagrOf(pre.curve, s, lastBhav), earlyDd, lateDd: ddOf(pre.curve, s, lastBhav),
    earlyScore: early != null && earlyDd > 0 ? early / earlyDd : null,
    since2020: cagrOf(pre.curve, '2020-08-01', lastBhav),
    monthsInCash: pre.lists.filter((l) => !l.symbols.length).length,
    yearly: yearly(pre.curve),
    lastList: (pre.lists[pre.lists.length - 1]?.symbols || []).map((x) => x.replace('.NS', '')),
  };
}

export const IDEAS = [
  { key: 'lowvol', name: 'Low volatility', versions: { lv20: ['20 calmest stocks', { rank: lowVol, top: 20 }], lv30: ['30 calmest stocks', { rank: lowVol, top: 30 }] } },
  { key: 'combo', name: 'Momentum + low volatility', versions: { blend: ['Blend: half momentum, half calmness (20 stocks)', { rank: momLowVolBlend }], filter50: ['50 strongest, then the 20 calmest of those', { rank: momThenLowVol(50) }], filter40: ['40 strongest, then the 20 calmest of those', { rank: momThenLowVol(40) }] } },
  { key: 'gate', name: 'Momentum 20 with a market filter', versions: { gate200: ['Momentum 20, liquid fund when NIFTY is below its 200-day average', { gate: 'trend' }] } },
];

export async function newIdeasTest({ loadCandles = candles } = {}) {
  const data = await loadAll(loadCandles);
  const { nifty, lastBhav } = data;
  const base = run(data, {});
  // NIFTY total return (≈1.2% a year dividends) on the same dates, from the saved Momentum 20 study when present
  let index = null;
  try {
    const m = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'momentum.json'), 'utf8'));
    index = m.index;
  } catch {
    /* no momentum study yet */
  }
  const ideas = [];
  for (const idea of IDEAS) {
    const results = {};
    for (const [k, [label, o]] of Object.entries(idea.versions)) {
      results[k] = { label, ...run(data, { ...o, gate: o.gate === 'trend' ? () => trendGate(nifty) : null }) };
    }
    // pick on 2010–17 only: return per unit of worst fall
    const pick = Object.keys(results).sort((a, b) => (results[b].earlyScore ?? -9) - (results[a].earlyScore ?? -9))[0];
    const x = results[pick];
    // fixed in advance: "better than Momentum 20" = within 1 point of its after-tax return AND a worst fall
    // at least 5 points smaller on 2018–now; and it must beat NIFTY in both halves
    const beatsNifty = index ? x.early > index.early && x.late > index.late : null;
    const smallerFalls = x.lateDd <= base.lateDd - 0.05;
    const keepsReturn = x.cagrAfterTax >= base.cagrAfterTax - 0.01;
    const passed = !!beatsNifty && smallerFalls && keepsReturn;
    const pc = (v) => `${(v * 100).toFixed(1)}%`;
    ideas.push({
      key: idea.key, name: idea.name, results, pick, passed,
      verdict: `${results[pick].label} (picked on 2010–17): ${pc(x.cagrAfterTax)} a year after tax vs ${pc(base.cagrAfterTax)} for Momentum 20; worst fall since 2018 ${pc(x.lateDd)} vs ${pc(base.lateDd)}; 2018–now ${pc(x.late)} a year vs NIFTY ${index ? pc(index.late) : '–'}. ${passed ? 'Passed: similar return with clearly smaller falls.' : !beatsNifty ? 'Did not pass: it did not beat NIFTY in both halves.' : !keepsReturn ? 'Did not pass: it gave up more than 1 point a year of return.' : 'Did not pass: the falls were not clearly smaller.'}`,
    });
  }
  ideas.push({
    key: 'inclusion', name: 'Index inclusion (stocks added to NIFTY 50)', results: null, pick: null, passed: null,
    verdict: 'Not tested: it needs the dates each stock was announced for NIFTY 50 / Next 50, which are not in this app’s data (NSE publishes them only as separate press releases). Only 2–6 changes happen a year, so even with that data a 16-year test would have under 100 cases. Studies of index additions generally report that much of the move comes before the change takes effect, so it is hard to catch after the announcement.',
  });
  return {
    at: new Date().toISOString(), from: MOM.from, to: lastBhav, split: SETTINGS.split, settings: SETTINGS,
    baseline: { label: 'Momentum 20 (realistic, same test)', ...base }, index, ideas,
    tried: IDEAS.reduce((a, i) => a + Object.keys(i.versions).length, 0),
    note: 'Survivorship-free (each month’s top 200 NSE stocks as they were, delisted ones sold at their last price). Monthly at the midpoint of the next day’s range, 0.55% a side (charges + slippage); tax simplified (sales netted per financial year). Liquid fund at 5% a year while out of the market. Six versions tried in all — a version that looks good partly by luck is possible.',
  };
}

export const saveNewIdeas = (r) => writeJsonAtomic(SAVED(), r);
export function loadNewIdeas() {
  try {
    return JSON.parse(readFileSync(SAVED(), 'utf8'));
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await newIdeasTest();
  saveNewIdeas(r);
  const pc = (v) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  const row = (l, x) => console.log(`${l.padEnd(58)} ${pc(x.cagr).padStart(6)} ${pc(x.cagrAfterTax).padStart(6)} dd ${pc(x.maxDrawdown).padStart(6)} | early ${pc(x.early)} dd ${pc(x.earlyDd)} | late ${pc(x.late)} dd ${pc(x.lateDd)} | cash ${x.monthsInCash ?? 0}`);
  row(r.baseline.label, r.baseline);
  if (r.index) console.log(`NIFTY: ${pc(r.index.cagr)} after tax ${pc(r.index.cagrAfterTax)} dd ${pc(r.index.maxDrawdown)} early ${pc(r.index.early)} late ${pc(r.index.late)}`);
  for (const i of r.ideas) {
    console.log(`\n${i.name}`);
    for (const [k, x] of Object.entries(i.results || {})) row(`${k === i.pick ? '*' : ' '} ${x.label}`, x);
    console.log(`  → ${i.verdict}`);
  }
}
