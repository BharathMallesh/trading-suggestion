// Forward test: paper accounts that run the candidate strategies side by side
// from today, with the same starting capital and real Indian costs, so we
// learn — without any hindsight — whether they beat simply holding NIFTY.
//
//   nifty     buy NIFTYBEES (NIFTY 50 ETF) once and hold          (benchmark)
//   trend     Strategy A: hold NIFTYBEES at month-end while NIFTY > 200-day
//             average (±1% band), else a liquid fund (6%/yr accrual)
//   momentum  Strategy B2: top 20 of NIFTY 200 by 12-1 month momentum,
//             monthly, keep holdings while rank ≤ 40, all cash when NIFTY is
//             below its 200-day average
//
// Tax: each account keeps FIFO tax lots (tax.mjs); the previous financial
// year's tax (capital gains + slab tax on liquid-fund returns) is paid from
// cash on the first run of a new year, and "after tax if sold today" is shown.
//
// State: paper-bot/data/strategy-accounts.json. rebalance() is safe to call
// every monitor run — each strategy only trades when its own schedule says so.
// Paper simulation only — no orders are ever sent. Not investment advice.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { candles } from '../market-data.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { loadIndexList, SIGNALS } from './ranking.mjs';
import { ASSUMPTIONS } from './strategies.mjs';
import { mapLimit, badRequest } from '../util.mjs';
import { TaxLedger, fyOf } from './tax.mjs';

const PATH = process.env.STRATEGY_ACCOUNTS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'strategy-accounts.json');
const ETF = 'NIFTYBEES.NS';
export const ACCOUNTS = {
  nifty: 'NIFTY 50 buy-and-hold (benchmark)',
  trend: 'A · NIFTY trend filter (month-end)',
  momentum: 'B2 · Momentum top 20 + market filter',
};
const istDate = (d = new Date()) => new Date(d.getTime() + 19800_000).toISOString().slice(0, 10);

function fresh(capital) {
  const startedAt = new Date().toISOString();
  return {
    capital,
    startedAt,
    accounts: Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, { cash: capital, holdings: {}, charges: 0, trades: [], history: [], lastAccrual: startedAt, lastRebalanceMonth: null }])),
  };
}
export function loadAccounts() {
  try {
    if (existsSync(PATH)) return JSON.parse(readFileSync(PATH, 'utf8'));
  } catch {
    /* start fresh */
  }
  return null;
}
function save(st) {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(st, null, 2));
}
export function resetAccounts(capital = 1e6) {
  const c = Number(capital);
  if (!(c >= 1e5 && c <= 1e9)) throw badRequest('Capital must be between ₹1 lakh and ₹100 crore (momentum holds 20 stocks).');
  const st = fresh(c);
  save(st);
  return st;
}

/** The account's tax ledger; older saved accounts get lots seeded from their holdings. */
function ledger(acct, startedAt) {
  if (!acct._ledger) {
    if (acct.tax) acct._ledger = TaxLedger.from(acct.tax);
    else {
      acct._ledger = new TaxLedger();
      for (const [sym, h] of Object.entries(acct.holdings)) {
        const first = acct.trades.find((t) => t.symbol === sym && t.side === 'buy');
        acct._ledger.buy(sym, h.qty, h.cost / h.qty, first?.date || startedAt.slice(0, 10));
      }
    }
  }
  return acct._ledger;
}

/** Cash earns the liquid-fund rate between runs (slab-taxed income). */
function accrue(acct, now, L) {
  const days = (now - new Date(acct.lastAccrual)) / 86400000;
  if (days > 0 && acct.cash > 0) {
    const interest = acct.cash * ((1 + ASSUMPTIONS.liquidYield) ** (days / 365) - 1);
    acct.cash += interest;
    L?.income(interest, istDate(now));
  }
  acct.lastAccrual = now.toISOString();
}

/** First run in a new financial year: pay last year's tax from cash. */
function settleTax(acct, today, L) {
  const fy = fyOf(today);
  if (acct.taxFy && acct.taxFy !== fy) {
    const tax = L.settle(acct.taxFy);
    if (tax > 0) {
      acct.cash -= tax;
      acct.taxPaid = (acct.taxPaid || 0) + tax;
      acct.trades.push({ date: today, symbol: 'TAX', side: 'tax', qty: 0, price: 0, charges: tax, note: `income tax for FY ${acct.taxFy}` });
    }
  }
  acct.taxFy = fy;
}

