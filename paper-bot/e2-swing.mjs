#!/usr/bin/env node
// Momentum breakout swing "E2" (library + CLI) — PAPER ONLY. Found by the multi-agent search (Nov 2026):
// buy, at the close, a stock's FIRST close above its highest close of the previous 252 sessions, if it is in the top
// 25% of the NSE top-200 (point in time) by 12-1 month momentum. Stop = lowest low of the previous 10 sessions − 1 ATR;
// exit = 5-ATR chandelier trail (highest high since entry − 5 ATR), sold at the next open after a close below it
// (a gap below the trail is sold at that open). ₹5,00,000 account: risk 1.25% of equity per trade (value = risk ÷ stop
// distance, ≤ 20% of equity, ≤ cash), ≤ 10 positions, highest momentum first, one position per stock — and a stock's
// new signal is ignored while its previous signal's trade would still be running (taken or not), as in the tested code.
// Results of the search (real NSE data, costs 0.35%): 2008–22 +0.29 R/trade (t 6.0); 2023–24 +0.85 R (t 5.6, 2024 flat);
// final test 2025 → Nov 2026: +0.08 R/trade (t 0.8 — FAILED the per-trade bar) but the account made ~12.6%/yr after
// tax with a 12–16% worst fall vs NIFTY 1.7%/yr. So it is tracked on paper to build a live record. Not advice.
//
//   node --max-old-space-size=12000 paper-bot/e2-swing.mjs --paper

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { loadSeries, pointInTimeUniverse } from './bhav-history.mjs';
import { indicators, RULES as ATH } from './ath-swing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const PAPER = () => process.env.E2_PAPER_PATH || join(HERE, 'data', 'e2-swing-paper.json');
export const E2 = { momTop: 0.75, pivotDays: 10, stopAtr: 1, trailAtr: 5, maxHold: 250, riskPct: 1.25, maxOpen: 10, maxPositionPct: 20, cost: 0.35, capital: 500000, cashYield: 0.065 };
export const RESEARCH = {
  dev: { period: '2008–2022', trades: 1578, avgR: 0.285, t: 6.0, afterTaxPerYear: 0.152, maxDD: 0.22 },
  val: { period: '2023–2024', trades: 263, avgR: 0.85, t: 5.6, afterTaxPerYear: 0.25, maxDD: 0.14, note: '2023 +1.51 R, 2024 ≈ 0' },
  test: { period: '2025 → Nov 2026', trades: 200, avgR: 0.082, t: 0.81, afterTaxPerYear: 0.126, maxDD: 0.12, niftyPerYear: 0.017, note: 'failed the per-trade bar (t < 1.5); without the 10 best trades it loses' },
};
export const loadE2Paper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};

/** Daily bars with ATR (the app's swing indicators), 12-1 momentum, the previous 252 sessions' highest close. */
export function prepare(rows) {
  const bars = indicators(rows, ATH);
  for (let i = 0; i < bars.length; i++) bars[i].mom = i >= 252 ? bars[i - 21].close / bars[i - 252].close - 1 : null;
  const dq = [];
  for (let i = 0; i < bars.length; i++) {
    bars[i].hi252prev = dq.length && i >= 252 ? bars[dq[0]].close : null;
    while (dq.length && bars[dq[dq.length - 1]].close <= bars[i].close) dq.pop();
    dq.push(i);
    while (dq[0] <= i - 252) dq.shift();
  }
  return bars;
}

/** The E2 signal at bar i: first close above the previous 252 sessions' highest close → { pivotLow } or null. */
export function signalAt(bars, i, R = E2) {
  const b = bars[i];
  if (!b.atr || b.hi252prev == null || i < 1) return null;
  if (!(b.close > b.hi252prev && bars[i - 1].close <= (bars[i - 1].hi252prev ?? Infinity))) return null;
  let lo = i;
  for (let k = i - R.pivotDays; k < i; k++) if (k >= 0 && bars[k].low < bars[lo].low) lo = k;
  return { pivotLow: bars[lo].low };
}

