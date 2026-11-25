#!/usr/bin/env node
// Call / Put prediction tournament (library + CLI) — PAPER ONLY, no broker orders. Not advice.
//
// WHY: backtest searches for a NIFTY direction rule kept failing (the Call/Put live scorecard: top call right 35–36%
// vs always-Up 45–47%; options positioning and FII positioning: no edge; "Trade today?": no sign predicts down days,
// only risk; loops 20 and 23: the afternoon trend near-miss lost both unseen periods; the HFCL study: news explains
// moves afterwards, it doesn't predict them). More searching mostly finds luck. So this REPLACES backtest searching with
// FORWARD testing: many fixed ("frozen") predictors each make a call for NIFTY every morning BEFORE the open, they are
// scored on days nobody has seen, and a leader is called proven only with statistical support after a multiple-testing
// correction. The most likely outcome is that no contestant is ever proven — the card says so plainly.
//
// Each contestant, at ~08:40 IST, using only data whose bar CLOSED before the 09:15 open (and before "now"):
//   for TODAY's session (open → close) and for the next 5 sessions (today's open → the 5th session's close):
//   CALL / PUT / NO TRADE, a probability of up, and a confidence. Each contestant is frozen code with a version hash
//   (its predict function + the reused app functions it calls + its parameters); a changed hash starts a new record.
// The afternoon trend (T1) is a SAME-DAY contestant: it predicts at 12:25 (replayed after the close from bars up to the
// 12:25 bar only) and is scored separately on the 12:30 → 15:15 window.
//
// Scoring (forward only, from the first real 08:40 run): direction hit for CALL/PUT calls (NO TRADE counted apart),
// Brier score and log loss vs "always the base rate", a paper P&L (₹2,000 at risk on a ₹1 lakh account): a real ATM
// weekly NIFTY option bought 09:20 and sold 15:15 when Groww's 5-minute option prices are there (never on a NIFTY
// expiry day — no P&L that day), else a NIFTY futures-move proxy sized so one daily ATR = ₹2,000.
//
//   node paper-bot/cp-tournament.mjs --predict                         # the 08:40 job (quiet exit on holidays / after 09:15)
//   node paper-bot/cp-tournament.mjs --predict --date 2026-11-25       # a TEST entry for that session (shown, never scored)
//   node paper-bot/cp-tournament.mjs --score                           # evening: score every outstanding day

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { normCdf } from '../blackscholes.mjs';
import { isTradingDay, tradingDaysBetween, lastSessionDate } from './market-calendar.mjs';
import { isExpiryDay, expiryStatus } from './expiry.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore, baseProbabilities } from './groww-predict.mjs';
import { calibratedProbs, loadCalibration } from './calibration.mjs';
import { signsAt, levelOf, KINDS } from './trade-today.mjs';
import { bigMove, loadBigMoveEval } from './big-move.mjs';
import { withZ, loadResult as loadPositioningResult } from './options-positioning.mjs';
import { fiiFeatures } from './fii.mjs';
import { detectSignal, fillBuy, fillSell, charges as optCharges, RULES as AT_RULES } from './afternoon-trend.mjs';
import { seededIndex } from './news-pick.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';
import { futuresCharges } from './costs.mjs';
import { liveScorecard } from './prediction-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = () => process.env.CP_TOURNAMENT_PATH || join(HERE, 'data', 'cp-tournament.json');

export const T = {
  openMins: 555, // 09:15 IST
  deadlineMins: 545, // slow downloads stop at 09:05 IST so the run finishes before the open
  capital: 100000,
  riskRs: 2000,
  lean: 0.03, // the probability lean of a rule with no fitted probability (base rate ± 3 points)
  minN: 100,
  alpha: 0.05,
  baseRateSessions: 500,
  trailMinN: 10,
};
export const HORIZONS = { day: 'Today (open → close)', five: 'Next 5 sessions (open → 5th close)', pm: 'Same day 12:30 → 15:15' };
export const CALLS = ['CALL', 'PUT', 'NO TRADE'];
export const NOTE = 'Paper only — no broker orders. Not advice.';
export const WHY = 'This replaces backtest searching with forward testing: every contestant is frozen code that calls NIFTY before the open and is scored on days nobody has seen. Backtest searches kept finding luck (top Call/Put call right 35–36% vs always-Up 45–47% on the live scorecard; positioning, FII, "Trade today?", news and the afternoon-trend near-miss all failed out of sample).';
export const GIFT_NOTE = 'GIFT NIFTY (the old SGX NIFTY) has no free pre-open source the app can read (Yahoo has no GIFT NIFTY series; NSE IX pages need scraping) — the overnight contestant uses only the US S&P 500 close (Yahoo ^GSPC), which ends at 02:30 IST, before the open.';

// ------------------------------------------------------------------ time + the pre-open guard ---
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const istNow = (now) => {
  const s = new Date(now.getTime() + 19800_000).toISOString();
  return { date: s.slice(0, 10), mins: +s.slice(11, 13) * 60 + +s.slice(14, 16), hhmm: s.slice(11, 16) };
};
/** The session's 09:15 IST open, ms. */
export const openMs = (date) => Date.parse(`${date}T09:15:00+05:30`);
/** When each kind of row was final (its bar closed / the file was published), ms. */
export const CLOSE_TIME = {
  india: (r) => Date.parse(`${String(r.date).slice(0, 10)}T15:30:00+05:30`), // NSE daily bar, participant OI, F&O bhavcopy (published after the close)
  us: (r) => Date.parse(`${String(r.date).slice(0, 10)}T21:00:00Z`), // NYSE 16:00 ET in standard time (later than DST, so conservative)
  m5: (r) => Date.parse(`${String(r.date).slice(0, 10)}T${String(r.date).slice(11, 16)}:00+05:30`) + 5 * 60000, // 5-minute bar: its start + 5 minutes
  stamp: (r) => Date.parse(r.time || r.date), // a timestamped item (headline)
};
/** The cut-off for a prediction of `date` made at `now`: the session open, or now if earlier (no in-progress bar). */
export const cutoffFor = (date, now = new Date()) => Math.min(openMs(date), now.getTime());
/** Rows that were final strictly before the cut-off. */
export function preOpen(rows, kind, cutoff) {
  const f = CLOSE_TIME[kind];
  return (rows || []).filter((r) => {
    const t = f(r);
    return Number.isFinite(t) && t < cutoff;
  });
}
const SERIES_KIND = { nifty: 'india', vix: 'india', spx: 'us', positioning: 'india', fii: 'india', headlines: 'stamp' };
/** Throws if any series row was final at or after the cut-off (the contestant would be reading the future). */
export function assertPreOpen(inp) {
  for (const [k, kind] of Object.entries(SERIES_KIND)) {
    for (const r of inp[k] || []) {
      const t = CLOSE_TIME[kind](r);
      if (!(t < inp.cutoff)) throw new Error(`pre-open guard: ${k} row ${r.date || r.time} is not before the ${new Date(inp.cutoff).toISOString()} cut-off`);
    }
  }
  return true;
}
/** Contestant inputs: every series cut at the guard, frozen. */
export function guardInputs(raw, date, now = new Date()) {
  const cutoff = cutoffFor(date, now);
  const out = { date, cutoff };
  for (const [k, kind] of Object.entries(SERIES_KIND)) out[k] = Object.freeze(preOpen(raw[k], kind, cutoff).map((r) => Object.freeze({ ...r })));
  for (const k of ['newsPick', 'cal', 'bigMoveEval', 'posResult', 'baseRate', 'trail', 'llm', 'llmKey']) out[k] = raw[k] ?? null;
  return Object.freeze(out);
}

