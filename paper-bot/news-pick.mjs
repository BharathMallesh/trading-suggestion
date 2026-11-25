#!/usr/bin/env node
// Morning news pick (library + CLI) — at ~08:40 IST on trading days, "which stock looks best to buy today, from the
// overnight news": up to 3 BUY picks (or, often, "no pick today"), each with a reason and a confidence. Then it KEEPS
// SCORE from a price you could actually have traded: the entry is that day's OPEN (not the previous close), scored at
// the same day's close and after 5 sessions (the pick day counts as the first), vs NIFTY from its own open that day,
// net of 0.3% costs. A CONTROL is logged with every pick day — one random stock from the same candidate pool (seeded by
// the date) scored the same way — and the picks are "unproven" until they beat it (≥ 100 scored picks, hit rate and
// average net return above the control's, 95% interval of the hit rate clear of 50%).
//
// Why so careful (research rounds 15–20 + the HFCL case study, Nov 2026): no news rule predicted direction reliably
// after costs. Order-win news is priced into the OPEN (18 of 22 opened higher, +1.4% gap) and then FADED −1.7%
// open→close on average; buying at the first tradeable price after news lost −2.0% a day (6 of 25 won). Results-day
// gaps did not continue. Fills at the daily open of small caps flatter backtests (open-print artifact), so the pool is
// limited to the 300 most-traded stocks. The picks never feed any strategy — nothing else in the app reads this file.
// Not advice.
//
// Candidate pool: stocks with NSE announcements since the previous session's 15:30 (ONE call to NSE's all-equities
// corporate-announcements API), only the point-in-time 300 most-traded (bhav store, previous month's median traded
// value), not on the "don't buy now" list and not routine-only filings; plus the News watch watchlist. Capped at 25
// (requests 0.8 s apart). Per candidate: headlines (news.mjs), event type and tested history (news-watch.mjs).
// Change 25 Nov 2026 (round 79): the event type prefers the company's own non-routine NSE filing over headlines
// when both exist (news-watch.mjs mainEvent); 0 picks had been scored before it.
//
//   node paper-bot/news-pick.mjs --run [--notify]     # the 08:40 job (quiet exit on holidays / after 09:15)
//   node paper-bot/news-pick.mjs --run --force        # a TEST run for today at any time (shown, never scored)
//   node paper-bot/news-pick.mjs --score              # evening: score outstanding picks + controls

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay, tradingDaysBetween, lastSessionDate } from './market-calendar.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';
import { isRoundup } from './news.mjs';
import { classifyEvent, mainEvent, historyFor, EVENT_TYPES, FINANCE_WORDS, nseTime, cleanSymbol, watchlist, strategyHoldings, wilson } from './news-watch.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = () => process.env.NEWS_PICK_PATH || join(HERE, 'data', 'news-pick.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const NP = { costPct: 0.3, maxCandidates: 25, maxPicks: 3, pacingMs: 800, minN: 100, liquidTop: 300, maxItems: 6, keepDays: 60, openMins: 555 };
export const HORIZONS = { day: 'Same day (open → close)', five: '5 sessions (open → 5th close)' };
export const DISCLAIMER =
  'Unproven: no news rule predicted direction reliably after costs in testing; order-win news was priced into the open and then faded −1.7% open→close on average. ' +
  'Picks are scored from the day\'s OPEN (a price you could trade) vs NIFTY from its open, net of 0.3% costs, next to a random stock from the same pool. ' +
  'Not better than the random control until the scorecard says so. Feeds no strategy. Not advice.';
export const NO_AI_LINE = 'No picks: the AI key was rejected or is missing — replace the OpenRouter key in the Keychain (trading-research-openrouter). Showing the candidates and their events only.';

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ddmmyyyy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const istNow = (now) => {
  const s = new Date(now.getTime() + 19800_000).toISOString();
  return { date: s.slice(0, 10), mins: +s.slice(11, 13) * 60 + +s.slice(14, 16), hhmm: s.slice(11, 16) };
};
const r3 = (x) => Math.round(x * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (p, fb) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
};
const PRIORITY = ['order_win', 'results', 'rating', 'corporate_action', 'fund_raise', 'management', 'regulatory', 'other'];

