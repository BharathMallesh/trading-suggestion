#!/usr/bin/env node
// Experimental paper-trading signal runner
//
// Usage:
//   node paper-bot/run.mjs                          # hybrid daily scan
//   node paper-bot/run.mjs --tech-only              # pure technical (no key)
//   node paper-bot/run.mjs --interval 15m           # intraday 15-min
//   node paper-bot/run.mjs --backtest               # sequential backtest
//   node paper-bot/run.mjs --backtest --tech-only
//   node paper-bot/run.mjs RELIANCE.NS HDFCBANK.NS  # specific symbols

import { candles } from '../market-data.mjs';
import { PAPER } from './config.mjs';
import { generateSignal } from './signal.mjs';
import { PaperEngine } from './paper-engine.mjs';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const doBacktest = args.includes('--backtest');
const techOnly = args.includes('--tech-only');

// Optional --interval 15m|5m|1h|1d
let intervalFlag = '1d';
const intervalIdx = args.indexOf('--interval');
if (intervalIdx !== -1 && args[intervalIdx + 1]) {
  intervalFlag = args[intervalIdx + 1];
}

const symbols = args.filter((a) => !a.startsWith('--') && a !== intervalFlag);
const targetSymbols = symbols.length ? symbols : PAPER.symbols;

// Resolve data settings from interval
function resolveDataSettings() {
  if (intervalFlag === '1d') {
    return {
      range: PAPER.candleRange,
      interval: '1d',
      lookbackBars: PAPER.lookbackBars,
      label: 'daily',
    };
  }
  const preset = PAPER.intraday[intervalFlag];
  if (!preset) {
    console.error(`Unsupported interval "${intervalFlag}". Use 1d, 15m, 5m, or 1h.`);
    process.exit(1);
  }
  return {
    range: preset.range,
    interval: preset.interval,
    lookbackBars: preset.lookbackBars,
    label: intervalFlag,
  };
}

const dataSettings = resolveDataSettings();

function printBanner() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  PAPER-BOT  ·  Experimental hybrid signal + paper trading  ║');
  console.log('║  RESEARCH / EDUCATION ONLY — not investment advice         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Mode     : ${techOnly ? 'TECH-ONLY' : 'HYBRID'}`);
  console.log(`Interval : ${dataSettings.label}`);
  console.log(`Symbols  : ${targetSymbols.length}`);
  console.log();
}

function printSignal(s) {
  const icon = s.signal === 'LONG' ? '🟢' : s.signal === 'SHORT' ? '🔴' : '⚪';
  console.log(`${icon}  ${s.symbol.padEnd(14)}  ${s.signal.padEnd(6)}  conf=${(s.confidence * 100).toFixed(0)}%`);
  console.log(`    Tech bias : ${s.techBias}`);
  console.log(`    Reasoning : ${s.reasoning}`);
  if (s.indicators) {
    const i = s.indicators;
    console.log(`    Close ${i.close?.toFixed(2)}  RSI ${i.rsi14?.toFixed(1)}  SMA20 ${i.sma20?.toFixed(2)}  SMA50 ${i.sma50?.toFixed(2)}  ATR ${i.atr14?.toFixed(2)}`);
  }
  console.log();
}

async function fetchCandles(sym) {
  return candles(sym, {
    range: dataSettings.range,
    interval: dataSettings.interval,
  });
}

