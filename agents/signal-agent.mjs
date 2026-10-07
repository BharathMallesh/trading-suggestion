// Signal Agent (experimental paper signals)
// Produces LONG / SHORT / FLAT for paper-trading research only.

import { candles } from '../market-data.mjs';
import { generateSignal } from '../paper-bot/signal.mjs';
import { PAPER } from '../paper-bot/config.mjs';

/**
 * Signal Agent — hybrid or tech-only signals for one or more symbols.
 * Experimental. Not investment advice.
 */
export async function signalAgent({
  symbols = [],
  techOnly = false,
  interval = '1d',
} = {}) {
  const list = (symbols.length ? symbols : PAPER.symbols.slice(0, 5))
    .map((s) => String(s).trim())
    .filter(Boolean);

  let range = PAPER.candleRange;
  let candleInterval = '1d';
  let lookbackBars = PAPER.lookbackBars;

  if (interval !== '1d' && PAPER.intraday[interval]) {
    range = PAPER.intraday[interval].range;
    candleInterval = PAPER.intraday[interval].interval;
    lookbackBars = PAPER.intraday[interval].lookbackBars;
  }

  const signals = [];
  for (const sym of list) {
    try {
      const data = await candles(sym, { range, interval: candleInterval });
      const sig = await generateSignal(sym, data, { techOnly, lookbackBars });
      signals.push(sig);
    } catch (err) {
      signals.push({
        symbol: sym,
        signal: 'FLAT',
        confidence: 0,
        reasoning: err.message || 'Error',
        techBias: 'NEUTRAL',
        indicators: null,
        error: true,
      });
    }
  }

  return {
    agent: 'signal',
    mode: techOnly ? 'tech-only' : 'hybrid',
    interval,
    signals,
    disclaimer:
      'Experimental paper signals only. Not investment advice. No proven edge. Do not use for real trading decisions.',
  };
}
