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

/** Model that answered the most recent successful call (main or a fallback). */
let lastModel = null;
export const llmLastModel = () => lastModel;

// Statuses where another model may succeed: no credits, rate limit, model
// gone / unavailable, provider errors.
const FALLBACK_STATUSES = new Set([402, 404, 429, 500, 502, 503, 504]);

function friendly(status, body) {
  if (status === 402) return new HttpError(503, 'OpenRouter account is out of credits — add credits at https://openrouter.ai/settings/credits. AI features (Ask, narration, news briefs, sentiment) fall back to non-AI results until then.');
  if (status === 401) return new HttpError(503, 'OpenRouter rejected the API key (401) — check or replace the key.');
  if (status === 429) return new HttpError(503, 'OpenRouter is rate-limiting requests — try again shortly.');
  return new HttpError(502, `OpenRouter HTTP ${status}: ${String(body).slice(0, 400)}`);
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
  // An explicitly requested model is used alone; otherwise main → free fallbacks.
  const models = opts.model ? [opts.model] : [OPENROUTER.model, ...(opts.noFallback ? [] : OPENROUTER.fallbackModels)];
  let firstError = null;
  for (const model of models) {
    const attempts = 1 + Math.max(0, opts.retryEmpty ?? 1);
    let failed = null;
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
          model,
          temperature: opts.temperature ?? 0.3,
          messages,
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        failed = { status: res.status, body };
        break;
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.trim()) return done(model, content);
      if (opts.jsonKeys?.length && typeof msg.reasoning === 'string') {
        const obj = extractJson(msg.reasoning, (o) => opts.jsonKeys.some((k) => k in o), { last: true });
        if (obj) return done(model, JSON.stringify(obj));
      }
    }
    if (!failed) return done(model, ''); // answered, but empty
    // The main model's problem is what the health check should report.
    if (model === models[0]) {
      lastLlmError = { at: new Date().toISOString(), status: failed.status };
      firstError = friendly(failed.status, failed.body);
    }
    if (!FALLBACK_STATUSES.has(failed.status)) break; // e.g. bad key: no model will work
  }
  throw firstError;
}

function done(model, text) {
  lastModel = model;
  // A fallback answering doesn't clear the main model's error (health shows it).
  if (model === OPENROUTER.model) lastLlmError = null;
  return text;
}
