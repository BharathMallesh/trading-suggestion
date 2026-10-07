// Factual candle DESCRIBER (library + CLI). Turns real OHLC candles into a
// plain description of WHAT THE DATA SHOWS — the trend over the window, up/down
// days, where price sits in its range, how volume compares, and the shape of
// the latest candle.
//
// SCOPE: description, never prediction. The computed stats are deterministic.
// The optional Ling narration is guardrailed (see research.mjs) to report only
// what the numbers say — it will NOT forecast direction or give buy/sell/hold.
// "Here's what happened", never "here's what will happen".
import { pathToFileURL } from 'node:url';
import { candles } from './market-data.mjs';
import { chat } from './ling-client.mjs';
import { RESEARCH_SYSTEM } from './research.mjs';

/**
 * Deterministic descriptive stats over a series of candles (oldest first).
 * Pure function — same candles in, same stats out. No forecasting.
 * @param {{date:string,open:number,high:number,low:number,close:number,volume:(number|null)}[]} rows
 */
export function computeStats(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No candles to describe.');
  const n = rows.length;
  const first = rows[0];
  const last = rows[n - 1];

  const change = last.close - first.close;
  const pctChange = first.close ? (change / first.close) * 100 : 0;

  let up = 0, down = 0, flat = 0;
  for (const r of rows) {
    if (r.close > r.open) up++;
    else if (r.close < r.open) down++;
    else flat++;
  }

  let hi = rows[0], lo = rows[0];
  for (const r of rows) {
    if (r.high > hi.high) hi = r;
    if (r.low < lo.low) lo = r;
  }
  // Where the latest close sits between the window's low and high (0=low,100=high).
  const rangePosPct = hi.high > lo.low ? ((last.close - lo.low) / (hi.high - lo.low)) * 100 : 100;

  const vols = rows.map((r) => r.volume).filter((v) => v != null);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const lastVol = last.volume ?? null;
  const lastVolVsAvgPct = avgVol && lastVol != null ? ((lastVol - avgVol) / avgVol) * 100 : null;

  // Close-to-close streak ending on the last candle.
  let streak = 0, streakDir = 0;
  for (let i = n - 1; i > 0; i--) {
    const d = Math.sign(rows[i].close - rows[i - 1].close);
    if (d === 0) break;
    if (streakDir === 0) { streakDir = d; streak = 1; }
    else if (d === streakDir) streak++;
    else break;
  }

  // Biggest single-day close-to-close moves within the window.
  let bigUp = null, bigDown = null;
  for (let i = 1; i < n; i++) {
    const pct = ((rows[i].close - rows[i - 1].close) / rows[i - 1].close) * 100;
    if (bigUp === null || pct > bigUp.pct) bigUp = { date: rows[i].date, pct };
    if (bigDown === null || pct < bigDown.pct) bigDown = { date: rows[i].date, pct };
  }

  const round = (x) => (x == null ? null : +x.toFixed(2));
  return {
    from: first.date,
    to: last.date,
    days: n,
    firstClose: first.close,
    lastClose: last.close,
    change: round(change),
    pctChange: round(pctChange),
    upDays: up,
    downDays: down,
    flatDays: flat,
    highestHigh: { value: hi.high, date: hi.date },
    lowestLow: { value: lo.low, date: lo.date },
    rangePositionPct: round(rangePosPct),
    avgVolume: avgVol == null ? null : Math.round(avgVol),
    lastVolume: lastVol,
    lastVolVsAvgPct: round(lastVolVsAvgPct),
    streak: { direction: streakDir > 0 ? 'up' : streakDir < 0 ? 'down' : 'none', days: streak },
    biggestUpDay: bigUp && { date: bigUp.date, pct: round(bigUp.pct) },
    biggestDownDay: bigDown && { date: bigDown.date, pct: round(bigDown.pct) },
  };
}

/**
 * Describe the shape of a single candle as proportions of its range — purely
 * geometric, no pattern-name verdicts implied.
 */
