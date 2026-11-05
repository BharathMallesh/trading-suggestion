#!/usr/bin/env node
// The intraday strategies on 5 years of 5-minute candles (library + CLI): the YouTube intraday paper versions
// (video rules / improved / morning scanner) and the Breakfast strategy, with their CURRENT rules unchanged, on the
// Groww long history (paper-bot/data/candles-hist, from 2020). Same backtest code as the 52-day tests, same charges.
// 2020–22 vs 2023 → and year by year. Today's stock lists are used for the whole period (stocks that left the
// lists are missing), which flatters the results slightly. Research only.
//
//   node --max-old-space-size=12000 paper-bot/intraday-5y.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { readHist } from './groww-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.INTRADAY_5Y_PATH || join(HERE, 'data', 'intraday-5y.json');
export const SPLIT = '2023-01-01';
export const loadIntraday5y = () => {
  try {
    return JSON.parse(readFileSync(SAVED(), 'utf8'));
  } catch {
    return null;
  }
};

/** n, win rate, total, average, t of ₹ results. */
export function rupeeStats(xs) {
  const n = xs.length;
  if (!n) return { trades: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { trades: n, winRate: xs.filter((x) => x > 0).length / n, total: m * n, avg: m, tStat: sd ? m / (sd / Math.sqrt(n)) : null };
}
/** Whole period, 2020–22, 2023 → and each year. */
export function periods(trades, value = (t) => t.net) {
  const byYear = {};
  for (const t of trades) (byYear[t.date.slice(0, 4)] ||= []).push(value(t));
  return {
    all: rupeeStats(trades.map(value)), early: rupeeStats(trades.filter((t) => t.date < SPLIT).map(value)), late: rupeeStats(trades.filter((t) => t.date >= SPLIT).map(value)),
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, v]) => [y, rupeeStats(v)])),
    from: trades.map((t) => t.date).sort()[0] ?? null, to: trades.map((t) => t.date).sort().at(-1) ?? null,
  };
}

export async function intraday5y({ loadCandles = candles, read = readHist, breakfast = true } = {}) {
  const vp = await import('./vwap-pullback.mjs');
  const bf = await import('./breakfast.mjs');
  const { loadIndexList } = await import('./ranking.mjs');
  const p1 = Math.floor(Date.parse('2019-01-01') / 1000);
  const daily = async (s) => {
    try {
      return vp.dailyTrendLookup((await loadCandles(s, { period1: p1, interval: '1d' })).filter((r) => r.close > 0));
    } catch {
      return new Map();
    }
  };
  const out = { at: new Date().toISOString(), split: SPLIT, vwap: {}, breakfast: null };

  // YouTube intraday: the three paper versions
  for (const [key, v] of Object.entries(vp.PAPER_VARIANTS)) {
    const list = v.stocks || vp.VIDEO_STOCKS;
    const data = [];
    for (const s of list) {
      const rows = read(s).filter((r) => r.close > 0 && r.high > 0);
      if (rows.length) data.push({ s, rows, daily: await daily(s) });
    }
    const trades = vp.accountTrades(data.flatMap(({ s, rows, daily: d }) => vp.backtestStock(s, rows, v.rules, { daily: d })), v.rules.maxPerDay);
    out.vwap[key] = { label: v.label.replace(/ \(unproven\)$/, ''), stocks: data.length, sessions: new Set(data.flatMap((x) => x.rows.map((r) => r.date.slice(0, 10)))).size, ...periods(trades), beforeCosts: rupeeStats(trades.map((t) => t.gross ?? t.net)) };
  }

  // Breakfast: NIFTY 200 by sector, NIFTY's first five minutes
  if (breakfast) {
    const idx = await loadIndexList('nifty200');
    const ind = idx.industries || {};
    const uni = (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`));
    const stocks = [];
    for (const s of uni) {
      const rows = read(s).filter((b) => b.close > 0 && b.high > 0);
      if (rows.length) stocks.push({ s, sector: ind[s] || ind[s.replace('.NS', '')] || 'Other', sessions: bf.sessionsOf(rows) });
    }
    const nifty = bf.sessionsOf(read('^NSEI').filter((b) => b.close > 0));
    const trades = [];
    for (const d of [...nifty.keys()].sort()) {
      const p = bf.picksFor(d, stocks, nifty);
      const ses = (sym) => stocks.find((x) => x.s === sym)?.sessions.get(d);
      for (const [side, pick] of [['long', p.long], ['short', p.short]]) {
        if (!pick) continue;
        const t = bf.simulate({ ...pick, date: d }, side, ses(pick.symbol), p.niftyMove);
        if (t) trades.push(t);
      }
    }
    out.breakfast = { label: 'Breakfast strategy', stocks: stocks.length, sessions: nifty.size, ...periods(trades), flatOpen: periods(trades.filter((t) => bf.isFlatOpen(t))), beforeCosts: rupeeStats(trades.map((t) => t.gross ?? t.net)) };
  }
  writeJsonAtomic(SAVED(), out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await intraday5y({ breakfast: !process.argv.includes('--vwap-only') });
    const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v || 0)).toLocaleString('en-IN')}`;
    const line = (name, x) => console.log(`${name.padEnd(46)} ${x.from} → ${x.to} · ${x.all.trades} trades, won ${Math.round((x.all.winRate || 0) * 100)}%, ${rs(x.all.total)} (t ${x.all.tStat?.toFixed(2)}) · 2020–22 ${rs(x.early.total)} (t ${x.early.tStat?.toFixed(2)}) · 2023→ ${rs(x.late.total)} (t ${x.late.tStat?.toFixed(2)})`);
    for (const v of Object.values(r.vwap)) line(v.label, v);
    if (r.breakfast) {
      line('Breakfast', r.breakfast);
      line('Breakfast · flat opens only', r.breakfast.flatOpen);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
