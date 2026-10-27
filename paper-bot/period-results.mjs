// Results for a period (library), for "Ask the app": "today's results",
// "yesterday", "this week", "last week", "this month", "last month", or a date
// ("23 Oct", "2026-10-23"). Sums every strategy's paper record over the period,
// with a day-by-day table for longer periods and the totals since the start.
// Read-only: built from the paper records the evening run writes. Paper only.

import { loadPaper } from './vwap-pullback.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadAthPaper, activeRules, RULES as ATH_RULES } from './ath-swing.mjs';
import { loadNiftyDipPaper, ofVersion } from './nifty-dip.mjs';
import { loadFoStranglePaper } from './fo-strangle.mjs';
import { isTradingDay, lastSessionDate } from './market-calendar.mjs';
import { loadCoreSatellite } from './core-satellite.mjs';

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000));
const istToday = (now) => iso(new Date(now.getTime() + 19800_000));
const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const nice = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Does the question ask for results / P&L? */
export function isResultsQuestion(question) {
  const q = String(question).toLowerCase();
  return /\b(results?|p\s*&\s*l|pnl|profit|loss|earn(ed|ings)?|made|performance|report|how (did|was|were)\b.*\b(do|perform|go|went|day|week|month))\b/.test(q)
    || /^\s*(today|yesterday|this week|last week|this month|last month|week|month)\s*\??\s*$/.test(q);
}

