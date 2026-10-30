#!/usr/bin/env node
// RSI + price-action swing (library + CLI), from a trader interview (Rathod):
// daily RSI for the setup, hourly candles for the entry, 2–6 day holds.
//
// Rules (fixed before testing):
//   Setup     daily RSI(14) < 30 (today's live price as the day's close) AND
//             hourly RSI(14) < 25 (< 15 = "strong" — reported, not required)
//   Entry     within 14 hourly candles of the setup, an hourly GREEN candle
//             CLOSES above the high of the most recent red candle → buy at
//             the next hourly open
//   Stop      the low of that day's candle so far; exit after an hourly CLOSE
//             below it (next open)
//   Exits     A "hourly trail": a red hourly candle closes below the low of the
//               previous green hourly candle → next open
//             B "daily trail": the same on daily candles
//             C "take profit": +3.5% target (his "3–4%"), else B
//             all: out after 6 trading days at the latest
//   The exit version is chosen on the first year and judged on the second.
//   Short     the mirror image (daily RSI > 70, hourly > 75, red candle closing
//             below a green candle's low …) — needs futures to hold overnight.
//   Costs     delivery: 0.25% a side (STT 0.1% …) + 0.1% slippage a side
//   Not testable: his "skip falls caused by bad news / fraud / results".
// Universe: today's NIFTY 200 (2 years of Yahoo hourly candles — a mild
// survivorship bias in its favour). Research / paper only — not advice.
//
//   node paper-bot/rsi-swing.mjs           # backtest (saved for the app)
//   node paper-bot/rsi-swing.mjs --paper   # live scan + paper record

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { loadIndexList } from './ranking.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';
import { portfolio } from './ath-swing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.RSI_SWING_PATH || join(HERE, 'data', 'rsi-swing.json');
const PAPER = () => process.env.RSI_SWING_PAPER_PATH || join(HERE, 'data', 'rsi-swing-paper.json');

export const RULES = { rsi: 14, dailyBelow: 30, hourlyBelow: 25, strongBelow: 15, armBars: 14, maxDays: 6, takeProfitPct: 3.5, costPct: 0.25, slipPct: 0.1 };
export const VERSIONS = { a: 'A: hourly trailing exit', b: 'B: daily trailing exit', c: 'C: +3.5% target, else daily trailing exit', d: 'D: sell at the first daily close above the 5-day average' };
// Improvement candidates (2026-10-30), fixed before testing; chosen on the first year, judged on the second.
// trend: the stock closed above its 200-day average the day before; market: NIFTY did.
export const IMPROVEMENTS = {
  base: { label: 'Original (B: daily trailing exit)', version: 'b' },
  trend: { label: '1. Only stocks above their 200-day average', version: 'b', trend: true },
  market: { label: '2. Only when NIFTY is above its 200-day average', version: 'b', market: true },
  bounce: { label: '3. Exit at the first daily close above the 5-day average', version: 'd' },
  trendBounce: { label: '4. = 1 + 3', version: 'd', trend: true },
  trendBounce10: { label: '5. = 1 + 3, up to 10 days', version: 'd', trend: true, maxDays: 10 },
  all: { label: '6. = 1 + 2 + 3', version: 'd', trend: true, market: true },
};

// --------------------------------------------------------------- RSI ---
/** Wilder RSI for a list of closes (null until enough data). */
export function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0);
    const dn = Math.max(-ch, 0);
    if (i <= n) {
      g += up / n;
      l += dn / n;
      if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}
/** Wilder state after each daily close: { date, close, g, l } — to compute a live daily RSI with today's price. */
function wilderStates(daily, n = 14) {
  const st = [];
  let g = 0;
  let l = 0;
  for (let i = 1; i < daily.length; i++) {
    const ch = daily[i].close - daily[i - 1].close;
    const up = Math.max(ch, 0);
    const dn = Math.max(-ch, 0);
    if (i <= n) {
      g += up / n;
      l += dn / n;
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
    }
    if (i >= n) st.push({ date: daily[i].date, close: daily[i].close, g, l });
  }
  return st;
}
const liveRsi = (s, price, n = 14) => {
  const ch = price - s.close;
  const g = (s.g * (n - 1) + Math.max(ch, 0)) / n;
  const l = (s.l * (n - 1) + Math.max(-ch, 0)) / n;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
};

