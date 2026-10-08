#!/usr/bin/env node
// FII positioning test (library + CLI): does how foreign institutions are
// positioned in NIFTY index derivatives predict NIFTY's next move?
//
// Data: NSE's free daily "participant-wise open interest" files
// (archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv),
// cached per day in paper-bot/data/fii/. Features (FII row):
//   longRatio   index-futures long / (long + short) — unaffected by lot-size changes
//   longRatioZ  its z-score vs the previous 60 days
//   ratioChg5   change in longRatio over 5 sessions
//   optNet      (index call long − call short) − (index put long − put short),
//               scaled by total index option OI
// Test: rank correlation (IC) of each feature with NIFTY's next 5 / 20-day
// return at non-overlapping dates, t-stat, both halves. Fixed rules, no fitting.
// Research only — not investment advice.
//
//   node paper-bot/fii.mjs            # fetch (first run ~3–5 min) + test

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { candles } from '../market-data.mjs';
import { spearman } from './ranking.mjs';
import { mapLimit } from '../util.mjs';

const DIR = process.env.FII_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data', 'fii');
const URL = (d) => `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}.csv`;

/** Parse one participant-OI CSV → { FII: {...}, DII: {...}, Client: {...}, Pro: {...} }. */
export function parseParticipantCsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const hi = lines.findIndex((l) => /^Client Type/i.test(l));
  if (hi < 0) return null;
  // Split on commas only: some NSE files have a stray TAB inside a header cell
  // ("Future Stock Short\t,"); splitting on tabs would shift every column.
  const head = lines[hi].split(',').map((h) => h.trim().toLowerCase());
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const idx = {
    futLong: col('future index long'),
    futShort: col('future index short'),
    callLong: col('option index call long'),
    putLong: col('option index put long'),
    callShort: col('option index call short'),
    putShort: col('option index put short'),
  };
  if (Object.values(idx).some((i) => i < 0)) return null;
  const out = {};
  for (const l of lines.slice(hi + 1)) {
    const cells = l.split(',').map((c) => c.trim());
    const who = cells[0];
    if (!who) continue;
    out[who] = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, Number(String(cells[i]).replace(/[^0-9.-]/g, '')) || 0]));
  }
  return out.FII ? out : null;
}

