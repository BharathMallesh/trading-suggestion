#!/usr/bin/env node
// Signal odds for the VWAP + 20 MA pullback strategy (library + CLI).
//
// When the video's rules fire, what is the chance THIS trade ends in profit
// after costs? Every past signal on the 20 strategy stocks (saved 5-minute
// history) is labelled win / loss, and the win rate is broken down by the
// conditions at the signal:
//   daily trend   with / against the trade (stock vs its 20-day average)
//   morning move  with / against / flat (move from yesterday's close by 09:30)
//   NIFTY         same side of its 20 MA + VWAP / opposite / mixed
//   time          before 10:30 / 10:30–12:00 / after 12:00
//   volatility    ATR as % of price above / below the median
// Each condition's win rate is shrunk toward the overall rate (few signals →
// small adjustment) and combined on the log-odds scale with a damping factor
// (conditions overlap, so adding them all in full would over-count).
//
// Honest check: fitted on the first half of the sessions, scored on the second
// half (Brier score vs simply using the overall win rate). The adjusted odds
// are shown only if they beat the overall rate out of sample; otherwise the
// app shows the overall rate alone. Re-tested weekly as history grows.
// Research / paper only — not a signal to trade.
//
//   node paper-bot/vwap-odds.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';
import { EVAL_UNIVERSE, VIDEO_STOCKS } from './config.mjs';
import { RULES, backtestStock, niftyContext, dailyContext, withStore } from './vwap-pullback.mjs';

const FILE = () => process.env.VWAP_ODDS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'vwap-odds.json');
export const SHRINK = 30; // pseudo-signals pulling each condition toward the overall rate
export const DAMP = 0.6; // share of each condition's log-odds shift that is applied

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clampP = (p) => Math.min(0.97, Math.max(0.03, p));

/** Condition levels for one signal (null = unknown). `atrMedian` from the training signals. */
export function conditions(t, atrMedian) {
  const dir = t.side === 'long' ? 1 : -1;
  const f = t.feat || {};
  const g = f.gapPct == null ? null : dir * f.gapPct;
  return {
    dailyTrend: f.dailyUp == null ? null : (t.side === 'long') === f.dailyUp ? 'with' : 'against',
    morningMove: g == null ? null : g >= 0.5 ? 'with' : g <= -0.5 ? 'against' : 'flat',
    nifty: f.niftySide == null ? null : f.niftySide === dir ? 'with' : f.niftySide === -dir ? 'against' : 'mixed',
    time: t.time < '10:30' ? 'early' : t.time < '12:00' ? 'midday' : 'late',
    volatility: f.atrPct == null || atrMedian == null ? null : f.atrPct >= atrMedian ? 'high' : 'low',
  };
}
export const LABELS = {
  dailyTrend: { name: 'Daily trend', with: 'with the trade', against: 'against the trade' },
  morningMove: { name: 'Move by 09:30', with: '≥ 0.5% with the trade', against: '≥ 0.5% against', flat: 'small (< 0.5%)' },
  nifty: { name: 'NIFTY', with: 'same side of 20 MA + VWAP', against: 'opposite side', mixed: 'mixed' },
  time: { name: 'Time of signal', early: 'before 10:30', midday: '10:30–12:00', late: 'after 12:00' },
  volatility: { name: 'Volatility (ATR %)', high: 'above median', low: 'below median' },
};

const win = (t) => t.net > 0;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : null;
};

/** Fit the per-condition win rates on `trades`. */
export function fitOdds(trades, { shrink = SHRINK, damp = DAMP } = {}) {
  const n = trades.length;
  const w = trades.filter(win).length;
  const base = (w + 1) / (n + 2);
  const atrMedian = median(trades.map((t) => t.feat?.atrPct).filter((x) => x != null));
  const table = {};
  for (const t of trades) {
    for (const [k, lvl] of Object.entries(conditions(t, atrMedian))) {
      if (lvl == null) continue;
      table[k] ||= {};
      table[k][lvl] ||= { n: 0, w: 0 };
      table[k][lvl].n++;
      if (win(t)) table[k][lvl].w++;
    }
  }
  for (const k of Object.keys(table)) {
    for (const c of Object.values(table[k])) {
      c.rawRate = c.w / c.n;
      c.rate = (c.w + shrink * base) / (c.n + shrink);
      c.shift = logit(clampP(c.rate)) - logit(clampP(base));
    }
  }
  return { n, wins: w, base, atrMedian, table, shrink, damp };
}

/** Chance this signal ends in profit after costs, with the conditions that moved it. */
export function predictOdds(model, t) {
  const cond = conditions(t, model.atrMedian);
  let x = logit(clampP(model.base));
  const reasons = [];
  for (const [k, lvl] of Object.entries(cond)) {
    const c = lvl == null ? null : model.table[k]?.[lvl];
    if (!c) continue;
    x += model.damp * c.shift;
    reasons.push({ condition: LABELS[k].name, level: LABELS[k][lvl], winRate: c.rawRate, signals: c.n, shift: model.damp * c.shift });
  }
  return { prob: sigmoid(x), base: model.base, reasons: reasons.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)) };
}

const brier = (ps, ys) => ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length;

