// Persistent paper portfolio (delivery / daily, long-only — like a retail cash
// account). State survives restarts in paper-bot/portfolio.json.
//
// - rebalance(): daily signals → open new LONGs (rules: confidence ≥ min,
//   max open positions, ATR sizing) and exit held names on FLAT/SHORT signals
//   after the minimum hold.
// - refresh(): replays each open position's daily bars since entry for
//   stop / target hits (gap-aware), then marks to the latest close.
// Paper simulation only — no orders are ever sent anywhere. Not investment advice.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PaperEngine } from './paper-engine.mjs';
import { PAPER } from './config.mjs';
import { candles } from '../market-data.mjs';
import { generateSignal } from './signal.mjs';
import { HttpError, badRequest, readJsonSafe, writeJsonAtomic } from '../util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PATH = process.env.PORTFOLIO_PATH || join(__dir, 'portfolio.json');

function freshState(capital = PAPER.startingCapital) {
  return { createdAt: new Date().toISOString(), startingCapital: capital, cash: capital, positions: [], closedTrades: [], equityHistory: [], totalCharges: 0, lastRefresh: null };
}

export function loadState() {
  // Missing → fresh; corrupt → readJsonSafe moves it aside and throws (never overwrite evidence).
  return readJsonSafe(PATH, null) || freshState();
}

function saveState(st) {
  writeJsonAtomic(PATH, st);
}

/** Rebuild an engine from saved state (delivery product). */
function toEngine(st) {
  const e = new PaperEngine({ startingCapital: st.startingCapital, product: 'delivery' });
  e.cash = st.cash;
  e.totalCharges = st.totalCharges || 0;
  e.closedTrades = st.closedTrades || [];
  for (const p of st.positions) e.positions.set(p.symbol, { ...p });
  return e;
}

function fromEngine(e, st) {
  st.cash = e.cash;
  st.totalCharges = e.totalCharges;
  st.positions = [...e.positions.values()];
  st.closedTrades = e.closedTrades.slice(-200);
  return st;
}

const day = (d) => String(d).slice(0, 10);

/**
 * Check stops/targets on bars after entry, mark to market, record equity.
 * @param {{ loadCandles?: Function, now?: Date }} [opts]  injectable for tests
 */
export async function refresh(opts = {}) {
  const load = opts.loadCandles || candles;
  const st = loadState();
  const e = toEngine(st);
  const marks = {};
  for (const pos of [...e.positions.values()]) {
    let bars;
    try {
      bars = await load(pos.symbol, { range: '6mo', interval: '1d' });
    } catch {
      continue; // keep the position; try again next refresh
    }
    const after = bars.filter((b) => day(b.date) > day(pos.entryDate));
    pos.barsHeld = after.length;
    for (const b of after) {
      if (e.checkStopsAndTargets(pos.symbol, b).length) break;
    }
    if (e.positions.has(pos.symbol) && bars.length) marks[pos.symbol] = bars[bars.length - 1].close;
  }
  const equity = e.equity(marks);
  // Equity-history dates are IST (as in strategy-accounts.mjs), not UTC.
  const now = opts.now || new Date();
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const hist = st.equityHistory;
  if (hist.length && hist[hist.length - 1].date === today) hist[hist.length - 1].equity = equity;
  else hist.push({ date: today, equity });
  st.lastRefresh = new Date().toISOString();
  saveState(fromEngine(e, st));
  return summarize(st, marks);
}

/**
 * Apply today's daily signals to the portfolio.
 * @param {{ techOnly?: boolean, symbols?: string[], loadCandles?: Function }} [opts]
 */
