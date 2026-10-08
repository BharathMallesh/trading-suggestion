// Health checks: catch silent failures before they corrupt the evidence.
// Each check returns { name, ok, detail } ; `level` is 'ok' | 'warn' | 'fail'.
// Never reads or prints the API key — only whether one is set.

import { readdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { quote } from '../market-data.mjs';
import { storeStatus } from './collector.mjs';
import { loadCalibration } from './calibration.mjs';
import { computeStats } from './prediction-log.mjs';
import { llmCredits, llmStatus } from '../ling-client.mjs';

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
      const res = await fetch('https://news.google.com/rss/search?q=NIFTY%20when:2d&hl=en-IN&gl=IN&ceid=IN:en', { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    if (credits && credits.remaining <= 0.01) {
      out.push(check('AI key', 'warn', `OpenRouter has no credits left (used $${credits.totalUsage.toFixed(2)} of $${credits.totalCredits.toFixed(2)} bought) — add credits at openrouter.ai/settings/credits; AI features are falling back`));
    } else if (recent) {
      out.push(check('AI key', 'warn', `last AI call failed (HTTP ${recent.status} at ${recent.at.slice(11, 16)} UTC)`));
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

  const level = out.some((c) => c.level === 'fail') ? 'fail' : out.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return { level, checks: out, at: now.toISOString() };
}
