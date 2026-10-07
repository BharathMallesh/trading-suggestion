// Shared helpers for reading structured JSON out of model replies.
// Models wrap JSON in ```fences```, put prose (sometimes with braces) before
// it, or express confidence as "75" / "high" — normalize all of that here so
// every caller behaves the same.

/**
 * Find the first balanced {...} block in `text` that parses as a JSON object.
 * Scans every '{' so braces inside leading prose ("{draft}") don't break it.
 * @param {string} text
 * @param {(obj: object) => boolean} [accept]  optional filter (e.g. must have a key)
 * @returns {object|null}
 */
export function extractJson(text, accept = () => true, { last = false } = {}) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  let found = null;
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj) && accept(obj)) {
            if (!last) return obj;
            found = obj;
          }
        } catch {
          /* not JSON — try the next '{' */
        }
        break;
      }
    }
  }
  if (found) return found;
  // Repair: models sometimes stop right before the final brace(s), e.g.
  // '{"signal":"FLAT","reasoning":"…"' + fence. Try closing it ourselves.
  const tail = s.slice(s.indexOf('{')).trim();
  if (tail.startsWith('{')) {
    for (const suffix of ['}', '"}', ']}', '}}', '"]}']) {
      try {
        const obj = JSON.parse(tail + suffix);
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && accept(obj)) return obj;
      } catch {
        /* try the next repair */
      }
    }
  }
  return null;
}

/**
 * Confidence → [0, 1]. Accepts 0.7, 70 (percent), "70%", "high"/"moderate"/"low".
 * @param {unknown} c
 * @param {number} [fallback=0.4]  used when nothing usable is given
 */
export function normalizeConfidence(c, fallback = 0.4) {
  const clamp = (n) => Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
  if (typeof c === 'number' && Number.isFinite(c)) return clamp(c);
  const s = String(c ?? '').trim().toLowerCase();
  const n = parseFloat(s);
  if (!Number.isNaN(n)) return clamp(n);
  if (s.includes('very high') || s.includes('high') || s.includes('strong')) return 0.75;
  if (s.includes('moderate') || s.includes('medium')) return 0.55;
  if (s.includes('low') || s.includes('weak')) return 0.35;
  return fallback;
}
