#!/usr/bin/env node
// "1:15 PM reversal" (YouTube, Rajesh Jain / Upsurge Club, _ux9Lre4voo) — library + CLI: the video's rules, a 5-year
// backtest on Groww 5-minute bars with controls, and a forward paper record. Paper / research only — not advice.
//
// PRE-REGISTERED (paper-bot/one-fifteen.md, written before any result):
//   Move        price at 13:15 (13:10 bar close) vs the previous session's last close; |move| ≥ 3% (main) / ≥ 5% (variant);
//               |move| > 20% skipped (split / bonus in unadjusted data)
//   Level       the 13:15–13:45 30-minute candle (5-minute bars 13:15…13:40): high H, low L
//   Reversal    up-move → SHORT below L, stop H · down-move → LONG above H, stop L (a break the other way is ignored)
//   Entry       first 5-minute bar from 13:45 trading through the level; fill at the level, or the bar open if it gaps
//               through, + slippage. Skip if risk < 0.3% or > 3% of price (index 0.1%–3%). Target 1R.
//   Versions    V video: target same day, else carry overnight (F&O stocks via futures; others out 15:15), next day
//                 target / stop / 15:15; untriggered levels valid next session until 15:15 (intraday that day)
//               S same-day only: entries 13:45–15:10, out at 15:15, no carry, no next-day levels
//               I NIFTY (index futures proxy): rules of V, |move| ≥ 1% (main) / ≥ 3%; BANKNIFTY not in the data
//   Account     ₹1,000 risk a trade (≤ ₹1 lakh × 5), max 2 new trades a day, 1 per stock a day, none while one is open
//   Costs       same-day: intraday equity charges + 0.03%/fill · carried: stock-futures charges + 0.03%/fill ·
//               NIFTY: futures charges + 0.01%/fill. Options untestable (no per-stock intraday option prices).
//   Periods     build 2020–22 · check 2023–24 · test 2025 → latest
//   Controls    trend continuation (trade the break with the move) · fade at 13:45 without the level · random side at 13:45
//
//   node paper-bot/one-fifteen.mjs --backtest   # 5-year test → data/one-fifteen.json
//   node paper-bot/one-fifteen.mjs --paper      # evening: forward paper record → data/one-fifteen-paper.json

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orderCharges, futuresCharges } from './costs.mjs';
import { writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.ONE_FIFTEEN_PATH || join(HERE, 'data', 'one-fifteen.json');
const PAPER = () => process.env.ONE_FIFTEEN_PAPER_PATH || join(HERE, 'data', 'one-fifteen-paper.json');
const FO_DIR = () => process.env.FO_STOCKS_DIR || join(HERE, 'data', 'fo-stocks');

export const RULES = {
  moveMin: 3, moveMax: 20, riskMinPct: 0.3, riskMaxPct: 3, rr: 1,
  candleFrom: '13:15', candleTo: '13:45', priceAt: '13:10', firstEntry: '13:45', lastEntry: '15:15', exitAt: '15:15',
  riskRs: 1000, capital: 100000, leverage: 5, slippagePct: 0.03, maxPerDay: 2,
  entryBar: 'stop', // pre-registered: the entry bar checks the stop. 'colour' (sensitivity, added after the first run): bar colour decides the order
};
export const INDEX_RULES = { ...RULES, moveMin: 1, riskMinPct: 0.1, slippagePct: 0.01 };
export const VERSIONS = {
  V: { label: 'Video: 1:1 target, carry overnight, level valid next day', carry: true, nextDay: true },
  S: { label: 'Same-day only: out at 15:15', carry: false, nextDay: false },
};
export const PERIODS = { build: ['2020-01-01', '2022-12-31'], check: ['2023-01-01', '2024-12-31'], test: ['2025-01-01', '2099-12-31'] };
const INTRA = { brokerageDeliveryPct: 0, brokerageDeliveryCap: 0, brokerageIntradayPct: 0.03, brokerageIntradayCap: 20, dpChargePerSell: 0, slippagePct: 0 };

const hhmm = (r) => String(r.date).slice(11, 16);
const dayOf = (r) => String(r.date).slice(0, 10);

/** Today's NSE F&O stock list (latest data/fo-stocks file) as Yahoo-style symbols. */
export function foSet(dir = FO_DIR()) {
  try {
    const f = readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop();
    return new Set(Object.keys(JSON.parse(readFileSync(join(dir, f), 'utf8'))).map((s) => `${s}.NS`));
  } catch {
    return new Set();
  }
}

/** Bars → sessions [{ date, bars }] (09:15–15:25 only, oldest first). */
export function sessionsOf(rows) {
  const m = new Map();
  for (const b of rows) {
    const t = hhmm(b);
    if (!(b.close > 0) || t < '09:15' || t > '15:25') continue;
    const d = dayOf(b);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(b);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bars]) => ({ date, bars: bars.sort((a, b) => String(a.date).localeCompare(String(b.date))) }));
}

