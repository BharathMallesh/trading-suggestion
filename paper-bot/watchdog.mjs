#!/usr/bin/env node
// Daily watchdog (library + CLI): after the evening run, check that everything
// the Mac is supposed to do unattended actually happened, and say so plainly.
//   - collect ran (collect.log), NIFTY's 5-minute bars were saved, all four
//     paper records were updated, the dashboard server answers, the backup is
//     recent, storage is not too big, the weekly refit ran, the launchd jobs
//     are loaded.
//   - Weekends and NSE holidays are not errors: on those days (and before
//     16:05 on a trading day, when today's run is not due yet) the checks look
//     at the last trading day's run instead.
// Each check: { name, ok, detail, fix } — `fix` is a plain-English hint.
// Saved to paper-bot/data/watchdog.json (WATCHDOG_PATH to change).
//
//   node paper-bot/watchdog.mjs            # run the checks, print a summary
//   node paper-bot/watchdog.mjs --notify   # + ONE Mac notification, only if something failed

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../util.mjs';
import { isTradingDay, lastSessionDate } from './market-calendar.mjs';
import { readStore } from './collector.mjs';
import { backupStatus } from './backup.mjs';
import { storageSizes, STORAGE_WARN_GB } from './health.mjs';
import { loadPaper } from './vwap-pullback.mjs';
import { loadAthPaper } from './ath-swing.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadNiftyDipPaper } from './nifty-dip.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WATCHDOG_PATH = () => process.env.WATCHDOG_PATH || join(HERE, 'data', 'watchdog.json');
export const LOG_DIR = () => process.env.TRADING_LOG_DIR || join(homedir(), 'Library', 'Logs', 'trading-research');
export const SERVER_URL = () => process.env.WATCHDOG_SERVER_URL || 'http://127.0.0.1:3000/';
export const DUE_MINS = 16 * 60 + 5; // the collect job starts at 16:05 IST on trading days
export const BACKUP_MAX_DAYS = 2;
export const REFIT_MAX_DAYS = 8;
export const JOBS = ['server', 'collect', 'monitor', 'refit', 'backup'];
export const LABELS = JOBS.map((j) => `com.trading-research.${j}`);

