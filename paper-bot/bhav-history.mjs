#!/usr/bin/env node
// Survivorship-free stock history (library + CLI) from NSE's own daily cash
// market files ("bhavcopy"), which list EVERY traded stock on each day —
// including companies that later collapsed, were suspended or delisted.
//
//   - Each session's file is downloaded once (2008 →) and only the rows for
//     stocks that were ever among the 300 most-traded are kept (EQ, BE and BZ
//     series, so a stock moved to trade-to-trade surveillance is not lost).
//     Stored per month, gzip-compressed, in paper-bot/data/bhav-eq/.
//   - Corporate actions (splits, bonuses) are undone with NSE's own adjusted
//     previous close: on an ex-date PREVCLOSE ≠ yesterday's close, and the
//     ratio rescales all earlier prices.
//   - The point-in-time universe for each month is the 200 most-traded stocks
//     (median daily traded value) of the PREVIOUS month — what you could have
//     known then — so stocks that later failed are included.
// Caveat: a company that changed its NSE symbol appears as two stocks.
//
//   node paper-bot/bhav-history.mjs            # download / continue (resumable; first run ≈ 1 hour)
//   node paper-bot/bhav-history.mjs --status

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { writeJsonAtomic } from '../util.mjs';

const run = promisify(execFile);
const DIR = () => process.env.BHAV_EQ_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data', 'bhav-eq');
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
export const TOP_KEEP = 300; // a stock is tracked from the first day it is among the 300 most traded
export const UNIVERSE = 200;
const SERIES = new Set(['EQ', 'BE', 'BZ']);

export class NseBlockedError extends Error {}

function urls(date) {
  const [y, m, d] = date.split('-');
  const neu = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
  const old = `https://nsearchives.nseindia.com/content/historical/EQUITIES/${y}/${MON[+m - 1]}/cm${d}${MON[+m - 1]}${y}bhav.csv.zip`;
  return date >= '2024-07-08' ? [neu, old] : [old, neu];
}

/** Parse either bhavcopy format → [{ sym, series, o, h, l, c, prev, val }]. */
export function parseCmBhav(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(',').map((x) => x.trim());
  const col = (n) => head.indexOf(n);
  const neu = col('TckrSymb') >= 0;
  const c = neu
    ? { sym: col('TckrSymb'), ser: col('SctySrs'), o: col('OpnPric'), h: col('HghPric'), l: col('LwPric'), c: col('ClsPric'), p: col('PrvsClsgPric'), v: col('TtlTrfVal') }
    : { sym: col('SYMBOL'), ser: col('SERIES'), o: col('OPEN'), h: col('HIGH'), l: col('LOW'), c: col('CLOSE'), p: col('PREVCLOSE'), v: col('TOTTRDVAL') };
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const series = (f[c.ser] || '').trim();
    if (!SERIES.has(series)) continue;
    const row = { sym: f[c.sym].trim(), series, o: +f[c.o], h: +f[c.h], l: +f[c.l], c: +f[c.c], prev: +f[c.p], val: +f[c.v] };
    if (row.c > 0 && row.h > 0 && row.l > 0 && row.o > 0) out.push(row);
  }
  return out;
}

/** One session's CSV text, { missing } for no file (holiday), or null for network trouble. */
export async function downloadCm(date, { fetchFn = fetch } = {}) {
  for (const url of urls(date)) {
    let res;
    let buf = null;
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(30000) });
        if (res.status === 403 || res.status === 429) throw new NseBlockedError('NSE is temporarily blocking downloads — run again later (progress is kept).');
        if (!res.ok) break;
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof NseBlockedError) throw err;
        buf = null;
      }
    }
    if (!res) return null;
    if (!res.ok) continue;
    if (!buf) return null;
    if (buf.slice(0, 2).toString() !== 'PK') continue;
    const tmp = join(tmpdir(), `cm-${date}-${process.pid}-${Math.random().toString(36).slice(2)}.zip`);
    writeFileSync(tmp, buf);
    try {
      const { stdout } = await run('unzip', ['-p', tmp], { maxBuffer: 200 * 1024 * 1024 });
      return { csv: stdout };
    } finally {
      unlinkSync(tmp);
    }
  }
  return { missing: true };
}

const monthFile = (ym) => join(DIR(), `${ym}.json.gz`);
const stateFile = () => join(DIR(), 'state.json');
export function loadState() {
  try {
    return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf8')) : { tracked: [], done: [], lastDate: null };
  } catch {
    return { tracked: [], done: [], lastDate: null };
  }
}
function readMonth(ym) {
  try {
    return existsSync(monthFile(ym)) ? JSON.parse(gunzipSync(readFileSync(monthFile(ym))).toString('utf8')) : {};
  } catch {
    return {};
  }
}
function writeMonth(ym, data) {
  mkdirSync(DIR(), { recursive: true });
  const tmp = `${monthFile(ym)}.tmp`;
  writeFileSync(tmp, gzipSync(JSON.stringify(data)));
  writeFileSync(monthFile(ym), readFileSync(tmp));
  unlinkSync(tmp);
}

