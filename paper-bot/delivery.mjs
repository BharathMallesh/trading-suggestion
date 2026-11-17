#!/usr/bin/env node
// NSE security-wise delivery position (MTO_DDMMYYYY.DAT) store (library + CLI). For each NSE trading day in the app's
// bhav store: quantity traded and deliverable quantity for the stocks the app tracks (series EQ/BE/BZ). Used by the
// ML stock picks (42-session delivery share is one of its strongest features). Stored per month:
//   paper-bot/data/mto/YYYY-MM.json.gz  {date: {SYMBOL: [qtyTraded, delivQty]}, "miss:<date>": 1, __complete: 1}
// History 2009-06 → Nov 2026 was downloaded during the Nov 2026 research; the evening job adds the new days.
//
//   node paper-bot/delivery.mjs            download the missing days (paced, resumable)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MTO_DIR = () => process.env.MTO_DIR || join(HERE, 'data', 'mto');
const BHAV = () => process.env.BHAV_EQ_DIR || join(HERE, 'data', 'bhav-eq');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const SER = new Set(['EQ', 'BE', 'BZ']);
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const readGz = (f) => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));

export const mtoUrl = (d) => `https://nsearchives.nseindia.com/archives/equities/mto/MTO_${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}.DAT`;

/** Parse an MTO file: checks the trade date in its header; keeps tracked symbols (EQ/BE/BZ) → {sym: [qty, deliv]}. */
export function parseMto(txt, date, tracked = null) {
  const want = `Trade Date <${date.slice(8, 10)}-${MON[+date.slice(5, 7) - 1]}-${date.slice(0, 4)}>`;
  if (!txt.includes(want)) throw new Error(`MTO file for ${date} has a different trade date`);
  const rows = {};
  for (const line of txt.split(/\r?\n/)) {
    const c = line.split(',');
    if (c[0] !== '20' || !SER.has(c[3]) || (tracked && !tracked.has(c[2]))) continue;
    rows[c[2]] = [+c[4], +c[5]];
  }
  return rows;
}

/** Delivery rows dated ≤ `to` (default: everything): Map date → {sym: [qty, deliv]}. */
export function loadDelivery(to = '9999-12-31', from = '0000-00-00') {
  const out = new Map();
  if (!existsSync(MTO_DIR())) return out;
  for (const f of readdirSync(MTO_DIR()).filter((x) => /^\d{4}-\d\d\.json\.gz$/.test(x)).sort()) {
    if (f.slice(0, 7) > to.slice(0, 7) || f.slice(0, 7) < from.slice(0, 7)) continue;
    for (const [d, rows] of Object.entries(readGz(join(MTO_DIR(), f)))) if (/^\d/.test(d) && d <= to && d >= from) out.set(d, rows);
  }
  return out;
}

/** Download the delivery files for bhav trading days that the store lacks (from `fromMonth`). */
export async function updateDelivery({ fromMonth = '2009-06', fetchFn = fetch, paceMs = 600, log = console.log } = {}) {
  mkdirSync(MTO_DIR(), { recursive: true });
  const state = JSON.parse(readFileSync(join(BHAV(), 'state.json'), 'utf8'));
  const tracked = new Set(state.tracked);
  const months = readdirSync(BHAV()).filter((f) => /^\d{4}-\d\d\.json\.gz$/.test(f)).map((f) => f.slice(0, 7)).filter((m) => m >= fromMonth).sort();
  let added = 0;
  let missing = 0;
  for (const ym of months) {
    const f = join(MTO_DIR(), `${ym}.json.gz`);
    const done = existsSync(f) ? readGz(f) : {};
    if (done.__complete) continue;
    const days = Object.keys(readGz(join(BHAV(), `${ym}.json.gz`))).filter((d) => /^\d/.test(d)).sort();
    let changed = false;
    for (const d of days) {
      if (done[d] || done[`miss:${d}`]) continue;
      let txt = null;
      let notFound = false;
      for (let a = 0; a < 3 && txt == null && !notFound; a++) {
        try {
          const r = await fetchFn(mtoUrl(d), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
          if (r.status === 403 || r.status === 429) throw Object.assign(new Error(`NSE refused the delivery file (HTTP ${r.status}) — try again later`), { blocked: true });
          if (r.status === 404) notFound = true;
          else if (r.ok) txt = await r.text();
        } catch (e) {
          if (e.blocked) {
            if (changed) writeFileSync(f, gzipSync(JSON.stringify(done)));
            throw e;
          }
          await pause(2000 * (a + 1));
        }
      }
      if (notFound) {
        // not published yet (today's file comes out in the evening) — only mark it missing once it is a week old
        if ((Date.now() - Date.parse(d)) / 86400000 > 7) { done[`miss:${d}`] = 1; changed = true; missing++; }
      } else if (txt != null) {
        const rows = parseMto(txt, d, tracked);
        if (Object.keys(rows).length) { done[d] = rows; added++; } else { done[`miss:${d}`] = 1; missing++; }
        changed = true;
      }
      await pause(paceMs);
    }
    const monthOver = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).getTime() + 8 * 86400000 < Date.now();
    if (monthOver && days.every((d) => done[d] || done[`miss:${d}`])) { done.__complete = 1; changed = true; }
    if (changed) writeFileSync(f, gzipSync(JSON.stringify(done)));
  }
  const all = loadDelivery('9999-12-31', months.at(-1) ? `${months.at(-1)}-01` : '0000-00-00');
  const last = [...all.keys()].sort().at(-1) || null;
  log(`Delivery data: +${added} day(s)${missing ? `, ${missing} not published` : ''} · latest ${last ?? 'none this month'}`);
  return { added, missing, last };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await updateDelivery({ fromMonth: process.argv[2] || '2009-06' });
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