/** The day's 1:15 setup: move at 13:15, the 13:15–13:45 candle, and the reversal side. null if not qualifying. */
export function setupFor(prevClose, bars, rules = RULES) {
  if (!(prevClose > 0)) return null;
  const at = bars.find((b) => hhmm(b) === rules.priceAt);
  const candle = bars.filter((b) => hhmm(b) >= rules.candleFrom && hhmm(b) < rules.candleTo);
  if (!at || candle.length < 6 || !bars.some((b) => hhmm(b) === rules.firstEntry)) return null;
  const move = (at.close / prevClose - 1) * 100;
  if (Math.abs(move) < rules.moveMin || Math.abs(move) > rules.moveMax) return null;
  const H = Math.max(...candle.map((b) => b.high));
  const L = Math.min(...candle.map((b) => b.low));
  if (!(H > L)) return null;
  return { move, H, L, trend: move > 0 ? 'up' : 'down' };
}

/** Side, level and stop of a setup for a mode: reversal (video) or continuation (control). */
export function plan(setup, mode = 'reversal') {
  const up = setup.trend === 'up';
  const fade = mode !== 'continuation';
  const side = up === fade ? 'short' : 'long';
  return side === 'short' ? { side, level: setup.L, stop: setup.H } : { side, level: setup.H, stop: setup.L };
}

/** First bar index ≥ from (time < until) that trades through the level; fill at the level or a worse open. */
export function findTrigger(bars, from, { side, level }, until = RULES.lastEntry) {
  for (let k = from; k < bars.length; k++) {
    const b = bars[k];
    if (hhmm(b) >= until) return null;
    if (side === 'short' ? b.low < level : b.high > level) return { k, raw: side === 'short' ? Math.min(level, b.open) : Math.max(level, b.open) };
  }
  return null;
}

/** Charges for one round trip (₹): intraday equity, or futures (carried / index). */
export function roundTrip({ entry, exit, qty, side, product, date }) {
  const buy = (side === 'long' ? entry : exit) * qty;
  const sell = (side === 'long' ? exit : entry) * qty;
  if (product === 'futures') return futuresCharges({ side: 'buy', value: buy, date }).total + futuresCharges({ side: 'sell', value: sell, date }).total;
  return orderCharges({ side: 'buy', value: buy, product: 'intraday', costs: INTRA }).total + orderCharges({ side: 'sell', value: sell, product: 'intraday', costs: INTRA }).total;
}

/**
 * Walk a trade from bar k of session di. Entry bar: stop only. Stop before target inside a bar; a bar opening beyond
 * the stop / target fills at its open. carry=false → out at the 15:15 bar's open. carry=true → held to the close, then
 * next session to target / stop / 15:15. Returns null when the data ends with the trade still open (open: true info).
 */
