// Event tracker: earnings surprises and other news facts → what followed.
//
// Post-earnings-announcement drift (prices tending to keep moving in the
// direction of an earnings surprise for weeks) is one of the most documented
// market effects. Free historical surprise data isn't available, so this
// records events going forward: when the news facts for a stock show a results
// beat / miss / inline (or an upgrade / downgrade / guidance change), we store
// the event with the price at that time, then measure the return 1, 5 and 20
// trading days later relative to NIFTY 50 ("abnormal return").
// Research only — not investment advice.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { candles } from '../market-data.mjs';
import { newsBrief } from './news.mjs';
import { mapLimit } from '../util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PATH = process.env.EVENTS_PATH || join(__dir, 'data', 'events.json');
export const HORIZONS = [1, 5, 20];

/** Fact → event type (only facts with a clear direction or a results print). */
export function eventsFromFacts(facts = {}) {
  const out = [];
  if (facts.results) out.push(`results:${facts.results}`);
  if (facts.rating) out.push(`rating:${facts.rating}`);
  if (facts.guidance && facts.guidance !== 'maintained') out.push(`guidance:${facts.guidance}`);
  return out;
}

export function loadEvents() {
  try {
    return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : [];
  } catch {
    return [];
  }
}
function saveEvents(list) {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(list, null, 2));
}

/**
 * Record events for one stock from its news facts. The same type for the same
 * stock within 10 days counts once (headlines repeat for days).
 */
export function recordEvents(symbol, facts, { price, date, headline = null, evidence = {}, now = new Date() } = {}) {
  const types = eventsFromFacts(facts);
  if (!types.length || !(price > 0) || !date) return [];
  const list = loadEvents();
  const added = [];
  for (const type of types) {
    const dup = list.some((e) => e.symbol === symbol && e.type === type && Math.abs(new Date(e.date) - new Date(date)) < 10 * 86400000);
    if (dup) continue;
    const ev = { id: `${symbol}|${type}|${date}`, symbol, type, date, price, headline: evidence[type.split(':')[0]] || headline, recordedAt: now.toISOString(), returns: {} };
    list.push(ev);
    added.push(ev);
  }
  if (added.length) saveEvents(list);
  return added;
}

/**
 * Scan a universe's news (one AI reading per stock per day — cached) and
 * record any new events at the latest close.
 */
export async function scanEvents(symbols, { brief = newsBrief, quoteRows = (s) => candles(s, { range: '5d', interval: '1d' }) } = {}) {
  const added = [];
  await mapLimit(symbols.filter((s) => /\.(NS|BO)$/i.test(s)), 4, async (sym) => {
    try {
      const n = await brief(sym);
      if (!eventsFromFacts(n.facts).length) return;
      const rows = await quoteRows(sym);
      const last = rows[rows.length - 1];
      added.push(...recordEvents(sym, n.facts, { price: last.close, date: last.date, headline: n.headlines?.[0]?.title, evidence: n.factEvidence || {} }));
    } catch {
      /* skip stock */
    }
  });
  return added;
}

/**
 * Fill in returns that have become measurable (h trading days after the
 * event), raw and vs NIFTY.
 */
export async function updateEventReturns({ load = candles, now = new Date() } = {}) {
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10); // IST date
  const list = loadEvents();
  const open = list.filter((e) => HORIZONS.some((h) => e.returns[h] == null));
  if (!open.length) return { updated: 0 };
  let index = [];
  try {
    index = await load('^NSEI', { range: '6mo', interval: '1d' });
  } catch {
    /* abnormal return unavailable */
  }
  const idxAt = new Map(index.map((r) => [r.date, r.close]));
  let updated = 0;
  for (const e of open) {
    let rows;
    try {
      rows = await load(e.symbol, { range: '6mo', interval: '1d' });
    } catch {
      continue;
    }
    const i = rows.findIndex((r) => r.date >= e.date);
    if (i < 0) continue;
    for (const h of HORIZONS) {
      if (e.returns[h] != null || i + h >= rows.length) continue;
      // Only settle on a COMPLETED past session (today's bar may still be forming).
      if (!(rows[i + h].date < today)) continue;
      // Same base bar and close for the stock and NIFTY legs, so the abnormal
      // return isn't skewed by a stock price taken at a different time.
      const ret = rows[i + h].close / rows[i].close - 1;
      const i0 = idxAt.get(rows[i].date);
      const i1 = idxAt.get(rows[i + h].date);
      e.returns[h] = { ret, abnormal: i0 && i1 ? ret - (i1 / i0 - 1) : null, through: rows[i + h].date };
      updated++;
    }
  }
  saveEvents(list);
  return { updated };
}

/** Average (abnormal) returns after each event type. */
export function eventStats(list = loadEvents()) {
  const by = {};
  for (const e of list) {
    by[e.type] ||= { type: e.type, n: 0 };
    by[e.type].n++;
    for (const h of HORIZONS) {
      const r = e.returns?.[h];
      if (!r) continue;
      const k = `d${h}`;
      by[e.type][k] ||= { n: 0, sumRet: 0, sumRet2: 0, sumAbn: 0, sumAbn2: 0, nAbn: 0, positive: 0 };
      const s = by[e.type][k];
      s.n++;
      s.sumRet += r.ret;
      s.sumRet2 += r.ret * r.ret;
      if (r.abnormal != null) {
        s.sumAbn += r.abnormal;
        s.sumAbn2 += r.abnormal * r.abnormal;
        s.nAbn++;
        if (r.abnormal > 0) s.positive++;
      }
    }
  }
  // t-stat of the mean: mean / (sd / sqrt(n)); null with n < 2 or zero spread.
  const tStat = (n, sum, sum2) => {
    if (n < 2) return null;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, (sum2 - n * mean * mean) / (n - 1)));
    return sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  };
  return Object.values(by).map((t) => {
    const out = { type: t.type, events: t.n };
    for (const h of HORIZONS) {
      const s = t[`d${h}`];
      out[`d${h}`] = s
        ? { n: s.n, avgRetPct: (s.sumRet / s.n) * 100, avgAbnormalPct: s.nAbn ? (s.sumAbn / s.nAbn) * 100 : null, pctBeatNifty: s.nAbn ? (s.positive / s.nAbn) * 100 : null, nAbnormal: s.nAbn, tStatRet: tStat(s.n, s.sumRet, s.sumRet2), tStatAbnormal: tStat(s.nAbn, s.sumAbn, s.sumAbn2) }
        : null;
    }
    return out;
  }).sort((a, b) => a.type.localeCompare(b.type));
}
