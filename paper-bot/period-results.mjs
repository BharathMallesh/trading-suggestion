// Results for a period (library), for "Ask the app": "today's results",
// "yesterday", "this week", "last week", "this month", "last month", or a date
// ("23 Oct", "2026-10-23"). Sums every strategy's paper record over the period,
// with a day-by-day table for longer periods and the totals since the start.
// Read-only: built from the paper records the evening run writes. Paper only.

import { loadPaper } from './vwap-pullback.mjs';
import { loadBreakfastPaper, isFlatOpen } from './breakfast.mjs';
import { loadAthPaper, activeRules, RULES as ATH_RULES } from './ath-swing.mjs';
import { loadNiftyDipPaper, ofVersion } from './nifty-dip.mjs';
import { loadFoStranglePaper, loadFoCondorPaper } from './fo-strangle.mjs';
import { isTradingDay, lastSessionDate } from './market-calendar.mjs';
import { loadCoreSatellite } from './core-satellite.mjs';
import { loadMomentumPaper } from './momentum.mjs';
import { loadMomentum10Paper } from './momentum10.mjs';
import { loadSteadyMixPaper } from './steady-mix.mjs';
import { loadIndiaMixPaper } from './india-mix.mjs';
import { loadRsiSwingPaper } from './rsi-swing.mjs';
import { loadImbalancePaper } from './imbalance-swing.mjs';
import { loadSpreadPaper } from './spread-paper.mjs';

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
export function periodResults(period, { vwap = loadPaper(), breakfast = loadBreakfastPaper(), swing = loadAthPaper(), dip = loadNiftyDipPaper(), fo = loadFoStranglePaper(), condor = loadFoCondorPaper(), cs = loadCoreSatellite(), m20 = loadMomentumPaper(), m10 = loadMomentum10Paper(), steady = loadSteadyMixPaper(), india = loadIndiaMixPaper(), rsi = loadRsiSwingPaper(), imb = loadImbalancePaper(), spread = loadSpreadPaper(), swingVersion = activeRules() !== ATH_RULES ? 'improved' : 'original' } = {}) {
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
    const flat = all.filter((t) => isFlatOpen(t));
    const fp = flat.filter((t) => inRange(t.date, period));
    rows.push({ label: 'Breakfast · flat opens only (paper version)', unit: '₹', trades: fp.length, wins: fp.filter((t) => t.net > 0).length, result: sumNet(fp), totalTrades: flat.length, total: sumNet(flat), detail: [], version: true });
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
  // iron condor version of the strangle (a separate paper record; shown, not added to the totals)
  if (condor?.trades) {
    const all = condor.trades.filter((t) => !t.open);
    const p = all.filter((t) => inRange(t.expiry, period));
    rows.push({ label: 'NIFTY iron condor (1 lot, paper version)', unit: '₹', version: true, trades: p.length, wins: p.filter((t) => t.pts > 0).length, result: p.reduce((a, t) => a + t.rupees, 0), totalTrades: all.length, total: all.reduce((a, t) => a + t.rupees, 0), detail: p.length ? p.map((t) => `${t.putStrike}/${t.callStrike} + wings expiry ${t.expiry.slice(5)} ${rs(t.rupees)}`) : [condor.status?.message || 'no position'] });
  }
  // RSI swing and Imbalance swing (R, closed by exit date; open positions listed)
  for (const [label, st, version] of [['RSI swing', rsi, rsi?.version], ['Imbalance swing', imb, 'original']]) {
    if (!st?.trades) continue;
    const all = st.trades.filter((t) => !version || (t.version || 'original') === version);
    const closed = all.filter((t) => !t.open && inRange(t.exitDate, period));
    const open = all.filter((t) => t.open);
    for (const t of closed) addDay(t.exitDate, `${label} (R)`, t.r);
    rows.push({
      label, unit: 'R', trades: closed.length, wins: closed.filter((t) => t.r > 0).length, result: closed.reduce((a, t) => a + t.r, 0),
      totalTrades: all.filter((t) => !t.open).length, total: all.filter((t) => !t.open).reduce((a, t) => a + t.r, 0),
      detail: [...closed.map((t) => `sold ${t.symbol.replace('.NS', '')} ${t.exitDate.slice(5)} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)} R`), ...(open.length ? [`holding now: ${open.map((t) => `${t.symbol.replace('.NS', '')} ${t.r >= 0 ? '+' : ''}${(t.r ?? 0).toFixed(2)} R`).join(', ')}`] : [])],
    });
  }
  // the ₹10,000 spread paper tracker (₹, settled / sold in the period)
  if (spread?.trades) {
    const all = spread.trades.filter((t) => !t.open);
    const p = all.filter((t) => inRange(t.settleDate, period));
    const open = spread.trades.filter((t) => t.open);
    for (const t of p) addDay(t.settleDate, 'F&O spread tracker', t.pnl);
    rows.push({ label: 'F&O spread tracker (₹10,000 practice)', unit: '₹', trades: p.length, wins: p.filter((t) => t.pnl > 0).length, result: p.reduce((a, t) => a + t.pnl, 0), totalTrades: all.length, total: all.reduce((a, t) => a + t.pnl, 0),
      detail: [...p.map((t) => `${t.symbol} ${t.legs.map((l) => l.k).join('/')}${t.legs[0].t === 'CE' ? 'C' : 'P'} ${rs(t.pnl)}`), ...(open.length ? [`open now: ${open.map((t) => `${t.symbol} ${t.mark != null ? rs(t.mark) : ''}`).join(', ')}`] : [])] });
  }
  const rupeeRows = rows.filter((r) => r.unit === '₹' && !r.version); // versions re-count the same trades
  // the monthly investing portfolios (₹1,00,000 each on paper): change in value over the period, from their daily values
  const portfolios = [['Momentum 20', m20], ['Momentum 10 + buffer', m10], ['Steady mix (30/10/60)', steady], ['India mix (⅓ Next 50 / ⅓ gold / ⅓ Momentum 10)', india]].map(([label, st]) => {
    if (!st) return { label, started: null };
    const capital = st.capital || 100000;
    const curve = st.curve || [];
    const before = curve.filter((d) => d.date < period.from).pop()?.value ?? capital;
    const end = curve.filter((d) => d.date <= period.to).pop();
    const held = (st.rebalances?.at(-1)?.holdings || []).length;
    return { label, started: st.startedAt, capital, change: end && end.date >= period.from ? end.value - before : null, value: curve.at(-1)?.value ?? capital, asOf: curve.at(-1)?.date ?? null, held, beganAfter: st.startedAt > period.to };
  });
  // the 80/20 paper account: change in value over the period (not a trade count)
  let account = null;
  if (cs?.curve?.length) {
    const before = cs.curve.filter((d) => d.date < period.from).pop() || { m80: cs.capital, nifty: cs.capital };
    const end = cs.curve.filter((d) => d.date <= period.to).pop();
    if (end && end.date >= period.from) account = { m80: end.m80 - before.m80, nifty: end.nifty - before.nifty, value: end.m80, capital: cs.capital };
  }
  return {
    period, rows, account, portfolios,
    totalRs: rupeeRows.reduce((a, r) => a + r.result, 0),
    tradesInPeriod: rows.filter((r) => !r.version).reduce((a, r) => a + r.trades, 0),
    days: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    recordedUpTo: [vwap?.updatedAt, breakfast?.updatedAt, swing?.updatedAt].filter(Boolean).sort().pop() || null,
  };
}

