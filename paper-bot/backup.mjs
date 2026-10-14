#!/usr/bin/env node
// Daily backup of the evidence that can't be re-created: the prediction log,
// forward-test accounts, paper portfolio, earnings events, monitor reports and
// weekly scorecards, settings, fitted models, and the collected intraday bars
// (Yahoo only keeps ~1 month of those). Re-downloadable caches (NSE files,
// news) are left out. Expensive-to-rebuild results (paper-bot/data/*.json, e.g.
// replays) are included; NSE download caches (fo-bhav/, fii/, fo-positioning/)
// and news-daily.json are not. Every .json is parse-checked first: a corrupt
// file fails the backup loudly instead of replacing a good snapshot.
//
//   ~/trading-research-backups/trading-research-YYYY-MM-DD.tar.gz  (last 30 kept)
//   + a copy in iCloud Drive (BACKUP_MIRROR to change; "" to turn off). macOS
//     may block background jobs from iCloud Drive — the health check reports it.
//
//   node paper-bot/backup.mjs            # back up now
//   node paper-bot/backup.mjs --list     # list backups
// Restore: stop the server, then
//   tar -xzf ~/trading-research-backups/trading-research-YYYY-MM-DD.tar.gz -C ~/trading-research

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, renameSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../util.mjs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BACKUP_DIR = () => process.env.BACKUP_DIR || join(homedir(), 'trading-research-backups');
export const BACKUP_MIRROR = () => process.env.BACKUP_MIRROR ?? join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'trading-research-backups');
export const KEEP = 30;

/** Paths (relative to the project root) included in a backup, if present. */
export const INCLUDE = [
  'paper-bot/prediction-history.json',
  'paper-bot/portfolio.json',
  'paper-bot/settings.json',
  'paper-bot/calibration.json',
  'paper-bot/vol-model.json',
  'paper-bot/data/strategy-accounts.json',
  'paper-bot/data/events.json',
  'paper-bot/monitor',
];
// The saved 5-minute price history is large and changes slowly: it goes into its own WEEKLY
// archive (candles-YYYY-Www.tar.gz, last 8 kept) instead of every daily one.
export const WEEKLY = ['paper-bot/data/candles'];
export const KEEP_WEEKLY = 8;
// re-settable or re-downloadable files that never go into backups (lan.json holds the phone-access PIN hash)
const SKIP = new Set(['news-daily.json', 'lan.json']);

/** Top-level paper-bot/data/*.json results worth keeping (everything but the news cache). */
function dataResultFiles(root) {
  const d = join(root, 'paper-bot', 'data');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json') && !SKIP.has(f))
    .map((f) => `paper-bot/data/${f}`);
}

/** All .json files under the included paths (recursive). */
function jsonFilesUnder(root, rel) {
  const abs = join(root, rel);
  if (statSync(abs).isDirectory()) return readdirSync(abs).flatMap((f) => jsonFilesUnder(root, `${rel}/${f}`));
  return rel.endsWith('.json') ? [rel] : [];
}

const statusPath = () => join(BACKUP_DIR(), 'status.json');