/** Out-of-sample check: fit on the first half of the dates, score the second half. */
export function evaluateOdds(trades, opts = {}) {
  const dates = [...new Set(trades.map((t) => t.date))].sort();
  const mid = dates[dates.length >> 1];
  const train = trades.filter((t) => t.date < mid);
  const test = trades.filter((t) => t.date >= mid);
  if (train.length < 60 || test.length < 60) return { enough: false, train: train.length, test: test.length, splitDate: mid };
  const m = fitOdds(train, opts);
  const ys = test.map((t) => (win(t) ? 1 : 0));
  const pModel = test.map((t) => predictOdds(m, t).prob);
  const bModel = brier(pModel, ys);
  const bBase = brier(test.map(() => m.base), ys);
  // do high-odds signals actually win more? split the test signals at the median prediction
  const med = median(pModel);
  // ties at the median (few distinct odds) go to whichever side keeps both halves non-empty
  const above = pModel.some((p) => p > med);
  const hi = test.filter((_, i) => (above ? pModel[i] > med : pModel[i] >= med));
  const lo = test.filter((_, i) => (above ? pModel[i] <= med : pModel[i] < med));
  const rate = (a) => (a.length ? a.filter(win).length / a.length : null);
  const avg = (a) => (a.length ? a.reduce((x, t) => x + t.net, 0) / a.length : null);
  const skill = 1 - bModel / bBase;
  return {
    enough: true, splitDate: mid, train: train.length, test: test.length,
    trainWinRate: m.base, testWinRate: rate(test),
    brierModel: bModel, brierBase: bBase, skill,
    higherOdds: { signals: hi.length, winRate: rate(hi), avgNetRs: avg(hi) },
    lowerOdds: { signals: lo.length, winRate: rate(lo), avgNetRs: avg(lo) },
    adopt: skill > 0.005 && rate(hi) > rate(lo),
  };
}

/** Every video-rules signal on the strategy stocks over the saved history. */
export async function signalHistory({ loadCandles = candles, stocks = [...new Set([...VIDEO_STOCKS, ...EVAL_UNIVERSE])] } = {}) {
  const get = withStore(loadCandles);
  const p1 = Math.floor(Date.now() / 1000) - 59 * 86400;
  const nifty = await niftyContext(get, p1);
  const per = await mapLimit(stocks, 4, async (s) => {
    try {
      const rows = (await get(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
      return rows.length > 500 ? backtestStock(s, rows, RULES, { nifty, daily: await dailyContext(loadCandles, s) }) : [];
    } catch {
      return [];
    }
  });
  // finished trades only (today's still-open trades have no outcome yet)
  return per.flat().filter((t) => t.reason !== 'close');
}

/** Build, test and save the model. */
export async function runOdds(opts = {}) {
  const trades = await signalHistory(opts);
  const ev = evaluateOdds(trades);
  const model = fitOdds(trades); // final model on all signals (used only if adopted)
  const dates = [...new Set(trades.map((t) => t.date))].sort();
  const out = {
    at: new Date().toISOString(), signals: trades.length, sessions: dates.length, from: dates[0], to: dates[dates.length - 1],
    evaluation: ev, adopted: !!ev.adopt, model,
    note: 'Chance that a video-rules signal ends in profit after costs, from every past signal on 20 stocks. Adjusted for conditions only if that beat the plain win rate on unseen days; re-tested weekly. Paper research — not a signal to trade.',
  };
  writeJsonAtomic(FILE(), out);
  return out;
}

export function loadOdds() {
  try {
    return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Odds for a live / recorded trade from the saved model: adjusted if adopted, else the plain win rate. */
export function oddsFor(t, saved = loadOdds()) {
  if (!saved?.model) return null;
  if (!saved.adopted) return { prob: saved.model.base, base: saved.model.base, adjusted: false, reasons: [] };
  return { ...predictOdds(saved.model, t), adjusted: true };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOdds()
    .then((r) => {
      const p = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
      console.log(`\nSIGNAL ODDS · ${r.signals} finished signals · ${r.sessions} sessions (${r.from} → ${r.to})`);
      console.log(`Overall: ${p(r.model.base)} of signals ended in profit after costs.`);
      for (const [k, levels] of Object.entries(r.model.table)) {
        console.log(`  ${LABELS[k].name}: ${Object.entries(levels).map(([l, c]) => `${LABELS[k][l]} ${p(c.rawRate)} (${c.n})`).join(' · ')}`);
      }
      const e = r.evaluation;
      if (!e.enough) console.log(`\nNot enough signals for the out-of-sample check (${e.train} / ${e.test}).`);
      else {
        console.log(`\nOut of sample (fit before ${e.splitDate}, scored after): Brier ${e.brierModel.toFixed(4)} vs plain rate ${e.brierBase.toFixed(4)} → skill ${(e.skill * 100).toFixed(1)}%`);
        console.log(`  higher-odds half: ${e.higherOdds.signals} signals, won ${p(e.higherOdds.winRate)}, avg ₹${Math.round(e.higherOdds.avgNetRs)}`);
        console.log(`  lower-odds half:  ${e.lowerOdds.signals} signals, won ${p(e.lowerOdds.winRate)}, avg ₹${Math.round(e.lowerOdds.avgNetRs)}`);
      }
      console.log(`\n${r.adopted ? 'ADOPTED: live signals show condition-adjusted odds.' : 'NOT adopted: live signals show the plain win rate only.'}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
