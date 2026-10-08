#!/usr/bin/env node
// Options positioning test (library + CLI): do NIFTY options positioning
// signals predict NIFTY's next move? Data: NSE's daily F&O bhavcopy (every
// NIFTY option's close, volume and open interest), 2019 → today. Per day only
// the derived signals are cached (paper-bot/data/fo-positioning/).
//
// Signals, fixed in advance:
//   pcrOi    put ÷ call open interest, all NIFTY options
//   pcrOiZ   its z-score vs the previous 60 sessions
//   pcrVol   put ÷ call volume
//   netDoi   (put OI added − call OI added) ÷ total OI
//   skew     implied vol of a ~3% OTM put − a ~3% OTM call (vol points),
//            nearest expiry ≥ 3 days away
//   skewZ    its z-score vs the previous 60 sessions
// Test: rank correlation (IC) with NIFTY's next 1-day / 5-day return
// (non-overlapping), t-stat, both halves. 12 tests → "strong" needs
// |t| ≥ 2.9 (Bonferroni, 5% ÷ 12) AND the same sign in both halves.
// Research only — not investment advice.
//
//   node paper-bot/options-positioning.mjs        # download missing days (~20–40 min first time) + test

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { greeks } from '../blackscholes.mjs';
import { spearman } from './ranking.mjs';
import { downloadBhav, parseFoBhav, FoBlockedError } from './vol-premium.mjs';
import { mapLimit } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.FO_POS_DIR || join(HERE, 'data', 'fo-positioning');
const SAVED = () => process.env.FO_POS_RESULT || join(HERE, 'data', 'options-positioning.json');
export const FEATURES = ['pcrOi', 'pcrOiZ', 'pcrVol', 'netDoi', 'skew', 'skewZ'];
export const HORIZONS = [1, 5];
export const STRONG_T = 2.9; // 5% ÷ 12 tests (two-sided) ≈ |t| 2.87