/** "Ask the app" answer for a results question. */
export function resultsAnswer(question, { now = new Date(), live = null, ...papers } = {}) {
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
  for (const p of r.portfolios.filter((x) => x.change != null)) summary.push(`${p.label} (₹${Math.round(p.capital).toLocaleString('en-IN')} on paper): ${rs(p.change)} over the period (${((p.change / p.capital) * 100).toFixed(1)}%; now ₹${Math.round(p.value).toLocaleString('en-IN')}).`);
  const notYetStarted = r.portfolios.filter((x) => x.started && x.change == null);
  if (notYetStarted.length) summary.push(`${notYetStarted.map((x) => x.label.replace(/ \(.*\)$/, '')).join(', ')}: no result in this period yet (paper records started ${[...new Set(notYetStarted.map((x) => nice(x.started)))].join(' / ')}; their first holdings were bought at the next month-start).`);
  if (r.account) summary.push(`80/20 paper account (index fund + swing): ${rs(r.account.m80)} over the period (now ${'₹' + Math.round(r.account.value).toLocaleString('en-IN')}); 100% NIFTY: ${rs(r.account.nifty)}.`);
  // before the evening run: today's intraday trades so far, the same live view as Trading strategies (not final)
  const liveToday = period.notYet && live?.date === period.notYet ? Object.values(live.variants || {}) : null;
  if (liveToday) {
    const lt = liveToday.reduce((a, v) => a + v.trades.length, 0);
    summary.unshift(`Today so far (${nice(period.notYet)}, live${live.lastBar ? ` to ${live.lastBar}` : ''}): ${lt} intraday trade${lt === 1 ? '' : 's'} — ${liveToday.map((v) => `${v.label.replace(/ \(unproven\)$/, '')} ${rs(v.netRs)}`).join(' · ')}. Final after the 4:05 PM run.`);
  }
  if (period.notYet) summary.push(`Today's trades are recorded after the 4:05 PM run; the table shows ${period.label}.${liveToday ? ' Today\'s live intraday trades are at the top (the same as Trading strategies → Today\'s signals).' : ' For today\'s live trades see Trading strategies.'}`);
  if (!isTradingDay(period.from) && period.kind === 'day') summary.unshift(`${period.label}: NSE was closed (weekend or holiday).`);
  const sections = [];
  if (liveToday) sections.push({
    heading: `Today so far — live (${nice(period.notYet)}), not final`, kind: 'table',
    columns: ['Strategy', 'Trades', 'Result after charges', 'Trades'],
    rows: liveToday.map((v) => [v.label.replace(/ \(unproven\)$/, ''), v.trades.length, rs(v.netRs), v.trades.map((t) => `${String(t.symbol).replace('.NS', '')} ${t.side} ${t.time} ${t.open ? 'open' : t.reason} ${rs(t.net)}`).join(' · ') || '–']),
  });
  const idle = r.rows.filter((x) => !x.trades);
  sections.push({
    heading: `By strategy: ${period.label}`, kind: 'table',
    columns: ['Strategy', 'Trades', 'Won', 'Result', 'Since start'],
    rows: r.rows.filter((x) => x.trades).map((x) => [x.label, x.trades, `${x.wins}/${x.trades}`, fmt(x, x.result), `${fmt(x, x.total)} (${x.totalTrades})`]),
    note: idle.length ? `No trades in this period: ${idle.map((x) => x.label).join(', ')}.` : undefined,
  });
  if (r.portfolios.some((x) => x.started)) sections.push({
    heading: 'Investing portfolios (₹1,00,000 each, paper)', kind: 'table',
    columns: ['Portfolio', 'Paper since', `Change: ${period.label}`, 'Value now', 'Holdings'],
    rows: r.portfolios.filter((x) => x.started).map((x) => [x.label, nice(x.started), x.change != null ? `${rs(x.change)} (${((x.change / x.capital) * 100).toFixed(1)}%)` : 'not started yet', `₹${Math.round(x.value).toLocaleString('en-IN')}${x.asOf ? ` (${nice(x.asOf)})` : ''}`, x.held || '–']),
  });
  if (period.kind !== 'day' && r.days.length) {
    const cols = [...new Set(r.days.flatMap((d) => Object.keys(d).filter((k) => k !== 'date')))];
    sections.push({ heading: 'Day by day', kind: 'table', columns: ['Day', ...cols.map((c) => c.replace('YouTube intraday · ', 'YouTube ')), 'Total ₹'], rows: r.days.map((d) => [nice(d.date), ...cols.map((c) => (d[c] == null ? '–' : c.endsWith('(R)') ? `${d[c] >= 0 ? '+' : ''}${d[c].toFixed(2)} R` : rs(d[c]))), rs(cols.filter((c) => !c.endsWith('(R)')).reduce((a, c) => a + (d[c] || 0), 0))]) });
  }
  const details = r.rows.filter((x) => x.detail.length).map((x) => `${x.label}: ${x.detail.slice(0, 12).join(' · ')}${x.detail.length > 12 ? ` · … ${x.detail.length - 12} more` : ''}`);
  if (details.length) sections.push({ heading: 'Trades', kind: 'list', items: details });
  // the short view: a few numbers on top, the rest folded (the summary list stays for the evening note / other uses)
  const rupee = r.rows.filter((x) => x.unit === '₹' && !x.version && x.trades);
  const started = r.portfolios.filter((x) => x.change != null);
  const highlights = [
    ...(liveToday ? [{ label: `Today so far (live, ${nice(period.notYet)})`, value: rs(liveToday.reduce((a, v) => a + v.netRs, 0)), sub: `${liveToday.reduce((a, v) => a + v.trades.length, 0)} intraday trades · final after 4:05 PM`, tone: Math.sign(liveToday.reduce((a, v) => a + v.netRs, 0)) }] : []),
    { label: `Trading · ${period.label}`, value: r.tradesInPeriod ? rs(r.totalRs) : '–', sub: r.tradesInPeriod ? `${r.tradesInPeriod} trades · ${r.rows.filter((x) => !x.version).reduce((a, x) => a + x.wins, 0)} won` : 'no trades closed', tone: Math.sign(r.totalRs) },
    { label: 'Investing portfolios', value: started.length ? rs(started.reduce((a, x) => a + x.change, 0)) : '–', sub: started.length ? `${started.length} portfolios · ₹${(started.reduce((x, p) => x + p.capital, 0) / 1e5).toLocaleString('en-IN')} lakh on paper` : 'no result in this period yet', tone: Math.sign(started.reduce((a, x) => a + x.change, 0)) },
    ...(r.account ? [{ label: '80/20 account', value: rs(r.account.m80), sub: `100% NIFTY: ${rs(r.account.nifty)}`, tone: Math.sign(r.account.m80) }] : []),
  ];
  const sorted = [...rupee].sort((a, b) => b.result - a.result);
  const brief = [
    ...(sorted.length ? [`Best: ${sorted[0].label} ${rs(sorted[0].result)}${sorted.length > 1 ? ` · worst: ${sorted.at(-1).label} ${rs(sorted.at(-1).result)}` : ''}.`] : []),
    ...(period.notYet ? [`Trading numbers are for ${period.label}; today's are saved after the 4:05 PM run.`] : []),
    ...(!isTradingDay(period.from) && period.kind === 'day' ? [`${period.label}: NSE was closed.`] : []),
  ];
  return {
    highlights, brief,
    intent: 'results', title: liveToday ? `Results: today so far (${nice(period.notYet)}, live) and ${period.label}` : `Results: ${period.label}`, summary, sections,
    caveat: 'Paper trades only, after all charges, at the standard size (₹1,000 risk per intraday trade; 1 lot for the strangle; swing in R = multiples of the risk taken). A few days or weeks say little about whether a strategy works — see Trading strategies → Compare all for the full record. Not investment advice.',
  };
}
