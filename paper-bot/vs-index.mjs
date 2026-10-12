// "Did my trading beat the index?" (library).
//
// Every buy and sell in the imported tradebook is mirrored into NIFTY 50 on
// the same day with the same rupees (a "public market equivalent"): buying
// ₹50,000 of a stock on a date also buys ₹50,000 of NIFTY that day; selling
// for ₹60,000 also sells ₹60,000 of NIFTY. At the end, your open positions at
// today's prices are compared with what the NIFTY mirror is worth.
//   - NIFTY includes ≈1.2%/yr dividends (price index + dividend estimate).
//   - Your side pays delivery charges on every trade (STT, stamp, exchange,
//     GST, DP); the NIFTY mirror is charged nothing — like a no-cost index fund.
//   - Sells of shares bought BEFORE the file's period are left out (no matching
//     buy to compare against); export the full history for an exact answer.
//   - Corporate actions (splits / bonuses) inside the period can distort a
//     stock's numbers; the app's prices are split-adjusted, the file's are not.
// Research / education only — not investment advice.

import { candles } from '../market-data.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { loadHoldings } from './holdings.mjs';
import { mapLimit } from '../util.mjs';

const DIV = 0.012;
const DAY = 86400000;

/** Annualised money-weighted return for dated cash flows [{date, amount}] (bisection). */
export function xirr(flows) {
  if (flows.length < 2) return null;
  const t0 = Date.parse(flows[0].date);
  const npv = (r) => flows.reduce((a, f) => a + f.amount / (1 + r) ** ((Date.parse(f.date) - t0) / (365.25 * DAY)), 0);
  let lo = -0.99;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** NIFTY total-return level by date (dividend estimate added daily). */
export function totalReturnIndex(rows) {
  const out = new Map();
  let tr = 1;
  for (let i = 0; i < rows.length; i++) {
    if (i) tr *= (rows[i].close / rows[i - 1].close) * (1 + DIV / 252);
    out.set(rows[i].date, tr);
  }
  return out;
}

/** Level on `date`, or the last one before it (weekend / holiday trades). */
function levelOn(index, dates, date) {
  let lo = 0;
  let hi = dates.length - 1;
  if (date < dates[0]) return index.get(dates[0]);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dates[mid] <= date) lo = mid;
    else hi = mid - 1;
  }
  return index.get(dates[lo]);
}

/**
 * Pure comparison. trades: [{symbol, date, side, qty, price}]; prices: {symbol: last};
 * index: Map(date → total-return level); today: 'YYYY-MM-DD'.
 */
