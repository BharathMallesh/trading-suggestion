// My portfolio — tax & risk for the user's ACTUAL holdings (entered by hand,
// stored only on this Mac in paper-bot/data/holdings.json, included in backups).
// Uses only the parts of the app with demonstrated value: Indian tax rules,
// Indian charges, volatility forecasts and calibrated big-move odds. No
// direction calls, no buy/sell recommendations — arithmetic and risk facts.
//
//   tax      unrealised short/long-term gains per lot (FIFO), tax if sold today
//   harvest  LTCG exemption (₹1.25 lakh/yr) still unused this financial year and
//            which long-term lots would use it (sell & rebuy), net of charges;
//            losses that could offset gains already booked this year
//   risk     typical day / week move in ₹, chance of a weekly loss > 3/5/10%,
//            losses in past crises at today's weights (beta proxy if a stock
//            has no data for that period)
//   spread   weight per stock and per industry, with concentration flags
// Research / education only — not tax or investment advice; check with a tax
// professional before acting.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candles } from '../market-data.mjs';
import { TaxLedger, TAX_RULES, fyOf, longTerm } from './tax.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { harForecast } from './volatility.mjs';
import { ewmaPath, standardisedMoves, tailProb, calibrated, loadBigMoveEval } from './big-move.mjs';
import { loadIndexList } from './ranking.mjs';
import { badRequest, mapLimit, writeJsonAtomic, readJsonSafe, SYMBOL_RE } from '../util.mjs';

const PATH = () => process.env.HOLDINGS_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'holdings.json');
const istDate = (d = new Date()) => new Date(d.getTime() + 19800_000).toISOString().slice(0, 10);

export const CRISIS_SCENARIOS = [
  { name: '2008 crash (Jan 2008 – Mar 2009)', from: '2008-01-08', to: '2009-03-09' },
  { name: 'COVID crash (Feb – Mar 2020)', from: '2020-02-19', to: '2020-03-23' },
  { name: '2022 rate hikes (Oct 2021 – Jun 2022)', from: '2021-10-18', to: '2022-06-17' },
  { name: '2024–25 correction (Sep 2024 – Mar 2025)', from: '2024-09-26', to: '2025-03-03' },
];
export const FLAGS = { stockPct: 20, sectorPct: 35 };

// ------------------------------------------------------------------ state ---

export function loadHoldings() {
  return readJsonSafe(PATH(), { lots: [], realized: {} });
}
function save(st) {
  writeJsonAtomic(PATH(), st);
}

const cleanSymbol = (s) => {
  const sym = String(s || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) throw badRequest('Symbol: up to 20 letters, digits or ^&.-= characters, e.g. RELIANCE.NS');
  return /\.(NS|BO)$/.test(sym) || sym.startsWith('^') ? sym : `${sym}.NS`;
};

/** Add one purchase lot. */
export function addLot({ symbol, qty, price, date, now = new Date() }) {
  const q = Number(qty);
  const p = Number(price);
  const d = String(date || '').trim();
  if (!(Number.isInteger(q) && q > 0 && q <= 1e7)) throw badRequest('Quantity must be a whole number of shares (1 – 1 crore).');
  if (!(p > 0 && p < 1e7)) throw badRequest('Buy price must be a positive number.');
  if (!/^\d{4}-\d\d-\d\d$/.test(d) || Number.isNaN(Date.parse(d)) || d < '1990-01-01' || d > istDate(now)) throw badRequest('Buy date must be YYYY-MM-DD, not in the future.');
  const st = loadHoldings();
  if (st.lots.length >= 500) throw badRequest('At most 500 lots.');
  const lot = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, symbol: cleanSymbol(symbol), qty: q, price: p, date: d };
  st.lots.push(lot);
  save(st);
  return lot;
}

export function removeLot(id) {
  const st = loadHoldings();
  const n = st.lots.length;
  st.lots = st.lots.filter((l) => l.id !== String(id));
  if (st.lots.length === n) throw badRequest('No lot with that id.');
  save(st);
  return { removed: id };
}

