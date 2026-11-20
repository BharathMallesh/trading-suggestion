#!/usr/bin/env node
// "Don't buy now" warnings (library + CLI). From the Nov 2026 loop-14 study ("plumbing" events, NSE 2010 → Nov 2026):
// after these events stocks lagged stocks of the same size by about 2–8% over the next 5–20 sessions, in the design years
// (2010–22) AND, frozen and run once, in 2023–24 and 2025–26. Six filters (the GSM one failed validation — left out):
//  (a) 3rd upper-circuit close in a row → avoid 20 sessions      (bh band-hit list "H" and close = high, from NSE's PR zip)
//  (b) price band cut (eq_band_changes: new band < old) → 20 sessions (strongest in the first 5)
//  (c) series change EQ → BE / BZ (trade-for-trade) → 20 sessions (Pd bhavcopy in the PR zip)
//  (d) newly enters long-term ASM → 20 sessions                  (NSE reportASM, diffed against the last saved list)
//  (e) newly enters short-term ASM → 5 sessions
// The avoid window starts at the first session after the information is public (the evening of the event date).
// Mostly small stocks. ~1 in 8 momentum picks were flagged, but skipping them was not proven to help (helped 2023–24, hurt
// slightly 2025–26) — a caution, not a return source. Not advice.
//
//   node paper-bot/avoid-list.mjs --paper

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { tradingDaysBetween } from './market-calendar.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = () => process.env.AVOID_LIST_PATH || join(HERE, 'data', 'avoid-list.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SERIES = new Set(['EQ', 'BE', 'BZ']);

export const RULES = {
  uc3: { label: '3rd upper-circuit close in a row', sessions: 20 },
  bandCut: { label: 'price band cut', sessions: 20 },
  t2t: { label: 'moved to trade-for-trade (EQ → BE/BZ)', sessions: 20 },
  ltasm: { label: 'entered long-term ASM', sessions: 20 },
  stasm: { label: 'entered short-term ASM', sessions: 5 },
};
// Excess return vs same-size stocks after costs (loop 14 runner, entry at the next open). DEV designed; VAL/TEST frozen, run once.
export const RESEARCH = {
  rows: [
    { rule: '3rd upper-circuit close in a row → 20 sessions', dev: -6.8, val: -6.8, test: -5.4, nTest: 549 },
    { rule: 'Price band cut → 20 sessions', dev: -6.9, val: -8.4, test: -6.0, nTest: 1869 },
    { rule: 'Price band cut → first 5 sessions', dev: -4.6, val: -4.4, test: -3.6, nTest: 2017 },
    { rule: 'EQ → BE/BZ (trade-for-trade) → 20 sessions', dev: -6.5, val: -8.1, test: -5.8, nTest: 1064 },
    { rule: 'Enters long-term ASM → 20 sessions', dev: -5.9, val: -5.3, test: -5.1, nTest: 611 },
    { rule: 'Enters short-term ASM → 5 sessions', dev: -4.6, val: -3.3, test: -2.4, nTest: 1688 },
  ],
  periods: 'DEV 2010–22 (designed) · VAL 2023–24 · TEST 2025 → Nov 2026 (both frozen, run once)',
  note: 'Mostly small stocks; ~1 in 8 momentum picks were flagged but skipping them was not proven to help (helped 2023–24, hurt slightly 2025–26) — a caution, not a return source.',
  failed: 'Entering GSM looked strong on 2010–22 but failed validation — not used.',
};

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const num = (x) => {
  const v = parseFloat(String(x ?? '').trim());
  return Number.isFinite(v) ? v : null;
};
const splitCsv = (text) => String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
const okSym = (s) => !!s && !/-RE\d*$/i.test(s); // rights-entitlement lines are not stocks

