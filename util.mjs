// Small shared helpers for the trading-research module. No dependencies.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

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

/**
 * Write JSON atomically: temp file in the same dir, fsync, rename. A crash
 * mid-write leaves the old file intact instead of a truncated one.
 */
export function writeJsonAtomic(path, obj, space = 2) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(obj, null, space));
    try { fsyncSync(fd); } catch { /* fsync is best-effort */ }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Read JSON; `fallback` only when the file does not exist. A file that exists
 * but won't parse is moved aside (kept as evidence) and we throw, so callers
 * never silently start fresh and overwrite it.
 */
export function readJsonSafe(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const moved = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, moved); } catch { /* keep going; the error below is what matters */ }
    throw new Error(`Corrupt JSON in ${path} (${e.message}); moved to ${moved}`);
  }
}

const _locks = new Map();
/** Serialize async work per key (e.g. a file path) inside this process. */
export function withFileLock(path, fn) {
  const prev = _locks.get(path) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  _locks.set(path, tail);
  tail.then(() => { if (_locks.get(path) === tail) _locks.delete(path); });
  return run;
}
