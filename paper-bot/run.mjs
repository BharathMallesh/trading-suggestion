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
import { runBacktest as walkForward } from './backtest.mjs';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * Sequential backtest via the shared walk-forward engine (backtest.mjs):
 * - Fills at next bar's OPEN; stops/targets on high/low (gap-aware)
 * - LONG + SHORT; symbols aligned by date
 */
async function runBacktest() {
  printBanner();
  console.log('Starting sequential paper backtest…\n');

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
  if (!Object.keys(history).length) {
    console.error('No data loaded.');
    process.exit(1);
  }

  const pnlStr = (t) => `${t.pnl >= 0 ? '+' : ''}₹${t.pnl.toFixed(0)} (${t.pnl >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%)`;
  let result;
  try {
    result = await walkForward(history, {
      techOnly,
      lookbackBars: dataSettings.lookbackBars,
      onEvent(e) {
        if (e.type === 'stop') console.log(`${e.date}  ${e.trade.reason.padEnd(12)} ${e.trade.side.padEnd(5)} ${e.trade.symbol.padEnd(14)} PnL ${pnlStr(e.trade)}`);
        else if (e.type === 'open') console.log(`${e.date}  ${e.side.padEnd(12)} ${e.symbol.padEnd(14)} qty=${e.qty} @ ${e.price.toFixed(2)}  stop=${e.stop?.toFixed(1) ?? '–'} tgt=${e.target?.toFixed(1) ?? '–'}`);
        else if (e.type === 'close') console.log(`${e.date}  CLOSE        ${e.trade.side.padEnd(5)} ${e.trade.symbol.padEnd(14)} PnL ${pnlStr(e.trade)}`);
        else if (e.type === 'end') console.log(`${e.date}  END          ${e.trade.side.padEnd(5)} ${e.trade.symbol.padEnd(14)} PnL ${pnlStr(e.trade)}`);
        else if (e.type === 'bar' && e.index % 20 === 0) process.stdout.write(`  … ${e.date}  equity ₹${e.equity.toFixed(0)}  trades=${e.trades}\r`);
      },
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const s = result.summary;
  console.log('\n\n══════════════ PAPER BACKTEST RESULTS ══════════════');
  console.log(`Mode              : ${techOnly ? 'TECH-ONLY' : 'HYBRID'}`);
  console.log(`Interval          : ${dataSettings.label}`);
  console.log(`Symbols           : ${result.symbols.length}`);
  console.log(`Period            : ${result.startDate} → ${result.endDate} (${result.bars} shared bars)`);
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

  // Saved next to this script, whatever directory the command was run from.
  const outPath = join(HERE, 'last-backtest.json');
  try {
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: techOnly ? 'tech-only' : 'hybrid',
      interval: dataSettings.label,
      symbols: result.symbols,
      summary: {
        startingCapital: s.startingCapital,
        finalEquity: s.finalEquity,
        totalReturnPct: s.totalReturnPct,
        closedTrades: s.closedTrades,
        sideBreakdown: s.sideBreakdown,
        winRatePct: s.winRatePct,
        profitFactor: s.profitFactor === Infinity ? 'Infinity' : s.profitFactor,
        maxDrawdownPct: s.maxDrawdownPct,
        exitReasons: s.exitReasons,
      },
      trades: s.trades,
    }, null, 2));
    console.log(`Results saved to ${outPath}`);
  } catch (err) {
    console.error(`Could not save results to ${outPath}: ${err.message}`);
  }

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
