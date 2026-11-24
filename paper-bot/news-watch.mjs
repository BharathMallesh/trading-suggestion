#!/usr/bin/env node
// News watch (library + CLI) — an agent that reads each watched stock's news every evening and makes a call:
// UP / DOWN / NO CALL for the next session and for 5 sessions, with a confidence and a one-line reason. Then it
// KEEPS SCORE: every call is logged with the date and the closing price, and after 1 and 5 sessions it is scored
// against the stock's move vs NIFTY (direction hit or miss, and a paper P&L if you had followed it, 0.3% costs).
//
// Honest starting point (20 research rounds, Nov 2026): no news-type rule predicted next-day or 5-day direction
// reliably after costs. Order wins faded next day on average in 2010–22 but not after 2022; results-day gaps did not
// continue; credit-rating upgrades and management exits failed their later checks. What DID hold up are a few things to
// AVOID (price-band cut, trade-for-trade, ASM entry, 3rd upper circuit — paper-bot/avoid-list.mjs; rights issues;
// bonus board-meeting news; buying on a bonus/split ex-date). So these calls are UNPROVEN until the scorecard here
// shows otherwise (n ≥ 100 scored calls and a 95% interval that excludes 50%). The calls never change any other
// strategy — nothing else in the app reads this file. Not advice.
//
// Sources per stock: NSE corporate announcements of the last 2 sessions (with broadcast time; curl + cookie jar, as
// in bonus-runup.mjs), recent headlines (news.mjs: Google News RSS / Yahoo, relevance filter), the active
// "don't buy now" warnings (avoid-list.mjs), and one Ling reading per stock per IST day (summary + calls).
// Without OPENROUTER_API_KEY the card still shows the news and events; calls then come only from the tested avoid
// events (5-session DOWN) and are labelled "rule".
//
//   node paper-bot/news-watch.mjs --run [--refresh] [--symbols A,B]

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic, badRequest } from '../util.mjs';
import { tradingDaysBetween, lastSessionDate, nseOpenNow } from './market-calendar.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';
import { isRoundup } from './news.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIST = () => process.env.NEWS_WATCH_PATH || join(HERE, 'data', 'news-watch.json'); // user-added symbols
const STATE = () => process.env.NEWS_WATCH_STATE_PATH || join(HERE, 'data', 'news-watch-state.json'); // readings + call log
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const NW = { costPct: 0.3, horizons: [1, 5], minN: 100, maxUser: 30, maxHeadlines: 6, maxAnn: 8 };
export const DISCLAIMER = 'Unproven: in 20 rounds of testing no news rule predicted next-day or 5-day direction reliably after costs. These calls are kept score of below and are not better than a coin flip until the scorecard says so. Not advice.';

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ddmmyyyy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const istDate = (now) => new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
const readJ = (p, fb) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
};
export const cleanSymbol = (s) => String(s || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
const SYM_RE = /^[A-Z0-9&-]{1,20}$/;
// A headline must read like company / market news (drops songs, films and people that share a name with the stock).
export const FINANCE_WORDS = /\b(shares?|stocks?|NSE|BSE|Sensex|Nifty|order|orders|contract|results?|profit|loss|revenue|sales|Ltd|Limited|crore|lakh|IPO|Q[1-4]|FY\d*|dividend|bonus|split|rating|target|board|acqui\w*|stake|plant|deal|merger|demerger|promoter|investors?|brokerage|buy|sell|rally|surges?|jumps?|falls?|slumps?|gains?|SEBI|CEO|CFO|MD)\b|₹|Rs\.?\s?\d/i;

// ---------------- event types ----------------
export const EVENT_TYPES = {
  order_win: 'Order win',
  results: 'Results',
  fund_raise: 'Fund-raise / QIP / rights',
  management: 'Management change',
  rating: 'Rating',
  corporate_action: 'Bonus / split / dividend / demerger',
  regulatory: 'Regulatory / ASM',
  other: 'Other',
};
// Tested historical effects (vs stocks of the same size; research rounds 13–20, Nov 2026). avoid = a confirmed negative.
export const HISTORY = {
  order_win: { text: 'order win: −1% next day on average 2010–22 (−2% over 60 sessions), no effect 2023–24 — no edge now', avoid: false },
  results: { text: 'results: the results-day move did not continue over the next sessions (2010–26 test) — no edge', avoid: false },
  rights: { text: 'rights issue: stocks lagged similar stocks by 4–8% over 20 sessions (2010–26 test: −4% after the board filing, −6 to −8% after ex-rights)', avoid: true },
  ofs: { text: 'offer for sale: −2.9% over 5 sessions in 2010–22, but it failed the 2023–24 check — no reliable effect', avoid: false },
  raise: { text: 'QIP / preferential / debt fund-raise: not tested — no historical number', avoid: false },
  management: { text: 'management change: CEO/MD exits −2.5 to −3.3% in 2010–22 but failed the 2023–24 check; CFO exits failed 2025–26 — no reliable effect', avoid: false },
  rating: { text: 'rating change: credit-rating upgrades +3.4% over 60 sessions in 2010–22 but failed the 2023–24 check — no reliable effect', avoid: false },
  bonus_bm: { text: 'bonus board-meeting news: stocks lagged similar stocks by 5–7% over the next 20 sessions (2010–26 test)', avoid: true },
  bonus_ex: { text: 'bonus / split: ~+2–4% run-up BEFORE the ex-date (held 2023–26, see Bonus/split run-up), but buying ON the ex-date lagged similar stocks by ~6% over 20 sessions', avoid: false },
  dividend: { text: 'dividend: small ~+1% run-up before the ex-date; buying on the ex-date −2% vs similar stocks — small effects', avoid: false },
  restructure: { text: 'demerger / scheme of arrangement: the parent lagged similar stocks by ~7.6% over 60 sessions after a demerger ex-date (2010–22, a weaker result); no buy edge found', avoid: false },
  buyback: { text: 'buyback news: stocks did worse than similar stocks afterwards (2010–22 test)', avoid: false },
  regulatory: { text: 'surveillance: entering ASM −5% over 20 sessions, price-band cut −6%, trade-for-trade −6% (2010–26, confirmed) — see Don\'t buy now', avoid: false },
};
const ROUTINE = /newspaper publication|trading window|analysts?\/institutional|investor meet|investor presentation|con\.? ?call|earnings call|regulation 74|reg\.? ?74|loss of share|duplicate share|share certificate|certificate under|compliance certificate|esop|employee stock|record of investor|intimation of (investor|analyst)|audio recording|transcript/i;
const RULES = [
  ['regulatory', /\bASM\b|surveillance|show[- ]cause|penalt|\bfined?\b|\bprobe\b|\braid|search (and|&) seizure|tax demand|gst demand|warning letter|import alert|form 483|\binsolvency|\bSEBI\b.*(order|notice)|suspension of trading|\bdefault/i, null],
  ['fund_raise', /\bQIP\b|qualified institution|rights issue|rights entitlement|\bpreferential|fund[- ]?rais|raising of funds|raise funds|\bwarrants\b|\bNCDs?\b|debentures|\bOFS\b|offer for sale/i, (t) => (/rights (issue|entitlement)/i.test(t) ? 'rights' : /\bOFS\b|offer for sale/i.test(t) ? 'ofs' : 'raise')],
  ['corporate_action', /\bbonus\b|stock split|\bsplit\b|sub-?division|dividend|buy-?back/i, (t) => (/buy-?back/i.test(t) ? 'buyback' : /\bbonus\b/i.test(t) && /board meeting|consider|recommend|propos/i.test(t) ? 'bonus_bm' : /\bbonus\b|split|sub-?division/i.test(t) ? 'bonus_ex' : 'dividend')],
  ['corporate_action', /scheme of arrangement|demerg|amalgamation|\bmerger\b/i, () => 'restructure'],
  ['order_win', /award of (order|contract)|receipt of order|bagging|letter of (award|intent)|\bLoA\b|\bLoI\b|\b(wins?|won|bags?|bagged|secures?|secured|receives?|received|bagging)\b[^.]{0,60}\b(orders?|contracts?|deal)\b|\b(orders?|contracts?)\b[^.]{0,30}\b(worth|valued|win|award)/i, null],
  ['results', /financial results?|\bresults?\b|earnings|net profit|\bPAT\b|EBITDA|quarterly numbers|\bQ[1-4]\s?(FY)?\d*\s+(profit|loss|revenue)/i, null],
  ['rating', /credit rating|\brating\b|upgrade|downgrade|\bCRISIL\b|\bICRA\b|India Ratings|target price/i, null],
  ['management', /resign|appoint|cessation|change in (director|management|kmp|key managerial)|\bCEO\b|\bCFO\b|managing director|steps down|re-?designat/i, null],
];
// Which event matters most when a stock has several (tested avoids and surveillance first).
const PRIORITY = ['regulatory', 'fund_raise', 'corporate_action', 'results', 'order_win', 'rating', 'management', 'other'];

/** Classify one announcement / headline → { type, sub, routine }. */
export function classifyEvent(text) {
  const t = String(text || '');
  if (ROUTINE.test(t)) return { type: 'other', sub: null, routine: true };
  for (const [type, re, subFn] of RULES) if (re.test(t)) return { type, sub: subFn ? subFn(t) : null, routine: false };
  return { type: 'other', sub: null, routine: false };
}
/** Historical note for an event ({type, sub}) or null when nothing was tested. */
export const historyFor = (ev) => (ev ? HISTORY[ev.sub] || HISTORY[ev.type] || null : null);

/** The stock's main event from its classified items (non-routine, by priority). */
export function mainEvent(items) {
  const real = items.filter((x) => x.event && !x.event.routine);
  if (!real.length) return null;
  real.sort((a, b) => PRIORITY.indexOf(a.event.type) - PRIORITY.indexOf(b.event.type));
  const top = real[0].event;
  // an avoid sub-type anywhere wins inside the same type
  const avoidSub = real.find((x) => x.event.type === top.type && HISTORY[x.event.sub]?.avoid)?.event;
  return avoidSub || top;
}

// ---------------- NSE announcements ----------------
/** NSE "13-Nov-2026 17:10:26" → ISO time in IST ("2026-11-13T17:10:26+05:30"). */
export function nseTime(s) {
  const m = String(s || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  if (!m || !MON[m[2].toLowerCase()]) return null;
  return `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`;
}
/** NSE corporate-announcements JSON → [{source:'NSE', time, title, detail, link}], newest first. */
export function parseAnnouncements(j) {
  const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
  return rows
    .map((r) => ({
      source: 'NSE',
      time: nseTime(r.exchdisstime || r.an_dt) || null,
      title: String(r.desc || 'Announcement').trim(),
      detail: String(r.attchmntText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      link: /^https:\/\/(nsearchives|archives)\.nseindia\.(com|in)\//.test(r.attchmntFile || '') ? r.attchmntFile : null,
    }))
    .filter((x) => x.time)
    .sort((a, b) => b.time.localeCompare(a.time));
}
/** All symbols' announcements in one NSE cookie session (curl; Node's fetch is refused over HTTP/2). */
export async function fetchAnnouncements(symbols, from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  const jar = join(dir, 'cj.txt');
  const base = ['-s', '-L', '--compressed', '--max-time', '40', '-b', jar, '-c', jar, '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/companies-listing/corporate-filings-announcements'];
  const out = new Map();
  try {
    await run('curl', [...base, '-H', 'Accept: text/html,*/*;q=0.8', '-o', '/dev/null', 'https://www.nseindia.com/']).catch(() => {});
    for (const s of symbols) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(s)}&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`;
        const { stdout } = await run('curl', [...base, '-H', 'Accept: */*', url], { maxBuffer: 20 * 1024 * 1024 });
        out.set(s, { items: parseAnnouncements(JSON.parse(stdout)) });
      } catch (err) {
        out.set(s, { items: [], error: `NSE announcements unavailable (${String(err.message).split('\n')[0].slice(0, 80)})` });
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- watchlist ----------------
export const loadUserList = () => {
  const j = readJ(LIST(), null);
  return Array.isArray(j?.symbols) ? j.symbols.filter((s) => SYM_RE.test(s)) : [];
};
function saveUserList(symbols) {
  writeJsonAtomic(LIST(), { symbols, updatedAt: new Date().toISOString(), note: 'News watch: symbols you added. Momentum 10 / India mix stocks are added automatically.' });
}
export function addWatchSymbol(symbol) {
  const s = cleanSymbol(symbol);
  if (!SYM_RE.test(s)) throw badRequest('Give an NSE symbol such as TCS or HDFCBANK (letters, digits, & or -).');
  const list = loadUserList();
  if (list.includes(s)) return { symbols: list, added: false };
  if (list.length >= NW.maxUser) throw badRequest(`At most ${NW.maxUser} added stocks — remove one first.`);
  const next = [...list, s];
  saveUserList(next);
  return { symbols: next, added: true };
}
export function removeWatchSymbol(symbol) {
  const s = cleanSymbol(symbol);
  const list = loadUserList();
  if (!list.includes(s)) return { symbols: list, removed: false, note: 'Not in your added list (Momentum 10 / India mix stocks follow their strategy and cannot be removed here).' };
  const next = list.filter((x) => x !== s);
  saveUserList(next);
  return { symbols: next, removed: true };
}
/** Strategy holdings (Momentum 10 + India mix stock third) from their paper files. */
export async function strategyHoldings() {
  const { thisMonth } = await import('./this-month.mjs');
  const t = thisMonth();
  const m10 = t.plans.find((p) => p.key === 'm10')?.hold || [];
  const india = (t.plans.find((p) => p.key === 'india')?.parts || []).flatMap((p) => p.stocks || []);
  return { m10, india };
}
/** Watchlist rows: [{symbol, from: ['Momentum 10', 'India mix', 'added']}]. */
export async function watchlist({ holdingsFn = strategyHoldings, user = loadUserList() } = {}) {
  let h = { m10: [], india: [] };
  let error = null;
  try {
    h = await holdingsFn();
  } catch (err) {
    error = `strategy holdings unavailable (${err.message})`;
  }
  const rows = new Map();
  const add = (s, tag) => {
    const k = cleanSymbol(s);
    if (!SYM_RE.test(k)) return;
    if (!rows.has(k)) rows.set(k, { symbol: k, from: [] });
    if (!rows.get(k).from.includes(tag)) rows.get(k).from.push(tag);
  };
  (h.m10 || []).forEach((s) => add(s, 'Momentum 10'));
  (h.india || []).forEach((s) => add(s, 'India mix'));
  user.forEach((s) => add(s, 'added'));
  return { rows: [...rows.values()], error };
}

// ---------------- the call ----------------
const CALLS = new Set(['UP', 'DOWN', 'NO CALL']);
export function normCall(c) {
  const s = String(c || '').trim().toUpperCase().replace(/[_-]/g, ' ');
  if (CALLS.has(s)) return s;
  if (/^(BUY|BULLISH|POSITIVE|LONG)$/.test(s)) return 'UP';
  if (/^(SELL|BEARISH|NEGATIVE|SHORT)$/.test(s)) return 'DOWN';
  return 'NO CALL';
}
const oneCall = (x) => {
  const call = normCall(x?.call ?? x?.direction);
  return { call, confidence: call === 'NO CALL' ? null : Math.round(normalizeConfidence(x?.confidence, 0.5) * 100) / 100, reason: String(x?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null };
};
/** Rule calls (no AI): a tested avoid event or an active avoid warning → DOWN over 5 sessions; otherwise NO CALL. */
export function ruleCalls(event, warnings = []) {
  const h = historyFor(event);
  const none = { call: 'NO CALL', confidence: null, reason: null };
  if (warnings.length) return { next: { ...none, reason: 'tested warnings are about 5–20 sessions, not the next day' }, five: { call: 'DOWN', confidence: 0.55, reason: `tested avoid warning: ${warnings.map((w) => w.reason).join(', ')}` }, source: 'rule' };
  if (h?.avoid) return { next: { ...none, reason: 'the tested effect is over 20 sessions, not the next day' }, five: { call: 'DOWN', confidence: 0.55, reason: `tested avoid event — ${h.text.split(':')[0]}` }, source: 'rule' };
  return { next: { ...none, reason: 'no tested edge for this news' }, five: { ...none, reason: 'no tested edge for this news' }, source: 'rule' };
}

export function llmMessages({ symbol, company, items, event, history, warnings }) {
  const lines = items.slice(0, 12).map((x, i) => `${i + 1}. [${x.source}${x.event ? ` · ${EVENT_TYPES[x.event.type]}` : ''}] ${x.time ? x.time.slice(0, 16).replace('T', ' ') : ''} ${x.title}${x.detail ? ` — ${x.detail.slice(0, 220)}` : ''}`);
  return [
    {
      role: 'system',
      content:
        'You read company news for an Indian stock research dashboard and make a direction call that will be scored against the stock\'s move vs NIFTY. ' +
        'Be honest: in testing, NO type of news predicted next-day or 5-day direction reliably after costs; order wins faded next day in 2010–22 but not after; results gaps did not continue. ' +
        'Only a few events had a confirmed negative effect (rights issues, bonus board-meeting news, buying on a bonus/split ex-date, surveillance/ASM, price-band cuts). ' +
        'Say "NO CALL" unless the items give a concrete reason; keep confidence modest (0.5 = coin flip). Use ONLY the items given. ' +
        'Reply ONLY with JSON: {"summary":"1-2 factual sentences about what was announced/reported","next":{"call":"UP"|"DOWN"|"NO CALL","confidence":0-1,"reason":"one line"},' +
        '"five":{"call":"UP"|"DOWN"|"NO CALL","confidence":0-1,"reason":"one line"}}  ("next" = the next session, "five" = the next 5 sessions, both relative to NIFTY).',
    },
    {
      role: 'user',
      content: `Stock: ${company || symbol} (NSE: ${symbol})\nMain event type: ${event ? EVENT_TYPES[event.type] : 'none'}\nTested history: ${history?.text || 'none for this type'}\nActive avoid warnings: ${warnings.length ? warnings.map((w) => `${w.reason} (until ${w.until})`).join('; ') : 'none'}\nItems (newest first):\n${lines.join('\n') || '(none)'}`,
    },
  ];
}
export function parseLlm(raw) {
  const j = extractJson(raw, (o) => 'next' in o || 'five' in o || 'summary' in o);
  if (!j) return null;
  return { summary: String(j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null, next: oneCall(j.next), five: oneCall(j.five), source: 'ai' };
}

// ---------------- prices + scoring ----------------
/** Closes for symbols + NIFTY from `from`: the bhav store (corporate-action adjusted) first, Yahoo for the rest. */
export async function defaultPrices(symbols, from, need) {
  const { loadSeries } = await import('./bhav-history.mjs');
  const { candles } = await import('../market-data.mjs');
  const months = [];
  for (let d = `${from.slice(0, 7)}-01`; d.slice(0, 7) <= istDate(new Date()).slice(0, 7); d = addDays(d, 32).slice(0, 7) + '-01') months.push(d.slice(0, 7));
  let series = new Map();
  try {
    series = loadSeries({ months });
  } catch {
    /* fall back to Yahoo */
  }
  const out = new Map();
  const period1 = Math.floor(Date.parse(`${addDays(from, -5)}T00:00:00Z`) / 1000);
  const yahoo = async (y) => new Map((await candles(y, { period1, interval: '1d' })).filter((r) => r.close > 0).map((r) => [r.date, r.close]));
  for (const s of symbols) {
    const rows = series.get(s);
    const m = rows ? new Map(rows.filter((r) => r.date >= from).map((r) => [r.date, r.close])) : new Map();
    if (!m.size || (need && !m.has(need))) {
      try {
        const y = await yahoo(`${s}.NS`);
        if (y.size) {
          out.set(s, y);
          continue;
        }
      } catch {
        /* keep what the store had */
      }
    }
    out.set(s, m);
  }
  let nifty = new Map();
  try {
    nifty = await yahoo('^NSEI');
  } catch {
    /* scoring waits */
  }
  return { series: out, nifty };
}

/** Session `h` trading days after `date`. */
export const sessionAfter = (date, h) => tradingDaysBetween(addDays(date, 1), addDays(date, h * 2 + 20))[h - 1] || null;

/** Score open calls whose target session has a close for the stock and NIFTY. Mutates and returns the calls. */
export function scoreCalls(calls, { series, nifty }, cost = NW.costPct, upTo = null) {
  for (const c of calls) {
    if (c.scored) continue;
    const T = sessionAfter(c.date, c.horizon);
    c.target = T;
    if (upTo && T > upTo) continue; // only closes of completed sessions
    const s = series.get(c.symbol);
    const p0 = s?.get(c.date) ?? c.price ?? null; // the fresh (adjusted) series first, the logged close as a fallback
    const p1 = T ? s?.get(T) : null;
    const n0 = nifty.get(c.date) ?? c.nifty;
    const n1 = T ? nifty.get(T) : null;
    if (!(p0 > 0 && p1 > 0 && n0 > 0 && n1 > 0)) continue;
    const stockPct = (p1 / p0 - 1) * 100;
    const niftyPct = (n1 / n0 - 1) * 100;
    const excessPct = stockPct - niftyPct;
    const sign = c.call === 'UP' ? 1 : -1;
    Object.assign(c, {
      scored: true,
      scoredAt: T,
      stockPct: r3(stockPct),
      niftyPct: r3(niftyPct),
      excessPct: r3(excessPct),
      hit: sign * excessPct > 0,
      pnlPct: r3(sign * stockPct - cost), // bought (UP) or sold short (DOWN) at that close, out at the target close
      pnlVsNiftyPct: r3(sign * excessPct - cost), // the same, hedged with NIFTY
    });
  }
  return calls;
}
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Wilson 95% interval for k hits in n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
export function verdict(n, ci, minN = NW.minN) {
  if (n < minN || !ci) return `not better than a coin flip yet — ${n} of ${minN} scored calls needed before judging`;
  if (ci[0] > 0.5) return 'better than a coin flip so far (95% interval above 50%) — still not advice';
  if (ci[1] < 0.5) return 'worse than a coin flip (95% interval below 50%) — the calls point the wrong way more often';
  return 'not better than a coin flip yet (95% interval includes 50%)';
}
function tally(cs) {
  const n = cs.length;
  const hits = cs.filter((c) => c.hit).length;
  const ci = wilson(hits, n);
  const sum = (k) => cs.reduce((a, c) => a + c[k], 0);
  return { n, hits, hitRate: n ? hits / n : null, ci, avgPnlPct: n ? sum('pnlPct') / n : null, totalPnlPct: n ? sum('pnlPct') : 0, avgPnlVsNiftyPct: n ? sum('pnlVsNiftyPct') / n : null, verdict: verdict(n, ci) };
}
/** Scorecard per horizon (+ by source and event type). */
export function scorecard(calls) {
  const out = {};
  for (const h of NW.horizons) {
    const all = calls.filter((c) => c.horizon === h);
    const done = all.filter((c) => c.scored);
    const by = (k) => Object.fromEntries([...new Set(done.map((c) => c[k] || 'other'))].map((v) => [v, tally(done.filter((c) => (c[k] || 'other') === v))]));
    out[h] = { ...tally(done), pending: all.length - done.length, bySource: by('source'), byType: by('eventType') };
  }
  return out;
}

// ---------------- the evening run ----------------
export const loadNewsWatch = () => readJ(STATE(), null);

async function defaultNews(symbol) {
  const { newsBrief } = await import('./news.mjs');
  return newsBrief(`${symbol}.NS`, { useLlm: false });
}
async function defaultLlm(messages) {
  const { chat } = await import('../ling-client.mjs');
  return chat(messages, { temperature: 0, timeoutMs: 45_000 });
}
async function defaultAvoid() {
  const { avoidListView } = await import('./avoid-list.mjs');
  return avoidListView().bySymbol || {};
}

/**
 * One evening pass over the watchlist: read, classify, call, log, score. Calls are logged only when the market is
 * closed (after 15:30 IST or before 09:15 / non-trading days), against the close of the last completed session.
 */
export async function runNewsWatch({
  now = new Date(),
  symbols = null,
  refresh = false,
  holdingsFn = strategyHoldings,
  annFn = fetchAnnouncements,
  newsFn = defaultNews,
  llmFn = defaultLlm,
  pricesFn = defaultPrices,
  avoidFn = defaultAvoid,
} = {}) {
  const today = istDate(now);
  const base = lastSessionDate(now);
  const canLog = !nseOpenNow(now);
  const prevSess = tradingDaysBetween(addDays(base, -10), addDays(base, -1)).at(-1) || base;
  const wl = await watchlist({ holdingsFn });
  let rows = wl.rows;
  if (symbols?.length) {
    const want = new Set(symbols.map(cleanSymbol));
    rows = [...rows.filter((r) => want.has(r.symbol)), ...[...want].filter((s) => !rows.some((r) => r.symbol === s) && SYM_RE.test(s)).map((s) => ({ symbol: s, from: ['checked'] }))];
  }
  const st = loadNewsWatch() || { startedAt: today, calls: [], latest: {} };
  st.calls ||= [];
  st.latest ||= {};
  const errors = [];
  if (wl.error) errors.push(wl.error);

  let warnings = {};
  try {
    warnings = (await avoidFn()) || {};
  } catch (err) {
    errors.push(`avoid list: ${err.message}`);
  }
  let ann = new Map();
  try {
    ann = await annFn(rows.map((r) => r.symbol), prevSess, today);
  } catch (err) {
    errors.push(`NSE announcements unavailable (${err.message})`);
  }
  const annFailed = rows.filter((r) => ann.get(r.symbol)?.error).length;
  if (annFailed) errors.push(`NSE announcements failed for ${annFailed} of ${rows.length} stocks`);

  let llmNote = null;
  const stocks = [];
  for (const r of rows) {
    const sym = r.symbol;
    const s = { symbol: sym, from: r.from, date: today, base, errors: [] };
    const a = ann.get(sym);
    if (a?.error) s.errors.push(a.error);
    else if (!ann.has(sym)) s.errors.push('NSE announcements not fetched');
    const annItems = (a?.items || []).slice(0, NW.maxAnn);
    let news = null;
    try {
      news = await newsFn(sym);
    } catch (err) {
      s.errors.push(`headlines unavailable (${String(err.message).slice(0, 80)})`);
    }
    s.company = news?.company || null;
    const heads = (news?.headlines || []).filter((h) => !isRoundup(h.title) && FINANCE_WORDS.test(h.title)).slice(0, NW.maxHeadlines).map((h) => ({ source: h.publisher || 'News', time: h.time || null, title: h.title, detail: '', link: /^https?:\/\//.test(h.link || '') ? h.link : null }));
    s.items = [...annItems, ...heads].map((x) => ({ ...x, event: classifyEvent(`${x.title} ${x.detail}`) }));
    s.event = mainEvent(s.items);
    s.eventLabel = s.event ? EVENT_TYPES[s.event.type] : null;
    s.history = historyFor(s.event)?.text || null;
    s.warnings = (warnings[sym] || []).map((w) => ({ reason: w.reason, until: w.until }));

    // One AI reading per stock per IST day (reused unless --refresh), like news.mjs.
    const prev = st.latest[sym];
    let ai = !refresh && prev?.date === today && prev?.source === 'ai' ? { summary: prev.summary, next: prev.next, five: prev.five, source: 'ai', cached: true } : null;
    if (!ai && s.items.some((x) => !x.event.routine)) {
      try {
        ai = parseLlm(await llmFn(llmMessages({ symbol: sym, company: s.company, items: s.items, event: s.event, history: historyFor(s.event), warnings: s.warnings })));
        if (!ai) s.errors.push('AI reply could not be read');
      } catch (err) {
        llmNote = /OPENROUTER_API_KEY/.test(err.message) ? 'AI summary and calls need OPENROUTER_API_KEY — showing news and events only; calls come from the tested avoid rules.' : `AI unavailable: ${String(err.message).split('\n')[0].slice(0, 100)}`;
        if (symbols) s.errors.push(llmNote); // a one-stock check shows it on the stock; the evening run shows it once on top
      }
    }
    const calls = ai || ruleCalls(s.event, s.warnings);
    s.summary = ai?.summary || null;
    s.next = calls.next;
    s.five = calls.five;
    s.source = calls.source;
    s.quiet = !s.items.some((x) => !x.event.routine);
    stocks.push(s);
  }
  if (llmNote) errors.push(llmNote);

  // prices: logging base + scoring
  const open = st.calls.filter((c) => !c.scored);
  const pxSyms = [...new Set([...stocks.map((s) => s.symbol), ...open.map((c) => c.symbol)])];
  const from = [base, ...open.map((c) => c.date)].sort()[0];
  let px = { series: new Map(), nifty: new Map() };
  try {
    px = await pricesFn(pxSyms, from, base);
  } catch (err) {
    errors.push(`prices unavailable (${err.message})`);
  }

  let logged = 0;
  if (canLog) {
    for (const s of stocks) {
      for (const [h, c] of [[1, s.next], [5, s.five]]) {
        if (c.call === 'NO CALL') continue;
        if (st.calls.some((x) => x.symbol === s.symbol && x.date === base && x.horizon === h)) continue; // first call of the evening stands
        st.calls.push({
          id: `${base}:${s.symbol}:${h}`,
          date: base,
          madeAt: now.toISOString(),
          symbol: s.symbol,
          horizon: h,
          call: c.call,
          confidence: c.confidence,
          reason: c.reason,
          source: s.source,
          eventType: s.event?.type || 'none',
          eventSub: s.event?.sub || null,
          price: px.series.get(s.symbol)?.get(base) ?? null,
          nifty: px.nifty.get(base) ?? null,
        });
        logged++;
      }
    }
  }
  scoreCalls(st.calls, px, NW.costPct, base);

  // merge with what is on disk now (the server's "check now" may have written meanwhile)
  const disk = loadNewsWatch();
  if (disk?.calls) for (const c of disk.calls) if (!st.calls.some((x) => x.id === c.id)) st.calls.push(c);
  const latest = { ...(disk?.latest || {}), ...st.latest };
  for (const s of stocks) latest[s.symbol] = s;
  // drop readings for stocks no longer watched (keep 60 days of the ones that are)
  const keep = new Set(wl.rows.map((r) => r.symbol));
  for (const k of Object.keys(latest)) if (!keep.has(k) && !(symbols && stocks.some((s) => s.symbol === k))) delete latest[k];
  const out = {
    ...st,
    latest,
    calls: st.calls.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.horizon - b.horizon),
    // a one-stock "check now" keeps the evening run's summary; its problems are on that stock's own lines
    ...(symbols
      ? { lastCheck: { at: now.toISOString(), date: today, base, stocks: stocks.length, logged, canLog, symbols: stocks.map((s) => s.symbol), problems: errors }, lastRun: disk?.lastRun || st.lastRun || null, fetchError: disk?.fetchError ?? st.fetchError ?? null }
      : { lastRun: { at: now.toISOString(), date: today, base, stocks: stocks.length, logged, canLog, symbols: null }, fetchError: errors.length ? `${today}: ${errors.join(' · ')}` : null }),
    updatedAt: now.toISOString(),
  };
  writeJsonAtomic(STATE(), out);
  return out;
}

/** What the app serves: the scorecard on top, then the latest reading per watched stock. */
export async function newsWatchView({ holdingsFn = strategyHoldings } = {}) {
  const st = loadNewsWatch() || { calls: [], latest: {} };
  const wl = await watchlist({ holdingsFn });
  const stocks = wl.rows.map((r) => ({ ...(st.latest?.[r.symbol] || { symbol: r.symbol, notYet: true }), from: r.from }));
  let related = null;
  try {
    const { computeStats } = await import('./prediction-log.mjs');
    const nv = computeStats().newsValue;
    related = nv?.n ? { n: nv.n, directionHitRate: nv.directionHitRate } : null;
  } catch {
    /* optional */
  }
  return {
    disclaimer: DISCLAIMER,
    scorecard: scorecard(st.calls || []),
    recentCalls: (st.calls || []).slice(-40).reverse(),
    stocks,
    userSymbols: loadUserList(),
    lastRun: st.lastRun || null,
    fetchError: [st.fetchError, wl.error].filter(Boolean).join(' · ') || null,
    startedAt: st.startedAt || null,
    costPct: NW.costPct,
    minN: NW.minN,
    eventTypes: EVENT_TYPES,
    relatedNewsValue: related,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) {
    console.log('Usage: node paper-bot/news-watch.mjs --run [--refresh] [--symbols A,B]');
    process.exit(0);
  }
  try {
    const si = args.indexOf('--symbols');
    const symbols = si >= 0 ? String(args[si + 1] || '').split(',').filter(Boolean) : null;
    const st = await runNewsWatch({ refresh: args.includes('--refresh'), symbols });
    const L = symbols ? st.lastCheck : st.lastRun;
    console.log(`News watch ${L.date} (calls against the ${L.base} close): ${L.stocks} stocks · ${L.logged} new calls logged${L.canLog ? '' : ' (market open — calls shown, not logged)'}`);
    for (const s of Object.values(st.latest).filter((x) => x.date === L.date && (!L.symbols || L.symbols.includes(x.symbol)))) {
      const nse = s.items.filter((x) => x.source === 'NSE').length;
      const nws = s.items.length - nse;
      const c = (x) => `${x.call}${x.confidence != null ? ` ${Math.round(x.confidence * 100)}%` : ''}`;
      console.log(`  ${s.symbol.padEnd(11)} NSE ${nse} · headlines ${nws} · ${s.eventLabel || 'no event'}${s.event?.sub ? ` (${s.event.sub})` : ''} · next ${c(s.next)} · 5 sessions ${c(s.five)} [${s.source}]${s.warnings.length ? ' ⚠' : ''}${s.errors.length ? ` · ${s.errors.join('; ')}` : ''}`);
      if (s.summary) console.log(`               ${s.summary}`);
    }
    const sc = scorecard(st.calls);
    for (const h of NW.horizons) console.log(`Scorecard ${h} session${h > 1 ? 's' : ''}: ${sc[h].n} scored (${sc[h].pending} pending) · hit rate ${sc[h].hitRate == null ? '–' : `${(sc[h].hitRate * 100).toFixed(0)}%`} · ${sc[h].verdict}`);
    const probs = symbols ? L.problems.join(' · ') : st.fetchError;
    if (probs) console.log(`Problems: ${probs}`);
    console.log('Not advice.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
