#!/usr/bin/env node
// Strategy tests (library + CLI): low-turnover, cost-aware strategies judged
// against simply holding NIFTY. Every rule is fixed IN ADVANCE (no tuning on
// the test data); results are reported for both halves of the period.
//
// A. NIFTY trend: hold NIFTY (via an index ETF) while NIFTY is above its
//    200-day average (±1% band to avoid flip-flopping), else a liquid fund.
//    Variants: daily check, and month-end check only.
// B. Momentum portfolio (NIFTY 200, monthly): top 20 by 12-1 month momentum,
//    built up step by step so each component's effect is visible:
//      B0 plain · B1 + buffer (keep holdings while rank ≤ 40)
//      B2 + market filter (cash when NIFTY < 200-day average)
//      B3 + volatility targeting (15% annual; remainder in liquid fund)
// C. Volatility-targeted NIFTY: hold NIFTY sized so expected volatility is
//    15% a year (exposure = min(1, 15% ÷ forecast vol), re-sized at month
//    end, rest in a liquid fund). Forecasters compared: rv20, EWMA, HAR —
//    does the better forecast give a better strategy? Plus C+A: the same
//    sizing on top of the trend filter.
//
// Costs: Indian delivery charges per order (STT, exchange, SEBI, stamp, GST,
// DP charge per sale) + slippage; ETF trades use ETF rates. Cash earns a
// liquid-fund rate. Dividends: ~1.2%/yr added while invested in equities
// (both strategy and benchmark), since Yahoo index prices exclude them.
// Not modelled: taxes (short-term capital gains on every switch/rebalance
// would reduce strategy returns further vs buy-and-hold), impact cost of
// large orders. Universe for B is TODAY's NIFTY 200 → survivorship bias.
// Research only — not investment advice.
//
//   node paper-bot/strategies.mjs            # both, ₹10 lakh
//   node paper-bot/strategies.mjs --capital 100000

import { pathToFileURL } from 'node:url';
import { candles } from '../market-data.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { loadIndexList, SIGNALS } from './ranking.mjs';
import { mapLimit, badRequest } from '../util.mjs';
import { FORECASTERS } from './volatility.mjs';
import { TaxLedger, TAX_RULES, fyOf } from './tax.mjs';

const TD = 252;
export const ASSUMPTIONS = {
  liquidYield: 0.06, // annual, cash / liquid fund
  dividendYield: 0.012, // annual, added while in equities
  stockSlippagePct: 0.1, // per fill, NIFTY 200 names
  etfRoundTripPct: 0.1, // ETF: tiny STT + exchange + stamp + spread, per round trip
  etfExpense: 0.0005, // annual, index ETF
  smaDays: 200,
  bandPct: 1,
  topN: 20,
  bufferRank: 40,
  volTarget: 0.15,
  rebalanceDays: 21,
};

/** Performance stats for a daily equity curve [{date, equity}]. */
export function stats(curve, { rf = ASSUMPTIONS.liquidYield } = {}) {
  if (curve.length < 3) return null;
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const years = rets.length / TD;
  const total = curve[curve.length - 1].equity / curve[0].equity;
  const cagr = total ** (1 / years) - 1;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length) * Math.sqrt(TD);
  let peak = curve[0].equity;
  let maxDD = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, 1 - p.equity / peak);
  }
  return {
    from: curve[0].date,
    to: curve[curve.length - 1].date,
    years,
    cagrPct: cagr * 100,
    volPct: vol * 100,
    sharpe: vol ? (cagr - rf) / vol : null,
    maxDrawdownPct: maxDD * 100,
    calmar: maxDD ? cagr / maxDD : null,
  };
}

/** Stats for the whole period and each half (stability check). */
function withHalves(curve, rf = ASSUMPTIONS.liquidYield) {
  const mid = Math.floor(curve.length / 2);
  return { all: stats(curve, { rf }), firstHalf: stats(curve.slice(0, mid + 1), { rf }), secondHalf: stats(curve.slice(mid), { rf }) };
}

const sma = (a, i, n) => {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += a[k];
  return s / n;
};

