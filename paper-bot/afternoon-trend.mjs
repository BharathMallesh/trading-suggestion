#!/usr/bin/env node
// Afternoon trend — NIFTY option buying (library + CLI), PAPER ONLY. The loop-23 option-buying near-miss "T1":
// it passed the 2020–21 search (+8.5% a trade, t 2.79, 81 trades) but lost both periods it had never seen
// (validation 2022 −4.1% a trade; final 2023 → Nov 2026 −2.6% a trade, a ₹1 lakh account −1.5% a year after tax).
// Tracked live on paper only to see whether it comes back. No broker orders — the app never places one.
//
// FROZEN RULES (loop23/optbuy/rounds/FINAL_freeze.md, F1; scripts/m5.py + verify_t1.mjs — copied, not re-tuned):
//   Signal  at the 12:25 5-minute bar close, NIFTY ≥ +0.4% (≤ −0.4%) from the 09:15 open, and the day's highest
//           (lowest) close is within the last 30 minutes (the last 6 bars, 12:00–12:25).
//   Entry   buy the ATM call (put) — the strike nearest the 12:25 close (within 75 points) — of the nearest weekly
//           NIFTY expiry that is NOT expiring that day; fill at the close of the first traded option bar from the
//           12:30 bar (≤ 15:10) + slippage max(0.5%, ₹0.05).
//   Exit    on 5-minute closes after the entry bar: stop at −20% of the entry close, target at +50% (stop checked
//           first), otherwise the 15:15 bar; filled at that close − slippage.
//   Sizing  account ₹1,00,000; lots = floor(₹2,000 ÷ (cost per unit × lot × 0.2)) (cost = fill + charges, as in the
//           research's acct.py), whole lots, never more premium than the account; 0 lots → "skipped: one lot exceeds
//           2% risk". Lot = today's NSE NIFTY lot (65, fo-strangle.mjs lotOn).
//   Never   on a NIFTY expiry day (expiry.mjs) — the research bought the next weekly then; the app's rule is stricter.
//   Costs   ₹20 an order, exchange 0.03503%, SEBI ₹10/crore, GST 18% on those, stamp 0.003% on the buy, STT 0.15% of
//           the premium on the sale (from 1 Apr 2026; fo-strangle.mjs sttSell), + the slippage above.
//
// DATA: it is REPLAYED AFTER THE CLOSE from 5-minute bars (the evening collect job), not run intraday:
//   NIFTY   the app's 5-minute store (collector.mjs, Yahoo, saved at 16:05), else the Groww 5-minute history
//           (groww-history.mjs readHist) — bars up to the 12:25 bar only for the signal.
//   Option  the Groww 5-minute F&O candles (groww-fno.mjs: expiries → contracts → fnoCandles for that day), priced only
//           from bars at or after the 12:30 bar (no look-ahead). No bars → "no option data" for that day, never a guess.
// Live execution would differ: real fills, slippage and the time it takes to act at 12:30.
// Research only — not investment advice. SEBI: ~91% of F&O traders lose money; option buyers lose more.
//
//   node paper-bot/afternoon-trend.mjs --paper                     # record the completed sessions since the start
//   node paper-bot/afternoon-trend.mjs --paper --date 2026-11-23   # one day as a TEST entry (shown, not scored)

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { isExpiryDay, nextSession, expiryStatus } from './expiry.mjs';
import { lotOn, sttSell } from './fo-strangle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = () => process.env.AFTERNOON_TREND_PAPER_PATH || join(HERE, 'data', 'afternoon-trend-paper.json');
const FO_HIST = () => process.env.FO_HIST_DIR || join(HERE, 'data', 'fo-hist');

export const RULES = {
  signalBar: '12:25', openBar: '09:15', entryFrom: '12:30', entryLast: '15:10', exitAt: '15:15',
  movePct: 0.4, recentBars: 6, minBars: 8, stop: 0.2, target: 0.5, maxStrikeGap: 75,
  slipPct: 0.5, tick: 0.05, brokeragePerOrder: 20, capital: 100000, riskRs: 2000, stopFrac: 0.2,
  taxRate: 0.312, arbYield: 0.065, arbTax: 0.208,
};