export function walk({ sessions, di, k, side, entry, stop, target, carry, rules = RULES, gapFill = true }) {
  const hitStop = (c) => (side === 'short' ? c.high >= stop : c.low <= stop);
  const hitTgt = (c) => (side === 'short' ? c.low <= target : c.high >= target);
  const stopFill = (c) => (side === 'short' ? Math.max(stop, c.open) : Math.min(stop, c.open));
  const tgtFill = (c) => (side === 'short' ? Math.min(target, c.open) : Math.max(target, c.open));
  const day1 = sessions[di].bars;
  for (let j = k; j < day1.length; j++) {
    const c = day1[j];
    if (!carry && j > k && hhmm(c) >= rules.exitAt) return { exit: c.open, reason: '15:15', exitDate: sessions[di].date, exitTime: hhmm(c), carried: false };
    if (j > k && (side === 'short' ? c.open >= stop : c.open <= stop)) return { exit: c.open, reason: 'stop', exitDate: sessions[di].date, exitTime: hhmm(c), carried: false };
    // entry bar filled at the level: 'colour' assumes O→L→H→C for a green bar and O→H→L→C for a red one, so a short
    // filled at L on a red bar (high came first) / a long filled at H on a green bar (low came first) is not stopped there
    const skipEntryStop = j === k && !gapFill && rules.entryBar === 'colour' && (side === 'short' ? c.close < c.open : c.close >= c.open);
    if (!skipEntryStop && hitStop(c)) return { exit: stopFill(c), reason: 'stop', exitDate: sessions[di].date, exitTime: hhmm(c), carried: false, entryBarStop: j === k };
    if (j > k && hitTgt(c)) return { exit: tgtFill(c), reason: 'target', exitDate: sessions[di].date, exitTime: hhmm(c), carried: false };
  }
  const last = day1[day1.length - 1];
  if (!carry) return { exit: last.close, reason: '15:15', exitDate: sessions[di].date, exitTime: hhmm(last), carried: false };
  const nx = sessions[di + 1];
  if (!nx) return { open: true, mark: last.close, markDate: sessions[di].date };
  if (Math.abs(nx.bars[0].open / last.close - 1) > 0.2) return { corpAction: true }; // split / bonus overnight
  for (const c of nx.bars) {
    if (hhmm(c) >= rules.exitAt) return { exit: c.open, reason: '15:15', exitDate: nx.date, exitTime: hhmm(c), carried: true };
    if (hitStop(c)) return { exit: stopFill(c), reason: 'stop', exitDate: nx.date, exitTime: hhmm(c), carried: true };
    if (hitTgt(c)) return { exit: tgtFill(c), reason: 'target', exitDate: nx.date, exitTime: hhmm(c), carried: true };
  }
  const l2 = nx.bars[nx.bars.length - 1];
  return { exit: l2.close, reason: '15:15', exitDate: nx.date, exitTime: hhmm(l2), carried: true };
}

// deterministic coin flip per (symbol, date) for the random control
const coin = (s) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 === 0;
};

/**
 * All trades for one symbol. opts: version 'V' | 'S'; mode 'reversal' | 'continuation' | 'fade' | 'random';
 * fno (stock futures available → V may carry); index (NIFTY: futures charges, always carry in V).
 * Trades still open at the end of the data come back with open: true (no result).
 */
