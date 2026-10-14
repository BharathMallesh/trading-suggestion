#!/usr/bin/env node
// Intraday history collector (library + CLI).
//
// Yahoo serves only ~1 month of 5-min / 15-min bars, which is the biggest
// weakness of the intraday evaluations. Run this once a day after the close
// and the local store grows by a day each time (stored under
// paper-bot/data/candles/<interval>/<SYMBOL>.json, de-duplicated by
// timestamp, in-progress bars excluded). The replay harness merges the store
// with fresh data automatically.
//
// Optional: with GROWW_ACCESS_TOKEN set, --groww-backfill N pulls the last N
// weekdays of bars from Groww's read-only historical API (longer history).
//
//   node paper-bot/collector.mjs                       # collect today
//   node paper-bot/collector.mjs --groww-backfill 120  # optional backfill
//   node paper-bot/collector.mjs --status              # what is stored

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { gzipSync, gunzipSync } from 'zlib';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { candles } from '../market-data.mjs';
import { daySession } from '../groww-data.mjs';
import { mapLimit } from '../util.mjs';
import { tradingDaysBetween } from './market-calendar.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.CANDLE_STORE || join(__dir, 'data', 'candles');
export const STORED_INTERVALS = ['5m', '15m'];
const BAR_SECS = { '5m': 300, '15m': 900 };

// Stored gzip-compressed (≈40× smaller); plain .json files from before are still read and replaced on the next write.
const baseFor = (interval, symbol) => join(STORE, interval, symbol.replace(/[^A-Za-z0-9.&^-]/g, '_'));
const fileFor = (interval, symbol) => `${baseFor(interval, symbol)}.json.gz`;
const symOf = (f) => f.replace(/\.json(\.gz)?$/, '');

export function readStore(symbol, interval) {
  try {
    const gz = fileFor(interval, symbol);
    if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'));
    const plain = `${baseFor(interval, symbol)}.json`;
    return existsSync(plain) ? JSON.parse(readFileSync(plain, 'utf8')) : [];
  } catch {
    return [];
  }
}

/** Merge bar lists by timestamp (later source wins), oldest first. */
export function mergeBars(...lists) {
  const byTs = new Map();
  for (const list of lists) for (const b of list || []) if (b && b.ts != null) byTs.set(b.ts, b);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function writeStore(symbol, interval, rows) {
  const f = fileFor(interval, symbol);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, gzipSync(JSON.stringify(rows)));
  renameSync(tmp, f);
  const plain = `${baseFor(interval, symbol)}.json`;
  if (existsSync(plain)) unlinkSync(plain); // replaced by the compressed file
}

/** Compress any plain .json store files left from before (one-off, safe to repeat). */
export function compressStore() {
  let n = 0;
  for (const interval of STORED_INTERVALS) {
    const dir = join(STORE, interval);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const sym = symOf(f);
      writeStore(sym, interval, JSON.parse(readFileSync(join(dir, f), 'utf8')));
      n++;
    }
  }
  return n;
}

/** Only completed bars are stored (a live bar would be overwritten later anyway). */
const completed = (rows, interval, now = Date.now()) => rows.filter((b) => (b.ts + BAR_SECS[interval]) * 1000 <= now);

/**
 * Fetch recent bars and merge them into the store.
 * @returns {Promise<{symbol, interval, before, after, added}[]>}
 */
export async function collect({ symbols, intervals = STORED_INTERVALS, loadCandles = candles, now = Date.now(), retryDelayMs = 5000 } = {}) {
  const jobs = symbols.flatMap((s) => intervals.map((i) => [s, i]));
  const first = await collectJobs(jobs, loadCandles, now);
  // one retry for failures (timeouts happen when Yahoo is busy right after the close)
  const failed = first.filter((r) => r.error);
  if (!failed.length) return first;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  const again = new Map((await collectJobs(failed.map((r) => [r.symbol, r.interval]), loadCandles, now)).map((r) => [`${r.symbol}|${r.interval}`, r]));
  return first.map((r) => (r.error ? again.get(`${r.symbol}|${r.interval}`) || r : r));
}