// ------------------------------------------------------------------ small maths ---
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clampP = (p) => Math.min(0.99, Math.max(0.01, p));
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
export const brier = (p, up) => (p - (up ? 1 : 0)) ** 2;
export const logLoss = (p, up) => -Math.log(up ? clampP(p) : 1 - clampP(p));
/** 1 − Brier ÷ reference Brier (> 0 = better than always saying the base rate). */
export const brierSkill = (b, ref) => (ref > 0 ? 1 - b / ref : null);
export function tStat(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null;
}
/** One-sided p-value that the hit rate beats `bar` (normal approximation to the binomial). */
export function pAbove(k, n, bar) {
  if (!n || !(bar > 0 && bar < 1)) return null;
  const z = (k - n * bar) / Math.sqrt(n * bar * (1 - bar));
  return 1 - normCdf(z);
}
/** Holm step-down adjusted p-values (same order as given; nulls kept). */
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const out = ps.map(() => null);
  let run = 0;
  idx.forEach(([p, i], j) => {
    run = Math.max(run, Math.min(1, (m - j) * p));
    out[i] = run;
  });
  return out;
}
/** Benjamini–Hochberg adjusted p-values (q-values; same order as given; nulls kept). */
export function bh(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const out = ps.map(() => null);
  let run = 1;
  for (let j = m - 1; j >= 0; j--) {
    const [p, i] = idx[j];
    run = Math.min(run, (p * m) / (j + 1));
    out[i] = Math.min(1, run);
  }
  return out;
}
const sma = (xs, n) => (xs.length >= n ? mean(xs.slice(-n)) : null);

// ------------------------------------------------------------------ a call ---
const call = (c, pUp, conf, why) => ({ call: c, pUp: Math.round(clampP(pUp) * 1000) / 1000, conf: Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100, why });
const both = (x) => ({ day: x, five: x });
const base = (inp, h = 'day') => inp.baseRate?.[h] ?? 0.5;
const leanCall = (inp, dir, why, h = 'day', conf = 0.1) => (dir > 0 ? call('CALL', base(inp, h) + T.lean, conf, why) : dir < 0 ? call('PUT', base(inp, h) - T.lean, conf, why) : call('NO TRADE', base(inp, h), 0, why));