export function compareWithIndex({ trades, prices, index, today, costs = DEFAULT_COSTS }) {
  const dates = [...index.keys()].sort();
  const endLevel = levelOn(index, dates, today);
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'buy' ? -1 : 1));
  const held = new Map();
  const flows = [];
  let invested = 0;
  let proceeds = 0;
  let charges = 0;
  let mirror = 0; // NIFTY mirror value at the end, built flow by flow
  let skippedSells = 0;
  const bySymbol = new Map();
  for (const t of sorted) {
    const g = endLevel / levelOn(index, dates, t.date);
    const s = bySymbol.get(t.symbol) || { symbol: t.symbol, bought: 0, sold: 0, charges: 0 };
    if (t.side === 'buy') {
      const amt = t.qty * t.price;
      const ch = orderCharges({ side: 'buy', value: amt, product: 'delivery', costs }).total;
      held.set(t.symbol, (held.get(t.symbol) || 0) + t.qty);
      flows.push({ date: t.date, amount: -(amt + ch) });
      invested += amt + ch;
      charges += ch;
      mirror += (amt + ch) * g;
      s.bought += amt + ch;
      s.charges += ch;
    } else {
      const have = held.get(t.symbol) || 0;
      const q = Math.min(have, t.qty);
      if (q < t.qty) skippedSells += t.qty - q;
      if (!q) {
        bySymbol.set(t.symbol, s);
        continue;
      }
      held.set(t.symbol, have - q);
      const amt = q * t.price;
      const ch = orderCharges({ side: 'sell', value: amt, product: 'delivery', costs }).total;
      flows.push({ date: t.date, amount: amt - ch });
      proceeds += amt - ch;
      charges += ch;
      mirror -= (amt - ch) * g;
      s.sold += amt - ch;
      s.charges += ch;
    }
    bySymbol.set(t.symbol, s);
  }
  let openValue = 0;
  const unpriced = [];
  for (const [sym, q] of held) {
    if (q <= 0) continue;
    const px = prices[sym];
    if (px == null) {
      unpriced.push(sym);
      continue;
    }
    openValue += q * px;
    const s = bySymbol.get(sym);
    s.openQty = q;
    s.openValue = q * px;
  }
  const yourFlows = [...flows, { date: today, amount: openValue }];
  const mirrorFlows = [...flows, { date: today, amount: mirror }];
  // Kaplan–Schoar PME: > 1 means your trades beat the same money in NIFTY
  const grown = (sign) => flows.filter((f) => Math.sign(f.amount) === sign).reduce((a, f) => a + Math.abs(f.amount) * (endLevel / levelOn(index, dates, f.date)), 0);
  const pme = (grown(1) + openValue) / grown(-1);
  const perStock = [...bySymbol.values()].map((s) => ({ ...s, pnl: s.sold + (s.openValue || 0) - s.bought })).sort((a, b) => b.pnl - a.pnl);
  return {
    trades: sorted.length,
    from: sorted[0]?.date ?? null,
    to: today,
    invested, proceeds, charges, openValue,
    yourPnl: proceeds + openValue - invested,
    niftyMirrorValue: mirror,
    differenceRs: openValue - mirror,
    pme,
    yourXirr: xirr(yourFlows),
    niftyXirr: mirror > 0 ? xirr(mirrorFlows) : null,
    beat: pme > 1,
    skippedSells, unpriced,
    perStock: perStock.slice(0, 50),
  };
}

/** From the saved tradebook: load NIFTY and today's prices, compare. */
export async function tradesVsIndex({ loadCandles = candles, now = new Date(), st = loadHoldings() } = {}) {
  const trades = st.trades || [];
  if (!trades.length) return { empty: true, note: 'Import your tradebook (Zerodha / Groww CSV) in My portfolio to compare your trading with NIFTY.' };
  const first = trades.map((t) => t.date).sort()[0];
  const p1 = Math.floor(Date.parse(first) / 1000) - 10 * 86400;
  const nifty = (await loadCandles('^NSEI', { period1: p1, interval: '1d' })).filter((r) => r.close > 0);
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const loaded = await mapLimit(symbols, 4, async (s) => {
    try {
      const rows = (await loadCandles(s, { range: '5d', interval: '1d' })).filter((r) => r.close > 0);
      return [s, rows.length ? rows[rows.length - 1].close : null];
    } catch {
      return [s, null];
    }
  });
  const today = new Date(now.getTime() + 19800_000).toISOString().slice(0, 10);
  const r = compareWithIndex({ trades, prices: Object.fromEntries(loaded.filter(([, p]) => p != null)), index: totalReturnIndex(nifty), today });
  return {
    ...r,
    verdict: r.beat
      ? `Your trades beat putting the same money into NIFTY on the same days by ₹${Math.round(r.differenceRs).toLocaleString('en-IN')} (after charges).`
      : `Putting the same money into NIFTY on the same days would have left you ₹${Math.round(-r.differenceRs).toLocaleString('en-IN')} better off (after charges).`,
    note: 'Each buy/sell mirrored into NIFTY 50 (incl. ≈1.2%/yr dividends) with the same rupees on the same day. Your side pays delivery charges; the NIFTY mirror none. Sells of shares bought before the file’s period are left out. Splits/bonuses inside the period can distort a stock. Before tax. Not advice.',
  };
}