// ------------------------------------------------------------- trades ---
const day = (b) => String(b.date).slice(0, 10);
const green = (b) => b.close > b.open;
const red = (b) => b.close < b.open;

/**
 * Trades for one stock. hourly = [{date 'YYYY-MM-DD HH:MM', open, high, low, close}]
 * (whole hours), daily = [{date, open, high, low, close}] (completed days).
 * side 'long' (default) or 'short' (mirror image). version 'a' | 'b' | 'c'.
 */
export function tradesFor(symbol, hourly, daily, { version = 'b', side = 'long', r = RULES, includeOpen = false, trend = false, market = null, maxDays = null } = {}) {
  const L = side === 'long';
  const hr = rsiSeries(hourly.map((b) => b.close), r.rsi);
  const states = wilderStates(daily, r.rsi);
  const stateBefore = new Map(); // date → Wilder state of the previous completed day
  for (let k = 0; k + 1 < states.length; k++) stateBefore.set(states[k + 1].date, states[k]);
  // also the day after the last daily row (today, if hourly runs ahead of the daily data)
  const lastState = states[states.length - 1];
  const dailyIdx = new Map(daily.map((d, i) => [d.date, i]));
  // 200-day average of the stock (to the previous close) for the trend filter; 5-day average for exit D
  const sma = (i, n) => (i >= n - 1 ? daily.slice(i - n + 1, i + 1).reduce((a, x) => a + x.close, 0) / n : null);
  const aboveBefore = (d) => {
    let i = dailyIdx.get(d);
    if (i == null) i = daily.findIndex((x) => x.date > d);
    if (i == null || i < 0) i = daily.length;
    const p = i - 1;
    const m = p >= 0 ? sma(p, 200) : null;
    return m != null && daily[p].close > m;
  };
  const out = [];
  let armedUntil = -1;
  let armedStrong = false;
  let armedDailyRsi = null;
  let armedHourlyRsi = null;
  let lastOpp = null; // most recent red (long) / green (short) candle
  for (let i = 1; i < hourly.length; i++) {
    const b = hourly[i];
    const d = day(b);
    const st = stateBefore.get(d) || (lastState && d > lastState.date ? lastState : null);
    const dRsi = st ? liveRsi(st, b.close, r.rsi) : null;
    const hRsi = hr[i];
    if (dRsi != null && hRsi != null && (L ? dRsi < r.dailyBelow && hRsi < r.hourlyBelow : dRsi > 100 - r.dailyBelow && hRsi > 100 - r.hourlyBelow)) {
      armedUntil = i + r.armBars;
      armedStrong = L ? hRsi < r.strongBelow : hRsi > 100 - r.strongBelow;
      armedDailyRsi = dRsi;
      armedHourlyRsi = hRsi;
    }
    // the trigger candle closes beyond the most recent opposite candle's extreme
    const trig = i <= armedUntil && lastOpp && (L ? green(b) && b.close > lastOpp.high : red(b) && b.close < lastOpp.low);
    if ((L ? red(b) : green(b))) lastOpp = b;
    if (!trig || i + 1 >= hourly.length) continue;
    // optional filters (improvement test): stock / NIFTY above the 200-day average at the previous close
    if (trend && !aboveBefore(d)) continue;
    if (market && !market(d)) continue;
    // entry at the next hourly open
    const e = i + 1;
    const slip = r.slipPct / 100;
    const entry = hourly[e].open * (L ? 1 + slip : 1 - slip);
    const today = hourly.filter((x, k) => k <= i && day(x) === d);
    const stop = L ? Math.min(...today.map((x) => x.low)) : Math.max(...today.map((x) => x.high));
    if (L ? !(entry > stop) : !(entry < stop)) continue;
    const target = version === 'c' ? entry * (L ? 1 + r.takeProfitPct / 100 : 1 - r.takeProfitPct / 100) : null;
    let exitIdx = null;
    let exit = null;
    let reason = null;
    let lastSame = null; // most recent green (long) / red (short) hourly candle since entry
    const days = [];
    for (let k = e; k < hourly.length; k++) {
      const c = hourly[k];
      if (!days.includes(day(c))) days.push(day(c));
      if (target != null && (L ? c.high >= target : c.low <= target)) {
        // filled at the target, or at the open if the candle gapped beyond it
        exit = L ? Math.max(target, c.open) : Math.min(target, c.open);
        exitIdx = k;
        reason = 'target';
        break;
      }
      const lastOfDay = k + 1 >= hourly.length || day(hourly[k + 1]) !== day(c);
      let hit = null;
      if (L ? c.close < stop : c.close > stop) hit = 'stop';
      else if (version === 'a' && lastSame && (L ? red(c) && c.close < lastSame.low : green(c) && c.close > lastSame.high)) hit = 'trail';
      else if (version === 'd' && lastOfDay) {
        const di = dailyIdx.get(day(c));
        const m5 = di != null ? sma(di, 5) : null;
        if (m5 != null && (L ? daily[di].close > m5 : daily[di].close < m5)) hit = 'bounce';
      } else if (version !== 'a' && lastOfDay) {
        const di = dailyIdx.get(day(c));
        const dc = di != null ? daily[di] : null;
        const prevSame = di != null ? [...daily.slice(Math.max(0, di - 10), di)].reverse().find((x) => (L ? green(x) : red(x))) : null;
        if (dc && prevSame && (L ? red(dc) && dc.close < prevSame.low : green(dc) && dc.close > prevSame.high)) hit = 'trail';
      }
      if (!hit && lastOfDay && days.length >= (maxDays || r.maxDays)) hit = `${maxDays || r.maxDays} days`;
      if (L ? green(c) : red(c)) lastSame = c;
      if (hit) {
        if (k + 1 >= hourly.length) {
          exitIdx = null;
          break;
        }
        exitIdx = k + 1;
        exit = hourly[k + 1].open;
        reason = hit;
        break;
      }
    }
    const open = exitIdx == null;
    if (open && !includeOpen) break;
    const last = hourly[hourly.length - 1];
    const px = open ? last.close : exit;
    const fill = L ? px * (1 - slip) : px * (1 + slip);
    const cost = (2 * r.costPct) / 100;
    const retPct = (L ? fill / entry - 1 : entry / fill - 1) - cost;
    const riskPct = Math.abs(entry - stop) / entry;
    out.push({
      symbol, side, version, signalTime: b.date, entryDate: day(hourly[e]), entryTime: hourly[e].date, exitDate: open ? day(last) : day(hourly[exitIdx]), exitTime: open ? null : hourly[exitIdx].date,
      entry, stop, target, exit: fill, reason: open ? 'open' : reason, open, retPct, riskPct, r: retPct / riskPct, days: open ? null : days.length,
      dailyRsi: armedDailyRsi, hourlyRsi: armedHourlyRsi, strong: armedStrong,
    });
    if (open) break;
    i = exitIdx; // one position per stock at a time
    armedUntil = -1;
  }
  return out;
}