/**
 * Strategy A on an index series. `monthEnd`: only re-check the signal on the
 * last trading day of each month. Signal at close, switch at the next close.
 */
export function trendStrategy(index, { monthEnd = false, a = ASSUMPTIONS, label = null } = {}) {
  const close = index.map((r) => r.close);
  const start = a.smaDays;
  let invested = close[start] > sma(close, start, a.smaDays);
  let equity = 1;
  let bh = 1;
  let switches = 0;
  let daysIn = 0;
  const curve = [{ date: index[start].date, equity }];
  const bench = [{ date: index[start].date, equity: bh }];
  const dailyLiquid = (1 + a.liquidYield) ** (1 / TD) - 1;
  const dailyDiv = a.dividendYield / TD;
  const path = [invested ? 1 : 0]; // exposure held over day i (index start + k)
  let pending = null; // signal decided at the previous close, executed at this close
  for (let i = start + 1; i < index.length; i++) {
    const r = close[i] / close[i - 1] - 1;
    bh *= 1 + r + dailyDiv;
    equity *= invested ? 1 + r + dailyDiv - a.etfExpense / TD : 1 + dailyLiquid;
    if (invested) daysIn++;
    // Signal at close i-1, switch (and pay the cost) at close i: the new
    // exposure first earns day i+1's return — never the return that produced it.
    if (pending !== null && pending !== invested) {
      invested = pending;
      switches++;
      equity *= 1 - a.etfRoundTripPct / 200; // half a round trip per switch
    }
    pending = null;
    // decide at today's close (executes at tomorrow's close)
    const isMonthEnd = i + 1 >= index.length || index[i + 1].date.slice(0, 7) !== index[i].date.slice(0, 7);
    if (!monthEnd || isMonthEnd) {
      const m = sma(close, i, a.smaDays);
      pending = invested ? close[i] > m * (1 - a.bandPct / 100) : close[i] > m * (1 + a.bandPct / 100);
    }
    curve.push({ date: index[i].date, equity });
    bench.push({ date: index[i].date, equity: bh });
    path.push(invested ? 1 : 0);
  }
  const years = (index.length - start - 1) / TD;
  return {
    name: label || (monthEnd ? 'A · NIFTY trend (month-end check)' : 'A · NIFTY trend (daily check)'),
    path,
    start,
    ...withHalves(curve, a.liquidYield),
    benchmark: withHalves(bench, a.liquidYield),
    switchesPerYear: switches / years,
    pctTimeInvested: (daysIn / (index.length - start - 1)) * 100,
    curve,
    benchCurve: bench,
  };
}

/**
 * After-tax replay of a single-asset (NIFTY ETF) strategy: `path[k]` is the
 * share of the account in the ETF on day start + k (decided the day before).
 * Rupee amounts (capital matters for the ₹1.25 lakh LTCG exemption); FIFO
 * lots; dividends paid to cash and slab-taxed; liquid fund returns
 * slab-taxed; tax paid from cash each March (selling ETF if cash is short);
 * everything sold on the last day ("if you cashed out") and that tax paid too.
 */
