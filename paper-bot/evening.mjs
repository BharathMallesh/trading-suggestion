#!/usr/bin/env node
// Evening summary (CLI, run by the collect job after every paper record is
// updated): ONE Mac notification covering all four strategies — the YouTube
// intraday versions, the Breakfast strategy, and the strong-stock swing
// strategy's new signals and exits — and the strategy section of this week's
// scorecard refreshed with the day's results.
//
//   node paper-bot/evening.mjs [--notify]

import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { loadPaper, closeSummary } from './vwap-pullback.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadAthPaper, athSwingScan, activeRules, RULES } from './ath-swing.mjs';
import { isTradingDay } from './market-calendar.mjs';
import { loadNiftyDipPaper } from './nifty-dip.mjs';

const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** Lines for one date: [{ title, short, detail }] per strategy. `scan` = today's swing scan (or null). */
export function eveningLines(date, { vwap = loadPaper(), breakfast = loadBreakfastPaper(), swing = loadAthPaper(), scan = null, swingVersion = 'original', dip = loadNiftyDipPaper() } = {}) {
  const out = [];
  const v = (vwap?.trades || []).filter((t) => t.date === date && (t.variant || 'video') === 'video');
  out.push({ title: 'YouTube intraday', short: v.length ? `YouTube ${rs(v.reduce((a, t) => a + t.net, 0))}` : 'YouTube: no trade', detail: closeSummary(vwap, date).join(' · ') });
  const b = (breakfast?.trades || []).filter((t) => t.date === date);
  out.push({ title: 'Breakfast', short: b.length ? `Breakfast ${rs(b.reduce((a, t) => a + t.net, 0))}` : 'Breakfast: no trade', detail: b.length ? b.map((t) => `${t.symbol.replace('.NS', '')} ${t.side} ${t.reason} ${rs(t.net)}`).join(', ') : 'no setup' });
  const exits = (swing?.trades || []).filter((t) => !t.open && t.exitDate === date && (t.version || 'original') === swingVersion);
  const sig = (scan?.triggered || []).filter((x) => !x.held);
  const held = (scan?.triggered || []).filter((x) => x.held);
  const parts = [];
  if (sig.length) parts.push(`${sig.length} new signal${sig.length > 1 ? 's' : ''} (${sig.slice(0, 3).map((x) => x.symbol.replace('.NS', '')).join(', ')})`);
  if (exits.length) parts.push(`exits ${exits.map((t) => `${t.symbol.replace('.NS', '')} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R`).join(', ')}`);
  out.push({ title: 'Strong-stock swing', short: parts.length ? `Swing: ${parts.join(', ')}` : 'Swing: no signals', detail: [...sig.map((x) => `${x.symbol.replace('.NS', '')} ${x.setup} · buy at the next open on paper · stop ₹${x.stop.toFixed(1)}`), ...held.map((x) => `${x.symbol.replace('.NS', '')} ${x.setup} again · already held on paper, no new buy`), ...exits.map((t) => `${t.symbol.replace('.NS', '')} exited (${t.reason}) ${t.r.toFixed(2)} R`)].join(' · ') || 'nothing new' });
  // NIFTY dip-buy: buys / sells today, else where NIFTY stands
  const dt = dip?.trades || [];
  const dBuy = dt.filter((t) => t.entryDate === date);
  const dSell = dt.filter((t) => !t.open && t.exitDate === date);
  const dParts = [...dBuy.map((t) => `bought NIFTY ETF at ${Math.round(t.entry)}`), ...dSell.map((t) => `sold ${t.retPct >= 0 ? '+' : ''}${t.retPct.toFixed(1)}% (${rs(t.net)})`)];
  const ds = dip?.status;
  if (ds?.pendingBuy && ds.date === date) dParts.push('signal: buys at the next open');
  out.push({ title: 'NIFTY dip-buy', short: dParts.length ? `Dip-buy: ${dParts.join(', ')}` : 'Dip-buy: no signal', detail: dParts.length ? dParts.join(' · ') : ds?.message || 'no signal' });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const t = new Date(Date.now() + 19800_000);
    const date = t.toISOString().slice(0, 10);
    const afterClose = isTradingDay(date) && t.getUTCHours() * 60 + t.getUTCMinutes() >= 15 * 60 + 35;
    let scan = null;
    if (afterClose) {
      try {
        scan = await athSwingScan({});
      } catch (err) {
        console.log(`Swing scan failed: ${err.message}`);
      }
    }
    const lines = eveningLines(date, { scan, swingVersion: activeRules() !== RULES ? 'improved' : 'original' });
    for (const l of lines) console.log(`${l.title}: ${l.detail}`);
    if (process.argv.includes('--notify') && afterClose) {
      const msg = lines.map((l) => l.short).join(' · ');
      execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', `Strategies · ${date}`, msg.slice(0, 220)], () => {});
    }
    try {
      const { refreshWeeklyStrategy } = await import('./weekly.mjs');
      if (refreshWeeklyStrategy(loadPaper())) console.log('Weekly scorecard: strategy section updated.');
    } catch (err) {
      console.log(`Weekly scorecard not updated: ${err.message}`);
    }
  })().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
