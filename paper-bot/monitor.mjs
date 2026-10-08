#!/usr/bin/env node
// Investor monitor: one run = what an investor would check, recorded so we can
// see over days/weeks whether the app's numbers are any good.
//
// Talks to the RUNNING dashboard server (so it uses that server's API key):
//   1. Watchlist (Settings → symbols): Call/Put multi-horizon with news
//      → every prediction is logged for later scoring.
//   2. Scores predictions whose horizon has passed.
//   3. Applies today's daily signals to the paper portfolio.
//   4. Scorecard from all scored predictions: hit-rate, Brier vs simple
//      baselines, does Ling help, does the news tilt help.
//   5. Health checks, NIFTY implied-vs-forecast volatility, ranking, and the
//      earnings-event tracker (scan NIFTY 50 news for results beats/misses).
//   6. Alerts (held stock with a results event, options unusually rich/cheap,
//      tilt switched off, failing health checks, …) — optional macOS
//      notification with --notify.
// Writes paper-bot/monitor/<date>-<time>.json and appends to journal.md.
// The dashboard's "Today" page runs the same function in-process.
//
//   node paper-bot/monitor.mjs                 # default http://127.0.0.1:3000
//   MONITOR_URL=http://127.0.0.1:3001 node paper-bot/monitor.mjs
//   node paper-bot/monitor.mjs --no-trade      # skip the paper portfolio step
//   node paper-bot/monitor.mjs --notify        # macOS notification for alerts
//
// Research / paper simulation only. Not investment advice.

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { scorecard } from './monitor-score.mjs';
import { maybeWeekly } from './weekly.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MONITOR_DIR || join(HERE, 'monitor');
const BASE = process.env.MONITOR_URL || 'http://127.0.0.1:3000';

/** JSON client for the dashboard server at `base`. */
function client(base) {
  return async function api(path, body) {
    const res = await fetch(base + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
    return data;
  };
}

/**
 * Alerts worth an investor's attention (factual; never "buy/sell").
 * @returns {{ level:'high'|'info', text:string }[]}
 */
export function computeAlerts(r) {
  const out = [];
  for (const c of r.health?.checks || []) {
    if (c.level === 'fail') out.push({ level: 'high', text: `Health: ${c.name} failing — ${c.detail}` });
    else if (c.level === 'warn' && c.name === 'AI key' && /credits|balance|failed/.test(c.detail)) out.push({ level: 'high', text: `AI: ${c.detail}` });
    else if (c.level === 'warn' && c.name === 'disk space') out.push({ level: 'high', text: `Disk: ${c.detail}` });
    else if (c.level === 'warn' && ['intraday store', 'calibration', 'scoring'].includes(c.name)) out.push({ level: 'info', text: `Health: ${c.name} — ${c.detail}` });
  }
  const held = new Set((r.portfolio?.positions || []).map((p) => p.symbol));
  for (const w of r.watchlist || []) {
    if (held.has(w.symbol) && (w.events || []).includes('results')) out.push({ level: 'high', text: `${w.symbol} (held in paper portfolio): results event in the news — moves are usually larger.` });
  }
  const v = r.volatility;
  // Only flag NIFTY options when the gap is unusual vs VIX's normal premium.
  if (v?.reading && /unusually/.test(v.reading)) out.push({ level: 'info', text: `NIFTY: ${v.reading}` });
  else if (!v?.typicalRatio && v?.ratio >= 1.3) out.push({ level: 'info', text: `NIFTY options pricing ${((v.ratio - 1) * 100).toFixed(0)}% more volatility than forecast (India VIX ${v.impliedPct?.toFixed(1)}%).` });
  if (r.evaluation?.newsValue?.tilt?.autoDisabled) out.push({ level: 'high', text: 'News tilt switched itself off: scored predictions show it does not help.' });
  if (r.scorecard?.scored >= 30 && r.scorecard.brier.app >= r.scorecard.brier.uniform) out.push({ level: 'high', text: `Probabilities are doing no better than a coin-flip after ${r.scorecard.scored} scored predictions.` });
  for (const e of r.events?.added || []) out.push({ level: 'info', text: `New event: ${e.symbol} ${e.type} (at ${Number(e.price).toFixed(2)}) — tracked for 1/5/20-day drift.` });
  for (const a of r.portfolio?.actions || []) out.push({ level: 'info', text: `Paper portfolio: ${a.action} ${a.symbol}.` });
  for (const a of r.strategies?.actions || []) {
    if (a.account !== 'nifty') out.push({ level: 'info', text: `Strategy forward test · ${a.account}: ${a.action}.` });
  }
  return out;
}

/** macOS desktop notification (no-op elsewhere). Text passed as an argument, never interpolated into a script. */
export function notify(title, message) {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message.slice(0, 220)], () => {});
}