export function afterTaxSingle(index, start, path, { capital = 1e6, a = ASSUMPTIONS, rules = TAX_RULES } = {}) {
  const L = new TaxLedger(rules);
  const dailyLiquid = (1 + a.liquidYield) ** (1 / TD) - 1;
  const dailyDiv = a.dividendYield / TD;
  // ETF price net of its expense ratio
  let px = index[start].close;
  const priceAt = [px];
  for (let i = start + 1; i < index.length; i++) {
    px *= (index[i].close / index[i - 1].close) * (1 - a.etfExpense / TD);
    priceAt.push(px);
  }
  let units = 0;
  let cash = capital;
  const trade = (k, targetValue) => {
    const p = priceAt[k];
    const date = index[start + k].date;
    const delta = targetValue - units * p;
    if (Math.abs(delta) < 1) return;
    const cost = (Math.abs(delta) * a.etfRoundTripPct) / 200;
    if (delta > 0) {
      const u = (delta - cost) / p;
      L.buy('ETF', u, p, date);
      units += u;
      cash -= delta;
    } else {
      const u = Math.min(units, -delta / p);
      L.sell('ETF', u, p, date);
      units -= u;
      cash += u * p - cost;
    }
  };
  // initial position
  trade(0, capital * path[0]);
  const curve = [{ date: index[start].date, equity: cash + units * priceAt[0] }];
  let target = path[0];
  for (let k = 1; k < path.length; k++) {
    const date = index[start + k].date;
    const p = priceAt[k];
    // income for the day
    const interest = cash > 0 ? cash * dailyLiquid : 0;
    const div = units * p * dailyDiv;
    cash += interest + div;
    L.income(interest + div, date);
    const eq = cash + units * p;
    // re-size when the strategy changes its exposure, or the drift is > 5 points
    const want = path[k];
    const cur = eq > 0 ? (units * p) / eq : 0;
    if (want !== target || Math.abs(cur - want) > 0.05) {
      trade(k, eq * want);
      target = want;
    }
    // financial year end: pay tax from cash (sell ETF if needed)
    const next = index[start + k + 1]?.date;
    if (next && fyOf(next) !== fyOf(date)) {
      const tax = L.settle(fyOf(date));
      if (tax > cash) trade(k, Math.max(0, units * p - (tax - cash) * 1.002));
      cash -= tax;
    }
    curve.push({ date, equity: cash + units * p });
  }
  // cash out at the end and pay that year's tax
  const lastK = path.length - 1;
  trade(lastK, 0);
  const finalTax = L.settle(fyOf(index[start + lastK].date));
  const finalAfterTax = cash - finalTax;
  const years = lastK / TD;
  return {
    ...stats(curve),
    cagrIfSoldPct: ((finalAfterTax / capital) ** (1 / years) - 1) * 100,
    taxPaid: L.paid,
    taxPaidPctOfCapitalPerYear: (L.paid / capital / years) * 100,
  };
}

/**
 * Strategy C: volatility-targeted NIFTY (optionally on top of the trend filter).
 * Re-sized at month end only (low turnover); costs on the size change.
 */
export function volTargetStrategy(index, { forecaster = 'har', withTrend = false, a = ASSUMPTIONS } = {}) {
  const close = index.map((r) => r.close);
  const logR = close.slice(1).map((c, i) => Math.log(c / close[i]));
  const start = Math.max(a.smaDays, 300);
  const dailyLiquid = (1 + a.liquidYield) ** (1 / TD) - 1;
  const dailyDiv = a.dividendYield / TD;
  const f = FORECASTERS[forecaster];
  const sizeAt = (i) => {
    let exp = 1;
    const v = f(logR.slice(0, i), 21);
    if (v) exp = Math.min(1, a.volTarget / (v * Math.sqrt(TD)));
    if (withTrend) {
      const m = sma(close, i, a.smaDays);
      if (m && close[i] < m) exp = 0;
    }
    return exp;
  };
  let exposure = sizeAt(start);
  let pendingSize = null; // sized at a month-end close, executed at the NEXT close
  let equity = 1;
  let turnover = 0;
  let sumExp = 0;
  const curve = [{ date: index[start].date, equity }];
  const path = [exposure];
  for (let i = start + 1; i < index.length; i++) {
    const r = close[i] / close[i - 1] - 1;
    equity *= 1 + exposure * (r + dailyDiv - a.etfExpense / TD) + (1 - exposure) * dailyLiquid;
    sumExp += exposure;
    if (pendingSize !== null) {
      const delta = Math.abs(pendingSize - exposure);
      if (delta >= 0.05) {
        equity *= 1 - (delta * a.etfRoundTripPct) / 200;
        turnover += delta;
        exposure = pendingSize;
      }
      pendingSize = null;
    }
    const isMonthEnd = i + 1 >= index.length || index[i + 1].date.slice(0, 7) !== index[i].date.slice(0, 7);
    if (isMonthEnd) pendingSize = sizeAt(i); // decided now, traded at tomorrow's close
    curve.push({ date: index[i].date, equity });
    path.push(exposure);
  }
  const years = (index.length - start - 1) / TD;
  return {
    path,
    start,
    name: `C · vol target ${Math.round(a.volTarget * 100)}% (${forecaster})${withTrend ? ' + trend filter' : ''}`,
    forecaster,
    withTrend,
    ...withHalves(curve),
    avgExposurePct: (sumExp / (index.length - start - 1)) * 100,
    turnoverPerYear: turnover / years,
    curve,
  };
}

