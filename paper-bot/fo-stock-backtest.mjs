#!/usr/bin/env node
// F&O stock-spread test on REAL NSE option prices (library + CLI), Jul 2024 → the latest finished month.
// Each monthly cycle: buy at the close of the first session after the previous monthly expiry, chosen with the app's
// own rules and only what was known that day (Up/Down labels from NSE history up to that day; each stock's own past
// moves for the odds); sell at the real option closes 2 sessions before expiry (stock options settle by delivery);
// all charges. Up to 3 spreads, ≤ 2 the same way, most-you-can-lose ≤ ₹3,000, both legs ≥ 100 contracts, no
// STAY OUT day. Controls (fixed before the first run): the opposite lean, no lean, and ranking by the replay average.
// Untraded options keep stale closes in NSE's file, so each leg is valued at no less than its intrinsic value and a
// bought spread at 0 … its width; a trade across a split / bonus (stock moved > 40%) is left out. Research only.
//
//   node --max-old-space-size=12000 paper-bot/fo-stock-backtest.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { downloadBhav, parseStockChains } from './vol-premium.mjs';
import { riskCheck, legCharges } from './fo-riskcheck.mjs';
import { signsAt, levelOf } from './trade-today.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = () => process.env.FO_STOCKS_HIST_DIR || join(HERE, 'data', 'fo-stocks-hist');
const SAVED = () => process.env.FO_STOCK_TEST_PATH || join(HERE, 'data', 'fo-stock-test.json');
export const TEST = { from: '2024-07-25', split: '2025-08-01', capital: 10000, perTrade: 3000, maxOpen: 3, maxPerSide: 2, minVolume: 100, minSessions: 5, exitSessionsBefore: 2 };
export const VARIANTS = {
  rules: { label: 'The app\'s rules (STRONG → call spread, WEAK → put spread, best odds)', side: 'lean' },
  opposite: { label: 'Control: the opposite (calls on WEAK, puts on STRONG)', side: 'opposite' },
  noLean: { label: 'Control: no lean (best odds either way)', side: 'both' },
  rankAvg: { label: 'Ranked by the replay average instead of the odds', side: 'lean', rank: 'avg' },
};
export const loadFoStockTest = () => {
  try {
    return JSON.parse(readFileSync(SAVED(), 'utf8'));
  } catch {
    return null;
  }
};
const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const day = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0;

