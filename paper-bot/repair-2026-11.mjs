// One-off, idempotent data repair after the 25 Nov 2026 QA pass (round 79). Prints every change.
//   node paper-bot/repair-2026-11.mjs            (same as --dry-run: shows what it would change)
//   node paper-bot/repair-2026-11.mjs --apply    (writes the files; back them up first)
//
// 1. Paper curves (India mix, Momentum 10, Momentum 20, Steady mix) had points keyed by the RUN date, so a run
//    on a Sunday / NSE holiday added a point on a non-trading day (INV-1 / L8). Each such point is:
//      • dropped when the previous trading day already has a point (that day's closes are already recorded);
//      • re-keyed to the previous trading day when it has none AND re-valuing the holdings at that day's
//        closes reproduces the stored value (so the value is from that date's prices);
//      • dropped otherwise. No value is ever invented.
// 2. Prediction log (O-B2 / S-B5): Groww-path entries stored the bare NSE symbol (INFY), and the scorer read it
//    as the US ADR. Bare symbols are mapped to the NSE Yahoo symbol (INFY → INFY.NS, the old one kept in
//    `symbolWas`), and scores with an impossible move (|move| > 50%) are voided (kept in `voidedScore`) so the
//    scorer settles them again on the NSE price.
// Research / paper only.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { yahooSymbolFor, IMPLAUSIBLE_MOVE_PCT } from './prediction-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = () => process.env.REPAIR_DATA_DIR || join(HERE, 'data');
const PRED = () => process.env.PREDICTION_LOG_PATH || join(HERE, 'prediction-history.json');
const LIQUID_YIELD = 0.06; // india-mix / steady-mix MIX.liquidYield
const TOL = 0.0005; // re-key only if the re-valued holdings match the stored value within 0.05%

const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
export function prevTradingDay(d) {
  for (let x = addDays(d, -1), i = 0; i < 20; i++, x = addDays(x, -1)) if (isTradingDay(x)) return x;
  return null;
}

/** Value of the rebalance's holdings at the closes of `date` (liquid parts grown to `liquidTo`, as the original run did). */
async function valueAt(kind, reb, date, liquidTo, closeOn) {
  if (kind === 'equal') {
    let v = 0;
    for (const h of reb.holdings) {
      const px = await closeOn(`${h.symbol}.NS`, date);
      if (px == null) return null;
      v += h.weight * (px / h.entry);
    }
    return reb.value * v;
  }
  let v = 0;
  for (const h of reb.holdings) {
    if (h.kind === 'liquid') {
      v += h.amount * (1 + LIQUID_YIELD) ** Math.max(0, (Date.parse(liquidTo) - Date.parse(reb.date)) / (365.25 * 86400000));
      continue;
    }
    const px = await closeOn(h.symbol, date);
    if (px == null) return null;
    v += h.amount * (px / h.entry);
  }
  return v;
}

export const CURVE_FILES = [
  { file: 'india-mix-paper.json', kind: 'parts' },
  { file: 'steady-mix-paper.json', kind: 'parts' },
  { file: 'momentum10-paper.json', kind: 'equal' },
  { file: 'momentum-paper.json', kind: 'equal' },
];