/** The period a question asks about → { from, to, label, kind }. */
export function parsePeriod(question, now = new Date()) {
  const q = String(question).toLowerCase();
  const today = istToday(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDays(today, -dow);
  const [y, m] = today.split('-').map(Number);
  const explicit = q.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/) || q.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (explicit) {
    const d = explicit[0].includes('-') ? explicit[0] : `${y}-${String(MON.indexOf(explicit[2]) + 1).padStart(2, '0')}-${String(explicit[1]).padStart(2, '0')}`;
    const date = d > today ? `${y - 1}${d.slice(4)}` : d;
    return { from: date, to: date, label: nice(date), kind: 'day' };
  }
  if (/\blast month\b|\bprevious month\b/.test(q)) {
    const first = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
    const last = addDays(`${y}-${String(m).padStart(2, '0')}-01`, -1);
    return { from: first, to: last, label: new Date(`${first}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }), kind: 'month' };
  }
  if (/\bmonth\b|\bmtd\b/.test(q)) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    return { from: first, to: today, label: `this month (${new Date(`${first}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })} so far)`, kind: 'month' };
  }
  if (/\blast week\b|\bprevious week\b/.test(q)) return { from: addDays(monday, -7), to: addDays(monday, -1), label: `last week (${nice(addDays(monday, -7))} – ${nice(addDays(monday, -3))})`, kind: 'week' };
  if (/\bweek\b|\bwtd\b/.test(q)) return { from: monday, to: today, label: `this week (from ${nice(monday)})`, kind: 'week' };
  if (/\byesterday\b/.test(q)) {
    const d = lastSessionDate(new Date(`${today}T00:00:00+05:30`)); // the trading day before today
    return { from: d, to: d, label: `yesterday (${nice(d)})`, kind: 'day' };
  }
  // today (default): the latest trading day whose results exist
  const t = new Date(now.getTime() + 19800_000);
  const afterRun = t.getUTCHours() * 60 + t.getUTCMinutes() >= 16 * 60 + 5;
  // before the evening run, today has no record yet: use the trading day before it
  const d = isTradingDay(today) && afterRun ? today : isTradingDay(today) ? lastSessionDate(new Date(`${today}T00:00:00+05:30`)) : lastSessionDate(now);
  return { from: d, to: d, label: d === today ? `today (${nice(d)})` : `the latest trading day (${nice(d)})`, kind: 'day', notYet: isTradingDay(today) && !afterRun ? today : null };
}

const inRange = (d, p) => d && d >= p.from && d <= p.to;
const sumNet = (a) => a.reduce((x, t) => x + (t.net ?? 0), 0);

/** Every strategy's result over a period. */
export function periodResults(period, { vwap = loadPaper(), breakfast = loadBreakfastPaper(), swing = loadAthPaper(), dip = loadNiftyDipPaper(), fo = loadFoStranglePaper(), cs = loadCoreSatellite(), swingVersion = activeRules() !== ATH_RULES ? 'improved' : 'original' } = {}) {
  const rows = [];
  const byDay = new Map(); // date → { strategy → ₹ }
  const addDay = (d, k, v) => {
    if (!byDay.has(d)) byDay.set(d, {});
    byDay.get(d)[k] = (byDay.get(d)[k] || 0) + v;
  };
  // YouTube intraday (₹)
  const vt = vwap?.trades || [];
  for (const [k, label] of [['video', 'YouTube intraday · video rules'], ['improved', 'YouTube intraday · improved'], ['scanner', 'YouTube intraday · scanner']]) {
    const all = vt.filter((t) => (t.variant || 'video') === k);
    const p = all.filter((t) => inRange(t.date, period));
    for (const t of p) addDay(t.date, label, t.net);
    rows.push({ label, unit: '₹', trades: p.length, wins: p.filter((t) => t.net > 0).length, result: sumNet(p), totalTrades: all.length, total: sumNet(all), detail: p.map((t) => `${t.date.slice(5)} ${t.symbol.replace('.NS', '')} ${t.side} ${t.reason} ${rs(t.net)}`) });
  }
  // Breakfast (₹)
  {
    const all = breakfast?.trades || [];
    const p = all.filter((t) => inRange(t.date, period));
    for (const t of p) addDay(t.date, 'Breakfast', t.net);
    rows.push({ label: 'Breakfast', unit: '₹', trades: p.length, wins: p.filter((t) => t.net > 0).length, result: sumNet(p), totalTrades: all.length, total: sumNet(all), detail: p.map((t) => `${t.date.slice(5)} ${t.symbol.replace('.NS', '')} ${t.side} ${t.reason} ${rs(t.net)}`) });
  }
  // Strong-stock swing (R; closed by exit date, plus buys in the period and positions held now)
  {
    const all = (swing?.trades || []).filter((t) => (t.version || 'original') === swingVersion);
    const closed = all.filter((t) => !t.open && inRange(t.exitDate, period));
    const bought = all.filter((t) => inRange(t.entryDate, period));
    const open = all.filter((t) => t.open);
    for (const t of closed) addDay(t.exitDate, 'Strong-stock swing (R)', t.r);
    rows.push({
      label: `Strong-stock swing (${swingVersion} rules)`, unit: 'R', trades: closed.length, wins: closed.filter((t) => t.r > 0).length, result: closed.reduce((a, t) => a + t.r, 0),
      totalTrades: all.filter((t) => !t.open).length, total: all.filter((t) => !t.open).reduce((a, t) => a + t.r, 0),
      detail: [...bought.map((t) => `bought ${t.symbol.replace('.NS', '')} on ${t.entryDate.slice(5)}`), ...closed.map((t) => `sold ${t.symbol.replace('.NS', '')} ${t.exitDate.slice(5)} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)} R`), ...(open.length ? [`holding now: ${open.map((t) => `${t.symbol.replace('.NS', '')} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)} R`).join(', ')}`] : [])],
    });
  }
  // NIFTY dip-buy (₹, standard version, by exit date)
  {
    const all = ofVersion(dip?.trades, 'standard').filter((t) => !t.open);
    const p = all.filter((t) => inRange(t.exitDate, period));
    for (const t of p) addDay(t.exitDate, 'NIFTY dip-buy', t.net);
    rows.push({ label: 'NIFTY dip-buy', unit: '₹', trades: p.length, wins: p.filter((t) => t.net > 0).length, result: sumNet(p), totalTrades: all.length, total: sumNet(all), detail: p.length ? p.map((t) => `${t.entryDate.slice(5)} → ${t.exitDate.slice(5)} ${rs(t.net)}`) : [dip?.status?.message || 'no signal'] });
  }
  // NIFTY short strangle (₹ per lot, by expiry)
  {
    const all = (fo?.trades || []).filter((t) => !t.open);
    const p = all.filter((t) => inRange(t.expiry, period));
    for (const t of p) addDay(t.expiry, 'NIFTY short strangle', t.rupees);
    rows.push({ label: 'NIFTY short strangle (1 lot)', unit: '₹', trades: p.length, wins: p.filter((t) => t.pts > 0).length, result: p.reduce((a, t) => a + t.rupees, 0), totalTrades: all.length, total: all.reduce((a, t) => a + t.rupees, 0), detail: p.length ? p.map((t) => `${t.putStrike}/${t.callStrike} expiry ${t.expiry.slice(5)} ${rs(t.rupees)}`) : [fo?.status?.message || 'no position'] });
  }
  const rupeeRows = rows.filter((r) => r.unit === '₹');
  // the 80/20 paper account: change in value over the period (not a trade count)
  let account = null;
  if (cs?.curve?.length) {
    const before = cs.curve.filter((d) => d.date < period.from).pop() || { m80: cs.capital, nifty: cs.capital };
    const end = cs.curve.filter((d) => d.date <= period.to).pop();
    if (end && end.date >= period.from) account = { m80: end.m80 - before.m80, nifty: end.nifty - before.nifty, value: end.m80, capital: cs.capital };
  }
  return {
    period, rows, account,
    totalRs: rupeeRows.reduce((a, r) => a + r.result, 0),
    tradesInPeriod: rows.reduce((a, r) => a + r.trades, 0),
    days: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    recordedUpTo: [vwap?.updatedAt, breakfast?.updatedAt, swing?.updatedAt].filter(Boolean).sort().pop() || null,
  };
}

/** "Ask the app" answer for a results question. */
export function resultsAnswer(question, { now = new Date(), ...papers } = {}) {
  const period = parsePeriod(question, now);
  const r = periodResults(period, papers);
  const fmt = (row, v) => (row.unit === 'R' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)} R` : rs(v));
  const active = r.rows.filter((x) => x.trades);
  const summary = [
    r.tradesInPeriod
      ? `${r.tradesInPeriod} closed paper trade${r.tradesInPeriod === 1 ? '' : 's'} · total ${rs(r.totalRs)} across the rupee strategies${active.some((x) => x.unit === 'R') ? ' (swing shown in R)' : ''}.`
      : 'No paper trades closed in this period.',
    ...active.map((x) => `${x.label}: ${x.trades} trade${x.trades === 1 ? '' : 's'}, ${x.wins} won, ${fmt(x, x.result)}`),
  ];
  if (r.account) summary.push(`80/20 paper account (index fund + swing): ${rs(r.account.m80)} over the period (now ${'₹' + Math.round(r.account.value).toLocaleString('en-IN')}); 100% NIFTY: ${rs(r.account.nifty)}.`);
  if (period.notYet) summary.push(`Today's trades are recorded after the 4:05 PM run; this shows ${period.label}. For today's live trades see Trading strategies.`);
  if (!isTradingDay(period.from) && period.kind === 'day') summary.unshift(`${period.label}: NSE was closed (weekend or holiday).`);
  const sections = [{
    heading: `By strategy: ${period.label}`, kind: 'table',
    columns: ['Strategy', 'Trades', 'Won', 'Result', 'Since start'],
    rows: r.rows.map((x) => [x.label, x.trades, x.trades ? `${x.wins}/${x.trades}` : '–', x.trades ? fmt(x, x.result) : '–', `${fmt(x, x.total)} (${x.totalTrades})`]),
  }];
  if (period.kind !== 'day' && r.days.length) {
    const cols = [...new Set(r.days.flatMap((d) => Object.keys(d).filter((k) => k !== 'date')))];
    sections.push({ heading: 'Day by day', kind: 'table', columns: ['Day', ...cols.map((c) => c.replace('YouTube intraday · ', 'YouTube ')), 'Total ₹'], rows: r.days.map((d) => [nice(d.date), ...cols.map((c) => (d[c] == null ? '–' : c.endsWith('(R)') ? `${d[c] >= 0 ? '+' : ''}${d[c].toFixed(2)} R` : rs(d[c]))), rs(cols.filter((c) => !c.endsWith('(R)')).reduce((a, c) => a + (d[c] || 0), 0))]) });
  }
  const details = r.rows.filter((x) => x.detail.length).map((x) => `${x.label}: ${x.detail.slice(0, 12).join(' · ')}${x.detail.length > 12 ? ` · … ${x.detail.length - 12} more` : ''}`);
  if (details.length) sections.push({ heading: 'Trades', kind: 'list', items: details });
  return {
    intent: 'results', title: `Results: ${period.label}`, summary, sections,
    caveat: 'Paper trades only, after all charges, at the standard size (₹1,000 risk per intraday trade; 1 lot for the strangle; swing in R = multiples of the risk taken). A few days or weeks say little about whether a strategy works — see Trading strategies → Compare all for the full record. Not investment advice.',
  };
}