export async function rebalance(opts = {}) {
  const load = opts.loadCandles || candles;
  await refresh(opts); // settle stops/targets first
  const st = loadState();
  const e = toEngine(st);
  const symbols = opts.symbols?.length ? opts.symbols : PAPER.symbols;
  const actions = [];
  const marks = {};
  for (const sym of symbols) {
    let bars;
    try {
      bars = await load(sym, { range: PAPER.candleRange, interval: '1d' });
    } catch (err) {
      actions.push({ symbol: sym, action: 'skip', reason: err.message });
      continue;
    }
    const sig = await generateSignal(sym, bars, { techOnly: opts.techOnly !== false, lookbackBars: PAPER.lookbackBars });
    const px = bars[bars.length - 1].close;
    const date = bars[bars.length - 1].date;
    marks[sym] = px;
    const held = e.positions.get(sym);
    if (held) {
      if ((sig.signal === 'FLAT' || sig.signal === 'SHORT') && (held.barsHeld || 0) >= PAPER.minHoldBars) {
        const r = e.closePosition(sym, px, date, 'signal');
        if (r.ok) actions.push({ symbol: sym, action: 'close', price: r.trade.exitPrice, pnl: r.trade.pnl, reason: sig.reasoning });
      } else {
        actions.push({ symbol: sym, action: 'hold', reason: sig.signal === 'LONG' ? 'signal still LONG' : `min hold ${PAPER.minHoldBars} days` });
      }
    } else if (sig.signal === 'LONG' && sig.confidence >= PAPER.minConfidence) {
      const r = e.openLong(sym, px, date, sig.indicators?.atr14);
      actions.push(r.ok
        ? { symbol: sym, action: 'buy', qty: r.qty, price: px, stop: r.stop, target: r.target, confidence: sig.confidence, reason: sig.reasoning }
        : { symbol: sym, action: 'skip', reason: r.reason });
    } else {
      actions.push({ symbol: sym, action: 'none', reason: `${sig.signal} @ ${(sig.confidence * 100).toFixed(0)}% — ${sig.reasoning}` });
    }
  }
  saveState(fromEngine(e, st));
  return { actions, ...(await refresh(opts)) };
}

/** Manually close one position at the latest close. */
export async function closeOne(symbol, opts = {}) {
  const load = opts.loadCandles || candles;
  const st = loadState();
  const e = toEngine(st);
  if (!e.positions.has(symbol)) throw new HttpError(404, `No open paper position in ${symbol}.`);
  const bars = await load(symbol, { range: '5d', interval: '1d' });
  const last = bars[bars.length - 1];
  const r = e.closePosition(symbol, last.close, last.date, 'manual');
  saveState(fromEngine(e, st));
  return { trade: r.trade, ...(await refresh(opts)) };
}

/** Start over with a fresh account. */
export function reset(capital = PAPER.startingCapital) {
  const c = Number(capital);
  if (!(c >= 1000 && c <= 1e8)) throw badRequest('Starting capital must be between ₹1,000 and ₹10 crore.');
  const st = freshState(c);
  saveState(st);
  return summarize(st, {});
}

function summarize(st, marks) {
  const positions = st.positions.map((p) => {
    const mark = marks[p.symbol] ?? p.entryPrice;
    return { ...p, mark, unrealized: (mark - p.entryPrice) * p.qty, unrealizedPct: (mark / p.entryPrice - 1) * 100 };
  });
  const invested = positions.reduce((a, p) => a + p.mark * p.qty, 0);
  const equity = st.cash + invested;
  const realized = (st.closedTrades || []).reduce((a, t) => a + t.pnl, 0);
  return {
    startingCapital: st.startingCapital,
    cash: st.cash,
    equity,
    returnPct: (equity / st.startingCapital - 1) * 100,
    realizedPnl: realized,
    totalCharges: st.totalCharges || 0,
    positions,
    closedTrades: (st.closedTrades || []).slice(-20).reverse(),
    equityHistory: st.equityHistory,
    createdAt: st.createdAt,
    lastRefresh: st.lastRefresh,
    disclaimer: 'Paper portfolio — simulated, delivery (long-only), Indian charges applied. No real orders. Not investment advice.',
  };
}