/** Plan (and with apply, write) the curve repair of one paper file. Returns the changes. */
export async function repairCurve(path, kind, { closeOn, apply = false } = {}) {
  if (!existsSync(path)) return { path, missing: true, changes: [] };
  const st = JSON.parse(readFileSync(path, 'utf8'));
  const curve = st.curve || [];
  const have = new Set(curve.filter((c) => isTradingDay(c.date)).map((c) => c.date));
  const changes = [];
  const out = [];
  for (const c of curve) {
    if (isTradingDay(c.date)) {
      out.push(c);
      continue;
    }
    const to = prevTradingDay(c.date);
    if (have.has(to)) {
      changes.push({ date: c.date, value: c.value, action: 'drop', why: `${to} already has a point` });
      continue;
    }
    const reb = [...(st.rebalances || [])].filter((r) => r.date <= to).at(-1);
    const v = reb ? await valueAt(kind, reb, to, c.date, closeOn) : null;
    if (v != null && Math.abs(v / c.value - 1) <= TOL) {
      changes.push({ date: c.date, value: c.value, action: 're-key', to, check: v, why: `holdings at the ${to} closes give ₹${v.toFixed(2)}` });
      out.push({ ...c, date: to });
      have.add(to);
    } else changes.push({ date: c.date, value: c.value, action: 'drop', check: v, why: v == null ? `no ${to} closes to check it against` : `the ${to} closes give ₹${v.toFixed(2)}, not this value` });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  if (apply && changes.length) {
    st.curve = out;
    st.repairedAt = new Date().toISOString();
    writeJsonAtomic(path, st);
  }
  return { path, before: curve.length, after: out.length, changes };
}

/** Plan (and with apply, write) the prediction-log repair. */
export function repairPredictions(path, { apply = false } = {}) {
  if (!existsSync(path)) return { path, missing: true, remapped: 0, voided: [] };
  const log = JSON.parse(readFileSync(path, 'utf8'));
  let remapped = 0;
  const voided = [];
  for (const e of log.entries || []) {
    const y = yahooSymbolFor(e.symbol);
    if (y !== e.symbol) {
      e.symbolWas = e.symbol;
      e.symbol = y;
      remapped++;
    }
    if (e.evaluated && e.realizedRetPct != null && Math.abs(e.realizedRetPct) > IMPLAUSIBLE_MOVE_PCT) {
      voided.push({ id: e.id, symbol: e.symbol, ts: e.ts, lastClose: e.lastClose, futureClose: e.futureClose, realizedRetPct: e.realizedRetPct });
      e.voidedScore = { futureClose: e.futureClose, realizedRetPct: e.realizedRetPct, realizedLabel: e.realizedLabel, settledAt: e.settledAt ?? null, evalTs: e.evalTs, why: 'settled on the wrong (US) listing — round 79 repair' };
      Object.assign(e, { evaluated: false, evalTs: null, settledAt: null, futureClose: null, realizedRetPct: null, realizedLabel: null, hitBias: null, hitTopProb: null, evalThresholdPct: null });
    }
  }
  if (apply && (remapped || voided.length)) writeJsonAtomic(path, log);
  const n = (log.entries || []).length;
  return { path, entries: n, remapped, voided, evaluatedAfter: (log.entries || []).filter((e) => e.evaluated).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  try {
    const { candles } = await import('../market-data.mjs');
    const cache = new Map();
    const closeOn = async (symbol, date) => {
      if (!cache.has(symbol)) cache.set(symbol, candles(symbol, { period1: Math.floor(Date.parse(addDays(date, -40)) / 1000), interval: '1d' }).catch(() => []));
      const row = (await cache.get(symbol)).find((r) => r.date === date && r.close > 0);
      return row ? row.close : null;
    };
    console.log(apply ? 'APPLYING the repair' : 'DRY RUN (add --apply to write)');
    for (const { file, kind } of CURVE_FILES) {
      const r = await repairCurve(join(DATA(), file), kind, { closeOn, apply });
      if (r.missing) { console.log(`${file}: not found`); continue; }
      console.log(`${file}: ${r.before} → ${r.after} curve points${r.changes.length ? '' : ' (nothing to change)'}`);
      for (const c of r.changes) console.log(`  ${c.date} ₹${c.value.toFixed(2)}: ${c.action}${c.to ? ` → ${c.to}` : ''} (${c.why})`);
    }
    const p = repairPredictions(PRED(), { apply });
    if (p.missing) console.log('prediction log: not found');
    else {
      console.log(`prediction log: ${p.entries} entries · bare symbols mapped to .NS: ${p.remapped} · scores voided: ${p.voided.length} · scored after: ${p.evaluatedAfter}`);
      for (const v of p.voided) console.log(`  void ${v.symbol} ${v.ts}: ${v.lastClose} → ${v.futureClose} (${v.realizedRetPct.toFixed(1)}%)`);
    }
    if (!apply) console.log('Nothing written.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
