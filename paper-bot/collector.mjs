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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { candles } from '../market-data.mjs';
import { daySession } from '../groww-data.mjs';
import { mapLimit } from '../util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.CANDLE_STORE || join(__dir, 'data', 'candles');
export const STORED_INTERVALS = ['5m', '15m'];
const BAR_SECS = { '5m': 300, '15m': 900 };

const fileFor = (interval, symbol) => join(STORE, interval, `${symbol.replace(/[^A-Za-z0-9.&^-]/g, '_')}.json`);

export function readStore(symbol, interval) {
  try {
    const f = fileFor(interval, symbol);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
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
  writeFileSync(f, JSON.stringify(rows));
}

/** Only completed bars are stored (a live bar would be overwritten later anyway). */
const completed = (rows, interval, now = Date.now()) => rows.filter((b) => (b.ts + BAR_SECS[interval]) * 1000 <= now);

/**
 * Fetch recent bars and merge them into the store.
 * @returns {Promise<{symbol, interval, before, after, added}[]>}
 */
export async function collect({ symbols, intervals = STORED_INTERVALS, loadCandles = candles, now = Date.now() } = {}) {
  const jobs = symbols.flatMap((s) => intervals.map((i) => [s, i]));
  return mapLimit(jobs, 3, async ([symbol, interval]) => {
    const before = readStore(symbol, interval);
    try {
      const fresh = completed(await loadCandles(symbol, { range: '1mo', interval }), interval, now);
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
  for (let d = 1; dates.length < days && d < days * 2; d++) {
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
          if (/GROWW_ACCESS_TOKEN|401|403/.test(err.message)) throw err; // no point continuing
        }
      }
      const merged = mergeBars(got, before); // keep Yahoo bars where both exist
      writeStore(symbol, interval, merged);
      report.push({ symbol, interval, before: before.length, after: merged.length, added: merged.length - before.length, errors });
    }
  }
  return report;
}

/** Summary of what is stored: bars + first/last date per file. */
export function storeStatus() {
  const out = [];
  for (const interval of STORED_INTERVALS) {
    const dir = join(STORE, interval);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const rows = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!rows.length) continue;
      const days = new Set(rows.map((r) => String(r.date).slice(0, 10))).size;
      out.push({ interval, symbol: f.replace(/\.json$/, ''), bars: rows.length, days, from: rows[0].date, to: rows[rows.length - 1].date });
    }
  }
  return out;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  await import('./settings.mjs');
  const { PAPER, EVAL_UNIVERSE } = await import('./config.mjs');
  const symbols = [...new Set([...EVAL_UNIVERSE, ...PAPER.symbols, '^NSEI', '^INDIAVIX'])];
  try {
    if (args.includes('--status')) {
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
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
