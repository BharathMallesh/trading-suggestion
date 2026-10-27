#!/usr/bin/env node
// "Breakfast strategy" (library + CLI), from a trader interview: pick the
// day's stock from sector strength in the first five minutes, enter at ~9:21,
// 1% target / 1% stop, and be out by ~9:45 whatever happens.
//
// Rules (fixed before testing):
//   9:15–9:20   score every NIFTY 200 stock by its move from yesterday's close
//               to the close of the 9:15 candle; a sector's strength is the
//               average of its stocks (sectors with 3+ stocks)
//   Long        strongest sector → its strongest stock that is up less than 5%
//               (don't chase a stock already up 5%+)
//   Short       weakest sector → its weakest stock down less than 5%
//   Entry       open of the 9:20 candle (≈ 9:21) + slippage
//   Stop        1% from entry
//   Target      1%, or 0.5% when NIFTY's first five minutes are against the
//               trade ("smaller profit when the market is negative")
//   Exit        at the stop or target (stop assumed first if both are inside
//               one candle), otherwise at 9:45 (close of the 9:40 candle)
//   Versions    long only · short only · both (one long + one short a day)
//   Costs       intraday charges + 0.03% slippage per fill; ₹1 lakh at 5×
//               intraday leverage = ₹5 lakh position (the interview's example)
// Equity only: the interview also trades at-the-money options on the same
// signals, which needs intraday option prices we don't have.
// Research / paper only — not investment advice.
//
//   node paper-bot/breakfast.mjs            # backtest on saved + Yahoo 5-minute data
//   node paper-bot/breakfast.mjs --paper    # update the forward paper record

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { orderCharges } from './costs.mjs';
import { loadIndexList } from './ranking.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';
import { withStore } from './vwap-pullback.mjs';
import { isTradingDay } from './market-calendar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.BREAKFAST_PATH || join(HERE, 'data', 'breakfast.json');
const PAPER = () => process.env.BREAKFAST_PAPER_PATH || join(HERE, 'data', 'breakfast-paper.json');

export const RULES = { flatOpenPct: 0.3, maxChasePct: 5, stopPct: 1, targetPct: 1, weakTargetPct: 0.5, exitAt: '09:40', minSectorStocks: 3, capital: 100000, leverage: 5, slippagePct: 0.03, topSectors: 3 };
const COSTS = { brokerageDeliveryPct: 0, brokerageDeliveryCap: 0, brokerageIntradayPct: 0.03, brokerageIntradayCap: 20, dpChargePerSell: 0, slippagePct: 0 };

const hhmm = (r) => String(r.date).slice(11, 16);
const day = (r) => String(r.date).slice(0, 10);

/** Per stock: { date → { first, entryIdx, prevClose, rows } } from 5-minute bars. */
export function sessionsOf(rows) {
  const out = new Map();
  let prevClose = null;
  for (let i = 0; i < rows.length; i++) {
    const d = day(rows[i]);
    let s = out.get(d);
    if (!s) {
      s = { prevClose, bars: [] };
      out.set(d, s);
    }
    s.bars.push(rows[i]);
    if (i + 1 === rows.length || day(rows[i + 1]) !== d) prevClose = rows[i].close;
  }
  return out;
}

/** The 9:15 candle's move from yesterday's close (%), or null. */
const firstMove = (s) => {
  const b = s?.bars.find((x) => hhmm(x) === '09:15');
  return b && s.prevClose ? (b.close / s.prevClose - 1) * 100 : null;
};

/**
 * Picks for one date: sector heat map and the long / short candidates.
 * stocks: [{ s, sector, sessions: Map }], nifty: Map of sessions for ^NSEI.
 */
