#!/usr/bin/env node
// Swing entry timing test (library + CLI): for every Strong-stock swing buy
// (wide trail), compare two ways of buying on the entry day —
//   A. at the 9:15 open (the current rule)
//   B. only when price breaks above the 10-minute opening range (9:15–9:25 high),
//      before 2:30 pm; skipped if the range low breaks first or it never breaks
// Same stock, same stop, same exit (the swing rules); only the entry differs.
// Yahoo keeps 5-minute candles for ~60 days, so each day is recorded while it is
// available. A one-time backfill re-runs the swing rules on the NIFTY 200 over the
// last ~8 weeks for a first sample. Research / paper only — not advice.
//
//   node paper-bot/swing-orb.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';
import { loadAthPaper, wideRules, tradesFor, loadDaily, universe } from './ath-swing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.SWING_ORB_PATH || join(HERE, 'data', 'swing-orb.json');
export const RULES = { orMinutes: 10, buffer: 0.0005, slippage: 0.001, lastEntry: '14:30', windowDays: 55 };

const ist = (ts) => new Date((ts + 19800) * 1000).toISOString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const keyOf = (t) => `${String(t.symbol).replace('.NS', '')}|${t.entryDate}`;

/** The opening-range entry on one day's 5-minute bars → { entry, time } or { skip }. */
export function orbEntry(bars, stop, r = RULES) {
  const day = bars.filter((b) => b.hm >= '09:15');
  const n = Math.round(r.orMinutes / 5);
  if (day.length < n + 1 || day[0].hm !== '09:15') return { skip: 'no 5-minute data' };
  const orH = Math.max(...day.slice(0, n).map((b) => b.high));
  const orL = Math.min(...day.slice(0, n).map((b) => b.low));
  const lvl = orH * (1 + r.buffer);
  for (const b of day.slice(n)) {
    if (b.hm >= r.lastEntry) break;
    const up = b.high >= lvl;
    const down = b.low < orL;
    if (down && !up) return { skip: 'opening range broke down first' };
    if (up) {
      const entry = Math.max(lvl, b.open) * (1 + r.slippage);
      if (!(entry > stop)) return { skip: 'below the stop' };
      return { entry, time: b.hm, orHigh: orH, orLow: orL };
    }
  }
  return { skip: 'never broke above the opening range' };
}

async function dayBars(loadCandles, symbol, date) {
  const rows = await loadCandles(`${String(symbol).replace('.NS', '')}.NS`, { period1: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - 86400, interval: '5m' });
  return rows.filter((x) => x.close > 0).map((b) => ({ ...b, d: ist(b.ts).slice(0, 10), hm: ist(b.ts).slice(11, 16) })).filter((b) => b.d === date);
}

export function summary(store) {
  const rows = Object.values(store.trades || {});
  const closed = rows.filter((t) => !t.open && t.rOpen != null);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const orbTaken = closed.filter((t) => !t.orb.skip);
  return {
    trades: rows.length, closed: closed.length, open: rows.length - closed.length,
    atOpen: { avgR: avg(closed.map((t) => t.rOpen)), winRate: closed.length ? closed.filter((t) => t.rOpen > 0).length / closed.length : null },
    orb: { taken: orbTaken.length, skipped: closed.length - orbTaken.length, avgR: avg(closed.map((t) => (t.orb.skip ? 0 : t.rOrb))), avgRTaken: avg(orbTaken.map((t) => t.rOrb)), winRate: orbTaken.length ? orbTaken.filter((t) => t.rOrb > 0).length / orbTaken.length : null },
    skippedAtOpenR: avg(closed.filter((t) => t.orb.skip).map((t) => t.rOpen)),
  };
}

export async function swingOrbUpdate({ loadCandles = candles, now = new Date(), backfill = true, r = RULES } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const store = (() => {
    try {
      return JSON.parse(readFileSync(SAVED(), 'utf8'));
    } catch {
      return { startedAt: today, trades: {} };
    }
  })();
  const oldest = addDays(today, -r.windowDays);
  const wide = wideRules();
  // the swing trades to compare: the paper record (wide) + a one-time backfill of the last ~8 weeks
  const source = new Map();
  for (const t of (loadAthPaper()?.trades || []).filter((x) => x.version === 'wide')) source.set(keyOf(t), { ...t, from: 'paper' });
  const needBackfill = backfill && !store.backfillDone;
  const backfillSyms = new Set(Object.values(store.trades).filter((t) => t.from === 'backfill' && t.open).map((t) => t.symbol));
  if (needBackfill || backfillSyms.size) {
    const syms = needBackfill ? await universe() : [...backfillSyms].map((s) => `${s}.NS`);
    for (const { s, rows } of await loadDaily(loadCandles, syms, '2005-01-01', now)) {
      for (const t of tradesFor(s, rows, wide)) if ((t.entryDate >= oldest || store.trades[keyOf(t)]) && !source.has(keyOf(t))) source.set(keyOf(t), { ...t, from: 'backfill' }); // recorded trades keep updating until they close
    }
    if (needBackfill) store.backfillDone = today;
  }
  for (const [k, t] of source) {
    if (t.entryDate > today) continue;
    let rec = store.trades[k];
    if (!rec) {
      if (t.entryDate < oldest) continue; // 5-minute data no longer available
      let bars;
      try {
        bars = await dayBars(loadCandles, t.symbol, t.entryDate);
      } catch {
        continue; // try again tomorrow
      }
      if (!bars.length || (t.entryDate === today && bars.at(-1).hm < '15:15')) continue; // the day isn't complete yet
      rec = { symbol: String(t.symbol).replace('.NS', ''), entryDate: t.entryDate, from: t.from, stop: t.stop, openEntry: t.entry, orb: orbEntry(bars, t.stop, r) };
      store.trades[k] = rec;
    }
    // exits come from the swing rules (same for both versions)
    rec.open = t.open;
    rec.exitDate = t.exitDate;
    rec.exit = t.exit;
    rec.reason = t.reason;
    rec.rOpen = t.r;
    // the opening-range entry pays the same charges (as a share of the trade) as the open entry
    const costPct = t.retPct != null ? t.exit / t.entry - 1 - t.retPct : 0;
    rec.rOrb = rec.orb.skip ? null : ((t.exit / rec.orb.entry - 1 - costPct) * rec.orb.entry) / (rec.orb.entry - t.stop);
  }
  store.updatedAt = now.toISOString();
  store.summary = summary(store);
  writeJsonAtomic(SAVED(), store);
  return store;
}

export function loadSwingOrb() {
  try {
    return JSON.parse(readFileSync(SAVED(), 'utf8'));
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await swingOrbUpdate();
    const s = st.summary;
    const f = (x) => (x == null ? '–' : x.toFixed(2));
    console.log(`Swing entry timing: ${s.trades} swing buys (${s.closed} closed) · at the open ${f(s.atOpen.avgR)} R a trade · opening-range entry ${f(s.orb.avgR)} R (taken ${s.orb.taken}, skipped ${s.orb.skipped}; skipped ones made ${f(s.skippedAtOpenR)} R at the open)`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