export function candleShape(r) {
  const range = r.high - r.low;
  const body = Math.abs(r.close - r.open);
  const upper = r.high - Math.max(r.open, r.close);
  const lower = Math.min(r.open, r.close) - r.low;
  const pct = (x) => (range > 0 ? +((x / range) * 100).toFixed(1) : 0);
  return {
    date: r.date,
    direction: r.close > r.open ? 'up' : r.close < r.open ? 'down' : 'flat',
    bodyPct: pct(body),
    upperWickPct: pct(upper),
    lowerWickPct: pct(lower),
  };
}

/** Render the deterministic facts as readable lines (used by CLI and narration). */
export function formatStats(symbol, stats, shape) {
  const dir = stats.change >= 0 ? '+' : '';
  return [
    `${symbol}: ${stats.from} → ${stats.to} (${stats.days} candles)`,
    `Change over window: ${dir}${stats.change} (${dir}${stats.pctChange}%), close ${stats.firstClose} → ${stats.lastClose}`,
    `Up candles ${stats.upDays} / down candles ${stats.downDays} / flat ${stats.flatDays}`,
    `Window high ${stats.highestHigh.value} (${stats.highestHigh.date}), low ${stats.lowestLow.value} (${stats.lowestLow.date})`,
    `Latest close sits ${stats.rangePositionPct}% up the window's range`,
    stats.streak.days > 1 ? `Current streak: ${stats.streak.days} ${stats.streak.direction} closes in a row` : 'No streak into the last candle',
    stats.lastVolVsAvgPct != null ? `Last volume ${stats.lastVolVsAvgPct >= 0 ? '+' : ''}${stats.lastVolVsAvgPct}% vs window average` : 'Volume unavailable',
    stats.biggestUpDay ? `Biggest up move ${stats.biggestUpDay.pct}% (${stats.biggestUpDay.date}); biggest down move ${stats.biggestDownDay.pct}% (${stats.biggestDownDay.date})` : '',
    `Latest candle: ${shape.direction}, body ${shape.bodyPct}% of range, upper wick ${shape.upperWickPct}%, lower wick ${shape.lowerWickPct}%`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Fetch candles for a symbol, compute the factual stats, and (optionally) have
 * Ling narrate them in plain English — description only, no forecast.
 * @param {string} symbol
 * @param {{ range?: string, interval?: string, narrate?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{symbol:string, stats:object, latestCandle:object, facts:string, narrative?:string}>}
 */
export async function describeCandles(symbol, opts = {}) {
  const rows = await candles(symbol, {
    range: opts.range || '3mo',
    interval: opts.interval || '1d',
    signal: opts.signal,
  });
  const stats = computeStats(rows);
  const shape = candleShape(rows[rows.length - 1]);
  const facts = formatStats(symbol, stats, shape);
  const out = { symbol, stats, latestCandle: shape, facts };

  if (opts.narrate) {
    const instruction = [
      `Describe, in plain English, what the following price data shows for ${symbol}.`,
      "Cover the trend over the window, notable moves, where price sits in its range, and how recent volume compares.",
      'Report ONLY what these numbers say. Do NOT predict direction or say whether it will go up or down.',
      'Do NOT give any buy/sell/hold or suggestion. Just narrate the data factually.',
      '',
      'DATA:',
      facts,
    ].join('\n');
    out.narrative = await chat(
      [
        { role: 'system', content: RESEARCH_SYSTEM },
        { role: 'user', content: instruction },
      ],
      opts,
    );
  }
  return out;
}

// CLI:
//   node describe-candles.mjs HDFCBANK.NS               # facts only (no key)
//   node describe-candles.mjs HDFCBANK.NS 6mo --narrate # + plain-English narration
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const sym = positional[0];
  const range = positional[1] || '3mo';
  const narrate = args.includes('--narrate');
  if (!sym) {
    console.error('Usage: node describe-candles.mjs <SYMBOL> [range] [--narrate]');
    console.error('  e.g. node describe-candles.mjs HDFCBANK.NS 6mo --narrate');
    process.exit(1);
  }
  describeCandles(sym, { range, narrate })
    .then((d) => {
      console.log(d.facts);
      if (d.narrative) console.log('\n--- plain-English description ---\n' + d.narrative);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