/** Black-Scholes implied vol by bisection (null if the price is outside bounds). */
export function impliedVol({ price, spot, strike, tYears, type }) {
  if (!(price > 0) || !(tYears > 0)) return null;
  const at = (v) => greeks({ spot, strike, tYears, iv: v, type }).price;
  let lo = 0.01;
  let hi = 3;
  if (price < at(lo) || price > at(hi)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Signals for one day from a parsed bhavcopy (parseFoBhav) and NIFTY's close. */
export function dayFeatures(parsed, spot, date) {
  let ceOi = 0;
  let peOi = 0;
  let ceVol = 0;
  let peVol = 0;
  let ceDoi = 0;
  let peDoi = 0;
  for (const chain of Object.values(parsed.expiries)) {
    for (const r of Object.values(chain)) {
      ceOi += r.ceOi || 0;
      peOi += r.peOi || 0;
      ceVol += r.ceVol || 0;
      peVol += r.peVol || 0;
      ceDoi += r.ceDoi || 0;
      peDoi += r.peDoi || 0;
    }
  }
  const s = parsed.underlying || spot;
  // skew on the nearest expiry at least 3 days away
  const exp = Object.keys(parsed.expiries).filter((e) => (Date.parse(e) - Date.parse(date)) / 86400000 >= 3).sort()[0];
  let skew = null;
  let atmIv = null;
  if (exp && s > 0) {
    const chain = parsed.expiries[exp];
    const t = (Date.parse(exp) - Date.parse(date)) / 86400000 / 365;
    const pick = (target, typ) => {
      let best = null;
      for (const [k, r] of Object.entries(chain)) {
        if (!(r[typ] > 0) || !((typ === 'CE' ? r.ceVol : r.peVol) > 0)) continue;
        if (best == null || Math.abs(k - target) < Math.abs(best - target)) best = Number(k);
      }
      return best;
    };
    const kp = pick(s * 0.97, 'PE');
    const kc = pick(s * 1.03, 'CE');
    const ka = pick(s, 'CE');
    const ivP = kp != null ? impliedVol({ price: chain[kp].PE, spot: s, strike: kp, tYears: t, type: 'PE' }) : null;
    const ivC = kc != null ? impliedVol({ price: chain[kc].CE, spot: s, strike: kc, tYears: t, type: 'CE' }) : null;
    if (ivP && ivC) skew = (ivP - ivC) * 100;
    const ivA = ka != null ? impliedVol({ price: chain[ka].CE, spot: s, strike: ka, tYears: t, type: 'CE' }) : null;
    if (ivA) atmIv = ivA * 100;
  }
  return {
    date,
    spot: s,
    pcrOi: ceOi ? peOi / ceOi : null,
    pcrVol: ceVol ? peVol / ceVol : null,
    netDoi: ceOi + peOi ? (peDoi - ceDoi) / (ceOi + peOi) : null,
    skew,
    atmIv,
  };
}

/** One day's signals (cached). null = holiday / no file. */
export async function positioningDay(date, spot, { fetchFn = fetch } = {}) {
  const f = join(DIR(), `${date}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const d = await downloadBhav(date, { fetchFn });
  if (!d) return undefined; // network trouble: not cached, retry later
  let out = null;
  if (!d.missing) {
    const parsed = parseFoBhav(d.csv);
    if (!parsed) return undefined;
    out = dayFeatures(parsed, spot, date);
  }
  mkdirSync(DIR(), { recursive: true });
  writeFileSync(f, JSON.stringify(out));
  return out;
}

/** Add 60-session z-scores (past only). */
export function withZ(series, key, out, n = 60) {
  return series.map((x, i) => {
    const past = series.slice(Math.max(0, i - n), i).map((y) => y[key]).filter((v) => v != null);
    if (past.length < 40 || x[key] == null) return { ...x, [out]: null };
    const m = past.reduce((a, b) => a + b, 0) / past.length;
    const sd = Math.sqrt(past.reduce((a, b) => a + (b - m) ** 2, 0) / past.length);
    return { ...x, [out]: sd > 0 ? (x[key] - m) / sd : null };
  });
}

/** IC / t / halves for each feature and horizon. */
export function evaluate(series, nifty) {
  const idx = new Map(nifty.map((r, i) => [r.date, i]));
  const horizons = {};
  for (const h of HORIZONS) {
    const pts = [];
    for (let k = 0; k < series.length; k += h) {
      const i = idx.get(series[k].date);
      if (i == null || i + h >= nifty.length) continue;
      pts.push({ ...series[k], fwd: nifty[i + h].close / nifty[i].close - 1 });
    }
    const features = {};
    for (const f of FEATURES) {
      const p = pts.filter((x) => x[f] != null && Number.isFinite(x[f]));
      if (p.length < 40) continue;
      const ic = spearman(p.map((x) => x[f]), p.map((x) => x.fwd));
      const half = p.length >> 1;
      const ic1 = spearman(p.slice(0, half).map((x) => x[f]), p.slice(0, half).map((x) => x.fwd));
      const ic2 = spearman(p.slice(half).map((x) => x[f]), p.slice(half).map((x) => x.fwd));
      const t = ic != null && Math.abs(ic) < 1 ? ic * Math.sqrt((p.length - 2) / (1 - ic * ic)) : null;
      const med = [...p].map((x) => x[f]).sort((a, b) => a - b)[p.length >> 1];
      const up = (a) => a.filter((x) => x.fwd > 0).length / (a.length || 1);
      const consistent = ic && ic1 && ic2 && Math.sign(ic) === Math.sign(ic1) && Math.sign(ic) === Math.sign(ic2);
      features[f] = {
        n: p.length, ic, tStat: t, icFirstHalf: ic1, icSecondHalf: ic2,
        upRateWhenHigh: up(p.filter((x) => x[f] > med)), upRateWhenLow: up(p.filter((x) => x[f] <= med)),
        evidence: !consistent ? 'none' : t != null && Math.abs(t) >= STRONG_T ? 'strong' : Math.abs(t) >= 2 ? 'weak (fails the multiple-testing bar)' : 'weak',
      };
    }
    horizons[`${h}d`] = { periods: pts.length, baseUpRate: pts.filter((x) => x.fwd > 0).length / (pts.length || 1), features };
  }
  return horizons;
}

/** OLS t-stat of x in y = a + b·x + c·control (control for a confounder). */
function partialT(y, x, c) {
  const n = y.length;
  const X = y.map((_, i) => [1, x[i], c[i]]);
  const XtX = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = [0, 1, 2].map((i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  // 3×3 inverse (Gauss-Jordan)
  const A = XtX.map((r, i) => [...r, ...[0, 1, 2].map((j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    const d = A[i][i];
    if (!d) return null;
    for (let j = 0; j < 6; j++) A[i][j] /= d;
    for (let r = 0; r < 3; r++) if (r !== i) {
      const f = A[r][i];
      for (let j = 0; j < 6; j++) A[r][j] -= f * A[i][j];
    }
  }
  const inv = A.map((r) => r.slice(3));
  const b = [0, 1, 2].map((i) => inv[i].reduce((s, v, j) => s + v * Xty[j], 0));
  const resid = y.map((v, k) => v - X[k].reduce((s, xv, j) => s + xv * b[j], 0));
  const s2 = resid.reduce((a, e) => a + e * e, 0) / (n - 3);
  return b[1] / Math.sqrt(s2 * inv[1][1]);
}

/**
 * Robustness for a next-day signal, fixed in advance:
 *  tradable: IC with NIFTY's NEXT session open→close (the data is published
 *            after the close, so that is the first move you could act on)
 *  control:  t of the signal after controlling for the same day's NIFTY return
 *            (rules out plain "a fall bounces back")
 * Passes only if both have t ≥ 2 with the original sign.
 */
export function robustness(series, nifty, f) {
  const idx = new Map(nifty.map((r, i) => [r.date, i]));
  const pts = [];
  for (const x of series) {
    const i = idx.get(x.date);
    if (i == null || i < 1 || i + 1 >= nifty.length || x[f] == null) continue;
    const n1 = nifty[i + 1];
    if (!(n1.open > 0)) continue;
    pts.push({ v: x[f], oc: n1.close / n1.open - 1, cc: n1.close / nifty[i].close - 1, today: nifty[i].close / nifty[i - 1].close - 1 });
  }
  const tOf = (ic, n) => (ic != null && Math.abs(ic) < 1 ? ic * Math.sqrt((n - 2) / (1 - ic * ic)) : null);
  const icOc = spearman(pts.map((p) => p.v), pts.map((p) => p.oc));
  const icCc = spearman(pts.map((p) => p.v), pts.map((p) => p.cc));
  const tOc = tOf(icOc, pts.length);
  const tCtl = partialT(pts.map((p) => p.cc), pts.map((p) => p.v), pts.map((p) => p.today));
  const sign = Math.sign(icCc);
  const pass = tOc != null && tCtl != null && Math.sign(tOc) === sign && Math.sign(tCtl) === sign && Math.abs(tOc) >= 2 && Math.abs(tCtl) >= 2;
  return {
    feature: f,
    n: pts.length,
    icCloseToClose: icCc,
    icNextOpenToClose: icOc,
    tNextOpenToClose: tOc,
    tAfterControllingTodaysMove: tCtl,
    corrWithTodaysMove: spearman(pts.map((p) => p.v), pts.map((p) => p.today)),
    verdict: pass ? 'survives both checks — a candidate for forward testing' : 'does not survive: likely a closing-price / reversal artifact, not a tradable signal',
  };
}

/** Where today's reading sits in its own history (percentile). */
function percentile(series, key, v) {
  const a = series.map((x) => x[key]).filter((x) => x != null);
  return v == null || !a.length ? null : (a.filter((x) => x <= v).length / a.length) * 100;
}

export async function testPositioning({ from = '2019-03-01', loadCandles = candles, fetchFn = fetch, onProgress = () => {}, concurrency = 3 } = {}) {
  const nifty = (await loadCandles('^NSEI', { range: '10y', interval: '1d' })).filter((r) => r.close > 0);
  const days = nifty.filter((r) => r.date >= from);
  let blocked = null;
  let done = 0;
  const rows = await mapLimit(days, concurrency, async (r) => {
    if (blocked) return null;
    try {
      const cached = existsSync(join(DIR(), `${r.date}.json`));
      const x = await positioningDay(r.date, r.close, { fetchFn });
      if (!cached && fetchFn === fetch) await new Promise((res) => setTimeout(res, 200));
      if (++done % 50 === 0) onProgress(done, days.length);
      return x || null;
    } catch (err) {
      if (err instanceof FoBlockedError) blocked = err.message;
      return null;
    }
  });
  let series = rows.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  if (series.length < 250) throw new Error(`Only ${series.length} days of options data available.${blocked ? ' ' + blocked : ''}`);
  series = withZ(withZ(series, 'pcrOi', 'pcrOiZ'), 'skew', 'skewZ');
  const horizons = evaluate(series, nifty);
  const latest = series[series.length - 1];
  const strongList = Object.entries(horizons).flatMap(([h, x]) => Object.entries(x.features).filter(([, v]) => v.evidence === 'strong').map(([f]) => ({ f, h })));
  const strong = strongList.map(({ f, h }) => `${f} (${h})`);
  const checks = strongList.filter(({ h }) => h === '1d').map(({ f }) => robustness(series, nifty, f));
  const survivors = checks.filter((c) => c.verdict.startsWith('survives'));
  return {
    at: new Date().toISOString(),
    days: series.length,
    from: series[0].date,
    to: latest.date,
    blocked,
    horizons,
    latest: {
      ...latest,
      percentiles: Object.fromEntries(['pcrOi', 'pcrVol', 'netDoi', 'skew', 'atmIv'].map((k) => [k, percentile(series, k, latest[k])])),
    },
    robustness: checks,
    verdict: !strong.length
      ? 'No positioning signal passes the bar: put-call ratios, OI changes and skew did not reliably predict NIFTY\'s next day or week.'
      : survivors.length
        ? `${survivors.map((c) => c.feature).join(', ')} passed the strict bar AND the tradability / reversal checks — a candidate to forward-test, not yet something to act on.`
        : `${strong.join(', ')} passed the strict bar, but not the tradability / reversal checks — most likely a closing-price or "a fall bounces back" artifact, not a usable signal.`,
    rule: `IC = rank correlation with NIFTY's next 1-day / 5-day return (non-overlapping). "strong" needs |t| ≥ ${STRONG_T} (12 tests, Bonferroni) AND the same sign in both halves.`,
  };
}

export function saveResult(r) {
  mkdirSync(dirname(SAVED()), { recursive: true });
  writeFileSync(SAVED(), JSON.stringify(r, null, 2));
}
export function loadResult() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  testPositioning({ onProgress: (d, t) => process.stdout.write(`  ${d}/${t} days…\r`) })
    .then((r) => {
      saveResult(r);
      console.log(`\nOPTIONS POSITIONING · ${r.days} sessions · ${r.from} → ${r.to}${r.blocked ? ` · PARTIAL: ${r.blocked}` : ''}`);
      for (const [h, x] of Object.entries(r.horizons)) {
        console.log(`\nNext ${h} · ${x.periods} periods · NIFTY up ${(x.baseUpRate * 100).toFixed(0)}%`);
        console.log('feature      IC       t    1st / 2nd half    up% high / low   evidence');
        for (const [f, v] of Object.entries(x.features)) {
          console.log(`${f.padEnd(10)} ${v.ic.toFixed(3).padStart(6)} ${v.tStat.toFixed(2).padStart(6)}   ${v.icFirstHalf.toFixed(3).padStart(6)} / ${v.icSecondHalf.toFixed(3).padEnd(6)}   ${(v.upRateWhenHigh * 100).toFixed(0).padStart(3)}% / ${(v.upRateWhenLow * 100).toFixed(0)}%      ${v.evidence}`);
        }
      }
      const l = r.latest;
      console.log(`\nLatest ${l.date}: PCR(OI) ${l.pcrOi?.toFixed(2)} (${l.percentiles.pcrOi?.toFixed(0)}th pct) · skew ${l.skew?.toFixed(1)} pts (${l.percentiles.skew?.toFixed(0)}th) · ATM IV ${l.atmIv?.toFixed(1)}%`);
      for (const c of r.robustness || []) console.log(`Robustness ${c.feature}: next open→close IC ${c.icNextOpenToClose.toFixed(3)} (t ${c.tNextOpenToClose.toFixed(2)}) · after controlling for today's move t ${c.tAfterControllingTodaysMove.toFixed(2)} · corr with today's move ${c.corrWithTodaysMove.toFixed(2)} → ${c.verdict}`);
      console.log(`${r.verdict}\n${r.rule}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