/** Gains already booked (realised) in the current financial year, for the exemption and set-off. */
export function setRealized({ stcg = 0, ltcg = 0, now = new Date() }) {
  const s = Number(stcg);
  const l = Number(ltcg);
  if (!Number.isFinite(s) || !Number.isFinite(l) || Math.abs(s) > 1e10 || Math.abs(l) > 1e10) throw badRequest('Realised gains must be numbers (₹; losses negative).');
  const st = loadHoldings();
  st.realized = { fy: fyOf(istDate(now)), stcg: s, ltcg: l };
  save(st);
  return st.realized;
}

// ------------------------------------------------------------- analysis ---

const roundTrip = (value) => {
  const c = (side) => orderCharges({ side, value, product: 'delivery', costs: DEFAULT_COSTS }).total;
  return c('sell') + c('buy') + (value * 2 * DEFAULT_COSTS.slippagePct) / 100;
};

/** This FY's total tax if `sell` lots are sold today on top of gains already booked. */
export function taxWith(lots, sell, prices, realized, today) {
  const L = new TaxLedger();
  for (const l of lots) L.buy(l.symbol, l.qty, l.price, l.date);
  const twoYrsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  if (realized?.stcg) realized.stcg > 0 ? (L.buy('_ST', 1, 0, today), L.sell('_ST', 1, realized.stcg, today)) : (L.buy('_ST', 1, -realized.stcg, today), L.sell('_ST', 1, 0, today));
  if (realized?.ltcg) realized.ltcg > 0 ? (L.buy('_LT', 1, 0, twoYrsAgo), L.sell('_LT', 1, realized.ltcg, today)) : (L.buy('_LT', 1, -realized.ltcg, twoYrsAgo), L.sell('_LT', 1, 0, today));
  // sell the chosen lots FIFO per symbol (sell whole holdings of the symbol up to the chosen qty)
  const qtyBySym = {};
  for (const l of sell) qtyBySym[l.symbol] = (qtyBySym[l.symbol] || 0) + l.qty;
  for (const [sym, q] of Object.entries(qtyBySym)) if (prices[sym]) L.sell(sym, q, prices[sym], today);
  return L.settle(fyOf(today));
}

/** Tax on selling everything today (current FY, including gains already booked). */
export function taxIfSoldAll(lots, prices, realized, today) {
  const L = new TaxLedger();
  for (const l of lots) L.buy(l.symbol, l.qty, l.price, l.date);
  // gains already booked this FY, as synthetic same-year trades (ST: bought today; LT: bought 2 years ago)
  const twoYrsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  if (realized?.stcg) realized.stcg > 0 ? (L.buy('_ST', 1, 0, today), L.sell('_ST', 1, realized.stcg, today)) : (L.buy('_ST', 1, -realized.stcg, today), L.sell('_ST', 1, 0, today));
  if (realized?.ltcg) realized.ltcg > 0 ? (L.buy('_LT', 1, 0, twoYrsAgo), L.sell('_LT', 1, realized.ltcg, today)) : (L.buy('_LT', 1, -realized.ltcg, twoYrsAgo), L.sell('_LT', 1, 0, today));
  const base = (() => {
    const B = TaxLedger.from(L.toJSON());
    return B.settle(fyOf(today)); // tax on what's already booked
  })();
  for (const l of lots) if (prices[l.symbol]) L.sell(l.symbol, l.qty, prices[l.symbol], today);
  return Math.max(0, L.settle(fyOf(today)) - base);
}

/**
 * LTCG harvesting: fill the unused exemption with long-term gains, selling
 * each stock's OLDEST shares first (FIFO, as demat sales are matched) and
 * stopping at the first short-term lot. Returns suggested sells.
 */