/** Pd*.csv (bhavcopy inside the PR zip) → Map(sym → {series, o, h, l, c}) for EQ / BE / BZ. Names may contain commas. */
export function parsePd(text) {
  const out = new Map();
  for (const line of splitCsv(text).slice(1)) {
    let p = line.split(',').map((x) => x.trim());
    if (p.length > 16) p = [...p.slice(0, 4), ...p.slice(-12)];
    if (p.length < 14 || !SERIES.has(p[1]) || !okSym(p[2])) continue;
    const [o, h, l, c] = [num(p[5]), num(p[6]), num(p[7]), num(p[8])];
    if (!(c > 0) || !(o > 0)) continue;
    if (!out.has(p[2]) || p[1] === 'EQ') out.set(p[2], { series: p[1], o, h, l, c });
  }
  return out;
}
/** bh*.csv (band-hit list) → Map("SYM|SERIES" → 'H' | 'L'). */
export function parseBh(text) {
  const out = new Map();
  for (const line of splitCsv(text).slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p.length < 4 || !p[0]) continue;
    const hl = [...p.slice(3)].reverse().find((x) => x === 'H' || x === 'L');
    if (hl) out.set(`${p[0]}|${p[1]}`, hl);
  }
  return out;
}
/** eq_band_changes_DDMMYYYY.csv → [{symbol, series, from, to}] (numeric bands only). */
export function parseBand(text) {
  const out = [];
  const lines = splitCsv(text);
  if (!lines.length || lines[0].trim().startsWith('<')) return out;
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p.length < 6 || !p[1] || p[1] === 'NIL') continue;
    const from = num(p.at(-2));
    const to = num(p.at(-1));
    if (from != null && to != null) out.push({ symbol: p[1], series: p[2], from, to });
  }
  return out;
}
/** NSE reportASM JSON → { long: [sym], short: [sym], asOf }. */
export function parseAsm(j) {
  const syms = (xs) => [...new Set((xs || []).map((x) => String(x?.symbol || '').trim()).filter(Boolean))].sort();
  if (!j || typeof j !== 'object' || (!j.longterm && !j.shortterm)) return null;
  const asOf = (j.longterm?.data?.[0] || j.shortterm?.data?.[0])?.asmTime || null;
  return { long: syms(j.longterm?.data), short: syms(j.shortterm?.data), asOf };
}

/** Events of one session: upper-circuit streaks and EQ → BE/BZ moves (needs the previous state), and band cuts. */
export function sessionEvents({ date, pd, bh, band, streaks, lastSeries }) {
  const ev = [];
  const nextStreaks = {};
  for (const [sym, r] of pd) {
    const hit = bh.get(`${sym}|${r.series}`);
    const uc = hit === 'H' && r.c >= r.h - 1e-6;
    if (uc) {
      nextStreaks[sym] = (streaks[sym] || 0) + 1;
      if (nextStreaks[sym] === 3) ev.push({ symbol: sym, code: 'uc3', date, detail: `closed at the upper band 3 sessions in a row (₹${r.c})` });
    }
    const prev = lastSeries[sym];
    if (prev && prev.series === 'EQ' && (r.series === 'BE' || r.series === 'BZ') && prev.date >= addDays(date, -10)) ev.push({ symbol: sym, code: 't2t', date, detail: `series EQ → ${r.series}` });
  }
  for (const b of band || []) {
    if (!SERIES.has(b.series) || !okSym(b.symbol) || !(b.to < b.from)) continue;
    ev.push({ symbol: b.symbol, code: 'bandCut', date, detail: `price band ${b.from}% → ${b.to}%` });
  }
  const seen = { ...lastSeries };
  for (const [sym, r] of pd) seen[sym] = { series: r.series, date };
  return { events: ev, streaks: nextStreaks, lastSeries: seen };
}

/** Avoid window: the N sessions after the event date. */
export function avoidWindow(date, sessions) {
  const days = tradingDaysBetween(addDays(date, 1), addDays(date, sessions * 2 + 30));
  return { since: days[0], until: days[sessions - 1] };
}

