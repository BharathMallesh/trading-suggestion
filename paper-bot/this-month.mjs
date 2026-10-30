// "Do this month" (library): one monthly action list for the three tested
// investing rules — Steady mix, Momentum 10 + buffer and Momentum 20 — in
// rupees for the amount you choose. Built only from their paper records:
// what they hold now, what the next month-end is likely to change, the NIFTY
// market filter, and the dates. Also the evening-note lines (and so the Mac
// alert) for the days that matter: the month-end, the change day, and the day
// NIFTY crosses its 200-day average. Facts from tested rules, not advice.

import { loadMomentumPaper } from './momentum.mjs';
import { loadMomentum10Paper } from './momentum10.mjs';
import { loadSteadyMixPaper, MIX } from './steady-mix.mjs';
import { loadIndiaMixPaper } from './india-mix.mjs';
import { nextTradingDay, lastTradingDayOfMonth } from './my-plan.mjs';
import { isTradingDay } from './market-calendar.mjs';

const sym = (s) => String(s).replace('.NS', '');
const amt = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const diff = (a, b) => b.filter((x) => !a.includes(x));

/** Symbols held after the latest paper change (or the current list before the first one). */
const holdingsOf = (st) => (st?.rebalances?.at(-1)?.holdings || []).filter((h) => !h.kind || h.kind === 'stock').map((h) => sym(h.symbol));

/** The plan for one momentum rule: hold now, and the likely change at the next month-end. */
function momentumPlan(key, name, st, slots, money, today) {
  if (!st) return { key, name, ready: false, note: 'No paper record yet.' };
  const held = holdingsOf(st);
  const current = held.length ? held : (st.list || []).map((x) => sym(x.symbol));
  const next = (st.preview?.list || []).map((x) => sym(x.symbol));
  const last = st.rebalances?.at(-1);
  const prev = st.rebalances?.at(-2);
  const changedToday = last?.date === today;
  return {
    key, name, ready: true, perStock: money / slots, money,
    hold: current, started: !!held.length,
    today: changedToday ? { bought: diff(prev ? holdingsOf({ rebalances: [prev] }) : [], held), sold: prev ? diff(held, holdingsOf({ rebalances: [prev] })) : [] } : null,
    likelyIn: next.length ? diff(current, next) : [], likelyOut: next.length ? diff(next, current) : [], previewAt: st.preview?.date || null,
  };
}

export function thisMonth({ now = new Date(), amount = 100000, m20 = loadMomentumPaper(), m10 = loadMomentum10Paper(), steady = loadSteadyMixPaper(), india = loadIndiaMixPaper() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const day = isTradingDay(today) ? today : nextTradingDay(today);
  const monthEnd = lastTradingDayOfMonth(day);
  const changeDay = nextTradingDay(monthEnd);
  const firstOfMonth = !isTradingDay(today) ? false : nextTradingDay(lastTradingDayOfMonth(addMonths(today, -1))) === today;
  const phase = today === monthEnd ? 'month-end' : firstOfMonth ? 'change-day' : 'hold';

  const f = steady?.filter || null;
  const filter = f ? { inMarket: f.inMarket, latest: f.today, decidedAt: f.monthEnd, flipLikely: f.today != null && f.inMarket != null && f.today !== f.inMarket } : null;

  // Steady mix: 30% stocks (Momentum 10 list, or the liquid fund when the filter is out) / 10% gold / 60% liquid
  const m10plan = momentumPlan('m10', 'Momentum 10 + buffer', m10, 10, amount, today);
  const stocksIn = filter ? filter.inMarket !== false : true;
  const nextIn = filter ? filter.latest !== false : true;
  const steadyPlan = {
    key: 'steady', name: 'Steady mix', ready: !!steady, money: amount,
    parts: [
      { part: `Stocks (${MIX.stocks * 100}%)`, amount: amount * MIX.stocks, what: stocksIn ? `the Momentum 10 stocks, ${amt((amount * MIX.stocks) / 10)} each: ${m10plan.hold?.join(', ') || '–'}` : 'market filter OUT: kept in the liquid fund' },
      { part: `Gold (${MIX.gold * 100}%)`, amount: amount * MIX.gold, what: 'a gold ETF such as GOLDBEES' },
      { part: `Liquid fund (${MIX.liquid * 100}%)`, amount: amount * MIX.liquid, what: 'a liquid / overnight fund' },
    ],
    next: nextIn === stocksIn ? `No change to the split expected at the ${monthEnd} month-end (filter ${nextIn ? 'IN' : 'OUT'} on the latest close).` : nextIn ? `On the latest close the filter would turn IN: at the ${monthEnd} month-end the 30% would move from the liquid fund into the Momentum 10 stocks.` : `On the latest close the filter would turn OUT: at the ${monthEnd} month-end the 30% would move from stocks into the liquid fund.`,
    rebalanceNote: 'Each month, put the three parts back to 30 / 10 / 60.',
  };
  const third = amount / 3;
  const indiaPlan = {
    key: 'india', name: 'India mix', ready: true, money: amount,
    parts: [
      { part: 'Nifty Next 50 (⅓)', amount: third, what: 'a Nifty Next 50 index fund or ETF such as JUNIORBEES' },
      { part: 'Gold (⅓)', amount: third, what: 'a gold ETF such as GOLDBEES' },
      { part: 'Momentum 10 (⅓)', amount: third, what: `the Momentum 10 stocks, ${amt(third / 10)} each: ${m10plan.hold?.join(', ') || '–'}` },
    ],
    next: m10plan.likelyIn?.length || m10plan.likelyOut?.length ? `At the ${monthEnd} month-end the stock third likely swaps in ${m10plan.likelyIn.join(', ') || 'none'} and out ${m10plan.likelyOut.join(', ') || 'none'}.` : `No stock change expected at the ${monthEnd} month-end on the latest prices.`,
    rebalanceNote: `Each month, put the three parts back to ⅓ each.${india?.rebalances?.length ? '' : ' Paper record starts at the next change.'}`,
  };
  const plans = [steadyPlan, indiaPlan, m10plan, momentumPlan('m20', 'Momentum 20', m20, 20, amount, today)];

  const steps = {
    'month-end': `Today is the last trading day of the month. The new lists are made from today's close; the swap is at the open on ${changeDay}.`,
    'change-day': 'Today is the change day: the paper portfolios swapped at today\'s open. Make the same changes if you follow one, then nothing until the next month-end.',
    hold: `Nothing to do until the month-end (${monthEnd}). The swap is at the open on ${changeDay}. Daily moves don't change the plan.`,
  }[phase];
  return {
    at: new Date().toISOString(), today, phase, monthEnd, changeDay, amount, filter, plans, steps,
    note: 'What the tested rules would hold, scaled to your amount. Based on the paper records, not a recommendation; decide yourself or with a SEBI-registered adviser.',
  };
}

function addMonths(date, n) {
  const [y, m] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 15));
  return t.toISOString().slice(0, 10);
}