export function summarise(trades) {
  const done = trades.filter((t) => !t.open);
  if (!done.length) return { trades: 0 };
  const rets = done.map((t) => t.retPct);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1));
  const wins = done.filter((t) => t.retPct > 0);
  const gw = wins.reduce((a, t) => a + t.retPct, 0);
  const gl = -done.filter((t) => t.retPct <= 0).reduce((a, t) => a + t.retPct, 0);
  return {
    trades: done.length, winRate: wins.length / done.length, avgRetPct: m * 100, avgR: done.reduce((a, t) => a + t.r, 0) / done.length,
    profitFactor: gl > 0 ? gw / gl : null, tStat: sd > 0 ? m / (sd / Math.sqrt(rets.length)) : null,
    avgDays: done.reduce((a, t) => a + (t.days || 0), 0) / done.length, worstPct: Math.min(...rets) * 100,
    exits: done.reduce((o, t) => ((o[t.reason] = (o[t.reason] || 0) + 1), o), {}),
  };
}

// ---------------------------------------------------------------- data ---
async function universe() {
  const idx = await loadIndexList('nifty200');
  return (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`));
}
/** Hourly (whole hours only) and completed daily candles for the universe. */
export async function loadData({ loadCandles = candles, now = new Date() } = {}) {
  const t = new Date(now.getTime() + 19800_000);
  const today = t.toISOString().slice(0, 10);
  const afterClose = t.getUTCHours() * 60 + t.getUTCMinutes() >= 15 * 60 + 35;
  const symbols = await universe();
  return (await mapLimit(symbols, 6, async (s) => {
    try {
      const h = (await loadCandles(s, { range: '2y', interval: '60m' })).filter((b) => b.close > 0 && b.open > 0);
      // drop a still-forming hour (anything not on the :15 boundary, or today's last bar before the close)
      const hourly = h.filter((b) => String(b.date).slice(14, 16) === '15' && !(day(b) === today && !afterClose && b === h[h.length - 1]));
      const d = (await loadCandles(s, { range: '5y', interval: '1d' })).filter((b) => b.close > 0 && b.open > 0);
      const daily = d.filter((b) => b.date < today || afterClose);
      return hourly.length > 200 && daily.length > 60 ? { symbol: s, hourly, daily } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
}

// --------------------------------------------------------------- tests ---
export async function rsiSwingTest({ loadCandles = candles, now = new Date() } = {}) {
  const data = await loadData({ loadCandles, now });
  const first = data.reduce((a, x) => (x.hourly[0] && day(x.hourly[0]) < a ? day(x.hourly[0]) : a), '9999');
  const last = data.reduce((a, x) => (day(x.hourly.at(-1)) > a ? day(x.hourly.at(-1)) : a), '');
  const split = new Date((Date.parse(first) + Date.parse(last)) / 2).toISOString().slice(0, 10);
  const pf = (trades) => {
    const p = portfolio(trades.filter((t) => !t.open).map((t) => ({ ...t, exitDate: t.exitDate })), { capital: 100000, riskPct: 1, maxOpen: 5, maxPositionPct: 20, cashRatePct: 6 });
    const yrs = (Date.parse(last) - Date.parse(first)) / (365.25 * 86400000);
    return { cagr: yrs > 0 ? (p.finalEquity / 100000) ** (1 / yrs) - 1 : null, finalEquity: p.finalEquity, taken: p.taken.length };
  };
  const results = {};
  for (const side of ['long', 'short']) {
    for (const v of Object.keys(VERSIONS)) {
      const trades = data.flatMap(({ symbol, hourly, daily }) => tradesFor(symbol, hourly, daily, { version: v, side }));
      results[`${side}-${v}`] = {
        side, version: v, label: `${side === 'long' ? 'Buy' : 'Short'} · ${VERSIONS[v]}`,
        all: summarise(trades), first: summarise(trades.filter((t) => t.entryDate < split)), second: summarise(trades.filter((t) => t.entryDate >= split)),
        strong: summarise(trades.filter((t) => t.strong)), portfolio: pf(trades),
      };
    }
  }
  // improvement candidates (buy side): chosen on the first year, judged once on the second
  let niftyAbove = null;
  try {
    const nd = (await loadCandles('^NSEI', { range: '5y', interval: '1d' })).filter((x) => x.close > 0);
    const ok = new Map();
    for (let i = 200; i < nd.length; i++) ok.set(nd[i].date, nd[i].close > nd.slice(i - 199, i + 1).reduce((a, x) => a + x.close, 0) / 200);
    const dates = [...ok.keys()];
    niftyAbove = (d) => {
      const prev = dates.filter((x) => x < d).pop();
      return prev ? ok.get(prev) : false;
    };
  } catch {
    niftyAbove = null;
  }
  const improve = {};
  for (const [key, imp] of Object.entries(IMPROVEMENTS)) {
    if (imp.market && !niftyAbove) continue;
    const trades = data.flatMap(({ symbol, hourly, daily }) => tradesFor(symbol, hourly, daily, { version: imp.version, trend: !!imp.trend, market: imp.market ? niftyAbove : null, maxDays: imp.maxDays || null }));
    improve[key] = { label: imp.label, all: summarise(trades), first: summarise(trades.filter((t) => t.entryDate < split)), second: summarise(trades.filter((t) => t.entryDate >= split)), beforeCosts: summarise(trades.filter((t) => !t.open).map((t) => ({ ...t, retPct: t.retPct + (2 * (RULES.costPct + RULES.slipPct)) / 100 }))), portfolio: pf(trades) };
  }
  const eligible = Object.entries(improve).filter(([, x]) => (x.first.trades || 0) >= 50);
  const pickKey = eligible.sort(([, x], [, y]) => (y.first.avgRetPct ?? -99) - (x.first.avgRetPct ?? -99))[0]?.[0] || 'base';
  const pick = improve[pickKey];
  const improvePassed = (pick.second.avgRetPct ?? -1) > 0 && (pick.second.tStat ?? 0) >= 2;
  // the exit version is chosen on the first year (long side), judged on the second
  const chosen = ['a', 'b', 'c'].sort((x, y) => (results[`long-${y}`].first.avgRetPct ?? -99) - (results[`long-${x}`].first.avgRetPct ?? -99))[0];
  const c = results[`long-${chosen}`];
  const passed = (c.second.avgRetPct ?? -1) > 0 && (c.second.tStat ?? 0) >= 2;
  // NIFTY over the same span, for comparison
  let nifty = null;
  try {
    const n = (await loadCandles('^NSEI', { range: '2y', interval: '1d' })).filter((x) => x.close > 0 && x.date >= first);
    const yrs = (Date.parse(n.at(-1).date) - Date.parse(n[0].date)) / (365.25 * 86400000);
    nifty = { cagr: (n.at(-1).close / n[0].close) ** (1 / yrs) - 1 };
  } catch {
    /* no comparison */
  }
  return {
    at: new Date().toISOString(), from: first, to: last, split, stocks: data.length, rules: RULES, versions: VERSIONS, results, chosen, passed, nifty,
    improve: { results: improve, pick: pickKey, passed: improvePassed, tried: Object.keys(improve).length,
      verdict: `${improve[pickKey].label} was best on the first year (${improve[pickKey].first.avgRetPct?.toFixed(2)}% a trade) and made ${pick.second.avgRetPct?.toFixed(2) ?? '–'}% a trade on the second year (t ${pick.second.tStat?.toFixed(1) ?? '–'}, ${pick.second.trades} trades) — ${improvePassed ? 'it passed' : 'not a pass'}.` },
    verdict: passed
      ? `The buy setup with ${VERSIONS[chosen]} (chosen on the first year) was profitable on the second year after costs: ${c.second.avgRetPct.toFixed(2)}% a trade (t ${c.second.tStat.toFixed(1)}).`
      : `The buy setup with ${VERSIONS[chosen]} (chosen on the first year) did not pass on the second year: ${c.second.trades} trades, ${c.second.avgRetPct?.toFixed(2) ?? '–'}% a trade after costs (t ${c.second.tStat?.toFixed(1) ?? '–'}), ${Math.round((c.second.winRate || 0) * 100)}% won.`,
    note: 'Today\'s NIFTY 200 stocks over the last two years of Yahoo hourly candles (stocks that left the index are missing, which flatters a buy-the-dip rule). Daily RSI uses the live price as today\'s close, as a trader watching would see it. Entries and exits at the next hourly open; stops and exits act on candle closes. Delivery charges 0.25% + 0.1% slippage a side. His "skip falls caused by bad news" filter cannot be tested. Portfolio: ₹1 lakh, 1% risk a trade, at most 5 open, idle cash at 6%. Research only.',
  };
}

export const saveRsiSwing = (r) => writeJsonAtomic(SAVED(), r);
const readJ = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
export const loadRsiSwing = () => readJ(SAVED());
export const loadRsiSwingPaper = () => readJ(PAPER());

/** Live scan: stocks in the RSI setup now (waiting for the entry candle) and fresh entry signals. */
export function scanNow(data, r = RULES) {
  const forming = [];
  const triggered = [];
  for (const { symbol, hourly, daily } of data) {
    const hr = rsiSeries(hourly.map((b) => b.close), r.rsi);
    const st = wilderStates(daily, r.rsi);
    const i = hourly.length - 1;
    const b = hourly[i];
    const s = st.filter((x) => x.date < day(b)).pop();
    if (!s || hr[i] == null) continue;
    const dRsi = liveRsi(s, b.close, r.rsi);
    const tr = tradesFor(symbol, hourly.slice(-120), daily, { version: 'b', includeOpen: true }).filter((t) => t.open && t.entryDate === day(b));
    if (tr.length) triggered.push({ symbol, entry: tr[0].entry, stop: tr[0].stop, signalTime: tr[0].signalTime, dailyRsi: tr[0].dailyRsi, hourlyRsi: tr[0].hourlyRsi });
    else if (dRsi < r.dailyBelow + 5) forming.push({ symbol, dailyRsi: dRsi, hourlyRsi: hr[i], close: b.close, ready: dRsi < r.dailyBelow && hr[i] < r.hourlyBelow });
  }
  return { triggered, forming: forming.sort((a, b) => a.dailyRsi - b.dailyRsi).slice(0, 20) };
}

/** Paper record (chosen version, buy side): trades entered on or after the start date; re-checked each evening. */
export async function rsiSwingPaperUpdate({ loadCandles = candles, now = new Date() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const st = loadRsiSwingPaper() || { startedAt: today, trades: [] };
  const version = loadRsiSwing()?.chosen || 'b';
  const data = await loadData({ loadCandles, now });
  const prev = new Map(st.trades.map((t) => [`${t.symbol}|${t.entryTime}`, t]));
  st.trades = data.flatMap(({ symbol, hourly, daily }) => tradesFor(symbol, hourly, daily, { version, includeOpen: true }))
    .filter((t) => t.entryDate >= st.startedAt).map((t) => ({ ...t, firstSeen: prev.get(`${t.symbol}|${t.entryTime}`)?.firstSeen || now.toISOString() }));
  st.version = version;
  st.scan = scanNow(data);
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return { startedAt: st.startedAt, version, summary: summarise(st.trades), open: st.trades.filter((t) => t.open).length, scan: st.scan };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pc = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  if (process.argv.includes('--paper')) {
    rsiSwingPaperUpdate()
      .then((r) => console.log(`RSI swing paper (${r.version}): since ${r.startedAt} · ${r.summary.trades} closed, ${r.open} open · entry signals now: ${r.scan.triggered.map((x) => x.symbol.replace('.NS', '')).join(', ') || 'none'} · setups forming: ${r.scan.forming.filter((x) => x.ready).map((x) => x.symbol.replace('.NS', '')).join(', ') || 'none'}`))
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    rsiSwingTest()
      .then((r) => {
        saveRsiSwing(r);
        console.log(`\nRSI SWING (Rathod) · ${r.stocks} stocks · ${r.from} → ${r.to} · split ${r.split}`);
        for (const x of Object.values(r.results)) console.log(`  ${x.label.padEnd(50)} ${String(x.all.trades).padStart(4)} tr · won ${Math.round((x.all.winRate || 0) * 100)}% · ${pc(x.all.avgRetPct)}/trade · t ${x.all.tStat?.toFixed(2) ?? '–'} · 1st ${pc(x.first.avgRetPct)} · 2nd ${pc(x.second.avgRetPct)} (t ${x.second.tStat?.toFixed(2) ?? '–'}) · strong ${pc(x.strong.avgRetPct)} (${x.strong.trades}) · ₹1L → ${x.portfolio.cagr != null ? `${(x.portfolio.cagr * 100).toFixed(1)}%/yr` : '–'} · ${x.all.avgDays?.toFixed(1)} days · exits ${JSON.stringify(x.all.exits)}`);
        console.log(`  NIFTY over the span: ${r.nifty ? `${(r.nifty.cagr * 100).toFixed(1)}%/yr` : '–'}`);
        console.log('  IMPROVEMENTS (buy side):');
        for (const [k, x] of Object.entries(r.improve.results)) console.log(`    ${x.label.padEnd(58)} ${String(x.all.trades).padStart(4)} tr · won ${Math.round((x.all.winRate || 0) * 100)}% · ${pc(x.all.avgRetPct)} (before costs ${pc(x.beforeCosts.avgRetPct)}) · 1st ${pc(x.first.avgRetPct)} · 2nd ${pc(x.second.avgRetPct)} (t ${x.second.tStat?.toFixed(2) ?? '–'}) · ₹1L ${x.portfolio.cagr != null ? `${(x.portfolio.cagr * 100).toFixed(1)}%/yr` : '–'} · ${x.all.avgDays?.toFixed(1)} days${k === r.improve.pick ? '  ← chosen on the 1st year' : ''}`);
        console.log(`  ${r.improve.verdict}`);
        console.log(`\n${r.verdict}`);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  }
}
