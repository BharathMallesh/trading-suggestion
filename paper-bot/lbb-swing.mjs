#!/usr/bin/env node
// Leader Box Breakout "LBB" (library + CLI) — PAPER ONLY. The best version built from the popular YouTube swing
// strategies (Nov 2026 multi-agent study): Minervini's trend template picks the stocks, a Darvas box breakout times the
// entry, Weinstein's 30-week average decides the exit; signals ranked by relative strength (RS), new buys only while
// NIFTY is above its 200-day average, every position sized by risk.
//
// Rules (frozen 16 Nov 2026, designed on 2010–22 only):
//  • Universe: NSE top 200 by traded value (previous month, point in time).
//  • Darvas box: a 52-week high starts a box top; top confirmed after 3 sessions with no higher high; floor = lowest low
//    since the top, confirmed after 3 sessions with no lower low (and no new high). Close below the floor cancels the box.
//  • Buy signal on the close above the confirmed box top when ALL hold: trend template (close > 50 > 150 > 200-day SMAs,
//    200-day SMA rising over 21 sessions, close ≥ 1.25 × 52-week low and ≥ 0.75 × 52-week high); RS rank ≥ 70
//    (average of 6- and 12-month return, percentile within the top 200); volume above its 50-day average; NIFTY above
//    its 200-day SMA. One trade at a time per stock. Bought at the next open (not if it opens at/below the stop).
//  • Stop: the box floor, never more than 8% below the breakout close; fixed. Exit: a close below the stop, or a weekly
//    close below the 30-week SMA of weekly closes — sold at the next open.
//  • Size: 0.5% of equity at risk ÷ stop distance, ≤ 6% of equity, ≤ cash, skip if < 2%; highest RS first; if cash is
//    short, sell the weakest-RS holding when it trails the new signal by ≥ 20 RS points (one rotation per signal).
// Research (₹5 lakh, 0.35% costs, after tax): 2010–22 14.1%/yr (worst fall 30%) vs Momentum 10 17.3%, NIFTY 10.7% →
// FAILED the agreed bar; run once, frozen, on later data: 2023–24 42.1%/yr, 2025 → Nov 2026 4.9%/yr with per-trade
// t 0.4 (no reliable edge). A boom-market system — tracked on paper to build a live record. Not advice.
//
//   node --max-old-space-size=12000 paper-bot/lbb-swing.mjs --paper

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { loadSeries, pointInTimeUniverse } from './bhav-history.mjs';
import { candles } from '../market-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const PAPER = () => process.env.LBB_PAPER_PATH || join(HERE, 'data', 'lbb-swing-paper.json');
export const LBB = { conf: 3, rsMin: 70, volx: 1, maxStop: 0.08, wkMa: 30, riskPct: 0.5, maxPct: 6, minPct: 2, maxOpen: 25, rotGap: 20, cost: 0.35, capital: 500000, cashYield: 0.06 };
export const RESEARCH = {
  dev: { period: '2010–2022', trades: 450, perTradePct: 8.41, t: 3.7, afterTaxPerYear: 0.141, maxDD: 0.30, note: 'designed here; Momentum 10 17.3%, E2 13.6%, NIFTY 10.7% — failed the bar (did not beat Momentum 10)' },
  val: { period: '2023–2024', trades: 86, perTradePct: 21.2, t: 3.4, afterTaxPerYear: 0.421, maxDD: 0.20, note: 'frozen rule run once; Momentum 10 31.0%, E2 29.8%, NIFTY 14.8%' },
  test: { period: '2025 → Nov 2026', trades: 43, perTradePct: 1.7, t: 0.4, afterTaxPerYear: 0.049, maxDD: 0.15, note: 'no reliable edge; E2 11.8%, NIFTY 1.7%, Momentum 10 1.4% (fall 36%)' },
};
export const loadLbbPaper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};

