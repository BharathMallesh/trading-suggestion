#!/usr/bin/env node
// Bonus / split run-up (library + CLI) — PAPER ONLY. From the Nov 2026 loop-13 study (NSE corporate actions 2008 →):
// stocks tend to rise in the days before a bonus or split goes ex. Frozen rule (designed on 2008–22 only):
//  • Event: an NSE corporate action that is a bonus or a split (sub-division), in a stock the app tracks (ever among
//    NSE's 300 most traded), whose board meeting that considered it was ≥ 3 sessions before entry (within 180 days).
//  • Buy at the OPEN 10 sessions before the ex-date; sell at the CLOSE of the session before the ex-date (so the
//    holding is never through the ex-date). One trade per stock per 20 sessions; 10 equal slots; idle cash 6%.
//  • Costs 0.35% round trip, +0.30% when the stock ranks below 150 by traded value (most do).
// Research, excess over stocks of the same size after costs: 2008–22 +3.0% a trade (t 6.2); run once, frozen, on later
// data: 2023–24 +4.3% (t 4.8), 2025 → Nov 2026 +2.3% (t 2.6). The ₹5 lakh account trailed India mix in 2025–26
// (10.8% vs 20.1% a year after tax) — few trades, so mostly cash; a handful of big winners carry it.
// LIVE CHANGE (stated, not hidden): NSE usually lists the ex-date fewer than 10 sessions ahead, which the research could
// not check. Here a trade is bought at the next open after the ex-date first appears on NSE, at most 10 sessions
// before it ("late" when fewer), and only with ≥ 3 sessions left. The record shows how often that happens.
// Also found (avoid): buying ON a bonus/split ex-date (−6% vs same-size stocks over 20 sessions) or right after a bonus
// board meeting (−5 to −7%). Not advice.
//
//   node paper-bot/bonus-runup.mjs --paper

import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { writeJsonAtomic } from '../util.mjs';
import { loadState as bhavState } from './bhav-history.mjs';
import { nseDate, tradingDaysBetween } from './market-calendar.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const PAPER = () => process.env.BONUS_RUNUP_PAPER_PATH || join(HERE, 'data', 'bonus-runup-paper.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const BSR = { pre: 10, minHold: 3, bmLag: 3, bmDays: 180, gap: 20, slots: 10, cost: 0.35, smallCost: 0.3, smallRank: 150, capital: 500000, cashYield: 0.06, taxRate: 0.208 };
export const RESEARCH = {
  rows: [
    { period: '2008–2022 (designed)', trades: 404, excessPct: 2.97, t: 6.2, account: 0.121, maxDD: null, note: 'India mix 15.1%, Momentum 10 19.9%, NIFTY 11.2% (2010–22)' },
    { period: '2023–2024 (frozen, run once)', trades: 136, excessPct: 4.34, t: 4.8, account: 0.37, maxDD: 0.099, note: 'India mix 26.7%, Momentum 10 32.0%, NIFTY 15.3%' },
    { period: '2025 → Nov 2026 (frozen, run once)', trades: 120, excessPct: 2.25, t: 2.6, account: 0.108, maxDD: 0.097, note: 'India mix 20.1%, Momentum 10 14.3%, NIFTY 1.6%' },
  ],
  verdict: 'a real per-trade edge in all three periods, but the account trailed India mix in 2025–26; without its 10 best trades the 2025–26 edge is only +0.4% a trade; 80%+ of trades are in less-traded stocks',
};

export const isBonusSplit = (s) => /bonus|split|sub[\s-]*div/i.test(String(s || ''));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ddmmyyyy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

export const loadBonusRunupPaper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Plan one event: entry at the open `pre` sessions before ex (or the first session after the ex-date was first seen,
 * if that is later), exit at the close of the session before ex. Needs ≥ minHold sessions and a bonus/split board
 * meeting dated in [ex − bmDays, entry − bmLag sessions]. `days` = sorted trading days covering the window.
 */
