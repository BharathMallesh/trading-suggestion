// Small shared helpers for the trading-research module. No dependencies.

/** An Error carrying an HTTP status, so the server can answer 400/404/503 instead of 500. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A ticker: 1–20 chars of letters, digits and ^&.-= (case-insensitive; = for Yahoo FX like USDINR=X). */
export const SYMBOL_RE = /^[A-Za-z0-9^&.=\-]{1,20}$/;

/** Shorthand for a 400 input-validation error. */
export const badRequest = (message) => new HttpError(400, message);

/**
 * Normalize a symbols input into a clean array. Accepts an array or a
 * comma/space-separated string; anything else yields [].
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseSymbols(input) {
  if (input == null) return [];
  if (!Array.isArray(input) && typeof input !== 'string') throw badRequest('symbols must be an array of tickers or a comma-separated string.');
  const list = Array.isArray(input) ? input : input.split(/[,\s]+/);
  if (list.some((s) => typeof s !== 'string')) throw badRequest('symbols must be strings.');
  const out = list.map((s) => s.trim()).filter(Boolean);
  for (const s of out) {
    if (!SYMBOL_RE.test(s)) throw badRequest(`Invalid symbol "${s.slice(0, 24)}": use up to 20 letters, digits or ^&.- characters.`);
  }
  return out;
}

/** Parse a boolean-ish value: true, "true", 1, "1" → true; everything else → false. */
export function parseBool(v) {
  return v === true || v === 1 || v === 'true' || v === '1';
}

/** Map with at most `limit` promises in flight (keeps API/LLM load polite). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
