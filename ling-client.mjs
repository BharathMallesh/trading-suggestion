// Thin OpenRouter client (OpenAI-compatible chat completions) for the trading-
// research module. No dependencies — uses the built-in fetch (Node 18+). The
// API key comes from the environment (OPENROUTER_API_KEY); it is never stored
// or logged here.
import { OPENROUTER } from './config.mjs';
import { HttpError } from './util.mjs';
import { extractJson } from './paper-bot/llm-json.mjs';

/**
 * Call the model with a list of chat messages and return the assistant text.
 * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
 * @param {{ model?: string, temperature?: number, signal?: AbortSignal, timeoutMs?: number,
 *   jsonKeys?: string[], retryEmpty?: number }} [opts]
 *   `jsonKeys`: for JSON-returning prompts. Ling is a reasoning model and sometimes
 *   returns `content: null` with its answer only in `message.reasoning`; when
 *   that happens, the last JSON object there containing one of these keys is
 *   returned instead. `retryEmpty` (default 1): extra attempts when the reply
 *   is still empty.
 * @returns {Promise<string>}
 */
/** Last OpenRouter failure seen by this process (for health checks), or null after a success. */
let lastLlmError = null;
export const llmStatus = () => lastLlmError;

/** Account balance (free endpoint; doesn't use credits). */
export async function llmCredits() {
  const key = process.env[OPENROUTER.apiKeyEnv];
  if (!key) return null;
  const res = await fetch(`${OPENROUTER.baseUrl}/credits`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`credits HTTP ${res.status}`);
  const d = (await res.json())?.data || {};
  return { totalCredits: Number(d.total_credits) || 0, totalUsage: Number(d.total_usage) || 0, remaining: (Number(d.total_credits) || 0) - (Number(d.total_usage) || 0) };
}

export async function chat(messages, opts = {}) {
  const key = process.env[OPENROUTER.apiKeyEnv];
  if (!key) {
    throw new HttpError(
      503,
      `Missing ${OPENROUTER.apiKeyEnv}. Set your OpenRouter key first, e.g.:\n` +
        `  export ${OPENROUTER.apiKeyEnv}="sk-or-..."`,
    );
  }
  const attempts = 1 + Math.max(0, opts.retryEmpty ?? 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Default 25s timeout so backtests don't hang on a slow/stuck API call
    const signal =
      opts.signal ||
      (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(opts.timeoutMs ?? 25_000)
        : undefined);

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
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastLlmError = { at: new Date().toISOString(), status: res.status };
      if (res.status === 402) {
        throw new HttpError(503, 'OpenRouter account is out of credits — add credits at https://openrouter.ai/settings/credits. AI features (Ask, narration, news briefs, sentiment) fall back to non-AI results until then.');
      }
      if (res.status === 401) throw new HttpError(503, 'OpenRouter rejected the API key (401) — check or replace the key.');
      if (res.status === 429) throw new HttpError(503, 'OpenRouter is rate-limiting requests — try again shortly.');
      throw new HttpError(502, `OpenRouter HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    }
    lastLlmError = null;
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.trim()) return content;
    if (opts.jsonKeys?.length && typeof msg.reasoning === 'string') {
      const obj = extractJson(msg.reasoning, (o) => opts.jsonKeys.some((k) => k in o), { last: true });
      if (obj) return JSON.stringify(obj);
    }
  }
  return '';
}
