#!/usr/bin/env node
// "Analyse today" scan (library + CLI): what each NIFTY 50 stock (plus the
// strategy's video stocks) is doing RIGHT NOW on today's 5-minute candles,
// and how often stocks in the same situation kept going that way for the
// rest of the day in the past.
//
// For every stock:
//   Trend now     above both its 20-candle average and VWAP (up), below both
//                 (down), or between them (mixed) — the video strategy's rule
//   Daily trend   yesterday's close vs its 20-day average
//   Morning move  % from yesterday's close by 09:30
//   NIFTY         the index on the same side or not
//   Alignment     strong (trend now + daily + morning/NIFTY agree), partial,
//                 weak (trend now only), or mixed
//   Setup         a fresh VWAP + 20 MA pullback signal in the last 15 minutes,
//                 with the strategy's entry / stop / target
//   History       for the same alignment at the same time of day over the last
//                 ~60 days of 5-minute data: % of cases where the stock kept
//                 moving the same way until 15:15, and the average move
//
// It describes the present and the past record; it does not predict the rest
// of today. Research / education only — not a recommendation to trade.
//
//   node paper-bot/today-scan.mjs          # rebuild the history table, then scan

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';
import { VIDEO_STOCKS } from './config.mjs';
import { loadIndexList } from './ranking.mjs';
import { RULES, indicators, backtestStock, dailyContext, withStore } from './vwap-pullback.mjs';
import { isTradingDay } from './market-calendar.mjs';

const STATS = () => process.env.TODAY_SCAN_STATS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'today-scan-stats.json');
export const CHECK_TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00'];
export const LEVELS = ['strong', 'partial', 'weak'];
export const GAP_PCT = 0.5;

const hhmm = (r) => String(r.date).slice(11, 16);
const day = (r) => String(r.date).slice(0, 10);
const sideOf = (b) => (b?.ma == null ? 0 : b.close > b.ma && b.close > b.vwap ? 1 : b.close < b.ma && b.close < b.vwap ? -1 : 0);

/** Alignment of the other signals with the intraday side (+1 up / −1 down). */
export function alignment({ side, dailyUp, gapPct, niftySide }) {
  if (!side) return 'mixed';
  const daily = dailyUp == null ? 0 : (dailyUp ? 1 : -1) === side ? 1 : -1;
  const morning = gapPct == null || Math.abs(gapPct) < GAP_PCT ? 0 : Math.sign(gapPct) === side ? 1 : -1;
  const nifty = niftySide == null || niftySide === 0 ? 0 : niftySide === side ? 1 : -1;
  if (daily === 1 && (morning === 1 || nifty === 1) && morning !== -1 && nifty !== -1) return 'strong';
  if ([daily, morning, nifty].filter((x) => x === 1).length >= 1 && [daily, morning, nifty].filter((x) => x === -1).length <= 1) return 'partial';
  return 'weak';
}

/** Per-session lookups from 5-minute bars: bar index by "date time", previous close, last bar per day. */
function sessions(bars) {
  const byKey = new Map();
  const days = new Map();
  let prevClose = null;
  for (let i = 0; i < bars.length; i++) {
    const d = day(bars[i]);
    byKey.set(`${d} ${hhmm(bars[i])}`, i);
    let s = days.get(d);
    if (!s) {
      s = { prevClose, first: i };
      days.set(d, s);
    }
    s.last = i;
    if (hhmm(bars[i]) === '09:25' && s.prevClose) s.gapPct = (bars[i].close / s.prevClose - 1) * 100;
    if (i + 1 === bars.length || day(bars[i + 1]) !== d) prevClose = bars[i].close;
  }
  return { byKey, days };
}

