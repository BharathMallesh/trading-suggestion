// F&O risk check (library): a pre-trade check that blocks the avoidable losses — positions too big or
// too unprotected for the account. For a NIFTY weekly trade on today's real NSE option prices it replays
// every NIFTY move of the same length since 2010 and reports: chance of profit at expiry, the loss in a
// 1-in-20 and a 1-in-100 week, the worst ever, the margin, and a verdict. Rule: a 1-in-100 week may cost
// at most `maxLossPct` (2%) of the account; otherwise it says how many lots would fit, or to add wings.
// It cannot make a trade win — it keeps one bad week from doing serious damage. Not advice.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candles } from '../market-data.mjs';
import { nearest, legCost, wingCost, LOT_NOW, marginPct } from './fo-strangle.mjs';
import { foStocksDir } from './vol-premium.mjs';
import { outlookFor, loadUpdownTable, loadUpdownLive, features } from './updown-outlook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FO_DIR = () => process.env.FO_BHAV_DIR || join(HERE, 'data', 'fo-bhav');
export const STRATEGIES = {
  strangle: 'Sell a strangle (call + put, no protection)',
  condor: 'Iron condor (sell a strangle, buy wings)',
  'buy-call': 'Buy a call',
  'buy-put': 'Buy a put',
};

/** The latest cached NSE day with a NIFTY chain: { date, spot, expiry, chain }. */
export function latestChain() {
  if (!existsSync(FO_DIR())) return null;
  for (const f of readdirSync(FO_DIR()).filter((x) => x.endsWith('.json')).sort().reverse()) {
    try {
      const d = JSON.parse(readFileSync(join(FO_DIR(), f), 'utf8'));
      const date = f.slice(0, 10);
      const expiry = d && Object.keys(d.expiries || {}).filter((e) => e > date).sort()[0];
      if (expiry && d.underlying > 0) return { date, spot: d.underlying, expiry, chain: d.expiries[expiry] };
    } catch {
      /* skip a bad file */
    }
  }
  return null;
}

/** The latest cached chain for a stock (nearest monthly expiry): { date, spot, expiry, chain, lot } or null. */
export function latestStockChain(symbol) {
  const dir = foStocksDir();
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'))[symbol];
      const date = f.slice(0, 10);
      const expiry = o && Object.keys(o.expiries).filter((e) => e > date).sort()[0];
      if (expiry && o.underlying > 0 && o.lot > 0) return { date, spot: o.underlying, expiry, chain: o.expiries[expiry], lot: o.lot };
    } catch {
      /* skip */
    }
  }
  return null;
}
/** Symbols with option chains in the latest stock file. */
export function stockSymbols() {
  const dir = foStocksDir();
  if (!existsSync(dir)) return [];
  const f = readdirSync(dir).filter((x) => x.endsWith('.json')).sort().pop();
  try {
    return f ? Object.keys(JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort() : [];
  } catch {
    return [];
  }
}

/** Trading sessions between two dates (weekdays; close enough for the move length). */
export const sessionsBetween = (a, b) => {
  let n = 0;
  for (let t = Date.parse(`${a}T00:00:00Z`) + 86400000; t <= Date.parse(`${b}T00:00:00Z`); t += 86400000) if (new Date(t).getUTCDay() % 6) n++;
  return Math.max(1, n);
};

/** Every n-session NIFTY move since 2010 (overlapping windows). */
export function moves(niftyRows, n) {
  const c = niftyRows.filter((x) => x.date >= '2010-01-01').map((x) => x.close);
  const out = [];
  for (let i = 0; i + n < c.length; i++) out.push(c[i + n] / c[i] - 1);
  return out;
}

/** Legs (per unit, + bought / − sold) for a strategy on a chain. */
export function legsFor(strategy, { spot, chain }, { distancePct = 2, wing = 500 } = {}) {
  const ck = nearest(chain, spot * (1 + distancePct / 100), 'CE');
  const pk = nearest(chain, spot * (1 - distancePct / 100), 'PE');
  const px = (k, t) => chain[k]?.[t];
  if (strategy === 'buy-call') return [{ k: ck, t: 'CE', q: 1, p: px(ck, 'CE') }];
  if (strategy === 'buy-put') return [{ k: pk, t: 'PE', q: 1, p: px(pk, 'PE') }];
  const legs = [{ k: ck, t: 'CE', q: -1, p: px(ck, 'CE') }, { k: pk, t: 'PE', q: -1, p: px(pk, 'PE') }];
  if (strategy === 'condor') {
    const wc = nearest(chain, ck + wing, 'CE');
    const wp = nearest(chain, pk - wing, 'PE');
    legs.push({ k: wc, t: 'CE', q: 1, p: px(wc, 'CE') }, { k: wp, t: 'PE', q: 1, p: px(wp, 'PE') });
  }
  return legs;
}

/** Points per unit at expiry for a final price, after charges. For a stock: its own lot and wider slippage. */
export function payoff(legs, settle, date, stock = null) {
  let pts = 0;
  for (const l of legs) {
    const intr = l.t === 'CE' ? Math.max(settle - l.k, 0) : Math.max(l.k - settle, 0);
    const cost = stock
      ? (20 / stock.lot) * 1.18 + l.p * (l.q < 0 ? 0.001 : 0.00003) + l.p * 0.0003503 * 1.18 + Math.max(l.p * 0.01, 0.1)
      : l.q < 0 ? legCost(l.p, date) : wingCost(l.p, date);
    pts += l.q * (intr - l.p) - cost - (l.q > 0 ? intr * 0.00125 : 0);
  }
  return pts;
}

const q = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))];

