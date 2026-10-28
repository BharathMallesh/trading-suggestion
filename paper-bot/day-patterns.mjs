#!/usr/bin/env node
// Day patterns (library + CLI): which strategy did better or worse on which
// weekday, and — for the intraday ones — after a gap-up, gap-down or flat open,
// plus the Monday tests (swing buys skipped or moved to Tuesday; a NIFTY
// "weekend dip"). Built from every strategy's backtest trades; saved for the
// "Day patterns" tab and refreshed by the weekly refit.
// Splitting a sample five ways invites chance patterns: each cell carries a
// t-statistic, and only patterns that held in both halves are called "consistent".
// Research only — not investment advice.
//
//   node paper-bot/day-patterns.mjs   # run the study and save it (~2 minutes)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { mapLimit, writeJsonAtomic } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = () => process.env.DAY_PATTERNS_PATH || join(HERE, 'data', 'day-patterns.json');
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const weekdayOf = (d) => NAMES[new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay()];

/** n, win rate, average, t-statistic of values. */
export function stats(values) {
  const n = values.length;
  if (!n) return { n: 0 };
  const m = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { n, win: values.filter((v) => v > 0).length / n, avg: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
}
/** Group trades by a key → { key: stats }. */
export function groupBy(trades, keyFn, valueFn) {
  const g = {};
  for (const t of trades) (g[keyFn(t)] ||= []).push(valueFn(t));
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, stats(v)]));
}
/** { symbol: { weekday: stats } } — which stocks did better or worse on which weekday. */
export function byStockDay(trades, dayFn, valueFn) {
  const out = {};
  for (const [sym, list] of Object.entries(trades.reduce((g, t) => ((g[t.symbol] ||= []).push(t), g), {}))) out[sym] = { all: stats(list.map(valueFn)), ...groupBy(list, dayFn, valueFn) };
  return out;
}
export const gapKind = (gapPct) => (gapPct == null ? null : gapPct > 0.3 ? 'gap up' : gapPct < -0.3 ? 'gap down' : 'flat open');

/** Best / worst weekday and whether the pattern held in both halves (when halves are given). */
export function verdictFor(byDay, { early = null, late = null, minN = 30 } = {}) {
  const days = WEEKDAYS.filter((d) => byDay[d]?.n);
  if (days.length < 2) return { best: null, worst: null, consistent: false, enough: false };
  const best = days.reduce((a, d) => (byDay[d].avg > byDay[a].avg ? d : a));
  const worst = days.reduce((a, d) => (byDay[d].avg < byDay[a].avg ? d : a));
  const enough = days.every((d) => byDay[d].n >= minN);
  const rank = (g, d) => (g && g[d]?.n ? WEEKDAYS.filter((x) => g[x]?.n).sort((a, b) => g[b].avg - g[a].avg).indexOf(d) : null);
  const consistent = !!(early && late && enough && rank(early, best) <= 1 && rank(late, best) <= 1 && rank(early, worst) >= 3 && rank(late, worst) >= 3);
  return { best, worst, consistent, enough };
}