/** Walk a long trade from the entry bar: initial stop, then the trail; fills at opens. Open at the data end → state. */
export function walk(bars, ei, R = E2) {
  const entry = bars[ei].close;
  const stop0 = bars[ei].stop0;
  let trail = stop0;
  let hh = bars[ei].close;
  for (let k = ei + 1; k < bars.length; k++) {
    const c = bars[k];
    if (c.open <= trail) return { exit: c.open, xi: k, reason: trail === stop0 ? 'stop (gap)' : 'trail (gap)' };
    if (c.low <= stop0 && trail === stop0) return { exit: Math.min(stop0, c.open), xi: k, reason: 'stop' };
    hh = Math.max(hh, c.high);
    if (c.atr) trail = Math.max(trail, hh - R.trailAtr * c.atr);
    const why = c.close < trail ? 'trail' : k - ei >= R.maxHold ? 'max hold' : null;
    if (why) {
      if (k + 1 < bars.length) return { exit: bars[k + 1].open, xi: k + 1, reason: why };
      return { open: true, sellNextOpen: true, trail, last: c.close, xi: k, entry };
    }
  }
  const k = bars.length - 1;
  return { open: true, sellNextOpen: false, trail, last: bars[k].close, xi: k, entry };
}

/** Every stock's E2 trades from `from` on (one at a time per stock — the tested non-overlap rule). */
export function tradesFor(sym, bars, universe, from, R = E2) {
  const out = [];
  const first = bars[0]?.date;
  for (let i = 30; i < bars.length; i++) {
    const b = bars[i];
    if (b.date < from) continue;
    if (!universe.get(b.date.slice(0, 7))?.has(sym)) continue;
    if (Date.parse(b.date) - Date.parse(first) < 365 * 86400000) continue;
    if (!((b.momPct ?? -1) >= R.momTop)) continue;
    const sig = signalAt(bars, i, R);
    if (!sig) continue;
    const stop0 = sig.pivotLow - R.stopAtr * b.atr;
    if (!(b.close > stop0)) continue;
    b.stop0 = stop0;
    const w = walk(bars, i, R);
    out.push({ symbol: sym, signalDate: b.date, entryDate: b.date, entry: b.close, stop: stop0, riskPct: (b.close - stop0) / b.close, mom: b.mom, momPct: b.momPct,
      ...(w.open ? { open: true, sellNextOpen: w.sellNextOpen, trail: w.trail, last: w.last, lastDate: bars[w.xi].date } : { open: false, exit: w.exit, exitDate: bars[w.xi].date, reason: w.reason }) });
    if (w.open) break;
    i = w.xi;
  }
  return out;
}

/** Load NSE history (from `fromMonth`) and every stock's E2 trades from `from`. */
export function buildTrades({ from, fromMonth, to = null } = {}) {
  const months = readdirSync(BHAV()).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, 7)).filter((m) => m >= fromMonth && (!to || m <= to.slice(0, 7)));
  const raw = loadSeries({ months });
  const series = new Map();
  for (const [s, rows] of raw) {
    const r = rows.filter((x) => (!to || x.date <= to) && x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0);
    if (r.length > 300) series.set(s, r);
  }
  const universe = pointInTimeUniverse(series);
  const stocks = new Map([...series].map(([s, rows]) => [s, prepare(rows)]));
  // momentum percentile among that month's universe, each day
  const byDate = new Map();
  for (const [s, bars] of stocks) for (const b of bars) {
    if (b.mom == null || !universe.get(b.date.slice(0, 7))?.has(s)) continue;
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  for (const bs of byDate.values()) {
    bs.sort((a, b) => a.mom - b.mom);
    bs.forEach((b, k) => { b.momPct = bs.length > 1 ? k / (bs.length - 1) : null; });
  }
  const trades = [...stocks].flatMap(([s, bars]) => tradesFor(s, bars, universe, from));
  const lastDate = [...byDate.keys()].sort().at(-1);
  return { trades, stocks, lastDate, days: [...byDate.keys()].sort() };
}

