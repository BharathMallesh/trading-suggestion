// Multi-agent coordinator
// Runs Research Agent + Signal Agent and combines into an experimental brief.
//
// The "suggestion" layer is paper-only and heavily disclaimer'd.
// It never claims certainty and never places real orders.

import { researchAgent } from './research-agent.mjs';
import { signalAgent } from './signal-agent.mjs';
import { PaperEngine } from '../paper-bot/paper-engine.mjs';
import { PAPER } from '../paper-bot/config.mjs';
import { parseSymbols } from '../util.mjs';

/**
 * Run both agents and produce a combined experimental brief.
 *
 * @param {{
 *   symbols?: string[],
 *   question?: string,
 *   techOnly?: boolean,
 *   interval?: string,
 * }} opts
 */
export async function runAgents(opts = {}) {
  const { question = null, techOnly = false, interval = '1d' } = opts;
  const given = parseSymbols(opts.symbols);
  const symbols = given.length ? given : PAPER.symbols.slice(0, 4);

  const startedAt = new Date().toISOString();

  // 1. Signal agent (all symbols)
  const signalResult = await signalAgent({ symbols, techOnly, interval });

  // 2. Research agent — focus on symbols that have a non-FLAT signal, else first symbol
  const interesting = signalResult.signals.filter(
    (s) => s.signal !== 'FLAT' && s.confidence >= PAPER.minConfidence,
  );
  const researchFocus = interesting.length
    ? interesting[0].symbol
    : symbols[0];

  const researchResult = await researchAgent({
    symbol: researchFocus,
    question:
      question ||
      `What are the main business drivers and recent risks for ${researchFocus}? Stick to facts only.`,
  });

  // 3. Paper snapshot from signals
  const engine = new PaperEngine();
  const opened = [];
  for (const s of signalResult.signals) {
    if (s.confidence < PAPER.minConfidence || !s.indicators?.close) continue;
    const px = s.indicators.close;
    let res;
    if (s.signal === 'LONG') {
      res = engine.openLong(s.symbol, px, s.date, s.indicators.atr14);
    } else if (s.signal === 'SHORT') {
      res = engine.openShort(s.symbol, px, s.date, s.indicators.atr14);
    }
    if (res?.ok) {
      opened.push({
        symbol: s.symbol,
        side: res.side,
        qty: res.qty,
        price: px,
        stop: res.stop,
        target: res.target,
        confidence: s.confidence,
        reasoning: s.reasoning,
      });
    }
  }
  const paperSummary = engine.summary();

  // 4. Experimental "suggestion" layer (paper only)
  const suggestions = opened.map((o) => ({
    action: o.side === 'LONG' ? 'PAPER LONG' : 'PAPER SHORT',
    symbol: o.symbol,
    qty: o.qty,
    entry: o.price,
    stop: o.stop,
    target: o.target,
    confidence: o.confidence,
    why: o.reasoning,
    note: 'Paper simulation only — not a real trade recommendation.',
  }));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    agents: {
      research: researchResult,
      signal: signalResult,
    },
    paper: {
      startingCapital: paperSummary.startingCapital,
      equity: paperSummary.finalEquity,
      cash: paperSummary.cash,
      openPositions: paperSummary.openPositions,
      opened,
    },
    experimentalSuggestions: suggestions,
    disclaimers: [
      'This is an experimental multi-agent research tool.',
      'Signals and paper suggestions have no proven edge.',
      'Nothing here is investment advice or a recommendation to buy/sell.',
      'Do not place real trades based on this output.',
      'Past simulated results do not predict future performance.',
    ],
  };
}
