#!/usr/bin/env node
// "Today's algo plan" (library + CLI): the honest answer to "the best algo for trading". After ~20,000 tested ideas
// only a few rules passed out of sample; this turns them into ONE action list for the next trading session, with
// exact quantities for the user's capital — nothing more:
//   • India mix (⅓ Momentum 10 / ⅓ Nifty Next 50 / ⅓ gold): orders only on the change day after a month-end, the
//     ⅓ reset only when a part has drifted ≥ 5 points (india-mix.mjs partValues / partBand — the paper engine's own
//     functions), and the Momentum 10 list changes for the stock third (momentum10 paper list).
//   • IPO apply: the minimum retail lot of every mainboard IPO on its last bidding day (UPI mandate by 5 PM), sell at
//     the listing open (ipo-apply paper record) — a small add-on, weaker in 2025–26.
//   • Bonus/split run-up entries / exits due that session — PAPER only (bonus-runup paper record).
//   • The six "don't buy now" warnings (avoid-list.mjs): a stock in the plan that is flagged is shown as SKIP.
//   • The expiry-day warning (expiry.mjs), and the standing idle-cash rule (arbitrage fund, hold > 12 months).
// Most days the honest output is "Nothing to do today". The app never places orders (no broker connection): the user
// places them. The checklist ticks and the capital are saved in data/algo-plan.json, with a log of every day's plan
// so the plan's record can be compared with the paper accounts (whose record IS the plan's record). Not advice.
//
//   node paper-bot/algo-plan.mjs --today [--log] [--capital 500000]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { writeJsonAtomic, badRequest } from '../util.mjs';
import { loadIndiaMixPaper, loadIndiaMix, partValues, partBand, INDIA_PARTS, MIX } from './india-mix.mjs';
import { loadMomentum10Paper } from './momentum10.mjs';
import { valuesBySymbol } from './steady-mix.mjs';
import { loadIpoApplyPaper, RESEARCH as IPO_RESEARCH } from './ipo-apply.mjs';
import { loadBonusRunupPaper, RESEARCH as BSR_RESEARCH, BSR } from './bonus-runup.mjs';
import { loadAvoidList, activeWarnings } from './avoid-list.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { expiryStatus, sessionFor, nextSession } from './expiry.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { PAPER } from './config.mjs';
import { latestChain } from './fo-riskcheck.mjs';
import { LOT_NOW, marginPct } from './fo-strangle.mjs';
import { foStocksDir } from './vol-premium.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = () => process.env.ALGO_PLAN_PATH || join(HERE, 'data', 'algo-plan.json');
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');

// Defaults for the user's real size (Nov 2026): ₹1,00,000 in total, all of it in India mix, no separate IPO cash buffer.
export const ALGO = {
  defaultCapital: 100000, defaultIpoBuffer: 0, minCapital: 10000, maxCapital: 1e9, maxIpoBuffer: 1e8, upiDeadline: '5 PM', logDays: 400, resizeMinPct: 10,
  smallLeg: 1000, // ₹: an order this small pays a fixed DP / brokerage charge that is a big share of it
  roundPts: 1, // whole-share rounding that moves a stock's weight by more than this many points of the India mix money is flagged
  flatBrokerage: 20, // ₹ per order at a broker that charges for delivery (shown next to the app's default ₹0 delivery brokerage)
  ipoTypical: 15000, // ₹ blocked per minimum-lot application (mainboard lots are sized ≈ ₹14–15k)
};
const sym = (s) => String(s || '').replace(/\.NS$/i, '');
const rs = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const prevSession = (d) => {
  let x = addDays(d, -1);
  for (let k = 0; k < 12 && !isTradingDay(x); k++) x = addDays(x, -1);
  return x;
};
/** Last trading day of the month `date` is in. */
export function monthEndOf(date) {
  let d = date;
  while (nextSession(d).slice(0, 7) === date.slice(0, 7)) d = nextSession(d);
  return d;
}
/** First trading day of the month `date` is in = the change day after the previous month-end. */
export const isChangeDay = (date) => isTradingDay(date) && prevSession(date).slice(0, 7) !== date.slice(0, 7);
export const isMonthEnd = (date) => isTradingDay(date) && nextSession(date).slice(0, 7) !== date.slice(0, 7);
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ----------------------------------------------------------------- saved state ---
export function loadAlgoState() {
  try {
    const j = JSON.parse(readFileSync(STATE(), 'utf8'));
    return { settings: j.settings || {}, ticks: j.ticks || {}, log: j.log || {} };
  } catch {
    return { settings: {}, ticks: {}, log: {} };
  }
}
const saveState = (st) => writeJsonAtomic(STATE(), st);
export const savedCapital = (st = loadAlgoState()) => st.settings.capital || ALGO.defaultCapital;
export const savedIpoBuffer = (st = loadAlgoState()) => (Number.isFinite(st.settings.ipoBuffer) ? st.settings.ipoBuffer : ALGO.defaultIpoBuffer);
/** Validate and save the settings: India mix money (₹10,000 – ₹100 crore) and the separate IPO cash buffer (₹0 – ₹10 crore). */
export function saveSettings({ capital, ipoBuffer } = {}) {
  const st = loadAlgoState();
  if (capital !== undefined) {
    const n = Math.round(Number(capital));
    if (!Number.isFinite(n) || n < ALGO.minCapital || n > ALGO.maxCapital) throw badRequest(`India mix money must be between ${rs(ALGO.minCapital)} and ${rs(ALGO.maxCapital)}.`);
    st.settings.capital = n;
  }
  if (ipoBuffer !== undefined) {
    const b = Math.round(Number(ipoBuffer));
    if (!Number.isFinite(b) || b < 0 || b > ALGO.maxIpoBuffer) throw badRequest(`The IPO cash buffer must be between ₹0 and ${rs(ALGO.maxIpoBuffer)}.`);
    st.settings.ipoBuffer = b;
  }
  saveState(st);
  return { capital: savedCapital(st), ipoBuffer: savedIpoBuffer(st) };
}
/** Save only the India mix money (kept for callers that set just that). */
export const saveCapital = (value) => saveSettings({ capital: value });