/** Thrown when NSE's CDN blocks us (403 / 429) — stop and retry later. */
export class BlockedError extends Error {}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Positioning for one date (cached). null = no file for that date (holiday).
 * Only a genuine 404 is cached as "no data"; blocks and network errors are
 * never cached (so a temporary block can't poison the history).
 */
export async function participantOi(date, { fetchFn = fetch } = {}) {
  const f = join(DIR, `${date}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let res;
  try {
    res = await fetchFn(URL(date), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch {
    return null; // network issue: try again next time
  }
  if (res.status === 403 || res.status === 429) throw new BlockedError('NSE is temporarily blocking downloads — try again later (cached days are kept).');
  let data = null;
  if (res.ok) {
    const text = await res.text();
    if (/Access Denied/i.test(text)) throw new BlockedError('NSE is temporarily blocking downloads — try again later (cached days are kept).');
    data = parseParticipantCsv(text);
    if (!data) return null; // unexpected format: don't cache
  } else if (res.status !== 404) {
    return null; // other errors: don't cache
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(f, JSON.stringify(data));
  return data;
}

/** Features from a dated series of FII rows (oldest first). */
export function fiiFeatures(series) {
  const ratio = series.map((x) => x.fii.futLong / Math.max(1, x.fii.futLong + x.fii.futShort));
  return series.map((x, i) => {
    const w = ratio.slice(Math.max(0, i - 60), i);
    const m = w.reduce((a, b) => a + b, 0) / (w.length || 1);
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length || 1)) || null;
    const o = x.fii;
    const optTotal = o.callLong + o.callShort + o.putLong + o.putShort;
    return {
      date: x.date,
      longRatio: ratio[i],
      longRatioZ: w.length >= 40 && sd ? (ratio[i] - m) / sd : null,
      ratioChg5: i >= 5 ? ratio[i] - ratio[i - 5] : null,
      optNet: optTotal ? (o.callLong - o.callShort - (o.putLong - o.putShort)) / optTotal : null,
    };
  });
}

/**
 * Fetch ~`days` sessions of FII positioning and test it against NIFTY.
 * @param {{ days?: number, loadCandles?: Function, fetchFn?: Function, onProgress?: Function }} [opts]
 */
export async function testFii({ days = 750, loadCandles = candles, fetchFn = fetch, onProgress = () => {} } = {}) {
  const nifty = await loadCandles('^NSEI', { range: '5y', interval: '1d' });
  const dates = nifty.map((r) => r.date).slice(-days);
  let done = 0;
  let blocked = null;
  // Politely: 2 at a time, short pause; stop at the first block.
  const rows = await mapLimit(dates, 2, async (d) => {
    if (blocked) return null;
    try {
      const cached = existsSync(join(DIR, `${d}.json`));
      const oi = await participantOi(d, { fetchFn });
      if (!cached && fetchFn === fetch) await pause(150);
      if (++done % 100 === 0) onProgress(done, dates.length);
      return oi ? { date: d, fii: oi.FII } : null;
    } catch (err) {
      if (err instanceof BlockedError) blocked = err.message;
      return null;
    }
  });
  const series = rows.filter(Boolean);
  if (series.length < 200) throw new Error(`Only ${series.length} days of FII data available.${blocked ? ' ' + blocked : ''}`);
  const feats = fiiFeatures(series);
  const closeAt = new Map(nifty.map((r, i) => [r.date, i]));
  const result = { days: series.length, from: series[0].date, to: series[series.length - 1].date, horizons: {} };
  for (const h of [5, 20]) {
    const pts = [];
    for (let k = 60; k < feats.length; k += h) {
      const i = closeAt.get(feats[k].date);
      if (i == null || i + h >= nifty.length) continue;
      pts.push({ ...feats[k], fwd: nifty[i + h].close / nifty[i].close - 1 });
    }
    const out = {};
    for (const f of ['longRatio', 'longRatioZ', 'ratioChg5', 'optNet']) {
      const p = pts.filter((x) => x[f] != null);
      if (p.length < 20) continue;
      const ic = spearman(p.map((x) => x[f]), p.map((x) => x.fwd));
      const half = p.length >> 1;
      const ic1 = spearman(p.slice(0, half).map((x) => x[f]), p.slice(0, half).map((x) => x.fwd));
      const ic2 = spearman(p.slice(half).map((x) => x[f]), p.slice(half).map((x) => x.fwd));
      // t-stat of a correlation: r·√((n−2)/(1−r²))
      const t = ic != null && Math.abs(ic) < 1 ? ic * Math.sqrt((p.length - 2) / (1 - ic * ic)) : null;
      // simple rule check: when the feature is above its median, how often was NIFTY up?
      const med = [...p].map((x) => x[f]).sort((a, b) => a - b)[p.length >> 1];
      const hi = p.filter((x) => x[f] > med);
      const lo = p.filter((x) => x[f] <= med);
      const upRate = (a) => a.filter((x) => x.fwd > 0).length / (a.length || 1);
      out[f] = {
        n: p.length,
        ic,
        tStat: t,
        icFirstHalf: ic1,
        icSecondHalf: ic2,
        upRateWhenHigh: upRate(hi),
        upRateWhenLow: upRate(lo),
        // Same sign overall AND in both halves, or it's not evidence at all.
        evidence: (() => {
          const consistent = ic && ic1 && ic2 && Math.sign(ic) === Math.sign(ic1) && Math.sign(ic) === Math.sign(ic2);
          if (!consistent) return 'none';
          return t != null && Math.abs(t) >= 2 ? 'strong' : 'weak';
        })(),
      };
    }
    result.horizons[h] = { periods: pts.length, baseUpRate: pts.filter((x) => x.fwd > 0).length / (pts.length || 1), features: out };
  }
  result.latest = feats[feats.length - 1];
  result.blocked = blocked;
  result.note = 'IC = rank correlation with the next h-day NIFTY return (non-overlapping). "strong" needs |t| ≥ 2 and the same sign in both halves. Positioning is widely watched — weak/no evidence is the expected result.';
  return result;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  testFii({ onProgress: (d, t) => process.stdout.write(`  fetched ${d}/${t} days…\r`) })
    .then((r) => {
      console.log(`\nFII POSITIONING TEST · ${r.days} sessions · ${r.from} → ${r.to}`);
      if (r.blocked) console.log(`(partial: ${r.blocked})`);
      for (const [h, x] of Object.entries(r.horizons)) {
        console.log(`\nNext ${h} sessions · ${x.periods} periods · NIFTY up ${(x.baseUpRate * 100).toFixed(0)}% of the time`);
        console.log('feature        IC      t     1st/2nd half     up% when high / low   evidence');
        for (const [f, v] of Object.entries(x.features)) {
          console.log(`${f.padEnd(12)} ${v.ic.toFixed(3).padStart(6)} ${v.tStat.toFixed(2).padStart(6)}   ${v.icFirstHalf.toFixed(3).padStart(6)} / ${v.icSecondHalf.toFixed(3).padEnd(6)}   ${(v.upRateWhenHigh * 100).toFixed(0).padStart(3)}% / ${(v.upRateWhenLow * 100).toFixed(0)}%            ${v.evidence}`);
        }
      }
      const l = r.latest;
      console.log(`\nLatest (${l.date}): FII index-futures long ratio ${(l.longRatio * 100).toFixed(1)}% (z ${l.longRatioZ?.toFixed(2)}), option net ${l.optNet?.toFixed(3)}`);
      console.log(r.note);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