async function scanOnce() {
  printBanner();
  console.log(`Scanning ${targetSymbols.length} symbol(s)…\n`);

  const results = [];

  for (const sym of targetSymbols) {
    process.stdout.write(`  Fetching ${sym}… `);
    try {
      const data = await fetchCandles(sym);
      console.log(`${data.length} bars`);
      const signal = await generateSignal(sym, data, {
        techOnly,
        lookbackBars: dataSettings.lookbackBars,
      });
      results.push(signal);
      printSignal(signal);
    } catch (err) {
      console.log('ERROR');
      console.error(`    ${err.message}\n`);
    }
  }

  // Paper snapshot — supports both LONG and SHORT
  console.log('── Paper account snapshot (if we acted on these signals) ──');
  const engine = new PaperEngine();
  const marks = {};

  for (const s of results) {
    if (s.confidence < PAPER.minConfidence) continue;
    const px = s.indicators?.close;
    if (!px) continue;

    if (s.signal === 'LONG') {
      const res = engine.openLong(s.symbol, px, s.date, s.indicators?.atr14);
      if (res.ok) {
        console.log(`  Opened LONG  ${s.symbol}  qty=${res.qty}  @ ${px.toFixed(2)}  stop=${res.stop?.toFixed(2) ?? '–'}  tgt=${res.target?.toFixed(2) ?? '–'}`);
        marks[s.symbol] = px;
      } else {
        console.log(`  Skipped LONG  ${s.symbol}: ${res.reason}`);
      }
    } else if (s.signal === 'SHORT') {
      const res = engine.openShort(s.symbol, px, s.date, s.indicators?.atr14);
      if (res.ok) {
        console.log(`  Opened SHORT ${s.symbol}  qty=${res.qty}  @ ${px.toFixed(2)}  stop=${res.stop?.toFixed(2) ?? '–'}  tgt=${res.target?.toFixed(2) ?? '–'}`);
        marks[s.symbol] = px;
      } else {
        console.log(`  Skipped SHORT ${s.symbol}: ${res.reason}`);
      }
    }
  }

  const summary = engine.summary();
  console.log();
  console.log(`  Starting capital : ₹${summary.startingCapital.toLocaleString('en-IN')}`);
  console.log(`  Current equity   : ₹${summary.finalEquity.toFixed(0)}`);
  console.log(`  Open positions   : ${summary.openPositions}`);
  console.log(`  Cash remaining   : ₹${summary.cash.toFixed(0)}`);
  console.log();
  console.log('⚠️  One-shot snapshot only. Use --backtest for full simulation.');
  console.log();
  console.log('DISCLAIMER: Experimental research tool only. Not investment advice.');
}

/**
 * Improved sequential backtest:
 * - Fill at next bar's OPEN (more realistic than close)
 * - Stops/targets checked on high/low of each bar
 * - Supports LONG + SHORT
 */
