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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which forecaster won the last replay (saved by `--eval --save`).
const MODEL_PATH = process.env.VOL_MODEL_PATH || join(dirname(fileURLToPath(import.meta.url)), 'vol-model.json');
export function loadVolModel() {
  try {
    return existsSync(MODEL_PATH) ? JSON.parse(readFileSync(MODEL_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}
const HISTORY_MODELS = ['rv20', 'rv60', 'ewma', 'garch', 'har', 'blend'];

/** Merge fields into vol-model.json (keeps the replay winners). */
export function updateVolModel(patch) {
  const m = { ...loadVolModel(), ...patch };
  writeFileSync(MODEL_PATH, JSON.stringify(m, null, 2));
  return m;
}

/** Weekly NIFTY options: horizons up to this many calendar days use the weekly IV ratio. */
export const WEEKLY_MAX_DAYS = 10;

/** Persist the replay's winners: best history model for stocks / NIFTY, and VIX's usual premium. */
export function saveVolModel(r) {
  const bestOf = (o) => HISTORY_MODELS.filter((k) => o[k]).sort((a, b) => o[a].meanQlike - o[b].meanQlike)[0] || 'ewma';
  const v = r.niftyImpliedVsRealised;
  const model = {
    fittedAt: new Date().toISOString(),
    horizon: r.horizon,
    bestStock: bestOf(r.summary),
    bestNifty: bestOf(r.niftyHeadToHead),
    niftyTypicalRatio: v ? v.avgImpliedPct / v.avgRealisedPct : null,
    summary: r.summary,
    niftyHeadToHead: r.niftyHeadToHead,
  };
  writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));
  return model;
}

const TRADING_DAYS = 252;
const isNifty = (s) => /^(\^NSEI|NIFTY|NIFTY50|NIFTY 50)$/i.test(String(s).trim());

const logReturns = (closes) => closes.slice(1).map((c, i) => Math.log(c / closes[i]));
const sd = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/** Daily-vol forecasters from past log returns (most recent last). */
const meanSq = (a) => a.reduce((x, y) => x + y * y, 0) / (a.length || 1);

/**
 * GARCH(1,1) with variance targeting, fitted by Gaussian likelihood over a
 * coarse (α, β) grid on the last 500 returns; returns the average daily vol
 * expected over the next `h` days (variance mean-reverts toward the long run).
 */
export function garchForecast(r, h = 5) {
  if (r.length < 250) return null;
  const x = r.slice(-500);
  const lr = meanSq(x);
  let best = null;
  for (let a = 0.02; a <= 0.16; a += 0.02) {
    for (let b = 0.78; b <= 0.96; b += 0.02) {
      if (a + b >= 0.995) continue;
      const w = lr * (1 - a - b);
      let v = lr;
      let ll = 0;
      for (const e of x) {
        ll -= Math.log(v) + (e * e) / v;
        v = w + a * e * e + b * v;
      }
      if (!best || ll > best.ll) best = { a, b, w, v, ll };
    }
  }
  // v is the one-step-ahead variance; average the h-step path.
  const p = best.a + best.b;
  let sum = 0;
  for (let k = 0; k < h; k++) sum += lr + p ** k * (best.v - lr);
  return Math.sqrt(Math.max(sum / h, 1e-12));
}

/** Solve a small linear system (normal equations) by Gaussian elimination. */
function solve(A, y) {
  const n = y.length;
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * HAR model (Corsi): next-h-day variance from the last day's, week's and
 * month's realised variance, fitted by OLS in logs on the past ~3 years.
 */
export function harForecast(r, h = 5) {
  if (r.length < 300) return null;
  const eps = 1e-10;
  const feats = (t) => [1, Math.log(r[t] ** 2 + eps), Math.log(meanSq(r.slice(t - 4, t + 1)) + eps), Math.log(meanSq(r.slice(t - 21, t + 1)) + eps)];
  const start = Math.max(22, r.length - 750 - h);
  const X = [];
  const Y = [];
  for (let t = start; t + h < r.length; t++) {
    X.push(feats(t));
    Y.push(Math.log(meanSq(r.slice(t + 1, t + 1 + h)) + eps));
  }
  const XtX = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => X.reduce((s, x) => s + x[i] * x[j], 0)));
  const XtY = [0, 1, 2, 3].map((i) => X.reduce((s, x, k) => s + x[i] * Y[k], 0));
  const beta = solve(XtX, XtY);
  if (!beta) return null;
  const resid = Y.map((y, k) => y - X[k].reduce((s, v, i) => s + v * beta[i], 0));
  const s2 = resid.reduce((a, e) => a + e * e, 0) / resid.length;
  const f = feats(r.length - 1).reduce((s, v, i) => s + v * beta[i], 0);
  return Math.sqrt(Math.exp(f + s2 / 2)); // log-normal bias correction
}