// ---------------- small pure helpers ----------------
/** Deterministic index in [0, n) from a date string (FNV-1a → mulberry32), so the control is reproducible. */
export function seededIndex(seed, n) {
  if (!(n > 0)) return -1;
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
}
/** The session before `date` and the start of the news window (its 15:30 IST close). */
export function newsWindow(date) {
  const prevSess = tradingDaysBetween(addDays(date, -12), addDays(date, -1)).at(-1) || addDays(date, -1);
  return { prevSess, since: `${prevSess}T15:30:00+05:30` };
}
/** The 5-session target: the 5th session counting the pick day. */
export const targetSession = (date, horizon) => (horizon === 'day' ? date : tradingDaysBetween(date, addDays(date, 20))[4] || null);

// ---------------- NSE: all equities in one call ----------------
/** NSE all-equities corporate-announcements JSON → [{symbol, company, source:'NSE', time, title, detail, link}]. */
export function parseAllAnnouncements(j) {
  const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
  return rows
    .map((r) => ({
      symbol: cleanSymbol(r.symbol),
      company: String(r.sm_name || '').trim() || null,
      source: 'NSE',
      time: nseTime(r.exchdisstime || r.an_dt) || null,
      title: String(r.desc || 'Announcement').trim(),
      detail: String(r.attchmntText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      link: /^https:\/\/(nsearchives|archives)\.nseindia\.(com|in)\//.test(r.attchmntFile || '') ? r.attchmntFile : null,
    }))
    .filter((x) => x.time && /^[A-Z0-9&-]{1,20}$/.test(x.symbol));
}
/** One request for every equity's announcements between two dates (curl + cookie jar; Node's fetch is refused). */
export async function fetchAllAnnouncements(from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  const jar = join(dir, 'cj.txt');
  const base = ['-s', '-L', '--compressed', '--max-time', '60', '-b', jar, '-c', jar, '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/companies-listing/corporate-filings-announcements'];
  try {
    await run('curl', [...base, '-H', 'Accept: text/html,*/*;q=0.8', '-o', '/dev/null', 'https://www.nseindia.com/']).catch(() => {});
    await sleep(NP.pacingMs);
    const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`;
    const { stdout } = await run('curl', [...base, '-H', 'Accept: */*', url], { maxBuffer: 64 * 1024 * 1024 });
    return parseAllAnnouncements(JSON.parse(stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- the candidate pool ----------------
/**
 * Pool = liquid stocks with non-routine NSE announcements in [since, until) not on the avoid list, ordered by event
 * (order win, results, rating … first) then traded value; the watchlist (not on the avoid list) comes after the typed
 * events and before announcements of type "other"; then the cap.
 */
export function buildPool({ ann = [], liquid = new Set(), avoid = {}, watch = [], since, until = null, cap = NP.maxCandidates, valueOf = () => 0 }) {
  const by = new Map();
  for (const a of ann) {
    if (a.time < since || (until && a.time >= until)) continue;
    if (!by.has(a.symbol)) by.set(a.symbol, []);
    by.get(a.symbol).push(a);
  }
  const ex = { announced: by.size, illiquid: 0, avoid: [], routineOnly: 0, overCap: [] };
  const rows = [];
  for (const [sym, items0] of by) {
    if (!liquid.has(sym)) {
      ex.illiquid++;
      continue;
    }
    if (avoid[sym]?.length) {
      ex.avoid.push(sym);
      continue;
    }
    const items = items0.sort((a, b) => b.time.localeCompare(a.time)).map(({ symbol, company, ...x }) => ({ ...x, event: classifyEvent(`${x.title} ${x.detail}`) }));
    const ev = mainEvent(items);
    if (!ev) {
      ex.routineOnly++;
      continue;
    }
    rows.push({ symbol: sym, company: items0[0].company || null, from: ['NSE announcement'], items, event: ev, value: valueOf(sym) || 0 });
  }
  rows.sort((a, b) => PRIORITY.indexOf(a.event.type) - PRIORITY.indexOf(b.event.type) || b.value - a.value || a.symbol.localeCompare(b.symbol));
  for (const w of watch) {
    const sym = cleanSymbol(w.symbol);
    const have = rows.find((r) => r.symbol === sym);
    if (have) {
      for (const f of w.from || []) if (!have.from.includes(f)) have.from.push(f);
      continue;
    }
    if (avoid[sym]?.length) {
      if (!ex.avoid.includes(sym)) ex.avoid.push(sym);
      continue;
    }
    rows.push({ symbol: sym, company: null, from: ['News watch', ...(w.from || [])], items: [], event: null, value: valueOf(sym) || 0 });
  }
  // order: announced with a typed event → the watchlist → announced with only "other" news; then the cap
  const rank = (r) => (!r.event ? 1 : r.event.type === 'other' ? 2 : 0);
  rows.sort((a, b) => rank(a) - rank(b));
  ex.overCap = rows.slice(cap).map((r) => r.symbol);
  return { candidates: rows.slice(0, cap), excluded: ex };
}

// ---------------- the AI ranking ----------------
export function pickMessages(date, candidates) {
  const block = candidates
    .map((c, i) => {
      const its = (c.items || [])
        .filter((x) => !x.event?.routine)
        .slice(0, NP.maxItems)
        .map((x) => `   - [${x.source}${x.event && x.event.type !== 'other' ? ` · ${EVENT_TYPES[x.event.type]}` : ''}] ${x.time ? x.time.slice(0, 16).replace('T', ' ') : ''} ${x.title}${x.detail ? ` — ${x.detail.slice(0, 160)}` : ''}`);
      return `${i + 1}. ${c.symbol}${c.company ? ` (${c.company})` : ''} · event: ${c.event ? EVENT_TYPES[c.event.type] : 'none'}${c.event?.sub ? ` (${c.event.sub})` : ''}\n   tested history: ${historyFor(c.event)?.text || 'none for this type'}\n${its.join('\n') || '   (no company news)'}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You pick at most 3 Indian stocks to BUY at today\'s market OPEN for a research scorecard, from overnight company news. Each pick is scored from today\'s open to today\'s close and to the close 5 sessions later, ' +
        'against NIFTY from its own open, after 0.3% costs, next to a RANDOM stock from the same list. Be honest about what testing found: NO type of news predicted direction reliably after costs. ' +
        'Order-win news is priced into the open — 18 of 22 order-win days opened higher (+1.4% gap) and then FADED −1.7% from open to close on average; buying at the first tradeable price after news lost about −2% a day. ' +
        'Results-day gaps did not continue. Rights issues, bonus board-meeting news, surveillance/ASM and price-band cuts were confirmed NEGATIVES — never pick those. ' +
        '"No pick today" is the right answer most days: pick only when an item gives a concrete, new, material reason that is plausibly NOT already in the opening price. ' +
        'Keep confidence modest (0.5 = coin flip). Use ONLY the items given; pick only symbols from the list. ' +
        'Reply ONLY with JSON: {"picks":[{"symbol":"SYM","reason":"one line citing the item","confidence":0-1}],"no_pick_reason":"one line if picks is empty"}',
    },
    { role: 'user', content: `Date: ${date} (picks are bought at today's open)\nCandidates (${candidates.length}):\n${block || '(none)'}` },
  ];
}
/** Ling's reply → {picks, noPickReason, dropped}; keeps only listed, non-avoid symbols, max 3. */
export function parsePicks(raw, candidates) {
  const j = extractJson(raw, (o) => 'picks' in o || 'no_pick_reason' in o);
  if (!j) return null;
  const pool = new Map(candidates.map((c) => [c.symbol, c]));
  const picks = [];
  const dropped = [];
  for (const p of Array.isArray(j.picks) ? j.picks : []) {
    const sym = cleanSymbol(p?.symbol);
    const c = pool.get(sym);
    if (!c) dropped.push({ symbol: sym || '?', why: 'not in the candidate list' });
    else if (historyFor(c.event)?.avoid) dropped.push({ symbol: sym, why: 'a tested avoid event' });
    else if (picks.some((x) => x.symbol === sym)) continue;
    else if (picks.length >= NP.maxPicks) dropped.push({ symbol: sym, why: `more than ${NP.maxPicks} picks` });
    else picks.push({ symbol: sym, reason: String(p.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240) || null, confidence: Math.round(normalizeConfidence(p.confidence, 0.5) * 100) / 100 });
  }
  return { picks, noPickReason: picks.length ? null : String(j.no_pick_reason || j.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240) || 'nothing concrete enough today', dropped };
}