/** Trade one account toward target rupee values {symbol: value} at prices {symbol: price}. */
function tradeTo(acct, target, prices, product, date, note) {
  const costs = { ...DEFAULT_COSTS, slippagePct: product === 'etf' ? 0.05 : ASSUMPTIONS.stockSlippagePct };
  const syms = new Set([...Object.keys(acct.holdings), ...Object.keys(target)]);
  // sells first (frees cash), then buys
  const order = [...syms].sort((a, b) => ((target[a] || 0) - value(acct, a, prices)) - ((target[b] || 0) - value(acct, b, prices)));
  for (const sym of order) {
    const px = prices[sym];
    if (!px) continue;
    const cur = value(acct, sym, prices);
    const delta = (target[sym] || 0) - cur;
    if (Math.abs(delta) < Math.max(1000, 0.01 * Math.max(cur, target[sym] || 0))) continue;
    const side = delta > 0 ? 'buy' : 'sell';
    let qty = Math.floor(Math.abs(delta) / px);
    if (side === 'sell' && !target[sym]) qty = acct.holdings[sym]?.qty || 0; // full exit
    if (!qty) continue;
    const fill = side === 'buy' ? px * (1 + costs.slippagePct / 100) : px * (1 - costs.slippagePct / 100);
    const v = qty * fill;
    const oc = orderCharges({ side, value: v, product, costs });
    const c = oc.total;
    // Tax basis: only brokerage (+ its GST) and stamp duty are deductible for
    // capital gains; STT, exchange/SEBI fees and DP charges are not.
    const b = oc.breakdown;
    const feeBase = b.brokerage + b.exchange + b.sebi;
    const gstOnBrokerage = feeBase > 0 ? (b.gst * b.brokerage) / feeBase : 0;
    if (side === 'buy' && v + c > acct.cash) continue;
    acct.cash += side === 'buy' ? -(v + c) : v - c;
    acct.charges += c;
    // tax cost basis = value + deductible buy charges; proceeds = value - deductible sell charges
    // (cash effects above still use the full charges)
    if (acct._ledger) side === 'buy' ? acct._ledger.buy(sym, qty, (v + b.brokerage + b.stamp + gstOnBrokerage) / qty, date) : acct._ledger.sell(sym, qty, (v - b.brokerage - gstOnBrokerage) / qty, date);
    const h = acct.holdings[sym] || { qty: 0, cost: 0 };
    if (side === 'buy') {
      h.cost += v;
      h.qty += qty;
    } else {
      h.cost *= (h.qty - qty) / h.qty;
      h.qty -= qty;
    }
    if (h.qty > 0) acct.holdings[sym] = h;
    else delete acct.holdings[sym];
    acct.trades.push({ date, symbol: sym, side, qty, price: fill, charges: c, note });
  }
  acct.trades = acct.trades.slice(-300);
}
const value = (acct, sym, prices) => (acct.holdings[sym]?.qty || 0) * (prices[sym] || 0);
const equityOf = (acct, prices) => acct.cash + Object.keys(acct.holdings).reduce((a, s) => a + value(acct, s, prices), 0);

/**
 * Run each strategy's schedule and mark everything to market.
 * @param {{ now?: Date, loadCandles?: Function, universe?: string }} [opts]
 */
