#!/usr/bin/env node
// Index-option expiry calendar (library + CLI) and the expiry-day warning.
//
// The weekday rule is NOT typed in from memory: it is read from the expiry dates that are actually present in the
// app's cached exchange files, and the holiday shift is checked against the NSE trading calendar (market-calendar.mjs):
//   • NIFTY weekly (NSE): every expiry date in paper-bot/data/fo-bhav/*.json (the nearest weekly per day),
//     fo-bhav-mc/*.json ("all" = every listed NIFTY expiry) and fo-hist/expiries/NIFTY-*.json.
//   • SENSEX weekly (BSE): paper-bot/data/bse-sensex-expiries.json (expiries seen in BSE's daily derivatives
//     bhavcopy, saved from the loop-21 study).
//   • Stock options (NSE, monthly): the expiries in the latest paper-bot/data/fo-stocks/*.json.
// Rule found (Nov 2026 data): NIFTY weekly = Tuesday, SENSEX weekly = Thursday; monthly = the last such weekday of the
// month; when that day is a holiday the expiry moves to the PREVIOUS trading day (e.g. NIFTY 24 Nov 2026, Guru Nanak
// Jayanti → Mon 23 Nov). BSE holidays are taken as NSE's (they match for trading holidays).
//
// Why warn: SEBI's FY25–26 study — 59–70% of index-option turnover is on expiry day itself and 75–80% within one day
// of it; prop / algo firms make ~98% of their profit in options while retail option buyers lose most there; SEBI's
// Jane Street interim order (3 Jul 2025; under appeal, SAT orders reserved 21 Oct 2026) alleged expiry-day index
// manipulation. The app's own tests: buying options on expiry day or the day before lost in every version. Not advice.
//
//   node paper-bot/expiry.mjs            # today's status, the rule and its evidence, the next expiries

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTradingDay, holidays } from './market-calendar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = () => process.env.EXPIRY_DATA_DIR || join(HERE, 'data');
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(`${d}T00:00:00Z`) + n * 86400000);
const wdOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const todayIst = (now) => iso(now.getTime() + 19800_000);
const istMins = (now) => {
  const t = new Date(now.getTime() + 19800_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
};

export const INDEXES = {
  NIFTY: { exchange: 'NSE', name: 'NIFTY', weekly: true },
  SENSEX: { exchange: 'BSE', name: 'SENSEX', weekly: true },
};
// what each monthly line covers (NSE monthly = the same weekday as NIFTY's weekly)
export const MONTHLY = {
  NIFTY: 'NIFTY monthly (and NSE\'s other monthly index options)',
  SENSEX: 'SENSEX monthly',
  STOCKS: 'NSE stock options (monthly)',
};

export const RESEARCH = {
  sebi: 'SEBI FY25–26 study: 59–70% of index-option turnover is on expiry day itself, 75–80% within one day of it.',
  prop: 'Prop / algo firms make ~98% of their profit in options; retail option buyers lose most of their money there.',
  jane: 'SEBI\'s Jane Street interim order (3 Jul 2025) alleged expiry-day index manipulation — under appeal; SAT orders reserved 21 Oct 2026, no final ruling.',
  ours: 'The app\'s own tests: buying options on expiry day or the day before lost money in every version.',
  advice: 'Don\'t buy options today; if you must trade, use limit orders and defined risk.',
};

// ------------------------------------------------------------- the observed dates ---
const readJ = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : []);

