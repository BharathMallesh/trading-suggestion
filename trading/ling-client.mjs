// Thin OpenRouter client (OpenAI-compatible chat completions) for the trading-
// research module. No dependencies — uses the built-in fetch (Node 18+). The
// API key comes from the environment (OPENROUTER_API_KEY); it is never stored
// or logged here.
import { OPENROUTER } from './config.mjs';

/**
 * Call the model with a list of chat messages and return the assistant text.
 * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
 * @param {{ model?: string, temperature?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function chat(messages, opts = {}) {
  const key = process.env[OPENROUTER.apiKeyEnv];
  if (!key) {
    throw new Error(
      `Missing ${OPENROUTER.apiKeyEnv}. Set your OpenRouter key first, e.g.:\n` +
        `  export ${OPENROUTER.apiKeyEnv}="sk-or-..."`,
    );
  }
  const res = await fetch(`${OPENROUTER.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      // Optional OpenRouter attribution headers.
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'AutoClaw Trading Research',
    },
    body: JSON.stringify({
      model: opts.model || OPENROUTER.model,
      temperature: opts.temperature ?? 0.3,
      messages,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}
