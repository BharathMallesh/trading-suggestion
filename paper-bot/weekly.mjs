// Weekly scorecard: the evidence that builds up week by week, in one place.
// Written after the last monitor run of the week (Friday ≥ 15:00 IST) to
// paper-bot/monitor/weekly/<YYYY-Www>.md (+ .json), with one macOS notification.
//   - forward-test strategy accounts: this week and since start, vs NIFTY
//   - predictions scored this week: hit-rate and Brier vs a coin-flip
//   - earnings-drift tracker, NIFTY volatility reading, open health issues
// Research / paper only — not investment advice.

import { writeJsonAtomic } from '../util.mjs';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scorecard } from './monitor-score.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { PAPER_VARIANTS, summarise, trustMeter } from './vwap-pullback.mjs';

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
/** The VWAP strategy's paper versions for one week: trades, net, running total, trust verdict. */
export function strategyWeek(paper, week) {
  if (!paper?.trades) return null;
  return Object.entries(PAPER_VARIANTS).map(([k, v]) => {
    const all = paper.trades.filter((x) => (x.variant || 'video') === k);
    const wk = summarise(all.filter((x) => x.date >= week.from && x.date <= week.to));
    const total = summarise(all);
    return { key: k, label: v.label, weekTrades: wk.trades, weekNetRs: wk.totalNetRs ?? 0, weekWinRate: wk.winRate ?? null, totalTrades: total.trades, totalNetRs: total.totalNetRs ?? 0, trust: trustMeter(total) };
  });
}

const rsx = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const STRAT_START = '<!-- strategy -->';
const STRAT_END = '<!-- /strategy -->';
/** Markdown block for the strategy section (replaceable when later sessions are recorded). */
export function strategyMarkdown(rows, asOf) {
  const lines = [STRAT_START, '', `## VWAP pullback strategy (paper)${asOf ? ` · recorded up to ${asOf}` : ''}`, ''];
  if (!rows) lines.push('No paper record yet.');
  else {
    lines.push('| Version | This week | Week net | Since start | Total net | Can we trust it? |', '|---|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.label} | ${r.weekTrades} trade${r.weekTrades === 1 ? '' : 's'}${r.weekWinRate != null ? ` (${Math.round(r.weekWinRate * 100)}% won)` : ''} | ${rsx(r.weekNetRs)} | ${r.totalTrades} | ${rsx(r.totalNetRs)} | ${r.trust.verdict} |`);
  }
  lines.push('', STRAT_END);
  return lines.join('\n');
}

export function buildWeekly({ reports, entries, week, prevReport = null, paper = null }) {
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
  const strategy = strategyWeek(paper, week);
  lines.push('', strategyMarkdown(strategy, paper?.trades?.length ? paper.trades.map((x) => x.date).sort().pop() : null));
  lines.push('', '## Open health issues', '', issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'None.');
  lines.push('', '_Research / paper simulation only. Not investment advice._', '');

  const nifty = accounts.find((a) => a.key === 'nifty');
  const others = accounts.filter((a) => a.key !== 'nifty');
  const summary = [
    nifty ? `NIFTY ${pct(nifty.weekPct, 2)}` : null,
    ...others.map((a) => `${a.key} ${pct(a.weekPct, 2)}`),
    ...(strategy || []).filter((r) => r.weekTrades).map((r) => `${r.key} strategy ${rsx(r.weekNetRs)}`),
    card.scored ? `${card.scored} scored, Brier ${card.brier.app.toFixed(2)} vs coin ${card.brier.uniform.toFixed(2)}` : 'no predictions scored',
    issues.length ? `${issues.length} health issue${issues.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return { week, generatedAt: new Date().toISOString(), runs: reports.length, accounts, strategy, predictions: card, allTime, events: ev, volatility: vol, issues, summary, markdown: lines.join('\n') };
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
export function maybeWeekly({ entries, now = new Date(), force = false, notifyFn = null, paper = null } = {}) {
  const t = ist(now);
  if (!force && !(lastTradingDayOfWeek(t.date) && t.mins >= 15 * 60)) return null;
  const week = isoWeek(t.date);
  const md = join(WEEKLY_DIR(), `${week.label}.md`);
  if (!force && existsSync(md)) return null;
  const w = buildWeekly({ reports: reportsBetween(week.from, week.to), entries, week, prevReport: reportBefore(week.from), paper });
  mkdirSync(WEEKLY_DIR(), { recursive: true });
  writeFileSync(md, w.markdown);
  writeJsonAtomic(join(WEEKLY_DIR(), `${week.label}.json`), w);
  if (notifyFn) notifyFn(`Weekly scorecard · ${week.label}`, w.summary);
  return w;
}

/** True when no NSE trading day follows `date` in the same week (normally Friday; Thursday if Friday is a holiday). */
export function lastTradingDayOfWeek(date) {
  if (!isTradingDay(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  for (let k = 1; d.getUTCDay() + k <= 6; k++) {
    if (isTradingDay(new Date(d.getTime() + k * 86400000).toISOString().slice(0, 10))) return false;
  }
  return true;
}

/**
 * After the close, put the day's paper trades into this week's scorecard if it
 * was already written (the scorecard is written at 15:00 on the last trading
 * day; that day's trades are only recorded after 15:35).
 */
export function refreshWeeklyStrategy(paper, now = new Date()) {
  const week = isoWeek(ist(now).date);
  const md = join(WEEKLY_DIR(), `${week.label}.md`);
  const js = join(WEEKLY_DIR(), `${week.label}.json`);
  if (!existsSync(md) || !existsSync(js)) return null;
  const w = JSON.parse(readFileSync(js, 'utf8'));
  w.strategy = strategyWeek(paper, week);
  const block = strategyMarkdown(w.strategy, paper?.trades?.length ? paper.trades.map((x) => x.date).sort().pop() : null);
  const text = readFileSync(md, 'utf8');
  const a = text.indexOf(STRAT_START);
  const b = text.indexOf(STRAT_END);
  w.markdown = a >= 0 && b > a ? text.slice(0, a) + block + text.slice(b + STRAT_END.length) : `${text}\n${block}\n`;
  writeFileSync(md, w.markdown);
  writeJsonAtomic(js, w);
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
