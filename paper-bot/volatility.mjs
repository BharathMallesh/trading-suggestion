// Volatility forecasting + "implied vs forecast" check (library + CLI).
//
// The app showed real skill at predicting WHETHER prices move (volatility),
// not which way. This module forecasts volatility and compares it with the
// volatility the options market is pricing (implied volatility):
//   - NIFTY 50: India VIX is NIFTY's 30-day implied volatility — fetched automatically.
//   - Stocks: type the option's IV from your broker (free option-chain data
//     isn't available programmatically).
// Forecasters: 20-day and 60-day realised vol, EWMA (RiskMetrics λ = 0.94),
// and for NIFTY the VIX itself. evaluateVolForecasts() replays history and
// scores each with QLIKE (standard loss for variance forecasts; lower = better).
// Research only — factual comparison, not a trade suggestion.
//
//   node paper-bot/volatility.mjs --eval             # forecast accuracy
//   node paper-bot/volatility.mjs ^NSEI              # implied (VIX) vs forecast
//   node paper-bot/volatility.mjs TCS.NS 28 7        # IV 28%, 7 days to expiry

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { badRequest, mapLimit } from '../util.mjs';
import { optionChain } from '../groww-data.mjs';

const TRADING_DAYS = 252;
const isNifty = (s) => /^(\^NSEI|NIFTY|NIFTY50|NIFTY 50)$/i.test(String(s).trim());

const logReturns = (closes) => closes.slice(1).map((c, i) => Math.log(c / closes[i]));
const sd = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/** Daily-vol forecasters from past log returns (most recent last). */
export const FORECASTERS = {
  rv20: (r) => (r.length >= 20 ? sd(r.slice(-20)) : null),
  rv60: (r) => (r.length >= 60 ? sd(r.slice(-60)) : null),
  ewma: (r, lambda = 0.94) => {
    if (r.length < 30) return null;
    let v = sd(r.slice(0, 30)) ** 2;
    for (let i = 30; i < r.length; i++) v = lambda * v + (1 - lambda) * r[i] ** 2;
    return Math.sqrt(v);
  },
};

/** QLIKE loss for a variance forecast (robust to noisy realised variance). */
export function qlike(realisedVar, forecastVar) {
  if (!(realisedVar > 0) || !(forecastVar > 0)) return null;
  const x = realisedVar / forecastVar;
  return x - Math.log(x) - 1;
}

/**
 * Replay: at non-overlapping dates, forecast daily vol and compare with the
 * realised vol over the next `horizon` days.
 */