/** Latest saved monitor report (for the Today page), or null. */
export function latestReport() {
  if (!existsSync(OUT)) return null;
  const files = readdirSync(OUT).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  try {
    return JSON.parse(readFileSync(join(OUT, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

/** NSE session status in IST, independent of this machine's timezone. */
export function marketStatus(now = new Date()) {
  const ist = new Date(now.getTime() + 19800_000);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  return { open, ist: ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST', weekday: day >= 1 && day <= 5 };
}

export { scorecard } from './monitor-score.mjs';

/**
 * One monitoring run against the dashboard server at `base`.
 * @returns {Promise<object>} the saved report
 */
export async function runMonitor({ base = BASE, trade = true, notify: doNotify = false } = {}) {
  const api = client(base);
  const startedAt = new Date().toISOString();
  const market = marketStatus();
  const { settings } = await api('/api/settings');
  const symbols = settings.symbols;

  // 1. Watchlist predictions (3 at a time; each also logs itself for scoring)
  const rows = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = await Promise.all(symbols.slice(i, i + 3).map(async (s) => {
      try {
        const d = await api('/api/groww-predict', { symbol: s, mode: 'multi', includeNews: true });
        const p = d.prediction;
        // chance of a > ±2% move next session (size, not direction)
        let big2 = null;
        try {
          const b = await api(`/api/big-move?symbol=${encodeURIComponent(d.symbol)}`);
          big2 = b.horizons?.['1d']?.odds?.find((o) => o.movePct === 2)?.prob ?? null;
        } catch {
          /* optional */
        }
        return {
          symbol: d.symbol, last: d.lastClose, up: p.probUp, down: p.probDown, side: p.probSideways, bias: p.bias,
          edge: d.edge?.level, aiAdjusted: p.adjustmentNote !== 'No LLM adjustment applied',
          sentiment: d.news?.sentiment ?? null, tiltPts: d.newsTilt?.applied ? d.newsTilt.shiftPts : 0,
          events: d.news?.events || [], atrPct: d.expectedMove?.upside?.typicalPct ?? null, headline: d.news?.headlines?.[0]?.title || null, big2,
        };
      } catch (err) {
        return { symbol: s, error: err.message };
      }
    }));
    rows.push(...batch);
  }

  // 1b. Volatility (NIFTY: India VIX vs forecast) and the weeks–months ranking
  let vol = null;
  let ranking = null;
  try {
    const v = await api('/api/vol-check?symbol=%5ENSEI&days=7');
    vol = { impliedPct: v.impliedPct, forecastPct: v.forecastPct, ratio: v.ratio, typicalRatio: v.typicalRatio, model: v.model, reading: v.reading };
  } catch (err) {
    vol = { error: err.message };
  }
  try {
    const r = await api('/api/rankings');
    ranking = { asOf: r.asOf, top: r.ranking.slice(0, 5).map((x) => x.symbol), bottom: r.ranking.slice(-5).map((x) => x.symbol) };
  } catch (err) {
    ranking = { error: err.message };
  }

  // 1c. Health + earnings-event tracker (NIFTY 50 news; one AI reading per stock per day)
  let health = null;
  try {
    health = await api('/api/health');
  } catch (err) {
    health = { level: 'fail', checks: [{ name: 'health endpoint', level: 'fail', detail: err.message }] };
  }
  let events = null;
  try {
    const sc = await api('/api/events/scan', { universe: 'nifty50' });
    events = { added: sc.added, stats: sc.stats, tracked: sc.tracked };
  } catch (err) {
    events = { error: err.message };
  }

  // 1d. Strategy forward-test accounts (each trades only on its own schedule)
  let strategies = null;
  try {
    const sa = await api('/api/strategy-accounts/rebalance', {});
    strategies = { startedAt: sa.startedAt, actions: sa.actions, accounts: sa.accounts.map((x) => ({ key: x.key, name: x.name, equity: x.equity, returnPct: x.returnPct, holdings: x.holdings.length })) };
  } catch (err) {
    strategies = { error: err.message };
  }

  // 2. Score due predictions
  const evalRes = await api('/api/prediction-evaluate', {});
  const { entries } = await api('/api/prediction-history?limit=500');
  const card = scorecard(entries);

  // 3. Paper portfolio
  let pf = null;
  if (trade) {
    try {
      pf = await api('/api/portfolio/rebalance', {});
    } catch (err) {
      pf = { error: err.message };
    }
  }

  const report = {
    startedAt, finishedAt: new Date().toISOString(), market, server: BASE, watchlist: rows,
    evaluation: { checked: evalRes.checked, newlyScored: evalRes.updated, llmValue: evalRes.stats?.llmValue, newsValue: evalRes.stats?.newsValue },
    scorecard: card,
    volatility: vol,
    ranking,
    health,
    events,
    strategies,
    portfolio: pf && !pf.error
      ? { equity: pf.equity, returnPct: pf.returnPct, cash: pf.cash, charges: pf.totalCharges, positions: pf.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, entry: p.entryPrice, last: p.mark, pnl: p.unrealized })), actions: pf.actions.filter((a) => ['buy', 'close'].includes(a.action)) }
      : pf,
    disclaimer: 'Research / paper simulation only. Not investment advice.',
  };
  report.alerts = computeAlerts(report);
  if (doNotify && report.alerts.length) {
    const top = report.alerts.filter((a) => a.level === 'high').concat(report.alerts.filter((a) => a.level !== 'high'));
    notify(`Trading research · ${report.alerts.length} alert${report.alerts.length > 1 ? 's' : ''}`, top.slice(0, 3).map((a) => a.text).join(' · '));
  }

  mkdirSync(OUT, { recursive: true });
  const stamp = market.ist.replace(' IST', '').replace(/[: ]/g, '-'); // IST, e.g. 2026-10-08-10-29
  writeFileSync(join(OUT, `${stamp}.json`), JSON.stringify(report, null, 2));
  const journal = join(OUT, 'journal.md');
  if (!existsSync(journal)) {
    appendFileSync(journal, '# Investor monitor journal\n\n| Run (IST) | Market | Scored | Hit-rate | Brier app / coin-flip / before-Ling | Ling | News tilt | Portfolio | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  }
  const f = (x) => (x == null ? '–' : x.toFixed(4));
  const v = report.evaluation;
  const notable = rows.filter((r) => r.events?.length || Math.abs(r.sentiment ?? 0) >= 0.6).map((r) => `${r.symbol.replace('.NS', '')}${r.events?.length ? '⚠' : ''}${r.sentiment != null ? ` ${r.sentiment > 0 ? '+' : ''}${r.sentiment}` : ''}`).join(', ');
  appendFileSync(journal, `| ${market.ist} | ${market.open ? 'open' : 'closed'} | ${card.scored} | ${card.hitRatePct != null ? card.hitRatePct.toFixed(0) + '%' : '–'} | ${f(card.brier?.app)} / ${f(card.brier?.uniform)} / ${f(card.brier?.beforeLing)} | ${v.llmValue?.n ? v.llmValue.verdict : 'n/a'} | ${v.newsValue?.tilt?.n ? v.newsValue.tilt.verdict : 'n/a'} | ${report.portfolio?.equity != null ? '₹' + report.portfolio.equity.toFixed(0) : '–'} | ${notable || '–'} |\n`);

  // Weekly scorecard after the last run of the week (Friday ≥ 15:00 IST).
  try {
    const w = maybeWeekly({ entries, notifyFn: doNotify ? notify : null });
    if (w) report.weekly = { week: w.week.label, summary: w.summary };
  } catch (err) {
    report.weekly = { error: err.message };
  }

  report.files = { json: join(OUT, `${stamp}.json`), journal };
  return report;
}

/** Console summary of a report (CLI). */
function printReport(report) {
  const { market, watchlist: rows, scorecard: card, volatility: vol, ranking, evaluation: v } = report;
  const f = (x) => (x == null ? '–' : x.toFixed(4));
  const symbols = rows.map((r) => r.symbol);
  // Console summary
  const pct = (x) => (x * 100).toFixed(0).padStart(2);
  console.log(`\nINVESTOR MONITOR · ${market.ist} · market ${market.open ? 'OPEN' : 'closed'} · ${symbols.length} stocks`);
  console.log('stock          last      up/down/side  bias      edge   AI  news   tilt   ±1ATR  events');
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.symbol.padEnd(14)} ERROR ${r.error}`);
      continue;
    }
    console.log(`${r.symbol.padEnd(14)} ${String(r.last?.toFixed(1)).padStart(8)}  ${pct(r.up)}/${pct(r.down)}/${pct(r.side)}      ${r.bias.padEnd(8)}  ${String(r.edge).padEnd(5)}  ${r.aiAdjusted ? 'y' : '-'}  ${r.sentiment == null ? '  n/a' : (r.sentiment > 0 ? '+' : '') + r.sentiment.toFixed(1).padStart(4)}  ${r.tiltPts ? (r.tiltPts > 0 ? '+' : '') + r.tiltPts.toFixed(1) : '  0 '}   ${r.atrPct != null ? r.atrPct.toFixed(2) + '%' : '–'}  ${r.events.join(', ')}`);
  }
  if (vol && !vol.error) console.log(`\nNIFTY volatility: implied (India VIX) ${vol.impliedPct?.toFixed(1)}% vs forecast ${vol.forecastPct?.toFixed(1)}% (ratio ${vol.ratio?.toFixed(2)}) — ${vol.reading}`);
  if (ranking && !ranking.error) console.log(`Ranking (composite, ${ranking.asOf}): top ${ranking.top.map((s) => s.replace('.NS', '')).join(', ')} · bottom ${ranking.bottom.map((s) => s.replace('.NS', '')).join(', ')} (check Stock ranking → Evidence before relying on it)`);
  console.log(`\nScoring: checked ${v.checked}, newly scored ${v.newlyScored}. ${card.verdict || 'No scored predictions yet.'}`);
  if (card.scored) {
    console.log(`  Hit-rate ${card.hitRatePct.toFixed(0)}% · Brier app ${f(card.brier.app)} vs coin-flip ${f(card.brier.uniform)} vs hindsight base rates ${f(card.brier.hindsightBaseRates)}${card.brier.beforeLing != null ? ` · before Ling ${f(card.brier.beforeLing)}` : ''}`);
  }
  if (v.llmValue?.n) console.log(`  Ling adjustment ${v.llmValue.verdict} (n=${v.llmValue.n})`);
  if (v.newsValue?.tilt?.n) console.log(`  News tilt ${v.newsValue.tilt.verdict} (n=${v.newsValue.tilt.n})${v.newsValue.tilt.autoDisabled ? ' — auto-disabled' : ''}`);
  if (report.portfolio?.equity != null) {
    const p = report.portfolio;
    console.log(`\nPaper portfolio: ₹${p.equity.toFixed(0)} (${p.returnPct >= 0 ? '+' : ''}${p.returnPct.toFixed(2)}%), ${p.positions.length} open, charges ₹${p.charges.toFixed(0)}${p.actions.length ? ' · today: ' + p.actions.map((a) => `${a.action} ${a.symbol}`).join(', ') : ' · no trades today'}`);
  } else if (report.portfolio?.error) console.log(`\nPaper portfolio error: ${report.portfolio.error}`);
  if (report.health) console.log(`\nHealth: ${report.health.level.toUpperCase()} — ${report.health.checks.filter((c) => c.level !== 'ok').map((c) => `${c.name}: ${c.detail}`).join(' · ') || 'all checks ok'}`);
  if (report.strategies?.accounts) console.log(`Strategies (forward test since ${String(report.strategies.startedAt).slice(0, 10)}): ${report.strategies.accounts.map((a) => `${a.key} ${a.returnPct >= 0 ? '+' : ''}${a.returnPct.toFixed(2)}%`).join(' · ')}`);
  if (report.events && !report.events.error) console.log(`Events: ${report.events.tracked} tracked${report.events.added.length ? ` · new: ${report.events.added.map((e) => `${e.symbol} ${e.type}`).join(', ')}` : ''}`);
  if (report.alerts?.length) {
    console.log('\nALERTS:');
    for (const a of report.alerts) console.log(`  ${a.level === 'high' ? '!!' : ' •'} ${a.text}`);
  }
  console.log(`\nSaved ${report.files.json} · journal ${report.files.journal}`);
  console.log('Research / paper simulation only. Not investment advice.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  runMonitor({ base: BASE, trade: !args.includes('--no-trade'), notify: args.includes('--notify') })
    .then(printReport)
    .catch((err) => {
      console.error(`Monitor failed: ${err.message}\nIs the dashboard running at ${BASE}? (node server.mjs, with OPENROUTER_API_KEY set)`);
      if (args.includes('--notify')) notify('Trading research monitor failed', err.message);
      process.exit(1);
    });
}
