// Small shared helpers for the trading-research module. No dependencies.

/** An Error carrying an HTTP status, so the server can answer 400/404/503 instead of 500. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Shorthand for a 400 input-validation error. */
export const badRequest = (message) => new HttpError(400, message);

/**
 * Normalize a symbols input into a clean array. Accepts an array or a
 * comma/space-separated string; anything else yields [].
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseSymbols(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,\s]+/) : [];
  return list.map((s) => String(s).trim()).filter(Boolean);
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