/** The paper account from `startedAt`: which trades it took (slots, sizing), cash, positions, equity curve. */
export function account(trades, stocks, days, startedAt, R = E2) {
  const byEntry = new Map();
  for (const t of trades.filter((x) => x.entryDate >= startedAt)) {
    if (!byEntry.has(t.entryDate)) byEntry.set(t.entryDate, []);
    byEntry.get(t.entryDate).push(t);
  }
  for (const v of byEntry.values()) v.sort((a, b) => b.mom - a.mom);
  const px = (s, d) => {
    const bars = stocks.get(s);
    const b = bars?.find((x) => x.date === d);
    return b ? b.close : null;
  };
  let cash = R.capital;
  let eq = R.capital;
  let prev = null;
  let open = [];
  const closed = [];
  const curve = [];
  for (const d of days.filter((x) => x >= startedAt)) {
    if (prev) cash *= (1 + R.cashYield) ** ((Date.parse(d) - Date.parse(prev)) / 86400000 / 365);
    const keep = [];
    for (const p of open) {
      if (!p.t.open && p.t.exitDate === d) {
        const ret = p.t.exit / p.t.entry - 1 - R.cost / 100;
        cash += p.value * (1 + ret);
        closed.push({ ...p.t, value: p.value, pnl: p.value * ret, r: ret / p.t.riskPct });
      } else keep.push(p);
    }
    open = keep;
    for (const t of byEntry.get(d) || []) {
      if (open.length >= R.maxOpen) break;
      if (open.some((p) => p.t.symbol === t.symbol)) continue;
      const value = Math.min((eq * R.riskPct) / 100 / t.riskPct, (eq * R.maxPositionPct) / 100, cash);
      if (value < eq * 0.01) continue;
      cash -= value;
      open.push({ t, value, last: t.entry });
    }
    eq = cash;
    for (const p of open) {
      const c = px(p.t.symbol, d);
      if (c) p.last = c;
      eq += p.value * (p.last / p.t.entry);
    }
    curve.push({ date: d, equity: Math.round(eq) });
    prev = d;
  }
  return { cash, equity: eq, open, closed, curve };
}

export function e2PaperUpdate({ now = new Date(), startedAt = null } = {}) {
  const prevState = loadE2Paper();
  const start = prevState?.startedAt || startedAt || new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  // history: momentum needs 252 sessions, the non-overlap rule needs signals from about a year before the start
  const y = Number(start.slice(0, 4));
  const { trades, stocks, lastDate, days } = buildTrades({ from: `${y - 1}-${start.slice(5, 7)}-01`, fromMonth: `${y - 3}-${start.slice(5, 7)}` });
  const acct = account(trades, stocks, days, start);
  const shares = (p) => Math.floor(p.value / p.t.entry);
  const today = trades.filter((t) => t.signalDate === lastDate);
  let peak = E2.capital;
  let maxDD = 0;
  for (const p of acct.curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, 1 - p.equity / peak);
  }
  const rs = acct.closed.map((t) => t.r);
  const st = {
    startedAt: start, rules: E2, research: RESEARCH, lastDate, updatedAt: now.toISOString(),
    value: Math.round(acct.equity), cash: Math.round(acct.cash), maxDD,
    summary: { closed: acct.closed.length, won: acct.closed.filter((t) => t.pnl > 0).length, realised: Math.round(acct.closed.reduce((a, t) => a + t.pnl, 0)), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, open: acct.open.length },
    open: acct.open.map((p) => ({ symbol: p.t.symbol, entryDate: p.t.entryDate, entry: p.t.entry, shares: shares(p), value: Math.round(p.value), stop: p.t.stop, trail: p.t.trail ?? p.t.stop, last: p.last, pnl: Math.round(p.value * (p.last / p.t.entry - 1)), sellNextOpen: !!p.t.sellNextOpen, momPct: p.t.momPct })),
    closed: acct.closed.map((t) => ({ symbol: t.symbol, entryDate: t.entryDate, entry: t.entry, exitDate: t.exitDate, exit: t.exit, reason: t.reason, pnl: Math.round(t.pnl), r: t.r })),
    signals: today.map((t) => ({ symbol: t.symbol, close: t.entry, stop: t.stop, riskPct: t.riskPct, momPct: t.momPct, taken: acct.open.some((p) => p.t.symbol === t.symbol && p.t.entryDate === lastDate) })).sort((a, b) => b.momPct - a.momPct),
    curve: acct.curve.slice(-400),
  };
  writeJsonAtomic(PAPER(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = e2PaperUpdate();
    const rs = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
    console.log(`Momentum breakout (E2) paper since ${st.startedAt} (NSE data to ${st.lastDate}): value ${rs(st.value)} · ${st.summary.open} open · ${st.summary.closed} closed · signals today: ${st.signals.map((s) => s.symbol).join(', ') || 'none'}${st.open.filter((p) => p.sellNextOpen).length ? ` · sell at the next open: ${st.open.filter((p) => p.sellNextOpen).map((p) => p.symbol).join(', ')}` : ''}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