export function simulate(symbol, rows, { version = 'V', mode = 'reversal', fno = true, index = false, rules = index ? INDEX_RULES : RULES } = {}) {
  const ver = VERSIONS[version];
  const sessions = Array.isArray(rows) && rows[0]?.bars ? rows : sessionsOf(rows);
  const trades = [];
  const canCarry = ver.carry && (index || fno);
  const slip = rules.slippagePct / 100;
  let pending = null; // untriggered level from the previous session (V)
  let busyUntil = ''; // 'YYYY-MM-DD HH:MM' — no new trade before the open one exits
  for (let di = 1; di < sessions.length; di++) {
    const { date, bars } = sessions[di];
    const prev = sessions[di - 1];
    const prevClose = prev.bars[prev.bars.length - 1].close;
    if (Math.abs(bars[0].open / prevClose - 1) > 0.2) { // corporate action between sessions: drop the old level
      pending = null;
      continue;
    }
    const setup = setupFor(prevClose, bars, rules);
    const start = (from) => {
      for (let k = from; k < bars.length; k++) if (`${date} ${hhmm(bars[k])}` > busyUntil) return k;
      return bars.length;
    };
    const cands = [];
    if (pending) {
      const k0 = start(0);
      const tr = findTrigger(bars, k0, pending, rules.lastEntry);
      if (tr) cands.push({ ...pending, ...tr, carry: false, fromPrev: true });
    }
    let todays = null;
    if (setup) {
      const k45 = bars.findIndex((b) => hhmm(b) === rules.firstEntry);
      const k0 = start(k45);
      if (mode === 'fade' || mode === 'random') {
        let side = plan(setup, 'reversal').side;
        if (mode === 'random') side = coin(`${symbol}|${date}`) ? 'long' : 'short';
        if (k0 === k45) {
          const range = setup.H - setup.L;
          const raw = bars[k45].open;
          cands.push({ side, level: raw, stop: side === 'long' ? raw - range : raw + range, k: k45, raw, move: setup.move, H: setup.H, L: setup.L, carry: canCarry, fromPrev: false, setupDate: date });
        }
      } else {
        todays = { ...plan(setup, mode), move: setup.move, H: setup.H, L: setup.L, setupDate: date };
        const tr = findTrigger(bars, k0, todays, rules.lastEntry);
        if (tr) cands.push({ ...todays, ...tr, carry: canCarry, fromPrev: false });
      }
    }
    pending = null;
    cands.sort((a, b) => a.k - b.k);
    // today's level not triggered today stays valid next session (V only)
    if (todays && ver.nextDay && !cands.some((x) => !x.fromPrev)) pending = todays;
    // the first trigger that passes the risk filter is the day's one trade in this stock (a skipped trigger uses up its level)
    let c = null;
    let entry;
    let risk;
    for (const x of cands) {
      const e = x.side === 'long' ? x.raw * (1 + slip) : x.raw * (1 - slip);
      const r = Math.abs(e - x.stop);
      if ((x.side === 'long' ? x.stop >= e : x.stop <= e) || (r / e) * 100 < rules.riskMinPct || (r / e) * 100 > rules.riskMaxPct) continue;
      c = x;
      entry = e;
      risk = r;
      break;
    }
    if (!c) continue;
    const target = c.side === 'long' ? entry + rules.rr * risk : entry - rules.rr * risk;
    const qty = Math.max(1, Math.floor(Math.min(rules.riskRs / risk, (rules.capital * rules.leverage) / entry)));
    const w = walk({ sessions, di, k: c.k, side: c.side, entry, stop: c.stop, target, carry: c.carry, rules, gapFill: c.raw !== c.level });
    const base = { symbol, date, time: hhmm(bars[c.k]), side: c.side, move: c.move, H: c.H, L: c.L, setupDate: c.setupDate, fromPrev: c.fromPrev, entry, stop: c.stop, target, qty, riskPct: (risk / entry) * 100 };
    if (w.corpAction) continue;
    if (w.open) {
      trades.push({ ...base, open: true, mark: w.mark, markDate: w.markDate, product: 'futures' });
      busyUntil = '9999';
      continue;
    }
    const exit = c.side === 'long' ? w.exit * (1 - slip) : w.exit * (1 + slip);
    const product = index || w.carried ? 'futures' : 'intraday';
    const gross = (c.side === 'long' ? exit - entry : entry - exit) * qty;
    const charges = roundTrip({ entry, exit, qty, side: c.side, product, date: w.exitDate });
    const grossNoSlip = (c.side === 'long' ? w.exit - c.raw : c.raw - w.exit) * qty;
    trades.push({ ...base, exit, exitDate: w.exitDate, exitTime: w.exitTime, reason: w.reason, carried: w.carried, entryBarStop: !!w.entryBarStop, product, gross, charges, net: gross - charges, rGross: grossNoSlip / (risk * qty), rNet: (gross - charges) / (risk * qty) });
    busyUntil = `${w.exitDate} ${w.exitTime}`;
  }
  return trades;
}

/** Account: at most maxPerDay new trades a day (earliest entry first, ties → bigger |move|). Open trades pass through. */
export function accountTrades(trades, maxPerDay = RULES.maxPerDay) {
  const byDay = new Map();
  for (const t of [...trades].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || Math.abs(b.move) - Math.abs(a.move))) {
    const list = byDay.get(t.date) || [];
    if (list.length < maxPerDay) list.push(t);
    byDay.set(t.date, list);
  }
  return [...byDay.values()].flat();
}

/** Trades, win rate, avg R before / after costs, ₹ total, day-clustered t, without the best 10, exits. */
export function stats(trades) {
  const done = trades.filter((t) => !t.open);
  const n = done.length;
  if (!n) return { trades: 0 };
  const sum = (f) => done.reduce((a, t) => a + f(t), 0);
  const per = new Map();
  for (const t of done) per.set(t.date, (per.get(t.date) || 0) + t.net);
  const d = [...per.values()];
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = d.length > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1)) : 0;
  const sorted = [...done].sort((a, b) => b.net - a.net);
  const rest = sorted.slice(10);
  return {
    trades: n, days: d.length,
    winRate: done.filter((t) => t.net > 0).length / n,
    avgRGross: sum((t) => t.rGross) / n, avgRNet: sum((t) => t.rNet) / n,
    avgChargesRs: sum((t) => t.charges) / n, totalNetRs: sum((t) => t.net),
    tDay: sd > 0 ? m / (sd / Math.sqrt(d.length)) : null,
    exBest10Rs: rest.reduce((a, t) => a + t.net, 0), exBest10R: rest.length ? rest.reduce((a, t) => a + t.rNet, 0) / rest.length : null,
    exits: { target: done.filter((t) => t.reason === 'target').length, stop: done.filter((t) => t.reason === 'stop').length, '15:15': done.filter((t) => t.reason === '15:15').length, carried: done.filter((t) => t.carried).length, nextDayLevel: done.filter((t) => t.fromPrev).length },
  };
}