const sma = (a, n) => {
  const o = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) o[i] = s / n;
  }
  return o;
};
/** Rolling max (dir 1) or min (dir −1) over the last n values including today (monotonic deque). */
const roll = (a, n, dir) => {
  const o = new Array(a.length).fill(null);
  const dq = [];
  for (let i = 0; i < a.length; i++) {
    while (dq.length && (a[dq.at(-1)] - a[i]) * dir <= 0) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) o[i] = a[dq[0]];
  }
  return o;
};
const monday = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return new Date(t - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
};

/** Indicators + Darvas box breakouts for one stock's daily rows ({date, open, high, low, close, val}). */
export function prepare(rows, R = LBB) {
  const n = rows.length;
  const c = rows.map((r) => r.close);
  const h = rows.map((r) => r.high);
  const l = rows.map((r) => r.low);
  const v = rows.map((r) => r.val / r.close); // shares ≈ traded value ÷ close
  const bars = rows.map((r, i) => ({ ...r, i, vol: v[i] }));
  const s50 = sma(c, 50);
  const s150 = sma(c, 150);
  const s200 = sma(c, 200);
  const av50 = sma(v, 50);
  const hh = roll(h, 252, 1);
  const ll = roll(l, 252, -1);
  // weekly closes (last session of each Monday-start week) and their 30-week SMA, known on that session
  const wIdx = [];
  for (let i = 0; i < n; i++) if (i + 1 >= n || monday(rows[i + 1].date) !== monday(rows[i].date)) wIdx.push(i);
  const wkEnd = new Set(wIdx);
  const wMa = new Map();
  for (let k = R.wkMa - 1; k < wIdx.length; k++) {
    let t = 0;
    for (let j = k - R.wkMa + 1; j <= k; j++) t += c[wIdx[j]];
    wMa.set(wIdx[k], t / R.wkMa);
  }
  // the last bar is a week's end only if the week is over (Friday) — otherwise its weekly close is not final yet
  if (n && new Date(`${rows[n - 1].date}T00:00:00Z`).getUTCDay() !== 5) wkEnd.delete(n - 1);
  // Darvas box machine
  let st = 'seek';
  let top = 0;
  let tb = 0;
  let floor = 0;
  let fb = 0;
  let box = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    Object.assign(b, { s50: s50[i], s150: s150[i], s200: s200[i], hh: hh[i], ll: ll[i], av50prev: i ? av50[i - 1] : null, weekEnd: wkEnd.has(i), w30: wMa.get(i) ?? null });
    if (i < 252) continue;
    if (st === 'seek') {
      if (h[i] >= hh[i]) { st = 'top'; top = h[i]; tb = i; }
    } else if (st === 'top') {
      if (h[i] > top) { top = h[i]; tb = i; } else if (i - tb >= R.conf) {
        st = 'floor';
        floor = Infinity;
        for (let j = tb + 1; j <= i; j++) if (l[j] < floor) { floor = l[j]; fb = j; }
        if (i - fb >= R.conf) { st = 'box'; box = { top, floor }; }
      }
    } else if (st === 'floor') {
      if (h[i] > top) { st = 'top'; top = h[i]; tb = i; } else if (l[i] < floor) { floor = l[i]; fb = i; } else if (i - fb >= R.conf) { st = 'box'; box = { top, floor }; }
    } else if (st === 'box') {
      if (c[i] > box.top) { b.brkTop = box.top; b.brkFloor = box.floor; st = 'top'; top = h[i]; tb = i; } else if (c[i] < box.floor) st = 'seek';
    }
  }
  return bars;
}

/** Minervini trend template at bar i. */
export function trendTemplate(bars, i) {
  const b = bars[i];
  const p = bars[i - 21];
  if (b.s200 == null || b.s150 == null || b.s50 == null || !p || p.s200 == null) return false;
  return b.close > b.s150 && b.close > b.s200 && b.s150 > b.s200 && b.s200 > p.s200 && b.s50 > b.s150 && b.close > b.s50 && b.close >= 1.25 * b.ll && b.close >= 0.75 * b.hh;
}

