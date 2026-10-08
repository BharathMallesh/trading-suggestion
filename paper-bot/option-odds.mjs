#!/usr/bin/env node
// Option payoff odds (library + CLI): the question an option buyer actually
// faces — "what is the chance this option ends above breakeven at expiry?" —
// answered from the volatility forecast (where the app has measured skill),
// not from a direction call (where it has none).
//
// For a CE/PE with strike K, premium P, expiry in d days:
//   breakeven  CE: K + P   ·   PE: K − P
//   P(profit)  under the FORECAST vol (HAR/blend winner) and under the option's
//              IMPLIED vol (what its price assumes), two ways:
//                normal  — lognormal, no drift
//                history — the stock's own past d-day moves rescaled to today's
//                          forecast vol (keeps fat tails / skew)
//   fair value = Black-Scholes price with the forecast vol, vs the premium.
//
// evaluateOptionOdds() replays history: at past dates it predicts P(price ends
// above / below thresholds) and checks how often that happened (Brier +
// reliability) vs a naive constant-volatility model.
// Research only — probabilities, not recommendations.
//
//   node paper-bot/option-odds.mjs TCS.NS CE 2150 25 7          # strike, premium, days
//   node paper-bot/option-odds.mjs ^NSEI PE 22000 120 7
//   node paper-bot/option-odds.mjs --eval

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { normCdf, greeks } from '../blackscholes.mjs';
import { FORECASTERS, loadVolModel, volCheck } from './volatility.mjs';
import { badRequest, mapLimit } from '../util.mjs';

const TD = 252;
const logReturns = (c) => c.slice(1).map((x, i) => Math.log(x / c[i]));

/** P(S_T > level) for a lognormal with daily vol `s` over `h` days, zero drift. */
export function probAboveNormal(spot, level, s, h) {
  if (!(level > 0)) return 1;
  const sig = s * Math.sqrt(h);
  if (!(sig > 0)) return spot > level ? 1 : 0;
  // median-neutral: ln(S_T/S) ~ N(−σ²/2, σ²)
  const z = (Math.log(level / spot) + (sig * sig) / 2) / sig;
  return 1 - normCdf(z);
}

/**
 * P(S_T > level) from the stock's own historical h-day log moves, rescaled
 * from their own vol to today's forecast vol (keeps fat tails and skew).
 */
export function probAboveHistory(spot, level, s, h, r) {
  if (!(level > 0)) return 1;
  const moves = [];
  for (let i = 0; i + h <= r.length; i += 1) {
    let m = 0;
    for (let k = i; k < i + h; k++) m += r[k];
    moves.push(m);
  }
  if (moves.length < 50) return null;
  const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
  const sd = Math.sqrt(moves.reduce((a, b) => a + (b - mean) ** 2, 0) / moves.length);
  if (!(sd > 0)) return null;
  const target = s * Math.sqrt(h);
  const x = Math.log(level / spot);
  // standardised, demeaned moves rescaled to the forecast vol
  const above = moves.filter((m) => ((m - mean) / sd) * target > x).length;
  return above / moves.length;
}

/**
 * Odds for one option now.
 * @param {{ symbol, type:'CE'|'PE', strike, premium?, iv?, days, loadCandles? }} p
 */