export function backupStatus() {
  try {
    return JSON.parse(readFileSync(statusPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function listBackups(dir = BACKUP_DIR()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^trading-research-\d{4}-\d\d-\d\d\.tar\.gz$/.test(f))
    .sort()
    .map((f) => ({ file: join(dir, f), date: f.slice(17, 27), bytes: statSync(join(dir, f)).size }));
}

/** Keep the newest `keep` archives in `dir`. */
function prune(dir, keep = KEEP) {
  const all = listBackups(dir);
  for (const b of all.slice(0, Math.max(0, all.length - keep))) unlinkSync(b.file);
}

export function listWeekly(dir = BACKUP_DIR()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^candles-\d{4}-W\d\d\.tar\.gz$/.test(f)).sort().map((f) => ({ file: join(dir, f), week: f.slice(8, 16), bytes: statSync(join(dir, f)).size }));
}
function pruneWeekly(dir) {
  const all = listWeekly(dir);
  for (const b of all.slice(0, Math.max(0, all.length - KEEP_WEEKLY))) unlinkSync(b.file);
}
/** ISO week label, e.g. 2026-W42 (weeks start Monday; week 1 holds the year's first Thursday). */
export const isoWeekLabel = (date) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const y = t.getUTCFullYear();
  const w = 1 + Math.floor((t - Date.UTC(y, 0, 1)) / (7 * 86400000));
  return `${y}-W${String(w).padStart(2, '0')}`;
};

/** This week's price-history archive, if not made yet. */
async function weeklyArchive(root, dir, date, mirrorDir) {
  const parts = WEEKLY.filter((p) => existsSync(join(root, p)));
  if (!parts.length) return null;
  const file = join(dir, `candles-${isoWeekLabel(date)}.tar.gz`);
  if (existsSync(file)) return { file, bytes: statSync(file).size, skipped: true };
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await run('tar', ['-czf', tmp, '-C', root, ...parts]);
    await run('tar', ['-tzf', tmp], { maxBuffer: 50 * 1024 * 1024 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
  pruneWeekly(dir);
  if (mirrorDir) {
    try {
      copyFileSync(file, join(mirrorDir, `candles-${isoWeekLabel(date)}.tar.gz`));
      pruneWeekly(mirrorDir);
    } catch { /* mirror is best effort; the daily status reports mirror problems */ }
  }
  return { file, bytes: statSync(file).size };
}

/**
 * Create today's archive (overwrites today's if re-run), verify it, prune, mirror.
 * @returns {Promise<{file, bytes, files, mirror}>}
 */
export async function backup(opts = {}) {
  try {
    return await backupInner(opts);
  } catch (err) {
    // Keep the last good status fields, add the error so the health check can shout.
    try {
      mkdirSync(BACKUP_DIR(), { recursive: true });
      writeJsonAtomic(statusPath(), { ...(backupStatus() || {}), error: { at: new Date().toISOString(), message: err.message } });
    } catch { /* reporting must not mask the real error */ }
    throw err;
  }
}

async function backupInner({ root = ROOT, now = new Date() } = {}) {
  const dir = BACKUP_DIR();
  mkdirSync(dir, { recursive: true });
  const date = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10); // IST date
  const file = join(dir, `trading-research-${date}.tar.gz`);
  const parts = [...new Set([...INCLUDE, ...dataResultFiles(root)])].filter((p) => existsSync(join(root, p)));
  if (!parts.length) throw new Error('Nothing to back up — no data files found.');
  // Parse-check first: never snapshot (and prune good history in favor of) a corrupt file.
  const bad = [];
  for (const rel of parts.flatMap((p) => jsonFilesUnder(root, p))) {
    try { JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch (e) { bad.push(`${rel} (${e.message.slice(0, 60)})`); }
  }
  if (bad.length) throw new Error(`Corrupt JSON, backup aborted: ${bad.join('; ')}`);
  // Build under a temp name; only replace today's archive once it is verified.
  const tmp = `${file}.tmp-${process.pid}`;
  let listed;
  try {
    await run('tar', ['-czf', tmp, '-C', root, ...parts]);
    const { stdout } = await run('tar', ['-tzf', tmp], { maxBuffer: 50 * 1024 * 1024 });
    listed = stdout.split('\n').filter(Boolean);
    for (const p of parts) if (!listed.some((l) => l === p || l.startsWith(`${p}/`))) throw new Error(`Backup verification failed: ${p} missing`);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
  prune(dir);
  let mirror = { ok: null, detail: 'off' };
  const m = BACKUP_MIRROR();
  if (m) {
    try {
      mkdirSync(m, { recursive: true });
      copyFileSync(file, join(m, `trading-research-${date}.tar.gz`));
      prune(m);
      mirror = { ok: true, detail: m };
    } catch (err) {
      mirror = { ok: false, detail: `${m}: ${err.code || err.message}` };
    }
  }
  const weekly = await weeklyArchive(root, dir, date, mirror.ok ? m : null);
  const status = { at: now.toISOString(), file, bytes: statSync(file).size, files: listed.filter((l) => !l.endsWith('/')).length, mirror, weekly };
  writeJsonAtomic(statusPath(), status);
  return status;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list')) {
    for (const b of listBackups()) console.log(`${b.date}  ${(b.bytes / 1e6).toFixed(2)} MB  ${b.file}`);
    for (const b of listWeekly()) console.log(`${b.week}  ${(b.bytes / 1e6).toFixed(2)} MB  ${b.file} (price history, weekly)`);
  } else {
    backup()
      .then((s) => {
        console.log(`Backed up ${s.files} files (${(s.bytes / 1e6).toFixed(2)} MB) → ${s.file}`);
        if (s.weekly) console.log(s.weekly.skipped ? `Price history: this week's archive exists (${s.weekly.file})` : `Price history (weekly): ${(s.weekly.bytes / 1e6).toFixed(2)} MB → ${s.weekly.file}`);
        console.log(s.mirror.ok ? `Copied to ${s.mirror.detail}` : s.mirror.ok === false ? `Mirror copy failed: ${s.mirror.detail}` : 'Mirror off');
      })
      .catch((err) => {
        console.error('Backup failed:', err.message);
        process.exit(1);
      });
  }
}