/** Walk a trade bought at the open of bar e with a fixed stop: close below the stop, or a weekly close below the
 *  30-week SMA → sold at the next open. Still running at the data end → open (sellNextOpen when the exit fired). */
export function walk(bars, e, stop, R = LBB) {
  for (let i = e; i < bars.length; i++) {
    const b = bars[i];
    if (i > e) {
      const pb = bars[i - 1];
      if ((Date.parse(b.date) - Date.parse(pb.date)) / 86400000 > 31) return { xi: i - 1, exit: pb.close, reason: 'suspended' };
      if (b.open / pb.close < 0.55 || b.close / pb.close < 0.35) return { xi: i - 1, exit: pb.close, reason: 'corporate action' };
    }
    const why = b.close < stop ? 'stop' : i > e && b.weekEnd && b.w30 != null && b.close < b.w30 ? '30-week exit' : null;
    if (why) {
      if (i + 1 < bars.length) return { xi: i + 1, exit: bars[i + 1].open, reason: why };
      return { open: true, sellNextOpen: true, reason: why, xi: i };
    }
  }
  return { open: true, sellNextOpen: false, xi: bars.length - 1 };
}

/** Every stock's LBB trades (one at a time per stock) + the signals on the latest close (to buy at the next open). */
export function tradesFor(sym, bars, universe, niftyUp, from, R = LBB) {
  const out = [];
  const signals = [];
  let busyUntil = -1;
  for (let i = 300; i < bars.length; i++) {
    const b = bars[i];
    if (b.brkTop == null || i <= busyUntil || b.date < from) continue;
    if (!(b.rs >= R.rsMin) || !trendTemplate(bars, i)) continue;
    if (!(b.av50prev && b.vol > R.volx * b.av50prev) || !niftyUp(b.date)) continue;
    if (!universe.get(b.date.slice(0, 7))?.has(sym)) continue;
    if (b.close / bars[i - 1].close < 0.55) continue;
    const stop = Math.max(b.brkFloor, b.close * (1 - R.maxStop));
    const sig = { symbol: sym, signalDate: b.date, close: b.close, stop, riskPct: (b.close - stop) / b.close, rs: b.rs };
    if (i + 1 >= bars.length) { signals.push(sig); break; } // buy at the next open
    const e = i + 1;
    if (bars[e].open <= stop || bars[e].open / b.close < 0.55) continue;
    const w = walk(bars, e, stop, R);
    out.push({ ...sig, entryDate: bars[e].date, entry: bars[e].open,
      ...(w.open ? { open: true, sellNextOpen: w.sellNextOpen, exitReason: w.reason || null } : { open: false, exit: w.exit, exitDate: bars[w.xi].date, reason: w.reason }) });
    busyUntil = w.xi;
    if (w.open) break;
  }
  return { trades: out, signals };
}

/** NIFTY above its 200-day SMA on a date (closing basis); dates without a NIFTY bar use the previous one. */
export function niftyFilter(rows) {
  const c = rows.map((r) => r.close);
  const s = sma(c, 200);
  const up = new Map(rows.map((r, i) => [r.date, s[i] != null && r.close > s[i]]));
  const dates = rows.map((r) => r.date);
  return (d) => {
    if (up.has(d)) return up.get(d);
    let lo = 0;
    let hi = dates.length - 1;
    let k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 ? up.get(dates[k]) : false;
  };
}

