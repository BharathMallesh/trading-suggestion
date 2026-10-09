#!/usr/bin/env node
// Next 30–40 minutes (library + CLI): can the app say whether a stock goes up
// or down over the next ~35 minutes? Yahoo keeps 60 days of 5-minute bars, so
// this uses the last ~60 sessions for the evaluation universe + holdout + NIFTY.
//
//   Label: move over the next 7 bars (35 min), same rule as everywhere
//   (UP / DOWN beyond max(0.15%, 0.35×ATR), else SIDEWAYS).
//   1. The app's current 5-minute probabilities (calibrated table or base
//      rates) vs trailing base rates — Brier, top-call hit rate, reliability.
//   2. A model built for this horizon (multinomial logistic): last-30-min
//      return, return since the open, NIFTY's last 30 min, time of day.
//      Fitted on the FIRST half of the sessions, judged on the SECOND half
//      and on the holdout stocks; date-clustered paired t.
//   3. Intraday momentum (published pattern): does the first 30 minutes'
//      return predict the last 30 minutes'? Per stock-day, plus NIFTY alone.
//   Adoption rule (fixed in advance): t ≤ −2 out of sample AND holdout
//   improves AND the up-call hit rate beats 50% after a 0.05% round-trip cost.
// Research only — not investment advice.
//
//   node paper-bot/intraday-test.mjs

import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore } from './groww-predict.mjs';
import { calibratedProbs, loadCalibration } from './calibration.mjs';
import { labelMove, brier, HOLDOUT_UNIVERSE } from './evaluate.mjs';
import { EVAL_UNIVERSE } from './config.mjs';
import { clusteredT } from './prob-improve.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';

const SAVED = () => process.env.INTRADAY_TEST_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'intraday-test.json');
export const H = Number(process.env.INTRADAY_H) || 7; // bars of 5 min (7 = 35 minutes)
const KEYS = ['probUp', 'probDown', 'probSideways'];
const LABELS = ['UP', 'DOWN', 'SIDEWAYS'];
const day = (r) => String(r.date).slice(0, 10);
const avg = (rows, f) => rows.reduce((a, x) => a + f(x), 0) / (rows.length || 1);

/** Group 5-minute rows by session. */
function sessions(rows) {
  const out = new Map();
  for (const r of rows) {
    const d = day(r);
    if (!out.has(d)) out.set(d, []);
    out.get(d).push(r);
  }
  return [...out.entries()].map(([date, bars]) => ({ date, bars })).filter((s) => s.bars.length >= 60);
}

// ---------------------------------------- tiny multinomial logistic model ---

export function fitSoftmax(X, y, { iters = 300, lr = 0.5, l2 = 1e-3 } = {}) {
  const k = 3;
  const d = X[0].length;
  const W = Array.from({ length: k }, () => new Array(d).fill(0));
  for (let it = 0; it < iters; it++) {
    const G = Array.from({ length: k }, () => new Array(d).fill(0));
    for (let n = 0; n < X.length; n++) {
      const z = W.map((w) => w.reduce((a, wi, j) => a + wi * X[n][j], 0));
      const m = Math.max(...z);
      const e = z.map((v) => Math.exp(v - m));
      const s = e.reduce((a, b) => a + b, 0);
      for (let c = 0; c < k; c++) {
        const g = e[c] / s - (y[n] === c ? 1 : 0);
        for (let j = 0; j < d; j++) G[c][j] += g * X[n][j];
      }
    }
    for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) W[c][j] -= lr * (G[c][j] / X.length + l2 * W[c][j]);
  }
  return W;
}

export function predictSoftmax(W, x) {
  const z = W.map((w) => w.reduce((a, wi, j) => a + wi * x[j], 0));
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return { probUp: e[0] / s, probDown: e[1] / s, probSideways: e[2] / s };
}

// ------------------------------------------------------------------ test ---