const ist = (now) => {
  const t = new Date(now.getTime() + 19800_000);
  return { date: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
};
const istDate = (iso) => (iso ? new Date(new Date(iso).getTime() + 19800_000).toISOString().slice(0, 10) : null);
const daysAgo = (d, now) => (now - d) / 86400000;
const check = (name, ok, detail, fix = '') => ({ name, ok, detail, fix: ok ? '' : fix });

/**
 * Which day's evening run to check: today once 16:05 has passed on a trading
 * day; otherwise the last trading day before today (weekend, holiday, or
 * today's run not due yet).
 */
export function sessionToCheck(now = new Date()) {
  const t = ist(now);
  if (isTradingDay(t.date) && t.mins >= DUE_MINS) return { today: t.date, session: t.date, note: '' };
  const prev = lastSessionDate(new Date(`${t.date}T00:00:00+05:30`)); // midnight IST → the previous trading day
  const note = isTradingDay(t.date) ? 'today’s run is not due until 16:05' : `${t.date} is not a trading day`;
  return { today: t.date, session: prev, note };
}

const readLog = (name) => {
  try {
    return readFileSync(join(LOG_DIR(), `${name}.log`), 'utf8').split('\n');
  } catch {
    return null;
  }
};
const HEADER = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (\S+)/;

/** collect.log: the `session` run's header line, "0 failed", and no "Error:" lines in that run's output. */
export function checkCollect(session, note = '') {
  const name = 'collect ran';
  const fix = 'Open Terminal and run: cd ~/trading-research && scripts/run.sh collect — it saves the day’s prices and updates the paper records. If this keeps happening, check the Mac was awake at 16:05 (plugged in, lid open).';
  const lines = readLog('collect');
  if (!lines) return check(name, false, `no collect log found in ${LOG_DIR()}`, `${fix} If it never ran, install the jobs: scripts/install-autostart.sh`);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(HEADER);
    if (m && m[1] === session && m[3] === 'collect') { start = i; break; }
  }
  if (start < 0) return check(name, false, `no collect run logged for ${session}`, fix);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (HEADER.test(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end);
  const at = lines[start].slice(11, 16);
  const errors = body.filter((l) => /^\w*Error:/.test(l)); // "Error: …" / "TypeError: …" at line start (the watchdog's own indented output never matches)
  const summary = body.find((l) => /^Collected \d+ series/.test(l));
  const prefix = note ? `${note}; last run ${session} ${at}` : `ran ${session} ${at}`;
  if (errors.length) return check(name, false, `${prefix} but logged an error: ${errors[0].trim().slice(0, 140)}`, fix);
  if (!summary) return check(name, false, `${prefix} but the collector never finished (no "Collected …" line)`, fix);
  if (!/\b0 failed\b/.test(summary)) return check(name, false, `${prefix}: ${summary.trim()}`, 'Some price series failed to download (usually Yahoo being slow). Re-run: cd ~/trading-research && node paper-bot/collector.mjs — it only adds what is missing.');
  return check(name, true, `${prefix} · ${summary.replace(/^Collected /, '').trim()}`);
}

/** 5-minute store has NIFTY bars for `session` (gzip or legacy .json — readStore handles both). */
export function checkStore(session) {
  const rows = readStore('^NSEI', '5m');
  const bars = rows.filter((r) => String(r.date).startsWith(session)).length;
  const last = rows.length ? String(rows[rows.length - 1].date).slice(0, 10) : null;
  return bars
    ? check('5-minute prices saved', true, `${bars} NIFTY bars saved for ${session}`)
    : check('5-minute prices saved', false, last ? `no NIFTY 5-minute bars for ${session} (last saved day ${last})` : 'no NIFTY 5-minute bars saved at all',
      'Run: cd ~/trading-research && node paper-bot/collector.mjs — Yahoo keeps only about 60 days of 5-minute bars, so catch up within a few weeks.');
}

export const RECORDS = [
  { name: 'YouTube intraday', file: 'vwap-paper.json', load: () => loadPaper(), cmd: 'node paper-bot/vwap-pullback.mjs --paper' },
  { name: 'Strong-stock swing', file: 'ath-paper.json', load: () => loadAthPaper(), cmd: 'node paper-bot/ath-swing.mjs --paper' },
  { name: 'Breakfast', file: 'breakfast-paper.json', load: () => loadBreakfastPaper(), cmd: 'node paper-bot/breakfast.mjs --paper' },
  { name: 'NIFTY dip-buy', file: 'nifty-dip-paper.json', load: () => loadNiftyDipPaper(), cmd: 'node paper-bot/nifty-dip.mjs --paper' },
];

/** A paper record was updated on or after `session` (IST date of its updatedAt). */
export function checkRecord(r, session) {
  const name = `paper record: ${r.name}`;
  const fix = `Run: cd ~/trading-research && ${r.cmd} — it re-checks every day since the start, so nothing is lost.`;
  let st = null;
  try { st = r.load(); } catch { /* unreadable = missing */ }
  if (!st) return check(name, false, `${r.file} is missing or unreadable`, fix);
  const d = istDate(st.updatedAt);
  return d && d >= session
    ? check(name, true, `${r.file} updated ${d} ${new Date(new Date(st.updatedAt).getTime() + 19800_000).toISOString().slice(11, 16)}`)
    : check(name, false, `${r.file} last updated ${d || 'never'}, expected ${session}`, fix);
}

/** Dashboard server answers (any HTTP response counts; 3-second timeout). */
export async function checkServer(fetchFn = fetch) {
  const fix = 'Restart it: launchctl kickstart -k gui/$(id -u)/com.trading-research.server — or run scripts/run.sh server in Terminal to see the error. Logs: ~/Library/Logs/trading-research/server.log';
  try {
    const res = await fetchFn(SERVER_URL(), { signal: AbortSignal.timeout(3000) });
    return check('dashboard server', true, `answering on ${SERVER_URL()} (HTTP ${res.status})`);
  } catch (err) {
    return check('dashboard server', false, `not answering on ${SERVER_URL()} (${String(err.cause?.code || err.name || err.message).slice(0, 60)})`, fix);
  }
}

/** Latest backup ≤ 2 days old and did not fail. */
export function checkBackup(now, b = backupStatus()) {
  const fix = 'Run: cd ~/trading-research && node paper-bot/backup.mjs — and read any error it prints. Logs: ~/Library/Logs/trading-research/backup.log';
  if (!b?.at) return check('backup', false, b?.error ? `backup failed: ${String(b.error.message).slice(0, 120)}` : 'no backup made yet', fix);
  if (b.error && b.error.at > b.at) return check('backup', false, `last backup FAILED ${istDate(b.error.at)}: ${String(b.error.message).slice(0, 120)}`, fix);
  const age = daysAgo(new Date(b.at), now);
  return age <= BACKUP_MAX_DAYS
    ? check('backup', true, `${(b.bytes / 1e6).toFixed(1)} MB, ${age < 1 ? `${Math.round(age * 24)} h` : `${age.toFixed(1)} days`} ago${b.mirror?.ok === false ? ' · iCloud copy failed, local copy only' : ''}`)
    : check('backup', false, `last backup ${age.toFixed(1)} days ago (more than ${BACKUP_MAX_DAYS})`, fix);
}

/** App data and local backups each under STORAGE_WARN_GB. */
export function checkStorage(sizes) {
  const mb = (b) => `${Math.round(b / 1e6)} MB`;
  const over = sizes.data / 1e9 > STORAGE_WARN_GB || sizes.backups / 1e9 > STORAGE_WARN_GB;
  return check('storage', !over, `data ${mb(sizes.data)} · backups ${mb(sizes.backups)} (warning above ${STORAGE_WARN_GB} GB each)`,
    'Old download caches in paper-bot/data (mf, fo-bhav folders) can be deleted — they re-download when needed. Old backups are in ~/trading-research-backups (the newest 30 are kept automatically).');
}

/** refit.log: last "YYYY-MM-DD HH:MM:SS refit" line within 8 days, and no "Error:" lines in that run's output. */
export function checkRefit(now) {
  const fix = 'Run: cd ~/trading-research && scripts/run.sh refit (takes several minutes). It runs every Saturday at 10:00 — the Mac must be awake then.';
  const lines = readLog('refit');
  let start = -1;
  for (let i = (lines || []).length - 1; i >= 0; i--) {
    const m = lines[i].match(HEADER);
    if (m && m[3] === 'refit') { start = i; break; }
  }
  if (start < 0) return check('weekly refit', false, lines ? 'refit.log has no run yet' : 'no refit log found', fix);
  const last = lines[start].match(HEADER);
  const age = daysAgo(new Date(`${last[1]}T${last[2]}+05:30`), now);
  if (age > REFIT_MAX_DAYS) return check('weekly refit', false, `last ran ${last[1]} (${age.toFixed(1)} days ago, more than ${REFIT_MAX_DAYS})`, fix);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (HEADER.test(lines[i])) { end = i; break; }
  const errors = lines.slice(start + 1, end).filter((l) => /^\w*Error:/.test(l));
  if (errors.length) {
    const offline = errors.filter((l) => /fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(l)).length;
    return check('weekly refit', false, `ran ${last[1]} but ${errors.length} step${errors.length > 1 ? 's' : ''} failed${offline ? ` (${offline} could not download: no internet?)` : ''}: ${errors[0].trim().slice(0, 120)}`,
      `${offline ? 'The Mac was probably offline (Wi-Fi not connected after waking). ' : ''}${fix}`);
  }
  return check('weekly refit', true, `last ran ${last[1]} (${age.toFixed(1)} days ago)`);
}

const run = promisify(execFile);
const launchctlList = async () => (await run('launchctl', ['list'], { timeout: 5000 })).stdout;

/** The launchd jobs are loaded (labels present in `launchctl list`). */
export async function checkLaunchd(listFn = launchctlList) {
  const fix = 'Re-install the background jobs: cd ~/trading-research && scripts/install-autostart.sh';
  try {
    const out = String(await listFn());
    const missing = LABELS.filter((l) => !out.includes(l));
    return missing.length
      ? check('background jobs', false, `not loaded: ${missing.map((l) => l.split('.').pop()).join(', ')}`, fix)
      : check('background jobs', true, `all ${LABELS.length} loaded (${JOBS.join(', ')})`);
  } catch (err) {
    return check('background jobs', false, `could not list jobs: ${String(err.message).slice(0, 80)}`, fix);
  }
}

/**
 * Run every check. Injectable for tests: now, fetchFn, listFn, sizesFn, backupFn.
 * @returns {Promise<{at, date, session, note, ok, checks}>}
 */
export async function watchdogChecks({ now = new Date(), fetchFn = fetch, listFn, sizesFn = storageSizes, backupFn = backupStatus } = {}) {
  const { today, session, note } = sessionToCheck(now);
  const checks = [checkCollect(session, note), checkStore(session), ...RECORDS.map((r) => checkRecord(r, session))];
  checks.push(await checkServer(fetchFn));
  checks.push(checkBackup(now, backupFn()));
  try {
    checks.push(checkStorage(sizesFn()));
  } catch (err) {
    checks.push(check('storage', false, `could not measure: ${String(err.message).slice(0, 80)}`, 'Check the disk is readable; run node paper-bot/health.mjs for details.'));
  }
  checks.push(checkRefit(now));
  checks.push(await checkLaunchd(listFn));
  return { at: now.toISOString(), date: today, session, note, ok: checks.every((c) => c.ok), checks };
}

export function loadWatchdog() {
  try {
    return existsSync(WATCHDOG_PATH()) ? JSON.parse(readFileSync(WATCHDOG_PATH(), 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * Saved result is still about the run that should be checked now (and < 26 h old).
 * While today's collect job is probably still running (16:05–16:45), yesterday's
 * result counts as fresh too, so the page doesn't show half-finished work as failures.
 */
export function watchdogFresh(saved, now = new Date()) {
  if (!saved?.at || now - new Date(saved.at) >= 26 * 3600000) return false;
  const { session } = sessionToCheck(now);
  const t = ist(now);
  return saved.session === session || (session === t.date && t.mins < DUE_MINS + 40);
}

const osaNotify = (title, message) => execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message.slice(0, 220)], () => {});

/** Run, save, and (with notify) send ONE notification only when something failed. */
export async function runWatchdog({ notify = false, notifyFn = osaNotify, save = true, ...opts } = {}) {
  const r = await watchdogChecks(opts);
  if (save) writeJsonAtomic(WATCHDOG_PATH(), r);
  if (notify && !r.ok) {
    const bad = r.checks.filter((c) => !c.ok);
    notifyFn(`Trading research · ${bad.length} system check${bad.length > 1 ? 's' : ''} failed`, `${bad.map((c) => c.name).join(', ')} — ${bad[0].fix}`);
  }
  return r;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWatchdog({ notify: process.argv.includes('--notify') })
    .then((r) => {
      console.log(`${r.date} watchdog: checking the ${r.session} run${r.note ? ` (${r.note})` : ''}`);
      for (const c of r.checks) {
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
        if (!c.ok) console.log(`       fix: ${c.fix}`);
      }
      console.log(r.ok ? 'All systems OK.' : `${r.checks.filter((c) => !c.ok).length} check(s) failed.`);
    })
    .catch((err) => {
      console.error('Watchdog failed:', err.message);
      process.exit(1);
    });
}
