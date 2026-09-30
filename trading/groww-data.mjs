// READ-ONLY Groww market-data client (candles). Optional alternative source to
// market-data.mjs (Yahoo). Zero dependencies, built-in fetch (Node 18+).
//
// SCOPE — read this:
// - This file fetches HISTORICAL CANDLES ONLY. It deliberately contains NO
//   endpoints for orders, positions, holdings, margins, or fund movement. It
//   reads a market through Groww's data API; it never trades on the account.
// - Your Groww access token is read from the environment (GROWW_ACCESS_TOKEN).
//   It is never hard-coded, never logged, and never leaves this process. Run
//   this yourself with your own token — the assistant does not authenticate to
//   your broker for you.
//
// Endpoint/response shapes follow Groww's published API and may need a small
// tweak for your account/version. Base URL and API version are overridable via
// env so you can adjust without editing code:
//   GROWW_BASE_URL      (default https://api.groww.in)
//   GROWW_API_VERSION   (default 1.0)

const BASE = process.env.GROWW_BASE_URL || 'https://api.groww.in';
const API_VERSION = process.env.GROWW_API_VERSION || '1.0';
const TOKEN_ENV = 'GROWW_ACCESS_TOKEN';

function authHeaders() {
  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(
      `Missing ${TOKEN_ENV}. Set your Groww access token first, e.g.:\n` +
        `  export ${TOKEN_ENV}="<your token>"\n` +
        `(Run this yourself; never paste the token into a chat.)`,
    );
  }
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
  if (!symbol) throw new Error('A trading symbol is required, e.g. "HDFCBANK".');
  if (!startTime || !endTime) throw new Error('startTime and endTime are required.');

  const qs = new URLSearchParams({
    exchange,
    segment,
    trading_symbol: symbol,
    start_time: String(startTime),
    end_time: String(endTime),
    interval_in_minutes: String(intervalMinutes),
  });
  const url = `${BASE}/v1/historical/candle/range?${qs.toString()}`;

  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groww HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
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

/** Convenience: one full NSE session (09:15–15:30 IST) for a date. */
export async function daySession(symbol, dateStr, opts = {}) {
  if (!/^\d{4}-\d\d-\d\d$/.test(String(dateStr || ''))) {
    throw new Error('Pass a date as YYYY-MM-DD, e.g. 2026-09-29.');
  }
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
if (import.meta.url === `file://${process.argv[1]}`) {
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
