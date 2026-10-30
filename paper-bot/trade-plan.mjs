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
  // held positions: tomorrow's stop, and a sell when the last close is below it
  const hold = open.map((t) => {
    const last = t.exit / (1 - r.slippagePct / 100); // an open trade's "exit" is its latest close less slippage
    const shares = sharesFor(capital, t.entry, t.stop, r);
    const sell = last < t.trail;
    return {
      symbol: sym(t.symbol), entryDate: t.entryDate, entry: t.entry, last, stop: t.trail, firstStop: t.stop, shares,
      value: shares * last, pnl: shares * (last - t.entry), r: t.r, gapToStopPct: last > 0 ? (last / t.trail - 1) * 100 : null,
      action: sell ? 'sell' : 'hold', stopRaised: t.trail > t.stop,
    };
  });
  const heldNow = new Set(open.map((t) => sym(t.symbol)));
  const keep = hold.filter((h) => h.action === 'hold').length;
  let slots = Math.max(0, r.maxOpen - keep);
  const buy = (scan?.triggered || []).map((x) => {
    const s = sym(x.symbol);
    const shares = sharesFor(capital, x.close, x.stop, r);
    const row = { symbol: s, setup: x.setup, close: x.close, stop: x.stop, riskPct: x.riskPct, shares, value: shares * x.close, riskRs: shares * (x.close - x.stop) };
    if (heldNow.has(s)) return { ...row, action: 'skip', why: 'already held' };
    if (!shares) return { ...row, action: 'skip', why: 'stop too close to size a position' };
    if (slots <= 0) return { ...row, action: 'skip', why: `all ${r.maxOpen} slots used` };
    slots--;
    return { ...row, action: 'buy' };
  });
  const closed = wide.filter((t) => !t.open);
  return {
    asOf, capital, rules: { riskPct: r.riskPct, maxOpen: r.maxOpen, maxPositionPct: r.maxPositionPct, trailAtr: r.chandelierAtr },
    buy, hold, sold: closed.filter((t) => t.exitDate === asOf).map((t) => ({ symbol: sym(t.symbol), exit: t.exit, r: t.r, reason: t.reason })),
    counts: { buy: buy.filter((b) => b.action === 'buy').length, sell: hold.filter((h) => h.action === 'sell').length, hold: keep, freeSlots: slots },
    record: { since: paper?.startedAt || null, ...summarise(wide), open: open.length },
    steps: [
      'After 4 pm: read this list (it updates with the evening job).',
      'Next morning at 9:15: buy the BUY rows at the open; if a stock opens below its stop, skip it.',
      'Sell the SELL rows at the open.',
      'Set each HOLD row’s stop (a stop-loss order, or check it each evening).',
    ],
    note: `Strong-stock swing, wide trail: ${r.riskPct}% of capital at risk a trade, up to ${r.maxOpen} positions, ≤ ${r.maxPositionPct}% of capital each, stop trails ${r.chandelierAtr} ATR below the highest high; no profit target. Tested 2010→ on NSE's full history: about 9–14% a year after tax, worst falls 21–27%, wins about 4 trades in 10. Shares use your amount; the paper record uses its own. Not advice.`,
  };
}