const inP = (t, [a, b]) => t.date >= a && t.date <= b;
/** Stats for every period, by year, long / short. */
export function report(trades) {
  const years = [...new Set(trades.map((t) => t.date.slice(0, 4)))].sort();
  return {
    all: stats(trades),
    ...Object.fromEntries(Object.entries(PERIODS).map(([k, p]) => [k, stats(trades.filter((t) => inP(t, p)))])),
    checkTest: stats(trades.filter((t) => t.date >= PERIODS.check[0])),
    byYear: Object.fromEntries(years.map((y) => [y, stats(trades.filter((t) => t.date.startsWith(y)))])),
    long: Object.fromEntries(['all', ...Object.keys(PERIODS)].map((k) => [k, stats(trades.filter((t) => t.side === 'long' && (k === 'all' || inP(t, PERIODS[k]))))])),
    short: Object.fromEntries(['all', ...Object.keys(PERIODS)].map((k) => [k, stats(trades.filter((t) => t.side === 'short' && (k === 'all' || inP(t, PERIODS[k]))))])),
  };
}

/** The pre-registered pass rule (one-fifteen.md). */
export function passRule(main, fade) {
  const ps = Object.keys(PERIODS);
  const c = {
    positiveEachPeriod: ps.every((p) => main[p]?.avgRNet > 0),
    tCheckTest: main.checkTest?.tDay >= 2,
    exBest10: main.all?.exBest10Rs > 0,
    beatsFade: ps.filter((p) => main[p]?.avgRNet > (fade?.[p]?.avgRNet ?? Infinity)).length >= 2,
  };
  return { ...c, pass: Object.values(c).every(Boolean) };
}

/** Long 5-minute history: Groww store, extended with the live store for later days. */
export async function longRows(symbol) {
  const { readHist } = await import('./groww-history.mjs');
  const { readStore } = await import('./collector.mjs');
  const h = readHist(symbol);
  const last = h.length ? dayOf(h[h.length - 1]) : '';
  return [...h, ...readStore(symbol, '5m').filter((b) => dayOf(b) > last && b.close > 0 && b.high > 0)];
}

