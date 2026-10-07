// Shared walk-forward paper backtest, used by both the CLI (run.mjs) and the
// dashboard server so the two can never drift apart.
//
// - Symbols are aligned by DATE (only bars every symbol has are walked), so a
//   mixed list such as AAPL + RELIANCE.NS compares the same day, not the same
//   array index.
// - Signal on bar i, fill at bar i+1 OPEN; stops/targets checked on high/low.
// EXPERIMENTAL RESEARCH ONLY — not investment advice.

import { PaperEngine } from './paper-engine.mjs';
import { generateSignal } from './signal.mjs';
import { PAPER } from './config.mjs';
import { HttpError } from '../util.mjs';

/** Bars needed before the first signal: SMA-50 plus a few bars of slack. */
export const WARMUP_BARS = 55;

/**
 * Restrict every symbol's history to the bar dates that ALL symbols share.
 * @param {Record<string, {date:string}[]>} history
 * @returns {Record<string, {date:string}[]>}
 */
export function alignByDate(history) {
  const syms = Object.keys(history);
  if (!syms.length) return {};
  let common = new Set(history[syms[0]].map((b) => b.date));
  for (const s of syms.slice(1)) {
    const dates = new Set(history[s].map((b) => b.date));
    common = new Set([...common].filter((d) => dates.has(d)));
  }
  const out = {};
  for (const s of syms) out[s] = history[s].filter((b) => common.has(b.date));
  return out;
}

/**
 * Walk the aligned history bar by bar and simulate the paper account.
 * @param {Record<string, object[]>} rawHistory  symbol → candles (oldest first)
 * @param {{ techOnly?: boolean, lookbackBars?: number, onEvent?: (e:object) => void }} [opts]
 * @returns {Promise<{ symbols: string[], bars: number, summary: object }>}
 */
export async function runBacktest(rawHistory, opts = {}) {
  const { techOnly = true, lookbackBars = PAPER.lookbackBars, onEvent = () => {} } = opts;
  const history = alignByDate(rawHistory);
  const symbols = Object.keys(history);
  if (!symbols.length) throw new HttpError(400, 'No market data loaded for the requested symbols.');

  const len = history[symbols[0]].length;
  const startIdx = WARMUP_BARS;
  if (len <= startIdx + 2) {
    const why = symbols.length > 1 ? ' (only bars shared by every symbol are used — mixing markets reduces overlap)' : '';
    throw new HttpError(400, `Not enough bars for a backtest: ${len} usable, need more than ${startIdx + 2}${why}.`);
  }

  const engine = new PaperEngine();
  engine.equityCurve[0].date = history[symbols[0]][startIdx].date;

  for (let i = startIdx; i < len - 1; i++) {
    const marks = {};
    engine.tickBar(); // min-hold age + loss cooldown

    for (const sym of symbols) {
      const bars = history[sym];
      const bar = bars[i];
      const nextBar = bars[i + 1];
      marks[sym] = nextBar.open;

      // 1. Stops / targets on this bar's range (always allowed).
      for (const t of engine.checkStopsAndTargets(sym, bar)) onEvent({ type: 'stop', date: bar.date, trade: t });

      // 2. Signal on data up to and including this bar.
      const signal = await generateSignal(sym, bars.slice(0, i + 1), { techOnly, lookbackBars });
      const hasPos = engine.positions.has(sym);
      const fillPrice = nextBar.open;

      if (!hasPos && signal.confidence >= PAPER.minConfidence) {
        let res;
        if (signal.signal === 'LONG') res = engine.openLong(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
        else if (signal.signal === 'SHORT') res = engine.openShort(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
        if (res?.ok) onEvent({ type: 'open', date: nextBar.date, symbol: sym, side: res.side, qty: res.qty, price: fillPrice, stop: res.stop, target: res.target });
      } else if (hasPos && engine.canSignalExit(sym)) {
        const pos = engine.positions.get(sym);
        const shouldExit =
          signal.signal === 'FLAT' ||
          (pos.side === 'LONG' && signal.signal === 'SHORT') ||
          (pos.side === 'SHORT' && signal.signal === 'LONG');
        if (shouldExit) {
          const res = engine.closePosition(sym, fillPrice, nextBar.date, 'signal');
          if (res.ok) onEvent({ type: 'close', date: nextBar.date, trade: res.trade });
        }
      }
    }

    engine.mark(history[symbols[0]][i].date, marks);
    onEvent({ type: 'bar', index: i, date: history[symbols[0]][i].date, equity: engine.equity(marks), trades: engine.closedTrades.length });
  }

  // Close anything still open at the last bar's close.
  const lastMarks = {};
  let lastDate = null;
  for (const sym of symbols) {
    const last = history[sym][len - 1];
    lastMarks[sym] = last.close;
    lastDate = last.date;
    if (engine.positions.has(sym)) {
      const res = engine.closePosition(sym, last.close, last.date, 'end-of-test');
      if (res.ok) onEvent({ type: 'end', date: last.date, trade: res.trade });
    }
  }
  engine.mark(lastDate, lastMarks);

  return { symbols, bars: len, startDate: history[symbols[0]][startIdx].date, endDate: lastDate, summary: engine.summary() };
}