/**
 * Strategy B variants on a stock universe.
 * @param {{symbol, dates:string[], closes:number[], at:Map}[]} series
 * @param {{date, close}[]} index NIFTY
 */
export function momentumStrategy(series, index, { variant = 'B3', capital = 1e6, a = ASSUMPTIONS, tax = false, rules = TAX_RULES } = {}) {
  const L = tax ? new TaxLedger(rules) : null;
  const equalWeight = variant === 'EW'; // same universe, same costs — isolates survivorship bias
  const useBuffer = variant !== 'B0' && !equalWeight;
  const useFilter = variant === 'B2' || variant === 'B3';
  const useVol = variant === 'B3';
  const costs = { ...DEFAULT_COSTS, slippagePct: a.stockSlippagePct };
  const dates = index.map((r) => r.date);
  const idxClose = index.map((r) => r.close);
  const dailyLiquid = (1 + a.liquidYield) ** (1 / TD) - 1;
  const dailyDiv = a.dividendYield / TD;
  const priceAt = (s, d) => {
    const i = s.at.get(d);
    return i == null ? null : s.closes[i];
  };
  const start = dates.findIndex((d) => series.filter((s) => (s.at.get(d) ?? -1) >= 260).length >= 50);
  if (start < 0 || start + a.rebalanceDays * 6 >= dates.length) throw badRequest('Not enough history for the momentum test.');

  let cash = capital;
  const pos = new Map(); // symbol → rupee value
  let charges = 0;
  let turnover = 0;
  const curve = [];
  let lastRebalance = -Infinity;
  for (let i = start; i < dates.length; i++) {
    const d = dates[i];
    // 1. mark to market (yesterday → today)
    if (i > start) {
      let div = 0;
      for (const [sym, v] of pos) {
        const s = series.find((x) => x.symbol === sym);
        const p0 = priceAt(s, dates[i - 1]);
        const p1 = priceAt(s, d);
        if (p0 && p1) {
          // with tax: dividends are paid out to cash (slab-taxed) instead of compounding in the position
          pos.set(sym, v * (p1 / p0) * (L ? 1 : 1 + dailyDiv));
          div += v * (p1 / p0) * dailyDiv;
        }
      }
      const interest = cash > 0 ? cash * dailyLiquid : 0;
      cash += interest;
      if (L) {
        cash += div;
        L.income(div + interest, d);
      }
    }
    // 2. rebalance every N trading days
    if (i - lastRebalance >= a.rebalanceDays) {
      lastRebalance = i;
      const equity = cash + [...pos.values()].reduce((x, y) => x + y, 0);
      let exposure = 1;
      if (useFilter) {
        const m = sma(idxClose, i, a.smaDays);
        if (m && idxClose[i] < m) exposure = 0;
      }
      // rank by 12-1 month momentum
      const ranked = series
        .map((s) => {
          const k = s.at.get(d);
          return k != null && k >= 260 ? { s, score: SIGNALS.mom12_1(s.closes.slice(0, k + 1)) } : null;
        })
        .filter((x) => x && x.score != null)
        .sort((x, y) => y.score - x.score);
      const rankOf = new Map(ranked.map((x, r) => [x.s.symbol, r + 1]));
      let target = [];
      if (exposure > 0 && equalWeight) {
        target = ranked.map((x) => x.s.symbol);
      } else if (exposure > 0) {
        if (useBuffer) target = [...pos.keys()].filter((sym) => (rankOf.get(sym) ?? Infinity) <= a.bufferRank);
        for (const x of ranked) {
          if (target.length >= a.topN) break;
          if (!target.includes(x.s.symbol)) target.push(x.s.symbol);
        }
        target = target.slice(0, a.topN);
        if (useVol && target.length) {
          // forecast vol of the equal-weight target basket from its last 60 days
          const rets = [];
          for (let k = i - 59; k <= i; k++) {
            let sum = 0;
            let n = 0;
            for (const sym of target) {
              const s = series.find((x) => x.symbol === sym);
              const p0 = priceAt(s, dates[k - 1]);
              const p1 = priceAt(s, dates[k]);
              if (p0 && p1) {
                sum += p1 / p0 - 1;
                n++;
              }
            }
            if (n) rets.push(sum / n);
          }
          const m = rets.reduce((x, y) => x + y, 0) / rets.length;
          const vol = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / rets.length) * Math.sqrt(TD);
          exposure = Math.min(1, a.volTarget / (vol || a.volTarget));
        }
      }
      const each = target.length ? (equity * exposure) / target.length : 0;
      const want = new Map(target.map((sym) => [sym, each]));
      for (const sym of new Set([...pos.keys(), ...want.keys()])) {
        const cur = pos.get(sym) || 0;
        const tgt = want.get(sym) || 0;
        const delta = tgt - cur;
        // ignore tiny top-ups (< 1% of the position) — they cost more than they help
        if (Math.abs(delta) < Math.max(500, 0.01 * Math.max(cur, tgt))) continue;
        const side = delta > 0 ? 'buy' : 'sell';
        const value = Math.abs(delta);
        const c = orderCharges({ side, value, product: 'delivery', costs }).total + (value * costs.slippagePct) / 100;
        charges += c;
        turnover += value;
        cash -= delta + c;
        if (L) {
          const px = priceAt(series.find((x) => x.symbol === sym), d);
          if (px) side === 'buy' ? L.buy(sym, value / px, px, d) : L.sell(sym, value / px, px, d);
        }
        if (tgt > 0) pos.set(sym, tgt);
        else pos.delete(sym);
      }
    }
    // financial year end: pay the year's tax from cash
    if (L && dates[i + 1] && fyOf(dates[i + 1]) !== fyOf(d)) cash -= L.settle(fyOf(d));
    curve.push({ date: d, equity: cash + [...pos.values()].reduce((x, y) => x + y, 0) });
  }
  let cagrIfSoldPct = null;
  if (L) {
    // cash out on the last day and pay that year's tax
    const d = dates[dates.length - 1];
    let fin = cash;
    for (const [sym, v] of pos) {
      const px = priceAt(series.find((x) => x.symbol === sym), d);
      if (px) L.sell(sym, v / px, px, d);
      fin += v;
    }
    fin -= L.settle(fyOf(d));
    cagrIfSoldPct = ((fin / capital) ** (1 / ((curve.length - 1) / TD)) - 1) * 100;
  }
  const years = (curve.length - 1) / TD;
  return {
    name: {
      B0: 'B0 · momentum top 20, monthly',
      B1: 'B1 · + buffer (hold while rank ≤ 40)',
      B2: 'B2 · + market filter (NIFTY > 200-day avg)',
      B3: 'B3 · + volatility target 15%',
      EW: 'Equal-weight same universe (survivorship control)',
    }[variant],
    variant,
    ...withHalves(curve),
    chargesPctPerYear: (charges / capital / years) * 100,
    turnoverPerYear: turnover / capital / years,
    ...(L ? { cagrIfSoldPct, taxPaidPctOfCapitalPerYear: (L.paid / capital / years) * 100 } : {}),
    curve,
  };
}

