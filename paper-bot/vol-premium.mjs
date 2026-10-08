#!/usr/bin/env node
// Volatility-premium test (library + CLI): is selling NIFTY options — i.e.
// "selling insurance" — profitable after Indian costs, and how bad are the
// bad weeks? The one area where a real, documented edge is plausible: option
// prices usually assume bigger moves than actually happen.
//
// Replay (≈10 years, every 5 sessions, no look-ahead):
//   - Price weekly NIFTY options with Black-Scholes at IV = India VIX (VIX is
//     the 30-day implied vol; real weekly IV differs — see the 0.9× stress row).
//   - Settle at the actual NIFTY close 5 sessions later (cash-settled intrinsic).
//   Strategies, fixed in advance:
//     S1 short ATM straddle (unlimited risk)
//     S2 short iron fly: S1 + bought wings ±3% away (max loss capped)
//     S3 S2 only when premium looks rich: VIX ÷ HAR forecast vol above its
//        own past median (known at the time)
//   Costs per leg: ₹20 brokerage, STT 0.1% of premium on sales, NSE 0.03503%,
//   SEBI, stamp 0.003% on buys, GST 18%, STT 0.125% of intrinsic on exercised
//   long legs, plus slippage max(0.5% of premium, 0.5 pt) per trade.
//   Capital: S1 ≈ 11% of notional (SPAN + exposure margin); S2/S3 = wing width.
//   Account view: a third of the account is posted as margin each week, the
//   rest sits in a liquid fund — full-account sizing is ruin-prone.
// Verdict rule: "edge" only if mean weekly P&L after costs > 0 with t ≥ 2 AND
// positive in both halves. Tail risk is always reported next to it.
// Research only — paper only, not a recommendation to sell options.
//
// Real-price check (--real): the same strategies on ACTUAL NIFTY weekly
// option closing prices from NSE's daily F&O bhavcopy archive (2019 →, when
// weekly options began), held to the weekly expiry and settled at NIFTY's
// close. This removes the "priced at VIX" assumption. Only the few NIFTY rows
// needed are cached (paper-bot/data/fo-bhav/).
//
//   node paper-bot/vol-premium.mjs           # VIX-priced model (fast)
//   node paper-bot/vol-premium.mjs --real    # + real option prices (first run downloads ~350 days)
//   node paper-bot/vol-premium.mjs --save    # both, saved; updates the weekly IV ratio (weekly refit)

import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { candles } from '../market-data.mjs';
import { greeks } from '../blackscholes.mjs';
import { harForecast, updateVolModel } from './volatility.mjs';
import { HttpError } from '../util.mjs';

export const VP_ASSUMPTIONS = {
  holdSessions: 5,
  strikeStep: 50,
  wingPct: 3,
  lotSize: 75,
  brokeragePerOrder: 20,
  sttSellPct: 0.1,
  sttExercisePct: 0.125,
  exchangePct: 0.03503,
  sebiPct: 0.0001,
  stampBuyPct: 0.003,
  gstPct: 18,
  slippagePct: 0.5,
  slippageMinPts: 0.5,
  marginPctNaked: 11,
  accountMarginShare: 1 / 3, // share of the account posted as margin; the rest earns the liquid-fund rate
  liquidYield: 0.06,
  rate: 0.065,
};

const roundTo = (x, step) => Math.round(x / step) * step;

/** Costs (index points per unit) for one opening trade of one leg. */
export function legCosts({ side, premium, a = VP_ASSUMPTIONS }) {
  const value = premium; // per unit
  const brokerage = a.brokeragePerOrder / a.lotSize;
  const stt = side === 'sell' ? (value * a.sttSellPct) / 100 : 0;
  const exchange = (value * a.exchangePct) / 100;
  const sebi = (value * a.sebiPct) / 100;
  const stamp = side === 'buy' ? (value * a.stampBuyPct) / 100 : 0;
  const gst = ((brokerage + exchange + sebi) * a.gstPct) / 100;
  const slippage = Math.max((premium * a.slippagePct) / 100, a.slippageMinPts);
  return brokerage + stt + exchange + sebi + stamp + gst + slippage;
}

/**
 * One position's P&L (index points per unit, after costs).
 * legs: [{ type: 'CE'|'PE', strike, side: 'sell'|'buy' }]
 */