export async function intradayTest({ loadCandles = candles } = {}) {
  const load = async (list, group) => (await mapLimit(list, 4, async (sym) => {
    try {
      // Yahoo keeps ~60 days of 5-minute bars: ask for the last 59 by explicit dates
      const rows = (await loadCandles(sym, { period1: Math.floor(Date.now() / 1000) - 59 * 86400, interval: '5m' })).filter((r) => r.close > 0);
      return rows.length > 1000 ? { sym, group, ss: sessions(rows) } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const nifty = (await load(['^NSEI'], 'index'))[0] || null;
  const all = [...(await load(EVAL_UNIVERSE, 'main')), ...(await load(HOLDOUT_UNIVERSE, 'holdout'))];
  const niftyByTime = new Map();
  if (nifty) for (const s of nifty.ss) s.bars.forEach((b, i) => niftyByTime.set(b.date, { s, i }));
  const cal = loadCalibration();
  const samples = [];
  const momentum = [];
  for (const st of all) {
    const flat = st.ss.flatMap((s) => s.bars);
    const pos = new Map(flat.map((b, i) => [b.date, i]));
    const pastLabels = []; // for trailing base rates (strictly earlier samples)
    for (const s of st.ss) {
      const b = s.bars;
      const open = b[0].open || b[0].close;
      // 3. intraday momentum: first 30 min (6 bars) vs last 30 min (last 6 bars)
      if (b.length >= 70) momentum.push({ group: st.group, date: s.date, first: b[5].close / open - 1, last: b[b.length - 1].close / b[b.length - 7].close - 1 });
      for (let i = 6; i + H < b.length; i += 3) {
        const gi = pos.get(b[i].date);
        if (gi < 60) continue;
        const win = flat.slice(gi - 59, gi + 1);
        const ind = computeIndicators(win);
        const close = b[i].close;
        const label = labelMove(((b[i + H].close - close) / close) * 100, ind.atr14, close);
        const score = techScore(ind);
        const app = calibratedProbs('5m', score, cal)?.probs || cal['5m']?.climatology || { probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 };
        const cnt = { UP: 1, DOWN: 1, SIDEWAYS: 1 };
        for (const l of pastLabels.slice(-400)) cnt[l]++;
        const tot = cnt.UP + cnt.DOWN + cnt.SIDEWAYS;
        const base = { probUp: cnt.UP / tot, probDown: cnt.DOWN / tot, probSideways: cnt.SIDEWAYS / tot };
        const n0 = niftyByTime.get(b[i].date);
        const nifty30 = n0 && n0.i >= 6 ? n0.s.bars[n0.i].close / n0.s.bars[n0.i - 6].close - 1 : 0;
        const x = [1, (close / b[i - 6].close - 1) * 100, (close / open - 1) * 100, nifty30 * 100, i / b.length, (ind.atr14 / close) * 100];
        // recent 5-minute volatility (last 12 bars, same session where possible)
        const rr = [];
        for (let k = gi - 11; k <= gi; k++) rr.push(Math.log(flat[k].close / flat[k - 1].close));
        const vol5 = Math.sqrt(rr.reduce((a, v) => a + v * v, 0) / rr.length);
        samples.push({ group: st.group, date: s.date, label, y: LABELS.indexOf(label), app, base, x, ret: (b[i + H].close - close) / close, vol5, slot: Math.min(5, Math.floor(i / 13)) });
        pastLabels.push(label);
      }
    }
  }
  if (!samples.length) throw new Error('No intraday data (Yahoo 5-minute history unavailable).');
  const dates = [...new Set(samples.map((x) => x.date))].sort();
  const mid = dates[dates.length >> 1];
  const first = samples.filter((x) => x.group === 'main' && x.date < mid);
  const second = samples.filter((x) => x.group === 'main' && x.date >= mid);
  const hold = samples.filter((x) => x.group === 'holdout' && x.date >= mid);

  // 1. the app's current probabilities
  const appVsBase = (rows) => {
    const t = clusteredT(rows, (x) => brier(x.app, x.label), (x) => brier(x.base, x.label));
    const top = (p) => LABELS[KEYS.indexOf(KEYS.reduce((a, k) => (p[k] > p[a] ? k : a), 'probUp'))];
    return {
      n: rows.length, dates: t.n, brierApp: avg(rows, (x) => brier(x.app, x.label)), brierBase: avg(rows, (x) => brier(x.base, x.label)), t: t.t,
      topHitApp: avg(rows, (x) => (top(x.app) === x.label ? 1 : 0)), topHitBase: avg(rows, (x) => (top(x.base) === x.label ? 1 : 0)),
    };
  };
  const baseRates = Object.fromEntries(LABELS.map((l) => [l, avg(samples, (x) => (x.label === l ? 1 : 0))]));

  // 2. a model built for 35 minutes (standardise features on the training half)
  const d = first[0].x.length;
  const mu = Array.from({ length: d }, (_, j) => (j === 0 ? 0 : avg(first, (x) => x.x[j])));
  const sd = Array.from({ length: d }, (_, j) => (j === 0 ? 1 : Math.sqrt(avg(first, (x) => (x.x[j] - mu[j]) ** 2)) || 1));
  const z = (x) => x.map((v, j) => (j === 0 ? 1 : (v - mu[j]) / sd[j]));
  const W = fitSoftmax(first.map((x) => z(x.x)), first.map((x) => x.y));
  const model = (x) => predictSoftmax(W, z(x.x));
  const judge = (rows) => {
    const t = clusteredT(rows, (x) => brier(model(x), x.label), (x) => brier(x.base, x.label));
    // trade check: go long when the model's UP − DOWN > 10 points, short when < −10
    const calls = rows.map((x) => ({ x, p: model(x) })).filter(({ p }) => Math.abs(p.probUp - p.probDown) > 0.1);
    const pnl = calls.map(({ x, p }) => Math.sign(p.probUp - p.probDown) * x.ret - 0.0005);
    return {
      n: rows.length, dates: t.n, brierModel: avg(rows, (x) => brier(model(x), x.label)), brierBase: avg(rows, (x) => brier(x.base, x.label)), t: t.t,
      calls: calls.length, callHitRate: calls.length ? calls.filter(({ x, p }) => Math.sign(p.probUp - p.probDown) === Math.sign(x.ret)).length / calls.length : null,
      avgNetPerCallPct: pnl.length ? (pnl.reduce((a, b) => a + b, 0) / pnl.length) * 100 : null,
    };
  };
  const oos = judge(second);
  const ho = judge(hold);
  const adopt = oos.t != null && oos.t <= -2 && ho.brierModel < ho.brierBase && oos.callHitRate > 0.5 && oos.avgNetPerCallPct > 0;

  // 4. Size, not direction: chance of a move bigger than ±k% in the next H bars.
  // Model: recent 5-min vol × time-of-day factor (fitted on the first half) → normal
  // tail; baseline: the trailing frequency of such moves for that stock.
  const sizeTest = {};
  {
    const slotFactor = Array.from({ length: 6 }, (_, sl) => {
      const rows = first.filter((x) => x.slot === sl && x.vol5 > 0);
      const realised = Math.sqrt(avg(rows, (x) => Math.log(1 + x.ret) ** 2));
      const pred = avg(rows, (x) => x.vol5) * Math.sqrt(H);
      return pred > 0 ? realised / pred : 1;
    });
    const normCdf = (zv) => 0.5 * (1 + Math.sign(zv) * Math.sqrt(1 - Math.exp(-2 * zv * zv / Math.PI))); // close approximation
    for (const k of [0.3, 0.5, 1]) {
      const thr = Math.log(1 + k / 100);
      const rows = [];
      const hist = []; // trailing frequency (samples are in time order per stock)
      for (const x of samples) {
        const sigma = x.vol5 * Math.sqrt(H) * slotFactor[x.slot];
        const p = sigma > 0 ? 2 * (1 - normCdf(thr / sigma)) : 0;
        const y = Math.abs(x.ret) > k / 100 ? 1 : 0;
        const past = hist.slice(-400);
        const freq = (past.reduce((a, v) => a + v, 0) + 0.5) / (past.length + 1);
        rows.push({ group: x.group, date: x.date, p: Math.min(0.999, Math.max(0.001, p)), freq, y });
        hist.push(y);
      }
      const sec = rows.filter((r) => r.group === 'main' && r.date >= mid);
      const ho2 = rows.filter((r) => r.group === 'holdout' && r.date >= mid);
      const sc = (rr) => {
        const t = clusteredT(rr, (r) => (r.p - r.y) ** 2, (r) => (r.freq - r.y) ** 2);
        return { n: rr.length, happenedPct: avg(rr, (r) => r.y) * 100, statedPct: avg(rr, (r) => r.p) * 100, brierModel: avg(rr, (r) => (r.p - r.y) ** 2), brierBase: avg(rr, (r) => (r.freq - r.y) ** 2), t: t.t };
      };
      sizeTest[`${k}%`] = { outOfSample: sc(sec), holdout: sc(ho2) };
    }
  }

  // 3. intraday momentum
  const mom = (rows) => {
    if (rows.length < 20) return null;
    const agree = rows.filter((r) => Math.sign(r.first) === Math.sign(r.last) && r.last !== 0).length / rows.length;
    // per-date average of sign agreement → clustered
    const t = clusteredT(rows.map((r) => ({ ...r, a: Math.sign(r.first) * r.last })), (r) => -r.a, () => 0);
    return { n: rows.length, sameDirectionRate: agree, tStat: t.t == null ? null : -t.t, dates: t.n };
  };
  const niftyMom = nifty ? nifty.ss.filter((s) => s.bars.length >= 70).map((s) => ({ date: s.date, first: s.bars[5].close / (s.bars[0].open || s.bars[0].close) - 1, last: s.bars[s.bars.length - 1].close / s.bars[s.bars.length - 7].close - 1 })) : [];

  return {
    at: new Date().toISOString(),
    horizonMinutes: H * 5,
    sessions: dates.length,
    from: dates[0],
    to: dates[dates.length - 1],
    baseRates,
    currentApp: { secondHalf: appVsBase(second), holdout: appVsBase(hold) },
    model35m: { trainedOn: `sessions before ${mid}`, outOfSample: oos, holdout: ho, adopt },
    intradayMomentum: { stocks: mom(momentum.filter((r) => r.group !== 'index')), nifty: mom(niftyMom) },
    sizeTest,
    rule: 'A 35-minute model is adopted only if, on the later half of the sessions, it beats trailing base rates with a date-clustered t ≤ −2, also improves on holdout stocks, its confident up/down calls are right more than 50% of the time, and they make money after a 0.05% round-trip cost.',
  };
}

export function saveIntradayTest(r) {
  writeJsonAtomic(SAVED(), r);
}
export function loadIntradayTest() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  intradayTest()
    .then((r) => {
      saveIntradayTest(r);
      const p = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
      console.log(`\nNEXT ${r.horizonMinutes} MINUTES · ${r.sessions} sessions · ${r.from} → ${r.to}`);
      console.log(`Base rates: UP ${p(r.baseRates.UP)} · DOWN ${p(r.baseRates.DOWN)} · SIDEWAYS ${p(r.baseRates.SIDEWAYS)}`);
      for (const [k, v] of Object.entries(r.currentApp)) console.log(`App today (${k}): Brier ${v.brierApp.toFixed(4)} vs base rates ${v.brierBase.toFixed(4)} (t ${v.t?.toFixed(2)}, ${v.dates} dates) · top call right ${p(v.topHitApp)} vs ${p(v.topHitBase)}`);
      const m = r.model35m;
      for (const [k, v] of [['out of sample', m.outOfSample], ['holdout', m.holdout]]) console.log(`35-min model (${k}): Brier ${v.brierModel.toFixed(4)} vs base ${v.brierBase.toFixed(4)} (t ${v.t?.toFixed(2)}) · ${v.calls} confident calls, right ${p(v.callHitRate)}, avg ${v.avgNetPerCallPct?.toFixed(3)}% per call after costs`);
      console.log(`→ ${m.adopt ? 'ADOPTED' : 'not adopted'}`);
      const im = r.intradayMomentum;
      if (im.stocks) console.log(`Intraday momentum, stocks: first 30 min and last 30 min same direction ${p(im.stocks.sameDirectionRate)} of ${im.stocks.n} stock-days (t ${im.stocks.tStat?.toFixed(2)}, ${im.stocks.dates} dates)`);
      if (im.nifty) console.log(`Intraday momentum, NIFTY: same direction ${p(im.nifty.sameDirectionRate)} of ${im.nifty.n} days (t ${im.nifty.tStat?.toFixed(2)})`);
      for (const [k, v] of Object.entries(r.sizeTest || {})) console.log(`Move bigger than ±${k} in ${r.horizonMinutes} min: said ${v.outOfSample.statedPct.toFixed(1)}% → happened ${v.outOfSample.happenedPct.toFixed(1)}% · Brier ${v.outOfSample.brierModel.toFixed(4)} vs trailing frequency ${v.outOfSample.brierBase.toFixed(4)} (t ${v.outOfSample.t?.toFixed(2)}) · holdout ${v.holdout.brierModel.toFixed(4)} vs ${v.holdout.brierBase.toFixed(4)} (t ${v.holdout.t?.toFixed(2)})`);
      console.log(r.rule);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