/** Run everything: A (10y NIFTY) and B0–B3 (10y NIFTY 200) vs benchmarks. */
export async function runStrategyTests({ capital = 1e6, universe = 'nifty200', loadCandles = candles } = {}) {
  const index = await loadCandles('^NSEI', { range: '10y', interval: '1d' });
  const A = [
    trendStrategy(index),
    trendStrategy(index, { monthEnd: true }),
    // Sensitivity: how much of A's edge depends on the 6% cash-yield assumption?
    trendStrategy(index, { monthEnd: true, a: { ...ASSUMPTIONS, liquidYield: 0.04 }, label: 'A · NIFTY trend (month-end, 4% cash yield)' }),
  ];
  const C = [
    volTargetStrategy(index, { forecaster: 'rv20' }),
    volTargetStrategy(index, { forecaster: 'ewma' }),
    volTargetStrategy(index, { forecaster: 'har' }),
    volTargetStrategy(index, { forecaster: 'har', withTrend: true }),
  ];
  // NIFTY buy-and-hold over C's window (C starts later: it needs 300 days for HAR)
  const cFrom = C[0].curve[0].date;
  const cIdx = index.filter((r) => r.date >= cFrom);
  const cBh = [];
  let ce = 1;
  cIdx.forEach((r, k) => {
    if (k) ce *= r.close / cIdx[k - 1].close + ASSUMPTIONS.dividendYield / TD;
    cBh.push({ date: r.date, equity: ce });
  });
  const cBench = withHalves(cBh);

  const list = await loadIndexList(universe);
  const loaded = await mapLimit(list.symbols, 4, async (sym) => {
    try {
      const rows = await loadCandles(sym, { range: '10y', interval: '1d' });
      return rows.length > 300 ? { symbol: sym, dates: rows.map((r) => r.date), closes: rows.map((r) => r.close), at: new Map(rows.map((r, k) => [r.date, k])) } : null;
    } catch {
      return null;
    }
  });
  const series = loaded.filter(Boolean);
  const B = ['B0', 'B1', 'B2', 'B3'].map((v) => momentumStrategy(series, index, { variant: v, capital }));
  const EW = momentumStrategy(series, index, { variant: 'EW', capital });
  // NIFTY buy-and-hold over B's window (with dividends)
  const from = B[0].curve[0].date;
  const idxWin = index.filter((r) => r.date >= from);
  const bhCurve = [];
  let eq = 1;
  idxWin.forEach((r, k) => {
    if (k) eq *= r.close / idxWin[k - 1].close + ASSUMPTIONS.dividendYield / TD;
    bhCurve.push({ date: r.date, equity: eq });
  });
  const verdict = (s, bench) => {
    const better = (x, y) => x.sharpe > y.sharpe && x.maxDrawdownPct <= y.maxDrawdownPct * 1.1;
    return better(s.firstHalf, bench.firstHalf) && better(s.secondHalf, bench.secondHalf)
      ? 'beats NIFTY on risk-adjusted return in both halves'
      : s.all.sharpe > bench.all.sharpe
        ? 'better overall, but not in both halves'
        : 'does not beat NIFTY';
  };
  const bBench = withHalves(bhCurve);
  // Reality check without survivorship bias: a real momentum ETF vs a real NIFTY ETF.
  let realEtf = null;
  try {
    const mo = await loadCandles('MOMENTUM.NS', { range: '10y', interval: '1d' });
    const ni = await loadCandles('NIFTYBEES.NS', { range: '10y', interval: '1d' });
    const at = new Map(ni.map((r) => [r.date, r.close]));
    const common = mo.filter((r) => at.has(r.date));
    if (common.length > 250) {
      realEtf = {
        from: common[0].date,
        to: common[common.length - 1].date,
        momentum: stats(common.map((r) => ({ date: r.date, equity: r.close }))),
        nifty: stats(common.map((r) => ({ date: r.date, equity: at.get(r.date) }))),
      };
    }
  } catch {
    /* optional */
  }
  // After tax (Indian rules, tax.mjs) — ₹ capital matters for the LTCG exemption.
  const at = (x) => ({ holdingCagrPct: x.cagrPct, cagrIfSoldPct: x.cagrIfSoldPct, sharpe: x.sharpe, maxDrawdownPct: x.maxDrawdownPct, taxPerYearPct: x.taxPaidPctOfCapitalPerYear });
  const aStart = A[0].start;
  const afterTaxA = {
    benchmark: at(afterTaxSingle(index, aStart, A[0].path.map(() => 1), { capital })),
    strategies: A.map((x) => ({ name: x.name, ...at(afterTaxSingle(index, x.start, x.path, { capital })) })),
  };
  const afterTaxC = C.map((x) => ({ name: x.name, ...at(afterTaxSingle(index, x.start, x.path, { capital })) }));
  const afterTaxB = ['B2', 'B3', 'EW'].map((v) => {
    const r = momentumStrategy(series, index, { variant: v, capital, tax: true });
    return { name: r.name, holdingCagrPct: r.all.cagrPct, cagrIfSoldPct: r.cagrIfSoldPct, sharpe: r.all.sharpe, maxDrawdownPct: r.all.maxDrawdownPct, taxPerYearPct: r.taxPaidPctOfCapitalPerYear };
  });
  const strip = ({ curve, benchCurve, path, ...rest }) => rest;
  return {
    capital,
    universe: { name: universe, source: list.source, used: series.length },
    assumptions: ASSUMPTIONS,
    A: A.map((x) => ({ ...strip(x), verdict: verdict(x, x.benchmark) })),
    C: C.map((x) => ({ ...strip(x), verdict: verdict(x, cBench) })),
    benchmarkC: cBench,
    afterTax: {
      A: afterTaxA,
      C: afterTaxC,
      B: afterTaxB,
      rules: TAX_RULES,
      note: `After Indian tax: STCG ${TAX_RULES.after.stcg * 100}% / LTCG ${TAX_RULES.after.ltcg * 100}% above ₹${TAX_RULES.after.ltcgExemption.toLocaleString('en-IN')} (older rates before ${TAX_RULES.change}), + ${TAX_RULES.cess * 100}% cess; dividends and liquid-fund returns at an assumed ${TAX_RULES.slabRate * 100}% slab. "Still holding" = tax on gains realised so far; "if sold at the end" also pays tax on selling everything on the last day.`,
    },
    B: B.map((x) => ({ ...strip(x), verdict: verdict(x, bBench) })),
    benchmarkB: bBench,
    equalWeight: strip(EW),
    realEtf,
    // Momentum's own contribution = return above the equal-weight portfolio of the SAME (biased) universe.
    momentumExcessPct: B.map((x) => ({ variant: x.variant, cagrAboveEqualWeightPct: x.all.cagrPct - EW.all.cagrPct, sharpeAboveEqualWeight: x.all.sharpe - EW.all.sharpe })),
    curves: {
      A: A[1].curve.filter((_, k) => k % 5 === 0),
      AB: A[1].benchCurve.filter((_, k) => k % 5 === 0),
      B: B[3].curve.filter((_, k) => k % 5 === 0).map((p) => ({ date: p.date, equity: p.equity / capital })),
      BB: bhCurve.filter((_, k) => k % 5 === 0),
    },
    caveats: [
      "B uses today's NIFTY 200 members (survivorship bias: past losers that left the index are missing), so B's results are flattered.",
      'The main tables are before tax; the after-tax table applies Indian capital-gains and slab tax (switching and rebalancing trigger short-term gains that buy-and-hold defers).',
      'Rules were fixed in advance; still, 10 years is one market history. Research only — not investment advice.',
    ],
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cIdx = args.indexOf('--capital');
  const capital = cIdx >= 0 ? Number(args[cIdx + 1]) : 1e6;
  runStrategyTests({ capital })
    .then((r) => {
      const row = (n, s, extra = '') => console.log(`${n.padEnd(46)} ${s.cagrPct.toFixed(1).padStart(6)}%  ${s.volPct.toFixed(1).padStart(5)}%  ${s.sharpe?.toFixed(2).padStart(5)}  ${s.maxDrawdownPct.toFixed(1).padStart(6)}%  ${extra}`);
      const head = () => console.log(`${'strategy'.padEnd(46)}   CAGR    vol  Sharpe   maxDD`);
      const a0 = r.A[0];
      console.log(`\nA · NIFTY trend vs buy-and-hold · ${a0.all.from} → ${a0.all.to} (${a0.all.years.toFixed(1)}y)`);
      head();
      row('NIFTY buy-and-hold (+div)', a0.benchmark.all);
      for (const x of r.A) {
        row(x.name, x.all, `${x.switchesPerYear.toFixed(1)} switches/yr · ${x.pctTimeInvested.toFixed(0)}% invested`);
        console.log(`   halves: Sharpe ${x.firstHalf.sharpe.toFixed(2)} / ${x.secondHalf.sharpe.toFixed(2)} vs NIFTY ${x.benchmark.firstHalf.sharpe.toFixed(2)} / ${x.benchmark.secondHalf.sharpe.toFixed(2)} · maxDD ${x.firstHalf.maxDrawdownPct.toFixed(0)}% / ${x.secondHalf.maxDrawdownPct.toFixed(0)}% vs ${x.benchmark.firstHalf.maxDrawdownPct.toFixed(0)}% / ${x.benchmark.secondHalf.maxDrawdownPct.toFixed(0)}% → ${x.verdict}`);
      }
      console.log(`\nC · volatility-targeted NIFTY · ${r.benchmarkC.all.from} → ${r.benchmarkC.all.to}`);
      head();
      row('NIFTY buy-and-hold (+div)', r.benchmarkC.all);
      for (const x of r.C) {
        row(x.name, x.all, `${x.avgExposurePct.toFixed(0)}% avg exposure · turnover ${x.turnoverPerYear.toFixed(1)}×/yr`);
        console.log(`   halves: Sharpe ${x.firstHalf.sharpe.toFixed(2)} / ${x.secondHalf.sharpe.toFixed(2)} vs NIFTY ${r.benchmarkC.firstHalf.sharpe.toFixed(2)} / ${r.benchmarkC.secondHalf.sharpe.toFixed(2)} → ${x.verdict}`);
      }
      const t = r.afterTax;
      console.log(`\nAFTER TAX · ₹${r.capital.toLocaleString('en-IN')} · CAGR still holding / if sold at the end · tax per year · maxDD`);
      const trow = (n, x) => console.log(`${n.padEnd(46)} ${x.holdingCagrPct.toFixed(1).padStart(5)}% / ${x.cagrIfSoldPct.toFixed(1).padStart(5)}%   tax ${x.taxPerYearPct.toFixed(2)}%/yr   maxDD ${x.maxDrawdownPct.toFixed(1)}%`);
      trow('NIFTY buy-and-hold (A window)', t.A.benchmark);
      for (const x of [...t.A.strategies, ...t.C, ...t.B]) trow(x.name, x);
      const b = r.B[0];
      console.log(`\nB · momentum on ${r.universe.name} (${r.universe.used} stocks) · ₹${r.capital.toLocaleString('en-IN')} · ${b.all.from} → ${b.all.to} (${b.all.years.toFixed(1)}y)`);
      head();
      row('NIFTY buy-and-hold (+div)', r.benchmarkB.all);
      row(r.equalWeight.name, r.equalWeight.all, `costs ${r.equalWeight.chargesPctPerYear.toFixed(2)}%/yr`);
      for (const x of r.B) {
        row(x.name, x.all, `costs ${x.chargesPctPerYear.toFixed(2)}%/yr · turnover ${x.turnoverPerYear.toFixed(1)}×/yr`);
        console.log(`   halves: Sharpe ${x.firstHalf.sharpe.toFixed(2)} / ${x.secondHalf.sharpe.toFixed(2)} vs NIFTY ${r.benchmarkB.firstHalf.sharpe.toFixed(2)} / ${r.benchmarkB.secondHalf.sharpe.toFixed(2)} → ${x.verdict}`);
      }
      console.log('\nMomentum above the equal-weight portfolio of the same stocks (removes the shared survivorship bias):');
      for (const m of r.momentumExcessPct) console.log(`   ${m.variant}: CAGR ${m.cagrAboveEqualWeightPct >= 0 ? '+' : ''}${m.cagrAboveEqualWeightPct.toFixed(1)} pts · Sharpe ${m.sharpeAboveEqualWeight >= 0 ? '+' : ''}${m.sharpeAboveEqualWeight.toFixed(2)}`);
      console.log(`\n${r.caveats.join('\n')}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
