// Swing trade plan (library): one daily action list for the Strong-stock swing
// with the wide trailing stop — the one trading method that held up in the app's
// 16-year survivorship-free tests. From the evening scan and the "wide" paper record:
//   BUY at the next open — today's breakouts, with shares for 1.5% of capital at risk
//     (capped at 20% of capital a stock), while fewer than 20 positions are open
//   SELL at the next open — held stocks that closed below their trailing stop
//   HOLD — every open position with its stop for tomorrow (5 ATR below the highest high)
// Facts from tested rules and paper records, not advice. Research / paper only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { loadAthPaper, wideRules, summarise } from './ath-swing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = () => process.env.SWING_SCAN_PATH || join(HERE, 'data', 'swing-scan.json');

export const saveSwingScan = (scan) => writeJsonAtomic(SCAN(), scan);
export function loadSwingScan() {
  try {
    return JSON.parse(readFileSync(SCAN(), 'utf8'));
  } catch {
    return null;
  }
}

const sym = (s) => String(s).replace('.NS', '');

/** Shares for `capital` with `riskPct`% at risk between entry and stop, capped at `maxPositionPct`% of capital. */
export function sharesFor(capital, entry, stop, r = wideRules()) {
  const risk = entry - stop;
  if (!(risk > 0) || !(entry > 0)) return 0;
  const byRisk = Math.floor((capital * r.riskPct) / 100 / risk);
  const byCap = Math.floor((capital * r.maxPositionPct) / 100 / entry);
  return Math.max(0, Math.min(byRisk, byCap));
}

export function tradePlan({ capital = 1000000, paper = loadAthPaper(), scan = loadSwingScan(), r = wideRules() } = {}) {
  const wide = (paper?.trades || []).filter((t) => t.version === 'wide');
  const open = wide.filter((t) => t.open);
  const asOf = scan?.date || open.reduce((a, t) => (t.exitDate > a ? t.exitDate : a), '') || null;
  // held positions: tomorrow's stop, and a sell when the last close is below it.
  // The paper record keeps every signal (it can hold more than maxOpen positions and more than the
  // capital); the plan sizes them the way the tested portfolio does: oldest entry first, up to
  // maxOpen positions and only while the capital lasts (at entry cost). The rest are "paper only".
  const ordered = [...open].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || String(a.symbol).localeCompare(String(b.symbol)));
  let room = capital;
  let taken = 0;
  const sized = new Map();
  for (const t of ordered) {
    let shares = sharesFor(capital, t.entry, t.stop, r);
    if (taken >= r.maxOpen) shares = 0;
    else shares = Math.min(shares, Math.floor(room / t.entry));
    if (shares > 0 && shares * t.entry < capital * 0.01) shares = 0;
    if (shares > 0) {
      taken++;
      room -= shares * t.entry;
    }
    sized.set(t, { shares, why: shares > 0 ? null : taken >= r.maxOpen ? `paper only: all ${r.maxOpen} slots were in use` : 'paper only: no cash left for it' });
  }
  const hold = open.map((t) => {
    const last = t.exit / (1 - r.slippagePct / 100); // an open trade's "exit" is its latest close less slippage
    const { shares, why } = sized.get(t);
    const sell = last < t.trail;
    return {
      symbol: sym(t.symbol), entryDate: t.entryDate, entry: t.entry, last, stop: t.trail, firstStop: t.stop, shares,
      value: shares * last, cost: shares * t.entry, pnl: shares * (last - t.entry), r: t.r, gapToStopPct: last > 0 ? (last / t.trail - 1) * 100 : null,
      action: sell ? 'sell' : 'hold', stopRaised: t.trail > t.stop, inPlan: shares > 0, ...(why ? { why } : {}),
    };
  });
  const heldNow = new Set(open.map((t) => sym(t.symbol)));
  const keep = hold.filter((h) => h.action === 'hold' && h.inPlan).length;
  let slots = Math.max(0, r.maxOpen - keep);
  // cash left for new buys: capital less what the kept positions are worth (sells free their money), as the tested portfolio does
  let cash = Math.max(0, capital - hold.filter((h) => h.action === 'hold').reduce((a, h) => a + h.value, 0));
  const buy = (scan?.triggered || []).map((x) => {
    const s = sym(x.symbol);
    const shares = Math.min(sharesFor(capital, x.close, x.stop, r), Math.floor(cash / x.close));
    const row = { symbol: s, setup: x.setup, close: x.close, stop: x.stop, riskPct: x.riskPct, shares, value: shares * x.close, riskRs: shares * (x.close - x.stop) };
    if (heldNow.has(s)) return { ...row, action: 'skip', why: 'already held' };
    if (slots <= 0) return { ...row, action: 'skip', why: `all ${r.maxOpen} slots used` };
    if (!shares || row.value < capital * 0.01) return { ...row, action: 'skip', why: cash < capital * 0.01 ? 'no cash left' : 'stop too close to size a position' };
    slots--;
    cash -= row.value;
    return { ...row, action: 'buy' };
  });
  const closed = wide.filter((t) => !t.open);
  return {
    asOf, capital, rules: { riskPct: r.riskPct, maxOpen: r.maxOpen, maxPositionPct: r.maxPositionPct, trailAtr: r.chandelierAtr },
    buy, hold, sold: closed.filter((t) => t.exitDate === asOf).map((t) => ({ symbol: sym(t.symbol), exit: t.exit, r: t.r, reason: t.reason })),
    cashLeft: cash,
    invested: hold.reduce((a, h) => a + h.cost, 0),
    paperOnly: hold.filter((h) => !h.inPlan).length,
    counts: { buy: buy.filter((b) => b.action === 'buy').length, sell: hold.filter((h) => h.action === 'sell' && h.inPlan).length, hold: keep, freeSlots: slots },
    record: { since: paper?.startedAt || null, ...summarise(wide), open: open.length },
    steps: [
      'After 4 pm: read this list (it updates with the evening job).',
      'Next morning at 9:15: buy the BUY rows at the open; if a stock opens below its stop, skip it.',
      'Sell the SELL rows at the open.',
      'Set each HOLD row’s stop (a stop-loss order, or check it each evening).',
    ],
    note: `Strong-stock swing, wide trail: ${r.riskPct}% of capital at risk a trade, up to ${r.maxOpen} positions, ≤ ${r.maxPositionPct}% of capital each, stop trails ${r.chandelierAtr} ATR below the highest high; no profit target. Tested 2010→ on NSE's full history: about 9–14% a year after tax, worst falls 21–27%, wins about 4 trades in 10. Shares use your amount; the paper record uses its own and keeps every signal, so held positions are sized oldest first up to the slots and cash your amount allows (the rest show as paper only). Not advice.`,
  };
}