export const RESEARCH = {
  name: 'T1 afternoon trend (loop 23, option buying)',
  rows: [
    { period: 'Search 2020–21', seen: 'used to choose the rule', perTrade: 8.5, t: 2.79, n: 81, note: 'passed' },
    { period: 'Validation 2022', seen: 'never seen', perTrade: -4.1, t: null, n: null, note: 'failed' },
    { period: 'Final 2023 → Nov 2026', seen: 'never seen, run once', perTrade: -2.6, t: null, n: 73, note: 'lost — ₹1 lakh account −1.5% a year after tax' },
  ],
  verdict: 'lost both unseen periods; tracked live on paper only to see whether it comes back',
  sebi: 'SEBI: ~91% of F&O traders lose money; option buyers lose more.',
  frozen: 'Rules frozen on 24 Nov 2026 before the final run (FINAL_freeze.md, F1); nothing changed after seeing it.',
};
export const VERDICT = 'Unproven until ≥ 100 trades.';
export const REPLAY_NOTE = 'Replayed after the close from 5-minute bars (NIFTY: the app\'s 5-minute store; option: Groww 5-minute candles), at the rule times, using only bars at or after the signal bar. Live execution would differ (slippage, fills, the time it takes to act at 12:30).';

// ------------------------------------------------------------------ costs (₹ per unit) ---
const exch = (d) => (d < '2024-10-01' ? 0.05 : 0.03503);
export const fillBuy = (px, r = RULES) => px + Math.max((px * r.slipPct) / 100, r.tick);
export const fillSell = (px, r = RULES) => Math.max(px - Math.max((px * r.slipPct) / 100, r.tick), 0);
/** Statutory + brokerage for one order of one lot, ₹ per unit (slippage is in the fill). */
export function charges(prem, d, lot, side, r = RULES) {
  const p = Math.max(prem, 0);
  const brk = r.brokeragePerOrder / lot;
  const ex = (p * exch(d)) / 100;
  const sebi = p * 1e-6;
  const stt = side === 'sell' ? (p * sttSell(d)) / 100 : 0;
  const stamp = side === 'buy' ? p * 3e-5 : 0;
  return brk + ex + sebi + stt + stamp + 0.18 * (brk + ex + sebi);
}

// ------------------------------------------------------------------ the rule ---
const hm = (b) => String(b.date).slice(11, 16);
const dayOf = (b) => String(b.date).slice(0, 10);

