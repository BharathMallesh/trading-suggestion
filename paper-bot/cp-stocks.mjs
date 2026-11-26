#!/usr/bin/env node
// Call / Put tournament — STOCKS (library + CLI). PAPER ONLY, no broker orders. Not advice.
//
// The NIFTY tournament (cp-tournament.mjs) extended to individual F&O stocks, with the same honesty rules: every
// contestant is frozen code with a version hash, calls are made before the 09:15 open from data that was final before
// it, they are scored forward only in the evening, and a leader is "proven" only after a multiple-testing correction.
//
// UNIVERSE (frozen, point in time, decided from the evening before): the 20 F&O stocks (NSE F&O stock file of the
// last session before the day) with the highest total traded value over the 20 NSE sessions before the day (NSE
// bhavcopy, paper-bot/data/bhav-eq). A stock on the avoid list that day (avoid-list.mjs) or on its own stock-option
// expiry day (the expiries NSE lists for it, or expiry.mjs 'STOCKS') is left out and the next one fills its place.
// Stock options expire together (monthly), so on the stock-option expiry day the league has no stocks at all.
//
// What the evidence says (memory of the research loops): stock options are monthly and physically settled; on ₹1 lakh
// only option BUYING is possible; in every tested setup realised volatility was BELOW implied (buyers pay a premium);
// company news is mostly priced in at the open (the HFCL case study: order news gapped up then fell open → close).
// So the most likely outcome is that no contestant is ever proven.
//
// SCORING (evening, forward only): direction hit vs the stock's own open → close and open → 5th close; separately
// whether the stock BEAT NIFTY in the called direction (a stock call can be right only because the market moved);
// Brier skill vs the stock's own base rate; a paper option P&L PROXY with ₹2,000 at risk on ₹1 lakh: the ATM monthly
// option's premium from the prior NSE bhav, changed by stock move × 0.5 delta (daily data has no option open price),
// minus option costs (STT 0.15% on the sale from 1 Apr 2026, ₹20 an order, GST, slippage). It ignores time decay and
// IV changes — optimistic for a buyer. Never on the stock's expiry day. Results are pooled across stocks and per stock;
// t-statistics and the p-values used for "proven" are clustered by date (stocks on one day move together).
//
//   node paper-bot/cp-stocks.mjs --prepare                      # evening: cache the next session's universe + inputs
//   node paper-bot/cp-stocks.mjs --predict                      # morning (after the NIFTY tournament), stops at 09:05
//   node paper-bot/cp-stocks.mjs --predict --date 2026-11-27    # a TEST entry (shown, never scored)
//   node paper-bot/cp-stocks.mjs --score                        # evening: score every outstanding day

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { normCdf } from '../blackscholes.mjs';
import { isTradingDay, tradingDaysBetween, lastSessionDate } from './market-calendar.mjs';
import { isExpiryDay, sessionFor } from './expiry.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore, baseProbabilities } from './groww-predict.mjs';
import { calibratedProbs, loadCalibration } from './calibration.mjs';
import { bigMove } from './big-move.mjs';
import { seededIndex } from './news-pick.mjs';
import { sttSell } from './fo-strangle.mjs';
import { loadAvoidList } from './avoid-list.mjs';
import { wilson, brier, brierSkill, tStat, holm, bh, cutoffFor, preOpen, CLOSE_TIME } from './cp-tournament.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = () => join(HERE, 'data');
const STATE = () => process.env.CP_STOCKS_PATH || join(DATA(), 'cp-stocks.json');
const PREP = () => process.env.CP_STOCKS_PREP_PATH || join(DATA(), 'cp-stocks-prep.json');
const FO_DIRS = () => (process.env.FO_STOCKS_DIRS ? process.env.FO_STOCKS_DIRS.split(':') : [join(DATA(), 'fo-stocks'), join(DATA(), 'fo-stocks-hist')]);
const NIFTY_STATE = () => process.env.CP_TOURNAMENT_PATH || join(DATA(), 'cp-tournament.json');

export const ST = {
  universeSize: 20,
  liquiditySessions: 20,
  minLiquiditySessions: 15,
  openMins: 555, // 09:15 IST
  stopMins: 545, // 09:05 IST: the morning run stops here (stocks not reached are skipped)
  capital: 100000,
  riskRs: 2000,
  delta: 0.5,
  lean: 0.03,
  minCalls: 300,
  minDays: 60,
  alpha: 0.05,
  baseRateSessions: 500,
  barsKeep: 620,
  bigMovePct: { day: 2, five: 4 },
  slippagePct: 0.5,
  slippageMin: 0.05,
  brokeragePerOrder: 20,
};
export const NOTE = 'Paper only — no broker orders. Not advice.';
export const UNIVERSE_RULE = `The ${ST.universeSize} F&O stocks (NSE F&O stock file of the last session before the day) with the highest total traded value over the ${ST.liquiditySessions} NSE sessions before the day (NSE bhavcopy); a stock on the avoid list that day or on its own stock-option expiry day is left out and the next one takes its place. Decided from the evening before.`;
export const WHY_VS_NIFTY = 'Each stock call is scored twice: against the stock\'s own move, and against NIFTY (did the stock beat NIFTY in the called direction?). Stocks mostly move with the market, so a CALL on a day NIFTY rose can be "right" with no stock skill at all — the vs-NIFTY score shows whether a contestant knows anything about the stock itself.';
export const PNL_NOTE = `P&L is a PROXY, not a real fill: ₹${ST.riskRs.toLocaleString('en-IN')} of premium at risk on ₹1 lakh, in the ATM monthly stock option (premium from the prior NSE bhav), changed by the stock's move × ${ST.delta} delta (NSE daily files have no option open price), minus option costs (STT 0.15% of premium on the sale from 1 Apr 2026, ₹20 an order, exchange fees, GST, 0.5% slippage). It ignores time decay and IV changes, so it flatters a buyer. Never on the stock's expiry day (physically settled).`;
export const EVIDENCE = 'Stock options are monthly and physically settled; on ₹1 lakh only option buying is possible; realised volatility was below implied in every tested setup (buyers pay a premium); news is mostly priced in at the open (HFCL study: order news gapped up, then fell open → close).';
export const HORIZONS = { day: 'Today (open → close)', five: 'Next 5 sessions (open → 5th close)' };

