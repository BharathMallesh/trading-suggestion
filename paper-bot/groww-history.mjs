#!/usr/bin/env node
// Long intraday history from Groww's backtesting API (library + CLI, READ-ONLY): 5-minute candles from 2020 for the
// stocks the strategies use, in 30-day requests (Groww's limit for 1–5 minute candles), about 2 requests a second
// (faster is rate-limited), resumable — finished chunks are remembered, so a stopped run continues where it left off.
// Saved in a separate store (paper-bot/data/candles-hist/5m) in the same bar format as the live store, so the live
// screens stay fast and the research tests read the long history. Prices are as traded (not adjusted for splits /
// bonuses) — fine for same-day tests; skip a day with a corporate action. Needs a Groww Trading API subscription.
//
//   node paper-bot/groww-history.mjs                 # every stock in the live 5-minute store + NIFTY
//   node paper-bot/groww-history.mjs TCS.NS INFY.NS  # just these

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { accessToken, resetAccessToken } from '../groww-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.CANDLE_HIST_DIR || join(HERE, 'data', 'candles-hist');
const LIVE_5M = () => process.env.CANDLE_STORE ? join(process.env.CANDLE_STORE, '5m') : join(HERE, 'data', 'candles', '5m');
export const HIST = { from: '2020-01-01', chunkDays: 29, delayMs: 550, interval: '5minute' };

const fileOf = (symbol) => join(DIR(), '5m', `${symbol.replace(/[^A-Za-z0-9.&^-]/g, '_')}.json.gz`);
const stateFile = () => join(DIR(), 'state.json');
const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
};
const writeAtomic = (f, buf) => {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, f);
};

/**
 * Drop whole stock-days with impossible bars: a bar 25% or more away from that day's middle close, high below low,
 * or a non-positive price. (Groww's file had one such day, 12 May 2025, with prices about 100× too high.)
 */
