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
import { loadNiftyDipPaper, ofVersion } from './nifty-dip.mjs';
import { loadFoStranglePaper } from './fo-strangle.mjs';
import { loadMomentumPaper } from './momentum.mjs';
import { loadRsiSwingPaper } from './rsi-swing.mjs';
import { monthLines } from './this-month.mjs';
import { loadMomentum10Paper } from './momentum10.mjs';
import { loadSteadyMixPaper } from './steady-mix.mjs';
import { loadImbalancePaper } from './imbalance-swing.mjs';
import { saveSwingScan, tradePlan } from './trade-plan.mjs';

const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** Lines for one date: [{ title, short, detail }] per strategy. `scan` = today's swing scan (or null). */
export function eveningLines(date, { vwap = loadPaper(), breakfast = loadBreakfastPaper(), swing = loadAthPaper(), scan = null, swingVersion = 'original', dip = loadNiftyDipPaper(), fo = loadFoStranglePaper(), mom = loadMomentumPaper(), rsi = loadRsiSwingPaper(), m10 = loadMomentum10Paper(), steady = loadSteadyMixPaper(), imb = loadImbalancePaper() } = {}) {
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
  // NIFTY dip-buy: buys / sells today (standard version, plus the deep-dip version when it acts), else where NIFTY stands
  const dipParts = (trades, status) => {
    const p = [...trades.filter((t) => t.entryDate === date).map((t) => `bought NIFTY ETF at ${Math.round(t.entry)}`), ...trades.filter((t) => !t.open && t.exitDate === date).map((t) => `sold ${t.retPct >= 0 ? '+' : ''}${t.retPct.toFixed(1)}% (${rs(t.net)})`)];
    if (status?.pendingBuy && status.date === date) p.push('signal: buys at the next open');
    return p;
  };
  const ds = dip?.status;
  const dParts = dipParts(ofVersion(dip?.trades, 'standard'), ds);
  const deepParts = dipParts(ofVersion(dip?.trades, 'deep'), dip?.statuses?.deep);
  if (deepParts.length) dParts.push(`deep dip (−5% in 10 days) ${deepParts.join(', ')}`);
  out.push({ title: 'NIFTY dip-buy', short: dParts.length ? `Dip-buy: ${dParts.join(', ')}` : 'Dip-buy: no signal', detail: dParts.length ? dParts.join(' · ') : ds?.message || 'no signal' });
  // NIFTY short strangle (F&O): weeks settled today, else the open position (data lags a day)
  const foDone = (fo?.trades || []).filter((t) => !t.open && t.expiry === date);
  const foOpen = (fo?.trades || []).find((t) => t.open);
  if (fo) out.push({ title: 'NIFTY short strangle', short: foDone.length ? `Strangle: week ${rs(foDone.reduce((a, t) => a + t.rupees, 0))}` : foOpen ? 'Strangle: holding' : 'Strangle: no position', detail: foDone.length ? foDone.map((t) => `settled ${t.putStrike}/${t.callStrike}: ${rs(t.rupees)} a lot${t.breached ? ` (${t.breached} side breached)` : ''}`).join(' · ') : fo.status?.message || 'no position' });
  const m = momentumLine(date, mom);
  if (m) out.push(m);
  // Momentum 10 and the Steady mix: month-end, change day, and a market-filter cross
  out.push(...monthLines(date, { m10, steady }));
  // Imbalance swing (paper): today's signals, buys and exits
  if (imb) {
    const sig = imb.scan?.date === date ? imb.scan.triggered : [];
    const b = (imb.trades || []).filter((t) => t.entryDate === date);
    const s = (imb.trades || []).filter((t) => !t.open && t.exitDate === date);
    if (sig.length || b.length || s.length) out.push({ title: 'Imbalance swing', short: `Imbalance swing: ${sig.length} signal${sig.length === 1 ? '' : 's'}, ${b.length} bought, ${s.length} sold`, detail: [...sig.map((x) => `signal ${x.symbol} (stop ₹${x.stop.toFixed(1)}, buy at the next open)`), ...b.map((t) => `bought ${t.symbol} at ₹${t.entry.toFixed(1)}`), ...s.map((t) => `sold ${t.symbol} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)} R (${t.reason})`)].join(' · ') });
  }
  // RSI swing (paper): buys and sells today, or entry signals at the latest hour
  if (rsi?.trades) {
    const b = rsi.trades.filter((t) => t.entryDate === date);
    const s = rsi.trades.filter((t) => !t.open && t.exitDate === date);
    const sig = rsi.scan?.triggered || [];
    if (b.length || s.length || sig.length) {
      out.push({ title: 'RSI swing', short: `RSI swing: ${b.length} bought, ${s.length} sold`, detail: [...b.map((t) => `bought ${t.symbol.replace('.NS', '')} at ₹${t.entry.toFixed(1)} (stop ₹${t.stop.toFixed(1)})`), ...s.map((t) => `sold ${t.symbol.replace('.NS', '')} ${t.reason} ${(t.retPct * 100).toFixed(2)}%`), ...sig.map((x) => `signal ${x.symbol.replace('.NS', '')}`)].join(' · ') + ' (paper; the strategy failed its test)' });
    }
  }
  return out;
}

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Next trading day after `date`. */
function nextTradingDay(date) {
  let d = addDays(date, 1);
  for (let k = 0; k < 12 && !isTradingDay(d); k++) d = addDays(d, 1);
  return d;
}
/** Names in `b` not in `a`, as short tickers. */
const added = (a, b) => b.filter((x) => !a.includes(x)).map((x) => x.replace('.NS', ''));