export function positionPnl({ legs, spot, settle, iv, days, a = VP_ASSUMPTIONS }) {
  let pnl = 0;
  let credit = 0;
  for (const l of legs) {
    const premium = greeks({ spot, strike: l.strike, tYears: days / 365, iv, type: l.type, rate: a.rate }).price;
    const intrinsic = l.type === 'CE' ? Math.max(settle - l.strike, 0) : Math.max(l.strike - settle, 0);
    const sign = l.side === 'sell' ? 1 : -1;
    credit += sign * premium;
    pnl += sign * (premium - intrinsic) - legCosts({ side: l.side, premium, a });
    if (l.side === 'buy' && intrinsic > 0) pnl -= (intrinsic * a.sttExercisePct) / 100;
  }
  return { pnl, credit };
}

function summarise(trades, a = VP_ASSUMPTIONS) {
  const r = trades.map((t) => t.ret);
  const n = r.length;
  if (n < 10) return null;
  const mean = r.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(r.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1));
  // Account curve: margin share at risk, the rest in a liquid fund; a week
  // that loses more than the account ends it.
  const liquidWk = (1 + a.liquidYield) ** (1 / 52) - 1;
  let eq = 1;
  let peak = 1;
  let maxDD = 0;
  const acct = [];
  for (const x of r) {
    const ar = x * a.accountMarginShare + (1 - a.accountMarginShare) * liquidWk;
    acct.push(ar);
    eq = Math.max(0, eq * (1 + ar));
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
  }
  // Calendar span (S3 skips weeks; its idle weeks earn nothing extra here, so this is conservative)
  const years = Math.max(n, (Date.parse(trades[n - 1].date) - Date.parse(trades[0].date)) / (7 * 86400000) + 1) / 52;
  const am = acct.reduce((x, y) => x + y, 0) / n;
  const asd = Math.sqrt(acct.reduce((x, y) => x + (y - am) ** 2, 0) / (n - 1));
  const sorted = [...trades].sort((x, y) => x.ret - y.ret);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  return {
    weeks: n,
    meanWeeklyPct: mean * 100,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
    winRatePct: (wins.length / n) * 100,
    avgWinPct: wins.length ? (wins.reduce((x, y) => x + y, 0) / wins.length) * 100 : 0,
    avgLossPct: losses.length ? (losses.reduce((x, y) => x + y, 0) / losses.length) * 100 : 0,
    worstWeekPct: sorted[0].ret * 100,
    worstWeekDate: sorted[0].date,
    worst5: sorted.slice(0, 5).map((t) => ({ date: t.date, retPct: t.ret * 100, niftyMovePct: t.movePct })),
    accountCagrPct: (eq ** (1 / years) - 1) * 100,
    accountSharpe: asd > 0 ? ((am - liquidWk) / asd) * Math.sqrt(52) : null,
    accountMaxDrawdownPct: maxDD * 100,
    accountWorstWeekPct: Math.min(...acct) * 100,
    worstWeekInAvgWeeks: mean > 0 ? Math.abs(sorted[0].ret) / mean : null,
  };
}

function judge(all, first, second) {
  if (!all || !first || !second) return 'not enough data';
  const edge = all.tStat >= 2 && first.meanWeeklyPct > 0 && second.meanWeeklyPct > 0;
  return edge ? 'edge after costs (both halves positive, t ≥ 2)' : all.meanWeeklyPct > 0 ? 'positive, but not reliable (fails t ≥ 2 or a half)' : 'loses money after costs';
}