export async function optionOdds({ symbol, type = 'CE', strike, premium, iv, days = 7, eventPending = false, expiry, loadCandles = candles, vol = volCheck } = {}) {
  const t = String(type).toUpperCase();
  if (t !== 'CE' && t !== 'PE') throw badRequest('type must be CE or PE');
  const K = Number(strike);
  if (!(K > 0)) throw badRequest('strike must be a positive number');
  const d = Number(days);
  if (!(d >= 1 && d <= 365)) throw badRequest('days to expiry must be 1–365');
  const v = await vol({ symbol, iv: iv ?? undefined, days: d, eventPending, expiry, loadCandles });
  const rows = await loadCandles(v.symbol, { range: '5y', interval: '1d' });
  const r = logReturns(rows.map((x) => x.close));
  const spot = rows[rows.length - 1].close;
  const h = Math.max(1, Math.round(d * (5 / 7)));
  const fDaily = v.forecastPct / 100 / Math.sqrt(TD);
  const iDaily = v.impliedPct != null ? v.impliedPct / 100 / Math.sqrt(TD) : null;
  const tYears = h / TD;
  // premium: given, else priced from implied vol (if known)
  let P = premium != null && premium !== '' ? Number(premium) : null;
  if (P == null && v.impliedPct != null) P = greeks({ spot, strike: K, tYears, iv: v.impliedPct / 100, type: t }).price;
  if (!(P >= 0)) throw badRequest('Give the option premium, or an implied vol so it can be priced.');
  const breakeven = t === 'CE' ? K + P : K - P;
  const pAbove = (level, sDaily, method) =>
    method === 'history' ? probAboveHistory(spot, level, sDaily, h, r) : probAboveNormal(spot, level, sDaily, h);
  const pProfit = (sDaily, method) => {
    if (sDaily == null) return null;
    const a = pAbove(breakeven, sDaily, method);
    return a == null ? null : t === 'CE' ? a : 1 - a;
  };
  const pItm = (sDaily) => (t === 'CE' ? probAboveNormal(spot, K, sDaily, h) : 1 - probAboveNormal(spot, K, sDaily, h));
  const fair = greeks({ spot, strike: K, tYears, iv: v.forecastPct / 100, type: t }).price;
  return {
    symbol: v.symbol,
    type: t,
    spot,
    strike: K,
    premium: P,
    premiumSource: premium != null && premium !== '' ? 'you entered' : `priced from implied vol ${v.impliedPct?.toFixed(1)}%`,
    days: d,
    tradingDays: h,
    breakeven,
    breakevenMovePct: (breakeven / spot - 1) * 100,
    forecastVolPct: v.forecastPct,
    impliedVolPct: v.impliedPct,
    volModel: v.model,
    eventPending: v.eventPending,
    probProfit: {
      forecastNormal: pProfit(fDaily, 'normal'),
      forecastHistory: pProfit(fDaily, 'history'),
      impliedNormal: pProfit(iDaily, 'normal'),
    },
    probItm: { forecast: pItm(fDaily), implied: iDaily ? pItm(iDaily) : null },
    fairValueForecast: fair,
    premiumVsFairPct: fair > 0 ? (P / fair - 1) * 100 : null,
    reading:
      fair > 0
        ? P > fair * 1.15
          ? `The premium is ${((P / fair - 1) * 100).toFixed(0)}% above its value under the forecast volatility — buyers pay for more movement than the forecast expects.`
          : P < fair * 0.87
            ? `The premium is ${((1 - P / fair) * 100).toFixed(0)}% below its value under the forecast volatility — the market expects less movement than the forecast.`
            : 'The premium is close to its value under the forecast volatility.'
        : 'Fair value unavailable.',
    disclaimer: 'Probabilities from volatility forecasts (no direction view). Ignores dividends and early events beyond any results add-on; real moves have fatter tails. Research only — not a recommendation.',
  };
}

/**
 * Replay: are these probabilities calibrated? At non-overlapping past dates,
 * predict P(S_{t+h} > S_t·(1+k·σ√h)) for k ∈ {−1, −0.5, 0.5, 1} using the
 * forecast vol (normal and history methods) and a naive 1-year constant vol,
 * then score against what happened.
 */
