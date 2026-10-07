// Finance RESEARCH entry point (library + CLI). Uses the Ling model via
// OpenRouter to produce factual, educational context and structured analysis.
//
// SCOPE (enforced by the system prompt below): information only. This module
// does NOT predict prices or market direction, does NOT give buy/sell/hold
// recommendations or price targets, and does NOT place trades or move money.
// Those are deliberately out of scope — see README.md for why.
import { pathToFileURL } from 'node:url';
import { chat } from './ling-client.mjs';
import { badRequest } from './util.mjs';

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
  const q = String(question || '').trim();
  if (!q) throw badRequest('Ask a question first, e.g. "What drives a bank\'s net interest margin?"');
  return chat(
    [
      { role: 'system', content: RESEARCH_SYSTEM },
      { role: 'user', content: q },
    ],
    opts,
  );
}

/**
 * Summarize a filing, press release, transcript, or news article that the user
 * pastes in. Returns a factual, structured summary — never advice, and never a
 * verdict on whether the news is "good" or "bad" for the price.
 * @param {string} text  the document/article text to summarize
 * @param {{ focus?: string, model?: string, temperature?: number, signal?: AbortSignal }} [opts]
 *   `focus` optionally steers what to emphasize (e.g. "the revenue segments").
 */
export async function summarize(text, opts = {}) {
  const body = String(text || '').trim();
  if (!body) throw badRequest('Nothing to summarize — pass the text of the filing/news.');
  const instruction = [
    'Summarize the following source text for a reader who wants the facts fast.',
    'Extract the key points, figures, and any stated risks or guidance verbatim',
    'from the text — do not add outside claims and do not infer numbers.',
    opts.focus ? `Focus especially on: ${opts.focus}.` : '',
    'Do NOT judge whether this is bullish/bearish or good/bad for the price, and',
    'do NOT suggest any action. Just report what the source says.',
    '',
    '--- SOURCE TEXT START ---',
    body,
    '--- SOURCE TEXT END ---',
  ]
    .filter(Boolean)
    .join('\n');
  return chat(
    [
      { role: 'system', content: RESEARCH_SYSTEM },
      { role: 'user', content: instruction },
    ],
    opts,
  );
}

/**
 * Explain a finance metric, instrument, or chart pattern generically — a
 * textbook-style, ticker-agnostic explanation. Use this for "what is X / how do
 * I read X" questions rather than anything tied to a live position.
 * @param {string} topic  e.g. "net interest margin", "a bullish engulfing candle"
 * @param {{ model?: string, temperature?: number, signal?: AbortSignal }} [opts]
 */
export async function explain(topic, opts = {}) {
  const t = String(topic || '').trim();
  if (!t) throw badRequest('Pass a topic to explain, e.g. "net interest margin".');
  const instruction = [
    `Explain the following finance concept in plain English: ${t}.`,
    'Cover what it is, how it is calculated or identified, how it is typically',
    'read, and its common caveats or limitations. Keep it general and educational',
    '— do not reference any specific current price, position, or time to act.',
  ].join('\n');
  return chat(
    [
      { role: 'system', content: RESEARCH_SYSTEM },
      { role: 'user', content: instruction },
    ],
    opts,
  );
}

// CLI: `node research.mjs "explain HDFC Bank's net interest margin"`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