export function picksFor(date, stocks, nifty, r = RULES) {
  const moves = [];
  for (const x of stocks) {
    const m = firstMove(x.sessions.get(date));
    if (m != null && Number.isFinite(m)) moves.push({ symbol: x.s, sector: x.sector, move: m });
  }
  const bySector = new Map();
  for (const m of moves) {
    if (!bySector.has(m.sector)) bySector.set(m.sector, []);
    bySector.get(m.sector).push(m);
  }
  const sectors = [...bySector].filter(([, v]) => v.length >= r.minSectorStocks)
    .map(([name, v]) => ({ name, avg: v.reduce((a, b) => a + b.move, 0) / v.length, stocks: v.sort((a, b) => b.move - a.move), count: v.length }))
    .sort((a, b) => b.avg - a.avg);
  const niftyMove = firstMove(nifty?.get(date));
  if (!sectors.length) return { date, sectors: [], niftyMove, long: null, short: null };
  const top = sectors[0];
  const bottom = sectors[sectors.length - 1];
  const long = top.stocks.find((x) => x.move < r.maxChasePct && x.move > 0) || null;
  const short = [...bottom.stocks].reverse().find((x) => x.move > -r.maxChasePct && x.move < 0) || null;
  return {
    date, niftyMove, sectors,
    long: long && top.avg > 0 ? { ...long, sectorAvg: top.avg } : null,
    short: short && bottom.avg < 0 ? { ...short, sectorAvg: bottom.avg } : null,
    alternatives: {
      long: sectors.slice(0, r.topSectors).filter((x) => x.avg > 0).map((x) => ({ sector: x.name, avg: x.avg, stock: x.stocks.find((y) => y.move < r.maxChasePct && y.move > 0)?.symbol ?? null })),
      short: sectors.slice(-r.topSectors).reverse().filter((x) => x.avg < 0).map((x) => ({ sector: x.name, avg: x.avg, stock: [...x.stocks].reverse().find((y) => y.move > -r.maxChasePct && y.move < 0)?.symbol ?? null })),
    },
  };
}

/** Simulate one pick on its session's bars. Returns a trade or null (no 9:20 candle yet). */
export function simulate(pick, side, session, niftyMove, r = RULES, { live = false } = {}) {
  const bars = session.bars;
  const ei = bars.findIndex((x) => hhmm(x) === '09:20');
  if (ei < 0) return null;
  const slip = r.slippagePct / 100;
  const dir = side === 'long' ? 1 : -1;
  const entry = bars[ei].open * (1 + dir * slip);
  const against = niftyMove != null && dir * niftyMove < 0;
  const targetPct = against ? r.weakTargetPct : r.targetPct;
  const stop = entry * (1 - (dir * r.stopPct) / 100);
  const target = entry * (1 + (dir * targetPct) / 100);
  let exit = null;
  let reason = null;
  let k = ei;
  for (; k < bars.length && hhmm(bars[k]) <= r.exitAt; k++) {
    const c = bars[k];
    const hitStop = side === 'long' ? c.low <= stop : c.high >= stop;
    const hitTarget = side === 'long' ? c.high >= target : c.low <= target;
    if (hitStop) {
      exit = side === 'long' ? Math.min(stop, c.open) : Math.max(stop, c.open);
      reason = 'stop';
      break;
    }
    if (hitTarget) {
      exit = target;
      reason = 'target';
      break;
    }
  }
  let open = false;
  if (exit == null) {
    const last = bars[Math.min(k, bars.length) - 1];
    exit = last.close;
    if (hhmm(last) < r.exitAt && live) {
      open = true;
      reason = 'open';
    } else reason = '9:45';
  }
  const exitFill = exit * (1 - dir * slip);
  const qty = Math.floor((r.capital * r.leverage) / entry);
  const gross = dir * (exitFill - entry) * qty;
  const buyVal = (side === 'long' ? entry : exitFill) * qty;
  const sellVal = (side === 'long' ? exitFill : entry) * qty;
  const charges = orderCharges({ side: 'buy', value: buyVal, product: 'intraday', costs: COSTS }).total + orderCharges({ side: 'sell', value: sellVal, product: 'intraday', costs: COSTS }).total;
  return {
    date: pick.date ?? day(bars[ei]), symbol: pick.symbol, sector: pick.sector, side, firstMovePct: pick.move,
    niftyMovePct: niftyMove, targetPct, entry, stop, target, exit: exitFill, reason, open, qty,
    gross, charges, net: gross - charges, retPct: dir * (exitFill / entry - 1) * 100,
  };
}

/**
 * "Flat opens only" version (2026-10-27 weekday study): trade only when NIFTY's
 * first five minutes moved ≤ 0.3% either way — on gap days the first move is
 * often an overreaction. Same trades, filtered by the day. Paper only, unproven.
 */
export const isFlatOpen = (t, r = RULES) => t.niftyMovePct != null && Math.abs(t.niftyMovePct) <= r.flatOpenPct;

export function summarise(trades) {
  const done = trades.filter((t) => !t.open);
  if (!done.length) return { trades: 0 };
  const wins = done.filter((t) => t.net > 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const per = new Map();
  for (const t of done) per.set(t.date, (per.get(t.date) || 0) + t.net);
  const daily = [...per.values()];
  const m = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, daily.length - 1));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const v of daily) {
    eq += v;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    trades: done.length, days: daily.length, winRate: wins.length / done.length,
    avgNetRs: sum(done, (t) => t.net) / done.length, avgGrossRs: sum(done, (t) => t.gross) / done.length, avgChargesRs: sum(done, (t) => t.charges) / done.length,
    totalNetRs: sum(done, (t) => t.net), maxDrawdownRs: dd, tStat: sd > 0 ? m / (sd / Math.sqrt(daily.length)) : null,
    exits: Object.fromEntries(['target', 'stop', '9:45'].map((k) => [k, done.filter((t) => t.reason === k).length])),
  };
}