/** Run the replay. `ivScale` lets a stress test price options below VIX. */
export async function volPremiumTest({ loadCandles = candles, a = VP_ASSUMPTIONS } = {}) {
  const nifty = (await loadCandles('^NSEI', { range: '10y', interval: '1d' })).filter((r) => r.close > 0);
  const vixRows = await loadCandles('^INDIAVIX', { range: '10y', interval: '1d' });
  const vix = new Map(vixRows.filter((r) => r.close > 0).map((r) => [r.date, r.close]));
  if (nifty.length < 500 || vix.size < 400) throw new HttpError(503, 'Not enough NIFTY / India VIX history for the test.');
  const logR = nifty.slice(1).map((r, i) => Math.log(r.close / nifty[i].close));
  const h = a.holdSessions;
  const runs = { S1: [], S2: [], S3: [], S1stress: [], S2stress: [] };
  const ratios = [];
  const vrp = [];
  for (let i = 300; i + h < nifty.length; i += h) {
    const d = nifty[i].date;
    const v = vix.get(d);
    if (!v) continue;
    const spot = nifty[i].close;
    const settle = nifty[i + h].close;
    const days = Math.max(1, Math.round((Date.parse(nifty[i + h].date) - Date.parse(d)) / 86400000));
    const iv = v / 100;
    const K = roundTo(spot, a.strikeStep);
    const w = roundTo((spot * a.wingPct) / 100, a.strikeStep);
    const straddle = [{ type: 'CE', strike: K, side: 'sell' }, { type: 'PE', strike: K, side: 'sell' }];
    const fly = [...straddle, { type: 'CE', strike: K + w, side: 'buy' }, { type: 'PE', strike: K - w, side: 'buy' }];
    const movePct = (settle / spot - 1) * 100;
    // realised vol over the hold, annualised — for the plain premium comparison
    const realised = Math.sqrt(logR.slice(i, i + h).reduce((s, x) => s + x * x, 0) / h) * Math.sqrt(252) * 100;
    vrp.push({ implied: v, realised });

    const s1 = positionPnl({ legs: straddle, spot, settle, iv, days, a });
    runs.S1.push({ date: d, ret: s1.pnl / (spot * a.marginPctNaked / 100), movePct });
    const s2 = positionPnl({ legs: fly, spot, settle, iv, days, a });
    const flyCapital = Math.max(1, w - s2.credit); // max loss ≈ wing − net credit
    runs.S2.push({ date: d, ret: s2.pnl / flyCapital, movePct });
    const s1s = positionPnl({ legs: straddle, spot, settle, iv: iv * 0.9, days, a });
    runs.S1stress.push({ date: d, ret: s1s.pnl / (spot * a.marginPctNaked / 100), movePct });
    const st = positionPnl({ legs: fly, spot, settle, iv: iv * 0.9, days, a });
    runs.S2stress.push({ date: d, ret: st.pnl / Math.max(1, w - st.credit), movePct });

    // S3: trade only when VIX is rich vs the HAR forecast (median of PAST ratios)
    const f = harForecast(logR.slice(0, i), h);
    if (f) {
      const ratio = iv / (f * Math.sqrt(252));
      const past = [...ratios].sort((x, y) => x - y);
      if (past.length >= 26 && ratio > past[past.length >> 1]) runs.S3.push({ date: d, ret: s2.pnl / flyCapital, movePct });
      ratios.push(ratio);
    }
  }
  const out = {};
  const names = {
    S1: 'S1 · short ATM straddle (unhedged)',
    S2: 'S2 · short iron fly, wings ±3% (risk capped)',
    S3: 'S3 · S2 only when VIX is rich vs forecast',
    S1stress: 'S1 stress · options priced at 0.9 × VIX',
    S2stress: 'S2 stress · options priced at 0.9 × VIX',
  };
  for (const [k, t] of Object.entries(runs)) {
    const mid = Math.floor(t.length / 2);
    const all = summarise(t, a);
    const first = summarise(t.slice(0, mid), a);
    const second = summarise(t.slice(mid), a);
    out[k] = { name: names[k], all, firstHalf: first, secondHalf: second, verdict: judge(all, first, second) };
  }
  // An edge that vanishes when options are priced 10% cheaper isn't robust.
  for (const [k, sk] of [['S1', 'S1stress'], ['S2', 'S2stress'], ['S3', 'S2stress']]) {
    if (out[k].verdict.startsWith('edge') && !out[sk].verdict.startsWith('edge')) {
      out[k].verdict = 'edge on paper, but NOT robust: disappears if options are priced 10% below VIX';
    }
  }
  const avg = (k) => vrp.reduce((s, x) => s + x[k], 0) / vrp.length;
  return {
    from: runs.S1[0]?.date,
    to: runs.S1[runs.S1.length - 1]?.date,
    premium: {
      avgImpliedPct: avg('implied'),
      avgRealisedPct: avg('realised'),
      pctWeeksImpliedAbove: (vrp.filter((x) => x.implied > x.realised).length / vrp.length) * 100,
    },
    strategies: out,
    assumptions: a,
    rule: 'Edge only if mean weekly P&L after costs > 0 with t ≥ 2, positive in both halves, AND it survives pricing options at 0.9 × VIX. Weekly returns are on margin (S1 ≈ 11% of notional; S2/S3 = max loss); account figures post a third of the account as margin.',
    caveats: [
      'Options are priced from India VIX (30-day implied vol). Real weekly options often trade at a different IV and with skew (OTM puts dearer) — the 0.9× row shows how sensitive the result is.',
      'NIFTY weekly expiries and lot sizes have changed over the years; this replay uses a fixed 5-session hold and today\'s lot size and charges.',
      'Short options can lose many weeks of profit in one week (see worst weeks). Margin calls and gap risk are real. Paper research only — not a recommendation.',
    ],
  };
}