export function riskCheck({ strategy = 'strangle', account = 500000, lots = 1, distancePct = 2, wing = 500, wingPct = 4, maxLossPct = 2, chain = latestChain(), niftyRows, symbol = 'NIFTY' }) {
  const stock = symbol !== 'NIFTY' ? chain : null; // a stock chain carries its own lot
  if (stock) wing = (chain.spot * wingPct) / 100; // wings for a stock: a share of its price, not NIFTY points
  if (!STRATEGIES[strategy]) throw new Error('Unknown strategy.');
  if (!chain) throw new Error('No NSE option prices cached yet (they arrive with the evening job).');
  const legs = legsFor(strategy, chain, { distancePct, wing });
  if (legs.some((l) => l.k == null || !(l.p > 0))) throw new Error('No traded price for one of the strikes; try another distance.');
  const n = sessionsBetween(chain.date, chain.expiry);
  const ms = moves(niftyRows, n);
  const lot = stock ? chain.lot : LOT_NOW;
  const per = ms.map((m) => payoff(legs, chain.spot * (1 + m), chain.date, stock) * lot).sort((a, b) => a - b); // ₹ for 1 lot
  const sold = strategy === 'strangle' || strategy === 'condor';
  const credit = -legs.reduce((a, l) => a + l.q * l.p, 0); // + received, − paid
  const definedLoss = strategy === 'condor' ? (Math.max(legs[2].k - legs[0].k, legs[1].k - legs[3].k) - credit) * lot : strategy.startsWith('buy') ? -credit * lot : null;
  const margin = strategy === 'strangle' ? (chain.spot * lot * (stock ? 20 : marginPct(chain.date))) / 100 : strategy === 'condor' ? definedLoss : -credit * lot;
  const bad20 = q(per, 0.05);
  const bad100 = q(per, 0.01);
  const allowed = (account * maxLossPct) / 100;
  const fitLots = bad100 < 0 ? Math.floor(allowed / -bad100) : lots;
  const total = (x) => x * lots;
  const ok = -total(bad100) <= allowed && margin * lots <= account * 0.5;
  const tips = [];
  if (!ok && fitLots >= 1) tips.push(`At most ${fitLots} lot${fitLots === 1 ? '' : 's'} keeps a 1-in-100 bad case within ${maxLossPct}% of the account.`);
  if (!ok && fitLots < 1) tips.push(`Even 1 lot can lose more than ${maxLossPct}% of this account in a 1-in-100 bad case${strategy === 'strangle' ? ' — add wings (iron condor) or skip' : ' — use a smaller trade or skip'}.`);
  if (strategy === 'strangle') tips.push(stock ? 'A sold strangle on a single stock has no loss limit — results, news or a block deal can move it 10–20% in a day. Wings (iron condor) cap it.' : 'A sold strangle has no loss limit: one 5% week cost −₹38,151 a lot on 3 Nov 2026. Wings (iron condor) cap it.');
  if (stock) tips.push('Check the results date and NSE\'s F&O ban list before trading a stock option; stock options are less liquid than NIFTY\'s (wider spreads).');
  if (margin * lots > account * 0.5) tips.push('The margin would tie up more than half the account; a gap could force the broker to close it.');
  return {
    symbol, date: chain.date, expiry: chain.expiry, spot: chain.spot, sessions: n, samples: ms.length, strategy, label: STRATEGIES[strategy], lots, lot, account,
    legs: legs.map((l) => ({ strike: l.k, type: l.t, side: l.q < 0 ? 'sell' : 'buy', price: l.p })),
    premium: credit * lot * lots, sold,
    chanceOfProfit: per.filter((x) => x > 0).length / per.length,
    typical: total(q(per, 0.5)), bad20: total(bad20), bad100: total(bad100), worstEver: total(per[0]), best: total(per.at(-1)),
    definedMaxLoss: definedLoss != null ? definedLoss * lots : null, margin: margin * lots,
    allowedLoss: allowed, fitLots, ok,
    verdict: ok ? `OK for this account: a 1-in-100 bad case (to expiry) would cost about ₹${Math.round(-total(bad100)).toLocaleString('en-IN')} (${((-total(bad100) / account) * 100).toFixed(1)}%), within the ${maxLossPct}% limit.` : `Too big for this account: a 1-in-100 bad case (to expiry) would cost about ₹${Math.round(-total(bad100)).toLocaleString('en-IN')} (${((-total(bad100) / account) * 100).toFixed(1)}% — limit ${maxLossPct}%).`,
    tips,
    note: `${stock ? `${symbol}` : 'NIFTY'} closing option prices from NSE (${chain.date}) for the ${chain.expiry} expiry, held to expiry; every ${n}-session ${stock ? `${symbol}` : 'NIFTY'} move since 2010 (${ms.length} cases) replayed, after charges${stock ? ' (stock margin assumed ≈20% of the position; check your broker)' : ''}. A guard against oversized trades, not a forecast — no rule here makes F&O profitable; the app's tests found these trades about break-even at best.`,
  };
}

