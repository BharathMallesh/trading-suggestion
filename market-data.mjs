// READ-ONLY public market data for the trading-research module (library + CLI).
// No dependencies — uses the built-in fetch (Node 18+). No API key required.
//
// SCOPE: this fetches real, publicly available quotes and OHLC candles so that
// research answers can be grounded in actual numbers. It is deliberately
// READ-ONLY and forecast-free: data comes IN, and nothing here predicts prices,
// ranks tickers, or emits a buy/sell/hold signal. It reads a market; it never
// takes a view on one. See README.md for the scope boundary.
//
// Source: the public Yahoo Finance chart endpoint. Prices are typically delayed
// (often ~15 min) and provided as-is with no warranty — treat everything here as
// general information, not a real-time trading feed.

import { pathToFileURL } from 'node:url';
import { HttpError, badRequest } from './util.mjs';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Yahoo occasionally rejects the default runtime User-Agent; send a plain one.
const UA = 'Mozilla/5.0 (AutoClaw Trading Research; read-only market data)';

// Ranges/intervals accepted by the chart endpoint. Kept as a light guard so a
// typo fails fast locally instead of returning a confusing API error.
const RANGES = new Set([
  '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max',
]);
const INTERVALS = new Set([
  '1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo',
]);
const INTRADAY = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h']);

/** True for minute/hour intervals (bars carry a time, not just a date). */
export const isIntraday = (interval) => INTRADAY.has(interval);

// Tiny in-memory cache so repeated clicks / parallel panels don't hammer Yahoo
// (it rate-limits with HTTP 429). Successful payloads only, short TTL.
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // url -> { at, result }