export async function backtest({ symbols, load = longRows, fo = foSet(), onProgress = () => {} } = {}) {
  if (!symbols) symbols = (await import('./groww-history.mjs')).histSymbols().filter((s) => s.endsWith('.NS'));
  const keys = [];
  for (const v of ['V', 'S']) for (const th of [3, 5]) for (const mode of ['reversal', 'continuation', 'fade', 'random']) keys.push({ id: `${v}|${th}|${mode}`, v, th, mode });
  const raw = Object.fromEntries(keys.map((x) => [x.id, []]));
  let first = null;
  let last = null;
  let sessionsN = 0;
  for (const [i, s] of symbols.entries()) {
    const ses = sessionsOf(await load(s));
    if (ses.length < 2) continue;
    first = !first || ses[0].date < first ? ses[0].date : first;
    last = !last || ses.at(-1).date > last ? ses.at(-1).date : last;
    sessionsN = Math.max(sessionsN, ses.length);
    for (const k of keys) raw[k.id].push(...simulate(s, ses, { version: k.v, mode: k.mode, fno: fo.has(s), rules: { ...RULES, moveMin: k.th } }).filter((t) => !t.open));
    onProgress({ i: i + 1, of: symbols.length, s });
  }
  const strip = (t) => ({ symbol: t.symbol, date: t.date, time: t.time, side: t.side, move: +t.move.toFixed(2), entry: +t.entry.toFixed(2), exit: +t.exit.toFixed(2), exitDate: t.exitDate, reason: t.reason, carried: t.carried, fromPrev: t.fromPrev, rNet: +t.rNet.toFixed(3), net: Math.round(t.net) });
  const results = {};
  for (const k of keys) {
    const acct = accountTrades(raw[k.id]);
    results[k.id] = { version: k.v, threshold: k.th, mode: k.mode, account: report(acct), everySignal: k.mode === 'reversal' ? report(raw[k.id]) : undefined };
    if (k.mode === 'reversal' && k.th === 3) results[k.id].best = [...acct].sort((a, b) => b.net - a.net).slice(0, 10).map(strip);
  }
  // sensitivity (added after the first run, NOT part of the pass rule): the entry-bar order from the candle colour
  const sens = { V: [], S: [] };
  for (const s of symbols) {
    const ses = sessionsOf(await load(s));
    if (ses.length < 2) continue;
    for (const v of ['V', 'S']) sens[v].push(...simulate(s, ses, { version: v, fno: fo.has(s), rules: { ...RULES, entryBar: 'colour' } }).filter((t) => !t.open));
  }
  const sensitivity = Object.fromEntries(Object.entries(sens).map(([v, tr]) => [`${v}|3|reversal|colour`, { version: v, threshold: 3, mode: 'reversal', entryBar: 'colour', account: report(accountTrades(tr)), everySignal: report(tr) }]));
  // what drives the video version: next-session levels vs same-day setups, and entry-bar stops
  const vAcct = accountTrades(raw['V|3|reversal']);
  const parts = {
    sameDaySetups: stats(vAcct.filter((t) => !t.fromPrev)), nextDayLevels: stats(vAcct.filter((t) => t.fromPrev)),
    nextDayAt0915: stats(vAcct.filter((t) => t.fromPrev && t.time === '09:15')), carried: stats(vAcct.filter((t) => t.carried)),
    entryBarStops: stats(vAcct.filter((t) => t.entryBarStop)), notEntryBarStop: stats(vAcct.filter((t) => !t.entryBarStop)),
  };
  // NIFTY (index futures proxy): rules of V
  const nifty = sessionsOf(await load('^NSEI'));
  const index = {};
  for (const th of [1, 3]) for (const mode of ['reversal', 'continuation', 'fade']) {
    const tr = simulate('^NSEI', nifty, { version: 'V', mode, index: true, rules: { ...INDEX_RULES, moveMin: th } }).filter((t) => !t.open);
    index[`${th}|${mode}`] = { threshold: th, mode, ...report(tr), trades: tr.map(strip) };
  }
  const verdicts = Object.fromEntries(['V', 'S'].map((v) => [v, passRule(results[`${v}|3|reversal`].account, results[`${v}|3|fade`].account)]));
  const out = {
    at: new Date().toISOString(), from: first, to: last, sessions: sessionsN, stocks: symbols.length, fnoStocks: symbols.filter((s) => fo.has(s)).length,
    rules: RULES, indexRules: INDEX_RULES, periods: PERIODS, versions: VERSIONS, results, sensitivity, parts, index, verdicts,
    verdict: plainVerdict(results, verdicts, index),
    note: 'Groww 5-minute bars (unadjusted; split days skipped), today\'s stock lists (stocks that left are missing — slightly flattering). Fills at the level or a worse gap open + slippage; stop first when stop and target share a bar; entry bar checks the stop only. Carried trades priced on the cash bars as a futures proxy (no basis / roll / lot size). Options untestable: no per-stock intraday option prices — the underlying\'s R is the proxy, and an option would add decay and wider spreads. BANKNIFTY has no 5-minute history in the store. Paper / research only — not advice.',
  };
  writeJsonAtomic(SAVED(), out);
  return out;
}

