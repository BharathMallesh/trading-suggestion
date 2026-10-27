#!/usr/bin/env node
// Core + satellite paper portfolio (library + CLI): the plan every test in the
// app points to — mostly a NIFTY index fund ("core") plus a small slice in the
// strong-stock swing strategy ("satellite") — tracked as one paper account from
// the day the swing paper record began, against holding 100% NIFTY.
//
//   core       a NIFTY ETF bought on the start day (price = NIFTY; 0.05% to buy)
//   satellite  the swing strategy's paper trades (rules in use), sized at 1% risk
//              of the satellite money, ≤ 10 positions, idle cash in a liquid fund
//              at 6%, valued at every day's close (ath-swing portfolio())
//   mixes      80 / 20 (the suggested plan) and 50 / 50, plus 100% NIFTY
// Paper only — not investment advice.
//
//   node paper-bot/core-satellite.mjs --update   # recompute and save (evening job)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { loadAthPaper, activeRules, RULES as ATH_RULES, portfolio, completedOnly } from './ath-swing.mjs';
import { loadJournal } from './journal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.CORE_SAT_PATH || join(HERE, 'data', 'core-satellite.json');
export const MIXES = [0.8, 0.5]; // share in the index fund
const ETF_BUY_COST = 0.0005;

/** Worst peak-to-trough fall of a value series. */
export function worstFall(values) {
  let peak = -Infinity;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
  }
  return dd;
}

/**
 * Daily values of each mix. `nifty` = [{date, close}] from the start; `satellite`
 * = Map(date → value of ₹1 put in the swing strategy on the start day).
 */
export function combine({ nifty, satellite, capital }) {
  const n0 = nifty[0].close;
  let last = 1;
  return nifty.map(({ date, close }) => {
    if (satellite.has(date)) last = satellite.get(date);
    const idx = (close / n0) * (1 - ETF_BUY_COST);
    const row = { date, nifty: capital * idx, satellite: last };
    for (const w of MIXES) row[`m${Math.round(w * 100)}`] = capital * (w * idx + (1 - w) * last);
    return row;
  });
}

export async function coreSatellite({ loadCandles = candles, now = new Date(), capital = Number(loadJournal().settings?.capital) || 100000, swing = loadAthPaper() } = {}) {
  if (!swing?.startedAt) return null;
  const start = swing.startedAt;
  const rules = { ...activeRules(), capital: 1e6 };
  const version = activeRules() !== ATH_RULES ? 'improved' : 'original';
  const trades = (swing.trades || []).filter((t) => (t.version || 'original') === version && t.entryDate >= start);
  const nifty = completedOnly((await loadCandles('^NSEI', { period1: Math.floor(Date.parse(start) / 1000) - 5 * 86400, interval: '1d' })).filter((x) => x.close > 0), now).filter((x) => x.date >= start);
  if (nifty.length < 1) return null;
  const days = nifty.map((x) => x.date);
  const series = new Map();
  for (const s of [...new Set(trades.map((t) => t.symbol))]) {
    try {
      const rows = (await loadCandles(s, { period1: Math.floor(Date.parse(start) / 1000) - 5 * 86400, interval: '1d' })).filter((x) => x.close > 0);
      series.set(s, new Map(rows.map((x) => [x.date, x.close])));
    } catch {
      /* a missing series is valued at its entry price */
    }
  }
  const pf = trades.length ? portfolio(trades, rules, { closes: (s) => series.get(s), days }) : { curve: [], taken: [] };
  const satellite = new Map(pf.curve.map((p) => [p.date, p.equity / rules.capital]));
  const curve = combine({ nifty, satellite, capital });
  const last = curve[curve.length - 1];
  const mix = (k, label) => ({ key: k, label, value: last[k], returnPct: (last[k] / capital - 1) * 100, worstFallPct: worstFall(curve.map((r) => r[k])) * 100 });
  return {
    at: new Date().toISOString(), startedAt: start, asOf: last.date, capital, version,
    mixes: [mix('m80', '80% index fund + 20% swing (the suggested plan)'), mix('m50', '50% index fund + 50% swing'), mix('nifty', '100% NIFTY index fund')],
    swingSlice: { returnPct: (last.satellite - 1) * 100, positions: pf.taken.map((t) => ({ symbol: t.symbol, entryDate: t.entryDate, open: !!t.open, retPct: t.retPct * 100, value: t.value / rules.capital })) },
    curve,
    note: `Paper account of ₹${capital.toLocaleString('en-IN')} from ${start} (when the swing paper record began). The index fund part follows NIFTY (price only, 0.05% to buy); the swing part takes every paper trade of the ${version} rules at 1% risk of its own money, ≤ 10 positions, idle cash at 6%, valued at each close. A few weeks say little — the point is to watch the plan over years. Paper only.`,
  };
}

export const saveCoreSatellite = (r) => writeJsonAtomic(SAVED(), r);
export function loadCoreSatellite() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  coreSatellite()
    .then((r) => {
      if (!r) return console.log('Core + satellite: no swing paper record yet.');
      if (process.argv.includes('--update')) saveCoreSatellite(r);
      console.log(`Core + satellite paper (since ${r.startedAt}, to ${r.asOf}): ${r.mixes.map((m) => `${m.label.split(' (')[0]} ${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(2)}% (worst fall ${m.worstFallPct.toFixed(1)}%)`).join(' · ')} · swing slice ${r.swingSlice.returnPct >= 0 ? '+' : ''}${r.swingSlice.returnPct.toFixed(2)}%`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
