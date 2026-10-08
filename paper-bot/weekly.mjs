// Weekly scorecard: the evidence that builds up week by week, in one place.
// Written after the last monitor run of the week (Friday ≥ 15:00 IST) to
// paper-bot/monitor/weekly/<YYYY-Www>.md (+ .json), with one macOS notification.
//   - forward-test strategy accounts: this week and since start, vs NIFTY
//   - predictions scored this week: hit-rate and Brier vs a coin-flip
//   - earnings-drift tracker, NIFTY volatility reading, open health issues
// Research / paper only — not investment advice.

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scorecard } from './monitor-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_DIR = () => process.env.MONITOR_DIR || join(HERE, 'monitor');
const WEEKLY_DIR = () => join(MONITOR_DIR(), 'weekly');

/** IST calendar parts of a Date. */
function ist(now) {
  const d = new Date(now.getTime() + 19800_000);
  return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** ISO week label (YYYY-Www) and its Monday/Sunday (IST dates). */
export function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  const monday = new Date(d.getTime() - day * 86400000);
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = 1 + Math.floor((thursday - yearStart) / (7 * 86400000));
  return {
    label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`,
    from: monday.toISOString().slice(0, 10),
    to: new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10),
  };
}

/** Monitor reports saved during [from, to] (file names start with the IST date). */
export function reportsBetween(from, to, dir = MONITOR_DIR()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f.slice(0, 10) >= from && f.slice(0, 10) <= to)
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);

/**
 * Build the weekly scorecard.
 * @param {{ reports: object[], entries: object[], week: {label, from, to}, prevReport?: object }} p
 *   reports: this week's monitor reports (oldest first); prevReport: the last
 *   report before the week (baseline for "this week" account changes).
 */
export function buildWeekly({ reports, entries, week, prevReport = null }) {
  const last = reports[reports.length - 1] || null;
  // Strategy accounts: equity at the end of the week vs the first value seen
  // (the last report before the week, else the account's first run this week).
  const startEq = new Map();
  for (const r of [prevReport, ...reports].filter(Boolean)) {
    for (const a of r.strategies?.accounts || []) if (!startEq.has(a.key)) startEq.set(a.key, a.equity);
  }
  const accounts = (last?.strategies?.accounts || []).map((a) => ({
    key: a.key,
    name: a.name,
    equity: a.equity,
    weekPct: startEq.get(a.key) ? (a.equity / startEq.get(a.key) - 1) * 100 : null,
    totalPct: a.returnPct,
    holdings: a.holdings,
  }));
  // Predictions scored this week (by prediction time).
  const inWeek = (entries || []).filter((e) => {
    const d = new Date(new Date(e.ts).getTime() + 19800_000).toISOString().slice(0, 10);
    return d >= week.from && d <= week.to;
  });
  const card = scorecard(inWeek);
  const allTime = scorecard(entries || []);
  const issues = (last?.health?.checks || []).filter((c) => c.level !== 'ok').map((c) => `${c.name}: ${c.detail}`);
  const ev = last?.events?.stats || null;
  const vol = last?.volatility && !last.volatility.error ? last.volatility : null;

  const lines = [];
  lines.push(`# Weekly scorecard · ${week.label} (${week.from} → ${week.to})`, '');
  lines.push(`${reports.length} monitor runs this week.`, '', '## Forward-test accounts (paper)', '');
  if (accounts.length) {
    lines.push('| Account | Equity | This week | Since start | Holdings |', '|---|---|---|---|---|');
    for (const a of accounts) lines.push(`| ${a.name} | ₹${Math.round(a.equity).toLocaleString('en-IN')} | ${pct(a.weekPct, 2)} | ${pct(a.totalPct, 2)} | ${a.holdings} |`);
  } else lines.push('No strategy-account data this week.');
  lines.push('', '## Predictions scored this week', '');
  if (card.scored) {
    lines.push(`${card.scored} scored · hit-rate ${card.hitRatePct.toFixed(0)}% · Brier app ${card.brier.app.toFixed(4)} vs coin-flip ${card.brier.uniform.toFixed(4)} (lower is better).`);
  } else lines.push('None scored this week.');
  if (allTime.scored) lines.push('', `All time: ${allTime.scored} scored — ${allTime.verdict}`);
  if (Array.isArray(ev) && ev.length) {
    const cell = (x) => (!x ? 'pending' : x.avgAbnormalPct != null ? `${pct(x.avgAbnormalPct, 2)} vs NIFTY (n ${x.n})` : `${pct(x.avgRetPct, 2)} (n ${x.n})`);
    lines.push('', '## Earnings / rating events (drift vs NIFTY)', '', '| Event | Count | +1 day | +5 days | +20 days |', '|---|---|---|---|---|');
    for (const t of ev) lines.push(`| ${t.type} | ${t.events} | ${cell(t.d1)} | ${cell(t.d5)} | ${cell(t.d20)} |`);
  }
  if (vol) lines.push('', '## NIFTY volatility', '', `India VIX ${vol.impliedPct?.toFixed(1)}% vs forecast ${vol.forecastPct?.toFixed(1)}% (${vol.model}). ${vol.reading || ''}`);
  lines.push('', '## Open health issues', '', issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'None.');
  lines.push('', '_Research / paper simulation only. Not investment advice._', '');

  const nifty = accounts.find((a) => a.key === 'nifty');
  const others = accounts.filter((a) => a.key !== 'nifty');
  const summary = [
    nifty ? `NIFTY ${pct(nifty.weekPct, 2)}` : null,
    ...others.map((a) => `${a.key} ${pct(a.weekPct, 2)}`),
    card.scored ? `${card.scored} scored, Brier ${card.brier.app.toFixed(2)} vs coin ${card.brier.uniform.toFixed(2)}` : 'no predictions scored',
    issues.length ? `${issues.length} health issue${issues.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return { week, generatedAt: new Date().toISOString(), runs: reports.length, accounts, predictions: card, allTime, events: ev, volatility: vol, issues, summary, markdown: lines.join('\n') };
}

/** Last monitor report saved before `from` (baseline for weekly changes). */
function reportBefore(from, dir = MONITOR_DIR()) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => n.endsWith('.json') && n.slice(0, 10) < from).sort().pop();
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write this week's scorecard if it's due (Friday ≥ 15:00 IST, or `force`) and
 * not written yet. Returns the scorecard or null.
 */
export function maybeWeekly({ entries, now = new Date(), force = false, notifyFn = null } = {}) {
  const t = ist(now);
  if (!force && !(t.day === 5 && t.mins >= 15 * 60)) return null;
  const week = isoWeek(t.date);
  const md = join(WEEKLY_DIR(), `${week.label}.md`);
  if (!force && existsSync(md)) return null;
  const w = buildWeekly({ reports: reportsBetween(week.from, week.to), entries, week, prevReport: reportBefore(week.from) });
  mkdirSync(WEEKLY_DIR(), { recursive: true });
  writeFileSync(md, w.markdown);
  writeFileSync(join(WEEKLY_DIR(), `${week.label}.json`), JSON.stringify(w, null, 2));
  if (notifyFn) notifyFn(`Weekly scorecard · ${week.label}`, w.summary);
  return w;
}

/** Most recent saved weekly scorecard, or null. */
export function latestWeekly() {
  const dir = WEEKLY_DIR();
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().pop();
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    return null;
  }
}