export function harvestPlan(lots, prices, remainingExemption) {
  const bySym = new Map();
  for (const l of [...lots].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!bySym.has(l.symbol)) bySym.set(l.symbol, []);
    bySym.get(l.symbol).push(l);
  }
  const today = istDate();
  const chunks = [];
  for (const [sym, ls] of bySym) {
    const px = prices[sym];
    if (!px) continue;
    for (const l of ls) {
      if (!longTerm(l.date, today)) break; // FIFO: can't reach later lots without selling this one
      const per = px - l.price;
      if (per <= 0) break; // selling a loss lot first would offset the gain we want to bank
      chunks.push({ symbol: sym, lotId: l.id, qty: l.qty, gainPerShare: per, price: px, ratio: per / px });
    }
  }
  // prefer the most gain per rupee sold (cheapest to harvest), symbol order kept within a stock
  chunks.sort((a, b) => b.ratio - a.ratio);
  let left = remainingExemption;
  const sells = [];
  for (const c of chunks) {
    if (left <= 0) break;
    const q = Math.min(c.qty, Math.floor(left / c.gainPerShare));
    if (q <= 0) continue;
    sells.push({ symbol: c.symbol, qty: q, gain: q * c.gainPerShare, value: q * c.price });
    left -= q * c.gainPerShare;
  }
  // merge per symbol
  const merged = {};
  for (const s of sells) {
    const m = (merged[s.symbol] ||= { symbol: s.symbol, qty: 0, gain: 0, value: 0 });
    m.qty += s.qty;
    m.gain += s.gain;
    m.value += s.value;
  }
  const list = Object.values(merged).map((m) => ({ ...m, charges: roundTrip(m.value) }));
  const harvested = list.reduce((a, m) => a + m.gain, 0);
  const charges = list.reduce((a, m) => a + m.charges, 0);
  const taxSaved = harvested * TAX_RULES.after.ltcg * (1 + TAX_RULES.cess);
  return { sells: list, harvested, charges, taxSaved, netBenefit: taxSaved - charges };
}

/** Weighted portfolio daily log returns on common dates (current weights). */
function portfolioReturns(series, weights) {
  const dateSets = series.map((s) => new Set(s.rows.map((r) => r.date)));
  const common = series[0].rows.map((r) => r.date).filter((d) => dateSets.every((ds) => ds.has(d)));
  const idx = series.map((s) => new Map(s.rows.map((r, i) => [r.date, i])));
  const out = [];
  for (let k = 1; k < common.length; k++) {
    let ret = 0;
    series.forEach((s, j) => {
      const a = s.rows[idx[j].get(common[k - 1])].close;
      const b = s.rows[idx[j].get(common[k])].close;
      ret += weights[j] * (b / a - 1);
    });
    out.push(Math.log(1 + ret));
  }
  return { dates: common.slice(1), r: out };
}

function beta(rows, nifty) {
  const nm = new Map(nifty.map((r, i) => [r.date, i]));
  const xs = [];
  const ys = [];
  for (let i = Math.max(1, rows.length - 500); i < rows.length; i++) {
    const j = nm.get(rows[i].date);
    const jp = nm.get(rows[i - 1].date);
    if (j == null || jp == null) continue;
    xs.push(nifty[j].close / nifty[jp].close - 1);
    ys.push(rows[i].close / rows[i - 1].close - 1);
  }
  if (xs.length < 100) return 1;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let vx = 0;
  xs.forEach((x, i) => {
    cov += (x - mx) * (ys[i] - my);
    vx += (x - mx) ** 2;
  });
  return vx ? cov / vx : 1;
}

const closeOn = (rows, date, after = true) => {
  const r = after ? rows.find((x) => x.date >= date) : [...rows].reverse().find((x) => x.date <= date);
  return r ? r : null;
};

