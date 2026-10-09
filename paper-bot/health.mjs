// Health checks: catch silent failures before they corrupt the evidence.
// Each check returns { name, ok, detail } ; `level` is 'ok' | 'warn' | 'fail'.
// Never reads or prints the API key — only whether one is set.

import { readdirSync, existsSync, statSync, statfsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { quote } from '../market-data.mjs';
import { storeStatus } from './collector.mjs';
import { loadCalibration } from './calibration.mjs';
import { computeStats } from './prediction-log.mjs';
import { llmCredits, llmStatus, llmLastModel } from '../ling-client.mjs';
import { backupStatus } from './backup.mjs';
import { growwStatus } from '../groww-data.mjs';
import { OPENROUTER } from '../config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const MONITOR_DIR = process.env.MONITOR_DIR || join(__dir, 'monitor');

/** Most recent weekday (IST) strictly before `now`'s IST date — the last full session. */
export function lastSessionDate(now = new Date()) {
  const ist = new Date(now.getTime() + 19800_000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  let d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  // Today counts once the session has closed (15:30 IST) on a weekday.
  if (!(d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && mins >= 15 * 60 + 30)) d = new Date(d.getTime() - 86400000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

const check = (name, level, detail) => ({ name, level, detail });

/**
 * Free disk space in bytes. On macOS, use the figure Finder shows ("available
 * for important usage", which counts purgeable space macOS frees on demand);
 * fall back to statfs (which doesn't).
 */
export function freeDiskBytes(path = __dir) {
  if (process.platform === 'darwin') {
    try {
      const js = `ObjC.import("Foundation"); var r = Ref(); $.NSURL.fileURLWithPath(${JSON.stringify(path)}).getResourceValueForKeyError(r, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null); r[0].js`;
      const v = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 5000, encoding: 'utf8' }).trim());
      if (v > 0) return v;
    } catch {
      /* fall back */
    }
  }
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

export const DISK_WARN_GB = 2;
export const DISK_FAIL_GB = 0.5;

/**
 * Run all checks.
 * @param {{ quoteFn?: Function, newsProbe?: Function, now?: Date }} [opts]  injectable for tests
 */
export async function healthChecks(opts = {}) {
  const now = opts.now || new Date();
  const out = [];

  // 1. Market data (Yahoo)
  try {
    const t0 = Date.now();
    const q = await (opts.quoteFn || quote)('^NSEI');
    const ms = Date.now() - t0;
    out.push(check('market data', ms > 5000 ? 'warn' : 'ok', `NIFTY ${q.price} in ${ms} ms`));
  } catch (err) {
    out.push(check('market data', 'fail', /rate-limit/i.test(err.message) ? 'Yahoo is rate-limiting — wait and retry' : err.message.slice(0, 120)));
  }

  // 2. News feed
  try {
    const n = await (opts.newsProbe || (async () => {
      const res = await fetch('https://news.google.com/rss/search?q=NIFTY%20when:2d&hl=en-IN&gl=IN&ceid=IN:en', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? (await res.text()).split('<item>').length - 1 : 0;
    }))();
    out.push(check('news feed', n > 0 ? 'ok' : 'warn', n > 0 ? `${n} recent market headlines` : 'news feed returned nothing'));
  } catch (err) {
    out.push(check('news feed', 'warn', err.message.slice(0, 120)));
  }

  // 3. AI: key present (never its value), account balance, recent failures
  if (!process.env.OPENROUTER_API_KEY) {
    out.push(check('AI key', 'warn', 'OPENROUTER_API_KEY not set — news briefs, sentiment and narration are off'));
  } else {
    let credits = null;
    try {
      credits = await (opts.creditsFn || llmCredits)();
    } catch {
      /* balance unknown */
    }
    const recent = (opts.statusFn || llmStatus)();
    const used = (opts.lastModelFn || llmLastModel)();
    const viaFallback = used && used !== OPENROUTER.model ? ` · free fallback ${used} is answering meanwhile` : OPENROUTER.fallbackModels.length ? ' · free fallback models will answer meanwhile' : '';
    if (credits && credits.remaining <= 0.01) {
      out.push(check('AI key', 'warn', `OpenRouter has no credits left (used $${credits.totalUsage.toFixed(2)} of $${credits.totalCredits.toFixed(2)} bought) — add credits at openrouter.ai/settings/credits${viaFallback}`));
    } else if (recent) {
      out.push(check('AI key', 'warn', `last AI call failed (HTTP ${recent.status} at ${recent.at.slice(11, 16)} UTC)${viaFallback}`));
    } else {
      out.push(check('AI key', 'ok', credits ? `key set · balance $${credits.remaining.toFixed(2)}` : 'OPENROUTER_API_KEY is set on the server'));
    }
  }

  // 4. Collector freshness
  const st = storeStatus();
  if (!st.length) {
    out.push(check('intraday store', 'warn', 'empty — run npm run collect after the close'));
  } else {
    const latest = st.map((s) => String(s.to).slice(0, 10)).sort().pop();
    const want = lastSessionDate(now);
    const days = Math.max(...st.map((s) => s.days));
    out.push(latest >= want
      ? check('intraday store', 'ok', `${st.length} series · ${days} trading days · up to ${latest}`)
      : check('intraday store', 'warn', `last bars ${latest}, expected ${want} — collector missed a run (Yahoo keeps ~1 month, so catch up soon)`));
  }

  // 5. Calibration age
  const cal = loadCalibration();
  const fitted = Object.values(cal).map((v) => v.fittedAt).filter(Boolean).sort();
  if (!fitted.length) out.push(check('calibration', 'warn', 'no calibration saved — run npm run calibrate'));
  else {
    const ageDays = (now - new Date(fitted[0])) / 86400000;
    out.push(check('calibration', ageDays > 10 ? 'warn' : 'ok', `oldest table fitted ${ageDays.toFixed(1)} days ago${ageDays > 10 ? ' — refit (npm run calibrate)' : ''}`));
  }

  // 6. Prediction scoring
  try {
    const s = computeStats();
    const stalePending = (s.recentPending || []).filter((e) => now - new Date(e.ts) > 4 * 86400000).length;
    out.push(check('scoring', stalePending ? 'warn' : 'ok', `${s.totalLogged} logged · ${s.evaluated} scored (deduped) · ${s.pending} pending${stalePending ? ` · ${stalePending} pending > 4 days (evaluation failing?)` : ''}`));
  } catch (err) {
    out.push(check('scoring', 'warn', err.message.slice(0, 120)));
  }

  // 7. Monitor last run
  if (existsSync(MONITOR_DIR)) {
    const runs = readdirSync(MONITOR_DIR).filter((f) => f.endsWith('.json')).map((f) => statSync(join(MONITOR_DIR, f)).mtimeMs).sort();
    const last = runs.pop();
    const hrs = last ? (now - last) / 3600000 : Infinity;
    out.push(check('monitor', hrs > 30 ? 'warn' : 'ok', last ? `last run ${hrs.toFixed(1)} h ago` : 'never run'));
  } else {
    out.push(check('monitor', 'warn', 'never run — npm run monitor'));
  }

  // 8. Disk space: the collector, logs and caches fail silently on a full disk.
  try {
    const gb = (opts.diskFn || freeDiskBytes)() / 1e9;
    out.push(gb < DISK_FAIL_GB
      ? check('disk space', 'fail', `only ${gb.toFixed(1)} GB free — data collection and logs will start failing; free up space`)
      : gb < DISK_WARN_GB
        ? check('disk space', 'warn', `${gb.toFixed(1)} GB free — below ${DISK_WARN_GB} GB; free up space soon`)
        : check('disk space', 'ok', `${gb.toFixed(1)} GB free`));
  } catch (err) {
    out.push(check('disk space', 'warn', `could not read free space: ${err.message.slice(0, 80)}`));
  }

  // 9. Backups of the evidence (daily; iCloud copy may be blocked for background jobs)
  const b = (opts.backupFn || backupStatus)();
  if (!b) out.push(check('backup', 'warn', 'no backup yet — runs daily at 18:30 (or: node paper-bot/backup.mjs)'));
  else if (b.error) out.push(check('backup', 'fail', `last backup FAILED (${String(b.error.message).slice(0, 120)}) — fix and re-run: node paper-bot/backup.mjs`));
  else {
    const ageH = (now - new Date(b.at)) / 3600000;
    const mirror = b.mirror?.ok === false ? ` · iCloud copy failed (${b.mirror.detail.split(': ').pop()}) — local copy only` : b.mirror?.ok ? ' · + iCloud copy' : '';
    out.push(ageH > 50
      ? check('backup', 'warn', `last backup ${(ageH / 24).toFixed(1)} days ago — check the backup job${mirror}`)
      : check('backup', b.mirror?.ok === false ? 'warn' : 'ok', `${(b.bytes / 1e6).toFixed(1)} MB, ${b.files} files, ${ageH.toFixed(0)} h ago${mirror}`));
  }

  // 11. Groww (optional broker data): configured / refusing / off
  const gs = (opts.growwFn || growwStatus)();
  if (gs.state !== 'off') out.push(check('Groww data', gs.state === 'blocked' ? 'warn' : 'ok', gs.state === 'blocked' ? gs.detail : `credentials set (${gs.detail})`));

  // 10. State files that failed to parse were moved aside (*.corrupt-*): the app
  // restarted that file fresh, so the evidence needs restoring from a backup.
  try {
    const roots = [__dir, join(__dir, 'data')];
    const bad = roots.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => /\.corrupt-\d+$/.test(f)).map((f) => join(d, f)) : []));
    out.push(bad.length
      ? check('state files', 'fail', `${bad.length} corrupted file(s) were set aside: ${bad.map((f) => f.split('/').slice(-2).join('/')).join(', ')} — restore from ~/trading-research-backups, then delete the .corrupt file`)
      : check('state files', 'ok', 'all state files readable'));
  } catch (err) {
    out.push(check('state files', 'warn', err.message.slice(0, 100)));
  }

  const level = out.some((c) => c.level === 'fail') ? 'fail' : out.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return { level, checks: out, at: now.toISOString() };
}
