// Market Research Agent
// Uses the existing guardrailed research module — factual only, no predictions.

import { research, summarize, explain } from '../research.mjs';
import { quote, candles } from '../market-data.mjs';
import { describeCandles } from '../describe-candles.mjs';

/**
 * Research Agent — gathers factual context about a symbol or topic.
 * Never predicts prices or recommends trades.
 */
export async function researchAgent({ symbol, question, mode = 'auto' } = {}) {
  const result = {
    agent: 'research',
    symbol: symbol || null,
    mode,
    quote: null,
    description: null,
    answer: null,
    disclaimer:
      'General information only. Not investment advice. No price prediction or trade recommendation.',
  };

  try {
    // Pull live snapshot if a symbol is given
    if (symbol) {
      result.quote = await quote(symbol);
      const desc = await describeCandles(symbol, {
        range: '3mo',
        interval: '1d',
        narrate: false,
      });
      result.description = desc.facts || null;
    }

    // Answer a research question
    if (question) {
      if (mode === 'explain') {
        result.answer = await explain(question);
      } else if (mode === 'summarize') {
        result.answer = await summarize(question);
      } else {
        // Auto: enrich question with symbol context if available
        const q = symbol
          ? `Regarding ${symbol}: ${question}`
          : question;
        result.answer = await research(q);
      }
    } else if (symbol) {
      // Default research prompt when only symbol is given
      result.answer = await research(
        `Give a factual overview of ${symbol}: what the company does, key business segments, and the main metrics investors typically watch. Do not predict price or recommend any action.`,
      );
    }
  } catch (err) {
    result.error = err.message || String(err);
  }

  return result;
}
