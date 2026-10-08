#!/usr/bin/env node
// Daily backup of the evidence that can't be re-created: the prediction log,
// forward-test accounts, paper portfolio, earnings events, monitor reports and
// weekly scorecards, settings, fitted models, and the collected intraday bars
// (Yahoo only keeps ~1 month of those). Re-downloadable caches (NSE files,
// replays, news) are left out.
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
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
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
  'paper-bot/data/candles',
  'paper-bot/monitor',
];

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

/**
 * Create today's archive (overwrites today's if re-run), verify it, prune, mirror.
 * @returns {Promise<{file, bytes, files, mirror}>}
 */
export async function backup({ root = ROOT, now = new Date() } = {}) {
  const dir = BACKUP_DIR();
  mkdirSync(dir, { recursive: true });
  const date = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10); // IST date
  const file = join(dir, `trading-research-${date}.tar.gz`);
  const parts = INCLUDE.filter((p) => existsSync(join(root, p)));
  if (!parts.length) throw new Error('Nothing to back up — no data files found.');
  await run('tar', ['-czf', file, '-C', root, ...parts]);
  // verify: the archive must list every included path
  const { stdout } = await run('tar', ['-tzf', file], { maxBuffer: 50 * 1024 * 1024 });
  const listed = stdout.split('\n').filter(Boolean);
  for (const p of parts) if (!listed.some((l) => l === p || l.startsWith(`${p}/`))) throw new Error(`Backup verification failed: ${p} missing`);
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
  const status = { at: now.toISOString(), file, bytes: statSync(file).size, files: listed.filter((l) => !l.endsWith('/')).length, mirror };
  writeFileSync(statusPath(), JSON.stringify(status, null, 2));
  return status;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list')) {
    for (const b of listBackups()) console.log(`${b.date}  ${(b.bytes / 1e6).toFixed(2)} MB  ${b.file}`);
  } else {
    backup()
      .then((s) => {
        console.log(`Backed up ${s.files} files (${(s.bytes / 1e6).toFixed(2)} MB) → ${s.file}`);
        console.log(s.mirror.ok ? `Copied to ${s.mirror.detail}` : s.mirror.ok === false ? `Mirror copy failed: ${s.mirror.detail}` : 'Mirror off');
      })
      .catch((err) => {
        console.error('Backup failed:', err.message);
        process.exit(1);
      });
  }
}