export async function rebalanceAccounts(opts = {}) {
  const now = opts.now || new Date();
  const load = opts.loadCandles || candles;
  const st = loadAccounts() || resetAccounts(1e6);
  const month = istDate(now).slice(0, 7);
  const today = istDate(now);
  for (const a of Object.values(st.accounts)) {
    const L = ledger(a, st.startedAt);
    accrue(a, now, L);
    settleTax(a, today, L);
  }

  // NIFTY + its 200-day average (decides trend & momentum filters)
  const idx = await load('^NSEI', { range: '2y', interval: '1d' });
  const closes = idx.map((r) => r.close);
  const sma200 = closes.slice(-ASSUMPTIONS.smaDays).reduce((a, b) => a + b, 0) / ASSUMPTIONS.smaDays;
  const niftyNow = closes[closes.length - 1];
  const etfRows = await load(ETF, { range: '5d', interval: '1d' });
  const prices = { [ETF]: etfRows[etfRows.length - 1].close };
  const actions = [];

  // nifty: buy once
  const n = st.accounts.nifty;
  if (!Object.keys(n.holdings).length && n.cash > 1000) {
    tradeTo(n, { [ETF]: n.cash * 0.998 }, prices, 'etf', today, 'initial buy');
    actions.push({ account: 'nifty', action: `bought ${ETF}` });
  }

  // trend: decide once per month (first run of a new month = month-end signal)
  const t = st.accounts.trend;
  if (t.lastRebalanceMonth !== month) {
    const inMarket = Object.keys(t.holdings).length > 0;
    const band = ASSUMPTIONS.bandPct / 100;
    const want = inMarket ? niftyNow > sma200 * (1 - band) : niftyNow > sma200 * (1 + band);
    const eq = equityOf(t, prices);
    tradeTo(t, want ? { [ETF]: eq * 0.998 } : {}, prices, 'etf', today, want ? 'NIFTY above 200-day avg' : 'NIFTY below 200-day avg → liquid fund');
    t.lastRebalanceMonth = month;
    actions.push({ account: 'trend', action: want ? 'invested in NIFTY ETF' : 'in liquid fund (cash)', nifty: niftyNow, sma200 });
  }

  // momentum: monthly
  const m = st.accounts.momentum;
  let momentumPrices = {};
  if (m.lastRebalanceMonth !== month) {
    const list = await loadIndexList(opts.universe || 'nifty200');
    const loaded = await mapLimit(list.symbols, 4, async (sym) => {
      try {
        const rows = await load(sym, { range: '2y', interval: '1d' });
        const c = rows.map((r) => r.close);
        return c.length > 253 ? { sym, price: c[c.length - 1], score: SIGNALS.mom12_1(c) } : null;
      } catch {
        return null;
      }
    });
    const ranked = loaded.filter((x) => x && x.score != null).sort((a, b) => b.score - a.score);
    momentumPrices = Object.fromEntries(ranked.map((x) => [x.sym, x.price]));
    // Every held symbol needs a price before trading: a holding outside the
    // ranked list (or one whose fetch failed) must not be valued at 0.
    let missing = null;
    for (const sym of Object.keys(m.holdings)) {
      if (momentumPrices[sym] > 0) continue;
      try {
        const r = await load(sym, { range: '5d', interval: '1d' });
        const px = r[r.length - 1]?.close;
        if (px > 0) momentumPrices[sym] = px;
      } catch {
        /* handled below */
      }
      if (!(momentumPrices[sym] > 0)) {
        missing = sym;
        break;
      }
    }
    if (missing) {
      actions.push({ account: 'momentum', action: `momentum: skipped — missing price for ${missing}` });
    } else {
      const rankOf = new Map(ranked.map((x, i) => [x.sym, i + 1]));
      let target = [];
      if (niftyNow >= sma200) {
        target = Object.keys(m.holdings).filter((s) => (rankOf.get(s) ?? Infinity) <= ASSUMPTIONS.bufferRank);
        for (const x of ranked) {
          if (target.length >= ASSUMPTIONS.topN) break;
          if (!target.includes(x.sym)) target.push(x.sym);
        }
      }
      const eq = equityOf(m, momentumPrices);
      const each = target.length ? (eq * 0.995) / target.length : 0;
      tradeTo(m, Object.fromEntries(target.map((s) => [s, each])), momentumPrices, 'delivery', today, niftyNow >= sma200 ? 'monthly momentum rebalance' : 'market filter: NIFTY below 200-day avg → cash');
      m.lastRebalanceMonth = month;
      actions.push({ account: 'momentum', action: target.length ? `holding ${target.length} stocks` : 'all cash (market filter)', universe: ranked.length });
    }
  }

  // Mark every account to market and record today's equity.
  const held = [...new Set(Object.values(st.accounts).flatMap((a) => Object.keys(a.holdings)))].filter((s) => !(s in prices) && !(s in momentumPrices));
  const extra = await mapLimit(held, 4, async (s) => {
    try {
      const r = await load(s, { range: '5d', interval: '1d' });
      return [s, r[r.length - 1].close];
    } catch {
      return [s, null];
    }
  });
  Object.assign(prices, momentumPrices, Object.fromEntries(extra.filter(([, p]) => p)));
  for (const a of Object.values(st.accounts)) {
    const eq = equityOf(a, prices);
    const last = a.history[a.history.length - 1];
    if (last && last.date === today) last.equity = eq;
    else a.history.push({ date: today, equity: eq });
  }
  for (const a of Object.values(st.accounts)) {
    a.afterTaxIfSold = afterTaxIfSold(a, prices, today);
    a.tax = a._ledger.toJSON();
    delete a._ledger;
  }
  save(st);
  return summarize(st, prices, actions);
}

/** Equity after selling everything today and paying this year's tax (estimate). */
function afterTaxIfSold(acct, prices, today) {
  const L = TaxLedger.from(acct._ledger.toJSON());
  let cash = acct.cash;
  for (const [sym, h] of Object.entries(acct.holdings)) {
    const px = prices[sym];
    if (!px) continue;
    L.sell(sym, h.qty, px, today);
    cash += h.qty * px;
  }
  return cash - L.settle(fyOf(today));
}

export function summarize(st, prices = {}, actions = []) {
  const accounts = Object.entries(st.accounts).map(([k, a]) => {
    const eq = a.history.length ? a.history[a.history.length - 1].equity : st.capital;
    return {
      key: k,
      name: ACCOUNTS[k],
      equity: eq,
      returnPct: (eq / st.capital - 1) * 100,
      cash: a.cash,
      charges: a.charges,
      taxPaid: a.taxPaid || 0,
      afterTaxIfSold: a.afterTaxIfSold ?? null,
      afterTaxReturnPct: a.afterTaxIfSold != null ? (a.afterTaxIfSold / st.capital - 1) * 100 : null,
      holdings: Object.entries(a.holdings).map(([s, h]) => ({ symbol: s, qty: h.qty, avgCost: h.cost / h.qty, last: prices[s] ?? null })),
      trades: a.trades.slice(-10).reverse(),
      history: a.history,
    };
  });
  return {
    capital: st.capital,
    startedAt: st.startedAt,
    accounts,
    actions,
    note: 'Forward test started on the date shown: no hindsight. Judge after many months — one year is still short for strategy comparisons. Paper only; not investment advice.',
  };
}