// ----------------------------------------------------------------- charges ---
const COSTS = () => ({ ...DEFAULT_COSTS, ...(PAPER.costs || {}) });
/** Charges of one delivery / ETF order as ₹ and % of the order, plus the same with a flat ₹20 brokerage. */
export function chargesFor(side, value, etf = false) {
  const c = orderCharges({ side: side === 'SELL' ? 'sell' : 'buy', value, product: etf ? 'etf' : 'delivery', costs: COSTS() });
  const flat = c.total + ALGO.flatBrokerage * 1.18;
  return { charges: c.total, chargesPct: value > 0 ? (c.total / value) * 100 : null, brokerage: c.breakdown.brokerage, withFlatPct: value > 0 ? (flat / value) * 100 : null, small: value < ALGO.smallLeg };
}

/**
 * Whole-share sizing of each Momentum 10 stock at this India mix money: the paper account works in exact rupees
 * (a ⅓ stock part split into 10 equal slots); a real order is whole shares. Flags a stock whose one share costs more
 * than its slot, and one whose rounding moves its weight by more than ALGO.roundPts points of the money.
 */
export function stockSizing(list, stockMoney, capital) {
  const per = stockMoney / Math.max(1, list.length);
  return list.filter((x) => x.close > 0).map((x) => {
    const shares = Math.round(per / x.close);
    const value = shares * x.close;
    const offPts = ((value - per) / capital) * 100;
    const flags = [];
    if (x.close > per) flags.push(`one share (₹${Math.round(x.close).toLocaleString('en-IN')}) costs more than its ${rs(per)} slot — ${shares ? `1 share is ${((x.close / capital) * 100).toFixed(1)}% of the money instead of ${((per / capital) * 100).toFixed(1)}%` : 'rounds to 0 shares: the slot stays in cash'}`);
    else if (Math.abs(offPts) > ALGO.roundPts) flags.push(`whole shares move its weight by ${offPts > 0 ? '+' : ''}${offPts.toFixed(1)} points`);
    return { symbol: x.symbol, price: x.close, slot: per, shares, value, offPts, flags };
  });
}