async function universe() {
  const idx = await loadIndexList('nifty200');
  const ind = idx.industries || {};
  return (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`)).map((s) => ({ s, sector: ind[s] || ind[s.replace('.NS', '')] || 'Other' }));
}

async function loadData(loadCandles, p1) {
  const get = withStore(loadCandles);
  const list = await universe();
  const stocks = (await mapLimit(list, 6, async (x) => {
    try {
      const rows = (await get(x.s, { period1: p1, interval: '5m' })).filter((b) => b.close > 0 && b.high > 0 && Number(hhmm(b).slice(3)) % 5 === 0);
      return rows.length ? { ...x, sessions: sessionsOf(rows) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const nifty = sessionsOf((await get('^NSEI', { period1: p1, interval: '5m' })).filter((b) => b.close > 0));
  return { stocks, nifty };
}

/** Backtest every session in the saved + Yahoo 5-minute history. */
export async function breakfastTest({ loadCandles = candles } = {}) {
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400;
  const { stocks, nifty } = await loadData(loadCandles, p1);
  const today = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const dates = [...nifty.keys()].filter((d) => d !== today).sort();
  const longs = [];
  const shorts = [];
  const daysOut = [];
  for (const d of dates) {
    const p = picksFor(d, stocks, nifty);
    const ses = (sym) => stocks.find((x) => x.s === sym)?.sessions.get(d);
    const L = p.long ? simulate({ ...p.long, date: d }, 'long', ses(p.long.symbol), p.niftyMove) : null;
    const S = p.short ? simulate({ ...p.short, date: d }, 'short', ses(p.short.symbol), p.niftyMove) : null;
    if (L) longs.push(L);
    if (S) shorts.push(S);
    daysOut.push({ date: d, niftyMovePct: p.niftyMove, topSector: p.sectors[0]?.name, bottomSector: p.sectors[p.sectors.length - 1]?.name, long: L, short: S });
  }
  // "Don't chase" check: what if the strongest stock had been taken even when up 5%+?
  const mid = dates[dates.length >> 1];
  const both = [...longs, ...shorts];
  return {
    at: new Date().toISOString(), stocks: stocks.length, sessions: dates.length, from: dates[0], to: dates[dates.length - 1], splitDate: mid,
    rules: RULES,
    longOnly: summarise(longs), shortOnly: summarise(shorts), both: summarise(both),
    halves: { first: summarise(both.filter((t) => t.date < mid)), second: summarise(both.filter((t) => t.date >= mid)) },
    flatOpen: {
      all: summarise(both.filter((t) => isFlatOpen(t))), gapDays: summarise(both.filter((t) => !isFlatOpen(t))),
      first: summarise(both.filter((t) => isFlatOpen(t) && t.date < mid)), second: summarise(both.filter((t) => isFlatOpen(t) && t.date >= mid)),
      note: 'Flat opens = NIFTY moved ≤ 0.3% either way in the first five minutes (9:15–9:20). Found in a weekday / opening-gap study on the same ~48 sessions, so this result is not an independent test; the paper record decides.',
    },
    beforeCosts: summarise(both.map((t) => ({ ...t, net: t.gross }))),
    recent: daysOut.slice(-15).reverse(),
    note: 'Equity only (the interview also uses at-the-money options on the same signals). First 5 minutes = yesterday\'s close → close of the 9:15 candle; entry at the 9:20 candle open; stop assumed before target inside one candle; ₹1 lakh at 5× intraday leverage per trade. Only ~40 sessions of 5-minute history are available so far (it grows daily), so treat the result as early. Research only.',
  };
}

export function saveBreakfast(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadBreakfast() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Today's (or the latest session's) sector heat map, picks and their progress. */
export async function breakfastToday({ loadCandles = candles, now = new Date() } = {}) {
  const p1 = Math.floor(now.getTime() / 1000) - 6 * 86400;
  const { stocks, nifty } = await loadData(loadCandles, p1);
  const t = new Date(now.getTime() + 19800_000);
  const today = t.toISOString().slice(0, 10);
  const nowT = t.toISOString().slice(11, 16);
  const date = [...nifty.keys()].sort().pop();
  const live = date === today && isTradingDay(today) && nowT < '15:30';
  const p = picksFor(date, stocks, nifty);
  const ready = !!nifty.get(date)?.bars.some((b) => hhmm(b) === '09:15') && (!live || nowT >= '09:20');
  const ses = (sym) => stocks.find((x) => x.s === sym)?.sessions.get(date);
  const sim = (pick, side) => (pick && ready ? simulate({ ...pick, date }, side, ses(pick.symbol), p.niftyMove, RULES, { live: live && nowT < '09:45' }) : null);
  return {
    at: now.toISOString(), date, live, time: nowT, ready,
    niftyMovePct: p.niftyMove,
    sectors: p.sectors.map((x) => ({ name: x.name, avg: x.avg, count: x.count, leader: x.stocks[0]?.symbol, laggard: x.stocks[x.stocks.length - 1]?.symbol })),
    long: p.long ? { ...p.long, trade: sim(p.long, 'long') } : null,
    short: p.short ? { ...p.short, trade: sim(p.short, 'short') } : null,
    alternatives: p.alternatives,
    note: ready ? 'Picks use the 9:15–9:20 candle. The strategy enters at ~9:21 and is out by 9:45 at the latest.' : 'The picks appear after 9:20, once the first 5-minute candle has closed.',
  };
}

export function loadBreakfastPaper() {
  try {
    return existsSync(PAPER()) ? JSON.parse(readFileSync(PAPER(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** After the close: record each session's long and short picks from the start date on. */
export async function breakfastPaperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadBreakfastPaper() || { startedAt: new Date(now.getTime() + 19800_000).toISOString().slice(0, 10), trades: [] };
  const p1 = Math.floor(now.getTime() / 1000) - 8 * 86400;
  const { stocks, nifty } = await loadData(loadCandles, p1);
  const t = new Date(now.getTime() + 19800_000);
  const today = t.toISOString().slice(0, 10);
  const afterClose = t.getUTCHours() * 60 + t.getUTCMinutes() >= 15 * 60 + 35;
  const have = new Set(st.trades.map((x) => `${x.date}|${x.side}`));
  let added = 0;
  for (const d of [...nifty.keys()].sort()) {
    if (d < st.startedAt || (d === today && !afterClose)) continue;
    const p = picksFor(d, stocks, nifty);
    for (const [side, pick] of [['long', p.long], ['short', p.short]]) {
      if (!pick || have.has(`${d}|${side}`)) continue;
      const tr = simulate({ ...pick, date: d }, side, stocks.find((x) => x.s === pick.symbol)?.sessions.get(d), p.niftyMove);
      if (tr) {
        st.trades.push(tr);
        added++;
      }
    }
  }
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { added, startedAt: st.startedAt, summary: summarise(st.trades), flatSummary: summarise(st.trades.filter((t) => isFlatOpen(t))) };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--paper')) {
    breakfastPaperUpdate()
      .then((r) => console.log(`Breakfast paper: +${r.added} trades · since ${r.startedAt} · ${r.summary.trades} trades · total net ₹${Math.round(r.summary.totalNetRs || 0)} · flat opens only: ${r.flatSummary.trades} trades, ₹${Math.round(r.flatSummary.totalNetRs || 0)}`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    breakfastTest()
      .then((r) => {
        saveBreakfast(r);
        const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
        const line = (n, x) => console.log(`${n.padEnd(22)} ${String(x.trades).padStart(4)} trades · win ${x.winRate != null ? Math.round(x.winRate * 100) : '–'}% · avg net ${rs(x.avgNetRs)} (gross ${rs(x.avgGrossRs)}, charges ${rs(x.avgChargesRs)}) · total ${rs(x.totalNetRs)} · t ${x.tStat?.toFixed(2)} · exits ${JSON.stringify(x.exits)}`);
        console.log(`\nBREAKFAST STRATEGY · ${r.stocks} stocks · ${r.sessions} sessions (${r.from} → ${r.to})`);
        line('Long only', r.longOnly);
        line('Short only', r.shortOnly);
        line('Both', r.both);
        line(`  before ${r.splitDate}`, r.halves.first);
        line(`  from ${r.splitDate}`, r.halves.second);
        line('Both, before costs', r.beforeCosts);
        console.log('Recent:');
        for (const d of r.recent.slice(0, 8)) console.log(`  ${d.date} NIFTY ${d.niftyMovePct?.toFixed(2)}% · top ${d.topSector} · long ${d.long ? `${d.long.symbol.replace('.NS', '')} ${d.long.reason} ${rs(d.long.net)}` : '–'} · short ${d.short ? `${d.short.symbol.replace('.NS', '')} ${d.short.reason} ${rs(d.short.net)}` : '–'}`);
        console.log(`\n${r.note}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