/** Load NSE history, RS ranks, every stock's trades and today's signals. */
export function buildTrades({ from, fromMonth, to = null, niftyRows }) {
  const months = readdirSync(BHAV()).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, 7)).filter((m) => m >= fromMonth && (!to || m <= to.slice(0, 7)));
  const raw = loadSeries({ months });
  const series = new Map();
  for (const [s, rows] of raw) {
    const r = rows.filter((x) => (!to || x.date <= to) && x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0 && x.val > 0);
    if (r.length > 300) series.set(s, r);
  }
  const universe = pointInTimeUniverse(series);
  const stocks = new Map([...series].map(([s, rows]) => [s, prepare(rows)]));
  // RS: average of 6- and 12-month return, percentile among that month's universe, each day
  const byDate = new Map();
  for (const [s, bars] of stocks) for (let i = 252; i < bars.length; i++) {
    const b = bars[i];
    if (!universe.get(b.date.slice(0, 7))?.has(s)) continue;
    b.rsScore = 0.5 * (b.close / bars[i - 126].close - 1) + 0.5 * (b.close / bars[i - 252].close - 1);
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  for (const bs of byDate.values()) {
    bs.sort((a, b) => a.rsScore - b.rsScore);
    bs.forEach((b, k) => { b.rs = (100 * k) / Math.max(1, bs.length - 1); });
  }
  const niftyUp = niftyFilter(niftyRows);
  const trades = [];
  const signals = [];
  for (const [s, bars] of stocks) {
    const r = tradesFor(s, bars, universe, niftyUp, from);
    trades.push(...r.trades);
    signals.push(...r.signals);
  }
  const days = [...byDate.keys()].sort();
  const lastDate = days.at(-1);
  return { trades, signals: signals.filter((x) => x.signalDate === lastDate), stocks, lastDate, days, niftyUp };
}

/** The paper account from `startedAt`: risk sizing, rotation, cash at 6%, costs; pre-tax value. */
export function account(trades, stocks, days, startedAt, R = LBB) {
  const side = R.cost / 200;
  const idx = new Map([...stocks].map(([s, bars]) => [s, new Map(bars.map((b, k) => [b.date, k]))]));
  const barOn = (s, d) => { const k = idx.get(s)?.get(d); return k == null ? null : stocks.get(s)[k]; };
  const lastOnOrBefore = (s, d) => { const bars = stocks.get(s); let b = null; for (const x of bars) { if (x.date > d) break; b = x; } return b; };
  const byEntry = new Map();
  for (const t of trades.filter((x) => x.entryDate >= startedAt)) {
    if (!byEntry.has(t.entryDate)) byEntry.set(t.entryDate, []);
    byEntry.get(t.entryDate).push(t);
  }
  for (const v of byEntry.values()) v.sort((a, b) => b.rs - a.rs);
  let cash = R.capital;
  let eq = R.capital;
  let prev = null;
  let prevDay = null;
  const open = new Map(); // symbol → { t, units, cost, last }
  const closed = [];
  const curve = [];
  const sell = (s, px, d, reason) => {
    const p = open.get(s);
    const proceeds = p.units * px * (1 - side);
    cash += proceeds;
    closed.push({ symbol: s, entryDate: p.t.entryDate, entry: p.t.entry, exitDate: d, exit: px, reason, pnl: proceeds - p.cost, r: (proceeds / p.cost - 1) / p.t.riskPct });
    open.delete(s);
  };
  for (const d of days.filter((x) => x >= startedAt)) {
    if (prev) cash *= (1 + R.cashYield) ** ((Date.parse(d) - Date.parse(prev)) / 86400000 / 365);
    for (const [s, p] of [...open]) if (!p.t.open && p.t.exitDate === d) sell(s, p.t.exit, d, p.t.reason);
    for (const t of byEntry.get(d) || []) {
      if (open.has(t.symbol)) continue;
      const want = Math.min((eq * R.riskPct) / 100 / Math.max(t.riskPct, 1e-6), (eq * R.maxPct) / 100);
      if (open.size >= R.maxOpen || cash < want * 0.5) {
        let weak = null;
        let wr = Infinity;
        for (const [s, p] of open) {
          if (p.t.entryDate === d || !prevDay) continue;
          const b = barOn(s, prevDay);
          if (b?.rs != null && b.rs < wr) { wr = b.rs; weak = s; }
        }
        const wb = weak && barOn(weak, d);
        if (wb && wr <= t.rs - R.rotGap) sell(weak, wb.open, d, 'rotated');
      }
      if (open.size >= R.maxOpen) continue;
      const amt = Math.min(want, cash);
      if (amt < (eq * R.minPct) / 100) continue;
      cash -= amt;
      open.set(t.symbol, { t, units: (amt * (1 - side)) / t.entry, cost: amt, last: t.entry });
      if (!t.open && t.exitDate === d) sell(t.symbol, t.exit, d, t.reason);
    }
    eq = cash;
    for (const [s, p] of open) {
      const b = barOn(s, d) || lastOnOrBefore(s, d);
      if (b) p.last = b.close;
      eq += p.units * p.last;
    }
    curve.push({ date: d, equity: Math.round(eq) });
    prev = d;
    prevDay = d;
  }
  return { cash, equity: eq, open, closed, curve };
}