export function cleanBars(bars) {
  const byDay = new Map();
  for (const b of bars) {
    const d = b.date.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  const out = [];
  for (const bs of byDay.values()) {
    const cl = bs.map((b) => b.close).sort((a, b) => a - b);
    const med = cl[cl.length >> 1];
    if (bs.some((b) => !(b.open > 0 && b.low > 0) || b.high < b.low || b.high / med > 1.25 || b.low / med < 0.75)) continue;
    out.push(...bs);
  }
  return out;
}

/** Saved long history for a symbol (bars oldest first, bad days removed; [] when none). */
export function readHist(symbol, { clean = true } = {}) {
  try {
    const bars = existsSync(fileOf(symbol)) ? JSON.parse(gunzipSync(readFileSync(fileOf(symbol))).toString('utf8')) : [];
    return clean ? cleanBars(bars) : bars;
  } catch {
    return [];
  }
}
/** Symbols with saved long history. */
export const histSymbols = () => (existsSync(join(DIR(), '5m')) ? readdirSync(join(DIR(), '5m')).filter((f) => f.endsWith('.json.gz')).map((f) => f.replace(/\.json\.gz$/, '')) : []);

/** App symbol → Groww symbol: "TCS.NS" → "NSE-TCS", "^NSEI" → "NSE-NIFTY". */
export const growwSymbol = (s) => (s === '^NSEI' ? 'NSE-NIFTY' : s === '^NSEBANK' ? 'NSE-BANKNIFTY' : `NSE-${s.replace(/\.NS$/, '')}`);

/** Groww candle [time, o, h, l, c, v, oi] → the store's bar { date: "YYYY-MM-DD HH:MM" (IST), ts, open, high, low, close, volume }. */
export function toBar(c) {
  const t = String(c[0]).replace('T', ' ').slice(0, 16);
  const ts = typeof c[0] === 'number' ? (c[0] > 1e12 ? Math.floor(c[0] / 1000) : c[0]) : Math.floor(Date.parse(`${t.replace(' ', 'T')}:00+05:30`) / 1000);
  const date = typeof c[0] === 'number' ? new Date((ts + 19800) * 1000).toISOString().slice(0, 16).replace('T', ' ') : t;
  return { date, ts, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0 };
}
/** Regular-session bars only (09:15 → 15:25 starts), as in the live store. */
export const inSession = (b) => b.date.slice(11) >= '09:15' && b.date.slice(11) <= '15:25' && b.close > 0;

/** The 30-day request windows from `from` to `to` (inclusive dates). */
export function chunks(from, to, days = HIST.chunkDays) {
  const out = [];
  for (let s = Date.parse(`${from}T00:00:00Z`); s <= Date.parse(`${to}T00:00:00Z`); s += (days + 1) * 86400000) {
    const a = new Date(s).toISOString().slice(0, 10);
    const b = new Date(Math.min(s + days * 86400000, Date.parse(`${to}T00:00:00Z`))).toISOString().slice(0, 10);
    out.push([a, b]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchChunk(gsym, a, b, { fetchFn = fetch, tries = 6 } = {}) {
  for (let k = 0; k < tries; k++) {
    const token = await accessToken();
    const qs = new URLSearchParams({ exchange: 'NSE', segment: 'CASH', groww_symbol: gsym, start_time: `${a} 09:15:00`, end_time: `${b} 15:30:00`, candle_interval: HIST.interval });
    let res;
    try {
      res = await fetchFn(`https://api.groww.in/v1/historical/candles?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-API-VERSION': '1.0' }, signal: AbortSignal.timeout(30000) });
    } catch {
      await sleep(3000 * (k + 1)); // network: wait and retry
      continue;
    }
    if (res.status === 429) {
      await sleep(5000 * (k + 1)); // rate-limited: back off
      continue;
    }
    if (res.status === 401) {
      resetAccessToken(); // the daily token expired (06:00 IST)
      continue;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 400 || res.status === 404) return { bars: [], missing: true }; // e.g. not listed in that period
    if (!res.ok) throw new Error(`Groww HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return { bars: (body?.payload?.candles || []).map(toBar).filter(inSession) };
  }
  throw new Error('Groww kept refusing (rate limit / network).');
}

/**
 * Download what is missing for each symbol, save after each symbol. Chunks that end before yesterday are remembered as
 * done; the latest chunk is fetched again next time. Returns a summary per symbol.
 */
export async function backfillHistory({ symbols, from = HIST.from, now = new Date(), delayMs = HIST.delayMs, fetchFn = fetch, onProgress = () => {} } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const state = readState();
  const report = [];
  for (const [i, symbol] of symbols.entries()) {
    const done = new Set(state[symbol]?.done || []);
    const todo = chunks(from, yesterday).filter(([a]) => !done.has(a));
    if (!todo.length) {
      report.push({ symbol, added: 0, skipped: true });
      continue;
    }
    let bars = readHist(symbol, { clean: false });
    const before = bars.length;
    let errors = 0;
    for (const [a, b] of todo) {
      try {
        const r = await fetchChunk(growwSymbol(symbol), a, b, { fetchFn });
        if (r.bars.length) {
          const byTs = new Map(bars.map((x) => [x.ts, x]));
          for (const x of r.bars) byTs.set(x.ts, x);
          bars = [...byTs.values()].sort((x, y) => x.ts - y.ts);
        }
        if (b < yesterday) done.add(a);
      } catch (err) {
        errors++;
        onProgress({ symbol, error: err.message });
      }
      await sleep(delayMs);
    }
    writeAtomic(fileOf(symbol), gzipSync(JSON.stringify(bars)));
    state[symbol] = { done: [...done].sort(), bars: bars.length, first: bars[0]?.date ?? null, last: bars.at(-1)?.date ?? null, updatedAt: now.toISOString() };
    writeAtomic(stateFile(), JSON.stringify(state));
    const row = { symbol, added: bars.length - before, bars: bars.length, first: state[symbol].first, last: state[symbol].last, errors };
    report.push(row);
    onProgress({ i: i + 1, of: symbols.length, ...row });
  }
  return report;
}

/** The default list: every stock in the live 5-minute store, plus NIFTY. */
export const defaultSymbols = () => {
  const live = existsSync(LIVE_5M()) ? readdirSync(LIVE_5M()).filter((f) => /\.NS\.json(\.gz)?$/.test(f)).map((f) => f.replace(/\.json(\.gz)?$/, '')) : [];
  return ['^NSEI', ...live.sort()];
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const syms = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const list = syms.length ? syms : defaultSymbols();
  const t0 = Date.now();
  console.log(`Groww 5-minute history from ${HIST.from}: ${list.length} symbols`);
  try {
    const rep = await backfillHistory({
      symbols: list,
      onProgress: (p) => {
        if (p.error) console.log(`  ${p.symbol}: ${p.error}`);
        else console.log(`  [${p.i}/${p.of}] ${p.symbol}: ${p.bars.toLocaleString('en-IN')} bars (${p.first} → ${p.last}), +${p.added.toLocaleString('en-IN')}${p.errors ? `, ${p.errors} chunk errors (retried next run)` : ''} · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      },
    });
    console.log(`Done: ${rep.filter((r) => !r.skipped).length} updated, ${rep.filter((r) => r.skipped).length} already complete, ${rep.reduce((a, r) => a + (r.errors || 0), 0)} chunk errors.`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
