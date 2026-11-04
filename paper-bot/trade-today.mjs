#!/usr/bin/env node
// "Trade today?" (library + CLI): Go / Be careful / Stay out for the next session, for each kind of trading,
// from warning signs known at the last close (NIFTY and India VIX). Tested on NIFTY since 2010 — rules picked
// on 2010–18, checked on 2019→: none of these signs tells whether the next day will be UP or DOWN (down days
// stay ≈ 46–53% after every sign), but several reliably come before WILD days (big swings that hit intraday
// stops) and 2%+ weeks (that breach sold strangles / credit spreads). So "Stay out" means "risk is high
// today", not "the market will fall". It can't promise a profit on the other days. Not advice.
//
//   node paper-bot/trade-today.mjs

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { lastSessionDate } from './market-calendar.mjs';
import { nextTradingDay } from './my-plan.mjs';

export const SIGNS = {
  vixJump: 'India VIX jumped 10% or more at the last close (fear rising fast)',
  bigFall: 'NIFTY fell 1.5% or more at the last close',
  bigMove: 'NIFTY moved 1.5% or more (up or down) at the last close',
  wideRange: 'the last day\'s high–low swing was 1.5× the usual (last 20 days)',
  down3: 'NIFTY closed lower 3 days or more in a row',
  vixHigh: 'India VIX is in its highest 20% of the past year',
  below200: 'NIFTY is below its 200-day average',
};
// rules fixed on 2010–18 (judged once on 2019→); each kind has the outcome that hurts it
export const KINDS = {
  intraday: { name: 'Intraday (stocks or F&O, bought and sold the same day)', outcome: 'wild', stay: ['vixJump', 'bigFall'], careful: ['wideRange', 'down3', 'vixHigh', 'bigMove'] },
  fnoSell: { name: 'F&O selling for the week (strangles, credit spreads, condors)', outcome: 'week2', stay: ['vixJump', 'bigMove', 'vixHigh', 'below200'], careful: ['wideRange', 'down3'] },
  fnoBuy: { name: 'F&O buying (calls, puts, debit spreads) held for days', outcome: 'week2', stay: [], careful: [], untested: true }, // big weeks HELP a buyer, but options cost more then: no sign tested here
  swing: { name: 'Swing trades (stocks for days to weeks)', outcome: 'fall3', stay: [], careful: ['vixHigh', 'vixJump'] },
  invest: { name: 'Monthly investing (Steady mix, India mix, Momentum 10)', outcome: 'fall3', stay: [], careful: [] },
};
const ADVICE = {
  intraday: { stay: 'Sit out today: wild swings are about 2–3× as common after this, so stops get hit and losses run.', careful: 'If you trade, use half the size and keep a stop; wild swings are more common today.', go: 'No warning sign. A normal day (it still can\'t say up or down).' },
  fnoSell: { stay: 'Don\'t sell options this week: a 2%+ NIFTY week (that breaks a 2%-away strangle) is far more common after this.', careful: 'Only with protection (a condor / spread), and smaller.', go: 'No warning sign — but selling still had a worst week bigger than a ₹10,000 account.' },
  fnoBuy: { stay: '', careful: '', go: 'No sign helps here: after warning signs NIFTY moves more (good for a buyer) but options cost more too. Bought options still lost on most weeks in testing, and direction can\'t be predicted. For same-day buys follow the Intraday line.' },
  swing: { stay: '', careful: 'Keep your stop and use a smaller size: 3%+ falls within the week are more common now (but so are rebounds).', go: 'No warning sign. Follow the plan and your stop.' },
  invest: { stay: '', careful: '', go: 'Keep the monthly plan. Skipping days hasn\'t helped: after these signs NIFTY\'s next weeks were not worse on average.' },
};

/** Signs at index `i` (that day's close known; nothing later used). */
export function signsAt(N, vix, i) {
  if (i < 250) return null;
  const c = N.slice(0, i + 1).map((x) => x.close);
  const sma = (n) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
  const avgRng = N.slice(i - 20, i).reduce((a, x) => a + (x.high - x.low) / x.close, 0) / 20;
  const v = vix.get(N[i].date);
  const vPrev = vix.get(N[i - 1].date);
  const hist = N.slice(i - 249, i + 1).map((x) => vix.get(x.date)).filter(Boolean);
  if (!v || !vPrev || hist.length < 200) return null;
  const move = N[i].close / N[i - 1].close - 1;
  let downs = 0;
  for (let k = i; k > i - 6 && N[k].close < N[k - 1].close; k--) downs++;
  return {
    values: { vix: v, vixChange: v / vPrev - 1, vixRank: hist.filter((x) => x <= v).length / hist.length, move, range: (N[i].high - N[i].low) / N[i].close, avgRange: avgRng, downDays: downs, sma200: sma(200), close: N[i].close },
    flags: {
      vixJump: v / vPrev - 1 >= 0.1, bigFall: move <= -0.015, bigMove: Math.abs(move) >= 0.015, wideRange: (N[i].high - N[i].low) / N[i].close >= 1.5 * avgRng,
      down3: downs >= 3, vixHigh: hist.filter((x) => x <= v).length / hist.length >= 0.8, below200: N[i].close < sma(200),
    },
  };
}
/** What happened after day i: the next day wild (range ≥ 1.5× usual), down; 2%+ move within 5 sessions; a 3%+ fall by then. */
function outcomesAfter(N, i, avgRange) {
  const t = N[i + 1];
  const w = N[i + 5];
  return { wild: (t.high - t.low) / t.close >= 1.5 * avgRange, down: t.close < N[i].close, week2: Math.abs(w.close / N[i].close - 1) >= 0.02, fall3: w.close / N[i].close - 1 <= -0.03, ret5: w.close / N[i].close - 1 };
}
export const levelOf = (kind, flags) => (KINDS[kind].stay.some((k) => flags[k]) ? 'stay' : KINDS[kind].careful.some((k) => flags[k]) ? 'careful' : 'go');