async function curlGet(url, out) {
  const { stdout } = await run('curl', ['-s', '-L', '--compressed', '--max-time', '60', '-A', UA, '-H', 'Accept: */*', '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/', '-o', out, '-w', '%{http_code}', url]);
  return Number(stdout);
}
/** One session's NSE files: PR zip (Pd bhavcopy + bh band hits) and the band-change file. null = PR zip not out (yet). */
export async function fetchDay(date) {
  const [y, m, d] = date.split('-');
  const dir = mkdtempSync(join(tmpdir(), 'avoid-'));
  try {
    const zip = join(dir, 'pr.zip');
    const code = await curlGet(`https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR${d}${m}${y.slice(2)}.zip`, zip);
    if (code !== 200 || !existsSync(zip) || readFileSync(zip).subarray(0, 2).toString() !== 'PK') return null;
    const { stdout: list } = await run('unzip', ['-Z1', zip]);
    const names = list.split('\n').map((x) => x.trim()).filter(Boolean);
    const pick = (re) => names.find((n) => re.test(n.split('/').pop()));
    const pdName = pick(/^pd\d*\.csv$/i);
    const bhName = pick(/^bh\d*\.csv$/i);
    if (!pdName) throw new Error(`PR zip for ${date} has no Pd file (${names.join(', ')})`);
    const read = async (n) => (n ? (await run('unzip', ['-p', zip, n], { maxBuffer: 100 * 1024 * 1024, encoding: 'latin1' })).stdout : '');
    const pd = parsePd(await read(pdName));
    const bh = parseBh(await read(bhName));
    const bandFile = join(dir, 'band.csv');
    const bcode = await curlGet(`https://nsearchives.nseindia.com/content/equities/eq_band_changes_${d}${m}${y}.csv`, bandFile).catch(() => 0);
    const band = bcode === 200 && existsSync(bandFile) ? parseBand(readFileSync(bandFile, 'latin1')) : [];
    return { pd, bh, band, files: [pdName, bhName].filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** NSE's live ASM lists (needs the site's cookies; via curl). */
export async function fetchAsm() {
  const dir = mkdtempSync(join(tmpdir(), 'nse-'));
  const jar = join(dir, 'cj.txt');
  const base = ['-s', '-L', '--compressed', '--max-time', '60', '-b', jar, '-c', jar, '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Referer: https://www.nseindia.com/reports/asm'];
  try {
    await run('curl', [...base, '-H', 'Accept: text/html,*/*;q=0.8', '-o', '/dev/null', 'https://www.nseindia.com/']).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const { stdout } = await run('curl', [...base, '-H', 'Accept: */*', 'https://www.nseindia.com/api/reportASM'], { maxBuffer: 50 * 1024 * 1024 });
    const a = parseAsm(JSON.parse(stdout));
    if (!a) throw new Error('ASM list had no long-term / short-term data');
    return a;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const loadAvoidList = () => {
  try {
    return JSON.parse(readFileSync(STATE(), 'utf8'));
  } catch {
    return null;
  }
};
/** Warnings still in force on `date` (until ≥ date), one row per stock and reason. */
export function activeWarnings(st, date) {
  return (st?.events || []).filter((e) => e.until >= date).sort((a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
}
/** What the app serves: the state plus today's active list and a symbol → reasons map for the badges. */
export function avoidListView(now = new Date()) {
  const st = loadAvoidList();
  const today = new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  if (!st) return { active: [], bySymbol: {}, research: RESEARCH, rules: RULES };
  const active = activeWarnings(st, today);
  const bySymbol = {};
  for (const e of active) (bySymbol[e.symbol] ||= []).push({ reason: e.reason, until: e.until });
  return { ...st, events: undefined, active, bySymbol, today };
}

/** Evening update: walk each new session's NSE files, then diff the ASM lists. */
export async function avoidListUpdate({ now = new Date(), fetchDayFn = fetchDay, fetchAsmFn = fetchAsm, firstRunSessions = 5, maxSessions = 15 } = {}) {
  const today = new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  let st = loadAvoidList();
  if (!st) st = { startedAt: today, lastDate: null, streaks: {}, lastSeries: {}, asm: null, events: [], log: [], fetchError: null };
  const errors = [];
  const sessions = st.lastDate
    ? tradingDaysBetween(addDays(st.lastDate, 1), today).slice(0, maxSessions)
    : tradingDaysBetween(addDays(today, -20), today).slice(-firstRunSessions);
  const add = (e) => {
    const r = RULES[e.code];
    if (st.events.some((x) => x.symbol === e.symbol && x.code === e.code && x.date === e.date)) return;
    st.events.push({ ...e, reason: r.label, sessions: r.sessions, ...avoidWindow(e.date, r.sessions) });
  };
  for (const d of sessions) {
    let got;
    try {
      got = await fetchDayFn(d);
    } catch (err) {
      errors.push(`${d}: ${err.message}`);
      break;
    }
    if (!got) {
      // not published yet (today, or a recent day) → try again next run; an old missing day is a holiday NSE didn't list
      if (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`) < 4 * 86400000) {
        if (d !== today) errors.push(`${d}: NSE PR file not available yet`);
        break;
      }
      st.lastDate = d;
      continue;
    }
    const r = sessionEvents({ date: d, pd: got.pd, bh: got.bh, band: got.band, streaks: st.streaks, lastSeries: st.lastSeries });
    r.events.forEach(add);
    st.streaks = r.streaks;
    st.lastSeries = r.lastSeries;
    st.lastDate = d;
    st.log = [...(st.log || []), { date: d, stocks: got.pd.size, bandHits: got.bh.size, bandChanges: got.band.length, events: r.events.length, files: got.files || [] }].slice(-30);
  }
  // ASM: a stock is "new" when it is on today's list and was not on the last saved one (the first run is the baseline)
  try {
    const a = await fetchAsmFn();
    const evDate = st.lastDate || today;
    if (st.asm) {
      const was = { long: new Set(st.asm.long), short: new Set(st.asm.short) };
      for (const s of a.long) if (!was.long.has(s) && okSym(s)) add({ symbol: s, code: 'ltasm', date: evDate, detail: `on NSE's long-term ASM list (${a.asOf || today})` });
      for (const s of a.short) if (!was.short.has(s) && okSym(s)) add({ symbol: s, code: 'stasm', date: evDate, detail: `on NSE's short-term ASM list (${a.asOf || today})` });
    }
    st.asm = { long: a.long, short: a.short, asOf: a.asOf, savedOn: today, baselineOnly: !st.asm };
  } catch (err) {
    errors.push(`ASM: ${err.message}`);
  }
  st.fetchError = errors.length ? `${today}: ${errors.join(' · ')}` : null;
  // keep 120 days of history
  st.events = st.events.filter((e) => e.until >= addDays(today, -120));
  st.research = RESEARCH;
  st.rules = RULES;
  st.updatedAt = now.toISOString();
  writeJsonAtomic(STATE(), st);
  return st;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await avoidListUpdate();
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const act = activeWarnings(st, today);
    const by = {};
    for (const e of act) by[e.code] = (by[e.code] || 0) + 1;
    console.log(`Don't-buy-now list: NSE files to ${st.lastDate || '–'} · ${act.length} active warnings (${Object.entries(by).map(([k, n]) => `${RULES[k].label}: ${n}`).join(', ') || 'none'}) · ASM ${st.asm ? `${st.asm.long.length} long-term / ${st.asm.short.length} short-term${st.asm.baselineOnly ? ' (baseline saved; new entries flagged from the next run)' : ''}` : 'not loaded'}`);
    for (const l of (st.log || []).slice(-5)) console.log(`  ${l.date}: ${l.stocks} stocks, ${l.bandHits} band hits, ${l.bandChanges} band changes, ${l.events} new warnings (${l.files.join(', ')})`);
    if (st.fetchError) console.log(`NSE fetch problem: ${st.fetchError}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