/** Every stock's option chains on a day (cached; null = no NSE file, e.g. a holiday). */
async function chainsOn(d, { fetchFn = fetch, today }) {
  const f = join(CACHE(), `${d}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  if (!weekday(d) || d >= today) return null;
  let r = null;
  for (let k = 0; k < 3 && !r?.csv && !r?.missing; k++) {
    try {
      r = await downloadBhav(d, { fetchFn });
    } catch {
      r = null;
    }
    if (!r?.csv && !r?.missing) await new Promise((s) => setTimeout(s, 1500));
  }
  if (!r?.csv && !r?.missing) return null; // network trouble: not cached, tried again next time
  const out = r.csv ? parseStockChains(r.csv, d) : null;
  mkdirSync(CACHE(), { recursive: true });
  writeFileSync(f, JSON.stringify(out));
  return out;
}

/** Up/Down labels at the close of `d` from NSE history up to that day. */
function labeller(series, uni, features, labelOf, percentile) {
  const idx = new Map();
  const indexOf = (s, d) => {
    if (!idx.has(s)) idx.set(s, new Map((series.get(s) || []).map((r, i) => [r.date, i])));
    return idx.get(s).get(d);
  };
  const cache = new Map();
  const labelsAt = (d) => {
    if (cache.has(d)) return cache.get(d);
    const rows = [];
    for (const s of uni.get(d.slice(0, 7)) || []) {
      const i = indexOf(s, d);
      if (i == null || i < 260) continue;
      const f = features(series.get(s).slice(0, i + 1).map((x) => x.close), i);
      if (f) rows.push({ symbol: s, ...f });
    }
    const sorted = rows.map((x) => x.mom).sort((a, b) => a - b);
    const m = new Map(rows.map((x) => [x.symbol, labelOf(x, percentile(sorted, x.mom, { member: true }))]));
    cache.set(d, m);
    return m;
  };
  return { labelsAt, indexOf };
}

/** Candidate spreads on a day with the Fits-my-budget tries and filters; best per stock by the variant's score. */
export function candidates(d, chains, labels, rowsOf, v, t = TEST) {
  const out = [];
  for (const [sym, o] of Object.entries(chains || {})) {
    const lab = labels.get(sym);
    const sides = v.side === 'lean' ? (lab === 'strong' ? ['call-spread'] : lab === 'weak' ? ['put-spread'] : [])
      : v.side === 'opposite' ? (lab === 'strong' ? ['put-spread'] : lab === 'weak' ? ['call-spread'] : [])
        : lab ? ['call-spread', 'put-spread'] : [];
    if (!sides.length) continue;
    const rows = rowsOf(sym, d);
    const expiry = Object.keys(o.expiries || {}).filter((e) => e > d).sort()[0];
    const lot = o.lots?.[expiry] ?? o.lot;
    if (!rows || !expiry || !(lot > 0) || !(o.underlying > 0)) continue;
    const chain = { date: d, spot: o.underlying, expiry, chain: o.expiries[expiry], lot };
    let best = null;
    for (const strategy of sides) for (const distancePct of [0, 2]) for (const wingPct of [2, 4]) {
      let r;
      try {
        r = riskCheck({ symbol: sym, strategy, account: t.capital, distancePct, wingPct, chain, niftyRows: rows });
      } catch {
        continue;
      }
      if (!(-r.premium > 0) || !(r.definedMaxLoss <= t.perTrade) || r.sessions < t.minSessions) continue;
      if (Math.min(...r.legs.map((l) => chain.chain[l.strike]?.[l.type === 'CE' ? 'ceVol' : 'peVol'] ?? 0)) < t.minVolume) continue;
      const score = v.rank === 'avg' ? r.average : r.chanceOfProfit;
      if (!best || score > best.score) best = { sym, lab, strategy, legs: r.legs.map((l) => ({ k: l.strike, t: l.type, q: l.side === 'buy' ? 1 : -1, p: l.price })), lot, cost: -r.premium, maxLoss: r.definedMaxLoss, expiry, chance: r.chanceOfProfit, average: r.average, score, spot: o.underlying };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}
export function pickSpreads(cands, t = TEST) {
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= t.maxOpen) break;
    if (chosen.filter((x) => x.strategy === c.strategy).length < t.maxPerSide) chosen.push(c);
  }
  return chosen;
}
/** Sell a spread at a day's option closes, after entry and exit charges (null if not comparable). */
export function closeSpread(t, entryDate, exitDate, exitChains) {
  const o = exitChains?.[t.sym];
  const S = o?.underlying;
  if (!(S > 0) || Math.abs(S / t.spot - 1) > 0.4) return null; // a split / bonus adjusts the contracts
  const ch = o.expiries?.[t.expiry];
  const pxs = t.legs.map((l) => {
    const intr = l.t === 'CE' ? Math.max(S - l.k, 0) : Math.max(l.k - S, 0);
    const p = ch?.[l.k]?.[l.t];
    return p >= 0 ? Math.max(p, intr) : intr; // a stale close never below what exercising is worth
  });
  const width = Math.abs(t.legs[1].k - t.legs[0].k);
  const value = Math.min(width, Math.max(0, t.legs.reduce((a, l, i) => a + l.q * pxs[i], 0))) * t.lot;
  const stock = { lot: t.lot };
  const charges = t.legs.reduce((a, l, i) => a + legCharges(l.p, l.q, entryDate, stock) + legCharges(pxs[i], -l.q, exitDate, stock), 0) * t.lot;
  const pnl = value - t.cost - charges;
  return { symbol: t.sym, label: t.lab, strategy: t.strategy, legs: t.legs.map((l) => `${l.q > 0 ? 'buy' : 'sell'} ${l.k}${l.t === 'CE' ? 'C' : 'P'}`).join(' / '), lot: t.lot, entryDate, exitDate, expiry: t.expiry, cost: t.cost, maxLoss: t.maxLoss, chance: t.chance, pnl, move: S / t.spot - 1 };
}

export function summarise(trades, t = TEST) {
  const st = (xs) => {
    const n = xs.length;
    if (!n) return { trades: 0 };
    const m = xs.reduce((a, x) => a + x.pnl, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x.pnl - m) ** 2, 0) / Math.max(1, n - 1));
    const sorted = [...xs].sort((a, b) => b.pnl - a.pnl);
    return { trades: n, winRate: xs.filter((x) => x.pnl > 0).length / n, expectedWinRate: xs.reduce((a, x) => a + x.chance, 0) / n, total: m * n, avg: m, tStat: sd ? m / (sd / Math.sqrt(n)) : null, worst: sorted.at(-1).pnl, best: sorted[0].pnl, withoutBest2: m * n - sorted.slice(0, 2).reduce((a, x) => a + x.pnl, 0) };
  };
  // the ₹10,000 account month by month, and where the plan's 30% stop would have ended it
  const byExit = new Map();
  for (const x of trades) byExit.set(x.exitDate, (byExit.get(x.exitDate) || 0) + x.pnl);
  let v = t.capital;
  let stoppedAt = null;
  const curve = [...byExit].sort(([a], [b]) => a.localeCompare(b)).map(([date, p]) => {
    v += p;
    if (!stoppedAt && v <= t.capital * 0.7) stoppedAt = date;
    return { date, value: v };
  });
  return { all: st(trades), dev: st(trades.filter((x) => x.entryDate < t.split)), holdout: st(trades.filter((x) => x.entryDate >= t.split)), curve, stoppedAt, monthsUp: [...byExit.values()].filter((p) => p > 0).length, months: byExit.size,
    calls: st(trades.filter((x) => x.strategy === 'call-spread')), puts: st(trades.filter((x) => x.strategy === 'put-spread')) };
}

export async function foStockTest({ loadCandles = candles, now = new Date(), fetchFn = fetch, onCycle = () => {} } = {}) {
  const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
  const { features, labelOf, percentile } = await import('./updown-outlook.mjs');
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const series = loadSeries();
  if (!series.size) throw new Error('No NSE history yet.');
  const uni = pointInTimeUniverse(series);
  const { labelsAt, indexOf } = labeller(series, uni, features, labelOf, percentile);
  const rowsOf = (s, d) => {
    const i = indexOf(s, d);
    return i == null ? null : series.get(s).slice(0, i + 1);
  };
  const p1 = Math.floor(Date.parse('2009-01-01') / 1000);
  const N = (await loadCandles('^NSEI', { period1: p1, interval: '1d' })).filter((x) => x.close > 0 && x.high > 0);
  const VIX = new Map((await loadCandles('^INDIAVIX', { period1: p1, interval: '1d' })).filter((x) => x.close > 0).map((x) => [x.date, x.close]));
  const stayOut = (d) => {
    const i = N.findIndex((x) => x.date === d);
    const s = i > 0 ? signsAt(N, VIX, i) : null;
    return s ? levelOf('intraday', s.flags) === 'stay' : false;
  };
  const get = (d) => chainsOn(d, { fetchFn, today });
  const fileDay = async (d) => {
    for (let k = 0; k < 8; k++, d = day(d, 1)) {
      if (d >= today) return null;
      const c = await get(d);
      if (c) return { d, c };
    }
    return null;
  };
  const trades = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, []]));
  const cycles = [];
  let prev = TEST.from;
  for (;;) {
    const e0 = await fileDay(day(prev, 1));
    if (!e0) break;
    const expiry = Object.keys(Object.values(e0.c)[0]?.expiries || {}).filter((e) => e > e0.d).sort()[0];
    if (!expiry || expiry >= today) break; // the cycle hasn't finished yet
    let x = expiry;
    const xs = [];
    for (let k = 0; k < 15 && xs.length < TEST.exitSessionsBefore; k++) {
      x = day(x, -1);
      if (await get(x)) xs.push(x);
    }
    const exitDay = xs.at(-1);
    let entry = e0;
    for (let g = 0; g < 5 && entry && stayOut(entry.d); g++) entry = await fileDay(day(entry.d, 1)); // wait out STAY OUT days
    if (exitDay && entry && entry.d < exitDay) {
      const exitChains = await get(exitDay);
      for (const [k, v] of Object.entries(VARIANTS)) {
        for (const c of pickSpreads(candidates(entry.d, entry.c, labelsAt(entry.d), rowsOf, v))) {
          const r = closeSpread(c, entry.d, exitDay, exitChains);
          if (r) trades[k].push(r);
        }
      }
      cycles.push({ entry: entry.d, exit: exitDay, expiry });
      onCycle(cycles.at(-1));
    }
    prev = expiry;
  }
  const out = {
    at: now.toISOString(), test: TEST, cycles: cycles.length, from: cycles[0]?.entry, to: cycles.at(-1)?.exit,
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, { label: v.label, ...summarise(trades[k]), trades: trades[k] }])),
  };
  const r = out.variants.rules;
  out.verdict = r.all.total > 0 && (r.all.tStat ?? 0) >= 2
    ? `The rules made money on real prices (${rs(r.all.total)} over ${r.all.trades} trades).`
    : `On real NSE prices the app's rules lost ${rs(r.all.total)} over ${r.all.trades} trades (${Math.round(r.all.winRate * 100)}% won, when the odds said ${Math.round(r.all.expectedWinRate * 100)}%)${r.stoppedAt ? `; the plan's 30% stop would have ended it on ${r.stoppedAt}` : ''}. None of the controls was reliably better.`;
  writeJsonAtomic(SAVED(), out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await foStockTest({ onCycle: (c) => process.stderr.write(`cycle ${c.entry} → ${c.exit}\n`) });
    console.log(`F&O stock test (real NSE prices, ${r.from} → ${r.to}, ${r.cycles} months): ${r.verdict}`);
    for (const v of Object.values(r.variants)) console.log(`  ${v.label}: ${v.all.trades} trades, won ${Math.round((v.all.winRate || 0) * 100)}%, ${rs(v.all.total || 0)} (without the best 2: ${rs(v.all.withoutBest2 || 0)}), t ${v.all.tStat?.toFixed(2)}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
