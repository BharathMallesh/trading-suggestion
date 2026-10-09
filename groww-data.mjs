// READ-ONLY Groww market-data client (candles). Optional alternative source to
// market-data.mjs (Yahoo). Zero dependencies, built-in fetch (Node 18+).
//
// SCOPE — read this:
// - This file fetches HISTORICAL CANDLES ONLY. It deliberately contains NO
//   endpoints for orders, positions, holdings, margins, or fund movement. It
//   reads a market through Groww's data API; it never trades on the account.
// - Credentials come from the environment, filled from the macOS Keychain by
//   scripts/run.sh — never hard-coded, never logged, never written to disk:
//     GROWW_ACCESS_TOKEN                 a ready daily token, or
//     GROWW_API_KEY + GROWW_API_SECRET   exchanged for a daily token on demand
//       (POST /v1/token/api/access, checksum = SHA-256(secret + epoch seconds)),
//       kept in memory only and refreshed when it expires (06:00 IST daily).
//
// Endpoint/response shapes follow Groww's published API and may need a small
// tweak for your account/version. Base URL and API version are overridable via
// env so you can adjust without editing code:
//   GROWW_BASE_URL      (default https://api.groww.in)
//   GROWW_API_VERSION   (default 1.0)

import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { HttpError, badRequest } from './util.mjs';

const BASE = process.env.GROWW_BASE_URL || 'https://api.groww.in';
const API_VERSION = process.env.GROWW_API_VERSION || '1.0';
const TOKEN_ENV = 'GROWW_ACCESS_TOKEN';

let cached = null; // { token, expiresAt } — memory only

/** Next 06:00 IST after `now` (Groww access tokens expire daily then). */
function next6amIst(now = Date.now()) {
  const ist = new Date(now + 19800_000);
  let t = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0) - 19800_000;
  if (t <= now) t += 86400000;
  return t;
}

/** True when Groww credentials of either kind are configured. */
export function growwConfigured() {
  return Boolean(process.env[TOKEN_ENV] || (process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET));
}

// Breaker: after Groww refuses data access (403), stop calling it for 6 hours
// (callers fall back to Yahoo); the health check reports the reason.
let blocked = null; // { until, reason }
export function growwStatus(now = Date.now()) {
  if (!growwConfigured()) return { state: 'off', detail: 'not configured' };
  if (blocked && blocked.until > now) return { state: 'blocked', detail: blocked.reason, until: new Date(blocked.until).toISOString() };
  return { state: 'ok', detail: cached ? 'token active' : 'configured' };
}
/** Configured and not currently refusing us. */
export function growwUsable(now = Date.now()) {
  return growwStatus(now).state === 'ok';
}
function noteRefusal(status, body) {
  if (status === 401 || status === 403) {
    blocked = {
      until: Date.now() + 6 * 3600000,
      reason: `Groww refused data access (HTTP ${status}${/required roles|forbidden/i.test(body) ? ': no data permission' : ''}). Groww requires an active Trading API subscription, and keys using API key + secret need daily approval on the Groww Cloud API Keys page. Using Yahoo meanwhile.`,
    };
    if (status === 401) cached = null;
  }
}

/** Exchange the API key + secret for a daily access token (cached in memory). */
export async function accessToken({ fetchFn = fetch, now = Date.now() } = {}) {
  if (process.env[TOKEN_ENV]) return process.env[TOKEN_ENV];
  const key = process.env.GROWW_API_KEY;
  const secret = process.env.GROWW_API_SECRET;
  if (!key || !secret) {
    throw new HttpError(503, 'Groww is not configured. Store your API key and secret in the Keychain (services trading-research-groww-key / trading-research-groww-secret) and restart the server.');
  }
  if (cached && cached.expiresAt - 60000 > now) return cached.token;
  const timestamp = String(Math.floor(now / 1000));
  const checksum = createHash('sha256').update(secret + timestamp).digest('hex');
  const res = await fetchFn(`${BASE}/v1/token/api/access`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ key_type: 'approval', checksum, timestamp }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.token || body?.payload?.token || body?.access_token;
  if (!res.ok || !token) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new HttpError(503, `Groww token request failed (${msg}). If Groww asks for daily approval, approve the API key on the Groww Cloud API Keys page, then retry.`);
  }
  const exp = Date.parse(body?.expiry || body?.payload?.expiry || '') || next6amIst(now);
  cached = { token, expiresAt: exp };
  return token;
}