// ------------------------------------------------- real NSE option prices ---

const FO_DIR = process.env.FO_BHAV_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data', 'fo-bhav');
const run = promisify(execFile);
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export class FoBlockedError extends Error {}

function bhavUrls(date) {
  const [y, m, d] = date.split('-');
  const neu = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
  const old = `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip`;
  return date >= '2024-07-08' ? [neu, old] : [old, neu];
}

const isoFromOld = (s) => {
  const [d, mon, y] = s.split('-');
  return `${y}-${String(MON.indexOf(mon.toUpperCase()) + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
};

/** NIFTY index options from one bhavcopy CSV (either format) → {expiry: {strike: {CE, PE, ceVol, peVol}}, underlying}. */
export function parseFoBhav(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(Boolean);
  const head = lines[0].split(',');
  const col = (n) => head.indexOf(n);
  const out = { underlying: null, expiries: {} };
  const neu = col('TckrSymb') >= 0;
  const c = neu
    ? { sym: col('TckrSymb'), tp: col('FinInstrmTp'), exp: col('XpryDt'), k: col('StrkPric'), opt: col('OptnTp'), close: col('ClsPric'), vol: col('TtlTradgVol'), und: col('UndrlygPric') }
    : { sym: col('SYMBOL'), tp: col('INSTRUMENT'), exp: col('EXPIRY_DT'), k: col('STRIKE_PR'), opt: col('OPTION_TYP'), close: col('CLOSE'), vol: col('CONTRACTS'), und: -1 };
  for (const l of lines.slice(1)) {
    const f = l.split(',');
    if (f[c.sym] !== 'NIFTY') continue;
    if (neu ? f[c.tp] !== 'IDO' : f[c.tp] !== 'OPTIDX') continue;
    const exp = neu ? f[c.exp] : isoFromOld(f[c.exp]);
    const k = Number(f[c.k]);
    const typ = f[c.opt];
    if (typ !== 'CE' && typ !== 'PE') continue;
    const e = (out.expiries[exp] ||= {});
    const row = (e[k] ||= {});
    row[typ] = Number(f[c.close]);
    row[typ === 'CE' ? 'ceVol' : 'peVol'] = Number(f[c.vol]) || 0;
    if (c.und >= 0 && !out.underlying) out.underlying = Number(f[c.und]) || null;
  }
  return Object.keys(out.expiries).length ? out : null;
}

/**
 * NIFTY option closes for one date, keeping only the nearest expiry within
 * 10 days (cached). null = no file (holiday). Blocks throw FoBlockedError.
 */
export async function foBhav(date, { fetchFn = fetch } = {}) {
  const f = join(FO_DIR, `${date}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let parsed = null;
  let sawFile = false;
  for (const url of bhavUrls(date)) {
    let res;
    let buf = null;
    // NSE sometimes drops a connection mid-file ("terminated"): retry a few times.
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
        if (res.status === 403 || res.status === 429) throw new FoBlockedError('NSE is temporarily blocking downloads — try again later (cached days are kept).');
        if (!res.ok) break;
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof FoBlockedError) throw err;
        buf = null;
      }
    }
    if (!res) return null; // network: retry another time
    if (!res.ok) continue;
    if (!buf) return null; // kept failing mid-download: don't cache
    if (buf.slice(0, 2).toString() !== 'PK') {
      if (/Access Denied/i.test(buf.toString('utf8', 0, 500))) throw new FoBlockedError('NSE is temporarily blocking downloads — try again later.');
      continue;
    }
    sawFile = true;
    const tmp = join(tmpdir(), `fo-${date}-${process.pid}.zip`);
    writeFileSync(tmp, buf);
    try {
      const { stdout } = await run('unzip', ['-p', tmp], { maxBuffer: 200 * 1024 * 1024 });
      parsed = parseFoBhav(stdout);
    } finally {
      unlinkSync(tmp);
    }
    break;
  }
  if (!sawFile) {
    mkdirSync(FO_DIR, { recursive: true });
    writeFileSync(f, 'null'); // genuine "no file for this date"
    return null;
  }
  if (!parsed) return null; // unexpected format: don't cache
  const near = Object.keys(parsed.expiries).filter((e) => e > date && (Date.parse(e) - Date.parse(date)) / 86400000 <= 10).sort();
  const keep = { underlying: parsed.underlying, expiries: {} };
  for (const e of near.slice(0, 2)) keep.expiries[e] = parsed.expiries[e];
  mkdirSync(FO_DIR, { recursive: true });
  writeFileSync(f, JSON.stringify(keep));
  return keep;
}