export async function evaluateVolForecasts(opts = {}) {
  const horizon = Number(opts.horizon) || 5;
  const symbols = opts.symbols?.length ? opts.symbols : ['^NSEI', 'RELIANCE.NS', 'HDFCBANK.NS', 'TCS.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'ITC.NS', 'LT.NS'];
  const load = opts.loadCandles || candles;
  let vix = null;
  try {
    const v = await load('^INDIAVIX', { range: '5y', interval: '1d' });
    vix = new Map(v.map((r) => [r.date, r.close]));
  } catch {
    /* VIX forecaster optional */
  }
  const losses = {}; // all series, historical forecasters
  const nifty = {}; // NIFTY only, incl. India VIX — the fair head-to-head
  const add = (k, l, sym) => {
    if (l == null) return;
    (losses[k] ||= []).push(l);
    if (isNifty(sym)) (nifty[k] ||= []).push(l);
  };
  let vrpN = 0;
  let vrpAbove = 0;
  let impliedSum = 0;
  let realisedSum = 0;
  const skipped = [];
  await mapLimit(symbols, 4, async (sym) => {
    let rows;
    try {
      rows = await load(sym, { range: '5y', interval: '1d' });
    } catch (err) {
      skipped.push(`${sym}: ${err.message.slice(0, 60)}`);
      return;
    }
    const closes = rows.map((r) => r.close);
    const r = logReturns(closes);
    for (let t = 61; t + horizon <= r.length; t += horizon) {
      const past = r.slice(0, t);
      const realisedVar = r.slice(t, t + horizon).reduce((a, x) => a + x * x, 0) / horizon;
      const iv = isNifty(sym) && vix ? vix.get(rows[t].date) : null; // date of the last return used
      if (isNifty(sym) && vix && !iv) continue; // keep the NIFTY head-to-head on identical dates
      for (const [k, f] of Object.entries(FORECASTERS)) {
        const s = f(past);
        if (s) add(k, qlike(realisedVar, s * s), sym);
      }
      if (iv) {
        const daily = iv / 100 / Math.sqrt(TRADING_DAYS);
        const realisedPct = Math.sqrt(realisedVar * TRADING_DAYS) * 100;
        (nifty.indiaVix ||= []).push(qlike(realisedVar, daily * daily));
        vrpN++;
        impliedSum += iv;
        realisedSum += realisedPct;
        if (iv > realisedPct) vrpAbove++;
      }
    }
  });
  const summarize = (obj) => Object.fromEntries(
    Object.entries(obj).map(([k, a]) => [k, { n: a.length, meanQlike: a.reduce((x, y) => x + y, 0) / a.length }]),
  );
  const summary = summarize(losses);
  const niftyHeadToHead = summarize(nifty);
  if (!Object.keys(summary).length) throw badRequest(`No usable history. ${skipped.join(' · ')}`);
  const bestOf = (o) => (Object.keys(o).length ? Object.entries(o).sort((a, b) => a[1].meanQlike - b[1].meanQlike)[0][0] : null);
  const best = bestOf(summary);
  return {
    horizon,
    symbols: symbols.length - skipped.length,
    skipped,
    summary,
    best,
    niftyHeadToHead,
    niftyBest: bestOf(niftyHeadToHead),
    niftyImpliedVsRealised: vrpN
      ? { n: vrpN, avgImpliedPct: impliedSum / vrpN, avgRealisedPct: realisedSum / vrpN, pctTimeImpliedAbove: (vrpAbove / vrpN) * 100 }
      : null,
    note: 'QLIKE: lower = better variance forecast. Implied vs realised: India VIX (30-day) vs NIFTY realised vol over the next horizon. Research only.',
  };
}

/**
 * Implied vs forecast volatility for one symbol now.
 * @param {{ symbol:string, iv?:number, days?:number }} p  iv in % (annualised); auto = India VIX for NIFTY
 */
export async function volCheck({ symbol, iv, days = 7, expiry, loadCandles = candles, chainFn = optionChain } = {}) {
  const sym = isNifty(symbol) ? '^NSEI' : String(symbol || '').trim();
  if (!sym) throw badRequest('symbol is required, e.g. ^NSEI or TCS.NS');
  const d = Number(days);
  if (!(d >= 1 && d <= 365)) throw badRequest('days to expiry must be 1–365.');
  const rows = await loadCandles(sym, { range: '1y', interval: '1d' });
  const r = logReturns(rows.map((x) => x.close));
  const forecasts = Object.fromEntries(
    Object.entries(FORECASTERS).map(([k, f]) => [k, f(r) ? f(r) * Math.sqrt(TRADING_DAYS) * 100 : null]),
  );
  let impliedPct = iv != null && iv !== '' ? Number(iv) : null;
  let impliedSource = impliedPct != null ? 'you entered' : null;
  let chain = null;
  if (impliedPct == null && sym === '^NSEI') {
    const v = await loadCandles('^INDIAVIX', { range: '5d', interval: '1d' });
    impliedPct = v[v.length - 1].close;
    impliedSource = 'India VIX';
  } else if (impliedPct == null && process.env.GROWW_ACCESS_TOKEN && /\.(NS|BO)$/i.test(sym)) {
    // Real stock-option IV from Groww's option chain (ATM, nearest monthly expiry).
    try {
      chain = await chainFn({ underlying: sym, expiry });
      if (chain.atmIvPct) {
        impliedPct = chain.atmIvPct;
        impliedSource = `Groww option chain (ATM ${chain.atmStrike}, expiry ${chain.expiry})`;
      }
    } catch (err) {
      chain = { error: err.message.slice(0, 140) };
    }
  }
  if (impliedPct != null && !(impliedPct > 0 && impliedPct < 300)) throw badRequest('IV must be a percentage between 0 and 300.');
  const forecastPct = forecasts.ewma ?? forecasts.rv20;
  const last = rows[rows.length - 1].close;
  const move = (volPct) => (volPct == null ? null : (volPct / 100) * Math.sqrt(d / TRADING_DAYS) * 100);
  const ratio = impliedPct != null && forecastPct ? impliedPct / forecastPct : null;
  return {
    symbol: sym,
    asOf: rows[rows.length - 1].date,
    last,
    days: d,
    forecastsAnnualPct: forecasts,
    forecastPct,
    impliedPct,
    impliedSource,
    optionChain: chain,
    ratio,
    expectedMovePct: { implied: move(impliedPct), forecast: move(forecastPct) },
    reading:
      ratio == null
        ? 'Enter the option\'s implied volatility (IV %) from your broker to compare.'
        : ratio > 1.15
          ? `Implied vol is ${((ratio - 1) * 100).toFixed(0)}% above the forecast: options are pricing bigger moves than recent behaviour suggests (relatively expensive).`
          : ratio < 0.87
            ? `Implied vol is ${((1 - ratio) * 100).toFixed(0)}% below the forecast: options are pricing smaller moves than recent behaviour suggests (relatively cheap).`
            : 'Implied vol is close to the forecast: options are priced roughly in line with recent behaviour.',
    disclaimer: 'Volatility comparison for research. Forecasts can be wrong, especially around results/events. Not a trade suggestion.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const run = args.includes('--eval')
    ? evaluateVolForecasts().then((r) => {
        console.log(`\nVOL FORECAST REPLAY · next ${r.horizon} days · ${r.symbols} series (5y, non-overlapping)`);
        console.log('All series (historical forecasters):');
        for (const [k, v] of Object.entries(r.summary)) console.log(`  ${k.padEnd(9)} QLIKE ${v.meanQlike.toFixed(4)} (n=${v.n})${k === r.best ? '  ← best' : ''}`);
        console.log('NIFTY only, same dates (incl. India VIX):');
        for (const [k, v] of Object.entries(r.niftyHeadToHead)) console.log(`  ${k.padEnd(9)} QLIKE ${v.meanQlike.toFixed(4)} (n=${v.n})${k === r.niftyBest ? '  ← best' : ''}`);
        const v = r.niftyImpliedVsRealised;
        if (v) console.log(`NIFTY: India VIX averaged ${v.avgImpliedPct.toFixed(1)}% vs realised ${v.avgRealisedPct.toFixed(1)}%; implied above realised ${v.pctTimeImpliedAbove.toFixed(0)}% of the time (n=${v.n}).`);
        console.log(r.note);
      })
    : volCheck({ symbol: args[0] || '^NSEI', iv: args[1], days: args[2] || 7 }).then((r) => {
        console.log(`\n${r.symbol} · ${r.asOf} · last ${r.last.toFixed(2)} · ${r.days} days`);
        console.log(`Forecast vol (annual): EWMA ${r.forecastsAnnualPct.ewma?.toFixed(1)}% · 20d ${r.forecastsAnnualPct.rv20?.toFixed(1)}% · 60d ${r.forecastsAnnualPct.rv60?.toFixed(1)}%`);
        if (r.impliedPct != null) console.log(`Implied vol: ${r.impliedPct.toFixed(1)}% (${r.impliedSource}) · ratio ${r.ratio.toFixed(2)}`);
        console.log(`Expected ±1σ move over ${r.days} days: forecast ${r.expectedMovePct.forecast?.toFixed(2)}%${r.expectedMovePct.implied != null ? ` · implied ${r.expectedMovePct.implied.toFixed(2)}%` : ''}`);
        console.log(r.reading);
      });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
