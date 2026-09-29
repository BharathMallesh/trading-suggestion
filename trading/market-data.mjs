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
  if (!sym) throw new Error('A ticker symbol is required, e.g. "AAPL" or "HDFCBANK.NS".');

  const range = opts.range || '1mo';
  const interval = opts.interval || '1d';
  if (!RANGES.has(range)) {
    throw new Error(`Unsupported range "${range}". Use one of: ${[...RANGES].join(', ')}.`);
  }
  if (!INTERVALS.has(interval)) {
    throw new Error(`Unsupported interval "${interval}". Use one of: ${[...INTERVALS].join(', ')}.`);
  }

  const url = `${CHART_BASE}/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: opts.signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Market data HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const err = data?.chart?.error;
  if (err) throw new Error(`Market data error for "${sym}": ${err.description || err.code || 'unknown'}`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No market data found for "${sym}". Check the ticker symbol.`);
  return result;
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
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    // Yahoo emits null OHLC for holidays/halts; skip incomplete rows.
    if (q.open?.[i] == null || q.close?.[i] == null) continue;
    rows.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
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

// CLI:
//   node market-data.mjs AAPL                 -> latest quote
//   node market-data.mjs HDFCBANK.NS --candles [range] [interval]  -> OHLC table
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const symbol = args.find((a) => !a.startsWith('--'));
  const wantCandles = args.includes('--candles');
  if (!symbol) {
    console.error('Usage: node market-data.mjs <SYMBOL> [--candles [range] [interval]]');
    console.error('  e.g. node market-data.mjs AAPL');
    console.error('       node market-data.mjs HDFCBANK.NS --candles 3mo 1d');
    process.exit(1);
  }
  const rest = args.filter((a) => a !== symbol && !a.startsWith('--'));
  const run = wantCandles
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