/** Nearest listed strike with a traded price for `typ`. */
function nearestStrike(chain, target, typ) {
  let best = null;
  for (const [k, row] of Object.entries(chain)) {
    const vol = typ === 'CE' ? row.ceVol : row.peVol;
    if (!(row[typ] > 0) || !(vol > 0)) continue;
    if (best == null || Math.abs(k - target) < Math.abs(best - target)) best = Number(k);
  }
  return best;
}

/**
 * Same strategies on real weekly option prices. Entry = the session after each
 * weekly expiry (so a full week is held); exit = expiry, settled at NIFTY close.
 */
export async function realPremiumTest({ loadCandles = candles, fetchFn = fetch, a = VP_ASSUMPTIONS, onProgress = () => {}, from = '2019-03-01' } = {}) {
  const nifty = (await loadCandles('^NSEI', { range: '10y', interval: '1d' })).filter((r) => r.close > 0);
  const vixRows = await loadCandles('^INDIAVIX', { range: '10y', interval: '1d' });
  const vix = new Map(vixRows.filter((r) => r.close > 0).map((r) => [r.date, r.close]));
  const closeOn = new Map(nifty.map((r) => [r.date, r.close]));
  const logR = nifty.slice(1).map((r, i) => Math.log(r.close / nifty[i].close));
  const idx = new Map(nifty.map((r, i) => [r.date, i]));
  const trades = { S1: [], S2: [], S3: [] };
  const ivRatio = [];
  const ratios = [];
  let blocked = null;
  let i = nifty.findIndex((r) => r.date >= from);
  let fetched = 0;
  while (i >= 0 && i < nifty.length - 1) {
    const d = nifty[i].date;
    let day;
    try {
      const cached = existsSync(join(FO_DIR, `${d}.json`));
      day = await foBhav(d, { fetchFn });
      if (!cached && fetchFn === fetch) await new Promise((r) => setTimeout(r, 250));
      if (!cached) onProgress(++fetched, d);
    } catch (err) {
      if (err instanceof FoBlockedError) {
        blocked = err.message;
        break;
      }
      throw err;
    }
    const expiry = day && Object.keys(day.expiries).sort()[0];
    const settle = expiry && closeOn.get(expiry);
    if (!day || !expiry || !settle || expiry <= d) {
      i++;
      continue;
    }
    const spot = day.underlying || nifty[i].close;
    const chain = day.expiries[expiry];
    const K = nearestStrike(chain, spot, 'CE');
    const days = Math.max(1, Math.round((Date.parse(expiry) - Date.parse(d)) / 86400000));
    if (K != null && chain[K]?.PE > 0 && chain[K]?.peVol > 0) {
      const w = roundTo((spot * a.wingPct) / 100, a.strikeStep);
      const kc = nearestStrike(chain, K + w, 'CE');
      const kp = nearestStrike(chain, K - w, 'PE');
      const legs = [
        { type: 'CE', strike: K, side: 'sell', premium: chain[K].CE },
        { type: 'PE', strike: K, side: 'sell', premium: chain[K].PE },
      ];
      const pnlOf = (ls) => ls.reduce((s, l) => {
        const intrinsic = l.type === 'CE' ? Math.max(settle - l.strike, 0) : Math.max(l.strike - settle, 0);
        const sign = l.side === 'sell' ? 1 : -1;
        let p = sign * (l.premium - intrinsic) - legCosts({ side: l.side, premium: l.premium, a });
        if (l.side === 'buy' && intrinsic > 0) p -= (intrinsic * a.sttExercisePct) / 100;
        return s + p;
      }, 0);
      const movePct = (settle / spot - 1) * 100;
      trades.S1.push({ date: d, ret: pnlOf(legs) / ((spot * a.marginPctNaked) / 100), movePct });
      // implied vol of the real straddle (≈ 0.8·S·σ·√T) vs VIX that day
      const straddle = chain[K].CE + chain[K].PE;
      const iv = straddle / (0.7979 * spot * Math.sqrt(days / 365));
      if (vix.get(d)) ivRatio.push({ date: d, ratio: iv / (vix.get(d) / 100) });
      if (kc != null && kp != null && kc > K && kp < K) {
        const fly = [...legs, { type: 'CE', strike: kc, side: 'buy', premium: chain[kc].CE }, { type: 'PE', strike: kp, side: 'buy', premium: chain[kp].PE }];
        const credit = fly.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
        const cap = Math.max(1, Math.max(kc - K, K - kp) - credit);
        const r = pnlOf(fly) / cap;
        trades.S2.push({ date: d, ret: r, movePct });
        const f = harForecast(logR.slice(0, idx.get(d)), Math.max(1, Math.round(days * 5 / 7)));
        if (f) {
          const ratio = iv / (f * Math.sqrt(252));
          const past = [...ratios].sort((x, y) => x - y);
          if (past.length >= 26 && ratio > past[past.length >> 1]) trades.S3.push({ date: d, ret: r, movePct });
          ratios.push(ratio);
        }
      }
    }
    // next entry: first session after this expiry
    const next = nifty.findIndex((r) => r.date > expiry);
    i = next > i ? next : i + 1;
  }
  const out = {};
  const names = {
    S1: 'S1 · short ATM straddle (real prices)',
    S2: 'S2 · short iron fly ±3% (real prices)',
    S3: 'S3 · S2 only when premium is rich (real prices)',
  };
  for (const [k, t] of Object.entries(trades)) {
    const mid = Math.floor(t.length / 2);
    const all = summarise(t, a);
    const first = summarise(t.slice(0, mid), a);
    const second = summarise(t.slice(mid), a);
    out[k] = { name: names[k], all, firstHalf: first, secondHalf: second, verdict: judge(all, first, second) };
  }
  const med = (a) => {
    const t = [...a].sort((x, y) => x - y);
    return t.length ? t[t.length >> 1] : null;
  };
  const sorted = ivRatio.map((x) => x.ratio).sort((x, y) => x - y);
  const recent = ivRatio.slice(-52);
  return {
    from: trades.S1[0]?.date,
    to: trades.S1[trades.S1.length - 1]?.date,
    weeks: trades.S1.length,
    weeklyIvVsVix: sorted.length
      ? {
        median: sorted[sorted.length >> 1], p25: sorted[Math.floor(sorted.length * 0.25)], p75: sorted[Math.floor(sorted.length * 0.75)], n: sorted.length,
        recentMedian: med(recent.map((x) => x.ratio)), recentN: recent.length, from: ivRatio[0].date, to: ivRatio[ivRatio.length - 1].date,
      }
      : null,
    strategies: out,
    blocked,
    note: 'Actual NSE closing prices of the nearest weekly NIFTY options, entered the session after each expiry and held to the next expiry. Closing prices ignore the bid-ask spread, which is charged separately as slippage.',
  };
}