// ------------------------------------------------------------------ time ---
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const istNow = (now) => {
  const s = new Date(now.getTime() + 19800_000).toISOString();
  return { date: s.slice(0, 10), mins: +s.slice(11, 13) * 60 + +s.slice(14, 16), hhmm: s.slice(11, 16) };
};
const prevSessions = (date, n) => {
  const out = [];
  for (let d = addDays(date, -1); out.length < n && d > addDays(date, -n * 3 - 30); d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
};
const sessionsFrom = (date, n) => tradingDaysBetween(date, addDays(date, n * 3 + 20)).slice(0, n);

// ------------------------------------------------------------------ small maths ---
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clampP = (p) => Math.min(0.99, Math.max(0.01, p));
const sma = (xs, n) => (xs.length >= n ? mean(xs.slice(-n)) : null);
/**
 * One-sided p-value that the hit rate beats `bar`, clustered by date: each day's (hits − bar × calls) is one
 * independent residual (stocks on the same day are correlated). Needs 2+ days.
 */
export function clusteredP(rows, bar) {
  const by = new Map();
  for (const r of rows) {
    const o = by.get(r.date) || { hits: 0, n: 0 };
    o.n++;
    if (r.hit) o.hits++;
    by.set(r.date, o);
  }
  const res = [...by.values()].map((o) => o.hits - bar * o.n);
  const G = res.length;
  if (G < 2) return null;
  const s = res.reduce((a, b) => a + b, 0);
  const v = res.reduce((a, b) => a + b * b, 0) * (G / (G - 1));
  if (!(v > 0)) return s > 0 ? 0 : 1;
  return 1 - normCdf(s / Math.sqrt(v));
}
/** t-statistic of the P&L summed per date (clustered by date). */
export function dayClusteredT(rows) {
  const by = new Map();
  for (const r of rows) if (r.pnl != null) by.set(r.date, (by.get(r.date) || 0) + r.pnl);
  return tStat([...by.values()]);
}

// ------------------------------------------------------------------ the universe (FROZEN) ---
/**
 * The point-in-time universe for `date`. Pure. `bars`: Map symbol → daily rows (only rows before `date` are used);
 * `foSymbols`: the F&O stock list known before `date`; `avoid`: avoid-list events [{ symbol, since, until, reason }];
 * `expiries`: symbol → its listed option expiry dates; `stockExpiry`: is `date` the NSE stock-option expiry day.
 */
export function selectUniverse({ date, foSymbols = [], bars = new Map(), avoid = [], expiries = {}, stockExpiry = false, size = ST.universeSize, sessions = ST.liquiditySessions, minSessions = ST.minLiquiditySessions }) {
  const window = new Set(prevSessions(date, sessions));
  const ranked = [];
  for (const sym of foSymbols) {
    const rows = (bars.get(sym) || []).filter((r) => r.date < date && window.has(r.date) && r.val > 0);
    if (rows.length < minSessions) continue;
    ranked.push({ symbol: sym, value: rows.reduce((a, r) => a + r.val, 0), sessions: rows.length });
  }
  ranked.sort((a, b) => b.value - a.value || (a.symbol < b.symbol ? -1 : 1));
  const universe = [];
  const excluded = [];
  for (const [i, r] of ranked.entries()) {
    if (universe.length >= size) break;
    const av = avoid.filter((e) => e.symbol === r.symbol && (e.since || e.date) <= date && e.until >= date);
    const xp = stockExpiry || (expiries[r.symbol] || []).includes(date);
    if (xp) excluded.push({ symbol: r.symbol, rank: i + 1, reason: 'stock-option expiry day' });
    else if (av.length) excluded.push({ symbol: r.symbol, rank: i + 1, reason: `avoid list: ${[...new Set(av.map((e) => e.reason))].join(', ')}` });
    else universe.push({ ...r, rank: i + 1 });
  }
  return { universe, excluded, considered: ranked.length, window: [...window] };
}

// ------------------------------------------------------------------ a call ---
const call = (c, pUp, conf, why) => ({ call: c, pUp: Math.round(clampP(pUp) * 1000) / 1000, conf: Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100, why: String(why).slice(0, 140) });
const both = (x) => ({ day: x, five: x });
const base = (inp, h = 'day') => inp.baseRate?.[h] ?? 0.5;
const leanCall = (inp, dir, why, h = 'day', conf = 0.1) => (dir > 0 ? call('CALL', base(inp, h) + ST.lean, conf, why) : dir < 0 ? call('PUT', base(inp, h) - ST.lean, conf, why) : call('NO TRADE', base(inp, h), 0, why));
const leanBoth = (inp, dir, why) => ({ day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') });

// ------------------------------------------------------------------ the contestants (FROZEN) ---
export const CONTESTANTS = [
  { id: 'always-call', name: 'Always CALL', group: 'baseline', deps: [], predict: (inp) => ({ day: call('CALL', base(inp), 0, 'always CALL'), five: call('CALL', base(inp, 'five'), 0, 'always CALL') }) },
  { id: 'always-put', name: 'Always PUT', group: 'baseline', deps: [], predict: (inp) => ({ day: call('PUT', base(inp), 0, 'always PUT'), five: call('PUT', base(inp, 'five'), 0, 'always PUT') }) },
  {
    id: 'coin', name: 'Coin flip (seeded by date + stock)', group: 'baseline', reuses: 'news-pick.mjs seededIndex', deps: [seededIndex],
    predict: (inp) => ({
      day: call(seededIndex(`${inp.date}|${inp.symbol}|coin|day`, 2) === 0 ? 'CALL' : 'PUT', 0.5, 0, 'coin flip'),
      five: call(seededIndex(`${inp.date}|${inp.symbol}|coin|five`, 2) === 0 ? 'CALL' : 'PUT', 0.5, 0, 'coin flip'),
    }),
  },
  {
    id: 'continuation', name: "Stock's last move (continuation)", group: 'baseline', deps: [],
    predict: (inp) => {
      const b = inp.bars;
      if (b.length < 2) return { skip: 'not enough daily bars' };
      const dir = Math.sign(b.at(-1).close - b.at(-2).close);
      return leanBoth(inp, dir, `${inp.symbol} ${dir > 0 ? 'rose' : dir < 0 ? 'fell' : 'was flat'} on ${b.at(-1).date}`);
    },
  },
  {
    id: 'reversal', name: "Opposite of the stock's last move (reversal)", group: 'baseline', deps: [],
    predict: (inp) => {
      const b = inp.bars;
      if (b.length < 2) return { skip: 'not enough daily bars' };
      const dir = -Math.sign(b.at(-1).close - b.at(-2).close);
      return leanBoth(inp, dir, `${inp.symbol} ${dir < 0 ? 'rose' : dir > 0 ? 'fell' : 'was flat'} on ${b.at(-1).date} → the other way`);
    },
  },
  {
    id: 'cp-model', name: 'Call/Put model (raw formula, stock daily bars)', group: 'model', reuses: 'groww-predict.mjs techScore + baseProbabilities, indicators.mjs computeIndicators', deps: [techScore, baseProbabilities, computeIndicators],
    predict: (inp) => {
      const rows = inp.bars.slice(-60);
      if (rows.length < 50) return { skip: 'fewer than 50 daily bars' };
      const s = techScore(computeIndicators(rows));
      const p = baseProbabilities(s);
      const pUp = p.probUp / (p.probUp + p.probDown);
      return both(call(s > 0 ? 'CALL' : s < 0 ? 'PUT' : 'NO TRADE', pUp, Math.abs(s), `technical score ${s.toFixed(2)} → formula up ${(pUp * 100).toFixed(0)}%`));
    },
  },
  {
    id: 'cp-calibrated', name: 'Call/Put model (calibrated 1d table)', group: 'model', reuses: 'calibration.mjs calibratedProbs on calibration.json 1d (read only)', deps: [techScore, calibratedProbs, computeIndicators],
    predict: (inp) => {
      const rows = inp.bars.slice(-60);
      if (rows.length < 50) return { skip: 'fewer than 50 daily bars' };
      const s = techScore(computeIndicators(rows));
      const t = calibratedProbs('1d', s, inp.cal || {});
      if (!t) return { skip: 'no validated 1d calibration table' };
      const pUp = t.probs.probUp / (t.probs.probUp + t.probs.probDown);
      return both(call(Math.abs(pUp - 0.5) < 0.005 ? 'NO TRADE' : pUp > 0.5 ? 'CALL' : 'PUT', pUp, Math.abs(pUp - 0.5) * 2, `score ${s.toFixed(2)} → calibrated up ${(pUp * 100).toFixed(1)}%`));
    },
  },
  {
    id: 'updown', name: 'Up/Down outlook lean (STRONG → CALL, WEAK → PUT)', group: 'model', reuses: 'updown-outlook.mjs live table (data/updown-live.json)', deps: [],
    predict: (inp) => {
      const u = inp.updown;
      if (!u) return { skip: 'no Up/Down outlook list before the open' };
      if (!u.label) return { skip: `not in the Up/Down top-200 list of ${u.date}` };
      const dir = u.label === 'strong' ? 1 : u.label === 'weak' ? -1 : 0;
      return leanBoth(inp, dir, `Up/Down ${String(u.label).toUpperCase()} on ${u.date}`);
    },
  },
  {
    id: 'momentum', name: 'Momentum 10 / 20 list (in the list → CALL)', group: 'model', reuses: 'momentum10-paper.json + momentum-paper.json (latest month-end list before the day)', deps: [],
    predict: (inp) => {
      const m = inp.momentum;
      if (!m || (!m.m10 && !m.m20)) return { skip: 'no Momentum 10 / 20 list before the open' };
      const inn = [m.m10?.symbols.includes(inp.symbol) && `Momentum 10 (${m.m10.monthEnd})`, m.m20?.symbols.includes(inp.symbol) && `Momentum 20 (${m.m20.monthEnd})`].filter(Boolean);
      return inn.length ? both(call('CALL', base(inp) + ST.lean, 0.1, `in ${inn.join(' + ')}`)) : both(call('NO TRADE', base(inp), 0, 'not in either momentum list'));
    },
  },
  {
    id: 'news-watch', name: 'News watch call (UP → CALL, DOWN → PUT)', group: 'model', reuses: 'news-watch.mjs latest calls (data/news-watch-state.json)', deps: [],
    predict: (inp) => {
      const n = inp.newsWatch;
      if (!n) return { skip: 'not on the News watch list (it covers the strategies\' holdings + added stocks)' };
      const one = (x, h) => {
        const c = String(x?.call || 'NO CALL');
        return c === 'UP' ? call('CALL', base(inp, h) + ST.lean, x.confidence ?? 0.1, `News watch UP (${n.date}): ${x.reason || ''}`) : c === 'DOWN' ? call('PUT', base(inp, h) - ST.lean, x.confidence ?? 0.1, `News watch DOWN (${n.date}): ${x.reason || ''}`) : call('NO TRADE', base(inp, h), 0, `News watch NO CALL (${n.date})`);
      };
      return { day: one(n.next, 'day'), five: one(n.five, 'five') };
    },
  },
  {
    id: 'news-pick', name: 'Morning news pick (picked → CALL)', group: 'model', reuses: 'news-pick.mjs (the morning picks, data/news-pick.json)', deps: [],
    predict: (inp) => {
      const d = inp.newsPick;
      if (!d) return { skip: 'the morning news pick did not run before the open' };
      return d.picks.includes(inp.symbol) ? both(call('CALL', base(inp) + ST.lean, 0.1, 'picked by the morning news pick')) : both(call('NO TRADE', base(inp), 0, d.picks.length ? `not picked (picked ${d.picks.join(', ')})` : 'news pick chose nothing'));
    },
  },
  {
    id: 'trend-20-50', name: "Stock's 20/50-day trend", group: 'model', deps: [],
    predict: (inp) => {
      const c = inp.bars.map((x) => x.close);
      if (c.length < 50) return { skip: 'fewer than 50 closes' };
      const s20 = sma(c, 20);
      const s50 = sma(c, 50);
      const last = c.at(-1);
      return leanBoth(inp, last > s20 && s20 > s50 ? 1 : last < s20 && s20 < s50 ? -1 : 0, `close ${last.toFixed(1)} · 20-day ${s20.toFixed(1)} · 50-day ${s50.toFixed(1)}`);
    },
  },
  {
    id: 'beta-nifty', name: "Beta to NIFTY (the NIFTY tournament's majority vote)", group: 'model', reuses: 'cp-tournament.mjs majority (data/cp-tournament.json, made earlier the same morning)', deps: [],
    predict: (inp) => {
      const n = inp.niftyMajority;
      if (!n) return { skip: 'no NIFTY tournament majority call for this session before the open' };
      const one = (x, h) => (x?.call === 'CALL' ? call('CALL', base(inp, h) + ST.lean, x.conf ?? 0.1, `NIFTY majority CALL (${x.why || ''})`) : x?.call === 'PUT' ? call('PUT', base(inp, h) - ST.lean, x.conf ?? 0.1, `NIFTY majority PUT (${x.why || ''})`) : call('NO TRADE', base(inp, h), 0, 'NIFTY majority NO TRADE'));
      return { day: one(n.day, 'day'), five: one(n.five, 'five') };
    },
  },
  {
    id: 'big-move', name: 'Big-move odds (NO TRADE when a small move is expected, else CALL)', group: 'model', reuses: 'big-move.mjs bigMove on the stock (HAR σ + standardised tails)', deps: [bigMove], params: ST.bigMovePct,
    predict: async (inp) => {
      if (inp.bars.length < 400) return { skip: 'fewer than 400 daily bars for big-move odds' };
      const r = await bigMove({ symbol: inp.symbol, loadCandles: async () => inp.bars.map((x) => ({ ...x })), now: new Date(inp.cutoff) });
      const one = r.horizons['1d'].odds.find((x) => x.movePct === ST.bigMovePct.day);
      const fiv = r.horizons['5d'].odds.find((x) => x.movePct === ST.bigMovePct.five);
      const pick = (o, h, k) => (o.prob < o.pastYear
        ? call('NO TRADE', base(inp, h), 0, `P(|move| > ${k}%) ${(o.prob * 100).toFixed(0)}% < past year ${(o.pastYear * 100).toFixed(0)}% → small move`)
        : call('CALL', base(inp, h), 0.05, `P(|move| > ${k}%) ${(o.prob * 100).toFixed(0)}% ≥ past year ${(o.pastYear * 100).toFixed(0)}% → base-rate CALL`));
      return { day: pick(one, 'day', ST.bigMovePct.day), five: pick(fiv, 'five', ST.bigMovePct.five) };
    },
  },
  {
    id: 'majority', name: 'Ensemble: majority vote of the models', group: 'ensemble', deps: [],
    predict: (inp, ctx) => {
      const out = {};
      for (const h of ['day', 'five']) {
        const votes = Object.entries(ctx.calls).filter(([id]) => groupOf(id) === 'model').map(([, x]) => x?.[h]).filter((x) => x && x.call !== 'NO TRADE');
        const up = votes.filter((x) => x.call === 'CALL').length;
        const dn = votes.length - up;
        out[h] = call(up > dn ? 'CALL' : dn > up ? 'PUT' : 'NO TRADE', votes.length ? mean(votes.map((x) => x.pUp)) : base(inp, h), votes.length ? Math.abs(up - dn) / votes.length : 0, `${up} CALL · ${dn} PUT of ${votes.length} model votes`);
      }
      return out;
    },
  },
  {
    id: 'weighted', name: 'Ensemble: weighted by past pooled scores only', group: 'ensemble', deps: [], params: { minN: 30, shrink: 60 },
    predict: (inp, ctx) => {
      const out = {};
      for (const h of ['day', 'five']) {
        let s = 0;
        let w = 0;
        let pw = 0;
        let used = 0;
        for (const [id, x] of Object.entries(ctx.calls)) {
          if (groupOf(id) === 'ensemble' || !x?.[h] || x[h].call === 'NO TRADE') continue;
          const tr = inp.trail?.[id]?.[h];
          if (!tr || tr.n < 30) continue;
          const wt = Math.max(0, tr.hits / tr.n - 0.5) * (tr.n / (tr.n + 60));
          if (!(wt > 0)) continue;
          s += wt * (x[h].call === 'CALL' ? 1 : -1);
          w += wt;
          pw += wt * x[h].pUp;
          used++;
        }
        out[h] = w > 0 && s !== 0 ? call(s > 0 ? 'CALL' : 'PUT', pw / w, Math.abs(s) / w, `weighted vote of ${used} contestant(s) with a positive past record`) : call('NO TRADE', base(inp, h), 0, 'no contestant has a positive past record yet (30+ pooled scored calls before today)');
      }
      return out;
    },
  },
];
export const groupOf = (id) => CONTESTANTS.find((c) => c.id === id)?.group || null;

// ------------------------------------------------------------------ frozen versions ---
const src = (d) => (typeof d === 'function' ? d.toString() : JSON.stringify(d));
/** 12-hex version: the predict code, the reused functions, its parameters, the league constants and the universe rule. */
export function versionOf(c) {
  const h = createHash('sha256');
  h.update(`${c.id}\0${c.predict.toString()}`);
  for (const d of c.deps || []) h.update(`\0${src(d)}`);
  h.update(`\0${JSON.stringify(c.params || {})}\0${JSON.stringify(ST)}\0${selectUniverse.toString()}`);
  return h.digest('hex').slice(0, 12);
}
export const versions = () => Object.fromEntries(CONTESTANTS.map((c) => [c.id, versionOf(c)]));
export const universeVersion = () => createHash('sha256').update(`${selectUniverse.toString()}\0${JSON.stringify(ST)}`).digest('hex').slice(0, 12);

// ------------------------------------------------------------------ the pre-open guard (per stock) ---
/** Throws if any input of a stock was final at or after the cut-off. */
export function assertStockPreOpen(inp) {
  const bad = (what, t) => {
    if (!(t < inp.cutoff)) throw new Error(`pre-open guard: ${inp.symbol} ${what} is not before the ${new Date(inp.cutoff).toISOString()} cut-off`);
  };
  for (const r of inp.bars || []) bad(`bar ${r.date}`, CLOSE_TIME.india(r));
  if (inp.updown) bad(`Up/Down list ${inp.updown.date}`, CLOSE_TIME.india(inp.updown));
  for (const k of ['m10', 'm20']) if (inp.momentum?.[k]) bad(`${k} list ${inp.momentum[k].monthEnd}`, CLOSE_TIME.india({ date: inp.momentum[k].monthEnd }));
  if (inp.newsWatch) bad(`News watch call ${inp.newsWatch.at}`, Date.parse(inp.newsWatch.at));
  if (inp.newsPick) bad(`news pick ${inp.newsPick.at}`, Date.parse(inp.newsPick.at));
  if (inp.niftyMajority) bad(`NIFTY majority ${inp.niftyMajority.at}`, Date.parse(inp.niftyMajority.at));
  return true;
}
/** One stock's contestant inputs, every item cut at the guard (late items dropped, not trusted), frozen. */
export function guardStockInputs(raw, date, now = new Date()) {
  const cutoff = cutoffFor(date, now);
  const before = (t) => Number.isFinite(t) && t < cutoff;
  const g = raw.global || {};
  const sym = raw.symbol;
  const bars = Object.freeze(preOpen(raw.bars, 'india', cutoff).map((r) => Object.freeze({ ...r })));
  const ud = g.updown && before(CLOSE_TIME.india(g.updown)) ? { date: g.updown.date, label: g.updown.labels?.[sym] ?? null } : null;
  const mom = {};
  for (const k of ['m10', 'm20']) {
    const lists = (g.momentum?.[k] || []).filter((x) => before(CLOSE_TIME.india({ date: x.monthEnd }))).sort((a, b) => (a.monthEnd < b.monthEnd ? -1 : 1));
    mom[k] = lists.at(-1) || null;
  }
  const nw = g.newsWatch && before(Date.parse(g.newsWatch.at)) && g.newsWatch.calls?.[sym] ? { at: g.newsWatch.at, ...g.newsWatch.calls[sym] } : null;
  const np = g.newsPick && before(Date.parse(g.newsPick.at)) ? g.newsPick : null;
  const nm = g.niftyMajority && before(Date.parse(g.niftyMajority.at)) ? g.niftyMajority : null;
  const inp = {
    date, cutoff, symbol: sym, bars, updown: ud, momentum: mom.m10 || mom.m20 ? mom : null, newsWatch: nw, newsPick: np, niftyMajority: nm,
    baseRate: raw.baseRate || baseRateOf(bars), cal: g.cal || {}, trail: g.trail || {},
  };
  return Object.freeze(inp);
}
/** The stock's base rates from pre-open bars: share of sessions up open → close and open → 5th close. */
export function baseRateOf(rows, n = ST.baseRateSessions) {
  const r = (rows || []).filter((x) => x.open > 0 && x.close > 0).slice(-n - 4);
  const day = r.slice(-n);
  const five = [];
  for (let i = 0; i + 4 < r.length; i++) five.push(r[i + 4].close > r[i].open);
  return { day: day.length ? day.filter((x) => x.close > x.open).length / day.length : 0.5, five: five.length ? five.filter(Boolean).length / five.length : 0.5, sessions: day.length };
}

/** All contestants for one stock on guarded inputs: ordinary ones first, then the ensembles. Never throws. */
export async function runStock(inp, vers = versions()) {
  assertStockPreOpen(inp);
  const preds = {};
  const calls = {};
  for (const c of CONTESTANTS.filter((x) => x.group !== 'ensemble')) {
    try {
      const r = await c.predict(inp, {});
      preds[c.id] = r?.skip ? { version: vers[c.id], skipped: r.skip } : { version: vers[c.id], day: r.day, five: r.five };
      if (!r?.skip) calls[c.id] = r;
    } catch (err) {
      preds[c.id] = { version: vers[c.id], skipped: `error: ${String(err.message || err).slice(0, 120)}` };
    }
  }
  for (const c of CONTESTANTS.filter((x) => x.group === 'ensemble')) {
    try {
      const r = await c.predict(inp, { calls });
      preds[c.id] = { version: vers[c.id], day: r.day, five: r.five };
    } catch (err) {
      preds[c.id] = { version: vers[c.id], skipped: `error: ${String(err.message || err).slice(0, 120)}` };
    }
  }
  return preds;
}

// ------------------------------------------------------------------ trailing pooled scores (strictly before a date) ---
export function trailingScores(st, date, vers = versions()) {
  const out = {};
  for (const d of st?.days || []) {
    if (d.test || !(d.date < date)) continue;
    for (const s of Object.values(d.stocks || {})) {
      for (const [id, p] of Object.entries(s.preds || {})) {
        if (p.version !== vers[id]) continue;
        for (const h of ['day', 'five']) {
          const sc = p.score?.[h];
          if (!sc || sc.hit == null) continue;
          if (h === 'five' && !(sc.endDate < date)) continue;
          const o = ((out[id] ||= {})[h] ||= { n: 0, hits: 0 });
          o.n++;
          if (sc.hit) o.hits++;
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ data (all injectable) ---
const readJ = (p, fb = null) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb;
  } catch {
    return fb;
  }
};
/** Where the NSE F&O stock file of the latest session strictly before `date` is: { date, path } or null. */
export function foDateBefore(date, dirs = FO_DIRS()) {
  let best = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).filter((x) => /^\d{4}-\d\d-\d\d\.json$/.test(x) && x.slice(0, 10) < date).sort().pop();
    if (f && (!best || f.slice(0, 10) > best.date)) best = { date: f.slice(0, 10), path: join(dir, f) };
  }
  return best;
}
/** The NSE F&O stock file of the latest session strictly before `date`: { date, data } or null. */
export function foFileBefore(date, dirs = FO_DIRS()) {
  const best = foDateBefore(date, dirs);
  const data = best ? readJ(best.path) : null;
  return data ? { date: best.date, data } : null;
}
/** What the cached inputs must match to be used: the latest F&O file and NSE daily file before `date`. */
async function defaultFresh(date) {
  let dataTo = null;
  try {
    const { loadState } = await import('./bhav-history.mjs');
    dataTo = (loadState().done || []).filter((x) => x < date).sort().pop() || null;
  } catch {
    dataTo = null;
  }
  return { foFile: foDateBefore(date)?.date || null, dataTo };
}
/** The ATM option of the nearest monthly expiry after `date` from one stock's NSE file entry: { spot, lot, expiry, CE, PE }. */
export function atmOf(o, date) {
  if (!o?.expiries || !(o.underlying > 0)) return null;
  const expiry = Object.keys(o.expiries).filter((e) => e > date).sort()[0];
  if (!expiry) return null;
  const chain = o.expiries[expiry];
  const pick = (typ) => {
    const vk = typ === 'CE' ? 'ceVol' : 'peVol';
    const ks = Object.keys(chain).map(Number).filter((k) => chain[k]?.[typ] > 0);
    const traded = ks.filter((k) => chain[k][vk] > 0);
    const pool = traded.length ? traded : ks;
    if (!pool.length) return null;
    const k = pool.reduce((a, b) => (Math.abs(b - o.underlying) < Math.abs(a - o.underlying) ? b : a));
    return { strike: k, prem: chain[k][typ] };
  };
  return { spot: o.underlying, lot: o.lots?.[expiry] ?? o.lot ?? null, expiry, CE: pick('CE'), PE: pick('PE') };
}
const monthsBack = (date, n) => {
  const out = [];
  let [y, m] = date.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--;
    if (!m) {
      m = 12;
      y--;
    }
  }
  return out;
};
async function defaultSeries(date) {
  const { loadSeries } = await import('./bhav-history.mjs');
  return loadSeries({ months: monthsBack(date, 32) });
}
const volOf = (r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.close > 0 && r.val > 0 ? Math.round(r.val / r.close) : 0, val: r.val });

/** The evening-before part: universe + each stock's bars, base rate and ATM option. Depends only on data before `date`. */
export async function prepare(date, { seriesFn = defaultSeries, foFn = foFileBefore, avoidFn = loadAvoidList } = {}) {
  const t0 = Date.now();
  const series = await seriesFn(date);
  const fo = foFn(date);
  const foSymbols = fo ? Object.keys(fo.data).sort() : [];
  const expiries = fo ? Object.fromEntries(Object.entries(fo.data).map(([s, o]) => [s, Object.keys(o.expiries || {})])) : {};
  const avoid = avoidFn()?.events || [];
  const stockExpiry = (() => {
    try {
      return isExpiryDay(date, 'STOCKS');
    } catch {
      return false;
    }
  })();
  const u = selectUniverse({ date, foSymbols, bars: series, avoid, expiries, stockExpiry });
  const stocks = {};
  for (const x of u.universe) {
    const rows = (series.get(x.symbol) || []).filter((r) => r.date < date).slice(-ST.barsKeep).map(volOf);
    stocks[x.symbol] = { bars: rows, baseRate: baseRateOf(rows), atm: atmOf(fo.data[x.symbol], date), expiry: (expiries[x.symbol] || []).includes(date) };
  }
  let dataTo = null;
  for (const s of Object.values(stocks)) if (s.bars.length && (!dataTo || s.bars.at(-1).date > dataTo)) dataTo = s.bars.at(-1).date;
  const errors = [];
  if (!fo) errors.push('no NSE F&O stock file before this session');
  if (fo && prevSessions(date, 1)[0] !== fo.date) errors.push(`F&O stock file is from ${fo.date}, not the last session ${prevSessions(date, 1)[0]}`);
  if (dataTo && prevSessions(date, 1)[0] !== dataTo) errors.push(`NSE daily prices end ${dataTo}, not the last session ${prevSessions(date, 1)[0]}`);
  return {
    forDate: date, builtAt: new Date().toISOString(), ruleVersion: universeVersion(), foFile: fo?.date || null, dataTo, stockExpiry,
    universe: u.universe, excluded: u.excluded, considered: u.considered, stocks, errors, prepMs: Date.now() - t0,
  };
}
export const loadPrep = (file = PREP()) => readJ(file);
export async function savePrep(date, opts = {}, file = PREP()) {
  const p = await prepare(date, opts);
  writeJsonAtomic(file, p, 0);
  return p;
}

/** The morning part: overnight / same-morning inputs shared by all stocks (each cut at the guard per stock later). */
export function loadGlobals(date, { isTest = false, st = null } = {}) {
  const ud = readJ(process.env.UPDOWN_LIVE_PATH || join(DATA(), 'updown-live.json'));
  const momList = (f) => (readJ(f)?.rebalances || []).map((r) => ({ monthEnd: r.monthEnd, symbols: (r.holdings || []).map((h) => h.symbol) }));
  const nw = readJ(process.env.NEWS_WATCH_STATE_PATH || join(DATA(), 'news-watch-state.json'));
  const np = readJ(process.env.NEWS_PICK_PATH || join(DATA(), 'news-pick.json'))?.days?.[date] || null;
  const nt = readJ(NIFTY_STATE());
  const nrec = (nt?.days || []).find((x) => x.date === date && !x.test) || (isTest ? (nt?.tests || []).find((x) => x.date === date) || (nt?.days || []).find((x) => x.date === date) : null);
  const maj = nrec?.preds?.majority;
  return {
    updown: ud?.date ? { date: ud.date, labels: Object.fromEntries((ud.rows || []).map((r) => [r.symbol, r.label])) } : null,
    momentum: { m10: momList(process.env.MOMENTUM10_PAPER_PATH || join(DATA(), 'momentum10-paper.json')), m20: momList(process.env.MOMENTUM_PAPER_PATH || join(DATA(), 'momentum-paper.json')) },
    newsWatch: nw?.lastRun?.at ? { at: nw.lastRun.at, calls: Object.fromEntries(Object.entries(nw.latest || {}).map(([s, v]) => [s, { date: v.date, next: v.next, five: v.five }])) } : null,
    newsPick: np && !np.test && np.madeAt ? { at: np.madeAt, picks: (np.picks || []).map((p) => p.symbol) } : null,
    niftyMajority: maj && !maj.skipped && nrec.finishedAt ? { at: nrec.finishedAt, test: !!nrec.test, day: maj.day, five: maj.five } : null,
    cal: loadCalibration(),
    trail: trailingScores(st, date),
  };
}

// ------------------------------------------------------------------ the morning run ---
export const loadStocks = (file = STATE()) => readJ(file);
const freshState = () => ({ startedAt: null, createdAt: new Date().toISOString(), days: [], tests: [] });

/**
 * The morning prediction (after the NIFTY tournament). Without `date`: today (IST), real; quiet on holidays, at/after
 * 09:15 or when already done; stocks not reached by 09:05 are skipped; a run finishing after 09:15 is not scored.
 * With `date` (or `test`): a TEST entry (kept apart, never scored).
 */
export async function predictStocks({ now = new Date(), date = null, test = false, file = STATE(), prepFile = PREP(), prepFn = prepare, globalsFn = loadGlobals, freshFn = defaultFresh, clock = () => new Date() } = {}) {
  const t = istNow(now);
  const isTest = Boolean(test || date);
  const d = date || t.date;
  if (!isTradingDay(d)) return { skipped: 'holiday', date: d, message: `${d}: not an NSE trading day — no stock calls.` };
  if (!isTest && t.mins >= ST.openMins) return { skipped: 'late', date: d, message: `${d} ${t.hhmm} IST: too late — stock calls must be made before the 09:15 open. Use --date for a TEST entry (not scored).` };
  const st = loadStocks(file) || freshState();
  st.days ||= [];
  st.tests ||= [];
  if (!isTest && st.days.some((x) => x.date === d)) return { skipped: 'done', date: d, message: `${d}: today's stock calls were already made — the first calls stand.` };
  const t0 = clock().getTime();
  let prep = readJ(prepFile);
  // the evening cache is used only if it was built for this session, with this rule, from the newest NSE files
  let cached = Boolean(prep && prep.forDate === d && prep.ruleVersion === universeVersion());
  if (cached) {
    const f = await freshFn(d);
    cached = f.foFile === prep.foFile && f.dataTo === prep.dataTo;
  }
  if (!cached) prep = await prepFn(d);
  const g = globalsFn(d, { isTest, st });
  if (!isTest && g.niftyMajority?.test) g.niftyMajority = null; // a real stock call never reads a TEST NIFTY call
  const vers = versions();
  const stocks = {};
  const stopAt = Date.parse(`${d}T00:00:00Z`) + (ST.stopMins - 330) * 60000;
  for (const u of prep.universe) {
    const s = prep.stocks[u.symbol];
    if (!isTest && clock().getTime() >= stopAt) {
      stocks[u.symbol] = { rank: u.rank, skipped: 'not reached before the 09:05 stop' };
      continue;
    }
    const inp = guardStockInputs({ symbol: u.symbol, bars: s.bars, baseRate: null, global: g }, d, now);
    stocks[u.symbol] = {
      rank: u.rank, value: u.value, lastClose: inp.bars.at(-1) ? { date: inp.bars.at(-1).date, close: inp.bars.at(-1).close } : null,
      baseRate: { day: inp.baseRate.day, five: inp.baseRate.five, sessions: inp.baseRate.sessions }, atm: s.atm, expiry: s.expiry, preds: await runStock(inp, vers),
    };
  }
  const t1 = clock();
  const finished = istNow(t1);
  const late = !isTest && (finished.date !== d || finished.mins >= ST.openMins);
  const rec = {
    date: d, test: isTest || late, testReason: isTest ? 'TEST entry (--date) — shown, never scored' : late ? `finished at ${finished.hhmm} IST, after the 09:15 open — not scored` : null,
    madeAt: now.toISOString(), finishedAt: t1.toISOString(), cutoff: new Date(cutoffFor(d, now)).toISOString(), runtimeMs: t1.getTime() - t0, prepCached: cached, prepMs: prep.prepMs ?? null,
    ruleVersion: prep.ruleVersion, foFile: prep.foFile, dataTo: prep.dataTo, stockExpiry: !!prep.stockExpiry, universe: prep.universe.map((x) => x.symbol), excluded: prep.excluded,
    niftyMajority: g.niftyMajority ? { day: g.niftyMajority.day?.call || null, five: g.niftyMajority.five?.call || null, test: g.niftyMajority.test } : null,
    stocks, errors: prep.errors || [], versions: vers,
  };
  if (rec.test) st.tests = [...st.tests.filter((x) => x.date !== d), rec].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-10);
  else {
    st.startedAt ||= d;
    st.days = [...st.days, rec].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  st.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, st, 0);
  return { date: d, rec, st };
}

// ------------------------------------------------------------------ scoring ---
/** Option costs in ₹ for buying `qty` at `buyPrem` and selling at `sellPrem` (fo-strangle.mjs STT; NSE fees, GST, slippage). */
export function optionCosts(buyPrem, sellPrem, qty, date) {
  const exPct = date < '2024-10-01' ? 0.05 : 0.03503; // NSE option transaction charge, % of premium (as fo-strangle.mjs)
  const side = (prem, sell) => {
    const v = prem * qty;
    const brk = ST.brokeragePerOrder;
    const ex = (v * exPct) / 100;
    const sebi = v * 1e-6;
    const stt = sell ? (v * sttSell(date)) / 100 : 0;
    const stamp = sell ? 0 : v * 0.00003;
    const slip = qty * Math.max((prem * ST.slippagePct) / 100, ST.slippageMin);
    return brk + ex + sebi + stt + stamp + 0.18 * (brk + ex + sebi) + slip;
  };
  return side(buyPrem, false) + (sellPrem > 0 ? side(sellPrem, true) : 0);
}
/**
 * The option P&L proxy for one call: ₹2,000 of the ATM monthly premium (prior NSE bhav), premium changed by the stock
 * move × 0.5 delta, minus costs. null without a premium; { pnl: null } on the stock's expiry day (or an expiry in the window).
 */
export function optionProxy({ callSide, ret, atm, date, expiryInWindow }) {
  if (!callSide || callSide === 'NO TRADE' || ret == null) return null;
  if (expiryInWindow) return { pnl: null, source: 'stock-option expiry in the window — no option (physically settled)' };
  const typ = callSide === 'CALL' ? 'CE' : 'PE';
  const leg = atm?.[typ];
  if (!leg || !(leg.prem > 0) || !(atm.spot > 0)) return null;
  const dir = callSide === 'CALL' ? 1 : -1;
  const qty = ST.riskRs / leg.prem;
  const exit = Math.max(0, leg.prem + ST.delta * dir * ret * atm.spot);
  const gross = qty * (exit - leg.prem);
  const charges = optionCosts(leg.prem, exit, qty, date);
  return { pnl: gross - charges, gross, charges, lots: atm.lot ? qty / atm.lot : null, source: 'proxy (stock move × 0.5 delta)' };
}
/** One prediction's score: own direction, vs NIFTY, Brier vs the stock's base rate. */
export function scoreStock(pred, out, baseP) {
  if (!pred || !out) return null;
  const s = { up: out.up, ret: out.ret, niftyRet: out.niftyRet, brier: brier(pred.pUp, out.up), brierRef: brier(baseP, out.up), endDate: out.endDate };
  if (pred.call === 'NO TRADE') return { ...s, hit: null, hitVsNifty: null, noTrade: true };
  const ex = out.niftyRet == null ? null : out.ret - out.niftyRet;
  return { ...s, hit: pred.call === 'CALL' ? out.up : !out.up, hitVsNifty: ex == null ? null : pred.call === 'CALL' ? ex > 0 : ex < 0 };
}

async function defaultNifty(from) {
  const { candles } = await import('../market-data.mjs');
  return (await candles('^NSEI', { period1: Math.floor(Date.parse(`${addDays(from, -10)}T00:00:00Z`) / 1000), interval: '1d' })).filter((x) => x.open > 0 && x.close > 0);
}

/** Evening: score every real day whose outcome is known (stock bars from NSE bhav, NIFTY from Yahoo). */
export async function scoreStocks({ now = new Date(), file = STATE(), seriesFn = defaultSeries, niftyFn = defaultNifty } = {}) {
  const st = loadStocks(file);
  if (!st?.days?.length) return { scoredNow: 0, st, message: 'Nothing to score yet: the stock league starts with the first real morning run.' };
  const upTo = lastSessionDate(now);
  const open = st.days.filter((d) => !d.test && d.date <= upTo && (!d.scored?.day || !d.scored?.five) && Object.keys(d.stocks || {}).length);
  for (const d of st.days) if (!d.test && !Object.keys(d.stocks || {}).length && d.date <= upTo) d.scored ||= { day: 'no stocks', five: 'no stocks' };
  if (!open.length) {
    writeJsonAtomic(file, st, 0);
    return { scoredNow: 0, st };
  }
  const series = await seriesFn(upTo);
  let nifty = [];
  const errors = [];
  try {
    nifty = await niftyFn(open[0].date);
  } catch (err) {
    errors.push(`NIFTY: ${String(err.message).slice(0, 80)}`);
  }
  const nBy = new Map(nifty.map((r) => [r.date, r]));
  let scoredNow = 0;
  for (const d of open) {
    d.scored ||= {};
    const end5 = sessionsFrom(d.date, 5)[4];
    const nOpen = nBy.get(d.date);
    const ready = { day: d.date <= upTo, five: end5 && end5 <= upTo };
    for (const h of ['day', 'five']) {
      if (d.scored[h] || !ready[h]) continue;
      const endD = h === 'day' ? d.date : end5;
      let any = false;
      let missing = 0;
      for (const [sym, s] of Object.entries(d.stocks)) {
        if (!s.preds) continue;
        const rows = series.get(sym) || [];
        const a = rows.find((r) => r.date === d.date);
        const z = rows.find((r) => r.date === endD);
        if (!a || !z || !(a.open > 0) || !(z.close > 0)) {
          missing++;
          continue;
        }
        const ret = z.close / a.open - 1;
        const nEnd = nBy.get(endD);
        const out = { up: z.close > a.open, ret, niftyRet: nOpen && nEnd ? nEnd.close / nOpen.open - 1 : null, endDate: endD };
        const xpWin = h === 'day' ? !!s.expiry || (s.atm?.expiry && s.atm.expiry === d.date) : !!s.expiry || (s.atm?.expiry && s.atm.expiry <= endD);
        for (const p of Object.values(s.preds)) {
          if (!p[h]) continue;
          const sc = scoreStock(p[h], out, s.baseRate?.[h] ?? 0.5);
          if (sc.hit != null) {
            const pl = optionProxy({ callSide: p[h].call, ret, atm: s.atm, date: d.date, expiryInWindow: xpWin });
            if (pl) Object.assign(sc, { pnl: pl.pnl, pnlSource: pl.source });
          }
          (p.score ||= {})[h] = sc;
        }
        (s.outcome ||= {})[h] = out;
        any = true;
      }
      // a day counts as scored once its prices are in (a stock with no NSE bar that day — suspended — stays unscored)
      if (any) {
        d.scored[h] = now.toISOString();
        d.missing = { ...(d.missing || {}), [h]: missing };
        scoredNow++;
      }
    }
  }
  // keep the file small: drop the "why" text of days older than the last 10
  for (const d of st.days.slice(0, -10)) for (const s of Object.values(d.stocks || {})) for (const p of Object.values(s.preds || {})) for (const h of ['day', 'five']) if (p[h]) delete p[h].why;
  st.lastScore = { at: now.toISOString(), upTo, scoredNow, errors };
  writeJsonAtomic(file, st, 0);
  return { scoredNow, st, errors };
}

// ------------------------------------------------------------------ leaderboard ---
/** Every scored call of a contestant for a horizon (real days, current version), one row per stock-day. */
export function callRows(st, h, id, vers = versions()) {
  const rows = [];
  for (const d of st?.days || []) {
    if (d.test) continue;
    for (const [sym, s] of Object.entries(d.stocks || {})) {
      const p = s.preds?.[id];
      if (!p || p.version !== vers[id] || !p.score?.[h]) continue;
      rows.push({ date: d.date, symbol: sym, call: p[h]?.call, ...p.score[h] });
    }
  }
  return rows;
}
/** Stats for a set of call rows (pooled, or one stock's). */
export function statsOf(rows) {
  const calls = rows.filter((r) => r.hit != null);
  const n = calls.length;
  const hits = calls.filter((r) => r.hit).length;
  const vs = calls.filter((r) => r.hitVsNifty != null);
  const vsHits = vs.filter((r) => r.hitVsNifty).length;
  const pn = calls.filter((r) => r.pnl != null);
  const b = rows.length ? mean(rows.map((r) => r.brier)) : null;
  const bRef = rows.length ? mean(rows.map((r) => r.brierRef)) : null;
  return {
    n, hits, hitRate: n ? hits / n : null, ci: wilson(hits, n), noTrade: rows.filter((r) => r.noTrade).length, predictions: rows.length,
    days: new Set(calls.map((r) => r.date)).size, stocks: new Set(calls.map((r) => r.symbol)).size,
    vsNifty: { n: vs.length, hits: vsHits, hitRate: vs.length ? vsHits / vs.length : null, ci: wilson(vsHits, vs.length) },
    brier: b, brierRef: bRef, brierSkill: rows.length ? brierSkill(b, bRef) : null,
    pnl: pn.reduce((a, r) => a + r.pnl, 0), pnlCalls: pn.length, tDay: dayClusteredT(pn),
  };
}
/** Per-stock breakdown of one contestant. */
export function perStock(st, h, id, vers = versions()) {
  const by = new Map();
  for (const r of callRows(st, h, id, vers)) {
    if (!by.has(r.symbol)) by.set(r.symbol, []);
    by.get(r.symbol).push(r);
  }
  return [...by.entries()].map(([symbol, rows]) => ({ symbol, ...statsOf(rows) })).sort((a, b) => b.n - a.n || (a.symbol < b.symbol ? -1 : 1));
}
/** The pooled leaderboard for a horizon: stats, the bar, day-clustered p, Holm + BH, status, verdict, the leader's best / worst stocks. */
export function leaderboard(st, h = 'day', vers = versions()) {
  const rows = CONTESTANTS.map((c) => {
    const cr = callRows(st, h, c.id, vers);
    return { id: c.id, name: c.name, group: c.group, ...statsOf(cr), _rows: cr.filter((r) => r.hit != null) };
  });
  const ac = rows.find((r) => r.id === 'always-call');
  const baseHit = ac?.n ? ac.hitRate : null;
  const bar = Math.max(0.5, baseHit ?? 0);
  const tested = rows.filter((r) => r.id !== 'always-call');
  const ps = tested.map((r) => (r.n ? clusteredP(r._rows, bar) : null));
  const hol = holm(ps);
  const q = bh(ps);
  tested.forEach((r, i) => Object.assign(r, { p: ps[i], pHolm: hol[i], qBH: q[i] }));
  for (const r of rows) {
    const why = [];
    if (r.n < ST.minCalls) why.push(`${r.n} of ${ST.minCalls} pooled stock-calls`);
    if (r.days < ST.minDays) why.push(`${r.days} of ${ST.minDays} different days`);
    if (!(r.ci && r.ci[0] > bar)) why.push(`hit-rate lower bound ${r.ci ? `${(r.ci[0] * 100).toFixed(0)}%` : '–'} not above ${(bar * 100).toFixed(0)}% (max of 50% and always-CALL)`);
    if (!(r.brierSkill > 0)) why.push('Brier skill not positive');
    if (!(r.pnl > 0)) why.push('P&L after costs not positive');
    if (r.id !== 'always-call' && !(r.pHolm != null && r.pHolm < ST.alpha)) why.push(`Holm-adjusted p ${r.pHolm == null ? '–' : r.pHolm.toFixed(2)} not < ${ST.alpha}`);
    if (r.id === 'always-call') why.push('the reference (base rate)');
    r.proven = why.length === 0;
    r.why = why;
    delete r._rows;
  }
  const ranked = [...rows].sort((a, b) => (b.ci?.[0] ?? -1) - (a.ci?.[0] ?? -1) || (b.hitRate ?? -1) - (a.hitRate ?? -1) || b.n - a.n);
  const leader = ranked.find((r) => r.n > 0 && r.id !== 'always-call') || null;
  for (const r of rows) r.status = r.proven ? 'PROVEN (forward, after Holm)' : leader && r.id === leader.id ? 'LEADING — still unproven' : 'unproven';
  let leaderStocks = null;
  if (leader) {
    const ps2 = perStock(st, h, leader.id, vers).filter((x) => x.n > 0);
    const byHit = [...ps2].sort((a, b) => b.hitRate - a.hitRate || b.n - a.n);
    leaderStocks = { id: leader.id, best: byHit.slice(0, 3), worst: byHit.slice(-3).reverse(), note: 'Per-stock results on a few calls are mostly luck: 10 calls at a true 50% land anywhere from 20% to 80% right.' };
  }
  const proven = rows.filter((r) => r.proven);
  return {
    horizon: h, label: HORIZONS[h], rows: ranked, baseHit, bar, leader: leader?.id || null, leaderStocks, proven: proven.map((r) => r.id),
    correction: `One-sided test of each contestant's pooled hit rate vs ${(bar * 100).toFixed(1)}% (the higher of 50% and always-CALL), clustered by date (stocks on one day move together), ${tested.length} contestants: Holm step-down (family-wise 5%) decides "proven"; Benjamini–Hochberg q-values shown too.`,
    verdict: proven.length ? `${proven.map((r) => r.name).join(', ')} passed every check — keep re-checking as the record grows.` : `No contestant is proven. ${leader ? `${leader.name} leads (${leader.n} stock-calls on ${leader.days} days) — LEADING, still unproven.` : 'Nothing scored yet.'} The most likely outcome: stock direction has not been predictable in any test.`,
  };
}

// ------------------------------------------------------------------ the card ---
export function stocksView({ file = STATE() } = {}) {
  const st = loadStocks(file) || freshState();
  const vers = versions();
  const latestReal = (st.days || []).at(-1) || null;
  const latestTest = (st.tests || []).at(-1) || null;
  const t = latestTest && (!latestReal || latestTest.date >= latestReal.date) ? latestTest : latestReal;
  const today = t ? {
    date: t.date, test: t.test, testReason: t.testReason, madeAt: t.madeAt, cutoff: t.cutoff, runtimeMs: t.runtimeMs, prepCached: t.prepCached, foFile: t.foFile, dataTo: t.dataTo,
    stockExpiry: t.stockExpiry, universe: t.universe, excluded: t.excluded, niftyMajority: t.niftyMajority, errors: t.errors,
    stocks: Object.entries(t.stocks || {}).map(([symbol, s]) => ({
      symbol, rank: s.rank, lastClose: s.lastClose, baseRate: s.baseRate, expiry: s.expiry, skipped: s.skipped || null,
      atm: s.atm ? { expiry: s.atm.expiry, lot: s.atm.lot, CE: s.atm.CE, PE: s.atm.PE } : null,
      calls: Object.fromEntries(Object.entries(s.preds || {}).map(([id, p]) => [id, p.skipped ? { skipped: p.skipped } : { day: p.day, five: p.five }])),
    })),
  } : null;
  const skips = {};
  if (today) for (const s of today.stocks) for (const [id, c] of Object.entries(s.calls)) if (c.skipped) ((skips[id] ||= {})[c.skipped] ||= []).push(s.symbol);
  const per = {};
  for (const h of ['day', 'five']) per[h] = Object.fromEntries(CONTESTANTS.map((c) => [c.id, perStock(st, h, c.id, vers)]));
  return {
    startedAt: st.startedAt || null, updatedAt: st.updatedAt || null, lastScore: st.lastScore || null, today, skips,
    boards: { day: leaderboard(st, 'day', vers), five: leaderboard(st, 'five', vers) }, perStock: per,
    contestants: CONTESTANTS.map((c) => ({ id: c.id, name: c.name, group: c.group, reuses: c.reuses || null, version: vers[c.id] })),
    horizons: HORIZONS, universeRule: UNIVERSE_RULE, whyVsNifty: WHY_VS_NIFTY, pnlNote: PNL_NOTE, evidence: EVIDENCE,
    rules: [
      'Calls at ~08:20 IST (after the NIFTY tournament) from data final before the 09:15 open; the run stops at 09:05 and a run finishing after 09:15 is not scored.',
      `Proven only with ≥ ${ST.minCalls} pooled stock-calls across ≥ ${ST.minDays} different days, a 95% Wilson lower bound above both 50% and always-CALL, positive Brier skill vs each stock's base rate, positive P&L after costs, and Holm-adjusted p < ${ST.alpha} (day-clustered).`,
      'Each contestant is frozen: its version hash covers its code, the app functions it reuses, its parameters and the universe rule; a new hash starts a new record.',
    ],
    note: NOTE,
  };
}

// ------------------------------------------------------------------ CLI ---
const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
async function cliScore() {
  const r = await scoreStocks();
  console.log(r.message || `Call / Put stock league scoring: ${r.scoredNow} new score(s)${r.errors?.length ? ` · ${r.errors.join(' · ')}` : ''}`);
  if (!r.st?.days?.length) return;
  const b = leaderboard(r.st, 'day');
  for (const row of b.rows.slice(0, 5)) console.log(`  ${row.id.padEnd(14)} ${row.n} calls / ${row.days} days · hit ${pc(row.hitRate)} ${row.ci ? `[${pc(row.ci[0])}–${pc(row.ci[1])}]` : ''} · vs NIFTY ${pc(row.vsNifty.hitRate)} · P&L proxy ₹${Math.round(row.pnl)} · ${row.status}`);
  console.log(b.verdict);
}
async function cliPrepare(date) {
  const d = date || sessionFor(new Date());
  const p = await savePrep(d);
  console.log(`Stock league inputs prepared for ${d} in ${p.prepMs} ms: ${p.universe.map((x) => x.symbol).join(', ') || '(no stocks)'}${p.excluded.length ? ` · left out: ${p.excluded.map((x) => `${x.symbol} (${x.reason})`).join(', ')}` : ''}${p.errors.length ? ` · ${p.errors.join(' · ')}` : ''}`);
}
/** CALL / PUT / NO TRADE / skipped counts per contestant for one record (the CLI summary). */
export function callCounts(rec) {
  const out = {};
  for (const c of CONTESTANTS) {
    const k = { day: { CALL: 0, PUT: 0, 'NO TRADE': 0 }, five: { CALL: 0, PUT: 0, 'NO TRADE': 0 }, skipped: 0, why: [] };
    for (const s of Object.values(rec.stocks || {})) {
      const p = s.preds?.[c.id];
      if (!p || p.skipped) {
        k.skipped++;
        const w = p?.skipped || s.skipped;
        if (!k.why.includes(w)) k.why.push(w);
      } else {
        k.day[p.day.call]++;
        k.five[p.five.call]++;
      }
    }
    out[c.id] = k;
  }
  return out;
}
async function cliPredict(date, test) {
  const r = await predictStocks({ date, test });
  if (r.skipped) return console.log(r.message);
  const x = r.rec;
  console.log(`Call / Put stock league ${x.date}${x.test ? ` — ${x.testReason}` : ''} · cut-off ${x.cutoff} · ${x.universe.length} stocks · ${x.runtimeMs} ms (inputs ${x.prepCached ? 'cached the evening before' : `built now, ${x.prepMs} ms`})${x.stockExpiry ? ' · STOCK-OPTION EXPIRY DAY (no stocks)' : ''}`);
  console.log(`  universe: ${x.universe.join(', ')}`);
  if (x.excluded.length) console.log(`  left out: ${x.excluded.map((e) => `${e.symbol} (${e.reason})`).join(', ')}`);
  for (const [id, k] of Object.entries(callCounts(x))) {
    console.log(`  ${id.padEnd(14)} today ${k.day.CALL} CALL / ${k.day.PUT} PUT / ${k.day['NO TRADE']} NO TRADE · 5 sessions ${k.five.CALL}/${k.five.PUT}/${k.five['NO TRADE']}${k.skipped ? ` · skipped ${k.skipped}: ${k.why.join('; ')}` : ''}`);
  }
  if (x.errors.length) console.log(`Problems: ${x.errors.join(' · ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dI = args.indexOf('--date');
  const date = dI >= 0 ? args[dI + 1] : null;
  if (dI >= 0 && !/^\d{4}-\d\d-\d\d$/.test(date || '')) {
    console.error('Error: usage: --predict|--prepare [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const steps = [['--score', () => cliScore()], ['--prepare', () => cliPrepare(date)], ['--predict', () => cliPredict(date, args.includes('--test'))]].filter(([f]) => args.includes(f));
  if (!steps.length) {
    console.log('usage: node paper-bot/cp-stocks.mjs --predict [--date YYYY-MM-DD] | --score | --prepare [--date YYYY-MM-DD]');
    process.exit(2);
  }
  let failed = false;
  for (const [, f] of steps) {
    try {
      await f();
    } catch (err) {
      console.error('Error:', err.message); // the next step still runs (a failed score must not stop the next session's inputs)
      failed = true;
    }
  }
  console.log(NOTE);
  if (failed) process.exit(1);
}