// ---------------- default I/O ----------------
async function defaultNews(symbol) {
  const { newsBrief } = await import('./news.mjs');
  return newsBrief(`${symbol}.NS`, { useLlm: false });
}
async function defaultLlm(messages) {
  const { chat } = await import('../ling-client.mjs');
  return chat(messages, { temperature: 0, timeoutMs: 60_000, jsonKeys: ['picks'] });
}
async function defaultAvoid() {
  const { avoidListView } = await import('./avoid-list.mjs');
  return avoidListView().bySymbol || {};
}
async function defaultSeries(months) {
  const { loadSeries } = await import('./bhav-history.mjs');
  return loadSeries({ months });
}
/** Point-in-time liquid set for `date` + last traded value per symbol, from the bhav store. */
export async function liquidity(date, seriesFn = defaultSeries) {
  const { pointInTimeUniverse } = await import('./bhav-history.mjs');
  const prevMonth = addDays(`${date.slice(0, 7)}-01`, -1).slice(0, 7);
  const series = await seriesFn([prevMonth, date.slice(0, 7)]);
  const set = pointInTimeUniverse(series, NP.liquidTop).get(date.slice(0, 7)) || new Set();
  const val = new Map([...series].map(([s, rows]) => [s, rows.filter((r) => r.date < date).at(-1)?.val || 0]));
  return { set, valueOf: (s) => val.get(s) || 0 };
}
/** Opens and closes (stock: bhav store first, Yahoo fallback; NIFTY: Yahoo) from `from`. */
export async function defaultPrices(symbols, from, needDates = []) {
  const { candles } = await import('../market-data.mjs');
  const months = [];
  const end = new Date(Date.now() + 19800_000).toISOString().slice(0, 7);
  for (let ym = addDays(`${from.slice(0, 7)}-01`, -1).slice(0, 7); ym <= end; ym = addDays(`${ym}-28`, 5).slice(0, 7)) months.push(ym);
  let series = new Map();
  try {
    series = await defaultSeries(months);
  } catch {
    /* Yahoo below */
  }
  const period1 = Math.floor(Date.parse(`${addDays(from, -7)}T00:00:00Z`) / 1000);
  const yahoo = async (y) => new Map((await candles(y, { period1, interval: '1d' })).filter((r) => r.open > 0 && r.close > 0).map((r) => [r.date, { open: r.open, close: r.close }]));
  const out = new Map();
  for (const s of symbols) {
    const rows = series.get(s) || [];
    const m = new Map(rows.filter((r) => r.date >= addDays(from, -7)).map((r) => [r.date, { open: r.open, close: r.close }]));
    if (needDates.some((d) => !m.has(d))) {
      try {
        const y = await yahoo(`${s}.NS`);
        for (const [d, v] of y) if (!m.has(d)) m.set(d, v);
      } catch {
        /* scoring waits */
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

// ---------------- scoring ----------------
/**
 * Score every non-test log entry (picks and controls alike) whose target session is complete (≤ upTo) and priced.
 * Entry = the pick day's OPEN; exit = the target close; NIFTY from its open the same day to the same close.
 * hit = beat NIFTY after costs (stock % − NIFTY % − 0.3 > 0). Mutates and returns the log.
 */
export function scorePicks(log, { series, nifty }, upTo, cost = NP.costPct) {
  for (const e of log) {
    if (e.test) continue;
    e.score ||= {};
    for (const h of Object.keys(HORIZONS)) {
      if (e.score[h]?.scored) continue;
      const T = targetSession(e.date, h);
      e.score[h] = { target: T, scored: false };
      if (!T || T > upTo) continue;
      const s = series.get(e.symbol);
      const o = s?.get(e.date)?.open;
      const c = s?.get(T)?.close;
      const no = nifty.get(e.date)?.open;
      const nc = nifty.get(T)?.close;
      if (!(o > 0 && c > 0 && no > 0 && nc > 0)) continue;
      const prevDate = [...(s?.keys() || [])].filter((d) => d < e.date).sort().at(-1);
      const prevClose = prevDate ? s.get(prevDate).close : null;
      const stockPct = (c / o - 1) * 100;
      const niftyPct = (nc / no - 1) * 100;
      e.score[h] = {
        target: T,
        scored: true,
        entryOpen: o,
        exitClose: c,
        gapPct: prevClose > 0 ? r3((o / prevClose - 1) * 100) : null, // how much was already in the open
        stockPct: r3(stockPct),
        niftyPct: r3(niftyPct),
        netPct: r3(stockPct - cost),
        netVsNiftyPct: r3(stockPct - niftyPct - cost),
        hit: stockPct - niftyPct - cost > 0,
      };
    }
  }
  return log;
}
export function tally(rows, h) {
  const done = rows.filter((e) => e.score?.[h]?.scored).map((e) => e.score[h]);
  const n = done.length;
  const hits = done.filter((x) => x.hit).length;
  const sum = (k) => done.reduce((a, x) => a + x[k], 0);
  const gaps = done.filter((x) => x.gapPct != null);
  return {
    n,
    hits,
    hitRate: n ? hits / n : null,
    ci: wilson(hits, n),
    avgNetPct: n ? sum('netPct') / n : null,
    sumNetPct: n ? sum('netPct') : 0,
    avgNetVsNiftyPct: n ? sum('netVsNiftyPct') / n : null,
    sumNetVsNiftyPct: n ? sum('netVsNiftyPct') : 0,
    avgGapPct: gaps.length ? gaps.reduce((a, x) => a + x.gapPct, 0) / gaps.length : null,
    pending: rows.filter((e) => !e.score?.[h]?.scored).length,
  };
}
export function pickVerdict(p, c, minN = NP.minN) {
  if (p.n < minN || !p.ci) return `unproven — not better than the random control yet (${p.n} of ${minN} scored picks needed)`;
  const beats = c.n > 0 && p.hitRate > c.hitRate && p.avgNetVsNiftyPct > c.avgNetVsNiftyPct;
  if (beats && p.ci[0] > 0.5) return 'better than the random control so far (hit-rate 95% interval above 50%) — still not advice';
  if (p.ci[1] < 0.5) return 'worse than a coin flip (95% interval below 50%) — unproven, the picks lag NIFTY more often than not';
  return 'unproven — not better than the random control yet';
}
/** Picks vs control per horizon. */
export function pickScorecard(log) {
  const real = (log || []).filter((e) => !e.test);
  const picks = real.filter((e) => e.kind === 'pick');
  const ctrl = real.filter((e) => e.kind === 'control');
  const out = { pickDays: new Set(picks.map((e) => e.date)).size };
  for (const h of Object.keys(HORIZONS)) {
    const p = tally(picks, h);
    const c = tally(ctrl, h);
    out[h] = { label: HORIZONS[h], picks: p, control: c, verdict: pickVerdict(p, c), proven: p.n >= NP.minN && c.n > 0 && p.ci[0] > 0.5 && p.hitRate > c.hitRate && p.avgNetVsNiftyPct > c.avgNetVsNiftyPct };
  }
  return out;
}

// ---------------- the morning run ----------------
export const loadNewsPick = () => readJ(STATE(), null);
const isKeyProblem = (msg) => /OPENROUTER_API_KEY|401|rejected the API key|api key/i.test(String(msg));

/**
 * The 08:40 run. Without `force`: quietly skips non-trading days, runs after 09:15 IST, and days that already have a
 * real pick. With `force`: runs for today at any time and is marked a TEST run (shown, never scored).
 */
export async function runNewsPick({
  now = new Date(),
  force = false,
  annFn = fetchAllAnnouncements,
  newsFn = defaultNews,
  llmFn = defaultLlm,
  liquidityFn = liquidity,
  avoidFn = defaultAvoid,
  holdingsFn = strategyHoldings,
  pacingMs = NP.pacingMs,
  clock = () => new Date(),
} = {}) {
  const t = istNow(now);
  const date = t.date;
  if (!force && !isTradingDay(date)) return { skipped: 'holiday', date, message: `${date}: not an NSE trading day — no news pick.` };
  if (!force && t.mins >= NP.openMins) return { skipped: 'late', date, message: `${date} ${t.hhmm} IST: too late for today's pick (it must be made before the 09:15 open). Use --force for a test run (not scored).` };
  const st = loadNewsPick() || { startedAt: date, log: [], days: {} };
  st.log ||= [];
  st.days ||= {};
  if (!force && st.days[date] && !st.days[date].test) return { skipped: 'done', date, message: `${date}: today's pick was already made at ${st.days[date].madeAt} — the first pick stands.`, day: st.days[date] };

  const errors = [];
  const { prevSess, since } = newsWindow(date);
  const until = `${date}T${t.hhmm}:59+05:30`;
  let ann = [];
  try {
    ann = await annFn(prevSess, date);
  } catch (err) {
    errors.push(`NSE announcements unavailable (${String(err.message).split('\n')[0].slice(0, 100)})`);
  }
  let liq = { set: new Set(), valueOf: () => 0 };
  try {
    liq = await liquidityFn(date);
    if (!liq.set.size) errors.push('liquidity filter unavailable (bhav store empty) — announced stocks skipped, watchlist only');
  } catch (err) {
    errors.push(`bhav store unavailable (${err.message}) — watchlist only`);
  }
  let avoid = {};
  try {
    avoid = (await avoidFn()) || {};
  } catch (err) {
    errors.push(`avoid list: ${err.message}`);
  }
  const wl = await watchlist({ holdingsFn });
  if (wl.error) errors.push(wl.error);
  const { candidates, excluded } = buildPool({ ann, liquid: liq.set, avoid, watch: wl.rows, since, until, valueOf: liq.valueOf });

  // headlines per candidate (polite: one at a time, 0.8 s apart). Stop fetching at 08:55 IST so the pick — and the
  // Call / Put tournament that runs after it — finish before the 09:15 open (on 25 Nov 2026 this loop ran until 09:34).
  // budget measured from this run's own clock (t.mins), so tests with a fixed 'now' behave like a real 08:15 run
  const cutoff = force ? Infinity : Date.now() + Math.max(0, 8 * 60 + 55 - t.mins) * 60000;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (Date.now() > cutoff) {
      c.errors = ['headlines skipped: past the 08:55 IST fetch cutoff'];
      continue;
    }
    if (i && pacingMs) await sleep(pacingMs);
    try {
      const news = await newsFn(c.symbol);
      c.company ||= news?.company || null;
      const heads = (news?.headlines || [])
        .filter((h) => !isRoundup(h.title) && FINANCE_WORDS.test(h.title) && (!h.time || Date.parse(h.time) >= Date.parse(since))) // only news since the previous close
        .slice(0, 4)
        .map((h) => ({ source: h.publisher || 'News', time: h.time || null, title: h.title, detail: '', link: /^https?:\/\//.test(h.link || '') ? h.link : null, event: classifyEvent(h.title) }));
      c.items = [...c.items, ...heads];
    } catch (err) {
      c.errors = [`headlines unavailable (${String(err.message).slice(0, 80)})`];
    }
    c.event = mainEvent(c.items);
    c.eventLabel = c.event ? EVENT_TYPES[c.event.type] : null;
    c.history = historyFor(c.event)?.text || null;
    c.items = c.items.slice(0, NP.maxItems + 4);
  }

  let ai = 'ok';
  let aiNote = null;
  let res = { picks: [], noPickReason: 'no candidates this morning', dropped: [] };
  if (candidates.length) {
    try {
      res = parsePicks(await llmFn(pickMessages(date, candidates)), candidates);
      if (!res) {
        ai = 'error';
        aiNote = 'AI reply could not be read — no picks today.';
        res = { picks: [], noPickReason: aiNote, dropped: [] };
      }
    } catch (err) {
      ai = isKeyProblem(err.message) ? 'missing' : 'error';
      aiNote = ai === 'missing' ? NO_AI_LINE : `AI unavailable (${String(err.message).split('\n')[0].slice(0, 100)}) — no picks today.`;
      res = { picks: [], noPickReason: aiNote, dropped: [] };
    }
  }
  const bySym = new Map(candidates.map((c) => [c.symbol, c]));
  const brief = (c) => {
    const items = c.items.filter((x) => !x.event?.routine);
    const main = c.event?.type;
    return { symbol: c.symbol, company: c.company, from: c.from, eventType: main || null, eventLabel: c.eventLabel, eventSub: c.event?.sub || null, history: c.history, items: [...items.filter((x) => x.event?.type === main), ...items.filter((x) => x.event?.type !== main)] }; // main-event items first
  };
  const picks = res.picks.map((p) => ({ ...p, ...brief(bySym.get(p.symbol)) }));
  const ci = picks.length ? seededIndex(date, candidates.length) : -1;
  const control = ci >= 0 ? { ...brief(candidates[ci]), note: 'random stock from the same pool (seeded by the date) — scored the same way' } : null;

  const finished = istNow(clock());
  const late = !force && (finished.date !== date || finished.mins >= NP.openMins);
  const test = force || late;
  const day = {
    date,
    test,
    testReason: force ? 'forced test run (--force) — not scored' : late ? `finished at ${finished.hhmm} IST, after the 09:15 open — not scored` : null,
    madeAt: now.toISOString(),
    prevSess,
    since,
    ai,
    aiNote,
    picks,
    noPickReason: picks.length ? null : res.noPickReason,
    dropped: res.dropped,
    control,
    candidates: candidates.map(brief),
    pool: { candidates: candidates.length, announcedStocks: excluded.announced, illiquid: excluded.illiquid, avoid: excluded.avoid, routineOnly: excluded.routineOnly, overCap: excluded.overCap },
    errors,
  };
  if (!test && picks.length) {
    for (const p of picks) st.log.push({ id: `${date}:pick:${p.symbol}`, date, kind: 'pick', symbol: p.symbol, reason: p.reason, confidence: p.confidence, eventType: bySym.get(p.symbol).event?.type || 'none', madeAt: day.madeAt });
    st.log.push({ id: `${date}:control:${control.symbol}`, date, kind: 'control', symbol: control.symbol, eventType: bySym.get(control.symbol).event?.type || 'none', madeAt: day.madeAt });
  }
  // a test run never replaces a real pick of the same day
  if (!(test && st.days[date] && !st.days[date].test)) st.days[date] = day;
  for (const d of Object.keys(st.days).sort().slice(0, -NP.keepDays)) delete st.days[d];
  st.updatedAt = new Date().toISOString();
  writeJsonAtomic(STATE(), st);
  return { date, day, scorecard: pickScorecard(st.log) };
}

/** Evening: score outstanding picks and controls up to the last completed session. */
export async function scoreNewsPick({ now = new Date(), pricesFn = defaultPrices } = {}) {
  const st = loadNewsPick();
  if (!st?.log?.length) return { scoredNow: 0, scorecard: pickScorecard([]) };
  const upTo = lastSessionDate(now);
  const open = st.log.filter((e) => !e.test && Object.keys(HORIZONS).some((h) => !e.score?.[h]?.scored));
  if (!open.length) return { scoredNow: 0, scorecard: pickScorecard(st.log) };
  const from = open.map((e) => e.date).sort()[0];
  const need = [...new Set(open.flatMap((e) => [e.date, targetSession(e.date, 'five')]).filter((d) => d && d <= upTo))];
  const before = st.log.reduce((a, e) => a + Object.values(e.score || {}).filter((x) => x.scored).length, 0);
  let error = null;
  try {
    scorePicks(st.log, await pricesFn([...new Set(open.map((e) => e.symbol))], from, need), upTo);
  } catch (err) {
    error = `prices unavailable (${err.message})`;
  }
  const after = st.log.reduce((a, e) => a + Object.values(e.score || {}).filter((x) => x.scored).length, 0);
  st.lastScore = { at: now.toISOString(), upTo, scoredNow: after - before, error };
  writeJsonAtomic(STATE(), st);
  return { scoredNow: after - before, error, scorecard: pickScorecard(st.log) };
}

/** What the app serves: today's (latest) pick, the scorecard vs control, the recent log. */
export function newsPickView() {
  const st = loadNewsPick() || { log: [], days: {} };
  const dates = Object.keys(st.days || {}).sort();
  const latestReal = [...dates].reverse().find((d) => !st.days[d].test);
  const latest = dates.length ? st.days[dates.at(-1)] : null;
  return {
    disclaimer: DISCLAIMER,
    latest,
    lastReal: latestReal && latestReal !== latest?.date ? { date: latestReal, picks: st.days[latestReal].picks.map((p) => p.symbol), control: st.days[latestReal].control?.symbol || null } : null,
    scorecard: pickScorecard(st.log),
    recent: (st.log || []).slice(-30).reverse(),
    lastScore: st.lastScore || null,
    startedAt: st.startedAt || null,
    costPct: NP.costPct,
    minN: NP.minN,
    horizons: HORIZONS,
  };
}

export function notifyText(r) {
  const picks = r?.day?.picks || [];
  if (picks.length) return `News pick today: ${picks.map((p) => p.symbol).join(', ')} (unproven — see News watch)`;
  return `No news pick today${r?.day?.ai === 'missing' ? ' (AI key needs replacing)' : ''}`;
}
/** Today's algo plan in one line (first line of the morning notification; logs the plan). Empty when it fails. */
export async function algoPlanLine() {
  try {
    const { algoPlan, logPlan, planLine } = await import('./algo-plan.mjs');
    const p = algoPlan();
    logPlan(p);
    return `${planLine(p)}\n`;
  } catch {
    return '';
  }
}
const notify = (title, message) => execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message.slice(0, 220)], () => {});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
  const sg = (x) => (x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`);
  const card = (sc) => {
    for (const h of Object.keys(HORIZONS)) {
      const s = sc[h];
      const f = (x) => `${x.n} scored (${x.pending} pending) · beat NIFTY ${pct(x.hitRate)}${x.ci ? ` [${pct(x.ci[0])}–${pct(x.ci[1])}]` : ''} · avg net ${sg(x.avgNetPct)} · sum ${sg(x.sumNetPct)}`;
      console.log(`Scorecard ${s.label}: picks ${f(s.picks)} | control ${f(s.control)}\n  → ${s.verdict}`);
    }
  };
  try {
    if (args.includes('--score')) {
      const r = await scoreNewsPick();
      console.log(`News pick scoring: ${r.scoredNow} new scores${r.error ? ` · ${r.error}` : ''}`);
      card(r.scorecard);
      console.log('Not advice.');
    } else if (args.includes('--run')) {
      const r = await runNewsPick({ force: args.includes('--force') });
      if (r.skipped) {
        console.log(r.message);
        process.exit(0);
      }
      const d = r.day;
      console.log(`News pick ${d.date}${d.test ? ` — TEST RUN (${d.testReason})` : ''} · news since ${d.since.replace('T', ' ').slice(0, 16)} IST`);
      console.log(`Pool: ${d.pool.candidates} candidates (NSE: ${d.pool.announcedStocks} stocks announced · ${d.pool.illiquid} outside the top ${NP.liquidTop} · ${d.pool.routineOnly} routine-only · ${d.pool.avoid.length} on the avoid list${d.pool.overCap.length ? ` · ${d.pool.overCap.length} over the cap of ${NP.maxCandidates}` : ''})`);
      for (const c of d.candidates) console.log(`  ${c.symbol.padEnd(11)} ${(c.eventLabel || 'no event').padEnd(34)} ${c.items.length} items · ${c.from.join(', ')}`);
      if (d.picks.length) for (const p of d.picks) console.log(`PICK ${p.symbol} (${Math.round(p.confidence * 100)}%): ${p.reason || ''}`);
      else console.log(`No pick today: ${d.noPickReason}`);
      if (d.control) console.log(`Control (random from the pool): ${d.control.symbol}`);
      if (d.dropped?.length) console.log(`Dropped: ${d.dropped.map((x) => `${x.symbol} (${x.why})`).join(', ')}`);
      if (d.errors.length) console.log(`Problems: ${d.errors.join(' · ')}`);
      card(r.scorecard);
      console.log('Not advice.');
      if (args.includes('--notify') && !d.test) notify('Trading research · morning', `${await algoPlanLine()}${notifyText(r)}`);
    } else {
      console.log('Usage: node paper-bot/news-pick.mjs --run [--notify] [--force]  |  --score');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