/** F&O sizes next to this money: one NIFTY lot (notional and ≈ margin) and a typical stock-option lot, from the latest NSE files. */
export function foSizes(capital, { chain = latestChain(), stocksDir = foStocksDir() } = {}) {
  const out = { capital, nifty: null, stockMedian: null };
  if (chain?.spot > 0) out.nifty = { lot: LOT_NOW, notional: chain.spot * LOT_NOW, margin: (chain.spot * LOT_NOW * marginPct(chain.date)) / 100, date: chain.date };
  try {
    const f = existsSync(stocksDir) ? readdirSync(stocksDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop() : null;
    if (f) {
      const v = Object.values(JSON.parse(readFileSync(join(stocksDir, f), 'utf8'))).map((o) => o.underlying * o.lot).filter((x) => x > 0).sort((a, b) => a - b);
      if (v.length) out.stockMedian = { notional: v[Math.floor(v.length / 2)], min: v[0], n: v.length, date: f.slice(0, 10) };
    }
  } catch {
    /* sizes are a note */
  }
  const lakh = (x) => `₹${(x / 100000).toFixed(1)} lakh`;
  out.text = `F&O at ${rs(capital)}: ${out.nifty ? `one NIFTY lot is about ${lakh(out.nifty.notional)} of index (≈ ${lakh(out.nifty.margin)} margin to sell)` : 'one NIFTY lot is many lakh of index'}${out.stockMedian ? ` and a typical stock-option lot about ${lakh(out.stockMedian.notional)} (smallest ${lakh(out.stockMedian.min)})` : ''} — far above ${rs(capital)}. Selling options (naked) is impossible at this size; buying options is the only F&O possible, and that is the side ~90% of retail traders lose on (SEBI). The expiry-day warning still applies.`;
  return out;
}
/** Tick / untick one action of one day's plan (this Mac's checklist only; it never changes a paper record). */
export function setTick(date, id, done = true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^[a-z0-9:._&-]{1,80}$/i.test(String(id))) throw badRequest('Bad date or action id.');
  const st = loadAlgoState();
  const day = (st.ticks[date] ||= {});
  if (done) day[id] = new Date().toISOString();
  else delete day[id];
  if (!Object.keys(day).length) delete st.ticks[date];
  // keep about a year of ticks
  for (const d of Object.keys(st.ticks).sort().slice(0, -ALGO.logDays)) delete st.ticks[d];
  saveState(st);
  return { date, ticks: st.ticks[date] || {} };
}

// ------------------------------------------------------------------- prices ---
/** Latest NSE closes for `symbols` from the app's bhav store (for paper sizes). */
export function bhavCloses(symbols) {
  const want = new Set(symbols.map(sym));
  const out = {};
  if (!want.size || !existsSync(BHAV())) return out;
  const files = readdirSync(BHAV()).filter((x) => /^\d{4}-\d{2}\.json\.gz$/.test(x)).sort().slice(-2).reverse();
  for (const f of files) {
    try {
      const m = JSON.parse(gunzipSync(readFileSync(join(BHAV(), f))).toString('utf8'));
      for (const d of Object.keys(m).sort().reverse()) {
        for (const r of m[d]) if (want.has(r[0]) && !out[r[0]] && r[4] > 0) out[r[0]] = { close: r[4], date: d };
        if (Object.keys(out).length === want.size) return out;
      }
    } catch {
      /* skip a bad month */
    }
  }
  return out;
}

// --------------------------------------------------------------- the rules ---
/** One-line WHY for each rule, from the saved tests where they exist. */
export function whyLines(indiaTest = loadIndiaMix()) {
  const b = indiaTest?.results?.banded;
  const n = indiaTest?.results?.nifty;
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const ipoTest = IPO_RESEARCH.rows.at(-1);
  return {
    india: b && n
      ? `India mix rule: ⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10, put back to ⅓ at a month-end only when a part has drifted ${MIX.bandPts}+ points. Tested ${indiaTest.from}→${indiaTest.to}: ${pc(b.all.cagr)} a year before tax, worst fall ${pc(b.all.maxDrawdown)} (NIFTY ${pc(n.all.cagr)}, ${pc(n.all.maxDrawdown)}); the only rule that also won the untouched 2025–26 test.`
      : `India mix rule: ⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10, put back to ⅓ only when a part drifts ${MIX.bandPts}+ points — the only rule that won the untouched 2025–26 test.`,
    m10: 'Momentum 10 + buffer (the stock third of India mix): the 10 strongest stocks by 6- and 12-month momentum, a stock is kept while it stays in the top 40; changed only at the month-end.',
    ipo: `IPO apply rule: the minimum retail lot in every mainboard IPO on its last bidding day, sell at the listing open. Tested ${ipoTest.period}: ≈ ${rs(ipoTest.perYear)} a year after tax per PAN vs an arbitrage fund — but only ≈ ₹3,500 a year in 2025–26; a small add-on.`,
    bonus: `Bonus/split run-up (PAPER ONLY): buy ${BSR.pre} sessions before a bonus / split ex-date, sell at the close the session before it. ${BSR_RESEARCH.verdict}.`,
    avoid: 'Don\'t-buy-now warnings (circuits, band cuts, trade-for-trade, ASM): flagged stocks lagged same-size stocks by 2–8% over 5–20 sessions in 2010–22, 2023–24 and 2025–26 — a caution, not a return source (skipping them was not proven to help).',
    idle: 'Idle cash rule: an arbitrage fund instead of an FD / savings — beat an FD by ~1.3–3.3 points a year after tax at the 30% slab in 2023–26; taxed as equity, so hold > 12 months for the lower long-term rate.',
  };
}