// --------------------------------------------------------------- the study ---
export async function dayPatternsStudy({ loadCandles = candles, now = new Date() } = {}) {
  const vp = await import('./vwap-pullback.mjs');
  const bf = await import('./breakfast.mjs');
  const ath = await import('./ath-swing.mjs');
  const dip = await import('./nifty-dip.mjs');
  const fo = await import('./fo-strangle.mjs');
  const { loadIndexList } = await import('./ranking.mjs');
  const get = vp.withStore(loadCandles);
  const p1 = Math.floor(now.getTime() / 1000) - 59 * 86400;
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const strategies = [];

  // NIFTY's opening gap per day (open of the first 5-minute candle vs the previous close)
  const n5 = (await get('^NSEI', { period1: p1, interval: '5m' })).filter((b) => b.close > 0);
  const gap = new Map();
  let prevClose = null;
  let cur = null;
  for (const b of n5) {
    const d = String(b.date).slice(0, 10);
    if (d !== cur) {
      if (prevClose) gap.set(d, (b.open / prevClose - 1) * 100);
      cur = d;
    }
    prevClose = b.close;
  }
  const byGap = (trades, f) => groupBy(trades.filter((t) => gapKind(gap.get(t.date))), (t) => gapKind(gap.get(t.date)), f);
  const sessions = gap.size;

  // YouTube intraday (the three paper versions, on the saved 5-minute history)
  const vwapLabels = { video: 'YouTube intraday · video rules', improved: 'YouTube intraday · improved', scanner: 'YouTube intraday · scanner' };
  for (const [key, v] of Object.entries(vp.PAPER_VARIANTS)) {
    const list = v.stocks || vp.VIDEO_STOCKS;
    const data = (await mapLimit(list, 4, async (s) => {
      try {
        const rows = (await get(s, { period1: p1, interval: '5m' })).filter((r) => r.close > 0 && r.high > 0);
        return { s, rows, daily: await vp.dailyContext(loadCandles, s) };
      } catch {
        return null;
      }
    })).filter(Boolean);
    const trades = vp.accountTrades(data.flatMap(({ s, rows, daily }) => vp.backtestStock(s, rows, v.rules, { daily })), v.rules.maxPerDay).filter((t) => t.date < today);
    const byDay = groupBy(trades, (t) => weekdayOf(t.date), (t) => t.net);
    strategies.push({ key: `vwap-${key}`, tab: 'vwap', name: vwapLabels[key] || key, unit: '₹', period: `last ${sessions} trading days`, all: stats(trades.map((t) => t.net)), byDay, byGap: byGap(trades, (t) => t.net), byStock: byStockDay(trades, (t) => weekdayOf(t.date), (t) => t.net), verdict: verdictFor(byDay) });
  }

  // Breakfast (the backtest loop, keeping the trades)
  {
    const idx = await loadIndexList('nifty200');
    const ind = idx.industries || {};
    const uni = (idx.symbols || []).map((s) => (/\.(NS|BO)$/.test(s) ? s : `${s}.NS`)).map((s) => ({ s, sector: ind[s] || ind[s.replace('.NS', '')] || 'Other' }));
    const hhmm = (b) => String(b.date).slice(11, 16);
    const stocks = (await mapLimit(uni, 6, async (x) => {
      try {
        const rows = (await get(x.s, { period1: p1, interval: '5m' })).filter((b) => b.close > 0 && b.high > 0 && Number(hhmm(b).slice(3)) % 5 === 0);
        return rows.length ? { ...x, sessions: bf.sessionsOf(rows) } : null;
      } catch {
        return null;
      }
    })).filter(Boolean);
    const nifty = bf.sessionsOf(n5);
    const trades = [];
    for (const d of [...nifty.keys()].filter((x) => x < today).sort()) {
      const p = bf.picksFor(d, stocks, nifty);
      for (const [side, pick] of [['long', p.long], ['short', p.short]]) {
        if (!pick) continue;
        const t = bf.simulate({ ...pick, date: d }, side, stocks.find((x) => x.s === pick.symbol)?.sessions.get(d), p.niftyMove);
        if (t) trades.push(t);
      }
    }
    const byDay = groupBy(trades, (t) => weekdayOf(t.date), (t) => t.net);
    const bySector = byStockDay(trades.map((t) => ({ ...t, symbol: t.sector || 'Other' })), (t) => weekdayOf(t.date), (t) => t.net);
    strategies.push({ key: 'breakfast', tab: 'breakfast', name: 'Breakfast strategy', unit: '₹', period: `last ${sessions} trading days`, all: stats(trades.map((t) => t.net)), byDay, byGap: byGap(trades, (t) => t.net), byStock: byStockDay(trades, (t) => weekdayOf(t.date), (t) => t.net), bySector, verdict: verdictFor(byDay) });
  }

  // Strong-stock swing, survivorship-free, by the weekday of the buy; plus the Monday tests
  const monday = { swing: [], weekendDip: [] };
  try {
    const { loadSeries, pointInTimeUniverse } = await import('./bhav-history.mjs');
    const series = loadSeries();
    if (series.size) {
      const universe = pointInTimeUniverse(series);
      const niftyD = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2005-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0 && x.open > 0);
      const market = ath.marketMap(niftyD);
      const prepared = [...series].filter(([, rows]) => rows.length > 300).map(([s, rows]) => ({ s, rows, bars: ath.indicators(rows), first: rows[0].date }));
      const tradesOf = (rules) => prepared.flatMap(({ s, rows, bars, first }) => ath.tradesFor(s, rows, rules, { bars, market }).filter((t) => !t.open && t.entryDate >= '2010-01-01' && universe.get(t.signalDate.slice(0, 7))?.has(s) && Date.parse(t.signalDate) - Date.parse(first) >= 365 * 86400000));
      for (const [key, name, rules] of [['swing-improved', 'Strong-stock swing · improved rules', ath.activeRules()], ['swing-wide', 'Strong-stock swing · wide trail', ath.wideRules()]]) {
        const trades = tradesOf(rules);
        const byDay = groupBy(trades, (t) => weekdayOf(t.entryDate), (t) => t.r);
        const early = groupBy(trades.filter((t) => t.entryDate < '2018-01-01'), (t) => weekdayOf(t.entryDate), (t) => t.r);
        const late = groupBy(trades.filter((t) => t.entryDate >= '2018-01-01'), (t) => weekdayOf(t.entryDate), (t) => t.r);
        // per stock: only names with 8+ trades, to keep the file small
        const many = trades.filter((t) => trades.filter((x) => x.symbol === t.symbol).length >= 8);
        strategies.push({ key, tab: 'ath', name, unit: 'R', period: '2010 → now, full NSE history (incl. stocks that later disappeared)', all: stats(trades.map((t) => t.r)), byDay, byDayEarly: early, byDayLate: late, byStock: byStockDay(many, (t) => weekdayOf(t.entryDate), (t) => t.r), verdict: verdictFor(byDay, { early, late }) });
        for (const [label, r] of [['all days', rules], ['Monday buys moved to Tuesday', { ...rules, shiftEntryDays: [1] }], ['no Monday buys', { ...rules, skipEntryDays: [1] }]]) {
          const x = ath.survivorshipRun(series, universe, market, { rulesList: { x: r }, nifty: niftyD, splitYear: '2018-01-01' }).results.x;
          monday.swing.push({ version: name, label, trades: x.all.trades, avgR: x.all.avgR, tStat: x.all.tStat, cagr: x.portfolioCagr, cagrAfterTax: x.portfolioCagrAfterTax, early: x.halves?.before, late: x.halves?.after, maxDrawdown: x.maxDrawdown });
        }
      }
    }
  } catch (err) {
    monday.error = err.message;
  }

  // NIFTY dip-buy (2008 →), by the weekday of the buy; and the weekend-dip test
  {
    const rows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2007-01-01') / 1000), interval: '1d' })).filter((x) => x.open > 0 && x.close > 0);
    const trades = dip.simulate(rows).filter((t) => !t.open && !t.pending);
    const byDay = groupBy(trades, (t) => weekdayOf(t.entryDate), (t) => t.retPct);
    strategies.push({ key: 'nifty-dip', tab: 'dip', name: 'NIFTY dip-buy', unit: '%', period: '2008 → now', all: stats(trades.map((t) => t.retPct)), byDay, verdict: verdictFor(byDay, { minN: 30 }) });
    const sma = (i, n) => (i >= n - 1 ? rows.slice(i - n + 1, i + 1).reduce((a, x) => a + x.close, 0) / n : null);
    const day = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
    for (const trend of [false, true]) {
      const out = [];
      for (let i = 201; i + 1 < rows.length; i++) {
        if (day(rows[i].date) !== 1 || day(rows[i - 1].date) !== 5) continue;
        if (!(rows[i].close < rows[i - 1].close && rows[i - 1].close < rows[i - 2].close)) continue;
        if (trend && !(rows[i].close > sma(i, 200))) continue;
        const e = i + 1;
        let j = e;
        for (; j < rows.length; j++) {
          const ma = sma(j, 5);
          if ((ma && rows[j].close > ma) || j - e + 1 >= 10) break;
        }
        if (j + 1 >= rows.length) break;
        out.push({ entryDate: rows[e].date, exitDate: rows[j + 1].date, days: j + 1 - e, open: false, ...dip.costTrade(rows[e].open, rows[j + 1].open) });
        i = j + 1;
      }
      const tr = out.filter((x) => x.entryDate >= '2010-01-01' && x.entryDate < '2018-01-01').map((x) => x.retPct);
      const te = out.filter((x) => x.entryDate >= '2018-01-01').map((x) => x.retPct);
      const p = dip.portfolio(rows, out, '2018-01-01');
      monday.weekendDip.push({ label: trend ? 'with the 200-day filter' : 'no filter', early: stats(tr), late: stats(te), cagr: p?.cagr, cagrAfterTax: p?.cagrAfter, niftyCagr: p?.niftyCagr, niftyAfterTax: p?.niftyAfter });
    }
  }

  // NIFTY short strangle: one trade a week; by the weekday of the expiry (that is the era)
  {
    const close = new Map((await loadCandles('^NSEI', { period1: Math.floor(Date.parse('2019-01-01') / 1000), interval: '1d' })).filter((x) => x.close > 0).map((x) => [x.date, x.close]));
    const dir = process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
    const trades = [];
    let last = '';
    for (const d of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort() : []) {
      if (d <= last) continue;
      let dayData = null;
      try {
        dayData = JSON.parse(readFileSync(join(dir, `${d}.json`), 'utf8'));
      } catch {
        continue;
      }
      const t = fo.openTrade(d, dayData, fo.RULES, close.get(d));
      if (!t) continue;
      last = t.expiry;
      if (close.has(t.expiry)) trades.push(fo.settle(t, close.get(t.expiry)));
    }
    const byDay = groupBy(trades, (t) => weekdayOf(t.expiry), (t) => t.retOnMargin * 100);
    strategies.push({ key: 'fo-strangle', tab: 'fo', name: 'NIFTY short strangle (F&O)', unit: '% of margin', period: 'weekly since 2019, by the weekday of the expiry', all: stats(trades.map((t) => t.retOnMargin * 100)), byDay, verdict: { ...verdictFor(byDay, { minN: 30 }), note: 'NIFTY expiry was Thursday until Aug 2025 and Tuesday since Sep 2025, so the weekday mostly shows the era (the calm recent period), not a day effect.' } });
  }

  return {
    at: new Date().toISOString(), intradaySessions: sessions, strategies, monday,
    note: 'Average result per trade by the weekday of the buy (intraday: the trading day; swing and dip-buy: the day the position was bought; strangle: the expiry day). ₹ per trade after charges at the standard size; R = multiples of the risk taken. A cell with |t| ≥ 2 is marked; with 5 days × many strategies, one or two such cells appear by chance. Only a pattern that held in both halves of the history is called consistent. F&O spreads are left out: their prices come from a model.',
  };
}

export const saveDayPatterns = (r) => writeJsonAtomic(SAVED(), r);
export function loadDayPatterns() {
  try {
    return existsSync(SAVED()) ? JSON.parse(readFileSync(SAVED(), 'utf8')) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dayPatternsStudy()
    .then((r) => {
      saveDayPatterns(r);
      for (const s of r.strategies) console.log(`${s.name.padEnd(40)} best ${s.verdict.best || '–'} · worst ${s.verdict.worst || '–'}${s.verdict.consistent ? ' · consistent in both halves' : ''} · ${s.all.n} trades`);
      console.log(`Monday tests: ${r.monday.swing.length} swing runs, ${r.monday.weekendDip.length} weekend-dip runs${r.monday.error ? ` (error: ${r.monday.error})` : ''}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