const obsCache = new Map();
/** Expiry dates actually present in the cached exchange files: { dates: [...], lastDataDate, sources: [...] }. */
export function observedExpiries(index) {
  const key = `${DATA()}|${index}`;
  if (obsCache.has(key)) return obsCache.get(key);
  const dates = new Set();
  const sources = [];
  let lastDataDate = null;
  const seen = (d) => { if (d > (lastDataDate || '')) lastDataDate = d; };
  if (index === 'NIFTY') {
    const fb = join(DATA(), 'fo-bhav');
    const files = listJson(fb).filter((f) => f >= '2025-01-01');
    for (const f of files) {
      const j = readJ(join(fb, f));
      for (const e of Object.keys(j?.expiries || {})) dates.add(e);
      seen(f.slice(0, 10));
    }
    if (files.length) sources.push(`NSE F&O bhavcopy, nearest NIFTY weekly (fo-bhav, ${files.length} days ${files[0].slice(0, 10)} → ${files.at(-1).slice(0, 10)})`);
    const mc = join(DATA(), 'fo-bhav-mc');
    const mfiles = listJson(mc).filter((f) => f >= '2025-01-01');
    for (const f of mfiles.slice(-3)) {
      const j = readJ(join(mc, f));
      for (const e of j?.all || []) dates.add(e);
      seen(f.slice(0, 10));
    }
    if (mfiles.length) sources.push(`NSE F&O bhavcopy, every listed NIFTY expiry (fo-bhav-mc, latest ${mfiles.at(-1).slice(0, 10)})`);
    const hd = join(DATA(), 'fo-hist', 'expiries');
    if (existsSync(hd)) for (const f of readdirSync(hd).filter((x) => /^NIFTY-20(2[5-9]|[3-9]\d)\.json$/.test(x))) {
      for (const e of readJ(join(hd, f)) || []) dates.add(e);
      sources.push(`NSE NIFTY expiry list (fo-hist/expiries/${f})`);
    }
  } else if (index === 'SENSEX') {
    const j = readJ(join(DATA(), 'bse-sensex-expiries.json'));
    for (const e of j?.expiries || []) dates.add(e);
    if (j?.lastDate) seen(j.lastDate);
    if (j) sources.push(j.source || 'BSE derivatives bhavcopy');
  } else if (index === 'STOCKS') {
    const fs = join(DATA(), 'fo-stocks');
    const files = listJson(fs);
    for (const f of files.slice(-25)) {
      const j = readJ(join(fs, f));
      for (const o of Object.values(j || {})) for (const e of Object.keys(o?.expiries || {})) dates.add(e);
      seen(f.slice(0, 10));
    }
    if (files.length) sources.push(`NSE F&O bhavcopy, stock options (fo-stocks, latest ${files.at(-1).slice(0, 10)})`);
  }
  const out = { index, dates: [...dates].sort(), lastDataDate, sources };
  obsCache.set(key, out);
  return out;
}
/** Forget cached observations (tests). */
export function resetExpiryCache() {
  obsCache.clear();
  monthSessions.clear();
  ruleCache.clear();
}