/**
 * The Up/Down lean shown next to the risk: the stock's STRONG / NEUTRAL / WEAK label with how often stocks
 * with that label rose over the next month (2018→), or NIFTY's position against its 200-day average.
 * A small 1–3 month tilt, not a call on the option's direction.
 */
export async function leanFor(symbol, { niftyRows = null, live = loadUpdownLive(), table = loadUpdownTable(), loadCandles = candles } = {}) {
  if (symbol === 'NIFTY') {
    if (!niftyRows?.length) return null;
    const f = features(niftyRows.map((x) => x.close), niftyRows.length - 1);
    const o = table?.nifty?.[f.above200 ? 'above' : 'below'];
    return { symbol, label: f.above200 ? 'above its 200-day average' : 'below its 200-day average', up1m: o?.['1m']?.up ?? null, avg1m: o?.['1m']?.avg ?? null, baseUp1m: table?.nifty?.all?.['1m']?.up ?? null };
  }
  const o = await outlookFor(symbol, { live, table, loadCandles });
  return { symbol, label: o.label, why: o.why, up1m: o.odds?.late?.['1m']?.up ?? null, avg1m: o.odds?.late?.['1m']?.avg ?? null, baseUp1m: o.base?.late?.['1m']?.up ?? null };
}

const histCache = new Map();
export async function riskCheckLive(opts, { loadCandles = candles } = {}) {
  const symbol = String(opts.symbol || 'NIFTY').toUpperCase().replace(/\.NS$/, '');
  const yahoo = symbol === 'NIFTY' ? '^NSEI' : `${symbol}.NS`;
  const c = histCache.get(yahoo);
  if (!c || Date.now() - c.at > 6 * 3600_000) {
    histCache.set(yahoo, { at: Date.now(), rows: (await loadCandles(yahoo, { period1: Math.floor(Date.parse('2009-06-01') / 1000), interval: '1d' })).filter((x) => x.close > 0) });
  }
  const rows = histCache.get(yahoo).rows;
  let lean = null;
  try {
    lean = await leanFor(symbol, { niftyRows: rows, loadCandles });
  } catch {
    lean = null; // the lean is optional
  }
  if (symbol === 'NIFTY') return { ...riskCheck({ ...opts, symbol, niftyRows: rows }), lean };
  const chain = latestStockChain(symbol);
  if (!chain) throw new Error(`No option prices for ${symbol}: it may not be in F&O (check the list), or the evening job hasn't saved them yet.`);
  return { ...riskCheck({ ...opts, symbol, chain, niftyRows: rows }), lean };
}
