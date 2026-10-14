// Phone access on the home network (library), protected by a PIN.
//
//   - Off by default. When switched on (from the Mac itself), the server also
//     listens on the Mac's home-network address, e.g. http://192.168.1.20:3000.
//   - Only private home-network addresses may connect (192.168.x.x, 10.x.x.x,
//     172.16–31.x.x, link-local); anything else is refused.
//   - Other devices must log in with the PIN (6–12 digits), stored only as a
//     salted scrypt hash. 5 wrong tries from one device → locked for 15 minutes.
//   - A login gives an HttpOnly, SameSite=Strict cookie valid for 30 days
//     (kept in memory: after a server restart, log in again).
//   - Settings can be changed only on the Mac itself (localhost).
// Plain HTTP on your own Wi-Fi: anyone on that Wi-Fi could see traffic, so use
// it only on a network you trust.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badRequest, readJsonSafe, writeJsonAtomic } from '../util.mjs';

const PATH = () => process.env.LAN_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'lan.json');
const SESSION_DAYS = 30;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60000;

export function lanConfig() {
  const c = readJsonSafe(PATH(), null) || {};
  return { enabled: !!c.enabled && !!c.hash, hasPin: !!c.hash, salt: c.salt || null, hash: c.hash || null };
}

/** Save the setting (and a new PIN if given). Turning on needs a PIN. */
export function saveLan({ enabled, pin } = {}) {
  const c = readJsonSafe(PATH(), null) || {};
  if (pin != null && pin !== '') {
    if (!/^\d{6,12}$/.test(String(pin))) throw badRequest('The PIN must be 6 to 12 digits.');
    c.salt = randomBytes(16).toString('hex');
    c.hash = scryptSync(String(pin), c.salt, 32).toString('hex');
    sessions.clear(); // a new PIN logs every device out
  }
  if (enabled && !c.hash) throw badRequest('Set a PIN first.');
  c.enabled = !!enabled;
  c.updatedAt = new Date().toISOString();
  writeJsonAtomic(PATH(), c);
  return lanConfig();
}

export function verifyPin(pin, cfg = lanConfig()) {
  if (!cfg.hash || !/^\d{6,12}$/.test(String(pin || ''))) return false;
  const a = scryptSync(String(pin), cfg.salt, 32);
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const norm = (ip) => String(ip || '').replace(/^::ffff:/, '');
export const isLoopback = (ip) => ['127.0.0.1', '::1'].includes(norm(ip));
/** Private home-network address (IPv4 private / link-local, IPv6 link-local / unique-local). */
export function isPrivate(ip) {
  const a = norm(ip);
  if (isLoopback(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [x, y] = [+m[1], +m[2]];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return /^fe80:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a);
}

/** The Mac's home-network addresses → URLs a phone can open. */
export function localUrls(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal && isPrivate(n.address)) out.push(`http://${n.address}:${port}`);
  }
  return out;
}

// ---- sessions and login attempts (in memory) ----
const sessions = new Map(); // token → expiry ms
const tries = new Map(); // ip → { n, until }

export function loginAttempt(ip, pin, now = Date.now()) {
  const k = norm(ip);
  const t = tries.get(k) || { n: 0, until: 0 };
  if (t.until > now) return { ok: false, locked: true, retryInMin: Math.ceil((t.until - now) / 60000) };
  if (!verifyPin(pin)) {
    t.n += 1;
    if (t.n >= MAX_TRIES) {
      t.until = now + LOCK_MS;
      t.n = 0;
    }
    tries.set(k, t);
    return { ok: false, locked: t.until > now, left: t.until > now ? 0 : MAX_TRIES - t.n };
  }
  tries.delete(k);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_DAYS * 86400000);
  return { ok: true, token, cookie: `tr_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` };
}

export function validSession(cookieHeader, now = Date.now()) {
  const m = String(cookieHeader || '').match(/(?:^|;\s*)tr_session=([0-9a-f]{64})/);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < now) {
    sessions.delete(m[1]);
    return false;
  }
  return true;
}

export function logout(cookieHeader) {
  const m = String(cookieHeader || '').match(/(?:^|;\s*)tr_session=([0-9a-f]{64})/);
  if (m) sessions.delete(m[1]);
}

/** Minimal login page (no scripts), styled like the app. */
export function loginPage(message = '') {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trading Research · Log in</title>
<style>:root{--bg:#f3f5fb;--panel:#fff;--ink:#1b2240;--muted:#5d6585;--line:#dde2f0;--accent:#4f5bd5}@media (prefers-color-scheme:dark){:root{--bg:#11152a;--panel:#181d36;--ink:#e6e9f8;--muted:#a0a8c8;--line:#2b3254;--accent:#8f99ff}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;width:100%;max-width:340px;display:grid;gap:12px}
h1{font-size:20px;margin:0}p{margin:0;color:var(--muted);font-size:14px}input{font-size:22px;letter-spacing:.3em;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);text-align:center}
button{font-size:16px;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600}.msg{color:#c0392b;font-size:14px}</style></head>
<body><form method="post" action="/login"><h1>Trading Research</h1><p>Enter the PIN set on the Mac.</p>
<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" required autofocus aria-label="PIN">
${message ? `<div class="msg">${esc(message)}</div>` : ''}<button type="submit">Log in</button></form></body></html>`;
}
