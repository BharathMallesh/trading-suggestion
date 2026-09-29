// Finance RESEARCH entry point (library + CLI). Uses the Ling model via
// OpenRouter to produce factual, educational context and structured analysis.
//
// SCOPE (enforced by the system prompt below): information only. This module
// does NOT predict prices or market direction, does NOT give buy/sell/hold
// recommendations or price targets, and does NOT place trades or move money.
// Those are deliberately out of scope — see README.md for why.
import { chat } from './ling-client.mjs';

export const RESEARCH_SYSTEM = [
  'You are a finance RESEARCH assistant. Your job is to give factual, educational,',
  'well-structured information and analysis in response to the question.',
  '',
  'Hard rules:',
  '- Do NOT predict prices, returns, or market direction ("will it go up/down").',
  '- Do NOT give buy/sell/hold recommendations, entry/exit points, or price targets.',
  '- Do NOT provide personalized investment advice.',
  '- If asked to predict or to recommend a trade, briefly decline and instead',
  '  explain the relevant facts, drivers, risks, and what the reader could look at.',
  '- State uncertainty plainly; never imply a forecast is reliable.',
  '',
  'Always end with a one-line reminder: "This is general information, not investment',
  'advice — do your own research and consider a licensed adviser."',
].join('\n');

/**
 * Ask a finance-research question. Returns the model's (non-advice) answer.
 * @param {string} question
 * @param {{ model?: string, temperature?: number, signal?: AbortSignal }} [opts]
 */
export async function research(question, opts = {}) {
  return chat(
    [
      { role: 'system', content: RESEARCH_SYSTEM },
      { role: 'user', content: question },
    ],
    opts,
  );
}

// CLI: `node research.mjs "explain HDFC Bank's net interest margin"`
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('Usage: node research.mjs "your finance research question"');
    process.exit(1);
  }
  research(question)
    .then((answer) => process.stdout.write(answer + '\n'))
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