function collectJobs(jobs, loadCandles, now) {
  return mapLimit(jobs, 3, async ([symbol, interval]) => {
    const before = readStore(symbol, interval);
    try {
      const fresh = completed(await loadCandles(symbol, { period1: Math.floor(now / 1000) - 58 * 86400, interval }), interval, now) // Yahoo keeps ~60 days of 5m/15m: the first run fills them all;
      const merged = mergeBars(before, fresh);
      writeStore(symbol, interval, merged);
      return { symbol, interval, before: before.length, after: merged.length, added: merged.length - before.length };
    } catch (err) {
      return { symbol, interval, before: before.length, after: before.length, added: 0, error: err.message.slice(0, 80) };
    }
  });
}

/**
 * Candles for the replay harness: stored history ∪ fresh Yahoo bars for the
 * stored intervals; plain Yahoo otherwise.
 */
export async function historyCandles(symbol, opts = {}, loadCandles = candles) {
  const fresh = await loadCandles(symbol, opts);
  if (!STORED_INTERVALS.includes(opts.interval)) return fresh;
  return mergeBars(readStore(symbol, opts.interval), fresh);
}

/** Groww time "YYYY-MM-DD HH:MM" (IST) → epoch seconds. */
const growwTs = (t) => Math.floor(Date.parse(`${t.replace(' ', 'T')}:00+05:30`) / 1000);

/**
 * Backfill the last `days` weekdays from Groww (needs GROWW_ACCESS_TOKEN).
 * Rows are converted to the same shape as Yahoo bars (date label + ts).
 */