export async function evaluateOptionOdds({ symbols, horizon = 5, loadCandles = candles, model = loadVolModel() } = {}) {
  const syms = symbols?.length ? symbols : ['^NSEI', 'RELIANCE.NS', 'HDFCBANK.NS', 'TCS.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'ITC.NS', 'LT.NS'];
  const ks = [-1, -0.5, 0.5, 1];
  const methods = { forecastNormal: [], forecastHistory: [], naiveNormal: [] };
  const rel = { forecastHistory: Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 })) };
  await mapLimit(syms, 4, async (sym) => {
    let rows;
    try {
      rows = await loadCandles(sym, { range: '5y', interval: '1d' });
    } catch {
      return;
    }
    const c = rows.map((x) => x.close);
    const r = logReturns(c);
    const fk = sym === '^NSEI' ? model.bestNifty || 'blend' : model.bestStock || 'har';
    for (let t = 301; t + horizon < r.length; t += horizon) {
      const past = r.slice(0, t);
      const f = FORECASTERS[fk](past, horizon) || FORECASTERS.ewma(past, horizon);
      const naive = Math.sqrt(past.slice(-252).reduce((a, x) => a + x * x, 0) / 252);
      const spot = c[t];
      const end = c[t + horizon];
      for (const k of ks) {
        const level = spot * Math.exp(k * f * Math.sqrt(horizon));
        const y = end > level ? 1 : 0;
        const pN = probAboveNormal(spot, level, f, horizon);
        const pH = probAboveHistory(spot, level, f, horizon, past);
        const pZ = probAboveNormal(spot, level, naive, horizon);
        methods.forecastNormal.push((pN - y) ** 2);
        if (pH != null) {
          methods.forecastHistory.push((pH - y) ** 2);
          const b = rel.forecastHistory[Math.min(9, Math.floor(pH * 10))];
          b.n++;
          b.p += pH;
          b.hit += y;
        }
        methods.naiveNormal.push((pZ - y) ** 2);
      }
    }
  });
  const summary = Object.fromEntries(Object.entries(methods).map(([k, a]) => [k, { n: a.length, brier: a.reduce((x, y) => x + y, 0) / (a.length || 1) }]));
  const best = Object.entries(summary).sort((a, b) => a[1].brier - b[1].brier)[0][0];
  return {
    horizon,
    symbols: syms.length,
    summary,
    best,
    reliability: rel.forecastHistory.filter((b) => b.n >= 20).map((b, i) => ({ meanPredicted: b.p / b.n, observed: b.hit / b.n, n: b.n })),
    note: 'Brier on binary "ends above level" outcomes (lower = better). Levels at ±0.5σ and ±1σ of the forecast move. Reliability: predicted vs observed frequency (history method).',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const run = a.includes('--eval')
    ? evaluateOptionOdds().then((r) => {
        console.log(`\nOPTION ODDS REPLAY · next ${r.horizon} days · ${r.symbols} series`);
        for (const [k, v] of Object.entries(r.summary)) console.log(`  ${k.padEnd(16)} Brier ${v.brier.toFixed(4)} (n=${v.n})${k === r.best ? '  ← best' : ''}`);
        console.log('  reliability (history method): ' + r.reliability.map((b) => `${(b.meanPredicted * 100).toFixed(0)}%→${(b.observed * 100).toFixed(0)}%`).join(' · '));
        console.log(r.note);
      })
    : optionOdds({ symbol: a[0] || '^NSEI', type: a[1] || 'CE', strike: a[2], premium: a[3], days: a[4] || 7 }).then((o) => {
        const pct = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
        console.log(`\n${o.symbol} ${o.type} ${o.strike} · spot ${o.spot.toFixed(2)} · ${o.days} days · premium ${o.premium.toFixed(2)} (${o.premiumSource})`);
        console.log(`Breakeven ${o.breakeven.toFixed(2)} (${o.breakevenMovePct >= 0 ? '+' : ''}${o.breakevenMovePct.toFixed(2)}% move needed)`);
        console.log(`Vol: forecast ${o.forecastVolPct.toFixed(1)}% (${o.volModel})${o.impliedVolPct != null ? ` · implied ${o.impliedVolPct.toFixed(1)}%` : ''}${o.eventPending ? ' · results due (widened)' : ''}`);
        console.log(`P(profit at expiry): forecast ${pct(o.probProfit.forecastNormal)} (normal) / ${pct(o.probProfit.forecastHistory)} (history)${o.probProfit.impliedNormal != null ? ` · implied ${pct(o.probProfit.impliedNormal)}` : ''}`);
        console.log(`P(in the money): forecast ${pct(o.probItm.forecast)}${o.probItm.implied != null ? ` · implied ${pct(o.probItm.implied)}` : ''}`);
        console.log(`Fair value at forecast vol ${o.fairValueForecast.toFixed(2)} vs premium ${o.premium.toFixed(2)} → ${o.reading}`);
      });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