/**
 * India mix orders for the change day after `monthEnd`, scaled to `capital`, from the paper portfolio's latest marks:
 * the band decision is the paper engine's own (partValues / partBand), the stock third is the Momentum 10 list made at
 * that month-end (or its preview when the final list isn't in yet). Assumes your India mix is in the same proportions
 * as the paper portfolio.
 */
export function indiaMixOrders({ capital, india, m10, monthEnd, date }) {
  const marks = (india?.marks || []).filter((x) => x.amount > 0);
  if (!marks.length) return { ready: false, note: 'No India mix paper marks yet.' };
  const last = india.rebalances?.at(-1);
  if (last?.monthEnd === monthEnd) return { ready: false, done: true, note: `The paper portfolio already re-balanced for the ${monthEnd} month-end on ${last.date} — see the India mix card.` };
  const val = (x) => x.amount * (1 + (x.retPct || 0) / 100);
  const total = marks.reduce((a, x) => a + val(x), 0);
  const k = capital / total;
  const sleeves = partValues(valuesBySymbol(marks), total, INDIA_PARTS);
  const band = partBand(sleeves, total, INDIA_PARTS);
  const final = m10?.monthEnd === monthEnd && m10?.list?.length;
  const list = (final ? m10.list : m10?.preview?.list || []).map((x) => ({ symbol: sym(x.symbol), close: x.close }));
  const target = band.rebalance
    ? { ...Object.fromEntries(INDIA_PARTS.funds.map((f) => [f.key, capital * f.w])), stocks: capital * INDIA_PARTS.stocks }
    : { ...Object.fromEntries(INDIA_PARTS.funds.map((f) => [f.key, sleeves[f.key] * k])), stocks: capital - INDIA_PARTS.funds.reduce((a, f) => a + sleeves[f.key] * k, 0) };
  const orders = [];
  const order = (o) => o.qty > 0 && orders.push({ ...o, amount: o.qty * o.price, ...chargesFor(o.side, o.qty * o.price, o.group === 'fund') });
  for (const f of INDIA_PARTS.funds) {
    const m = marks.find((x) => x.symbol === f.symbol);
    const price = m?.last || m?.entry;
    if (!(price > 0)) continue;
    const cur = m ? val(m) * k : 0;
    const d = Math.round((target[f.key] - cur) / price);
    order({ group: 'fund', part: f.key, symbol: sym(f.symbol), name: f.name, side: d > 0 ? 'BUY' : 'SELL', qty: Math.abs(d), price, why: band.rebalance ? `put ${f.name} back to ⅓ (${(band.weights[f.key] * 100).toFixed(1)}% now)` : null });
  }
  const held = marks.filter((x) => x.kind === 'stock');
  const liquid = marks.filter((x) => x.kind === 'liquid').reduce((a, x) => a + val(x) * k, 0);
  const inList = new Set(list.map((x) => x.symbol));
  for (const h of held) {
    if (inList.has(sym(h.symbol))) continue;
    const price = h.last || h.entry;
    order({ group: 'out', symbol: sym(h.symbol), side: 'SELL', qty: Math.round((val(h) * k) / price), price, why: 'left the Momentum 10 list (out of the top 40)' });
  }
  if (list.length) {
    const per = target.stocks / list.length;
    for (const x of list) {
      const h = held.find((y) => sym(y.symbol) === x.symbol);
      const price = h?.last || x.close;
      if (!(price > 0)) continue;
      const want = Math.round(per / price);
      const have = h ? Math.round((val(h) * k) / price) : 0;
      const d = want - have;
      // a kept stock is only resized when it is ≥ 10% away from its slot (smaller top-ups / trims are noise; the paper
      // portfolio resizes them too, at almost no difference)
      if (h && Math.abs(d) * price < (per * ALGO.resizeMinPct) / 100) continue;
      order({ group: h ? 'resize' : 'in', symbol: x.symbol, side: d > 0 ? 'BUY' : 'SELL', qty: Math.abs(d), price, why: h ? `back to an equal ${rs(per)} slot, as the paper portfolio does` : 'new in the Momentum 10 list' });
    }
  }
  const sizing = stockSizing(list, target.stocks, capital);
  for (const o of orders) o.sizeFlags = sizing.find((z) => z.symbol === o.symbol && o.side === 'BUY')?.flags || [];
  return {
    ready: true, monthEnd, date, bandTriggered: band.rebalance, sizing, weights: band.weights, off: Object.entries(band.weights).filter(([key, w]) => Math.abs(w - (key === 'stocks' ? INDIA_PARTS.stocks : INDIA_PARTS.funds.find((f) => f.key === key).w)) * 100 >= INDIA_PARTS.bandPts).map(([key]) => key),
    finalList: !!final, listDate: final ? m10.monthEnd : m10?.preview?.date || null, orders, liquid,
    marksAsOf: india.curve?.at(-1)?.date || null, paperValue: total, scale: k,
  };
}