// ------------------------------------------------------------ save / load ---

const SAVED = join(dirname(fileURLToPath(import.meta.url)), 'data', 'vol-premium.json');

/** Run both replays (VIX-priced model + real prices) and save the result. */
export async function runAndSaveVolPremium(opts = {}) {
  const model = await volPremiumTest(opts);
  let real = null;
  try {
    real = await realPremiumTest(opts);
  } catch (err) {
    real = { error: err.message };
  }
  const r = { at: new Date().toISOString(), model, real, verdict: overallVerdict(model, real) };
  // Keep the payoff-odds card's weekly pricing in step with real prices.
  const w = real?.weeklyIvVsVix;
  if (w?.recentN >= 20) updateVolModel({ niftyWeeklyIvToVix: { ...w, fittedAt: r.at } });
  mkdirSync(dirname(SAVED), { recursive: true });
  writeFileSync(SAVED, JSON.stringify(r, null, 2));
  return r;
}

export function loadVolPremium() {
  try {
    return existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** One-line conclusion; real prices outrank the VIX-priced model. */
export function overallVerdict(model, real) {
  const rs = real?.strategies;
  if (rs?.S2?.all) {
    const edge = ['S1', 'S2', 'S3'].filter((k) => rs[k]?.verdict?.startsWith('edge'));
    return edge.length
      ? `On real NSE prices, ${edge.map((k) => rs[k].name.split(' · ')[0]).join(', ')} showed an edge after costs (t ≥ 2, both halves) — paper-test it forward before trusting it; tail risk is large.`
      : 'On real NSE prices, no strategy showed a reliable edge after costs.';
  }
  return 'Only the VIX-priced model is available; its edge depends on pricing assumptions — not enough to act on.';
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--save')) {
  // Weekly refit: fetch new NSE days, re-run both replays, update the weekly IV ratio.
  runAndSaveVolPremium({})
    .then((r) => {
      const w = r.real?.weeklyIvVsVix;
      console.log(`${r.verdict}${w ? ` · weekly IV = ${w.recentMedian.toFixed(2)} × VIX (last ${w.recentN} weeks to ${w.to})` : ''}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  volPremiumTest()
    .then((r) => {
      console.log(`\nVOLATILITY PREMIUM · NIFTY weekly · ${r.from} → ${r.to}`);
      console.log(`India VIX averaged ${r.premium.avgImpliedPct.toFixed(1)}% vs realised ${r.premium.avgRealisedPct.toFixed(1)}% over the next 5 sessions; implied was higher in ${r.premium.pctWeeksImpliedAbove.toFixed(0)}% of weeks.\n`);
      console.log(`${'strategy'.padEnd(44)} weeks  mean/wk    t   win%  worst wk | account: CAGR  Sharpe  maxDD  worst wk | halves (mean/wk)`);
      for (const s of Object.values(r.strategies)) {
        const x = s.all;
        if (!x) continue;
        console.log(`${s.name.padEnd(44)} ${String(x.weeks).padStart(5)} ${x.meanWeeklyPct.toFixed(2).padStart(7)}% ${x.tStat.toFixed(2).padStart(5)} ${x.winRatePct.toFixed(0).padStart(5)}% ${x.worstWeekPct.toFixed(1).padStart(8)}% | ${x.accountCagrPct.toFixed(1).padStart(12)}% ${x.accountSharpe?.toFixed(2).padStart(6)} ${x.accountMaxDrawdownPct.toFixed(0).padStart(5)}% ${x.accountWorstWeekPct.toFixed(1).padStart(8)}% | ${s.firstHalf.meanWeeklyPct.toFixed(2)} / ${s.secondHalf.meanWeeklyPct.toFixed(2)}`);
        console.log(`   → ${s.verdict}`);
      }
      console.log(`\n${r.rule}\n${r.caveats.join('\n')}`);
      if (!process.argv.includes('--real')) return;
      console.log('\nREAL NSE OPTION PRICES (downloading any missing days, ~0.5 s each)…');
      return realPremiumTest({ onProgress: (n, d) => process.stdout.write(`  downloaded ${n} days (at ${d})…\r`) }).then((x) => {
        console.log(`\n${x.weeks} weekly trades · ${x.from} → ${x.to}${x.blocked ? ` · PARTIAL: ${x.blocked}` : ''}`);
        if (x.weeklyIvVsVix) console.log(`Real weekly ATM implied vol ÷ India VIX: median ${x.weeklyIvVsVix.median.toFixed(2)} (middle half ${x.weeklyIvVsVix.p25.toFixed(2)}–${x.weeklyIvVsVix.p75.toFixed(2)}, n ${x.weeklyIvVsVix.n})`);
        for (const s of Object.values(x.strategies)) {
          const y = s.all;
          if (!y) continue;
          console.log(`${s.name.padEnd(44)} ${String(y.weeks).padStart(5)} ${y.meanWeeklyPct.toFixed(2).padStart(7)}% ${y.tStat.toFixed(2).padStart(5)} ${y.winRatePct.toFixed(0).padStart(5)}% ${y.worstWeekPct.toFixed(1).padStart(8)}% | ${y.accountCagrPct.toFixed(1).padStart(12)}% ${y.accountSharpe?.toFixed(2).padStart(6)} ${y.accountMaxDrawdownPct.toFixed(0).padStart(5)}% ${y.accountWorstWeekPct.toFixed(1).padStart(8)}% | ${s.firstHalf.meanWeeklyPct.toFixed(2)} / ${s.secondHalf.meanWeeklyPct.toFixed(2)}`);
          console.log(`   → ${s.verdict}`);
        }
        console.log(x.note);
      });
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