/** Download every session from `from` (NIFTY's trading days) that isn't stored yet. Resumable. */
export async function buildBhavHistory({ from = '2008-01-01', loadCandles = candles, fetchFn = fetch, onProgress = () => {}, delayMs = 250, maxDays = Infinity } = {}) {
  const st = loadState();
  const tracked = new Set(st.tracked);
  const done = new Set(st.done);
  const days = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse(from) / 1000), interval: '1d' }))
    .filter((r) => r.close > 0).map((r) => r.date);
  const today = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const todo = days.filter((d) => !done.has(d) && d < today).slice(0, maxDays);
  let month = null;
  let data = null;
  let n = 0;
  const flush = () => {
    if (month) writeMonth(month, data);
    writeJsonAtomic(stateFile(), { tracked: [...tracked], done: [...done].sort(), lastDate: [...done].sort().pop() || null, updatedAt: new Date().toISOString() });
  };
  try {
    for (const d of todo) {
      const ym = d.slice(0, 7);
      if (ym !== month) {
        flush();
        month = ym;
        data = readMonth(ym);
      }
      const got = await downloadCm(d, { fetchFn });
      if (got === null) continue; // network trouble: picked up next run
      if (got.csv) {
        const rows = parseCmBhav(got.csv);
        for (const r of [...rows].sort((a, b) => b.val - a.val).slice(0, TOP_KEEP)) tracked.add(r.sym);
        data[d] = rows.filter((r) => tracked.has(r.sym)).map((r) => [r.sym, r.o, r.h, r.l, r.c, r.prev, Math.round(r.val)]);
      }
      done.add(d);
      onProgress(++n, todo.length, d);
      if (n % 20 === 0) flush();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  } finally {
    flush();
  }
  return { downloaded: n, remaining: todo.length - n, tracked: tracked.size, lastDate: [...done].sort().pop() || null };
}

/**
 * Adjusted daily series per symbol: Map(sym → [{date, open, high, low, close, val}]).
 * On a corporate-action ex-date NSE's PREVCLOSE differs from the previous close;
 * every earlier price is multiplied by PREVCLOSE / previous close.
 */
export function loadSeries({ months = null } = {}) {
  const dir = DIR();
  if (!existsSync(dir)) return new Map();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort();
  const raw = new Map();
  for (const f of files) {
    const ym = f.slice(0, 7);
    if (months && !months.includes(ym)) continue;
    const m = readMonth(ym);
    for (const d of Object.keys(m).sort()) {
      for (const [sym, o, h, l, c, prev, val] of m[d]) {
        if (!raw.has(sym)) raw.set(sym, []);
        raw.get(sym).push({ date: d, open: o, high: h, low: l, close: c, prev, val });
      }
    }
  }
  for (const [sym, rows] of raw) raw.set(sym, adjust(rows));
  return raw;
}

/** Undo splits / bonuses using NSE's adjusted previous close (only clear corporate actions: ≥ 5% gap between the two). */
export function adjust(rows) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = out.length - 1; i > 0; i--) {
    const f = out[i].prev > 0 ? out[i].prev / out[i - 1].close : 1;
    if (f > 0 && Math.abs(Math.log(f)) > Math.log(1.05)) {
      for (let j = 0; j < i; j++) {
        out[j].open *= f;
        out[j].high *= f;
        out[j].low *= f;
        out[j].close *= f;
      }
    }
  }
  return out.map(({ prev, ...r }) => r);
}

/**
 * Point-in-time universe: month → Set of the `size` most-traded stocks by
 * median daily traded value over the PREVIOUS calendar month (≥ 15 sessions).
 */
export function pointInTimeUniverse(series, size = UNIVERSE) {
  const byMonth = new Map(); // ym → [{sym, vals}]
  for (const [sym, rows] of series) {
    const per = new Map();
    for (const r of rows) {
      const ym = r.date.slice(0, 7);
      if (!per.has(ym)) per.set(ym, []);
      per.get(ym).push(r.val);
    }
    for (const [ym, vals] of per) {
      if (vals.length < 15) continue;
      const s = [...vals].sort((a, b) => a - b);
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push({ sym, med: s[s.length >> 1] });
    }
  }
  const months = [...byMonth.keys()].sort();
  const out = new Map();
  for (let k = 1; k < months.length; k++) {
    const prev = byMonth.get(months[k - 1]).sort((a, b) => b.med - a.med).slice(0, size);
    out.set(months[k], new Set(prev.map((x) => x.sym)));
  }
  // the month after the last stored one (for live use)
  if (months.length) {
    const [y, m] = months[months.length - 1].split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    out.set(next, new Set(byMonth.get(months[months.length - 1]).sort((a, b) => b.med - a.med).slice(0, size).map((x) => x.sym)));
  }
  return out;
}

export function bhavStatus() {
  const st = loadState();
  return { sessions: st.done.length, first: st.done[0] || null, last: st.lastDate, tracked: st.tracked.length, updatedAt: st.updatedAt || null };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--status')) {
    console.log(bhavStatus());
  } else {
    let last = 0;
    buildBhavHistory({
      onProgress: (i, n, d) => {
        if (Date.now() - last > 10000 || i === n) {
          last = Date.now();
          console.log(`  ${i}/${n} sessions · ${d}`);
        }
      },
    })
      .then((r) => console.log(`Done: +${r.downloaded} sessions · ${r.remaining} left · ${r.tracked} stocks tracked · up to ${r.lastDate}`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