/** Daily-vol forecasters from past log returns (most recent last); h = horizon in days. */
export const FORECASTERS = {
  rv20: (r) => (r.length >= 20 ? sd(r.slice(-20)) : null),
  rv60: (r) => (r.length >= 60 ? sd(r.slice(-60)) : null),
  ewma: (r, h, lambda = 0.94) => {
    if (r.length < 30) return null;
    let v = sd(r.slice(0, 30)) ** 2;
    for (let i = 30; i < r.length; i++) v = lambda * v + (1 - lambda) * r[i] ** 2;
    return Math.sqrt(v);
  },
  garch: (r, h = 5) => garchForecast(r, h),
  har: (r, h = 5) => harForecast(r, h),
  // Equal-weight blend of the three model forecasts (in variance).
  blend: (r, h = 5) => {
    const v = [FORECASTERS.ewma(r, h), garchForecast(r, h), harForecast(r, h)].filter((x) => x);
    return v.length ? Math.sqrt(meanSq(v)) : null;
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
  // NIFTY head-to-head only counts dates where the bias-corrected VIX also
  // exists (after a 20-observation warm-up), so every NIFTY model has equal n.
  const add = (k, l, sym) => {
    if (l == null) return;
    (losses[k] ||= []).push(l);
    if (isNifty(sym) && vrpN >= 20) (nifty[k] ||= []).push(l);
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
    // Start once every model (HAR needs ~300 days) can forecast: all are scored on the same dates.
    for (let t = 301; t + horizon <= r.length; t += horizon) {
      const past = r.slice(0, t);
      const realisedVar = r.slice(t, t + horizon).reduce((a, x) => a + x * x, 0) / horizon;
      const iv = isNifty(sym) && vix ? vix.get(rows[t].date) : null; // date of the last return used
      if (isNifty(sym) && vix && !iv) continue; // keep the NIFTY head-to-head on identical dates
      const fc = {};
      for (const [k, f] of Object.entries(FORECASTERS)) {
        const s = f(past, horizon);
        fc[k] = s;
        if (s) add(k, qlike(realisedVar, s * s), sym);
      }
      if (iv) {
        const daily = iv / 100 / Math.sqrt(TRADING_DAYS);
        const realisedPct = Math.sqrt(realisedVar * TRADING_DAYS) * 100;
        if (vrpN >= 20) (nifty.indiaVix ||= []).push(qlike(realisedVar, daily * daily));
        // Bias-corrected VIX: scale by realised/implied seen so far (past only).
        if (vrpN >= 20) {
          const scaled = daily * (realisedSum / impliedSum);
          (nifty.vixScaled ||= []).push(qlike(realisedVar, scaled * scaled));
          if (fc.har) (nifty.blendVix ||= []).push(qlike(realisedVar, (scaled * scaled + fc.har * fc.har) / 2));
        }
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
export async function volCheck({ symbol, iv, days = 7, expiry, eventPending = false, loadCandles = candles, chainFn = optionChain, model = loadVolModel() } = {}) {
  const sym = isNifty(symbol) ? '^NSEI' : String(symbol || '').trim();
  if (!sym) throw badRequest('symbol is required, e.g. ^NSEI or TCS.NS');
  const d = Number(days);
  if (!(d >= 1 && d <= 365)) throw badRequest('days to expiry must be 1–365.');
  // 3 years so GARCH / HAR have enough history.
  const rows = await loadCandles(sym, { range: '5y', interval: '1d' });
  const r = logReturns(rows.map((x) => x.close));
  const h = Math.max(1, Math.round(d * (5 / 7))); // trading days in the window
  const forecasts = Object.fromEntries(
    Object.entries(FORECASTERS).map(([k, f]) => {
      const v = f(r, h);
      return [k, v ? v * Math.sqrt(TRADING_DAYS) * 100 : null];
    }),
  );
  const chosen = sym === '^NSEI' ? model.bestNifty || 'blend' : model.bestStock || 'har';
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
  let forecastPct = forecasts[chosen] ?? forecasts.ewma ?? forecasts.rv20;
  // Results due: add one typical big-day move (90th-percentile |daily return|
  // over the past year) to the window's variance — event days are far more volatile.
  let eventAddOnPct = null;
  if (eventPending && forecastPct) {
    const abs = r.slice(-252).map((x) => Math.abs(x)).sort((a, b) => a - b);
    const big = abs[Math.floor(abs.length * 0.9)] || 0;
    const baseVar = (forecastPct / 100) ** 2 * (h / TRADING_DAYS);
    const withEvent = Math.sqrt((baseVar + big * big) * (TRADING_DAYS / h)) * 100;
    eventAddOnPct = withEvent - forecastPct;
    forecastPct = withEvent;
  }
  const last = rows[rows.length - 1].close;
  const move = (volPct) => (volPct == null ? null : (volPct / 100) * Math.sqrt(d / TRADING_DAYS) * 100);
  const ratio = impliedPct != null && forecastPct ? impliedPct / forecastPct : null;
  // Pricing IV. VIX is a 30-day measure; real weekly NIFTY options trade at a
  // measured fraction of it (from NSE closing prices — vol-premium.mjs).
  let pricingIvPct = impliedPct;
  let pricingIvSource = impliedSource;
  const wk = model.niftyWeeklyIvToVix;
  if (sym === '^NSEI' && impliedSource === 'India VIX' && d <= WEEKLY_MAX_DAYS && wk?.recentMedian > 0) {
    pricingIvPct = impliedPct * wk.recentMedian;
    pricingIvSource = `weekly options ≈ ${wk.recentMedian.toFixed(2)} × India VIX (median of real NSE prices, last ${wk.recentN} weeks to ${wk.to})`;
  }
  // For NIFTY, judge today's gap against VIX's usual premium over realised vol.
  const typical = sym === '^NSEI' && impliedSource === 'India VIX' ? model.niftyTypicalRatio : null;
  return {
    symbol: sym,
    asOf: rows[rows.length - 1].date,
    last,
    days: d,
    forecastsAnnualPct: forecasts,
    forecastPct,
    impliedPct,
    impliedSource,
    pricingIvPct,
    pricingIvSource,
    optionChain: chain,
    ratio,
    expectedMovePct: { implied: move(impliedPct), forecast: move(forecastPct) },
    model: chosen,
    eventPending,
    eventAddOnPct,
    typicalRatio: typical,
    reading:
      ratio == null
        ? 'Enter the option\'s implied volatility (IV %) from your broker to compare.'
        : typical
          ? ratio > typical * 1.15
            ? `India VIX is ${((ratio - 1) * 100).toFixed(0)}% above the forecast — more than its usual premium (~${((typical - 1) * 100).toFixed(0)}%): options look unusually expensive.`
            : ratio < typical * 0.87
              ? `India VIX is ${((ratio - 1) * 100).toFixed(0)}% vs the forecast — below its usual premium (~${((typical - 1) * 100).toFixed(0)}%): options look unusually cheap.`
              : `India VIX is ${((ratio - 1) * 100).toFixed(0)}% above the forecast — in line with its usual premium (~${((typical - 1) * 100).toFixed(0)}%): nothing unusual.`
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
        if (args.includes('--save')) {
          const m = saveVolModel(r);
          console.log(`Saved vol-model.json: stocks → ${m.bestStock}, NIFTY → ${m.bestNifty}, VIX usual premium ×${m.niftyTypicalRatio?.toFixed(2)}`);
        }
      })
    : volCheck({ symbol: args[0] || '^NSEI', iv: args[1] || undefined, days: args[2] || 7 }).then((r) => {
        console.log(`\n${r.symbol} · ${r.asOf} · last ${r.last.toFixed(2)} · ${r.days} days`);
        console.log(`Forecast vol (annual, model ${r.model}): ${r.forecastPct?.toFixed(1)}%${r.eventAddOnPct ? ` (incl. +${r.eventAddOnPct.toFixed(1)} pts for results)` : ''} · EWMA ${r.forecastsAnnualPct.ewma?.toFixed(1)}% · GARCH ${r.forecastsAnnualPct.garch?.toFixed(1)}% · HAR ${r.forecastsAnnualPct.har?.toFixed(1)}%`);
        if (r.impliedPct != null) console.log(`Implied vol: ${r.impliedPct.toFixed(1)}% (${r.impliedSource}) · ratio ${r.ratio.toFixed(2)}`);
        console.log(`Expected ±1σ move over ${r.days} days: forecast ${r.expectedMovePct.forecast?.toFixed(2)}%${r.expectedMovePct.implied != null ? ` · implied ${r.expectedMovePct.implied.toFixed(2)}%` : ''}`);
        console.log(r.reading);
      });
  run.catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
