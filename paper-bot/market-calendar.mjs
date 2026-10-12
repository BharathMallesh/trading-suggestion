#!/usr/bin/env node
// NSE trading calendar (library + CLI): weekends + exchange holidays.
//   - Holidays come from NSE's own list (nseindia.com holiday-master, capital
//     market segment), refreshed weekly by the refit job and saved to
//     paper-bot/data/nse-holidays.json. The 2026 list is built in as a
//     fallback so the app works offline.
//   - Special sessions (e.g. Diwali muhurat trading on a Sunday) are not modelled.
//
//   node paper-bot/market-calendar.mjs            # show upcoming holidays
//   node paper-bot/market-calendar.mjs --refresh  # fetch NSE's list

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';

const FILE = () => process.env.NSE_HOLIDAYS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'nse-holidays.json');

// NSE capital-market trading holidays 2026 that fall on weekdays (NSE circular list).
export const BUILTIN_HOLIDAYS = {
  '2026-01-15': 'Municipal Corporation Election - Maharashtra',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

let cache = null;
/** date → holiday name (saved NSE list merged over the built-in one). */
export function holidays() {
  if (cache) return cache;
  let saved = {};
  try {
    if (existsSync(FILE())) saved = JSON.parse(readFileSync(FILE(), 'utf8')).holidays || {};
  } catch {
    /* fall back to the built-in list */
  }
  cache = { ...BUILTIN_HOLIDAYS, ...saved };
  return cache;
}
/** Forget the in-memory copy (after a refresh, and in tests). */
export function resetHolidays() {
  cache = null;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** NSE "15-Jan-2026" → "2026-01-15". */
export const nseDate = (s) => {
  const [d, m, y] = String(s).split('-');
  return MONTHS[m] ? `${y}-${MONTHS[m]}-${d.padStart(2, '0')}` : null;
};

/** Fetch NSE's holiday list (needs the site's cookies first) and save it. */
export async function refreshHolidays({ fetchFn = fetch } = {}) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const home = await fetchFn('https://www.nseindia.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetchFn('https://www.nseindia.com/api/holiday-master?type=trading', {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/resources/exchange-communication-holidays', Cookie: cookie },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`NSE holiday list HTTP ${res.status}`);
  const j = await res.json();
  const list = {};
  for (const x of j.CM || []) {
    const d = nseDate(x.tradingDate);
    const wd = d ? new Date(`${d}T00:00:00Z`).getUTCDay() : 0;
    if (d && wd >= 1 && wd <= 5) list[d] = x.description;
  }
  if (!Object.keys(list).length) throw new Error('NSE holiday list was empty');
  writeJsonAtomic(FILE(), { at: new Date().toISOString(), source: 'nseindia.com holiday-master (CM)', holidays: list });
  resetHolidays();
  return list;
}

const ist = (now) => {
  const t = new Date(now.getTime() + 19800_000);
  return { date: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
};

/** Is `date` (YYYY-MM-DD) an NSE trading day? */
export function isTradingDay(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5 && !holidays()[date];
}

/** Is the NSE cash market open right now (09:15–15:30 IST on a trading day)? */
export function nseOpenNow(now = new Date()) {
  const t = ist(now);
  return isTradingDay(t.date) && t.mins >= 555 && t.mins < 930;
}

/** Most recent completed session: today once 15:30 IST has passed on a trading day, else the previous trading day. */
export function lastSessionDate(now = new Date()) {
  const t = ist(now);
  let d = new Date(`${t.date}T00:00:00Z`);
  if (!(isTradingDay(t.date) && t.mins >= 930)) d = new Date(d.getTime() - 86400000);
  for (let i = 0; i < 15 && !isTradingDay(d.toISOString().slice(0, 10)); i++) d = new Date(d.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

/** Trading days in [from, to] (inclusive). */
export function tradingDaysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400000)) {
    const s = d.toISOString().slice(0, 10);
    if (isTradingDay(s)) out.push(s);
  }
  return out;
}

/** Holidays from `date` on (for the UI). */
export function upcomingHolidays(date = ist(new Date()).date, n = 5) {
  return Object.entries(holidays()).filter(([d]) => d >= date).sort().slice(0, n).map(([d, name]) => ({ date: d, name }));
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (process.argv.includes('--refresh')) {
      const l = await refreshHolidays();
      console.log(`Saved ${Object.keys(l).length} NSE trading holidays.`);
    }
    for (const h of upcomingHolidays()) console.log(`${h.date}  ${h.name}`);
  })().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
