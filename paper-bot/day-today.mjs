// "What works today?" (library) for the Day patterns tab: for today's weekday
// (and, from 9:15, today's NIFTY opening gap) it ranks the logics by how they
// did on such days in their backtests, lists which stocks did best / worst on
// this weekday for a chosen logic, and shows how each logic did on paper over
// the last few trading days. Patterns from small samples are labelled as
// probably chance — this describes the past, it does not predict today.
// Research only — not investment advice.

import { candles } from '../market-data.mjs';
import { loadDayPatterns, WEEKDAYS, weekdayOf, gapKind } from './day-patterns.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { loadPaper } from './vwap-pullback.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadAthPaper } from './ath-swing.mjs';
import { loadNiftyDipPaper, ofVersion } from './nifty-dip.mjs';
import { loadFoStranglePaper } from './fo-strangle.mjs';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000));

/** The trading day this is about: today if NSE trades today, else the next trading day. */
export function dayInFocus(now = new Date()) {
  let d = iso(new Date(now.getTime() + 19800_000));
  for (let k = 0; k < 10 && !isTradingDay(d); k++) d = addDays(d, 1);
  return d;
}

/** Today's NIFTY opening gap (%) once the first 5-minute candle exists, else null. */
export async function openingGap({ loadCandles = candles, date } = {}) {
  try {
    const rows = (await loadCandles('^NSEI', { range: '5d', interval: '5m' })).filter((b) => b.close > 0);
    const today = rows.filter((b) => String(b.date).startsWith(date));
    const before = rows.filter((b) => String(b.date).slice(0, 10) < date);
    if (!today.length || !before.length) return null;
    return (today[0].open / before[before.length - 1].close - 1) * 100;
  } catch {
    return null;
  }
}

// how each logic's paper record looked over the last few trading days
function recentFor(key, papers, days = 5) {
  const pick = (list, dateOf, valueOf) => {
    const byDate = new Map();
    for (const t of list) byDate.set(dateOf(t), [...(byDate.get(dateOf(t)) || []), t]);
    return [...byDate].sort(([a], [b]) => b.localeCompare(a)).slice(0, days).map(([date, ts]) => ({ date, trades: ts.length, result: ts.reduce((a, t) => a + valueOf(t), 0), detail: ts.map((t) => `${(t.symbol || '').replace('.NS', '')} ${t.reason || ''}`.trim()).join(', ') }));
  };
  if (key.startsWith('vwap-')) {
    const v = key.slice(5);
    return pick((papers.vwap?.trades || []).filter((t) => (t.variant || 'video') === v), (t) => t.date, (t) => t.net);
  }
  if (key === 'breakfast') return pick(papers.breakfast?.trades || [], (t) => t.date, (t) => t.net);
  if (key.startsWith('swing-')) {
    const ver = key === 'swing-wide' ? 'wide' : 'improved';
    const mine = (papers.swing?.trades || []).filter((t) => (t.version || 'original') === ver);
    const closed = pick(mine.filter((t) => !t.open), (t) => t.exitDate, (t) => t.r);
    const open = mine.filter((t) => t.open).map((t) => `${t.symbol.replace('.NS', '')} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`);
    return open.length ? [...closed, { date: 'open now', trades: open.length, result: null, detail: open.join(', ') }] : closed;
  }
  if (key === 'nifty-dip') return pick(ofVersion(papers.dip?.trades, 'standard').filter((t) => !t.open), (t) => t.exitDate, (t) => t.net);
  if (key === 'fo-strangle') return pick((papers.fo?.trades || []).filter((t) => !t.open), (t) => t.expiry, (t) => t.rupees);
  return [];
}