const fr = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`);
export function plainVerdict(results, verdicts, index) {
  const v = results['V|3|reversal'].account;
  const s = results['S|3|reversal'].account;
  const any = verdicts.V.pass || verdicts.S.pass;
  const head = any ? 'Passed the pre-registered test — still paper only until the forward record agrees.' : 'Does not work after costs (failed the pre-registered test).';
  return `${head} Video version: ${fr(v.build.avgRNet)} / ${fr(v.check.avgRNet)} / ${fr(v.test.avgRNet)} per trade after costs in 2020–22 / 2023–24 / 2025→ (before costs ${fr(v.all.avgRGross)}). Same-day version: ${fr(s.build.avgRNet)} / ${fr(s.check.avgRNet)} / ${fr(s.test.avgRNet)}. NIFTY (≥ 1%): ${index['1|reversal'].all.trades || 0} trades, ${fr(index['1|reversal'].all.avgRNet)}.`;
}

export function loadOneFifteen() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------- forward paper record ---

export const PAPER_VERSIONS = { V: VERSIONS.V.label, S: VERSIONS.S.label };
const istNow = (d = new Date()) => {
  const t = new Date(d.getTime() + 19800_000);
  return { date: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
};
export function loadPaper() {
  try {
    return existsSync(PAPER()) ? JSON.parse(readFileSync(PAPER(), 'utf8')) : null;
  } catch {
    return null;
  }
}
const keyOf = (t) => `${t.version}|${t.symbol}|${t.date}|${t.side}`;

/**
 * Evening: replay the rules on the live 5-minute store (the collector's, same source as the VWAP paper record) for the
 * sessions since the paper start; closed trades are recorded once and never changed; open (carried) trades and the
 * levels valid next session are refreshed. Today counts only after 15:35 IST.
 */
export async function paperUpdate({ now = new Date(), symbols = null, load = null, fo = foSet() } = {}) {
  const { readStore } = await import('./collector.mjs');
  const get = load || (async (s) => readStore(s, '5m'));
  if (!symbols) {
    const { defaultSymbols } = await import('./groww-history.mjs');
    symbols = defaultSymbols();
  }
  const t = istNow(now);
  const lastComplete = t.mins >= 15 * 60 + 35 ? t.date : null;
  const st = loadPaper() || { startedAt: t.date, trades: [] };
  const done = new Map(st.trades.filter((x) => !x.open).map((x) => [keyOf(x), x]));
  const open = [];
  const levels = [];
  const setups = [];
  let latest = null;
  for (const s of symbols) {
    const index = s === '^NSEI';
    const rows = (await get(s)).filter((b) => b.close > 0 && b.high > 0 && (dayOf(b) < t.date || dayOf(b) === lastComplete));
    const ses = sessionsOf(rows);
    if (ses.length < 2) continue;
    latest = !latest || ses.at(-1).date > latest ? ses.at(-1).date : latest;
    const rules = index ? INDEX_RULES : RULES;
    for (const v of Object.keys(PAPER_VERSIONS)) {
      if (index && v === 'S') continue;
      for (const tr of simulate(s, ses, { version: v, index, fno: fo.has(s), rules })) {
        if (tr.date < st.startedAt) continue;
        const x = { ...tr, version: v };
        if (tr.open) open.push(x);
        else if (!done.has(keyOf(x))) done.set(keyOf(x), x);
      }
    }
    // the latest session's setups, and the levels still valid next session (V: not triggered today)
    const lastS = ses.at(-1);
    const prevS = ses.at(-2);
    const su = setupFor(prevS.bars.at(-1).close, lastS.bars, rules);
    if (su) {
      const p = plan(su);
      const k45 = lastS.bars.findIndex((b) => hhmm(b) === rules.firstEntry);
      const trig = findTrigger(lastS.bars, k45, p, rules.lastEntry);
      const row = { symbol: s, date: lastS.date, move: su.move, H: su.H, L: su.L, side: p.side, level: p.level, stop: p.stop, triggered: trig ? hhmm(lastS.bars[trig.k]) : null, fno: index || fo.has(s) };
      setups.push(row);
      if (!trig) levels.push(row);
    }
  }
  // account limit per version (closed + open), as in the backtest
  const all = [...done.values(), ...open];
  const kept = [];
  for (const v of Object.keys(PAPER_VERSIONS)) kept.push(...accountTrades(all.filter((x) => x.version === v && x.symbol !== '^NSEI')));
  kept.push(...all.filter((x) => x.symbol === '^NSEI'));
  const keepKeys = new Set(kept.map(keyOf));
  const recorded = new Set(st.trades.filter((x) => !x.open).map(keyOf));
  st.trades = all.filter((x) => recorded.has(keyOf(x)) || keepKeys.has(keyOf(x))).map((x) => ({ ...x, rNet: x.rNet ?? null })).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  st.setups = { date: latest, list: setups.sort((a, b) => Math.abs(b.move) - Math.abs(a.move)) };
  st.levels = { validOn: 'next session until 15:15', from: latest, list: levels.sort((a, b) => Math.abs(b.move) - Math.abs(a.move)) };
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return paperSummary(st);
}

export function paperSummary(st = loadPaper()) {
  if (!st) return { startedAt: null, byVersion: {}, trades: [], setups: null, levels: null };
  const byVersion = Object.fromEntries(Object.entries(PAPER_VERSIONS).map(([k, label]) => [k, { label, ...stats(st.trades.filter((x) => x.version === k && x.symbol !== '^NSEI')), open: st.trades.filter((x) => x.version === k && x.open).length }]));
  byVersion.I = { label: 'NIFTY (index futures proxy)', ...stats(st.trades.filter((x) => x.symbol === '^NSEI')), open: st.trades.filter((x) => x.symbol === '^NSEI' && x.open).length };
  return { startedAt: st.startedAt, updatedAt: st.updatedAt, byVersion, trades: st.trades.slice(-30).reverse(), setups: st.setups || null, levels: st.levels || null };
}

/** One line for the evening note. */
export function closeLine(st, date) {
  const tr = (st?.trades || []).filter((x) => x.exitDate === date && !x.open);
  const net = tr.reduce((a, x) => a + x.net, 0);
  const lv = st?.levels?.list?.length || 0;
  return `1:15 reversal: ${tr.length ? `${tr.length} closed ${net >= 0 ? '+' : '−'}₹${Math.abs(Math.round(net)).toLocaleString('en-IN')}` : 'no trades closed'} · ${lv} level${lv === 1 ? '' : 's'} for next session`;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rs = (v) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const f2 = (x) => (x == null ? '–' : x.toFixed(2));
  const line = (name, x) => console.log(`${name.padEnd(34)} ${x?.trades ? `${String(x.trades).padStart(5)} tr · win ${String(Math.round(x.winRate * 100)).padStart(2)}% · R gross ${f2(x.avgRGross).padStart(5)} net ${f2(x.avgRNet).padStart(5)} · ${rs(x.totalNetRs).padStart(10)} · t ${f2(x.tDay).padStart(5)} · ex-best-10 ${rs(x.exBest10Rs)}` : '    0 trades'}`);
  try {
    if (process.argv.includes('--backtest')) {
      const r = await backtest({ onProgress: (p) => p.i % 25 === 0 && console.error(`  ${p.i}/${p.of}`) });
      console.log(`\n1:15 PM REVERSAL · ${r.stocks} stocks (${r.fnoStocks} F&O) · ${r.from} → ${r.to} · account max 2/day, ₹1,000 risk`);
      for (const [id, x] of Object.entries(r.results)) {
        console.log(`\n${id}  (${VERSIONS[x.version].label}, |move| ≥ ${x.threshold}%, ${x.mode})`);
        for (const p of ['all', 'build', 'check', 'test']) line(`  ${p}`, x.account[p]);
        if (x.mode === 'reversal') {
          for (const p of ['build', 'check', 'test']) line(`  long ${p}`, x.account.long[p]);
          for (const p of ['build', 'check', 'test']) line(`  short ${p}`, x.account.short[p]);
          for (const [y, s] of Object.entries(x.account.byYear)) line(`  ${y}`, s);
          line('  every signal (no cap)', x.everySignal.all);
          console.log(`  exits ${JSON.stringify(x.account.all.exits)}`);
        }
      }
      console.log('\nSENSITIVITY (not in the pass rule): entry-bar order from the candle colour');
      for (const [id, x] of Object.entries(r.sensitivity)) {
        for (const p of ['all', 'build', 'check', 'test']) line(`  ${id} ${p}`, x.account[p]);
        line(`  ${id} every signal`, x.everySignal.all);
      }
      console.log('\nVIDEO VERSION (V, ≥ 3%, account) BY PART');
      for (const [k, x] of Object.entries(r.parts)) line(`  ${k}`, x);
      console.log('\nNIFTY (V rules, futures proxy)');
      for (const [id, x] of Object.entries(r.index)) {
        line(`  ${id} all`, x.all);
        for (const p of ['build', 'check', 'test']) line(`    ${p}`, x[p]);
      }
      console.log(`\nPass rule: ${JSON.stringify(r.verdicts)}\n${r.verdict}\n${r.note}`);
    } else if (process.argv.includes('--paper')) {
      const r = await paperUpdate();
      const t = istNow();
      for (const [k, v] of Object.entries(r.byVersion)) console.log(`1:15 paper ${k} (${v.label}) since ${r.startedAt}: ${v.trades || 0} closed · net R ${f2(v.avgRNet)} · ${rs(v.totalNetRs || 0)} · open ${v.open}`);
      console.log(closeLine(loadPaper(), t.date));
      console.log(`Setups ${r.setups?.date}: ${(r.setups?.list || []).map((x) => `${x.symbol.replace('.NS', '')} ${x.move.toFixed(1)}% ${x.side} ${x.triggered ? `@${x.triggered}` : 'not triggered'}`).join(', ') || 'none'}`);
    } else {
      console.log('Usage: node paper-bot/one-fifteen.mjs --backtest | --paper');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