/** Full analysis of the saved holdings. */
export async function analyzeHoldings({ loadCandles = candles, now = new Date() } = {}) {
  const st = loadHoldings();
  const today = istDate(now);
  const fy = fyOf(today);
  const realized = st.realized?.fy === fy ? st.realized : { fy, stcg: 0, ltcg: 0 };
  if (!st.lots.length) return { lots: [], realized, empty: true, note: 'Add your holdings (symbol, quantity, buy price, buy date) to see tax and risk.' };
  const symbols = [...new Set(st.lots.map((l) => l.symbol))];
  const p1 = Date.UTC(2007, 0, 1) / 1000;
  const loaded = await mapLimit(symbols, 4, async (sym) => {
    try {
      return { sym, rows: (await loadCandles(sym, { period1: p1, interval: '1d' })).filter((r) => r.close > 0) };
    } catch (err) {
      return { sym, rows: [], error: err.message };
    }
  });
  const data = Object.fromEntries(loaded.map((x) => [x.sym, x]));
  const prices = Object.fromEntries(loaded.filter((x) => x.rows.length).map((x) => [x.sym, x.rows[x.rows.length - 1].close]));
  let industries = {};
  try {
    industries = (await loadIndexList('nifty500')).industries || {};
  } catch {
    /* sectors unknown */
  }

  // --- per-lot tax view
  const lots = st.lots.map((l) => {
    const px = prices[l.symbol] ?? null;
    const value = px != null ? px * l.qty : null;
    const gain = px != null ? (px - l.price) * l.qty : null;
    const lt = longTerm(l.date, today);
    const ltOn = (() => {
      const d = new Date(`${l.date}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate() + 1)).toISOString().slice(0, 10);
    })();
    return { ...l, last: px, value, gain, gainPct: gain != null ? (gain / (l.price * l.qty)) * 100 : null, term: lt ? 'long' : 'short', longTermFrom: lt ? null : ltOn, error: data[l.symbol]?.error || null };
  });
  const priced = lots.filter((l) => l.value != null);
  const totalValue = priced.reduce((a, l) => a + l.value, 0);
  const totalCost = priced.reduce((a, l) => a + l.price * l.qty, 0);
  const sum = (term, sign) => priced.filter((l) => l.term === term && Math.sign(l.gain) === sign).reduce((a, l) => a + l.gain, 0);
  const tax = {
    unrealisedShortGain: sum('short', 1),
    unrealisedShortLoss: sum('short', -1),
    unrealisedLongGain: sum('long', 1),
    unrealisedLongLoss: sum('long', -1),
    taxIfSoldAllToday: taxIfSoldAll(priced, prices, realized, today),
    soonLongTerm: lots.filter((l) => l.term === 'short' && l.gain > 0 && (Date.parse(l.longTermFrom) - Date.parse(today)) / 86400000 <= 60)
      .map((l) => ({ symbol: l.symbol, qty: l.qty, gain: l.gain, longTermFrom: l.longTermFrom, taxSavedByWaiting: l.gain * (TAX_RULES.after.stcg - TAX_RULES.after.ltcg) * (1 + TAX_RULES.cess) })),
  };

  // --- harvesting
  const usedExemption = Math.max(0, realized.ltcg || 0);
  const remainingExemption = Math.max(0, TAX_RULES.after.ltcgExemption - usedExemption);
  const harvest = { exemption: TAX_RULES.after.ltcgExemption, usedThisYear: usedExemption, remaining: remainingExemption, ...harvestPlan(priced, prices, remainingExemption) };
  // Loss harvesting: tax this year on gains already booked, with vs without
  // selling every lot that's at a loss (set-off rules applied by the ledger:
  // short-term losses offset any gain, long-term losses only long-term gains).
  // FIFO: only symbols whose ENTIRE holding is at a loss are counted, since
  // selling part would release the oldest lots first.
  const symLoss = {};
  for (const l of priced) (symLoss[l.symbol] ||= []).push(l);
  const lossLots = Object.values(symLoss).filter((ls) => ls.every((l) => l.gain < 0)).flat();
  const bookedTax = taxWith(priced, [], prices, realized, today);
  const withLosses = taxWith(priced, lossLots, prices, realized, today);
  const lossHarvest = {
    lossAvailable: -lossLots.reduce((a, l) => a + l.gain, 0),
    taxOnBookedGains: bookedTax,
    taxSavedThisYear: Math.max(0, bookedTax - withLosses),
    charges: lossLots.reduce((a, l) => a + roundTrip(l.value), 0),
    lots: lossLots.map((l) => ({ symbol: l.symbol, qty: l.qty, loss: -l.gain, term: l.term })),
    note: 'Losses not used this year can be carried forward 8 years if you file your return on time.',
  };

  // --- spread
  const bySym = {};
  for (const l of priced) bySym[l.symbol] = (bySym[l.symbol] || 0) + l.value;
  const stocks = Object.entries(bySym).map(([s, v]) => ({ symbol: s, value: v, weightPct: (v / totalValue) * 100, industry: industries[s] || 'Other / not in NIFTY 500' })).sort((a, b) => b.value - a.value);
  const sectors = {};
  for (const s of stocks) sectors[s.industry] = (sectors[s.industry] || 0) + s.weightPct;
  const flags = [
    ...stocks.filter((s) => s.weightPct > FLAGS.stockPct).map((s) => `${s.symbol} is ${s.weightPct.toFixed(0)}% of the portfolio (above ${FLAGS.stockPct}%)`),
    ...Object.entries(sectors).filter(([k, w]) => w > FLAGS.sectorPct && !k.startsWith('Other')).map(([k, w]) => `${k} is ${w.toFixed(0)}% of the portfolio (above ${FLAGS.sectorPct}%)`),
  ];

  // --- risk (current weights)
  let risk = null;
  const withData = stocks.filter((s) => data[s.symbol]?.rows.length > 300);
  if (withData.length) {
    const wsum = withData.reduce((a, s) => a + s.value, 0);
    const series = withData.map((s) => ({ sym: s.symbol, rows: data[s.symbol].rows.slice(-1000) }));
    const { r } = portfolioReturns(series, withData.map((s) => s.value / wsum));
    if (r.length > 300) {
      const ev = loadBigMoveEval();
      const sig = ewmaPath(r);
      const s1 = harForecast(r, 1);
      const s5 = harForecast(r, 5);
      const z5 = standardisedMoves(r, sig, 5, r.length);
      const cal5 = ev?.horizons?.['5d']?.calibration || { scale: 1, shrink: 0 };
      const lossOdds = [3, 5, 10].map((k) => {
        // past-year frequency of a 5-day loss bigger than k%, for the calibration blend
        let hit = 0;
        let n = 0;
        for (let j = Math.max(0, r.length - 250); j + 5 <= r.length; j++) {
          n++;
          if (Math.exp(r.slice(j, j + 5).reduce((a, x) => a + x, 0)) - 1 < -k / 100) hit++;
        }
        const pastYear = n ? (hit + 0.5) / (n + 1) : null;
        return { lossPct: k, prob: calibrated(z5, s5, 5, k, pastYear ? pastYear * 2 : null, cal5).down, pastYear, rupees: (totalValue * k) / 100 };
      });
      risk = {
        coveredValuePct: (wsum / totalValue) * 100,
        typicalDay: { pct: s1 * 100, rupees: totalValue * s1 },
        typicalWeek: { pct: s5 * Math.sqrt(5) * 100, rupees: totalValue * s5 * Math.sqrt(5) },
        weeklyLossOdds: lossOdds,
        annualVolPct: s5 * Math.sqrt(252) * 100,
      };
    }
  }

  // --- crisis scenarios at today's weights
  let scenarios = [];
  try {
    const nifty = (await loadCandles('^NSEI', { period1: p1, interval: '1d' })).filter((x) => x.close > 0);
    scenarios = CRISIS_SCENARIOS.map((c) => {
      const n0 = closeOn(nifty, c.from);
      const n1 = closeOn(nifty, c.to, false);
      if (!n0 || !n1) return null;
      const niftyRet = n1.close / n0.close - 1;
      let loss = 0;
      let proxied = 0;
      for (const s of stocks) {
        const rows = data[s.symbol]?.rows || [];
        const a = rows.length && rows[0].date <= c.from ? closeOn(rows, c.from) : null;
        const b = a ? closeOn(rows, c.to, false) : null;
        let ret;
        if (a && b && b.date >= c.from) ret = b.close / a.close - 1;
        else {
          ret = beta(rows, nifty) * niftyRet; // no data for that period: NIFTY × the stock's beta
          proxied += s.value;
        }
        loss += s.value * ret;
      }
      return { ...c, niftyPct: niftyRet * 100, portfolioPct: (loss / totalValue) * 100, rupees: loss, proxiedPct: (proxied / totalValue) * 100 };
    }).filter(Boolean);
  } catch {
    /* no NIFTY data: skip scenarios */
  }

  return {
    asOf: today,
    fy,
    realized,
    totals: { value: totalValue, cost: totalCost, gain: totalValue - totalCost, gainPct: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : null },
    lots,
    tax,
    harvest,
    lossHarvest,
    stocks,
    sectors: Object.entries(sectors).map(([k, w]) => ({ industry: k, weightPct: w })).sort((a, b) => b.weightPct - a.weightPct),
    flags,
    risk,
    scenarios,
    note: 'Research / education only — not tax or investment advice. Tax uses FIFO lots and current rates (STCG 20%, LTCG 12.5% above ₹1.25 lakh, + 4% cess); surcharge and grandfathering are not modelled. Harvesting sells and rebuys the same shares to reset their cost; check with a tax professional first.',
  };
}