// ------------------------------------------------------------------ the contestants (FROZEN) ---
// group: baseline | model | ensemble | same-day. `deps` = the reused app functions / tables hashed into the version.
export const CONTESTANTS = [
  {
    id: 'always-call', name: 'Always CALL', group: 'baseline', reuses: null, deps: [],
    predict: (inp) => ({ day: call('CALL', base(inp), 0, 'always CALL (the base rate)'), five: call('CALL', base(inp, 'five'), 0, 'always CALL') }),
  },
  {
    id: 'always-put', name: 'Always PUT', group: 'baseline', reuses: null, deps: [],
    predict: (inp) => ({ day: call('PUT', base(inp), 0, 'always PUT'), five: call('PUT', base(inp, 'five'), 0, 'always PUT') }),
  },
  {
    id: 'coin', name: 'Coin flip (seeded by the date)', group: 'baseline', reuses: 'news-pick.mjs seededIndex', deps: [seededIndex],
    predict: (inp) => {
      const d = seededIndex(`${inp.date}|coin|day`, 2) === 0 ? 'CALL' : 'PUT';
      const f = seededIndex(`${inp.date}|coin|five`, 2) === 0 ? 'CALL' : 'PUT';
      return { day: call(d, 0.5, 0, 'coin flip'), five: call(f, 0.5, 0, 'coin flip') };
    },
  },
  {
    id: 'continuation', name: "Yesterday's direction (continuation)", group: 'baseline', reuses: null, deps: [],
    predict: (inp) => {
      const n = inp.nifty;
      if (n.length < 2) return { skip: 'not enough NIFTY closes' };
      const dir = Math.sign(n.at(-1).close - n.at(-2).close);
      const why = `NIFTY ${dir > 0 ? 'rose' : 'fell'} at the last close (${n.at(-1).date})`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'reversal', name: 'Opposite of yesterday (reversal)', group: 'baseline', reuses: null, deps: [],
    predict: (inp) => {
      const n = inp.nifty;
      if (n.length < 2) return { skip: 'not enough NIFTY closes' };
      const dir = -Math.sign(n.at(-1).close - n.at(-2).close);
      const why = `NIFTY ${dir < 0 ? 'rose' : 'fell'} at the last close (${n.at(-1).date}) → the other way`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'cp-model', name: 'Call/Put model (technical score, raw formula)', group: 'model', reuses: 'groww-predict.mjs techScore + baseProbabilities, indicators.mjs computeIndicators (daily NIFTY)', deps: [techScore, baseProbabilities, computeIndicators],
    predict: (inp) => {
      const rows = inp.nifty.slice(-60);
      if (rows.length < 50) return { skip: 'not enough NIFTY daily bars' };
      const s = techScore(computeIndicators(rows));
      const p = baseProbabilities(s);
      const pUp = p.probUp / (p.probUp + p.probDown);
      const c = s > 0 ? 'CALL' : s < 0 ? 'PUT' : 'NO TRADE';
      return both(call(c, pUp, Math.abs(s), `technical score ${s.toFixed(2)} → formula up ${(pUp * 100).toFixed(0)}% of the directional share`));
    },
  },
  {
    id: 'cp-calibrated', name: 'Call/Put model (calibrated table)', group: 'model', reuses: 'calibration.mjs calibratedProbs on calibration.json 1d (read only) + groww-predict.mjs techScore', deps: [techScore, calibratedProbs, computeIndicators],
    predict: (inp) => {
      const rows = inp.nifty.slice(-60);
      if (rows.length < 50) return { skip: 'not enough NIFTY daily bars' };
      const s = techScore(computeIndicators(rows));
      const t = calibratedProbs('1d', s, inp.cal || {});
      if (!t) return { skip: 'no validated 1d calibration table' };
      const pUp = t.probs.probUp / (t.probs.probUp + t.probs.probDown);
      const c = Math.abs(pUp - 0.5) < 0.005 ? 'NO TRADE' : pUp > 0.5 ? 'CALL' : 'PUT';
      return both(call(c, pUp, Math.abs(pUp - 0.5) * 2, `score ${s.toFixed(2)} → calibrated bucket up ${(pUp * 100).toFixed(1)}% of moves (table fitted ${String(t.meta.fittedAt).slice(0, 10)})`));
    },
  },
  {
    id: 'trade-today', name: '"Trade today?" risk read (NO TRADE when risky, else CALL)', group: 'model', reuses: 'trade-today.mjs signsAt + levelOf', deps: [signsAt, levelOf, KINDS],
    predict: (inp) => {
      const vix = new Map(inp.vix.map((x) => [x.date, x.close]));
      const N = inp.nifty;
      const s = signsAt(N, vix, N.length - 1);
      if (!s) return { skip: 'not enough NIFTY / India VIX history' };
      const on = Object.keys(s.flags).filter((k) => s.flags[k]);
      const lvD = levelOf('intraday', s.flags);
      const lvF = levelOf('fnoSell', s.flags);
      const why = (lv) => `${lv.toUpperCase()}${on.length ? ` (${on.join(', ')})` : ' (no warning sign)'}`;
      return {
        day: lvD === 'stay' ? call('NO TRADE', base(inp), 0, `intraday ${why(lvD)}`) : call('CALL', base(inp), 0.05, `intraday ${why(lvD)} → the base-rate CALL`),
        five: lvF === 'stay' ? call('NO TRADE', base(inp, 'five'), 0, `week ${why(lvF)}`) : call('CALL', base(inp, 'five'), 0.05, `week ${why(lvF)} → the base-rate CALL`),
      };
    },
  },
  {
    id: 'big-move', name: 'Big-move odds (NO TRADE when a small move is expected, else CALL)', group: 'model', reuses: 'big-move.mjs bigMove (HAR σ + standardised tails)', deps: [bigMove],
    predict: async (inp) => {
      if (inp.nifty.length < 400) return { skip: 'not enough NIFTY history for big-move odds' };
      const r = await bigMove({ symbol: '^NSEI', loadCandles: async () => inp.nifty.map((x) => ({ ...x })) });
      const one = r.horizons['1d'].odds.find((x) => x.movePct === 1);
      const fiv = r.horizons['5d'].odds.find((x) => x.movePct === 2);
      const pick = (o, h, k) => (o.prob < o.pastYear
        ? call('NO TRADE', base(inp, h), 0, `P(|move| > ${k}%) ${(o.prob * 100).toFixed(0)}% < past year ${(o.pastYear * 100).toFixed(0)}% → small move expected`)
        : call('CALL', base(inp, h), 0.05, `P(|move| > ${k}%) ${(o.prob * 100).toFixed(0)}% ≥ past year ${(o.pastYear * 100).toFixed(0)}% → the base-rate CALL`));
      return { day: pick(one, 'day', 1), five: pick(fiv, 'five', 2) };
    },
  },
  {
    id: 'positioning', name: 'Options positioning (PCR z-score, contrarian)', group: 'model', reuses: 'options-positioning.mjs positioningDay + withZ, up-rates from its saved test', deps: [withZ],
    params: { zHigh: 1, zLow: -1 },
    predict: (inp) => {
      const ser = withZ(inp.positioning.filter((x) => x && x.pcrOi != null), 'pcrOi', 'pcrOiZ');
      const last = ser.at(-1);
      const prevSession = inp.nifty.at(-1)?.date;
      if (!last || last.date !== prevSession) return { skip: `no NSE F&O positioning for the last session (${prevSession || '?'})` };
      if (last.pcrOiZ == null) return { skip: 'PCR z-score needs 40+ past sessions' };
      const f = (h) => inp.posResult?.horizons?.[h]?.features?.pcrOiZ || null;
      const pr = (h, side) => f(h)?.[side === 'high' ? 'upRateWhenHigh' : 'upRateWhenLow'] ?? (side === 'high' ? base(inp) + T.lean : base(inp) - T.lean);
      const z = last.pcrOiZ;
      const why = `PCR(OI) ${last.pcrOi.toFixed(2)}, z ${z.toFixed(2)} on ${last.date}`;
      const one = (h, hk) => (z >= 1 ? call('CALL', pr(hk, 'high'), Math.min(1, z / 3), `${why} → puts crowded, contrarian CALL`) : z <= -1 ? call('PUT', pr(hk, 'low'), Math.min(1, -z / 3), `${why} → calls crowded, contrarian PUT`) : call('NO TRADE', base(inp, h), 0, `${why} → no extreme`));
      return { day: one('day', '1d'), five: one('five', '5d') };
    },
  },
  {
    id: 'fii', name: 'FII index-futures long ratio (z-score, follow FIIs)', group: 'model', reuses: 'fii.mjs participantOi + fiiFeatures', deps: [fiiFeatures], params: { z: 1 },
    predict: (inp) => {
      const rows = inp.fii.filter((x) => x?.fii);
      const prevSession = inp.nifty.at(-1)?.date;
      if (!rows.length || rows.at(-1).date !== prevSession) return { skip: `no NSE participant OI for the last session (${prevSession || '?'})` };
      const f = fiiFeatures(rows).at(-1);
      if (f.longRatioZ == null) return { skip: 'FII z-score needs 40+ past sessions' };
      const dir = f.longRatioZ >= 1 ? 1 : f.longRatioZ <= -1 ? -1 : 0;
      const why = `FII long ratio ${(f.longRatio * 100).toFixed(1)}%, z ${f.longRatioZ.toFixed(2)} on ${f.date}`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'us-overnight', name: 'US overnight move (S&P 500 close; GIFT NIFTY not available)', group: 'model', reuses: 'market-data.mjs candles (Yahoo ^GSPC)', deps: [], params: { movePct: 0.5 },
    predict: (inp) => {
      const s = inp.spx;
      if (s.length < 2) return { skip: 'no S&P 500 closes' };
      const last = s.at(-1);
      if (Date.parse(`${last.date}T00:00:00Z`) < Date.parse(`${inp.nifty.at(-1)?.date || '1970-01-01'}T00:00:00Z`) - 4 * 86400000) return { skip: 'S&P 500 data stale' };
      const mv = (last.close / s.at(-2).close - 1) * 100;
      const dir = mv >= 0.5 ? 1 : mv <= -0.5 ? -1 : 0;
      const why = `S&P 500 ${mv >= 0 ? '+' : ''}${mv.toFixed(2)}% on ${last.date} (US close before our open)`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'news-pick', name: "Morning news pick's tilt (CALL when it picked stocks, else NO TRADE)", group: 'model', reuses: 'news-pick.mjs (the 08:40 picks, data/news-pick.json)', deps: [],
    predict: (inp) => {
      const d = inp.newsPick;
      if (!d) return { skip: 'the morning news pick did not run for this day' };
      const n = (d.picks || []).length;
      const why = n ? `news pick chose ${d.picks.map((p) => p.symbol).join(', ')}` : `no news pick (${String(d.noPickReason || d.aiNote || 'nothing').slice(0, 80)})`;
      return both(n ? call('CALL', base(inp) + T.lean, 0.1, `${why} → bullish tilt`) : call('NO TRADE', base(inp), 0, why));
    },
  },
  {
    id: 'llm', name: 'Ling / LLM read of overnight news', group: 'model', reuses: 'ling-client.mjs chat (OpenRouter), llm-json.mjs', deps: [extractJson, normalizeConfidence],
    predict: async (inp) => {
      if (!inp.llmKey) return { skip: 'no OpenRouter key — skipped' };
      if (!inp.llm) return { skip: 'no LLM client' };
      const heads = inp.headlines.slice(0, 15).map((h) => `- ${String(h.time).slice(0, 16)} ${h.title}`).join('\n') || '(no headlines)';
      const spx = inp.spx.length >= 2 ? `S&P 500 last close ${((inp.spx.at(-1).close / inp.spx.at(-2).close - 1) * 100).toFixed(2)}% (${inp.spx.at(-1).date}).` : '';
      const msgs = [
        { role: 'system', content: 'You forecast NIFTY 50 for a research scorecard. Testing found no reliable direction signal; a coin flip is the honest default and NO TRADE is allowed. Use only the items given. Reply ONLY with JSON: {"day":{"call":"CALL|PUT|NO TRADE","prob_up":0-1,"confidence":0-1},"five":{"call":"CALL|PUT|NO TRADE","prob_up":0-1,"confidence":0-1},"reason":"one line"}. "day" = today open→close; "five" = today open → close 5 sessions later.' },
        { role: 'user', content: `Session ${inp.date}. Last NIFTY close ${inp.nifty.at(-1)?.close} (${inp.nifty.at(-1)?.date}). ${spx}\nOvernight headlines (before the open):\n${heads}` },
      ];
      let raw;
      try {
        raw = await inp.llm(msgs);
      } catch (err) {
        const m = String(err.message || err);
        return { skip: /401|rejected the API key|OPENROUTER_API_KEY/i.test(m) ? 'OpenRouter key rejected (401) — skipped' : `LLM unavailable (${m.split('\n')[0].slice(0, 80)}) — skipped` };
      }
      const j = extractJson(raw, (o) => 'day' in o);
      if (!j) return { skip: 'LLM reply could not be read' };
      const one = (x) => {
        const c = String(x?.call || '').toUpperCase().replace(/_/g, ' ');
        const p = Number(x?.prob_up);
        return call(CALLS.includes(c) ? c : 'NO TRADE', Number.isFinite(p) ? p : 0.5, normalizeConfidence(x?.confidence, 0.3), String(j.reason || '').slice(0, 160));
      };
      return { day: one(j.day), five: one(j.five || j.day) };
    },
  },
  {
    id: 'vix-regime', name: 'India VIX regime (low → CALL, top 20% → PUT)', group: 'model', reuses: null, deps: [], params: { low: 0.5, high: 0.8, days: 250 },
    predict: (inp) => {
      const v = inp.vix.slice(-250).map((x) => x.close).filter((x) => x > 0);
      if (v.length < 200) return { skip: 'not enough India VIX history' };
      const now = v.at(-1);
      const rank = v.filter((x) => x <= now).length / v.length;
      const dir = rank <= 0.5 ? 1 : rank >= 0.8 ? -1 : 0;
      const why = `India VIX ${now.toFixed(2)} — percentile rank ${(rank * 100).toFixed(0)}% of the past year`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'trend-20-50', name: '20/50-day trend', group: 'model', reuses: null, deps: [],
    predict: (inp) => {
      const c = inp.nifty.map((x) => x.close);
      if (c.length < 50) return { skip: 'not enough NIFTY closes' };
      const s20 = sma(c, 20);
      const s50 = sma(c, 50);
      const last = c.at(-1);
      const dir = last > s20 && s20 > s50 ? 1 : last < s20 && s20 < s50 ? -1 : 0;
      const why = `close ${last.toFixed(0)} · 20-day ${s20.toFixed(0)} · 50-day ${s50.toFixed(0)}`;
      return { day: leanCall(inp, dir, why), five: leanCall(inp, dir, why, 'five') };
    },
  },
  {
    id: 'majority', name: 'Ensemble: majority vote of the app models', group: 'ensemble', reuses: null, deps: [],
    predict: (inp, ctx) => {
      const out = {};
      for (const h of ['day', 'five']) {
        const votes = Object.entries(ctx.calls).filter(([id]) => ctx.groupOf(id) === 'model').map(([, x]) => x?.[h]).filter((x) => x && x.call !== 'NO TRADE');
        const up = votes.filter((x) => x.call === 'CALL').length;
        const dn = votes.length - up;
        const p = votes.length ? mean(votes.map((x) => x.pUp)) : base(inp, h);
        out[h] = call(up > dn ? 'CALL' : dn > up ? 'PUT' : 'NO TRADE', p, votes.length ? Math.abs(up - dn) / votes.length : 0, `${up} CALL · ${dn} PUT of ${votes.length} model votes`);
      }
      return out;
    },
  },
  {
    id: 'weighted', name: 'Ensemble: weighted by trailing forward score (past days only)', group: 'ensemble', reuses: null, deps: [], params: { minN: 10, shrink: 20 },
    predict: (inp, ctx) => {
      const out = {};
      for (const h of ['day', 'five']) {
        let s = 0;
        let w = 0;
        let pw = 0;
        const used = [];
        for (const [id, x] of Object.entries(ctx.calls)) {
          if (ctx.groupOf(id) === 'ensemble' || !x?.[h] || x[h].call === 'NO TRADE') continue;
          const tr = inp.trail?.[id]?.[h];
          if (!tr || tr.n < 10) continue;
          const wt = Math.max(0, tr.hits / tr.n - 0.5) * (tr.n / (tr.n + 20));
          if (!(wt > 0)) continue;
          s += wt * (x[h].call === 'CALL' ? 1 : -1);
          w += wt;
          pw += wt * x[h].pUp;
          used.push(id);
        }
        out[h] = w > 0 && s !== 0
          ? call(s > 0 ? 'CALL' : 'PUT', pw / w, Math.abs(s) / w, `weighted vote of ${used.length} contestant(s) with a positive trailing record`)
          : call('NO TRADE', base(inp, h), 0, 'no contestant has a positive trailing forward record yet (10+ scored calls before today)');
      }
      return out;
    },
  },
];
/** The same-day contestant (scored on its own window; predicted at 12:25 from bars up to 12:25 only). */
export const SAME_DAY = {
  id: 'afternoon-t1', name: 'Afternoon trend T1 (12:25 signal → 12:30–15:15)', group: 'same-day', reuses: 'afternoon-trend.mjs detectSignal (+ its paper record for the real option P&L)', deps: [detectSignal],
  predict: (bars) => {
    const s = detectSignal(bars);
    if (s.retry) return { skip: s.reason };
    const why = `NIFTY ${(s.move * 100).toFixed(2)}% from the open at 12:25`;
    return { pm: s.type === 'CE' ? call('CALL', 0.5 + T.lean, 0.1, `${why}, at the day's high`) : s.type === 'PE' ? call('PUT', 0.5 - T.lean, 0.1, `${why}, at the day's low`) : call('NO TRADE', 0.5, 0, s.reason) };
  },
};
const ALL = () => [...CONTESTANTS, SAME_DAY];
export const groupOf = (id) => ALL().find((c) => c.id === id)?.group || null;

// ------------------------------------------------------------------ frozen versions ---
const src = (d) => (typeof d === 'function' ? d.toString() : JSON.stringify(d));
/** 12-hex version: the contestant's predict code + the reused functions / tables it calls + its parameters. */
export function versionOf(c) {
  const h = createHash('sha256');
  h.update(String(c.id));
  h.update('\0');
  h.update(c.predict.toString());
  for (const d of c.deps || []) h.update(`\0${src(d)}`);
  h.update(`\0${JSON.stringify(c.params || {})}`);
  h.update(`\0${JSON.stringify(T)}`);
  return h.digest('hex').slice(0, 12);
}
export const versions = () => Object.fromEntries(ALL().map((c) => [c.id, versionOf(c)]));

// ------------------------------------------------------------------ trailing scores (strictly before a date) ---
/** Each contestant's scored CALL/PUT record from real (non-test) days strictly BEFORE `date`, current versions only. */
export function trailingScores(st, date, vers = versions()) {
  const out = {};
  for (const d of st?.days || []) {
    if (d.test || !(d.date < date)) continue;
    for (const [id, p] of Object.entries(d.preds || {})) {
      if (p.version !== vers[id]) continue;
      for (const h of ['day', 'five']) {
        const sc = p.score?.[h];
        if (!sc || sc.hit == null) continue;
        // a 5-session call is only known after its 5th session: it counts only if that ended before `date`
        if (h === 'five' && !(sc.endDate < date)) continue;
        const o = ((out[id] ||= {})[h] ||= { n: 0, hits: 0 });
        o.n++;
        if (sc.hit) o.hits++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ running the contestants ---
/** All contestants on guarded inputs: ordinary ones first, the ensembles on their calls. Never throws. */
export async function runContestants(inp, { list = CONTESTANTS } = {}) {
  assertPreOpen(inp);
  const vers = versions();
  const preds = {};
  const calls = {};
  for (const c of list.filter((x) => x.group !== 'ensemble')) {
    try {
      const r = await c.predict(inp, {});
      preds[c.id] = r?.skip ? { version: vers[c.id], skipped: r.skip } : { version: vers[c.id], day: r.day, five: r.five };
      if (!r?.skip) calls[c.id] = r;
    } catch (err) {
      preds[c.id] = { version: vers[c.id], skipped: `error: ${String(err.message || err).slice(0, 120)}` };
    }
  }
  for (const c of list.filter((x) => x.group === 'ensemble')) {
    try {
      const r = await c.predict(inp, { calls, groupOf });
      preds[c.id] = { version: vers[c.id], day: r.day, five: r.five };
    } catch (err) {
      preds[c.id] = { version: vers[c.id], skipped: `error: ${String(err.message || err).slice(0, 120)}` };
    }
  }
  return preds;
}

// ------------------------------------------------------------------ data (all injectable) ---
const readJ = (p, fb = null) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb;
  } catch {
    return fb;
  }
};
async function yahoo(sym, from) {
  const { candles } = await import('../market-data.mjs');
  return (await candles(sym, { period1: Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000), interval: '1d' })).filter((x) => x.close > 0 && x.open > 0);
}
/** Positioning series for the sessions in `dates` (cached files; missing days downloaded until the deadline). */
async function positioningSeries(dates, niftyByDate, deadline) {
  const { positioningDay } = await import('./options-positioning.mjs');
  const dir = process.env.FO_POS_DIR || join(HERE, 'data', 'fo-positioning');
  const have = new Set(existsSync(dir) ? readdirSync(dir).map((f) => f.slice(0, 10)) : []);
  const out = [];
  let fetched = 0;
  for (const d of dates) {
    if (!have.has(d) && Date.now() > deadline) continue;
    try {
      const x = await positioningDay(d, niftyByDate.get(d) || null);
      if (!have.has(d)) fetched++;
      if (x) out.push(x);
    } catch {
      /* blocked / offline: this day is missing */
    }
  }
  return { rows: out, fetched };
}
async function fiiSeries(dates, deadline) {
  const { participantOi } = await import('./fii.mjs');
  const dir = process.env.FII_DIR || join(HERE, 'data', 'fii');
  const have = new Set(existsSync(dir) ? readdirSync(dir).map((f) => f.slice(0, 10)) : []);
  const out = [];
  let fetched = 0;
  for (const d of dates) {
    if (!have.has(d) && Date.now() > deadline) continue;
    try {
      const x = await participantOi(d);
      if (!have.has(d)) fetched++;
      if (x?.FII) out.push({ date: d, fii: x.FII });
    } catch {
      break; // NSE blocking: stop
    }
  }
  return { rows: out, fetched };
}
async function marketHeadlines() {
  const { parseRss } = await import('./news.mjs');
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent('Nifty Sensex stock market when:1d')}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  return parseRss(await res.text()).filter((x) => x.providerPublishTime).map((x) => ({ time: new Date(x.providerPublishTime * 1000).toISOString(), title: x.title }));
}
async function defaultLlm(messages) {
  const { chat } = await import('../ling-client.mjs');
  return chat(messages, { temperature: 0, timeoutMs: 60_000, jsonKeys: ['day'] });
}
/** Raw inputs for a prediction of `date` (the guard is applied afterwards by guardInputs). */
export async function loadInputs(date, { now = new Date(), deadline = Infinity, st = null } = {}) {
  const errors = [];
  const from = addDays(date, -365 * 6);
  const safe = async (label, f, fb) => {
    try {
      return await f();
    } catch (err) {
      errors.push(`${label}: ${String(err.message || err).split('\n')[0].slice(0, 100)}`);
      return fb;
    }
  };
  const [nifty, vix, spx] = await Promise.all([safe('NIFTY', () => yahoo('^NSEI', from), []), safe('India VIX', () => yahoo('^INDIAVIX', from), []), safe('S&P 500', () => yahoo('^GSPC', addDays(date, -40)), [])]);
  const cutoff = cutoffFor(date, now);
  const pre = preOpen(nifty, 'india', cutoff);
  const sessions = pre.slice(-75).map((x) => x.date);
  const byDate = new Map(pre.map((x) => [x.date, x.close]));
  const pos = await safe('positioning', () => positioningSeries(sessions, byDate, deadline), { rows: [], fetched: 0 });
  const fii = await safe('FII', () => fiiSeries(sessions, deadline), { rows: [], fetched: 0 });
  const np = readJ(process.env.NEWS_PICK_PATH || join(HERE, 'data', 'news-pick.json'));
  const key = Boolean(process.env.OPENROUTER_API_KEY);
  const headlines = key ? await safe('headlines', marketHeadlines, []) : [];
  return {
    nifty, vix, spx, positioning: pos.rows, fii: fii.rows, headlines,
    newsPick: np?.days?.[date] || null,
    cal: loadCalibration(), bigMoveEval: loadBigMoveEval(), posResult: loadPositioningResult(),
    llm: key ? defaultLlm : null, llmKey: key,
    baseRate: st?.baseRate || baseRateFrom(pre),
    trail: trailingScores(st, date),
    fetched: { positioning: pos.fetched, fii: fii.fetched },
    errors,
  };
}
/** Base rates from pre-start NIFTY bars: share of sessions up open → close, and open → 5th close. */
export function baseRateFrom(rows, n = T.baseRateSessions) {
  const r = rows.filter((x) => x.open > 0 && x.close > 0).slice(-n - 4);
  const day = r.slice(-n);
  const five = [];
  for (let i = 0; i + 4 < r.length; i++) five.push(r[i + 4].close > r[i].open);
  return {
    day: day.length ? day.filter((x) => x.close > x.open).length / day.length : 0.5,
    five: five.length ? five.filter(Boolean).length / five.length : 0.5,
    sessions: day.length, from: day[0]?.date || null, to: day.at(-1)?.date || null,
  };
}

// ------------------------------------------------------------------ the morning run ---
export const loadTournament = (file = STATE()) => readJ(file);
const freshState = () => ({ startedAt: null, createdAt: new Date().toISOString(), days: [], tests: [], contestants: {} });
const atrPctOf = (rows) => {
  const a = computeIndicators(rows.slice(-60)).atr14;
  const c = rows.at(-1)?.close;
  return a && c ? a / c : null;
};

/**
 * The 08:40 prediction. Without `date`: today (IST); quietly skips holidays, runs at/after 09:15 and days already
 * predicted. With `date` (or `test`): a TEST entry for that session (kept apart, never scored).
 */
export async function predictDay({ now = new Date(), date = null, test = false, file = STATE(), inputsFn = loadInputs, clock = () => new Date() } = {}) {
  const t = istNow(now);
  const isTest = Boolean(test || date);
  const d = date || t.date;
  if (!isTradingDay(d)) return { skipped: 'holiday', date: d, message: `${d}: not an NSE trading day — no tournament calls.` };
  if (!isTest && t.mins >= T.openMins) return { skipped: 'late', date: d, message: `${d} ${t.hhmm} IST: too late — calls must be made before the 09:15 open. Use --date for a TEST entry (not scored).` };
  const st = loadTournament(file) || freshState();
  st.days ||= [];
  st.tests ||= [];
  if (!isTest && st.days.some((x) => x.date === d)) return { skipped: 'done', date: d, message: `${d}: today's calls were already made — the first calls stand.` };
  const deadline = isTest ? Infinity : Date.parse(`${d}T00:00:00Z`) + (T.deadlineMins - 330) * 60000;
  const raw = await inputsFn(d, { now, deadline, st });
  const inp = guardInputs(raw, d, now);
  const preds = await runContestants(inp);
  const finished = istNow(clock());
  const late = !isTest && (finished.date !== d || finished.mins >= T.openMins);
  const vers = versions();
  for (const c of ALL()) st.contestants[c.id] = { name: c.name, group: c.group, reuses: c.reuses, version: vers[c.id] };
  const rec = {
    date: d, test: isTest || late, testReason: isTest ? 'TEST entry (--date) — shown, never scored' : late ? `finished at ${finished.hhmm} IST, after the 09:15 open — not scored` : null,
    madeAt: now.toISOString(), finishedAt: clock().toISOString(), cutoff: new Date(inp.cutoff).toISOString(),
    lastClose: inp.nifty.at(-1) ? { date: inp.nifty.at(-1).date, close: inp.nifty.at(-1).close } : null,
    atrPct: atrPctOf(inp.nifty), expiry: isExpiryDay(d, 'NIFTY'), preds, errors: raw.errors || [], fetched: raw.fetched || null,
  };
  if (rec.test) st.tests = [...st.tests.filter((x) => x.date !== d), rec].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-20);
  else {
    if (!st.startedAt) {
      st.startedAt = d;
      st.baseRate = inp.baseRate;
    }
    st.days = [...st.days, rec].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  st.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, st);
  return { date: d, rec, st };
}

// ------------------------------------------------------------------ scoring ---
/** One prediction's score for a horizon from the realised outcome. */
export function scoreOne(pred, out, baseP) {
  if (!pred || !out) return null;
  const up = out.up;
  const s = { up, ret: out.ret, brier: brier(pred.pUp, up), brierRef: brier(baseP, up), ll: logLoss(pred.pUp, up), llRef: logLoss(baseP, up), endDate: out.endDate };
  if (pred.call === 'NO TRADE') return { ...s, hit: null, noTrade: true };
  return { ...s, hit: pred.call === 'CALL' ? up : !up };
}
/** Futures-move proxy P&L: sized so one daily ATR = ₹2,000; futures charges both ways (costs.mjs, STT 0.05% from Apr 2026). */
export function futuresProxy(dir, ret, atrPct, date) {
  if (!(atrPct > 0) || ret == null) return null;
  const notional = T.riskRs / atrPct;
  const chg = futuresCharges({ side: 'buy', value: notional, date }).total + futuresCharges({ side: 'sell', value: notional * (1 + ret), date }).total;
  return { pnl: notional * dir * ret - chg, charges: chg, source: 'futures-move proxy' };
}
/** Real ATM weekly option bought at 09:20 (open of the 09:20 bar) and sold at 15:15 (open of the 15:15 bar). */
export function optionDayTrade(bars, date) {
  const day = (bars || []).filter((b) => String(b.date).slice(0, 10) === date && b.open > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hm = (b) => String(b.date).slice(11, 16);
  const e = day.find((b) => hm(b) >= '09:20' && hm(b) <= '09:30');
  const x = day.find((b) => hm(b) >= '15:15' && hm(b) <= '15:25');
  if (!e || !x) return null;
  const lot = 65;
  const cost = fillBuy(e.open) + optCharges(e.open, date, lot, 'buy');
  const proc = fillSell(x.open) - optCharges(x.open, date, lot, 'sell');
  const ret = (proc - cost) / cost;
  return { entry: { time: hm(e), price: e.open }, exit: { time: hm(x), price: x.open }, ret, pnl: ret * T.riskRs, source: 'real option (Groww 5-minute)' };
}
/** Paper P&L for one day-horizon call: none on a NIFTY expiry day; real option if priced, else the futures proxy. */
export function dayPnl(pred, out, { date, atrPct, expiry, option }) {
  if (!pred || pred.call === 'NO TRADE') return null;
  if (expiry) return { pnl: null, source: 'NIFTY expiry day — no option bought (never on expiry day)' };
  const dir = pred.call === 'CALL' ? 1 : -1;
  if (option?.[pred.call]) return option[pred.call];
  return futuresProxy(dir, out.ret, atrPct, date);
}

async function defaultOutcomes(from) {
  const rows = await yahoo('^NSEI', addDays(from, -10));
  return rows;
}
async function defaultOption({ date, type, spot }) {
  const { growwOptions } = await import('./afternoon-trend.mjs');
  const o = await growwOptions({ date, type, spot });
  return o?.bars ? optionDayTrade(o.bars, date) : null;
}
async function defaultBars(date) {
  const { niftyBarsFor } = await import('./afternoon-trend.mjs');
  return (await niftyBarsFor(date)).bars;
}
const pmOutcome = (bars, date) => {
  const day = (bars || []).filter((b) => String(b.date).slice(0, 10) === date && b.close > 0);
  const hm = (b) => String(b.date).slice(11, 16);
  const a = day.find((b) => hm(b) === '12:30');
  const z = day.find((b) => hm(b) === '15:15');
  if (!a || !z) return null;
  return { up: z.close > a.open, ret: z.close / a.open - 1, endDate: date, open: a.open, close: z.close };
};

/** Evening: score every real day (and the T1 same-day calls) whose outcome is known. */
export async function scoreTournament({ now = new Date(), file = STATE(), outcomesFn = defaultOutcomes, optionFn = defaultOption, barsFn = defaultBars, afternoonFile = process.env.AFTERNOON_TREND_PAPER_PATH || join(HERE, 'data', 'afternoon-trend-paper.json') } = {}) {
  const st = loadTournament(file);
  if (!st?.days?.length) return { scoredNow: 0, st, message: 'Nothing to score yet: the tournament starts with the first real 08:40 run.' };
  const upTo = lastSessionDate(now);
  const open = st.days.filter((d) => !d.test && d.date <= upTo && (!d.scored?.day || !d.scored?.five || !d.scored?.pm));
  if (!open.length) return { scoredNow: 0, st };
  const rows = await outcomesFn(open[0].date);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const at = readJ(afternoonFile);
  let scoredNow = 0;
  const errors = [];
  for (const d of open) {
    d.scored ||= {};
    const bar = byDate.get(d.date);
    const sessions = tradingDaysBetween(d.date, addDays(d.date, 20));
    const end5 = sessions[4];
    const outs = {
      day: bar ? { up: bar.close > bar.open, ret: bar.close / bar.open - 1, endDate: d.date, open: bar.open, close: bar.close } : null,
      five: bar && end5 && end5 <= upTo && byDate.get(end5) ? { up: byDate.get(end5).close > bar.open, ret: byDate.get(end5).close / bar.open - 1, endDate: end5, open: bar.open, close: byDate.get(end5).close } : null,
    };
    // real option prices for the day horizon (once per side), never on an expiry day
    if (outs.day && !d.scored.day && !d.expiry) {
      d.option ||= {};
      for (const side of ['CALL', 'PUT']) {
        if (d.option[side] !== undefined || !Object.values(d.preds).some((p) => p.day?.call === side)) continue;
        try {
          d.option[side] = await optionFn({ date: d.date, type: side === 'CALL' ? 'CE' : 'PE', spot: bar.open });
        } catch (err) {
          d.option[side] = null;
          errors.push(`${d.date} ${side} option: ${String(err.message).slice(0, 80)}`);
        }
      }
    }
    for (const h of ['day', 'five']) {
      if (d.scored[h] || !outs[h]) continue;
      for (const p of Object.values(d.preds)) {
        if (!p[h]) continue;
        const sc = scoreOne(p[h], outs[h], st.baseRate?.[h] ?? 0.5);
        if (sc.hit != null) {
          const pl = h === 'day' ? dayPnl(p.day, outs.day, { date: d.date, atrPct: d.atrPct, expiry: d.expiry, option: d.option }) : futuresProxy(p.five.call === 'CALL' ? 1 : -1, outs.five.ret, d.atrPct, d.date);
          if (pl) Object.assign(sc, { pnl: pl.pnl, pnlSource: pl.source });
        }
        (p.score ||= {})[h] = sc;
      }
      d.outcome = { ...(d.outcome || {}), [h]: outs[h] };
      d.scored[h] = now.toISOString();
      scoredNow++;
    }
    // the same-day contestant: 12:25 signal from bars up to 12:25 only, scored 12:30 → 15:15
    if (!d.scored.pm) {
      let bars = [];
      try {
        bars = await barsFn(d.date);
      } catch {
        bars = [];
      }
      const pmOut = pmOutcome(bars, d.date);
      if (pmOut) {
        const upto = bars.filter((b) => String(b.date).slice(0, 10) === d.date && String(b.date).slice(11, 16) <= '12:25');
        const r = SAME_DAY.predict(upto);
        const v = versionOf(SAME_DAY);
        if (r.skip) d.preds[SAME_DAY.id] = { version: v, skipped: r.skip, predictedAt: 'replay 12:25' };
        else {
          const sc = scoreOne(r.pm, pmOut, 0.5);
          if (sc.hit != null) {
            const atDay = (at?.days || []).find((x) => x.date === d.date && !x.test);
            const pl = d.expiry ? { pnl: null, source: 'NIFTY expiry day — no option bought' } : atDay?.status === 'trade' ? { pnl: atDay.pnl, source: 'afternoon-trend paper record (real option)' } : futuresProxy(r.pm.call === 'CALL' ? 1 : -1, pmOut.ret, d.atrPct, d.date);
            if (pl) Object.assign(sc, { pnl: pl.pnl, pnlSource: pl.source });
          }
          d.preds[SAME_DAY.id] = { version: v, pm: r.pm, predictedAt: 'replay 12:25 (bars up to 12:25 only)', score: { pm: sc } };
        }
        d.outcome = { ...(d.outcome || {}), pm: pmOut };
        d.scored.pm = now.toISOString();
        scoredNow++;
      }
    }
  }
  st.lastScore = { at: now.toISOString(), upTo, scoredNow, errors };
  writeJsonAtomic(file, st);
  return { scoredNow, st, errors };
}

// ------------------------------------------------------------------ leaderboard ---
/** Per-contestant stats for a horizon from the scored real days (current versions only). */
export function contestantStats(st, h, id, vers = versions()) {
  const rows = [];
  for (const d of st?.days || []) {
    if (d.test) continue;
    const p = d.preds?.[id];
    if (!p || p.version !== vers[id] || !p.score?.[h]) continue;
    rows.push({ date: d.date, ...p.score[h], call: p[h]?.call });
  }
  const calls = rows.filter((r) => r.hit != null);
  const hits = calls.filter((r) => r.hit).length;
  const n = calls.length;
  const pnls = calls.filter((r) => r.pnl != null);
  let cum = 0;
  return {
    id, n, hits, hitRate: n ? hits / n : null, ci: wilson(hits, n), noTrade: rows.filter((r) => r.noTrade).length, predictions: rows.length,
    brier: rows.length ? mean(rows.map((r) => r.brier)) : null, brierRef: rows.length ? mean(rows.map((r) => r.brierRef)) : null,
    brierSkill: rows.length ? brierSkill(mean(rows.map((r) => r.brier)), mean(rows.map((r) => r.brierRef))) : null,
    logLoss: rows.length ? mean(rows.map((r) => r.ll)) : null, logLossRef: rows.length ? mean(rows.map((r) => r.llRef)) : null,
    pnl: pnls.reduce((a, r) => a + r.pnl, 0), pnlDays: pnls.length, tDay: tStat(pnls.map((r) => r.pnl)),
    realOption: pnls.filter((r) => /real option/.test(r.pnlSource || '')).length,
    spark: calls.map((r) => (cum += r.hit ? 1 : 0)),
  };
}
/** Leaderboard for a horizon: stats, the bar, one-sided p-values, Holm and BH adjustments, status, verdict. */
export function leaderboard(st, h = 'day', vers = versions()) {
  const ids = h === 'pm' ? [SAME_DAY.id] : CONTESTANTS.map((c) => c.id);
  const rows = ids.map((id) => ({ ...contestantStats(st, h, id, vers), name: ALL().find((c) => c.id === id).name, group: groupOf(id) }));
  const ac = h === 'pm' ? null : rows.find((r) => r.id === 'always-call');
  const baseHit = ac?.n ? ac.hitRate : null;
  const bar = Math.max(0.5, baseHit ?? 0);
  const tested = rows.filter((r) => r.id !== 'always-call');
  const ps = tested.map((r) => pAbove(r.hits, r.n, bar));
  const hol = holm(ps);
  const q = bh(ps);
  tested.forEach((r, i) => Object.assign(r, { p: ps[i], pHolm: hol[i], qBH: q[i] }));
  for (const r of rows) {
    const reasons = [];
    if (r.n < T.minN) reasons.push(`${r.n} of ${T.minN} scored calls`);
    if (!(r.ci && r.ci[0] > bar)) reasons.push(`hit-rate interval lower bound ${r.ci ? `${(r.ci[0] * 100).toFixed(0)}%` : '–'} not above ${(bar * 100).toFixed(0)}% (max of 50% and always-CALL)`);
    if (!(r.brierSkill > 0)) reasons.push('Brier skill not positive');
    if (!(r.pnl > 0)) reasons.push('P&L after costs not positive');
    if (r.id !== 'always-call' && !(r.pHolm != null && r.pHolm < T.alpha)) reasons.push(`Holm-adjusted p ${r.pHolm == null ? '–' : r.pHolm.toFixed(2)} not < ${T.alpha}`);
    if (r.id === 'always-call') reasons.push('the reference (base rate)');
    r.proven = reasons.length === 0;
    r.why = reasons;
  }
  const ranked = [...rows].sort((a, b) => (b.ci?.[0] ?? -1) - (a.ci?.[0] ?? -1) || (b.hitRate ?? -1) - (a.hitRate ?? -1) || (b.n - a.n));
  const leader = ranked.find((r) => r.n > 0) || null;
  for (const r of rows) r.status = r.proven ? 'PROVEN (forward, after Holm)' : leader && r.id === leader.id ? 'LEADING — still unproven' : 'unproven';
  const proven = rows.filter((r) => r.proven);
  return {
    horizon: h, label: HORIZONS[h], rows: ranked, baseHit, bar, leader: leader?.id || null, proven: proven.map((r) => r.id),
    correction: `One-sided binomial test of each contestant's hit rate vs ${(bar * 100).toFixed(1)}% (the higher of 50% and always-CALL's hit rate), ${tested.length} contestants: Holm step-down (family-wise 5%) decides "proven"; Benjamini–Hochberg q-values shown too.`,
    verdict: proven.length ? `${proven.map((r) => r.name).join(', ')} passed every check — still re-check as the record grows.` : `No contestant is proven. ${leader ? `${leader.name} leads (${leader.n} scored calls) — still unproven.` : 'Nothing scored yet.'} This is the most likely outcome: daily NIFTY direction has not been predictable in any test.`,
  };
}

// ------------------------------------------------------------------ the card ---
export function tournamentView({ now = new Date(), file = STATE() } = {}) {
  const st = loadTournament(file) || freshState();
  const vers = versions();
  const latestReal = (st.days || []).at(-1) || null;
  const latestTest = (st.tests || []).at(-1) || null;
  const today = latestTest && (!latestReal || latestTest.date >= latestReal.date) ? latestTest : latestReal;
  let history = null;
  try {
    const sc = liveScore();
    history = sc ? { scored: sc.scored, topCallRight: sc.topCallRight, alwaysMostCommonRight: sc.alwaysMostCommonRight, mostCommon: sc.mostCommon, directionRight: sc.directionRight, directionCalls: sc.directionCalls, brierApp: sc.brierApp, brierCoin: sc.brierCoin, verdict: sc.verdict } : null;
  } catch {
    history = null;
  }
  let xp = null;
  try {
    const s = expiryStatus(now);
    xp = { session: s.session, niftyExpiry: isExpiryDay(s.session, 'NIFTY'), next: s.next.find((x) => x.index === 'NIFTY')?.weekly || null };
  } catch {
    xp = null;
  }
  return {
    startedAt: st.startedAt || null, baseRate: st.baseRate || null, updatedAt: st.updatedAt || null, lastScore: st.lastScore || null,
    today: today ? { date: today.date, test: today.test, testReason: today.testReason, madeAt: today.madeAt, cutoff: today.cutoff, lastClose: today.lastClose, expiry: today.expiry, errors: today.errors,
      calls: ALL().map((c) => ({ id: c.id, name: c.name, group: c.group, version: vers[c.id], ...(today.preds?.[c.id] || (c.id === SAME_DAY.id ? { skipped: 'predicts at 12:25 (replayed after the close)' } : { skipped: 'no call' })) })) } : null,
    boards: { day: leaderboard(st, 'day', vers), five: leaderboard(st, 'five', vers), pm: leaderboard(st, 'pm', vers) },
    contestants: ALL().map((c) => ({ id: c.id, name: c.name, group: c.group, reuses: c.reuses, version: vers[c.id] })),
    recent: (st.days || []).slice(-10).reverse().map((d) => ({ date: d.date, outcome: d.outcome || null, expiry: d.expiry })),
    // the scorecard numbers in the intro come from the live scorecard, not a fixed snapshot (round 79, O-B17)
    history, expiry: xp, why: history?.scored && history.topCallRight != null && history.alwaysMostCommonRight != null ? WHY.replace('top Call/Put call right 35–36% vs always-Up 45–47% on the live scorecard', `top Call/Put call right ${Math.round(history.topCallRight * 100)}% vs always-"${String(history.mostCommon || 'most common').replace(/ \(.*\)$/, '')}" ${Math.round(history.alwaysMostCommonRight * 100)}% on the live scorecard, ${history.scored} scored`) : WHY, gift: GIFT_NOTE, horizons: HORIZONS,
    rules: [
      `Calls at ~08:15 IST from data whose bar closed before the 09:15 open; a run that finishes after 09:15 is not scored.`,
      `Proven only with ≥ ${T.minN} scored calls, a 95% Wilson lower bound above both 50% and always-CALL's hit rate, positive Brier skill vs the base rate, positive P&L after costs, and Holm-adjusted p < ${T.alpha}.`,
      `P&L: ₹${T.riskRs.toLocaleString('en-IN')} at risk on ₹1 lakh — a real ATM weekly NIFTY option 09:20 → 15:15 when Groww 5-minute prices exist (STT 0.15% of premium on the sale from Apr 2026, ₹20 an order, slippage), else a NIFTY futures-move proxy sized so one daily ATR = ₹2,000. Never an option on a NIFTY expiry day (no P&L that day).`,
      'Each contestant is frozen: its version hash covers its code, the app functions it reuses and its parameters; a new hash starts a new record.',
    ],
    note: NOTE,
  };
}
/** The existing Call/Put card's live scorecard (prediction-log.mjs liveScorecard) — the tournament's starting history. */
const liveScore = () => liveScorecard();

// ------------------------------------------------------------------ CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  try {
    if (args.includes('--predict')) {
      const dI = args.indexOf('--date');
      const date = dI >= 0 ? args[dI + 1] : null;
      if (dI >= 0 && !/^\d{4}-\d\d-\d\d$/.test(date || '')) throw new Error('usage: --predict [--date YYYY-MM-DD]');
      const r = await predictDay({ date, test: args.includes('--test') });
      if (r.skipped) {
        console.log(r.message);
        process.exit(0);
      }
      const x = r.rec;
      console.log(`Call / Put tournament ${x.date}${x.test ? ` — ${x.testReason}` : ''} · data cut-off ${x.cutoff} · last close ${x.lastClose?.date} ${x.lastClose?.close?.toFixed(2)}${x.expiry ? ' · NIFTY EXPIRY DAY (no option P&L)' : ''}`);
      for (const c of CONTESTANTS) {
        const p = x.preds[c.id];
        if (p.skipped) console.log(`  ${c.id.padEnd(14)} SKIPPED: ${p.skipped}`);
        else console.log(`  ${c.id.padEnd(14)} today ${p.day.call.padEnd(8)} P(up) ${pc(p.day.pUp).padStart(4)} conf ${p.day.conf.toFixed(2)} · 5 sessions ${p.five.call.padEnd(8)} P(up) ${pc(p.five.pUp).padStart(4)} — ${p.day.why}`);
      }
      console.log(`  ${SAME_DAY.id.padEnd(14)} predicts at 12:25 (replayed after the close), scored 12:30 → 15:15`);
      if (x.errors.length) console.log(`Problems: ${x.errors.join(' · ')}`);
      if (x.fetched) console.log(`Downloaded: ${x.fetched.positioning} positioning day(s), ${x.fetched.fii} FII day(s)`);
      console.log(`${NOTE}`);
    } else if (args.includes('--score')) {
      const r = await scoreTournament();
      console.log(r.message || `Call / Put tournament scoring: ${r.scoredNow} new score(s)${r.errors?.length ? ` · ${r.errors.join(' · ')}` : ''}`);
      if (r.st?.days?.length) {
        const b = leaderboard(r.st, 'day');
        for (const row of b.rows.slice(0, 5)) console.log(`  ${row.id.padEnd(14)} ${row.n} calls · hit ${pc(row.hitRate)} ${row.ci ? `[${pc(row.ci[0])}–${pc(row.ci[1])}]` : ''} · P&L ₹${Math.round(row.pnl)} · ${row.status}`);
        console.log(b.verdict);
      }
      console.log(NOTE);
    } else {
      console.log('usage: node paper-bot/cp-tournament.mjs --predict [--date YYYY-MM-DD] | --score');
      process.exit(2);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