// Sessions NSE actually traded in a month, from the app's NSE equity bhavcopy store (one key per session). Used only for
// years the saved holiday list doesn't cover (it has 2026), so a 2025 holiday shift is recognised from the data too.
const monthSessions = new Map();
function tradedIn(month) {
  if (monthSessions.has(month)) return monthSessions.get(month);
  let set = null;
  try {
    const f = join(process.env.BHAV_EQ_DIR || join(DATA(), 'bhav-eq'), `${month}.json.gz`);
    if (existsSync(f)) set = new Set(Object.keys(JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'))));
  } catch {
    set = null;
  }
  monthSessions.set(month, set);
  return set;
}
/** Was `d` an exchange holiday? The NSE calendar, and for years it doesn't list, a weekday missing from NSE's daily files. */
export function closedDay(d) {
  if (!isTradingDay(d)) return true;
  const year = d.slice(0, 4);
  if (Object.keys(holidays()).some((h) => h.startsWith(year))) return false;
  const s = tradedIn(d.slice(0, 7));
  return !!s && s.size > 0 && [...s].some((x) => x > d) && !s.has(d);
}

/** The weekday an observed expiry stands for: its own weekday, or a later weekday whose days in between (and itself) were all holidays (the shift-back rule). */
function nominalWeekdays(date) {
  const out = [wdOf(date)];
  for (let k = 1; k <= 4; k++) {
    const d = addDays(date, k);
    const w = wdOf(d);
    if (w === 0 || w === 6) break;
    if (!closedDay(d)) break;
    out.push(w); // d is a weekday holiday: the expiry may have moved back from here
  }
  return out;
}

const ruleCache = new Map();
/**
 * The CURRENT weekly weekday rule, from the latest observed expiries: the weekday that explains the most of the last
 * `recent` weekly expiries (counting a date that sits just before a holiday as that holiday's weekday), with the
 * evidence: how many matched directly, which were shifted (and the holiday), any that don't fit, and since when the
 * run of that weekday has held.
 */
export function deriveWeekdayRule(index = 'NIFTY', { recent = 26 } = {}) {
  const key = `${DATA()}|${index}|${recent}`;
  if (ruleCache.has(key)) return ruleCache.get(key);
  const obs = observedExpiries(index);
  // weekly = one expiry per ISO week (the earliest listed date of that week; duplicates = re-listings)
  const byWeek = new Map();
  for (const d of obs.dates) {
    const monday = addDays(d, -((wdOf(d) + 6) % 7));
    if (!byWeek.has(monday)) byWeek.set(monday, []);
    byWeek.get(monday).push(d);
  }
  const weeks = [...byWeek.keys()].sort();
  const upto = obs.lastDataDate ? addDays(obs.lastDataDate, 45) : null; // listed-ahead expiries count too
  const recentWeeks = weeks.filter((w) => !upto || w <= upto).slice(-recent);
  const fits = (dates, w) => dates.some((d) => nominalWeekdays(d).includes(w));
  let best = null;
  for (let w = 1; w <= 5; w++) {
    const n = recentWeeks.filter((wk) => fits(byWeek.get(wk), w)).length;
    if (!best || n > best.n) best = { w, n };
  }
  if (!best || !recentWeeks.length) {
    const r = { index, weekday: null, found: false, note: `No ${index} expiry dates in the cached files.`, sources: obs.sources };
    ruleCache.set(key, r);
    return r;
  }
  const direct = [];
  const shifted = [];
  const other = [];
  for (const wk of recentWeeks) {
    const ds = byWeek.get(wk);
    const d = ds.find((x) => wdOf(x) === best.w) || ds.find((x) => nominalWeekdays(x).includes(best.w)) || ds[0];
    if (wdOf(d) === best.w) direct.push(d);
    else if (nominalWeekdays(d).includes(best.w)) {
      const nominal = addDays(d, (best.w - wdOf(d) + 7) % 7);
      shifted.push({ date: d, weekday: WD[wdOf(d)], nominal, holiday: holidays()[nominal] || 'no NSE session that day' });
    } else other.push({ date: d, weekday: WD[wdOf(d)] });
  }
  // since when: walk back over all weeks while the weekday still fits
  // (one odd week is tolerated and listed — e.g. a Diwali week with only a muhurat session; two in a row end the run)
  let since = byWeek.get(recentWeeks[0])[0];
  const odd = [];
  for (let i = weeks.indexOf(recentWeeks[0]) - 1; i >= 0; i--) {
    const ds = byWeek.get(weeks[i]);
    if (fits(ds, best.w)) { since = ds[0]; continue; }
    if (i > 0 && fits(byWeek.get(weeks[i - 1]), best.w)) { odd.push(`${ds[0]} ${WD[wdOf(ds[0])].slice(0, 3)}`); continue; }
    break;
  }
  const sinceOdd = odd.filter((o) => o.slice(0, 10) > since);
  const before = weeks.filter((wk) => byWeek.get(wk)[0] < since).slice(-3).map((wk) => byWeek.get(wk)[0]);
  const r = {
    index, exchange: INDEXES[index]?.exchange || 'NSE', found: best.n / recentWeeks.length >= 0.8,
    weekday: best.w, weekdayName: WD[best.w], weeks: recentWeeks.length, matched: best.n,
    from: byWeek.get(recentWeeks[0])[0], to: byWeek.get(recentWeeks.at(-1)).at(-1),
    direct: direct.length, shifted, other, since, odd: sinceOdd, before: before.map((d) => `${d} ${WD[wdOf(d)].slice(0, 3)}`),
    lastDataDate: obs.lastDataDate, sources: obs.sources,
  };
  r.note = `${index} weekly expiry = ${r.weekdayName}: ${r.matched} of the last ${r.weeks} weekly expiries (${r.from} → ${r.to}) — ${r.direct} on a ${r.weekdayName}, ${shifted.length} moved to the previous trading day for a holiday${shifted.length ? ` (${shifted.map((s) => `${s.date} for ${s.nominal} ${s.holiday}`).join('; ')})` : ''}${other.length ? `, ${other.length} other (${other.map((o) => `${o.date} ${o.weekday}`).join(', ')})` : ''}. On ${r.weekdayName}s since ${since}${sinceOdd.length ? ` (one-off: ${sinceOdd.join(', ')})` : ''}${r.before.length ? ` (before: ${r.before.join(', ')})` : ''}.`;
  ruleCache.set(key, r);
  return r;
}

/** Monthly check from the data: is the last observed expiry of each month the last `weekday` of that month (after the shift)? */
export function monthlyCheck(index = 'NIFTY', weekday = weekdayOf(index)) {
  const obs = observedExpiries(index === 'STOCKS' ? 'STOCKS' : index);
  const byMonth = new Map();
  for (const d of obs.dates) byMonth.set(d.slice(0, 7), d > (byMonth.get(d.slice(0, 7)) || '') ? d : byMonth.get(d.slice(0, 7)));
  const lastMonth = obs.lastDataDate ? addDays(obs.lastDataDate, 62).slice(0, 7) : '9999-12';
  const months = [...byMonth.keys()].sort().filter((m) => m >= '2025-10' && m <= lastMonth).slice(-8);
  const rows = months.map((m) => ({ month: m, observed: byMonth.get(m), rule: monthlyExpiryFor(m, weekday) }));
  // a month whose data stops early (the latest month) can only be checked if its rule date was listed
  const checked = rows.filter((r) => r.observed >= r.rule || obs.dates.includes(r.rule));
  const ok = checked.filter((r) => r.observed === r.rule || obs.dates.includes(r.rule));
  return { index, weekday, months: rows, checked: checked.length, matched: ok.length };
}

// ------------------------------------------------------------- the calendar ---
/** Move a nominal expiry back to the previous trading day when it is a holiday. */
export function shiftBack(date) {
  let d = date;
  for (let k = 0; k < 10 && !isTradingDay(d); k++) d = addDays(d, -1);
  return d;
}
/** Weekly expiry in the ISO week of `date` for a weekday rule. */
export function weeklyExpiryFor(date, weekday) {
  const monday = addDays(date, -((wdOf(date) + 6) % 7));
  return shiftBack(addDays(monday, weekday - 1));
}
/** Monthly expiry (the last `weekday` of the month, shifted back) for 'YYYY-MM'. */
export function monthlyExpiryFor(month, weekday) {
  const [y, m] = month.split('-').map(Number);
  let d = iso(Date.UTC(y, m, 0)); // last calendar day
  while (wdOf(d) !== weekday) d = addDays(d, -1);
  return shiftBack(d);
}

const weekdayOf = (index) => {
  if (index === 'STOCKS') return deriveWeekdayRule('NIFTY').weekday; // NSE monthly contracts expire on NSE's expiry weekday
  return deriveWeekdayRule(index).weekday;
};
/** Prefer a date the exchange actually listed in the same week (covers one-off exchange decisions). */
function listedOr(index, computed) {
  const obs = observedExpiries(index);
  if (obs.dates.includes(computed)) return computed;
  const monday = addDays(computed, -((wdOf(computed) + 6) % 7));
  const inWeek = obs.dates.filter((d) => d >= monday && d <= addDays(monday, 6) && isTradingDay(d));
  return inWeek.length ? inWeek[0] : computed;
}

/** Monthly expiry of `index` for 'YYYY-MM' (the rule date, or the date the exchange listed in that week). */
export function monthlyFor(index, month) {
  const w = weekdayOf(index);
  return w == null ? null : listedOr(index, monthlyExpiryFor(month, w));
}

/** What expires on `date`: [{ index, kind: 'weekly' | 'monthly', exchange, label }]. */
export function expiriesOn(date) {
  if (!isTradingDay(date)) return [];
  const out = [];
  for (const index of Object.keys(INDEXES)) {
    const w = weekdayOf(index);
    if (w == null) continue;
    const month = monthlyFor(index, date.slice(0, 7));
    const weekly = listedOr(index, weeklyExpiryFor(date, w));
    if (date === month) out.push({ index, kind: 'monthly', exchange: INDEXES[index].exchange, label: `${index} weekly + monthly` });
    else if (date === weekly) out.push({ index, kind: 'weekly', exchange: INDEXES[index].exchange, label: `${index} weekly` });
  }
  if (weekdayOf('STOCKS') != null && date === monthlyFor('STOCKS', date.slice(0, 7))) out.push({ index: 'STOCKS', kind: 'monthly', exchange: 'NSE', label: 'NSE stock options (monthly)' });
  return out;
}

/** Is `date` an expiry day for `index` ('NIFTY' | 'SENSEX' | 'STOCKS'; 'ANY' = any of them)? */
export function isExpiryDay(date, index = 'ANY') {
  const xs = expiriesOn(date);
  return index === 'ANY' ? xs.length > 0 : xs.some((x) => x.index === index);
}
/** Next trading day after `date`. */
export function nextSession(date) {
  let d = addDays(date, 1);
  for (let k = 0; k < 12 && !isTradingDay(d); k++) d = addDays(d, 1);
  return d;
}
/** Is `date` the trading day before an expiry day of `index`? */
export function isDayBeforeExpiry(date, index = 'ANY') {
  return isTradingDay(date) && isExpiryDay(nextSession(date), index);
}
/** The session a plan or a trade placed `now` is for: today until the 15:30 IST close on a trading day, else the next trading day. */
export function sessionFor(now = new Date()) {
  const today = todayIst(now);
  return isTradingDay(today) && istMins(now) < 930 ? today : nextSession(today);
}
/** Trading sessions from `tradeDate` to `expiry` (0 = the expiry day itself, 1 = the day before). */
export function sessionsToExpiry(tradeDate, expiry) {
  if (expiry <= tradeDate) return 0;
  let n = 0;
  for (let d = nextSession(tradeDate); d <= expiry && n < 400; d = nextSession(d)) n++;
  return n;
}

/** The next weekly and monthly expiry of each index (and stock options) on or after `from`. */
export function nextExpiries(from = todayIst(new Date())) {
  const out = [];
  for (const index of [...Object.keys(INDEXES), 'STOCKS']) {
    const w = weekdayOf(index);
    if (w == null) continue;
    let weekly = null;
    if (index !== 'STOCKS') {
      for (let k = 0; k < 3 && !weekly; k++) {
        const d = listedOr(index, weeklyExpiryFor(addDays(from, 7 * k), w));
        if (d >= from) weekly = d;
      }
    }
    let monthly = monthlyFor(index, from.slice(0, 7));
    if (monthly < from) {
      const [y, m] = from.split('-').map(Number);
      monthly = monthlyFor(index, iso(Date.UTC(y, m, 1)).slice(0, 7));
    }
    out.push({ index, exchange: index === 'SENSEX' ? 'BSE' : 'NSE', weekday: WD[w], weekly, monthly, label: index === 'STOCKS' ? MONTHLY.STOCKS : index });
  }
  return out;
}

const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const names = (xs) => [...new Set(xs.map((x) => (x.index === 'STOCKS' ? 'stock-option' : x.kind === 'monthly' ? `${x.index} monthly` : x.index)))].join(' / ');

/**
 * Status for the warning banners and notifications: the session in question (today until the close, else the next
 * trading day), what expires on it and on the session after, and the banner level: 'expiry' (red) on an expiry day,
 * 'eve' (amber) on the day before, else 'none'.
 */
export function expiryStatus(now = new Date()) {
  const today = todayIst(now);
  const session = sessionFor(now);
  const after = nextSession(session);
  const onSession = expiriesOn(session);
  const onAfter = expiriesOn(after);
  const sessionIsToday = session === today;
  const when = sessionIsToday ? 'Today' : `Next session (${dayLabel(session)})`;
  let level = 'none';
  let title = null;
  let short = null;
  if (onSession.length) {
    level = 'expiry';
    title = `${when} is ${names(onSession)} expiry day`;
    short = `${names(onSession)} expiry ${sessionIsToday ? 'today' : dayLabel(session)}`;
  } else if (onAfter.length) {
    level = 'eve';
    title = `${sessionIsToday ? 'Tomorrow' : dayLabel(after)} is ${names(onAfter)} expiry — ${sessionIsToday ? 'today' : dayLabel(session)} is the day before`;
    short = `${names(onAfter)} expiry ${sessionIsToday ? 'tomorrow' : dayLabel(after)}`;
  }
  const lines = level === 'none' ? [] : [RESEARCH.sebi, RESEARCH.prop, RESEARCH.jane, RESEARCH.ours];
  const rules = Object.keys(INDEXES).map((i) => deriveWeekdayRule(i));
  return {
    at: now.toISOString(), today, session, sessionIsToday, after, level, title, short,
    expiries: onSession, tomorrow: onAfter,
    advice: level === 'none' ? 'Buying options on expiry day or the day before lost in every version the app tested.' : sessionIsToday ? RESEARCH.advice : RESEARCH.advice.replace('today', `on ${dayLabel(session)}`),
    lines, next: nextExpiries(session),
    rules: rules.map((r) => ({ index: r.index, exchange: r.exchange, weekday: r.weekdayName || null, found: r.found, note: r.note })),
    note: 'Expiry weekdays read from the cached NSE / BSE files; holidays from the NSE calendar (moved to the previous trading day). Research caution, not advice.',
  };
}

/** The evening-notification line (one short line) when the next trading day is an expiry day, else null. */
export function eveningExpiryLine(date) {
  if (!isTradingDay(date)) return null;
  const next = nextSession(date);
  const xs = expiriesOn(next);
  if (!xs.length) return null;
  const idx = [...new Set(xs.filter((x) => x.index !== 'STOCKS').map((x) => x.index))];
  const what = idx.length ? idx.join('/') : 'stock-option';
  const when = next === addDays(date, 1) ? 'Tomorrow' : dayLabel(next);
  return { title: 'Expiry tomorrow', short: `${when} is ${what} expiry — don't buy options`, detail: `${next}: ${names(xs)} expiry. ${RESEARCH.sebi} ${RESEARCH.ours} ${RESEARCH.advice}` };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = expiryStatus();
  console.log(`Session ${s.session}${s.sessionIsToday ? ' (today)' : ''}: ${s.title || 'no index or stock-option expiry today or on the next session'}`);
  for (const r of Object.keys(INDEXES)) console.log(`Rule · ${deriveWeekdayRule(r).note}`);
  for (const r of Object.keys(INDEXES)) {
    const m = monthlyCheck(r);
    console.log(`Monthly · ${r}: last expiry of the month = last ${WD[m.weekday]} (shifted) in ${m.matched} of ${m.checked} checkable months: ${m.months.map((x) => `${x.month} ${x.observed}${x.observed === x.rule ? '' : ` (rule ${x.rule})`}`).join(', ')}`);
  }
  const st = monthlyCheck('STOCKS');
  console.log(`Monthly · stock options: ${st.matched} of ${st.checked} checkable months on the rule: ${st.months.map((x) => `${x.month} ${x.observed}`).join(', ')}`);
  for (const n of s.next) console.log(`Next · ${n.label.padEnd(28)} ${n.weekly ? `weekly ${n.weekly} ${dayLabel(n.weekly)} · ` : ''}monthly ${n.monthly} ${dayLabel(n.monthly)}`);
  if (s.level !== 'none') console.log(`${s.advice} ${s.lines.join(' ')}`);
  console.log('Not advice.');
}
