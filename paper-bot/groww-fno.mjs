// Groww F&O history (library, READ-ONLY): expiries, contract lists and 5-minute option candles from the Groww
// backtesting API (2020 →), cached on disk (paper-bot/data/fo-hist) so a test re-runs without downloading again.
// One request about every 0.55 s (faster is rate-limited); retries after 429 / network errors; renews the daily token.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, resetAccessToken } from '../groww-data.mjs';
import { toBar, inSession } from './groww-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.FO_HIST_DIR || join(HERE, 'data', 'fo-hist');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
export const PACE_MS = 550;

const save = (f, obj, gz = false) => {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, gz ? gzipSync(JSON.stringify(obj)) : JSON.stringify(obj));
  renameSync(tmp, f);
};
const load = (f, gz = false) => {
  try {
    return existsSync(f) ? JSON.parse(gz ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
};

/** A paced GET to the Groww API (JSON payload, or null for "no data"). */
export async function growwGet(path, params, { fetchFn = fetch, tries = 6 } = {}) {
  for (let k = 0; k < tries; k++) {
    const wait = last + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const token = await accessToken();
    let res;
    try {
      res = await fetchFn(`https://api.groww.in${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-API-VERSION': '1.0' }, signal: AbortSignal.timeout(30000) });
    } catch {
      await sleep(3000 * (k + 1));
      continue;
    }
    if (res.status === 429) {
      await sleep(5000 * (k + 1));
      continue;
    }
    if (res.status === 401) {
      resetAccessToken();
      continue;
    }
    if (res.status === 400 || res.status === 404) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Groww HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body?.payload ?? null;
  }
  throw new Error('Groww kept refusing (rate limit / network).');
}

/** Every expiry of an underlying in a year (cached). */
export async function expiries(underlying, year, opts) {
  const f = join(DIR(), 'expiries', `${underlying}-${year}.json`);
  const cached = load(f);
  const thisYear = String(new Date().getUTCFullYear());
  if (cached && String(year) !== thisYear) return cached;
  const p = await growwGet('/v1/historical/expiries', { exchange: 'NSE', underlying_symbol: underlying, year: String(year) }, opts);
  const out = (p?.expiries || []).sort();
  save(f, out);
  return out;
}

/** Contracts of one expiry → { strike: { CE: groww symbol, PE: … } } (cached). */
export async function contracts(underlying, expiry, opts) {
  const f = join(DIR(), 'contracts', `${underlying}-${expiry}.json`);
  let list = load(f);
  if (!list) {
    list = (await growwGet('/v1/historical/contracts', { exchange: 'NSE', underlying_symbol: underlying, expiry_date: expiry }, opts))?.contracts || [];
    save(f, list);
  }
  const out = {};
  for (const s of list) {
    const m = s.match(/-(\d+(?:\.\d+)?)-(CE|PE)$/);
    if (m) (out[Number(m[1])] ||= {})[m[2]] = s;
  }
  return out;
}

/** Groww option symbol, e.g. NSE-NIFTY-02Jun22-16500-CE. */
export const optionSymbol = (underlying, expiry, strike, type) => {
  const [y, m, d] = expiry.split('-');
  return `NSE-${underlying}-${d}${MON[Number(m) - 1]}${y.slice(2)}-${strike}-${type}`;
};

/** 5-minute candles of one F&O contract between two dates (inclusive; cached per contract + range). */
export async function fnoCandles(gsym, from, to, opts) {
  const f = join(DIR(), 'candles', `${gsym}_${from}_${to}.json.gz`);
  const cached = load(f, true);
  if (cached) return cached;
  const p = await growwGet('/v1/historical/candles', { exchange: 'NSE', segment: 'FNO', groww_symbol: gsym, start_time: `${from} 09:15:00`, end_time: `${to} 15:30:00`, candle_interval: '5minute' }, opts);
  const bars = (p?.candles || []).map(toBar).filter(inSession);
  save(f, bars, true);
  return bars;
}
