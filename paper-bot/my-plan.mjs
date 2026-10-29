// "My plan" (library) for the top of the Home tab: what the tested rules say to
// do now, in one place — the market regime, the index-fund core, this month's
// Momentum 20 list (with what changes at the next month-end), today's swing
// breakouts and the open swing positions with their stops, what to skip, and
// the next dates. Built from the app's tested tools and paper records only.
// Facts and rule outputs, not advice. Research / paper only.

import { investResearch } from './invest-research.mjs';
import { loadAthPaper, activeRules, RULES as ATH_RULES } from './ath-swing.mjs';
import { loadPaper } from './vwap-pullback.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadFoStranglePaper } from './fo-strangle.mjs';
import { isTradingDay } from './market-calendar.mjs';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000));
const sym = (s) => String(s).replace('.NS', '');

/** Next trading day after `date`. */
export function nextTradingDay(date) {
  let d = addDays(date, 1);
  for (let k = 0; k < 12 && !isTradingDay(d); k++) d = addDays(d, 1);
  return d;
}
/** Last trading day of the month that `date` is in. */
export function lastTradingDayOfMonth(date) {
  let d = date;
  while (nextTradingDay(d).slice(0, 7) === date.slice(0, 7)) d = nextTradingDay(d);
  return d;
}

/** What the record says about each intraday strategy (to decide "skip"). */
function recordOf(trades) {
  const done = (trades || []).filter((t) => !t.open);
  return { trades: done.length, net: done.reduce((a, t) => a + (t.net || 0), 0) };
}

export async function myPlan({ now = new Date(), research = () => investResearch(), papers = null } = {}) {
  const today = iso(new Date(now.getTime() + 19800_000));
  const r = await research();
  const raw = r.raw || {};
  const p = papers || { swing: loadAthPaper(), vwap: loadPaper(), breakfast: loadBreakfastPaper(), fo: loadFoStranglePaper() };
  const capital = raw.capital || 100000;
  const swingVersion = activeRules() !== ATH_RULES ? 'improved' : 'original';

  // 1. this month's Momentum 20 list and what the next month-end changes
  const mom = raw.momentum;
  const monthEnd = lastTradingDayOfMonth(isTradingDay(today) ? today : nextTradingDay(today));
  const nextRebalance = nextTradingDay(monthEnd);
  let momentum = null;
  if (mom?.list?.length) {
    const now20 = mom.list.map((x) => x.symbol);
    const next20 = (mom.preview?.list || []).map((x) => x.symbol);
    momentum = {
      passed: mom.passed, rankedAt: mom.monthEnd, list: mom.list.map((x) => ({ symbol: sym(x.symbol), ret12: x.ret12 })),
      perStock: Math.round(capital / now20.length), perStockSatellite: Math.round((capital * 0.2) / now20.length),
      monthEnd, nextRebalance,
      likelyIn: next20.filter((x) => !now20.includes(x)).map(sym), likelyOut: now20.filter((x) => !next20.includes(x)).map(sym), previewAt: mom.preview?.date || null,
      paperStarted: mom.rebalances > 0,
    };
  }

  // 2. swing: today's breakouts (from the research check) and the open positions with their stops
  const swing = {
    version: swingVersion,
    signals: (raw.triggered || []).map((t) => ({ symbol: sym(t.symbol), setup: t.setup, close: t.close, stop: t.stop, riskPct: t.riskPct, shares: t.size?.qty ?? null, value: t.size?.value ?? null })),
    open: (p.swing?.trades || []).filter((t) => t.open && (t.version || 'original') === swingVersion).map((t) => ({ symbol: sym(t.symbol), entryDate: t.entryDate, entry: t.entry, last: t.exit, stop: t.trail, r: t.r, gapToStopPct: t.exit > 0 ? (t.exit / t.trail - 1) * 100 : null })),
  };

  // 3. what to skip: strategies losing in testing and on paper
  const v = p.vwap?.trades || [];
  const skip = [
    { name: 'YouTube intraday · video rules', ...recordOf(v.filter((t) => (t.variant || 'video') === 'video')), why: 'loses after charges in testing; no filter fixed it' },
    { name: 'YouTube intraday · improved', ...recordOf(v.filter((t) => t.variant === 'improved')), why: 'unproven; about break-even in testing' },
    { name: 'YouTube intraday · scanner', ...recordOf(v.filter((t) => t.variant === 'scanner')), why: 'ahead on paper but on few trades; lost in the larger study' },
    { name: 'Breakfast', ...recordOf(p.breakfast?.trades), why: 'loses after charges, especially on gap days' },
    { name: 'F&O option selling (strangle)', ...{ trades: (p.fo?.trades || []).filter((t) => !t.open).length, net: (p.fo?.trades || []).filter((t) => !t.open).reduce((a, t) => a + t.rupees, 0) }, why: 'one crash week can lose most of the margin; needs ~₹6.6 lakh a lot' },
  ];

  // 4. the next dates that matter
  const dates = [
    momentum ? { date: monthEnd, what: 'Month ends: the next Momentum 20 list is made from this close (preview in the evening note)' } : null,
    momentum ? { date: nextRebalance, what: 'Momentum 20: swap to the new list at the open' } : null,
    { date: nextTradingDay(today), what: 'Swing: any breakout at tonight’s close is bought at this open (evening note)' },
  ].filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

  return {
    at: new Date().toISOString(), today, capital,
    regime: raw.regime,
    core: { funds: raw.funds || [], note: 'Long-term money: a low-cost NIFTY 50 index fund, ideally as a monthly SIP. In this app’s tests it beat every trading strategy after tax except the momentum screen; in falling markets like now, SIP buying gets cheaper prices.' },
    momentum, swing, skip, dates,
    careful: raw.careful || [],
    note: 'What the tested rules say now. The 80 / 20 split (80% index fund, 20% satellite) is the plan the tests support; the amounts are what that split means for your My trades capital. Nothing here says a stock will go up. Decide yourself — or with a SEBI-registered adviser.',
  };
}