/** The candle that has COMPLETED by check time T (the bar labelled T − 5 minutes). */
const barBefore = (t) => {
  const [h, m] = t.split(':').map(Number);
  const x = h * 60 + m - 5;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/**
 * History table: for each check time and alignment level, how often the stock
 * kept moving in the direction of its trend from that candle to 15:15.
 * data: [{ s, rows, daily }], nifty: 5-minute rows of ^NSEI. Today's unfinished session is skipped.
 */
export function continuationStats(data, niftyRows, { today = null } = {}) {
  const nb = indicators(niftyRows, RULES);
  const nIdx = new Map(nb.map((b) => [b.date, b]));
  const acc = {};
  for (const t of CHECK_TIMES) {
    acc[t] = {};
    for (const l of [...LEVELS, 'all']) acc[t][l] = { n: 0, cont: 0, sumMove: 0 };
  }
  for (const { rows, daily } of data) {
    const bars = indicators(rows, RULES);
    const { byKey, days } = sessions(bars);
    for (const [d, s] of days) {
      if (d === today) continue;
      const endI = byKey.get(`${d} 15:15`) ?? s.last;
      if (hhmm(bars[endI]) < '15:00') continue; // incomplete session
      for (const t of CHECK_TIMES) {
        const i = byKey.get(`${d} ${barBefore(t)}`);
        if (i == null || i >= endI) continue;
        const b = bars[i];
        const side = sideOf(b);
        if (!side) continue;
        const nbar = nIdx.get(b.date);
        const level = alignment({ side, dailyUp: daily?.get(d)?.aboveAvg20 ?? null, gapPct: s.gapPct ?? null, niftySide: sideOf(nbar) || null });
        const move = side * (bars[endI].close / b.close - 1) * 100;
        for (const l of [level, 'all']) {
          const c = acc[t][l];
          c.n++;
          if (move > 0) c.cont++;
          c.sumMove += move;
        }
      }
    }
  }
  const out = {};
  for (const t of CHECK_TIMES) {
    out[t] = {};
    for (const [l, c] of Object.entries(acc[t])) out[t][l] = { n: c.n, continued: c.n ? c.cont / c.n : null, avgMovePct: c.n ? c.sumMove / c.n : null };
  }
  return out;
}

async function universe() {
  let list = [];
  try {
    const idx = await loadIndexList('nifty50');
    list = (idx.symbols || []).map((s) => (/\.(NS|BO)$|^\^/.test(s) ? s : `${s}.NS`));
  } catch {
    /* fall back to the video stocks */
  }
  return [...new Set([...VIDEO_STOCKS, ...list])];
}

async function loadAll(loadCandles, symbols, p1) {
  const get = withStore(loadCandles);
  return (await mapLimit(symbols, 6, async (s) => {
    try {
      const rows = (await get(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0 && Number(hhmm(r).slice(3)) % 5 === 0);
      return rows.length ? { s, rows, daily: await dailyContext(loadCandles, s) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
}

/** Build and save the history table (weekly in refit; first scan builds it if missing). */
export async function buildStats({ loadCandles = candles } = {}) {
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400;
  const symbols = await universe();
  const data = await loadAll(loadCandles, symbols, p1);
  const nifty = (await withStore(loadCandles)('^NSEI', { period1: p1, interval: '5m' })).filter((r) => r.close > 0);
  const today = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const stats = continuationStats(data, nifty, { today });
  const dates = [...new Set(nifty.map(day))].filter((d) => d !== today).sort();
  const out = { at: new Date().toISOString(), stocks: data.length, sessions: dates.length, from: dates[0], to: dates[dates.length - 1], stats };
  writeJsonAtomic(STATS(), out);
  return out;
}
export function loadStats() {
  try {
    return existsSync(STATS()) ? JSON.parse(readFileSync(STATS(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Nearest check time at or before the given clock time (10:00 before 10:00). */
export function checkTimeFor(t) {
  let pick = CHECK_TIMES[0];
  for (const c of CHECK_TIMES) if (c <= t) pick = c;
  return pick;
}

/** Live scan of today's (or the latest) session. */
export async function todayScan({ loadCandles = candles, now = new Date(), stats = null } = {}) {
  const hist = stats || loadStats() || (await buildStats({ loadCandles }));
  const p1 = Math.floor(now.getTime() / 1000) - 8 * 86400;
  const symbols = await universe();
  const data = await loadAll(loadCandles, symbols, p1);
  const niftyRows = (await loadCandles('^NSEI', { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && Number(hhmm(r).slice(3)) % 5 === 0);
  const nb = indicators(niftyRows, RULES);
  const nIdx = new Map(nb.map((b) => [b.date, b]));
  const date = data.map(({ rows }) => day(rows[rows.length - 1])).sort().pop();
  const ist = new Date(now.getTime() + 19800_000);
  const nowT = ist.toISOString().slice(11, 16);
  const live = isTradingDay(ist.toISOString().slice(0, 10)) && date === ist.toISOString().slice(0, 10) && nowT >= '09:15' && nowT < '15:30';
  const stocks = [];
  for (const { s, rows, daily } of data) {
    const bars = indicators(rows, RULES);
    const { days } = sessions(bars);
    const sess = days.get(date);
    if (!sess) continue;
    const b = bars[sess.last];
    const side = sideOf(b);
    // how long it has stayed on this side (minutes)
    let k = sess.last;
    while (k > sess.first && sideOf(bars[k - 1]) === side) k--;
    const since = hhmm(bars[k]);
    const nbar = nIdx.get(b.date);
    const dailyUp = daily?.get(date)?.aboveAvg20 ?? null;
    const level = alignment({ side, dailyUp, gapPct: sess.gapPct ?? null, niftySide: sideOf(nbar) || null });
    const ct = checkTimeFor(hhmm(b));
    const h = side ? hist?.stats?.[ct]?.[level] : null;
    // fresh strategy setup: a video-rules signal whose entry is in the last 15 minutes
    const today = backtestStock(s, rows, RULES, { daily }).filter((t) => t.date === date);
    const lastT = hhmm(b);
    const fresh = today.find((t) => t.time >= barBefore(barBefore(barBefore(lastT))) && t.reason === 'close');
    stocks.push({
      symbol: s, video: VIDEO_STOCKS.includes(s), time: lastT,
      price: b.close, changePct: sess.prevClose ? (b.close / sess.prevClose - 1) * 100 : null,
      gapPct: sess.gapPct ?? null, ma: b.ma ?? null, vwap: b.vwap, atrPct: b.atr ? (b.atr / b.close) * 100 : null,
      trend: side === 1 ? 'up' : side === -1 ? 'down' : 'mixed', since,
      // trend strength: distance from VWAP in "typical candle moves" (ATR)
      strength: b.atr ? (b.close - b.vwap) / b.atr : null,
      dailyTrend: dailyUp == null ? null : dailyUp ? 'up' : 'down',
      nifty: sideOf(nbar) === 1 ? 'up' : sideOf(nbar) === -1 ? 'down' : 'mixed',
      alignment: level,
      history: h ? { checkTime: ct, ...h } : null,
      setup: fresh ? { side: fresh.side, time: fresh.time, entry: fresh.entry, stop: fresh.stop, target: fresh.target } : null,
      strategyTradesToday: today.length,
    });
  }
  const rank = { strong: 0, partial: 1, weak: 2, mixed: 3 };
  stocks.sort((a, b) => rank[a.alignment] - rank[b.alignment] || Math.abs(b.strength ?? 0) - Math.abs(a.strength ?? 0));
  const ct = checkTimeFor(nowT);
  const all = hist?.stats?.[ct]?.all;
  return {
    at: now.toISOString(), date, live, lastBar: stocks.map((x) => x.time).sort().pop(),
    nifty: { trend: sideOf(nb[nb.length - 1]) === 1 ? 'up' : sideOf(nb[nb.length - 1]) === -1 ? 'down' : 'mixed', price: nb[nb.length - 1]?.close ?? null },
    counts: { up: stocks.filter((x) => x.trend === 'up').length, down: stocks.filter((x) => x.trend === 'down').length, mixed: stocks.filter((x) => x.trend === 'mixed').length },
    stocks,
    history: hist ? { sessions: hist.sessions, stocks: hist.stocks, from: hist.from, to: hist.to, checkTime: ct, overall: all, byLevel: hist.stats?.[ct] } : null,
    note: 'Trend = where the price is now versus its 20-candle average and VWAP. It describes the present; it does not predict the rest of the day. "Kept going" = share of past cases (same time of day, same alignment) where the stock was further in that direction at 15:15. Close to 50% means a coin flip. Research only, not a recommendation.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const st = await buildStats();
    console.log(`History: ${st.stocks} stocks · ${st.sessions} sessions (${st.from} → ${st.to})`);
    const p = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    console.log('check  | strong            | partial           | weak              | all');
    for (const t of CHECK_TIMES) {
      const r = st.stats[t];
      const c = (x) => `${p(x.continued).padStart(4)} ${x.avgMovePct >= 0 ? '+' : ''}${(x.avgMovePct ?? 0).toFixed(2)}% n${String(x.n).padEnd(5)}`;
      console.log(`${t}  | ${c(r.strong)} | ${c(r.partial)} | ${c(r.weak)} | ${c(r.all)}`);
    }
    const s = await todayScan({ stats: st });
    console.log(`\nToday ${s.date} (candles to ${s.lastBar}) · NIFTY ${s.nifty.trend} · up ${s.counts.up} · down ${s.counts.down} · mixed ${s.counts.mixed}`);
    for (const x of s.stocks.slice(0, 15)) console.log(`  ${x.symbol.replace('.NS', '').padEnd(12)} ${x.trend.padEnd(5)} since ${x.since} · ${x.alignment.padEnd(7)} · change ${x.changePct?.toFixed(2)}% · kept going ${p(x.history?.continued)}${x.setup ? ` · SETUP ${x.setup.side} @${x.setup.entry.toFixed(1)}` : ''}`);
  })().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