/**
 * Momentum 20 in the evening note — only on the two days that matter:
 *   last trading day of the month: the new list is made from today's close (preview of the changes)
 *   first trading day of the month: the new list, bought at today's open on paper (what came in / went out)
 */
export function momentumLine(date, mom) {
  if (!mom) return null;
  const rebal = (mom.rebalances || []).filter((r) => r.date === date).pop();
  if (rebal) {
    const prev = (mom.rebalances || []).filter((r) => r.date < date).pop();
    const now = rebal.holdings.map((h) => h.symbol);
    const before = prev ? prev.holdings.map((h) => h.symbol) : [];
    const inn = added(before, now);
    const out = added(now, before);
    const each = Math.round((rebal.value || mom.capital) / now.length);
    return {
      title: 'Momentum 20',
      short: prev ? `Momentum 20: new list, ${inn.length} in / ${out.length} out` : 'Momentum 20: first list bought',
      detail: `New list (ranked at the ${rebal.monthEnd} close), bought on paper at today's open, about ₹${each.toLocaleString('en-IN')} each: ${prev ? `in ${inn.join(', ') || 'none'} · out ${out.join(', ') || 'none'} · kept ${now.length - inn.length}` : now.map((x) => x.replace('.NS', '')).join(', ')}.`,
    };
  }
  const isMonthEnd = isTradingDay(date) && nextTradingDay(date).slice(0, 7) !== date.slice(0, 7);
  if (isMonthEnd && mom.preview?.list?.length) {
    const cur = (mom.rebalances?.at(-1)?.holdings || []).map((h) => h.symbol);
    const base = cur.length ? cur : (mom.list || []).map((x) => x.symbol);
    const next = mom.preview.list.map((x) => x.symbol);
    const inn = added(base, next);
    const out = added(next, base);
    return {
      title: 'Momentum 20',
      short: `Momentum 20: month ends today, new list tomorrow (≈${inn.length} changes)`,
      detail: `The month ends today: the new list is made from today's close and bought at the next open (${nextTradingDay(date)}). Preview from the ${mom.preview.date} prices — likely in: ${inn.join(', ') || 'none'} · likely out: ${out.join(', ') || 'none'}. The final list is shown on the Investing tab.`,
    };
  }
  return null;
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
        saveSwingScan(scan); // for the swing trade plan card
      } catch (err) {
        console.log(`Swing scan failed: ${err.message}`);
      }
    }
    const lines = eveningLines(date, { scan, swingVersion: activeRules() !== RULES ? 'improved' : 'original' });
    // the swing trade plan for tomorrow (wide trail): buys, sells and stops to update
    if (scan) {
      const p = tradePlan({ scan });
      if (p.counts.buy || p.counts.sell || p.hold.some((h) => h.stopRaised)) lines.push({ title: 'Swing plan', short: `Swing plan: buy ${p.counts.buy}, sell ${p.counts.sell}, hold ${p.counts.hold}`, detail: [...p.buy.filter((b) => b.action === 'buy').map((b) => `BUY ${b.symbol} at the open (stop ₹${b.stop.toFixed(1)})`), ...p.hold.filter((h) => h.action === 'sell').map((h) => `SELL ${h.symbol} at the open (closed below ₹${h.stop.toFixed(1)})`), ...p.hold.filter((h) => h.action === 'hold').map((h) => `${h.symbol} stop ₹${h.stop.toFixed(1)}`)].join(' · ') });
    }
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