async function runBacktest() {
  printBanner();
  console.log('Starting sequential paper backtest…\n');
  console.log('Improvements vs earlier version:');
  console.log('  • Fills at next bar OPEN (instead of close)');
  console.log('  • Full LONG + SHORT support');
  console.log('  • Stops / targets on high-low');
  console.log('  • Exit reason + side breakdown\n');

  const engine = new PaperEngine();
  const history = {};

  for (const sym of targetSymbols) {
    process.stdout.write(`  Loading ${sym}… `);
    try {
      const data = await fetchCandles(sym);
      history[sym] = data;
      console.log(`${data.length} bars`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  const available = Object.keys(history);
  if (!available.length) {
    console.error('No data loaded.');
    process.exit(1);
  }

  const minLen = Math.min(...available.map((s) => history[s].length));
  const startIdx = Math.max(55, dataSettings.lookbackBars);

  if (minLen <= startIdx + 2) {
    console.error('Not enough bars for backtest with current interval/lookback.');
    process.exit(1);
  }

  console.log(`\nWalking forward bars ${startIdx} → ${minLen - 2} (${available.length} symbols)…\n`);

  for (let i = startIdx; i < minLen - 1; i++) {
    const barDate = history[available[0]][i].date;
    const marks = {};
    engine.tickBar(); // min-hold age + loss cooldown

    for (const sym of available) {
      const bars = history[sym];
      const bar = bars[i];
      const nextBar = bars[i + 1];
      marks[sym] = nextBar.open;

      // 1. Check stops / targets on current bar's high/low (always allowed)
      const stopped = engine.checkStopsAndTargets(sym, bar);
      for (const t of stopped) {
        const sign = t.pnl >= 0 ? '+' : '';
        console.log(`${bar.date}  ${t.reason.padEnd(12)} ${t.side.padEnd(5)} ${sym.padEnd(14)} PnL ${sign}₹${t.pnl.toFixed(0)} (${sign}${t.pnlPct.toFixed(1)}%)`);
      }

      // 2. Generate signal on data up to current bar
      const slice = bars.slice(0, i + 1);
      const signal = await generateSignal(sym, slice, {
        techOnly,
        lookbackBars: dataSettings.lookbackBars,
      });

      const hasPos = engine.positions.has(sym);
      const fillPrice = nextBar.open;

      if (!hasPos && signal.confidence >= PAPER.minConfidence) {
        if (signal.signal === 'LONG') {
          const res = engine.openLong(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
          if (res.ok) {
            console.log(`${nextBar.date}  LONG         ${sym.padEnd(14)} qty=${res.qty} @ ${fillPrice.toFixed(2)}  stop=${res.stop?.toFixed(1) ?? '–'} tgt=${res.target?.toFixed(1) ?? '–'}`);
          }
        } else if (signal.signal === 'SHORT') {
          const res = engine.openShort(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
          if (res.ok) {
            console.log(`${nextBar.date}  SHORT        ${sym.padEnd(14)} qty=${res.qty} @ ${fillPrice.toFixed(2)}  stop=${res.stop?.toFixed(1) ?? '–'} tgt=${res.target?.toFixed(1) ?? '–'}`);
          }
        }
      } else if (hasPos && engine.canSignalExit(sym)) {
        const pos = engine.positions.get(sym);
        const shouldExit =
          signal.signal === 'FLAT' ||
          (pos.side === 'LONG' && signal.signal === 'SHORT') ||
          (pos.side === 'SHORT' && signal.signal === 'LONG');

        if (shouldExit) {
          const res = engine.closePosition(sym, fillPrice, nextBar.date, 'signal');
          if (res.ok) {
            const t = res.trade;
            const sign = t.pnl >= 0 ? '+' : '';
            console.log(`${nextBar.date}  CLOSE        ${t.side.padEnd(5)} ${sym.padEnd(14)} PnL ${sign}₹${t.pnl.toFixed(0)} (${sign}${t.pnlPct.toFixed(1)}%)`);
          }
        }
      }
    }

    engine.mark(barDate, marks);

    if (i % 20 === 0) {
      process.stdout.write(`  … ${barDate}  equity ₹${engine.equity(marks).toFixed(0)}  trades=${engine.closedTrades.length}\r`);
    }
  }

  // Close remaining
  const lastMarks = {};
  for (const sym of available) {
    const last = history[sym][history[sym].length - 1];
    lastMarks[sym] = last.close;
    if (engine.positions.has(sym)) {
      const res = engine.closePosition(sym, last.close, last.date, 'end-of-test');
      if (res.ok) {
        const t = res.trade;
        const sign = t.pnl >= 0 ? '+' : '';
        console.log(`${last.date}  END          ${t.side.padEnd(5)} ${sym.padEnd(14)} PnL ${sign}₹${t.pnl.toFixed(0)}`);
      }
    }
  }
  engine.mark('end', lastMarks);

  const s = engine.summary();

  console.log('\n\n══════════════ PAPER BACKTEST RESULTS ══════════════');
  console.log(`Mode              : ${techOnly ? 'TECH-ONLY' : 'HYBRID'}`);
  console.log(`Interval          : ${dataSettings.label}`);
  console.log(`Symbols           : ${available.length}`);
  console.log(`Starting capital  : ₹${s.startingCapital.toLocaleString('en-IN')}`);
  console.log(`Final equity      : ₹${s.finalEquity.toFixed(0)}`);
  console.log(`Total return      : ${s.totalReturnPct >= 0 ? '+' : ''}${s.totalReturnPct.toFixed(1)}%`);
  console.log(`Closed trades     : ${s.closedTrades}`);
  console.log(`  LONG / SHORT    : ${s.sideBreakdown.LONG || 0} / ${s.sideBreakdown.SHORT || 0}`);
  console.log(`Win rate          : ${s.winRatePct.toFixed(1)}%`);
  console.log(`Profit factor     : ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`);
  console.log(`Max drawdown      : ${s.maxDrawdownPct.toFixed(1)}%`);
  if (Object.keys(s.exitReasons).length) {
    console.log(`Exit reasons      : ${JSON.stringify(s.exitReasons)}`);
  }
  console.log('════════════════════════════════════════════════════');
  console.log();

  try {
    const outPath = 'paper-bot/last-backtest.json';
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: techOnly ? 'tech-only' : 'hybrid',
      interval: dataSettings.label,
      symbols: available,
      summary: {
        startingCapital: s.startingCapital,
        finalEquity: s.finalEquity,
        totalReturnPct: s.totalReturnPct,
        closedTrades: s.closedTrades,
        sideBreakdown: s.sideBreakdown,
        winRatePct: s.winRatePct,
        profitFactor: s.profitFactor,
        maxDrawdownPct: s.maxDrawdownPct,
        exitReasons: s.exitReasons,
      },
      trades: s.trades,
    }, null, 2));
    console.log(`Results saved to ${outPath}`);
  } catch (_) {}

  console.log();
  console.log('DISCLAIMER: Experimental research simulation only. Not investment advice.');
  console.log('Results are not indicative of future performance. Costs are approximate.');
}

// Main
if (doBacktest) {
  runBacktest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  scanOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