export async function backfillGroww({ symbols, days = 60, intervals = STORED_INTERVALS, session = daySession, today = new Date() } = {}) {
  const dates = [];
  for (let d = 1; dates.length < days && d < days * 2 + 7; d++) { // +7: a weekend (e.g. run on a Monday) must not empty the window
    const dt = new Date(today.getTime() - d * 86400000);
    const wd = dt.getUTCDay();
    if (wd >= 1 && wd <= 5) dates.push(dt.toISOString().slice(0, 10));
  }
  const report = [];
  for (const symbol of symbols.filter((s) => /\.(NS|BO)$/i.test(s))) {
    const growwSym = symbol.replace(/\.(NS|BO)$/i, '');
    for (const interval of intervals) {
      const mins = parseInt(interval, 10);
      const before = readStore(symbol, interval);
      const got = [];
      let errors = 0;
      for (const date of dates) {
        try {
          const rows = await session(growwSym, date, { intervalMinutes: mins });
          for (const r of rows) got.push({ date: r.time, ts: growwTs(r.time), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
        } catch (err) {
          errors++;
          if (/GROWW_ACCESS_TOKEN|Groww is not configured|token request failed|401|403/.test(err.message)) throw err; // no point continuing
        }
      }
      const merged = mergeBars(got, before); // keep Yahoo bars where both exist
      writeStore(symbol, interval, merged);
      report.push({ symbol, interval, before: before.length, after: merged.length, added: merged.length - before.length, errors });
    }
  }
  return report;
}

/**
 * Gaps in the saved 5-minute history: series that stopped before `want` (the
 * last full session), sessions NIFTY has but a stock is missing, and NSE
 * trading days (exchange calendar) with no NIFTY bars at all. Returns
 * plain-language issues; [] when all is well.
 */
export function storeGaps(want, interval = '5m') {
  const dir = join(STORE, interval);
  if (!existsSync(dir)) return [];
  const daysOf = (rows) => new Set(rows.map((r) => String(r.date).slice(0, 10)));
  const ref = [...daysOf(readStore('^NSEI', interval))].sort();
  const issues = [];
  if (ref.length) {
    // NSE trading days (holidays skipped) with no NIFTY bars saved = missed collections
    const missed = tradingDaysBetween(ref[0], ref[ref.length - 1]).filter((d) => !ref.includes(d));
    if (missed.length) issues.push(`no ${interval} bars saved for ${missed.length} trading day${missed.length > 1 ? 's' : ''} (${missed.slice(0, 4).join(', ')}${missed.length > 4 ? '…' : ''}) — collection missed; Yahoo keeps ~60 days, so older gaps can't be refilled`);
  }
  const stale = [];
  const holes = [];
  for (const f of readdirSync(dir).filter((x) => /\.json(\.gz)?$/.test(x))) {
    const sym = symOf(f);
    const days = daysOf(readStore(sym, interval));
    if (!days.size) continue;
    const sorted = [...days].sort();
    if (want && sorted[sorted.length - 1] < want) stale.push(`${sym} (last ${sorted[sorted.length - 1]})`);
    const missing = ref.filter((d) => d >= sorted[0] && d <= sorted[sorted.length - 1] && !days.has(d)); // after its last day = stale (above)
    if (missing.length) holes.push(`${sym} missing ${missing.length} day${missing.length > 1 ? 's' : ''} (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''})`);
  }
  if (stale.length) issues.push(`not updated since the last session: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''}`);
  if (holes.length) issues.push(`days missing vs NIFTY: ${holes.slice(0, 5).join('; ')}${holes.length > 5 ? ` and ${holes.length - 5} more` : ''}`);
  return issues;
}

/** Summary of what is stored: bars + first/last date per file. */
export function storeStatus() {
  const out = [];
  for (const interval of STORED_INTERVALS) {
    const dir = join(STORE, interval);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.json(\.gz)?$/.test(x))) {
      const rows = readStore(symOf(f), interval);
      if (!rows.length) continue;
      const days = new Set(rows.map((r) => String(r.date).slice(0, 10))).size;
      out.push({ interval, symbol: symOf(f), bars: rows.length, days, from: rows[0].date, to: rows[rows.length - 1].date });
    }
  }
  return out;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  await import('./settings.mjs');
  const { PAPER, EVAL_UNIVERSE, VIDEO_STOCKS } = await import('./config.mjs');
  // NIFTY 200 (breakfast strategy's sector scan; includes the NIFTY 50) — 5-minute history grows daily
  let nifty50 = [];
  for (const f of ['index-nifty200.json', 'index-nifty50.json']) {
    try {
      const idx = JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8'));
      nifty50 = [...nifty50, ...(idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`))];
    } catch {
      /* list not downloaded yet */
    }
  }
  const symbols = [...new Set([...EVAL_UNIVERSE, ...PAPER.symbols, ...VIDEO_STOCKS, ...nifty50, '^NSEI', '^INDIAVIX'])];
  try {
    if (args.includes('--compress')) {
      console.log(`Compressed ${compressStore()} files.`);
    } else if (args.includes('--status')) {
      const st = storeStatus();
      if (!st.length) console.log('Store is empty — run without flags after the close.');
      for (const s of st) console.log(`${s.interval.padEnd(4)} ${s.symbol.padEnd(16)} ${String(s.bars).padStart(6)} bars · ${s.days} days · ${s.from} → ${s.to}`);
    } else if (args.includes('--groww-backfill')) {
      const days = Number(args[args.indexOf('--groww-backfill') + 1]) || 60;
      const rep = await backfillGroww({ symbols, days });
      for (const r of rep) console.log(`${r.interval.padEnd(4)} ${r.symbol.padEnd(16)} +${r.added} bars (now ${r.after})${r.errors ? ` · ${r.errors} days failed` : ''}`);
    } else {
      const rep = await collect({ symbols });
      const added = rep.reduce((a, r) => a + r.added, 0);
      const failed = rep.filter((r) => r.error);
      console.log(`Collected ${rep.length} series · +${added} new bars · ${failed.length} failed`);
      for (const r of failed) console.log(`  ${r.symbol} ${r.interval}: ${r.error}`);
      const st = storeStatus();
      const days = Math.max(0, ...st.map((s) => s.days));
      console.log(`Store: ${st.length} series, up to ${days} trading days of intraday history.`);
      // (market-calendar, not health.mjs: health imports this file, and a cycle with the running script deadlocks)
      const { lastSessionDate } = await import('./market-calendar.mjs');
      const gaps = storeGaps(lastSessionDate());
      for (const g of gaps) console.log(`  GAP: ${g}`);
      if ((gaps.length || failed.length) && args.includes('--notify')) {
        // macOS notification directly (monitor.mjs also imports this file through health.mjs)
        const { execFile } = await import('child_process');
        const notify = (title, message) => execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message.slice(0, 220)], () => {});
        notify('Trading research · 5-minute history has gaps', [...(failed.length ? [`${failed.length} series failed to download`] : []), ...gaps].join(' · '));
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
