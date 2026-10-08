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
// Writes paper-bot/monitor/<date>-<time>.json and appends to journal.md.
//
//   node paper-bot/monitor.mjs                 # default http://127.0.0.1:3000
//   MONITOR_URL=http://127.0.0.1:3001 node paper-bot/monitor.mjs
//   node paper-bot/monitor.mjs --no-trade      # skip the paper portfolio step
//
// Research / paper simulation only. Not investment advice.

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dedupeDaily } from './prediction-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MONITOR_DIR || join(HERE, 'monitor');
const BASE = process.env.MONITOR_URL || 'http://127.0.0.1:3000';
const args = process.argv.slice(2);
const trade = !args.includes('--no-trade');

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

/** NSE session status in IST, independent of this machine's timezone. */
export function marketStatus(now = new Date()) {
  const ist = new Date(now.getTime() + 19800_000);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  return { open, ist: ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST', weekday: day >= 1 && day <= 5 };
}

const KEYS = { UP: 'probUp', DOWN: 'probDown', SIDEWAYS: 'probSideways' };
const brier = (p, l) => ['UP', 'DOWN', 'SIDEWAYS'].reduce((a, k) => a + ((Number(p?.[KEYS[k]]) || 0) - (k === l ? 1 : 0)) ** 2, 0);

/** Scorecard over every scored prediction in the log. */
export function scorecard(entries) {
  // One prediction per stock per day (see prediction-log dedupeDaily).
  const ev = dedupeDaily(entries.filter((e) => e.evaluated && e.realizedLabel));
  if (!ev.length) return { scored: 0 };
  const avg = (f) => ev.reduce((a, e) => a + f(e), 0) / ev.length;
  const freq = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  for (const e of ev) freq[e.realizedLabel]++;
  const base = { probUp: freq.UP / ev.length, probDown: freq.DOWN / ev.length, probSideways: freq.SIDEWAYS / ev.length };
  const out = {
    scored: ev.length,
    outcomes: freq,
    hitRatePct: (ev.filter((e) => e.hitBias).length / ev.length) * 100,
    brier: {
      app: avg((e) => brier(e, e.realizedLabel)),
      beforeLing: ev.every((e) => e.base) ? avg((e) => brier(e.base, e.realizedLabel)) : null,
      uniform: avg((e) => brier({ probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 }, e.realizedLabel)),
      // hindsight base rates of the scored set — a tough, slightly unfair benchmark
      hindsightBaseRates: avg((e) => brier(base, e.realizedLabel)),
    },
  };
  out.verdict =
    out.scored < 30
      ? `Too early: ${out.scored} scored predictions (need ~30+ before reading much into it).`
      : out.brier.app < out.brier.uniform
        ? out.brier.app < out.brier.hindsightBaseRates
          ? 'App beats both a coin-flip and hindsight base rates — promising, keep watching.'
          : 'App beats a coin-flip but not hindsight base rates — honest, no clear edge.'
        : 'App is worse than a coin-flip — probabilities are not helping.';
  return out;
}

async function main() {
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
        return {
          symbol: d.symbol, last: d.lastClose, up: p.probUp, down: p.probDown, side: p.probSideways, bias: p.bias,
          edge: d.edge?.level, aiAdjusted: p.adjustmentNote !== 'No LLM adjustment applied',
          sentiment: d.news?.sentiment ?? null, tiltPts: d.newsTilt?.applied ? d.newsTilt.shiftPts : 0,
          events: d.news?.events || [], atrPct: d.expectedMove?.upside?.typicalPct ?? null, headline: d.news?.headlines?.[0]?.title || null,
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
    vol = { impliedPct: v.impliedPct, forecastPct: v.forecastPct, ratio: v.ratio, reading: v.reading };
  } catch (err) {
    vol = { error: err.message };
  }
  try {
    const r = await api('/api/rankings');
    ranking = { asOf: r.asOf, top: r.ranking.slice(0, 5).map((x) => x.symbol), bottom: r.ranking.slice(-5).map((x) => x.symbol) };
  } catch (err) {
    ranking = { error: err.message };
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
    portfolio: pf && !pf.error
      ? { equity: pf.equity, returnPct: pf.returnPct, cash: pf.cash, charges: pf.totalCharges, positions: pf.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, entry: p.entryPrice, last: p.mark, pnl: p.unrealized })), actions: pf.actions.filter((a) => ['buy', 'close'].includes(a.action)) }
      : pf,
    disclaimer: 'Research / paper simulation only. Not investment advice.',
  };

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
  if (ranking && !ranking.error) console.log(`Ranking (composite, ${ranking.asOf}): top ${ranking.top.map((s) => s.replace('.NS', '')).join(', ')} · bottom ${ranking.bottom.map((s) => s.replace('.NS', '')).join(', ')} (no historical evidence yet — see Stock ranking → Evidence)`);
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
  console.log(`\nSaved ${join(OUT, stamp + '.json')} · journal ${journal}`);
  console.log('Research / paper simulation only. Not investment advice.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Monitor failed: ${err.message}\nIs the dashboard running at ${BASE}? (node server.mjs, with OPENROUTER_API_KEY set)`);
    process.exit(1);
  });
}