/**
 * The plan for the next trading session (today until the 15:30 close, else the next trading day).
 * Every input is injectable (tests); by default the saved paper records are read.
 */
export function algoPlan({
  now = new Date(), capital = null, state = loadAlgoState(), india = loadIndiaMixPaper(), m10 = loadMomentum10Paper(),
  ipo = loadIpoApplyPaper(), bonus = loadBonusRunupPaper(), avoid = loadAvoidList(), indiaTest = loadIndiaMix(),
  closes = bhavCloses, expiry = expiryStatus(now), ipoBuffer = null, fo = null,
} = {}) {
  const cap = capital || savedCapital(state);
  const buffer = ipoBuffer ?? savedIpoBuffer(state);
  const date = sessionFor(now);
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const why = whyLines(indiaTest);
  const flagged = {};
  for (const e of activeWarnings(avoid, date)) (flagged[e.symbol] ||= []).push(`${e.reason} (until ${e.until})`);
  const skipFor = (s) => (flagged[sym(s)] ? `⚠ Don't buy now: ${flagged[sym(s)].join('; ')}. Skip it — the paper portfolio still buys it (skipping flagged stocks was not proven to help), so this part stays in cash until the next month-end.` : null);
  const actions = [];
  const info = [];

  // India mix + Momentum 10 list: only on the change day after a month-end
  let india_ = null;
  if (isChangeDay(date)) {
    const monthEnd = prevSession(date);
    india_ = indiaMixOrders({ capital: cap, india, m10, monthEnd, date });
    if (india_.ready) {
      const head = india_.bandTriggered
        ? `Band triggered: ${india_.off.join(' & ')} ${MIX.bandPts}+ points off ⅓ → put all three parts back to ⅓.`
        : `Band not triggered (all parts within ${MIX.bandPts} points of ⅓) → leave the Next 50 and gold parts alone; only the Momentum 10 stocks change.`;
      info.push({ kind: 'india', text: `${head} Paper marks of ${india_.marksAsOf || '–'}; Momentum 10 list ${india_.finalList ? `final (${india_.listDate} close)` : `PROVISIONAL from the ${india_.listDate || '–'} prices — the final list comes with the month-end NSE file`}.` });
      for (const o of india_.orders) {
        actions.push({
          id: `india:${o.symbol}:${o.side}`, kind: o.group === 'fund' ? 'india-mix' : 'momentum10', paper: false,
          title: `${o.side} ${o.qty} ${o.symbol} at the open`, side: o.side, symbol: o.symbol, qty: o.qty, price: o.price, amount: o.amount,
          charges: o.charges, chargesPct: o.chargesPct, withFlatPct: o.withFlatPct, small: o.small, flags: o.sizeFlags,
          detail: `${o.why}. Charges ≈ ₹${o.charges.toFixed(0)} (${o.chargesPct.toFixed(2)}% of the order; ${o.withFlatPct.toFixed(2)}% at a ₹${ALGO.flatBrokerage}-an-order broker)${o.small ? ` — under ₹${ALGO.smallLeg.toLocaleString('en-IN')}: fixed charges are a big share of a leg this small` : ''}.${o.sizeFlags.length ? ` ⚠ ${o.sizeFlags.join('; ')}.` : ''}`, why: o.group === 'fund' ? why.india : why.m10, skip: o.side === 'BUY' ? skipFor(o.symbol) : null, link: o.group === 'fund' ? 'indiaCard' : 'm10Card',
        });
      }
      if (!india_.orders.length) info.push({ kind: 'india', text: 'No India mix order is needed on these prices.' });
    } else info.push({ kind: 'india', text: india_.note });
  } else if (isMonthEnd(date)) {
    info.push({ kind: 'india', text: `${dayLabel(date)} is the month-end: the new Momentum 10 list is made from its close; India mix orders (and the ${MIX.bandPts}-point band check) are for the open on ${dayLabel(nextSession(date))} and appear here then.` });
  }

  // IPOs: apply on the last bidding day; sell at the listing open
  const ipoDue = (ipo?.openIssues || []).filter((x) => x.close === date);
  let ipoLeft = buffer;
  for (const x of ipoDue) {
    const price = x.band?.hi;
    const need = x.amount || (x.lot && price ? x.lot * price : ALGO.ipoTypical);
    const fits = ipoLeft >= need;
    if (fits) ipoLeft -= need;
    const noCash = fits ? null : `No cash for it: ${buffer ? `the IPO buffer ${rs(buffer)} has ${rs(Math.max(0, ipoLeft))} left` : 'with all of the money in India mix there is no separate cash to block'} (needs ${rs(need)}). Set an IPO cash buffer to apply — don't sell India mix for it.`;
    actions.push({
      id: `ipo:${x.symbol}:apply`, kind: 'ipo', paper: false, symbol: x.symbol,
      title: `Apply for ${x.symbol} IPO — last day`, qty: x.lot || null, price: price || null, amount: x.amount || (x.lot && price ? x.lot * price : null),
      detail: `${x.name}: ${x.lot ? `1 lot = ${x.lot} shares at the top of the band ₹${price} ≈ ${rs(x.lot * price)}` : 'lot size not loaded yet — check the issue page'}, "cut-off" price. Accept the UPI mandate by ${ALGO.upiDeadline} today. Money is only blocked until allotment.${x.retailX != null ? ` Retail subscribed ${x.retailX.toFixed(2)}× (${x.retailAsOf || 'latest'}).` : ''}`,
      why: why.ipo, skip: noCash, link: 'ipoCard',
    });
  }
  for (const a of Object.values(ipo?.applications || {})) {
    if (a.listingDate !== date || ['settled', 'no listing', 'no data'].includes(a.status)) continue;
    actions.push({
      id: `ipo:${a.symbol}:sell`, kind: 'ipo', paper: false, symbol: a.symbol, side: 'SELL', qty: a.lot || null, price: null, amount: null,
      title: `If allotted: sell ${a.lot ? `${a.lot} ` : ''}${a.symbol} at the listing open`, detail: 'Check allotment first (registrar / broker app). New listings open after a special pre-open (trading from 10:00). If not allotted, nothing to do.',
      why: why.ipo, skip: null, link: 'ipoCard',
    });
  }

  // Bonus/split run-up: PAPER entries and exits
  const due = (bonus?.upcoming || []).filter((e) => e.entryDate === date);
  const exits = (bonus?.open || []).filter((p) => p.exitDate === date);
  const px = due.length ? closes(due.map((e) => e.symbol)) : {};
  const slot = (bonus?.value || BSR.capital) / BSR.slots;
  for (const e of due) {
    const c = px[e.symbol]?.close;
    actions.push({
      id: `bonus:${e.symbol}:buy`, kind: 'bonus', paper: true, symbol: e.symbol, side: 'BUY', qty: c ? Math.floor(slot / c) : null, price: c || null, amount: c ? Math.floor(slot / c) * c : slot,
      title: `PAPER: buy ${e.symbol} at the open (bonus/split run-up)`, detail: `${e.subject}; ex-date ${e.ex}, sell at the close on ${e.exitDate}${e.late ? ' (entered late: NSE listed the ex-date late)' : ''}. Paper slot ${rs(slot)} of the ₹${(BSR.capital / 100000).toFixed(0)} lakh paper account${c ? ` ≈ ${Math.floor(slot / c)} shares at the last close ₹${c}` : ''}. Not feasible at ${rs(cap)} except as paper: the tested rule used ${rs(slot)} slots × ${BSR.slots}.`,
      why: why.bonus, skip: skipFor(e.symbol), link: 'bsrCard',
    });
  }
  for (const p of exits) {
    actions.push({
      id: `bonus:${p.symbol}:sell`, kind: 'bonus', paper: true, symbol: p.symbol, side: 'SELL', qty: p.shares, price: p.last, amount: p.shares * p.last,
      title: `PAPER: sell ${p.shares} ${p.symbol} at the close (day before ex-date)`, detail: `Bought ${p.entryDate} at ₹${p.entry}; ex-date ${p.ex}. Never held through the ex-date.`, why: why.bonus, skip: null, link: 'bsrCard',
    });
  }

  // F&O at this size (lot sizes from the latest NSE files)
  let foText;
  try {
    foText = (fo || foSizes(cap)).text;
  } catch {
    foText = `F&O: one NIFTY or stock-option lot is many lakh — far above ${rs(cap)}; only buying options is possible, the side most retail traders lose on.`;
  }
  // expiry day
  const warnings = [];
  if (expiry && expiry.level !== 'none') warnings.push({ kind: 'expiry', level: expiry.level, title: expiry.title, short: expiry.short, text: `${expiry.advice} ${expiry.lines[0]} ${expiry.lines.at(-1)}` });
  for (const a of actions) if (a.skip) a.title = `SKIP · ${a.title}`;

  const real = actions.filter((a) => !a.paper && !a.skip);
  const ticks = state.ticks?.[date] || {};
  for (const a of actions) a.done = !!ticks[a.id];
  const nothing = !real.length;
  const parts = [];
  const indiaN = real.filter((a) => a.kind === 'india-mix' || a.kind === 'momentum10').length;
  if (indiaN) parts.push(`India mix ${india_?.bandTriggered ? 're-balance' : 'Momentum 10 changes'} — ${indiaN} order${indiaN === 1 ? '' : 's'}`);
  for (const a of real.filter((x) => x.kind === 'ipo')) parts.push(a.id.endsWith(':apply') ? `apply ${a.symbol} IPO${a.amount ? ` (${rs(a.amount)})` : ''}, UPI by ${ALGO.upiDeadline}` : `sell ${a.symbol} at listing if allotted`);
  const paperN = actions.filter((a) => a.paper).length;
  const skipN = actions.filter((a) => a.skip).length;
  const warn = warnings.length ? ` · ⚠ ${warnings[0].short || warnings[0].title} — don't buy options` : '';
  const summary = nothing
    ? `Nothing to do ${date === today ? 'today' : `on ${dayLabel(date)}`}${paperN ? ` (${paperN} paper-only trade${paperN === 1 ? '' : 's'})` : ''}${skipN ? ` · ${skipN} skipped (don't-buy-now)` : ''}${warn}`
    : `${real.length} to do ${date === today ? 'today' : `on ${dayLabel(date)}`}: ${parts.join('; ')}${paperN ? ` · ${paperN} paper-only` : ''}${skipN ? ` · ${skipN} skipped` : ''}${warn}`;
  return {
    at: now.toISOString(), date, sessionIsToday: date === today, capital: cap, nothing, summary, actions, info, warnings,
    india: india_ && india_.ready ? { bandTriggered: india_.bandTriggered, weights: india_.weights, off: india_.off, finalList: india_.finalList, listDate: india_.listDate, marksAsOf: india_.marksAsOf, liquid: india_.liquid } : null,
    standing: [
      { kind: 'idle', text: `${why.idle} At ${rs(cap + buffer)} the ₹1.25 lakh a year long-term-gains exemption is not a concern.` },
      { kind: 'ipo', text: `IPO apply blocks about ${rs(ALGO.ipoTypical)} per application from cash that is NOT in India mix. IPO cash buffer: ${rs(buffer)} → ${Math.floor(buffer / ALGO.ipoTypical)} application${Math.floor(buffer / ALGO.ipoTypical) === 1 ? '' : 's'} at once.${buffer ? '' : ` With ${rs(cap)} fully in India mix, IPO apply needs a separate small cash buffer (set it above; it can sit in the arbitrage / liquid fund between IPOs).`}` },
      { kind: 'bonus', text: `Bonus/split run-up: not feasible at ${rs(cap)} except as paper — the tested rule used ${rs(BSR.capital / BSR.slots)} slots × ${BSR.slots}.` },
      { kind: 'fo', text: foText },
      { kind: 'avoid', text: why.avoid },
    ],
    settings: { capital: cap, ipoBuffer: buffer, ipoSlots: Math.floor(buffer / ALGO.ipoTypical) },
    sizing: india_?.sizing || stockSizing((m10?.list || []).map((x) => ({ symbol: sym(x.symbol), close: x.close })), cap * INDIA_PARTS.stocks, cap),
    noBroker: 'No broker connection: the app never places orders (not through Groww or any API). It only shows the plan — you place the orders yourself.',
    assumes: `Quantities assume your India mix is in the same proportions as the ₹1 lakh paper portfolio (same ⅓ parts and equal Momentum 10 slots), scaled to ${rs(cap)} and rounded to whole shares (the paper account uses exact rupees); prices are the latest closes, so the open will differ a little. Charges use the app's cost settings (₹0 delivery brokerage, DP ₹15.93 a sell, STT, stamp, exchange, GST). Starting fresh? Buy ⅓ each — see Do this month.`,
    note: 'The rules that passed out-of-sample testing, as one daily list. Past tests do not promise future returns. Not advice.',
  };
}

/** One line for a notification. */
export const planLine = (p) => `Algo plan: ${p.summary}`;

/** Save the day's plan in the log (one entry per session; the latest run for that session wins). */
export function logPlan(plan) {
  const st = loadAlgoState();
  st.log[plan.date] = {
    date: plan.date, at: plan.at, capital: plan.capital, summary: plan.summary, nothing: plan.nothing,
    bandTriggered: plan.india?.bandTriggered ?? null,
    actions: plan.actions.map(({ id, kind, side, symbol, qty, amount, paper, skip }) => ({ id, kind, side: side || null, symbol, qty, amount, paper, skipped: !!skip })),
  };
  for (const d of Object.keys(st.log).sort().slice(0, -ALGO.logDays)) delete st.log[d];
  saveState(st);
  return st.log[plan.date];
}

/**
 * The plan's record = the paper accounts' record. For each logged day that has passed: did the India mix paper
 * portfolio re-balance that day (and make the same band decision), and did the IPO paper record apply that day?
 */
export function trackRecord({ state = loadAlgoState(), india = loadIndiaMixPaper(), ipo = loadIpoApplyPaper(), bonus = loadBonusRunupPaper(), now = new Date() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const days = Object.values(state.log || {}).filter((d) => d.date < today || (d.date === today && !isTradingDay(today))).sort((a, b) => a.date.localeCompare(b.date));
  const checks = [];
  for (const d of days) {
    const ind = d.actions.filter((a) => a.kind === 'india-mix' || a.kind === 'momentum10');
    if (ind.length) {
      const r = (india?.rebalances || []).find((x) => x.date === d.date);
      checks.push({ date: d.date, what: 'India mix re-balance', matched: !!r && (d.bandTriggered == null || r.putBackToThirds === d.bandTriggered), paper: r ? `paper re-balanced (${r.putBackToThirds ? 'back to ⅓' : 'band not triggered'})` : 'no paper re-balance that day' });
    }
    for (const a of d.actions.filter((x) => x.kind === 'ipo' && x.id.endsWith(':apply'))) {
      const p = ipo?.applications?.[a.symbol];
      checks.push({ date: d.date, what: `IPO apply ${a.symbol}`, matched: !!p && p.appliedOn === d.date, paper: p ? `paper ${p.status}${p.status === 'settled' ? ` (expected ${p.expPnl >= 0 ? '+' : '−'}${rs(Math.abs(p.expPnl))})` : ''}` : 'not in the paper record' });
    }
  }
  const iv = india?.curve?.at(-1)?.value;
  return {
    days: days.length, nothingDays: days.filter((d) => d.nothing).length, checks, matched: checks.filter((c) => c.matched).length,
    since: days[0]?.date || null,
    accounts: [
      { name: 'India mix (paper)', card: 'indiaCard', since: india?.startedAt || null, value: iv ?? null, capital: india?.capital ?? null, ret: iv && india?.capital ? iv / india.capital - 1 : null },
      { name: 'IPO apply (paper)', card: 'ipoCard', since: ipo?.startedAt || null, applications: ipo?.totals?.applications ?? 0, settled: ipo?.totals?.settled ?? 0, expectedNet: ipo?.totals?.expected?.net ?? null },
      { name: 'Bonus/split run-up (paper only)', card: 'bsrCard', since: bonus?.startedAt || null, value: bonus?.value ?? null, capital: BSR.capital, ret: bonus?.value ? bonus.value / BSR.capital - 1 : null },
    ],
    note: 'The plan only repeats the paper rules, so its record is the paper accounts\' record; ticks are your own checklist and change nothing there.',
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (!args.includes('--today')) {
      console.log('Usage: node paper-bot/algo-plan.mjs --today [--log] [--capital 500000]');
      process.exit(0);
    }
    const ci = args.indexOf('--capital');
    const p = algoPlan({ capital: ci >= 0 ? Number(args[ci + 1]) || null : null });
    console.log(`Algo plan for ${p.date}${p.sessionIsToday ? ' (today)' : ' (next session)'} · India mix ${rs(p.capital)} · IPO buffer ${rs(p.settings.ipoBuffer)}`);
    console.log(p.summary);
    for (const w of p.warnings) console.log(`⚠ ${w.title}. ${w.text}`);
    for (const i of p.info) console.log(`· ${i.text}`);
    for (const a of p.actions) console.log(`[ ] ${a.title}${a.amount ? ` ≈ ${rs(a.amount)}` : ''}${a.detail ? ` — ${a.detail}` : ''}${a.skip ? ` — ${a.skip}` : ''}\n      why: ${a.why}`);
    const fl = p.sizing.filter((z) => z.flags.length);
    console.log(`Momentum 10 in whole shares at ${rs(p.capital)} (slot ≈ ${rs(p.sizing[0]?.slot || 0)}): ${p.sizing.map((z) => `${z.symbol} ${z.shares}×₹${Math.round(z.price)}`).join(', ')}${fl.length ? ` · ⚠ ${fl.map((z) => `${z.symbol}: ${z.flags.join('; ')}`).join(' · ')}` : ' · all fit'}`);
    for (const s of p.standing) console.log(`Standing: ${s.text}`);
    console.log(p.noBroker);
    if (args.includes('--log')) {
      logPlan(p);
      const t = trackRecord();
      console.log(`Logged. Plan record: ${t.days} past day(s) logged (${t.nothingDays} nothing-to-do), ${t.matched}/${t.checks.length} actions matched the paper records.`);
    }
    console.log('Not advice.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