/** Rating of one logic for the day: compare its weekday (and gap) average with its all-days average. */
export function rateFor(s, weekday, gap) {
  const day = s.byDay?.[weekday];
  const g = gap && s.byGap ? s.byGap[gap] : null;
  const base = s.all?.avg ?? 0;
  const parts = [day?.n ? day.avg - base : null, g?.n ? g.avg - base : null].filter((x) => x != null);
  const tilt = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  // how unusual the weekday result is for this logic: (weekday − usual) / (spread of one trade / √trades)
  const sd = s.all?.t ? Math.abs(s.all.avg) * Math.sqrt(s.all.n) / Math.abs(s.all.t) : null;
  const z = day?.n && sd ? (day.avg - base) / (sd / Math.sqrt(day.n)) : 0;
  const reliable = !!(s.verdict?.consistent && (weekday === s.verdict.best || weekday === s.verdict.worst));
  const label = !day?.n ? 'no trades on this weekday'
    : reliable ? (weekday === s.verdict.best ? 'its best weekday — and that held in both halves of the history' : 'its worst weekday — and that held in both halves of the history')
      : z >= 0.5 ? 'better than its usual day in the past (probably chance)' : z <= -0.5 ? 'worse than its usual day in the past (probably chance)' : 'about its usual day';
  return { tilt, z, reliable, label, day: day || null, gap: g || null };
}

/**
 * The "What works today?" answer. `logic` = a strategy key from the study, or null for all.
 */
export async function whatWorksToday({ logic = null, now = new Date(), loadCandles = candles, study = loadDayPatterns(), papers = null } = {}) {
  if (!study?.strategies) return { error: 'The day-patterns study has not run yet (it runs with the Saturday re-tests).' };
  const date = dayInFocus(now);
  const weekday = weekdayOf(date);
  const t = new Date(now.getTime() + 19800_000);
  const isToday = date === iso(t);
  const gapPct = isToday && t.getUTCHours() * 60 + t.getUTCMinutes() >= 9 * 60 + 20 ? await openingGap({ loadCandles, date }) : null;
  const gap = gapKind(gapPct);
  const p = papers || { vwap: loadPaper(), breakfast: loadBreakfastPaper(), swing: loadAthPaper(), dip: loadNiftyDipPaper(), fo: loadFoStranglePaper() };
  // the strangle's weekday is its expiry day (an era, not a day effect): only when picked
  const list = study.strategies.filter((s) => (logic ? s.key === logic : s.key !== 'fo-strangle'));
  const rows = list.map((s) => {
    const rate = rateFor(s, weekday, gap);
    const unit = s.unit;
    // stocks (or sectors) on this weekday: best and worst by average, at least 2 trades
    const groups = Object.entries(s.byStock || {}).map(([sym, g]) => ({ symbol: sym.replace('.NS', ''), day: g[weekday] || null, all: g.all })).filter((x) => x.day?.n >= 2);
    groups.sort((a, b) => b.day.avg - a.day.avg);
    const sectors = Object.entries(s.bySector || {}).map(([name, g]) => ({ symbol: name, day: g[weekday] || null, all: g.all })).filter((x) => x.day?.n >= 2).sort((a, b) => b.day.avg - a.day.avg);
    return { key: s.key, name: s.name, unit, period: s.period, all: s.all, ...rate, bestStocks: groups.slice(0, 5), worstStocks: groups.slice(-5).reverse().filter((x) => !groups.slice(0, 5).includes(x)), sectors: sectors.slice(0, 6), recent: recentFor(s.key, p), note: s.verdict?.note || null };
  });
  rows.sort((a, b) => (b.reliable - a.reliable) || b.z - a.z);
  return {
    date, weekday, isToday, gapPct, gap,
    logics: study.strategies.map((s) => ({ key: s.key, name: s.name })),
    rows,
    studyAt: study.at,
    note: `${isToday ? 'Today' : `The next trading day (${date})`} is a ${weekday}${gap ? `, and NIFTY opened with a ${gap} (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%)` : isToday ? '; the opening type is added after 9:20' : ''}. Ranked by how each logic did on such days in its backtest compared with its usual day. Only the strong-stock swing weekday pattern held in both halves of the history; the rest rests on small samples. This describes the past — it does not say what will happen today. Research only — not investment advice.`,
  };
}

export { WEEKDAYS };