/** The signal from one day's NIFTY 5-minute bars (only bars up to the 12:25 bar are looked at). */
export function detectSignal(bars, r = RULES) {
  const day = [...(bars || [])].filter((b) => b.close > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const upto = day.filter((b) => hm(b) <= r.signalBar);
  if (!upto.length || hm(upto[0]) !== r.openBar) return { type: null, reason: 'no NIFTY 5-minute bars', retry: true };
  if (upto.length < r.minBars || hm(upto.at(-1)) !== r.signalBar) return { type: null, reason: `NIFTY 5-minute bars incomplete (no ${r.signalBar} bar)`, retry: true };
  const open = upto[0].open;
  const close = upto.at(-1).close;
  const move = close / open - 1;
  const cl = upto.map((b) => b.close);
  const recent = cl.slice(-r.recentBars);
  const base = { open, close, move, bar: r.signalBar, high: Math.max(...cl), low: Math.min(...cl) };
  if (move >= r.movePct / 100 && Math.max(...recent) >= Math.max(...cl) - 1e-9) return { ...base, type: 'CE' };
  if (move <= -r.movePct / 100 && Math.min(...recent) <= Math.min(...cl) + 1e-9) return { ...base, type: 'PE' };
  const why = Math.abs(move) < r.movePct / 100 ? `NIFTY ${(move * 100).toFixed(2)}% from the open (needs ±${r.movePct}%)` : `NIFTY ${(move * 100).toFixed(2)}% but the day's ${move > 0 ? 'highest' : 'lowest'} close was not in the last 30 minutes`;
  return { ...base, type: null, reason: `no signal: ${why}` };
}

/** Nearest NIFTY expiry after `date` (never the same day) from a list of expiry dates. */
export const pickExpiry = (date, expiryList) => [...(expiryList || [])].filter((e) => e > date).sort()[0] || null;

/** ATM strike: the listed strike nearest `spot` that has a contract of `type` (lower on a tie), within 75 points. */
export function pickStrike(chain, spot, type, r = RULES) {
  const ks = Object.keys(chain || {}).filter((k) => chain[k]?.[type]).map(Number).sort((a, b) => a - b);
  let best = null;
  for (const k of ks) if (best == null || Math.abs(k - spot) < Math.abs(best - spot)) best = k;
  return best != null && Math.abs(best - spot) <= r.maxStrikeGap ? best : null;
}

/** Entry and exit along the option's 5-minute bars of `date` (bars before the 12:30 bar are never read). */
export function simulateExit(optBars, date, r = RULES) {
  const bars = (optBars || []).filter((b) => dayOf(b) === date && hm(b) >= r.entryFrom).sort((a, b) => (a.date < b.date ? -1 : 1));
  const traded = (b) => b.volume > 0 && b.close > 0;
  const i0 = bars.findIndex((b) => hm(b) <= r.entryLast && traded(b));
  if (i0 < 0) return null;
  const p0 = bars[i0].close;
  let exit = null;
  for (const b of bars.slice(i0 + 1)) {
    if (!traded(b)) continue;
    if (b.close <= p0 * (1 - r.stop)) { exit = { time: hm(b), price: b.close, why: 'stop' }; break; }
    if (b.close >= p0 * (1 + r.target)) { exit = { time: hm(b), price: b.close, why: 'target' }; break; }
    if (hm(b) >= r.exitAt) { exit = { time: hm(b), price: b.close, why: '15:15' }; break; }
  }
  if (!exit) {
    const last = bars.slice(i0 + 1).filter(traded).at(-1);
    if (!last) return null;
    exit = { time: hm(last), price: last.close, why: 'last bar' };
  }
  return { entry: { time: hm(bars[i0]), price: p0 }, exit };
}

/** Whole lots for the 2% risk at the 20% stop (and never more premium than the account). */
export function sizeLots(costPerUnit, lot, r = RULES, equity = r.capital) {
  const riskPerLot = costPerUnit * lot * r.stopFrac;
  if (!(riskPerLot > 0)) return 0;
  let lots = Math.floor(r.riskRs / riskPerLot);
  while (lots > 0 && lots * costPerUnit * lot > equity) lots--;
  return Math.max(0, lots);
}

/** One trade's ₹ from entry / exit closes. */
export function priceTrade({ entry, exit }, date, lot, lots, r = RULES) {
  const cost = fillBuy(entry.price, r) + charges(entry.price, date, lot, 'buy', r);
  const proc = fillSell(exit.price, r) - charges(exit.price, date, lot, 'sell', r);
  const units = lot * lots;
  const chg = (charges(entry.price, date, lot, 'buy', r) + charges(exit.price, date, lot, 'sell', r)) * units;
  return { costPerUnit: cost, procPerUnit: proc, ret: (proc - cost) / cost, pnl: (proc - cost) * units, charges: chg, gross: (exit.price - entry.price) * units, premium: cost * units };
}

/**
 * One session through the rule. `getOptions({ date, type, spot })` → { expiry, strike, symbol, bars } (or throws /
 * returns null bars when Groww has nothing). Returns the day's record: a trade, or a skip with the reason.
 */
export async function evaluateDay({ date, niftyBars, getOptions, isExpiry = (d) => isExpiryDay(d, 'NIFTY'), r = RULES, equity = r.capital, lot = lotOn(date) }) {
  const sig = detectSignal(niftyBars, r);
  const rec = { date, signal: sig.type ? { type: sig.type, move: sig.move, open: sig.open, close: sig.close, bar: sig.bar } : sig.open ? { type: null, move: sig.move, open: sig.open, close: sig.close, bar: sig.bar } : null };
  if (!sig.type) return { ...rec, status: 'skip', reason: sig.reason, ...(sig.retry ? { retry: true } : {}) };
  if (isExpiry(date)) return { ...rec, status: 'skip', reason: 'expiry day: no trade (NIFTY weekly expires today)' };
  let o = null;
  try {
    o = await getOptions({ date, type: sig.type, spot: sig.close });
  } catch (err) {
    return { ...rec, status: 'skip', reason: 'no option data', detail: String(err.message || err).slice(0, 160), retry: true };
  }
  if (!o?.expiry) return { ...rec, status: 'skip', reason: 'no option data', detail: o?.detail || 'no NIFTY expiry after this day', retry: true };
  if (o.strike == null) return { ...rec, status: 'skip', reason: 'no option data', detail: o.detail || `no listed ${sig.type} strike within ${r.maxStrikeGap} points`, expiry: o.expiry, retry: true };
  const leg = { expiry: o.expiry, strike: o.strike, type: sig.type, symbol: o.symbol || null };
  const path = simulateExit(o.bars, date, r);
  if (!path) return { ...rec, ...leg, status: 'skip', reason: 'no option data', detail: 'no traded 5-minute option bar from 12:30', retry: true };
  const one = priceTrade(path, date, lot, 1, r);
  const lots = sizeLots(one.costPerUnit, lot, r, equity);
  if (lots < 1) return { ...rec, ...leg, entry: path.entry, lot, costPerUnit: one.costPerUnit, status: 'skip', reason: 'skipped: one lot exceeds 2% risk' };
  const t = priceTrade(path, date, lot, lots, r);
  return { ...rec, ...leg, status: 'trade', entry: path.entry, exit: path.exit, lot, lots, ...t };
}

// ------------------------------------------------------------------ scorecard ---
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function tOf(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null;
}
/** Indian financial year of a date ('2026-27' for 1 Apr 2026 – 31 Mar 2027). */
export const fyOf = (d) => {
  const y = Number(d.slice(0, 4));
  const s = Number(d.slice(5, 7)) >= 4 ? y : y - 1;
  return `${s}-${String(s + 1).slice(2)}`;
};
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/**
 * The scorecard from the scored (non-test) day records: n, win rate, average % a trade, ₹ total, day-clustered t,
 * the equity curve, tax as business income (31.2%, by financial year, losses carried forward), and the same money
 * in an arbitrage fund and in NIFTY.
 */
export function summarise(days, { r = RULES, startedAt = null, niftyAtStart = null, niftyNow = null, asOf = null } = {}) {
  const scored = (days || []).filter((d) => !d.test);
  const trades = scored.filter((d) => d.status === 'trade').sort((a, b) => (a.date < b.date ? -1 : 1));
  const skips = {};
  for (const d of scored.filter((x) => x.status === 'skip')) {
    const k = /^no signal/.test(d.reason) ? 'no signal' : d.reason;
    skips[k] = (skips[k] || 0) + 1;
  }
  const n = trades.length;
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  // day-clustered: trades of the same day are one observation (their mean return)
  const byDay = new Map();
  for (const t of trades) byDay.set(t.date, [...(byDay.get(t.date) || []), t.ret]);
  const dayRets = [...byDay.values()].map(mean);
  let eq = r.capital;
  let peak = eq;
  let maxDd = 0;
  const curve = [];
  for (const d of [...scored].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (d.status === 'trade') eq += d.pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    curve.push({ date: d.date, equity: eq });
  }
  // tax: business income at 31.2% on each financial year's net, losses carried forward
  const fy = {};
  for (const t of trades) fy[fyOf(t.date)] = (fy[fyOf(t.date)] || 0) + t.pnl;
  let carry = 0;
  let tax = 0;
  const years = Object.keys(fy).sort().map((y) => {
    const net = fy[y] + carry;
    const tx = net > 0 ? r.taxRate * net : 0;
    carry = net > 0 ? 0 : net;
    tax += tx;
    return { fy: y, pnl: fy[y], tax: tx };
  });
  const to = asOf || curve.at(-1)?.date || null; // nothing recorded yet → no time has passed
  const span = startedAt && to && to >= startedAt ? daysBetween(startedAt, to) + 1 : 0;
  const arbGross = r.capital * ((1 + r.arbYield) ** (span / 365) - 1);
  return {
    n, won: trades.filter((t) => t.pnl > 0).length,
    winRate: n ? trades.filter((t) => t.pnl > 0).length / n : null,
    avgRetPct: n ? mean(trades.map((t) => t.ret)) * 100 : null,
    totalRs: total, avgRs: n ? total / n : null,
    tDay: tOf(dayRets), tradeDays: dayRets.length,
    best: n ? Math.max(...trades.map((t) => t.pnl)) : null, worst: n ? Math.min(...trades.map((t) => t.pnl)) : null,
    exits: { stop: trades.filter((t) => t.exit?.why === 'stop').length, target: trades.filter((t) => t.exit?.why === 'target').length, time: trades.filter((t) => !['stop', 'target'].includes(t.exit?.why)).length },
    sessions: scored.length, skips,
    equity: r.capital + total, curve, maxDrawdown: maxDd,
    afterTax: { tax, pnl: total - tax, equity: r.capital + total - tax, years, basis: 'business income at 31.2% (30% + 4% cess) on each financial year\'s net, losses carried forward' },
    arbitrage: { from: startedAt, to, days: span, gross: arbGross, afterTax: arbGross * (1 - r.arbTax), basis: `₹${r.capital.toLocaleString('en-IN')} in an arbitrage fund at ≈${(r.arbYield * 100).toFixed(1)}% a year, taxed as short-term equity (20.8%)` },
    nifty: niftyAtStart > 0 && niftyNow > 0 ? { from: niftyAtStart, now: niftyNow, ret: niftyNow / niftyAtStart - 1, rs: r.capital * (niftyNow / niftyAtStart - 1), basis: `₹${r.capital.toLocaleString('en-IN')} in NIFTY 50 at the close before the start (index, no dividends, before tax)` } : null,
    verdict: VERDICT,
  };
}

// ------------------------------------------------------------------ data ---
const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

/** NIFTY 5-minute bars of `date`: the live store (collector.mjs), else the Groww history. */
export async function niftyBarsFor(date) {
  const { readStore } = await import('./collector.mjs');
  let bars = readStore('^NSEI', '5m').filter((b) => dayOf(b) === date);
  let source = 'app 5-minute store (collector.mjs)';
  if (!bars.some((b) => hm(b) === RULES.signalBar)) {
    const { readHist } = await import('./groww-history.mjs');
    const h = readHist('^NSEI').filter((b) => dayOf(b) === date);
    if (h.some((b) => hm(b) === RULES.signalBar)) {
      bars = h;
      source = 'Groww 5-minute history (groww-history.mjs)';
    }
  }
  return { bars, source };
}

/** The option leg from Groww (expiry list → contract list → that day's 5-minute candles). Empty answers are not cached. */
export async function growwOptions({ date, type, spot }, r = RULES) {
  const { expiries, contracts, fnoCandles } = await import('./groww-fno.mjs');
  const y = Number(date.slice(0, 4));
  let list = await expiries('NIFTY', y);
  let expiry = pickExpiry(date, list);
  if (!expiry) {
    list = await expiries('NIFTY', y + 1);
    expiry = pickExpiry(date, list);
  }
  if (!expiry) return { expiry: null, detail: 'Groww listed no NIFTY expiry after this day' };
  const chain = await contracts('NIFTY', expiry);
  if (!Object.keys(chain).length) {
    try { unlinkSync(join(FO_HIST(), 'contracts', `NIFTY-${expiry}.json`)); } catch { /* not cached */ }
    return { expiry, strike: null, detail: `Groww listed no contracts for the ${expiry} expiry` };
  }
  const strike = pickStrike(chain, spot, type, r);
  if (strike == null) return { expiry, strike: null };
  const symbol = chain[strike][type];
  const bars = await fnoCandles(symbol, date, date);
  if (!bars.some((b) => dayOf(b) === date)) {
    try { unlinkSync(join(FO_HIST(), 'candles', `${symbol}_${date}_${date}.json.gz`)); } catch { /* not cached */ }
  }
  return { expiry, strike, symbol, bars };
}

// ------------------------------------------------------------------ paper record ---
const ist = (now) => new Date(now.getTime() + 19800_000);
const todayIst = (now) => ist(now).toISOString().slice(0, 10);
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
/** The latest session whose 5-minute store is complete: today after 16:00 IST (the collect job), else the one before. */
export function lastCompleteSession(now = new Date()) {
  const t = ist(now);
  let d = t.toISOString().slice(0, 10);
  if (!(isTradingDay(d) && t.getUTCHours() * 60 + t.getUTCMinutes() >= 16 * 60)) d = addDays(d, -1);
  for (let k = 0; k < 12 && !isTradingDay(d); k++) d = addDays(d, -1);
  return d;
}
export const loadAfternoonPaper = (file = PAPER()) => readJ(file);

const niftyCloseOn = async (date) => {
  const { bars } = await niftyBarsFor(date);
  return bars.filter((b) => b.close > 0 && hm(b) <= '15:25').at(-1)?.close ?? null;
};

/**
 * Update the paper record: every completed session from the start date not yet recorded (and recent "no data" days
 * again). With `date`: that one session as a TEST entry (kept apart, not scored).
 */
export async function afternoonPaperUpdate({ now = new Date(), date = null, file = PAPER(), getNifty = niftyBarsFor, getOptions = growwOptions, isExpiry = (d) => isExpiryDay(d, 'NIFTY'), r = RULES, niftyClose = niftyCloseOn } = {}) {
  const today = todayIst(now);
  let st = readJ(file);
  if (!st) {
    const last = lastCompleteSession(now);
    st = { startedAt: nextSession(today), openedAt: now.toISOString(), capital: r.capital, rules: r, days: [], tests: [], niftyAtStart: await niftyClose(last), niftyStartDate: last };
  }
  const ran = [];
  const run = async (d, test) => {
    if (!isTradingDay(d)) return { date: d, status: 'skip', reason: 'not a trading day', test };
    const { bars, source } = await getNifty(d);
    const equity = r.capital + st.days.filter((x) => x.status === 'trade' && x.date < d).reduce((a, t) => a + t.pnl, 0);
    const rec = await evaluateDay({ date: d, niftyBars: bars, getOptions, isExpiry, r, equity });
    return { ...rec, niftySource: source, recordedAt: now.toISOString(), ...(test ? { test: true } : {}) };
  };
  if (date) {
    const rec = await run(date, true);
    st.tests = [...(st.tests || []).filter((x) => x.date !== date), rec].sort((a, b) => (a.date < b.date ? -1 : 1));
    ran.push(rec);
  } else {
    const upto = lastCompleteSession(now);
    const have = new Map(st.days.map((x) => [x.date, x]));
    for (let d = st.startedAt; d <= upto; d = addDays(d, 1)) {
      if (!isTradingDay(d)) continue;
      const old = have.get(d);
      if (old && !(old.retry && d >= addDays(today, -7))) continue;
      const rec = await run(d, false);
      st.days = [...st.days.filter((x) => x.date !== d), rec].sort((a, b) => (a.date < b.date ? -1 : 1));
      ran.push(rec);
    }
    st.dataTo = st.days.at(-1)?.date || null;
    if (st.dataTo) st.niftyNow = await niftyClose(st.dataTo);
  }
  st.updatedAt = now.toISOString();
  writeJsonAtomic(file, st);
  return { st, ran, summary: summarise(st.days, { r, startedAt: st.startedAt, niftyAtStart: st.niftyAtStart, niftyNow: st.niftyNow, asOf: st.dataTo }) };
}

const RULE_TEXT = [
  'Signal at the 12:25 5-minute bar close: NIFTY ≥ +0.4% (≤ −0.4%) from the 09:15 open and the day\'s highest (lowest) close within the last 30 minutes.',
  'Buy the ATM call (put) of the nearest weekly NIFTY expiry that is not expiring that day, at the 12:30 bar close + slippage (max 0.5%, ₹0.05).',
  'Exit on 5-minute closes: stop −20%, target +50%, otherwise sell at the 15:15 bar.',
  'Account ₹1,00,000; lots = floor(₹2,000 ÷ (premium × lot 65 × 0.2)); 0 lots → skipped. Never on a NIFTY expiry day.',
  'Costs: ₹20 an order, STT 0.15% of the premium on the sale (from 1 Apr 2026), exchange, SEBI, stamp, GST.',
];

/** What the card shows. */
export function afternoonView({ now = new Date(), file = PAPER() } = {}) {
  const st = loadAfternoonPaper(file);
  const r = RULES;
  const sum = summarise(st?.days || [], { r, startedAt: st?.startedAt, niftyAtStart: st?.niftyAtStart, niftyNow: st?.niftyNow, asOf: st?.dataTo });
  let xp = null;
  try {
    const s = expiryStatus(now);
    xp = { session: s.session, level: s.level, title: s.title, niftyExpiry: isExpiryDay(s.session, 'NIFTY'), next: s.next.find((x) => x.index === 'NIFTY')?.weekly || null };
  } catch {
    xp = null;
  }
  const trades = (st?.days || []).filter((d) => d.status === 'trade').slice(-10).reverse();
  const recentDays = (st?.days || []).slice(-10).reverse();
  return {
    startedAt: st?.startedAt || null, dataTo: st?.dataTo || null, updatedAt: st?.updatedAt || null,
    rules: RULE_TEXT, summary: sum, trades, recentDays, tests: st?.tests || [], expiry: xp,
    research: RESEARCH, verdict: VERDICT, replay: REPLAY_NOTE,
    note: 'Paper only — no broker orders. Not advice.',
  };
}

// ------------------------------------------------------------------ CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const line = (x) => {
    const s = x.signal?.type ? `signal ${x.signal.type === 'CE' ? 'CALL' : 'PUT'} (NIFTY ${(x.signal.move * 100).toFixed(2)}% at 12:25)` : x.signal ? `NIFTY ${(x.signal.move * 100).toFixed(2)}% at 12:25` : '';
    if (x.status === 'trade') return `${x.date}${x.test ? ' [TEST, not scored]' : ''}: ${s} → bought ${x.lots} lot(s) NIFTY ${x.expiry} ${x.strike} ${x.type} at ${x.entry.time} ₹${x.entry.price.toFixed(2)}, out ${x.exit.why} ${x.exit.time} ₹${x.exit.price.toFixed(2)} → ${(x.ret * 100).toFixed(1)}% · ${rs(x.pnl)} after costs`;
    return `${x.date}${x.test ? ' [TEST, not scored]' : ''}: ${s ? `${s} → ` : ''}${x.reason}${x.detail ? ` (${x.detail})` : ''}`;
  };
  const dI = process.argv.indexOf('--date');
  const date = dI > 0 ? process.argv[dI + 1] : null;
  if (!process.argv.includes('--paper') || (dI > 0 && !/^\d{4}-\d\d-\d\d$/.test(date || ''))) {
    console.log('usage: node paper-bot/afternoon-trend.mjs --paper [--date YYYY-MM-DD]');
    process.exit(2);
  }
  try {
    const { st, ran, summary: s } = await afternoonPaperUpdate({ date });
    for (const x of ran) console.log(line(x));
    if (!ran.length) console.log(`Nothing new: the record starts ${st.startedAt}${st.dataTo ? `, recorded to ${st.dataTo}` : ''}.`);
    console.log(`Afternoon trend paper (since ${st.startedAt}): ${s.n} trades · ${s.n ? `won ${Math.round(s.winRate * 100)}% · avg ${s.avgRetPct.toFixed(1)}%/trade · ${rs(s.totalRs)}` : 'none yet'} · ${VERDICT}`);
    console.log(`${REPLAY_NOTE} Paper only — no broker orders. Not advice.`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