/**
 * Evening-note lines (and so the Mac alert) for the monthly rules, only on the
 * days that matter: the month-end (what changes tomorrow), the change day (what
 * changed), and a day NIFTY crossed its 200-day average (the filter's latest reading flipped).
 */
export function monthLines(date, { m10 = loadMomentum10Paper(), steady = loadSteadyMixPaper(), india = loadIndiaMixPaper() } = {}) {
  const out = [];
  const isMonthEnd = isTradingDay(date) && nextTradingDay(date).slice(0, 7) !== date.slice(0, 7);
  const r = m10?.rebalances?.at(-1);
  if (r?.date === date) {
    out.push({ title: 'Momentum 10', short: m10.rebalances.length > 1 ? `Momentum 10: ${r.bought.length} in / ${r.sold.length} out` : 'Momentum 10: first list bought', detail: `Changed at today's open on paper: bought ${(r.bought || []).join(', ') || 'none'} · sold ${(r.sold || []).join(', ') || 'none'}.` });
  } else if (isMonthEnd && m10?.preview?.list?.length) {
    const cur = holdingsOf(m10);
    const next = m10.preview.list.map((x) => sym(x.symbol));
    const inn = cur.length ? diff(cur, next) : next;
    out.push(cur.length
      ? { title: 'Momentum 10', short: `Momentum 10: month ends today (≈${inn.length} changes tomorrow)`, detail: `Likely in: ${inn.join(', ') || 'none'} · likely out: ${diff(next, cur).join(', ') || 'none'} (final list from today's close, swapped at the next open).` }
      : { title: 'Momentum 10', short: 'Momentum 10: first list bought tomorrow', detail: `Likely list: ${next.join(', ')} (final list from today's close, bought at the next open).` });
  }
  const s = steady?.rebalances?.at(-1);
  if (s?.date === date) out.push({ title: 'Steady mix', short: `Steady mix: re-balanced (filter ${s.inMarket ? 'IN' : 'OUT'})`, detail: `Put back to ${MIX.stocks * 100} / ${MIX.gold * 100} / ${MIX.liquid * 100} at today's open; the stock part is ${s.inMarket ? 'in the Momentum 10 stocks' : 'in the liquid fund (filter OUT)'}.` });
  else if (isMonthEnd && steady?.filter) out.push({ title: 'Steady mix', short: `Steady mix: filter ${steady.filter.today ? 'IN' : 'OUT'} at today's close decides tomorrow`, detail: `Tomorrow's re-balance uses the filter reading at today's close: ${steady.filter.today ? 'IN — the 30% goes into the Momentum 10 stocks' : 'OUT — the 30% stays in the liquid fund'}.` });
  const ir = india?.rebalances?.at(-1);
  if (ir?.date === date) out.push({ title: 'India mix', short: 'India mix: put back to ⅓ each', detail: `Re-balanced at today's open on paper to ⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10 (value ₹${Math.round(ir.value).toLocaleString('en-IN')}).` });
  const h = steady?.filterHistory || [];
  if (h.length >= 2 && h.at(-1).date === date && h.at(-1).today !== h.at(-2).today) {
    out.push({ title: 'Market filter', short: `NIFTY crossed ${h.at(-1).today ? 'above' : 'below'} its 200-day average`, detail: `The Steady mix filter now reads ${h.at(-1).today ? 'IN' : 'OUT'}; it only acts at the month-end, so nothing changes until then.` });
  }
  return out;
}