export async function lbbPaperUpdate({ now = new Date(), startedAt = null, loadCandles = candles } = {}) {
  const prevState = loadLbbPaper();
  const start = prevState?.startedAt || startedAt || new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const y = Number(start.slice(0, 4));
  const niftyRows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse(`${y - 3}-01-01`) / 1000), interval: '1d' })).filter((x) => x.close > 0);
  if (niftyRows.length < 250) throw new Error('not enough NIFTY history for the 200-day filter');
  const { trades, signals, stocks, lastDate, days, niftyUp } = buildTrades({ from: `${y - 1}-${start.slice(5, 7)}-01`, fromMonth: `${y - 3}-${start.slice(5, 7)}`, niftyRows });
  const acct = account(trades, stocks, days, start);
  let peak = LBB.capital;
  let maxDD = 0;
  for (const p of acct.curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, 1 - p.equity / peak);
  }
  const rs = acct.closed.map((t) => t.r);
  const eq = acct.equity;
  const st = {
    startedAt: start, rules: LBB, research: RESEARCH, lastDate, updatedAt: now.toISOString(), niftyAbove200: niftyUp(lastDate),
    value: Math.round(eq), cash: Math.round(acct.cash), maxDD,
    summary: { closed: acct.closed.length, won: acct.closed.filter((t) => t.pnl > 0).length, realised: Math.round(acct.closed.reduce((a, t) => a + t.pnl, 0)), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, open: acct.open.size },
    open: [...acct.open].map(([s, p]) => ({ symbol: s, entryDate: p.t.entryDate, entry: p.t.entry, shares: Math.floor(p.units), value: Math.round(p.cost), stop: p.t.stop, last: p.last, pnl: Math.round(p.units * p.last - p.cost), sellNextOpen: !!p.t.sellNextOpen, exitReason: p.t.exitReason, rs: stocks.get(s)?.at(-1)?.rs ?? null })),
    closed: acct.closed.map((t) => ({ ...t, pnl: Math.round(t.pnl) })),
    signals: signals.map((x) => ({ ...x, wantPct: Math.min(LBB.riskPct / x.riskPct, LBB.maxPct), wantValue: Math.round(Math.min((eq * LBB.riskPct) / 100 / x.riskPct, (eq * LBB.maxPct) / 100)) })).sort((a, b) => b.rs - a.rs),
    curve: acct.curve.slice(-400),
  };
  writeJsonAtomic(PAPER(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await lbbPaperUpdate();
    const rs = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
    console.log(`Leader Box Breakout paper since ${st.startedAt} (NSE data to ${st.lastDate}; NIFTY ${st.niftyAbove200 ? 'above' : 'BELOW — no new buys'} its 200-day): value ${rs(st.value)} · ${st.summary.open} open · ${st.summary.closed} closed · buy at the next open: ${st.signals.map((s) => s.symbol).join(', ') || 'none'}${st.open.filter((p) => p.sellNextOpen).length ? ` · sell at the next open: ${st.open.filter((p) => p.sellNextOpen).map((p) => p.symbol).join(', ')}` : ''}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