/** Drop the cached token (e.g. after a 401). */
export function resetAccessToken() {
  cached = null;
}

async function authHeaders() {
  const token = await accessToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-API-VERSION': API_VERSION,
  };
}

/**
 * Fetch historical candles for one instrument from Groww (READ-ONLY).
 * @param {object} p
 * @param {string} p.symbol            trading symbol, e.g. "HDFCBANK"
 * @param {string} [p.exchange="NSE"]  NSE | BSE
 * @param {string} [p.segment="CASH"]  CASH | FNO
 * @param {string|number} p.startTime  "YYYY-MM-DD HH:mm:ss" (IST) or epoch ms
 * @param {string|number} p.endTime    "YYYY-MM-DD HH:mm:ss" (IST) or epoch ms
 * @param {number} [p.intervalMinutes=1]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{time:string,hhmm:string,open:number,high:number,low:number,close:number,volume:number}[]>}
 */
export async function historicalCandles(p = {}) {
  const {
    symbol,
    exchange = 'NSE',
    segment = 'CASH',
    startTime,
    endTime,
    intervalMinutes = 1,
    signal,
  } = p;
  if (!symbol) throw badRequest('A trading symbol is required, e.g. "HDFCBANK".');
  if (!startTime || !endTime) throw badRequest('startTime and endTime are required.');

  const qs = new URLSearchParams({
    exchange,
    segment,
    trading_symbol: symbol,
    start_time: String(startTime),
    end_time: String(endTime),
    interval_in_minutes: String(intervalMinutes),
  });
  const url = `${BASE}/v1/historical/candle/range?${qs.toString()}`;

  const res = await fetch(url, { headers: await authHeaders(), signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    noteRefusal(res.status, body);
    throw new HttpError(502, `Groww HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Groww returns candles as arrays: [epochSeconds, open, high, low, close, volume].
  const raw = data?.payload?.candles ?? data?.candles ?? [];
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected Groww response shape: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const IST_OFFSET = 19800; // seconds (+5:30) for HH:MM display
  return raw
    .filter((c) => Array.isArray(c) && c[1] != null && c[4] != null)
    .map((c) => {
      const [ts, open, high, low, close, volume] = c;
      // Groww epochs are typically seconds; guard for ms just in case.
      const secs = ts > 1e12 ? Math.floor(ts / 1000) : ts;
      const d = new Date((secs + IST_OFFSET) * 1000);
      return {
        time: d.toISOString().slice(0, 16).replace('T', ' '),
        hhmm: d.toISOString().slice(11, 16),
        open,
        high,
        low,
        close,
        volume: volume ?? null,
      };
    });
}

/**
 * Default monthly expiry for NSE stock options: the last Tuesday of the month
 * (NSE's expiry day since Sept 2025); if that has passed, next month's.
 * Exchange calendars change — pass an explicit expiry when in doubt.
 */
export function defaultMonthlyExpiry(now = new Date()) {
  const ist = new Date(now.getTime() + 19800_000);
  for (let add = 0; add < 2; add++) {
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth() + add;
    const last = new Date(Date.UTC(y, m + 1, 0));
    while (last.getUTCDay() !== 2) last.setUTCDate(last.getUTCDate() - 1);
    const iso = last.toISOString().slice(0, 10);
    if (iso >= ist.toISOString().slice(0, 10)) return iso;
  }
  return null;
}

/**
 * Option chain (READ-ONLY) from Groww: ATM implied volatility and the
 * put/call open-interest ratio. Endpoint per Groww Trade API docs:
 * GET /v1/option-chain/exchange/{exchange}/underlying/{underlying}?expiry_date=YYYY-MM-DD
 * @returns {Promise<{underlying:string, expiry:string, spot:number, atmStrike:number, atmIvPct:number|null, pcr:number|null, strikes:number}>}
 */
export async function optionChain({ underlying, expiry, exchange = 'NSE', signal } = {}) {
  const u = String(underlying || '').trim().toUpperCase().replace(/\.(NS|BO)$/, '');
  if (!u) throw badRequest('An underlying is required, e.g. "TCS" or "NIFTY".');
  const exp = expiry || defaultMonthlyExpiry();
  if (!/^\d{4}-\d\d-\d\d$/.test(String(exp))) throw badRequest('Pass the expiry as YYYY-MM-DD.');
  const url = `${BASE}/v1/option-chain/exchange/${encodeURIComponent(exchange)}/underlying/${encodeURIComponent(u)}?expiry_date=${exp}`;
  const res = await fetch(url, { headers: await authHeaders(), signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    noteRefusal(res.status, body);
    throw new HttpError(502, `Groww option chain HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return summarizeChain(data?.payload ?? data, { underlying: u, expiry: exp });
}

/** ATM IV (average of CE/PE at the strike nearest spot) and OI put/call ratio. */
export function summarizeChain(payload, meta = {}) {
  const spot = Number(payload?.underlying_ltp);
  const strikes = payload?.strikes && typeof payload.strikes === 'object' ? payload.strikes : {};
  const keys = Object.keys(strikes).map(Number).filter(Number.isFinite);
  if (!keys.length || !(spot > 0)) throw new HttpError(502, 'Groww option chain: unexpected response (no strikes / spot).');
  const atm = keys.reduce((a, k) => (Math.abs(k - spot) < Math.abs(a - spot) ? k : a), keys[0]);
  const leg = strikes[String(atm)] || strikes[atm] || {};
  // Groww may report IV as a fraction (0.22) or a percentage (22).
  const ivPct = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x) < 3 ? Number(x) * 100 : Number(x));
  const ivs = [ivPct(leg.CE?.greeks?.iv), ivPct(leg.PE?.greeks?.iv)].filter((v) => v != null && v > 0);
  let ceOi = 0;
  let peOi = 0;
  for (const k of keys) {
    const s = strikes[String(k)] || strikes[k] || {};
    ceOi += Number(s.CE?.open_interest) || 0;
    peOi += Number(s.PE?.open_interest) || 0;
  }
  return {
    underlying: meta.underlying,
    expiry: meta.expiry,
    spot,
    atmStrike: atm,
    atmIvPct: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    pcr: ceOi ? peOi / ceOi : null,
    strikes: keys.length,
  };
}

/** Convenience: one full NSE session (09:15–15:30 IST) for a date. */
export async function daySession(symbol, dateStr, opts = {}) {
  const ds = String(dateStr || '');
  // Format check plus a round-trip so impossible dates (2026-13-45) are rejected.
  const valid = /^\d{4}-\d\d-\d\d$/.test(ds) && !Number.isNaN(Date.parse(ds + 'T00:00:00Z')) &&
    new Date(ds + 'T00:00:00Z').toISOString().slice(0, 10) === ds;
  if (!valid) throw badRequest('Pass a real date as YYYY-MM-DD, e.g. 2026-09-29.');
  return historicalCandles({
    symbol,
    exchange: opts.exchange || 'NSE',
    segment: opts.segment || 'CASH',
    startTime: `${dateStr} 09:15:00`,
    endTime: `${dateStr} 15:30:00`,
    intervalMinutes: opts.intervalMinutes || 1,
    signal: opts.signal,
  });
}

// CLI (run this yourself with GROWW_ACCESS_TOKEN set):
//   node groww-data.mjs HDFCBANK 2026-09-29 1
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [symbol, date, mins] = process.argv.slice(2);
  if (!symbol || !date) {
    console.error('Usage: node groww-data.mjs <SYMBOL> <YYYY-MM-DD> [intervalMinutes]');
    console.error('  requires: export GROWW_ACCESS_TOKEN="<your token>"');
    console.error('  e.g. node groww-data.mjs HDFCBANK 2026-09-29 1');
    process.exit(1);
  }
  daySession(symbol, date, { intervalMinutes: Number(mins) || 1 })
    .then((rows) => {
      console.log(`${symbol} ${date} — ${rows.length} candles (Groww, read-only)`);
      console.log(['time', 'open', 'high', 'low', 'close', 'volume'].join('\t'));
      for (const r of rows) console.log([r.hhmm, r.open, r.high, r.low, r.close, r.volume].join('\t'));
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