/** Drop all cached chart payloads (used by tests). */
export function clearMarketCache() {
  cache.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level fetch of the raw chart payload for a symbol. Symbols use Yahoo's
 * convention: bare ticker for US listings (e.g. "AAPL"), suffix for other
 * exchanges (e.g. "HDFCBANK.NS" for NSE India, "BP.L" for London).
 * @param {string} symbol
 * @param {{ range?: string, interval?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} the `chart.result[0]` object from Yahoo
 */
export async function fetchChart(symbol, opts = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) throw badRequest('A ticker symbol is required, e.g. "AAPL" or "HDFCBANK.NS".');

  const range = opts.range || '1mo';
  const interval = opts.interval || '1d';
  if (!RANGES.has(range)) {
    throw badRequest(`Unsupported range "${range}". Use one of: ${[...RANGES].join(', ')}.`);
  }
  if (!INTERVALS.has(interval)) {
    throw badRequest(`Unsupported interval "${interval}". Use one of: ${[...INTERVALS].join(', ')}.`);
  }

  const url = `${CHART_BASE}/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let res = await fetch(url, { headers: { 'User-Agent': UA }, signal: opts.signal });
  if (res.status === 429) {
    // Rate-limited: back off once before giving up.
    await sleep(800);
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: opts.signal });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw chartHttpError(sym, res.status, res.statusText, body);
  }
  const data = await res.json();
  const err = data?.chart?.error;
  if (err) throw chartHttpError(sym, 404, '', JSON.stringify({ chart: { error: err } }));
  const result = data?.chart?.result?.[0];
  if (!result) throw new HttpError(404, `No market data found for "${sym}". Check the ticker symbol.`);
  cache.set(url, { at: Date.now(), result });
  return result;
}

/** Turn a Yahoo error response into a short, user-readable HttpError. */
function chartHttpError(sym, status, statusText, body) {
  let description = '';
  try {
    description = JSON.parse(body)?.chart?.error?.description || '';
  } catch {
    /* not JSON */
  }
  if (status === 404 || /No data found/i.test(description)) {
    const hint = /^[A-Z0-9&-]+$/i.test(sym) && !sym.includes('.')
      ? ` NSE stocks need the .NS suffix (e.g. "${sym.toUpperCase()}.NS"); BSE uses .BO.`
      : '';
    return new HttpError(404, `No data found for "${sym}" — check the ticker symbol.${hint}`);
  }
  if (status === 429) {
    return new HttpError(503, 'Market data source is rate-limiting requests. Wait a few seconds and try again.');
  }
  if (status === 422 || status === 400) {
    return new HttpError(400, `Market data: ${description || 'that range/interval combination is not available'}.`);
  }
  return new HttpError(502, `Market data HTTP ${status} ${statusText}: ${(description || body).slice(0, 200)}`);
}

/**
 * Latest snapshot for a symbol — the numbers, no interpretation.
 * @param {string} symbol
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{symbol:string,name:string,currency:string,exchange:string,
 *   price:number,previousClose:number,dayHigh:number,dayLow:number,volume:number,
 *   fiftyTwoWeekHigh:number,fiftyTwoWeekLow:number,marketTime:string}>}
 */
export async function quote(symbol, opts = {}) {
  // range=1d/interval=1d is enough to populate the meta block cheaply.
  const { meta } = await fetchChart(symbol, { range: '1d', interval: '1d', signal: opts.signal });
  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    currency: meta.currency,
    exchange: meta.fullExchangeName || meta.exchangeName,
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose ?? meta.previousClose,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

/**
 * Historical OHLC candles for a symbol, oldest first. Rows where the market was
 * closed (null values) are dropped so the series is clean.
 * @param {string} symbol
 * @param {{ range?: string, interval?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{date:string,open:number,high:number,low:number,close:number,
 *   adjClose:(number|null),volume:number}[]>}
 */
export async function candles(symbol, opts = {}) {
  const result = await fetchChart(symbol, opts);
  const intra = isIntraday(opts.interval || '1d');
  const off = result.meta?.gmtoffset || 0; // seconds; shifts UTC into exchange-local
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    // Yahoo emits null OHLC for holidays/halts; skip incomplete rows.
    if (q.open?.[i] == null || q.close?.[i] == null) continue;
    const local = new Date((ts[i] + off) * 1000).toISOString();
    rows.push({
      // Daily bars: exchange-local date. Intraday bars: date + HH:MM so each
      // bar is uniquely labelled (charts, trade logs, alignment).
      date: intra ? local.slice(0, 16).replace('T', ' ') : local.slice(0, 10),
      ts: ts[i],
      open: q.open[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close[i],
      adjClose: adj?.[i] ?? null,
      volume: q.volume?.[i] ?? null,
    });
  }
  return rows;
}

/**
 * Intraday candles for ONE trading day, with real exchange-local timestamps.
 * Yahoo only serves fine intervals for a short recent window (1m ≈ last few
 * days), so this fetches that window and filters to the requested day.
 * @param {string} symbol
 * @param {{ interval?: string, date?: string, signal?: AbortSignal }} [opts]
 *   `interval` e.g. '1m','5m' (default '1m'); `date` 'YYYY-MM-DD' in the
 *   exchange's local time, or 'previous' for the last full session before the
 *   exchange's today (default: the most recent day present in the data).
 * @returns {Promise<{symbol:string,date:string,interval:string,count:number,
 *   currency:string,exchange:string,
 *   rows:{time:string,hhmm:string,open:number,high:number,low:number,close:number,volume:(number|null)}[]}>}
 */
export async function intraday(symbol, opts = {}) {
  const interval = opts.interval || '1m';
  if (opts.date && opts.date !== 'previous' && !/^\d{4}-\d\d-\d\d$/.test(opts.date)) {
    throw badRequest(`Pass the date as YYYY-MM-DD (or "previous"), got "${opts.date}".`);
  }
  // 1m/2m data spans only a few days on Yahoo; coarser intervals reach further.
  const range = ['1m', '2m'].includes(interval) ? '5d' : ['5m', '15m', '30m', '60m', '90m', '1h'].includes(interval) ? '1mo' : '5d';
  const result = await fetchChart(symbol, { range, interval, signal: opts.signal });
  const off = result.meta?.gmtoffset || 0; // seconds; shifts UTC into exchange-local
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const all = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] == null || q.close?.[i] == null) continue;
    // Add the offset, then read the UTC parts — that yields exchange wall-clock.
    const d = new Date((ts[i] + off) * 1000);
    all.push({
      localDate: d.toISOString().slice(0, 10),
      time: d.toISOString().slice(0, 16).replace('T', ' '),
      hhmm: d.toISOString().slice(11, 16),
      open: q.open[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close[i],
      volume: q.volume?.[i] ?? null,
    });
  }
  if (!all.length) throw new HttpError(404, `No intraday data for "${symbol}" at ${interval}.`);
  const dates = [...new Set(all.map((r) => r.localDate))].sort();
  let date = opts.date || dates[dates.length - 1];
  if (opts.date === 'previous') {
    // "Yesterday" = the latest session strictly before the exchange's today.
    const today = new Date(Date.now() + off * 1000).toISOString().slice(0, 10);
    const before = dates.filter((d) => d < today);
    if (!before.length) throw new HttpError(404, `No previous session in the data for ${symbol}.`);
    date = before[before.length - 1];
  }
  const rows = all.filter((r) => r.localDate === date).map(({ localDate, ...r }) => r);
  if (!rows.length) {
    throw new HttpError(404, `No ${interval} candles for ${symbol} on ${date}. Available days: ${dates.join(', ')}.`);
  }
  return {
    symbol: result.meta.symbol,
    date,
    interval,
    count: rows.length,
    currency: result.meta.currency,
    exchange: result.meta.fullExchangeName || result.meta.exchangeName,
    rows,
  };
}

// CLI:
//   node market-data.mjs AAPL                 -> latest quote
//   node market-data.mjs HDFCBANK.NS --candles [range] [interval]  -> OHLC table
//   node market-data.mjs HDFCBANK.NS --intraday [date] [interval]  -> one day, intraday
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const symbol = args.find((a) => !a.startsWith('--'));
  const wantCandles = args.includes('--candles');
  const wantIntraday = args.includes('--intraday');
  if (!symbol) {
    console.error('Usage: node market-data.mjs <SYMBOL> [--candles [range] [interval]] [--intraday [date] [interval]]');
    console.error('  e.g. node market-data.mjs AAPL');
    console.error('       node market-data.mjs HDFCBANK.NS --candles 3mo 1d');
    console.error('       node market-data.mjs HDFCBANK.NS --intraday 2026-09-29 1m');
    process.exit(1);
  }
  const rest = args.filter((a) => a !== symbol && !a.startsWith('--'));
  const run = wantIntraday
    ? intraday(symbol, { date: rest.find((r) => /^\d{4}-\d\d-\d\d$/.test(r)), interval: rest.find((r) => /^\d+(m|h)$/.test(r)) || '1m' }).then((d) => {
        console.log(`${d.symbol} — ${d.exchange} — ${d.date} — ${d.interval} — ${d.count} candles`);
        console.log(['time', 'open', 'high', 'low', 'close', 'volume'].join('\t'));
        for (const r of d.rows) {
          console.log([r.hhmm, r.open, r.high, r.low, r.close, r.volume].join('\t'));
        }
      })
    : wantCandles
    ? candles(symbol, { range: rest[0] || '1mo', interval: rest[1] || '1d' }).then((rows) => {
        if (!rows.length) return console.log('No candles returned.');
        console.log(['date', 'open', 'high', 'low', 'close', 'volume'].join('\t'));
        for (const r of rows) {
          console.log([r.date, r.open, r.high, r.low, r.close, r.volume].join('\t'));
        }
      })
    : quote(symbol).then((q) => {
        console.log(`${q.name} (${q.symbol}) — ${q.exchange}`);
        console.log(`Price:  ${q.price} ${q.currency}   (prev close ${q.previousClose})`);
        console.log(`Day:    ${q.dayLow} – ${q.dayHigh}`);
        console.log(`52wk:   ${q.fiftyTwoWeekLow} – ${q.fiftyTwoWeekHigh}`);
        console.log(`Volume: ${q.volume}`);
        console.log(`As of:  ${q.marketTime} (public data, may be delayed)`);
      });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