export function planEvent({ ex, firstSeen, bmDates = [], days, R = BSR }) {
  const exi = days.findIndex((d) => d >= ex);
  if (exi < 0 || days[exi] !== ex) return { skip: 'ex-date is not a trading day' };
  if (exi < R.pre) return { skip: 'not enough calendar' };
  const ideal = exi - R.pre;
  const seenNext = days.findIndex((d) => d > firstSeen);
  if (seenNext < 0) return { skip: 'not enough calendar' };
  const ei = Math.max(ideal, seenNext);
  const xi = exi - 1;
  if (xi - ei + 1 < R.minHold) return { skip: `ex-date listed too late (${Math.max(0, xi - seenNext + 1)} sessions left)` };
  const lim = days[Math.max(ei - R.bmLag, 0)];
  const lo = addDays(ex, -R.bmDays);
  if (!bmDates.some((D) => D >= lo && D <= lim)) return { skip: 'no bonus/split board meeting ≥ 3 sessions before entry' };
  return { entryDate: days[ei], exitDate: days[xi], sessions: xi - ei + 1, late: ei > ideal };
}

/** NSE API JSON via curl (Node's fetch is refused by NSE's server over HTTP/2). */
async function nseJson(urls) {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  const jar = join(dir, 'cj.txt');
  const base = ['-s', '-L', '--compressed', '--max-time', '60', '-b', jar, '-c', jar, '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/'];
  try {
    await run('curl', [...base, '-H', 'Accept: text/html,*/*;q=0.8', '-o', '/dev/null', 'https://www.nseindia.com/']).catch(() => {});
    const out = [];
    for (const u of urls) {
      await new Promise((r) => setTimeout(r, 800));
      const { stdout } = await run('curl', [...base, '-H', 'Accept: */*', u], { maxBuffer: 50 * 1024 * 1024 });
      out.push(JSON.parse(stdout));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function fetchCorporate(today, fetcher = nseJson) {
  const [ca, bm] = await fetcher([
    `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${ddmmyyyy(addDays(today, -10))}&to_date=${ddmmyyyy(addDays(today, 120))}`,
    `https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=${ddmmyyyy(addDays(today, -200))}&to_date=${ddmmyyyy(today)}`,
  ]);
  return {
    actions: (Array.isArray(ca) ? ca : []).filter((r) => isBonusSplit(r.subject)).map((r) => ({ symbol: r.symbol, ex: nseDate(r.exDate), subject: r.subject })).filter((r) => r.ex),
    meetings: (Array.isArray(bm) ? bm : []).filter((r) => isBonusSplit(`${r.bm_purpose || ''} ${r.bm_desc || ''}`)).map((r) => ({ symbol: r.bm_symbol, date: nseDate(r.bm_date) })).filter((r) => r.date && r.date <= today),
  };
}

function rawMonths(from, to) {
  const out = new Map(); // date → Map(sym → {o, c, val})
  if (!existsSync(BHAV())) return out;
  for (const f of readdirSync(BHAV()).filter((x) => /^\d{4}-\d{2}\.json\.gz$/.test(x)).sort()) {
    const ym = f.slice(0, 7);
    if (ym < from.slice(0, 7) || ym > to.slice(0, 7)) continue;
    const m = JSON.parse(gunzipSync(readFileSync(join(BHAV(), f))).toString('utf8'));
    for (const d of Object.keys(m)) {
      if (d < from || d > to) continue;
      out.set(d, new Map(m[d].map(([sym, o, , , c, , val]) => [sym, { o, c, val }])));
    }
  }
  return out;
}

/** Traded-value rank (1 = most traded) by median value over the given sessions. */
export function valueRanks(byDate) {
  const vals = new Map();
  for (const rows of byDate.values()) for (const [s, r] of rows) (vals.get(s) || vals.set(s, []).get(s)).push(r.val);
  const med = [...vals].filter(([, v]) => v.length >= 10).map(([s, v]) => [s, [...v].sort((a, b) => a - b)[v.length >> 1]]);
  med.sort((a, b) => b[1] - a[1]);
  return new Map(med.map(([s], i) => [s, i + 1]));
}

/** Daily update: merge NSE's list, then walk each new session in the bhav store (entries at the open, exits at the close). */
export async function bonusRunupPaperUpdate({ now = new Date(), fetchFn = fetchCorporate, R = BSR } = {}) {
  const today = new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const bs = bhavState();
  const lastBhav = bs.lastDate;
  if (!lastBhav) throw new Error('NSE daily files are missing — run paper-bot/bhav-history.mjs first');
  const tracked = new Set(bs.tracked || []);
  let st = loadBonusRunupPaper();
  if (!st) st = { startedAt: today, rules: R, lastDate: lastBhav, cash: R.capital, value: R.capital, events: {}, meetings: {}, open: [], closed: [], skipped: [], curve: [{ date: lastBhav, value: R.capital }], lastTrade: {}, fetchError: null };

  try {
    const { actions, meetings } = await fetchFn(today);
    for (const m of meetings) (st.meetings[m.symbol] ||= []).includes(m.date) || st.meetings[m.symbol].push(m.date);
    for (const a of actions) {
      const k = `${a.symbol}|${a.ex}`;
      if (!st.events[k]) st.events[k] = { symbol: a.symbol, ex: a.ex, subject: a.subject, firstSeen: today, status: 'new' };
    }
    st.fetchError = null;
  } catch (err) {
    st.fetchError = `${today}: ${err.message}`;
  }

  // plan new events
  const days = tradingDaysBetween(addDays(lastBhav, -40), addDays(today, 140));
  for (const ev of Object.values(st.events)) {
    if (ev.status !== 'new') continue;
    if (!tracked.has(ev.symbol)) { ev.status = 'skipped'; ev.reason = 'not among the stocks the app tracks'; continue; }
    const p = planEvent({ ex: ev.ex, firstSeen: ev.firstSeen, bmDates: st.meetings[ev.symbol] || [], days, R });
    if (p.skip) { ev.status = 'skipped'; ev.reason = p.skip; continue; }
    Object.assign(ev, p, { status: 'planned' });
  }

  // walk sessions after lastDate
  const px = rawMonths(addDays(st.lastDate, -45), lastBhav);
  const sessions = [...px.keys()].filter((d) => d > st.lastDate).sort();
  for (const d of sessions) {
    const rows = px.get(d);
    const prior = new Map([...px].filter(([x]) => x < d && x >= addDays(d, -35)));
    const ranks = valueRanks(prior);
    const prevD = [...px.keys()].filter((x) => x < d).sort().at(-1);
    if (prevD) st.cash *= 1 + R.cashYield * ((Date.parse(d) - Date.parse(prevD)) / 86400000) / 365;
    const equity = () => st.cash + st.open.reduce((s, p) => s + p.shares * p.last, 0);
    // entries at the open
    const due = Object.values(st.events).filter((e) => e.status === 'planned' && e.entryDate <= d).sort((a, b) => a.ex.localeCompare(b.ex));
    for (const ev of due) {
      const r = rows.get(ev.symbol);
      const lt = st.lastTrade[ev.symbol];
      const sinceLast = lt ? tradingDaysBetween(addDays(lt, 1), d).length : Infinity;
      let why = null;
      if (ev.entryDate < d) why = 'entry session passed before the data arrived';
      else if (!r || !(r.o > 0)) why = 'no trade on the entry day';
      else if (st.open.length >= R.slots) why = 'all 10 slots full';
      else if (sinceLast < R.gap) why = 'traded this stock within 20 sessions';
      if (why) { ev.status = 'skipped'; ev.reason = why; st.skipped.push({ symbol: ev.symbol, ex: ev.ex, reason: why, date: d }); continue; }
      const rank = ranks.get(ev.symbol) ?? 999;
      const costPct = R.cost + (rank > R.smallRank ? R.smallCost : 0);
      const budget = Math.min(equity() / R.slots, st.cash);
      const shares = Math.floor(budget / (r.o * (1 + costPct / 200)));
      if (shares < 1) { ev.status = 'skipped'; ev.reason = 'not enough cash'; continue; }
      const spend = shares * r.o * (1 + costPct / 200);
      st.cash -= spend;
      st.open.push({ symbol: ev.symbol, ex: ev.ex, subject: ev.subject, entryDate: d, exitDate: ev.exitDate, entry: r.o, shares, costPct, rank, late: ev.late, cost: spend, last: r.o });
      st.lastTrade[ev.symbol] = d;
      ev.status = 'bought';
    }
    // marks and exits at the close
    for (const p of [...st.open]) {
      const r = rows.get(p.symbol);
      if (r?.c > 0) p.last = r.c;
      const exitNow = (d >= p.exitDate && r?.c > 0) || d >= p.ex;
      if (!exitNow) continue;
      const proceeds = p.shares * p.last * (1 - p.costPct / 200);
      st.cash += proceeds;
      st.open = st.open.filter((x) => x !== p);
      const ev = st.events[`${p.symbol}|${p.ex}`];
      if (ev) ev.status = 'done';
      st.closed.push({ symbol: p.symbol, ex: p.ex, entryDate: p.entryDate, exitDate: d, entry: p.entry, exit: p.last, shares: p.shares, pnl: proceeds - p.cost, retPct: (proceeds / p.cost - 1) * 100, late: p.late, rank: p.rank, reason: d >= p.ex ? 'no price before ex — last close' : 'day before ex' });
    }
    st.value = equity();
    st.curve.push({ date: d, value: Math.round(st.value) });
    st.lastDate = d;
  }
  // summary
  const byFy = {};
  for (const t of st.closed) {
    const [y, m] = t.exitDate.split('-').map(Number);
    const fy = m >= 4 ? y : y - 1;
    byFy[fy] = (byFy[fy] || 0) + t.pnl;
  }
  const tax = Object.values(byFy).reduce((s, v) => s + Math.max(0, v) * R.taxRate, 0);
  let peak = 0;
  let dd = 0;
  for (const c of st.curve) { peak = Math.max(peak, c.value); dd = Math.max(dd, 1 - c.value / peak); }
  const won = st.closed.filter((t) => t.pnl > 0).length;
  st.summary = { closed: st.closed.length, open: st.open.length, won, late: st.closed.filter((t) => t.late).length, realised: st.closed.reduce((s, t) => s + t.pnl, 0), avgRetPct: st.closed.length ? st.closed.reduce((s, t) => s + t.retPct, 0) / st.closed.length : 0, estTax: tax, afterTaxValue: st.value - tax, maxDD: dd };
  st.upcoming = Object.values(st.events).filter((e) => e.status === 'planned').sort((a, b) => a.entryDate.localeCompare(b.entryDate)).map(({ symbol, ex, subject, entryDate, exitDate, sessions: n, late }) => ({ symbol, ex, subject, entryDate, exitDate, sessions: n, late }));
  st.recentSkips = Object.values(st.events).filter((e) => e.status === 'skipped' && e.ex >= addDays(today, -30)).sort((a, b) => a.ex.localeCompare(b.ex)).map(({ symbol, ex, reason }) => ({ symbol, ex, reason })).slice(-20);
  st.research = RESEARCH;
  st.rules = R;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(PAPER(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await bonusRunupPaperUpdate();
    console.log(`Bonus/split run-up paper: since ${st.startedAt} · data to ${st.lastDate} · value ₹${Math.round(st.value).toLocaleString('en-IN')} · ${st.summary.open} open · ${st.summary.closed} closed · ${st.upcoming.length} planned${st.fetchError ? ` · NSE list not refreshed (${st.fetchError})` : ''}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