/** The test: for each kind, how often its bad outcome followed Go / Careful / Stay days, 2010–18 and 2019→. */
export function testRules(N, vix, split = '2019-01-01') {
  const rows = [];
  for (let i = 250; i + 5 < N.length; i++) {
    const s = signsAt(N, vix, i);
    if (!s) continue;
    rows.push({ date: N[i].date, flags: s.flags, o: outcomesAfter(N, i, s.values.avgRange) });
  }
  const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null);
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    out[kind] = {};
    for (const [per, sel] of [['dev', (r) => r.date < split], ['holdout', (r) => r.date >= split]]) {
      const xs = rows.filter(sel);
      const by = (lv) => xs.filter((r) => levelOf(kind, r.flags) === lv);
      out[kind][per] = Object.fromEntries(['go', 'careful', 'stay', 'all'].map((lv) => {
        const ys = lv === 'all' ? xs : by(lv);
        return [lv, { days: ys.length, share: ys.length / xs.length, bad: rate(ys, (r) => r.o[k.outcome]), down: rate(ys, (r) => r.o.down), ret5: ys.length ? ys.reduce((a, r) => a + r.o.ret5, 0) / ys.length : null }];
      }));
    }
  }
  return { from: rows[0]?.date, to: rows.at(-1)?.date, split, days: rows.length, byKind: out };
}

const OUTCOME_TEXT = { wild: 'a wild next day (swing 1.5× the usual)', week2: 'a 2%+ NIFTY move within the week', fall3: 'a 3%+ NIFTY fall within the week' };

/** Today's answer from NIFTY and India VIX daily closes (only completed sessions). */
export function tradeTodayFrom(niftyRows, vixRows, now = new Date()) {
  const session = lastSessionDate(now);
  const N = niftyRows.filter((x) => x.close > 0 && x.high > 0 && x.date <= session); // never an in-progress bar
  const vix = new Map(vixRows.filter((x) => x.close > 0 && x.date <= session).map((x) => [x.date, x.close]));
  const i = N.length - 1;
  const s = signsAt(N, vix, i);
  if (!s) throw new Error('Not enough NIFTY / India VIX history.');
  const tests = testRules(N, vix);
  const on = Object.keys(SIGNS).filter((k) => s.flags[k]);
  const kinds = Object.entries(KINDS).map(([kind, k]) => {
    const level = levelOf(kind, s.flags);
    const t = tests.byKind[kind].holdout;
    return {
      kind, name: k.name, level, untested: !!k.untested, advice: ADVICE[kind][level],
      because: [...k.stay, ...k.careful].filter((x) => s.flags[x]).map((x) => SIGNS[x]),
      outcome: OUTCOME_TEXT[k.outcome], badNow: t[level].bad, badGo: t.go.bad, badAll: t.all.bad, downNow: t[level].down, downAll: t.all.down, sample: t[level].days,
    };
  });
  const worst = kinds.some((x) => x.level === 'stay') ? 'stay' : kinds.some((x) => x.level === 'careful') ? 'careful' : 'go';
  return {
    asOf: N[i].date, forSession: nextTradingDay(N[i].date), overall: worst, signs: on.map((k) => ({ key: k, text: SIGNS[k] })), values: s.values, kinds, tests,
    note: `From NIFTY and India VIX closes up to ${N[i].date}, for the next session (${nextTradingDay(N[i].date)}). Rules fixed on 2010–18 and checked on 2019→ (${tests.byKind.intraday.holdout.all.days} days). None of these signs predicts an up or down day — they predict RISK: wild days and big weeks. "Stay out" protects you from the worst days; it can't make the other days profitable. Also skip a stock on its results day, and F&O on the RBI policy day and the Budget. Not advice.`,
  };
}

const cache = { at: 0, value: null };
export async function tradeToday({ now = new Date(), loadCandles = candles, fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 30 * 60_000 && cache.value.session === lastSessionDate(now)) return cache.value.r;
  const p1 = Math.floor(Date.parse('2009-01-01') / 1000);
  const [n, v] = await Promise.all([loadCandles('^NSEI', { period1: p1, interval: '1d' }), loadCandles('^INDIAVIX', { period1: p1, interval: '1d' })]);
  const r = tradeTodayFrom(n, v, now);
  cache.at = Date.now();
  cache.value = { session: lastSessionDate(now), r };
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await tradeToday();
    const word = { go: 'GO', careful: 'BE CAREFUL', stay: 'STAY OUT' };
    console.log(`Trade today? (for ${r.forSession}, from the ${r.asOf} close): ${word[r.overall]}${r.signs.length ? ` — ${r.signs.map((s) => s.text).join('; ')}` : ' — no warning signs'}`);
    for (const k of r.kinds) console.log(`  ${word[k.level].padEnd(10)} ${k.name}: ${k.advice}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
