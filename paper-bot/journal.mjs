// Trade planner, journal, daily loss limit and price alerts (library).
//
// Plan    Before a trade: shares to buy for a fixed % risk, real charges, loss at
//         the stop and gain at the target after charges, today's chance of a move
//         as big as the stop distance (big-move odds), and a rules check.
// Journal Save the plan, close it later with the exit price: net ₹ after charges
//         and R (result ÷ planned risk). Stats: win rate, average win / loss,
//         expectancy, profit factor, by setup, and trades that broke the rules.
// Limit   Today's realised result vs a daily loss limit (e.g. −2% of capital);
//         a Mac notification once when it is hit.
// Alerts  Price levels per stock; checked every 5 minutes while NSE is open
//         against the 5-minute highs / lows since the last check, so a quick
//         spike between checks is not missed. A Mac notification when crossed.
//
// The app never places orders: trades are done in your broker app and recorded
// here. Stored only on this Mac. Research / education — not investment advice.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candles } from '../market-data.mjs';
import { orderCharges, DEFAULT_COSTS } from './costs.mjs';
import { bigMove } from './big-move.mjs';
import { badRequest, readJsonSafe, writeJsonAtomic, withFileLock, SYMBOL_RE } from '../util.mjs';

const PATH = () => process.env.JOURNAL_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'journal.json');
export const DEFAULT_SETTINGS = { capital: 100000, riskPct: 1, dailyLossPct: 2, maxTradesPerDay: 2, minRR: 1.5 };
export const SETUPS = ['VWAP pullback', 'Breakout', 'Trend follow', 'Reversal', 'Options', 'Other'];
const MAX_TRADES = 5000;
const MAX_ALERTS = 200;

const istNow = (now = new Date()) => {
  const t = new Date(now.getTime() + 19800_000);
  return { date: t.toISOString().slice(0, 10), time: t.toISOString().slice(11, 16) };
};
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const num = (v, name, { min = 0, allowNull = false } = {}) => {
  if ((v == null || v === '') && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= min) throw badRequest(`${name} must be a number above ${min}.`);
  return n;
};
export function normSymbol(s) {
  let x = String(s || '').trim().toUpperCase();
  if (!x) throw badRequest('Enter a stock symbol, e.g. TCS or RELIANCE.');
  if (!/[.^]/.test(x)) x = `${x}.NS`;
  if (!SYMBOL_RE.test(x)) throw badRequest(`"${s}" is not a valid symbol.`);
  return x;
}

export function loadJournal() {
  const st = readJsonSafe(PATH(), null) || {};
  return { settings: { ...DEFAULT_SETTINGS, ...(st.settings || {}) }, trades: st.trades || [], alerts: st.alerts || [], notified: st.notified || {} };
}
const save = (st) => writeJsonAtomic(PATH(), st);
const locked = (fn) => withFileLock(PATH(), fn);

export function saveSettings(input) {
  return locked(() => {
    const st = loadJournal();
    const s = { ...st.settings };
    if (input.capital != null) s.capital = num(input.capital, 'Capital', { min: 999 });
    if (input.riskPct != null) s.riskPct = num(input.riskPct, 'Risk per trade');
    if (input.dailyLossPct != null) s.dailyLossPct = num(input.dailyLossPct, 'Daily loss limit');
    if (input.maxTradesPerDay != null) s.maxTradesPerDay = Math.round(num(input.maxTradesPerDay, 'Max trades a day'));
    if (s.riskPct > 5) throw badRequest('Risk per trade above 5% of capital is not allowed here.');
    if (s.dailyLossPct > 10) throw badRequest('Daily loss limit above 10% of capital is not allowed here.');
    st.settings = s;
    save(st);
    return s;
  });
}

/** Charges for a round trip (entry → exit) of `qty` shares. */
export function roundTrip({ side, entry, exit, qty, product }) {
  const buyVal = (side === 'long' ? entry : exit) * qty;
  const sellVal = (side === 'long' ? exit : entry) * qty;
  return orderCharges({ side: 'buy', value: buyVal, product, costs: DEFAULT_COSTS }).total + orderCharges({ side: 'sell', value: sellVal, product, costs: DEFAULT_COSTS }).total;
}

/** Today's realised result and the daily-limit / trade-count status. */
export function todayStatus(st = loadJournal(), now = new Date()) {
  const { date } = istNow(now);
  const todays = st.trades.filter((t) => t.date === date && t.status !== 'cancelled');
  const closed = todays.filter((t) => t.status === 'closed');
  const realised = closed.reduce((a, t) => a + t.net, 0);
  const limitRs = (st.settings.capital * st.settings.dailyLossPct) / 100;
  const openRisk = todays.filter((t) => t.status === 'open').reduce((a, t) => a + t.lossAtStop, 0);
  return {
    date, trades: todays.length, maxTrades: st.settings.maxTradesPerDay, open: todays.length - closed.length,
    realisedRs: realised, limitRs, limitHit: realised <= -limitRs,
    // worst case if every open trade hits its stop
    worstCaseRs: realised - openRisk, roomLeftRs: Math.max(0, limitRs + realised),
  };
}

/** Chance (from big-move odds) that today moves against the trade by at least `pct` %. */
function adverseChance(bm, side, pct) {
  const odds = bm?.horizons?.['1d']?.odds;
  if (!odds?.length) return null;
  const key = side === 'long' ? 'probDown' : 'probUp';
  const pts = odds.map((o) => [o.movePct, o[key]]).sort((a, b) => a[0] - b[0]);
  if (pct <= pts[0][0]) {
    // between 0% (certain to move a little) and the first listed level
    const [m1, p1] = pts[0];
    return 0.5 + (p1 - 0.5) * (pct / m1);
  }
  for (let i = 1; i < pts.length; i++) {
    if (pct <= pts[i][0]) {
      const [a, pa] = pts[i - 1];
      const [b, pb] = pts[i];
      return pa + (pb - pa) * ((pct - a) / (b - a));
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Plan a trade. input: { symbol, side: 'long'|'short', entry, stop, target?, product: 'intraday'|'delivery', setup? }
 * Returns size, charges, outcomes after charges, risk odds and a rules check.
 */
export async function planTrade(input, { st = loadJournal(), now = new Date(), loadBigMove = (s) => bigMove({ symbol: s, loadCandles: candles }) } = {}) {
  const symbol = normSymbol(input.symbol);
  const entry = num(input.entry, 'Entry price');
  const stop = num(input.stop, 'Stop price');
  if (entry === stop) throw badRequest('The stop must be different from the entry.');
  const side = input.side === 'short' ? 'short' : input.side === 'long' ? 'long' : stop < entry ? 'long' : 'short';
  const product = input.product === 'delivery' ? 'delivery' : 'intraday';
  const s = st.settings;
  const perShare = Math.abs(entry - stop);
  const target = input.target != null && input.target !== '' ? num(input.target, 'Target price') : side === 'long' ? entry + 2 * perShare : entry - 2 * perShare;
  const riskRs = (s.capital * s.riskPct) / 100;
  const leverage = product === 'intraday' ? 5 : 1;
  const byRisk = Math.floor(riskRs / perShare);
  const byCash = Math.floor((s.capital * leverage) / entry);
  const qty = Math.max(0, Math.min(byRisk, byCash));
  const lossAtStop = qty ? perShare * qty + roundTrip({ side, entry, exit: stop, qty, product }) : 0;
  const gainAtTarget = qty ? Math.abs(target - entry) * qty - roundTrip({ side, entry, exit: target, qty, product }) : 0;
  const rrAfterCosts = lossAtStop > 0 ? gainAtTarget / lossAtStop : null;
  const stopPct = (perShare / entry) * 100;
  let risk = null;
  try {
    const bm = await loadBigMove(symbol);
    risk = { dailyMovePct: bm.horizons?.['1d']?.sigmaPct ?? null, chanceStopDistanceToday: adverseChance(bm, side, stopPct) };
  } catch {
    /* odds unavailable (symbol / data): plan still works */
  }
  const today = todayStatus(st, now);
  const wrongSide = side === 'long' ? !(stop < entry && target > entry) : !(stop > entry && target < entry);
  const checks = [
    { rule: 'Stop and target on the right sides of the entry', ok: !wrongSide, detail: wrongSide ? `For a ${side === 'long' ? 'buy' : 'short'}, the stop must be ${side === 'long' ? 'below' : 'above'} the entry and the target ${side === 'long' ? 'above' : 'below'} it.` : 'OK' },
    { rule: `Risk at most ${s.riskPct}% of capital`, ok: qty > 0 && lossAtStop <= riskRs * 1.15, detail: qty ? `Loss at stop ₹${Math.round(lossAtStop).toLocaleString('en-IN')} incl. charges (limit ₹${Math.round(riskRs).toLocaleString('en-IN')} + charges)` : 'The stop is too far for even one share at this risk.' },
    { rule: `Reward at least ${s.minRR}× the risk after charges`, ok: rrAfterCosts != null && rrAfterCosts >= s.minRR, detail: rrAfterCosts != null ? `${rrAfterCosts.toFixed(2)}× after charges` : '–' },
    { rule: `No more than ${s.maxTradesPerDay} trades today`, ok: today.trades < s.maxTradesPerDay, detail: `${today.trades} taken today` },
    { rule: `Daily loss limit (−${s.dailyLossPct}%) not reached`, ok: !today.limitHit && lossAtStop <= today.roomLeftRs + 1e-9, detail: today.limitHit ? `Limit hit: today ₹${Math.round(today.realisedRs).toLocaleString('en-IN')}. Stop trading for today.` : `Room left today ₹${Math.round(today.roomLeftRs).toLocaleString('en-IN')}` },
    { rule: 'Stop not inside normal noise', ok: risk?.chanceStopDistanceToday == null || risk.chanceStopDistanceToday < 0.45, detail: risk?.chanceStopDistanceToday != null ? `Chance today moves ${stopPct.toFixed(2)}% against you: ${Math.round(risk.chanceStopDistanceToday * 100)}%` : 'odds unavailable' },
  ];
  return {
    symbol, side, product, entry, stop, target, qty, perShareRisk: perShare, stopPct, riskRs,
    positionValue: qty * entry, marginNeeded: (qty * entry) / leverage, cappedByCash: byCash < byRisk,
    lossAtStop, gainAtTarget, rrAfterCosts, risk, checks, allOk: checks.every((c) => c.ok), setup: SETUPS.includes(input.setup) ? input.setup : 'Other',
    today,
  };
}

/** Save a planned trade as open (optionally with stop / target price alerts). */
export async function addTrade(input, { now = new Date(), withAlerts = false, plan = null } = {}) {
  const p = plan || (await planTrade(input, { now }));
  if (!p.qty) throw badRequest('Nothing to save: the plan has 0 shares.');
  const qty = input.qty != null && input.qty !== '' ? Math.round(num(input.qty, 'Quantity')) : p.qty;
  return locked(() => {
    const st = loadJournal();
    const { date, time } = istNow(now);
    const t = {
      id: id(), date, time, createdAt: now.toISOString(), status: 'open',
      symbol: p.symbol, side: p.side, product: p.product, setup: p.setup, qty,
      entry: p.entry, stop: p.stop, target: p.target, riskRs: p.perShareRisk * qty,
      lossAtStop: qty === p.qty ? p.lossAtStop : p.perShareRisk * qty + roundTrip({ side: p.side, entry: p.entry, exit: p.stop, qty, product: p.product }),
      rulesOk: p.allOk, brokenRules: p.checks.filter((c) => !c.ok).map((c) => c.rule),
      note: String(input.note || '').slice(0, 300),
    };
    st.trades.push(t);
    if (st.trades.length > MAX_TRADES) st.trades = st.trades.slice(-MAX_TRADES);
    if (withAlerts) {
      const mk = (price, kind) => ({ id: id(), symbol: t.symbol, op: (kind === 'stop') === (t.side === 'long') ? 'below' : 'above', price, note: `${kind === 'stop' ? 'Stop' : 'Target'} for ${t.side} ${t.qty} ${t.symbol.replace('.NS', '')}`, tradeId: t.id, createdAt: now.toISOString(), lastChecked: now.toISOString(), triggeredAt: null });
      st.alerts.push(mk(t.stop, 'stop'), mk(t.target, 'target'));
    }
    save(st);
    return t;
  });
}

/** Close an open trade at `exit`. Returns the trade and whether the daily limit was just hit. */
export async function closeTrade({ id: tid, exit }, { now = new Date(), notifyFn = null } = {}) {
  const x = num(exit, 'Exit price');
  return locked(() => {
    const st = loadJournal();
    const t = st.trades.find((y) => y.id === tid);
    if (!t) throw badRequest('No trade with that id.');
    if (t.status !== 'open') throw badRequest('That trade is already closed.');
    const before = todayStatus(st, now).limitHit;
    t.exit = x;
    t.closedAt = now.toISOString();
    t.gross = (t.side === 'long' ? x - t.entry : t.entry - x) * t.qty;
    t.charges = roundTrip({ side: t.side, entry: t.entry, exit: x, qty: t.qty, product: t.product });
    t.net = t.gross - t.charges;
    t.r = t.riskRs > 0 ? t.net / t.riskRs : null;
    t.status = 'closed';
    for (const a of st.alerts) if (a.tradeId === t.id && !a.triggeredAt) a.triggeredAt = 'closed';
    const today = todayStatus(st, now);
    const justHit = today.limitHit && !before;
    if (justHit && st.notified.limit !== today.date) {
      st.notified.limit = today.date;
      notifyFn?.('Daily loss limit reached', `Today ₹${Math.round(today.realisedRs).toLocaleString('en-IN')} (limit −₹${Math.round(today.limitRs).toLocaleString('en-IN')}). Stop trading for today.`);
    }
    save(st);
    return { trade: t, today, limitJustHit: justHit };
  });
}

export function deleteTrade(tid) {
  return locked(() => {
    const st = loadJournal();
    const n = st.trades.length;
    st.trades = st.trades.filter((t) => t.id !== tid);
    if (st.trades.length === n) throw badRequest('No trade with that id.');
    st.alerts = st.alerts.filter((a) => a.tradeId !== tid);
    save(st);
    return { ok: true };
  });
}

/** Personal scorecard from closed trades. */
export function journalStats(st = loadJournal()) {
  const closed = st.trades.filter((t) => t.status === 'closed');
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const block = (list) => {
    if (!list.length) return { trades: 0 };
    const wins = list.filter((t) => t.net > 0);
    const losses = list.filter((t) => t.net <= 0);
    return {
      trades: list.length, winRate: wins.length / list.length,
      avgWinRs: wins.length ? sum(wins, (t) => t.net) / wins.length : null,
      avgLossRs: losses.length ? sum(losses, (t) => t.net) / losses.length : null,
      expectancyRs: sum(list, (t) => t.net) / list.length,
      avgR: list.some((t) => t.r != null) ? sum(list.filter((t) => t.r != null), (t) => t.r) / list.filter((t) => t.r != null).length : null,
      totalRs: sum(list, (t) => t.net), chargesRs: sum(list, (t) => t.charges),
      profitFactor: losses.length && sum(losses, (t) => t.net) !== 0 ? sum(wins, (t) => t.net) / Math.abs(sum(losses, (t) => t.net)) : null,
    };
  };
  const by = (f) => {
    const m = new Map();
    for (const t of closed) {
      const k = f(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return Object.fromEntries([...m].map(([k, v]) => [k, block(v)]));
  };
  // running equity and worst drawdown (₹)
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...closed].sort((a, b) => (a.closedAt || '').localeCompare(b.closedAt || ''))) {
    eq += t.net;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    all: block(closed), bySetup: by((t) => t.setup || 'Other'), bySide: by((t) => t.side),
    rulesKept: block(closed.filter((t) => t.rulesOk)), rulesBroken: block(closed.filter((t) => !t.rulesOk)),
    maxDrawdownRs: dd, open: st.trades.filter((t) => t.status === 'open').length,
  };
}

// --------------------------------------------------------------- alerts ---

export async function addAlert({ symbol, op, price, note = '' }, { now = new Date() } = {}) {
  const sym = normSymbol(symbol);
  const p = num(price, 'Alert price');
  if (op !== 'above' && op !== 'below') throw badRequest('Choose "rises above" or "falls below".');
  return locked(() => {
    const st = loadJournal();
    if (st.alerts.filter((a) => !a.triggeredAt).length >= MAX_ALERTS) throw badRequest(`At most ${MAX_ALERTS} active alerts.`);
    const a = { id: id(), symbol: sym, op, price: p, note: String(note).slice(0, 120), createdAt: now.toISOString(), lastChecked: now.toISOString(), triggeredAt: null };
    st.alerts.push(a);
    save(st);
    return a;
  });
}
export function deleteAlert(aid) {
  return locked(() => {
    const st = loadJournal();
    const n = st.alerts.length;
    st.alerts = st.alerts.filter((a) => a.id !== aid);
    if (st.alerts.length === n) throw badRequest('No alert with that id.');
    save(st);
    return { ok: true };
  });
}

/**
 * Check active alerts against the 5-minute highs / lows since each alert was
 * last checked. Triggered alerts are marked and notified once.
 */
export async function checkAlerts({ loadCandles = candles, now = new Date(), notifyFn = null } = {}) {
  const st0 = loadJournal();
  const active = st0.alerts.filter((a) => !a.triggeredAt);
  if (!active.length) return [];
  const bySym = new Map();
  for (const s of new Set(active.map((a) => a.symbol))) {
    try {
      bySym.set(s, (await loadCandles(s, { range: '1d', interval: '5m' })).filter((r) => r.high > 0 && r.low > 0));
    } catch {
      bySym.set(s, []);
    }
  }
  return locked(() => {
    const st = loadJournal();
    const fired = [];
    for (const a of st.alerts) {
      if (a.triggeredAt) continue;
      const rows = bySym.get(a.symbol) || [];
      const since = Date.parse(a.lastChecked || a.createdAt) / 1000 - 300; // include the candle in progress at the last check
      const recent = rows.filter((r) => r.ts == null || r.ts >= since);
      const hit = recent.find((r) => (a.op === 'above' ? r.high >= a.price : r.low <= a.price));
      a.lastChecked = now.toISOString();
      if (hit) {
        a.triggeredAt = now.toISOString();
        a.triggerPrice = a.op === 'above' ? hit.high : hit.low;
        fired.push(a);
        notifyFn?.(`Price alert · ${a.symbol.replace('.NS', '')}`, `${a.op === 'above' ? 'Rose above' : 'Fell below'} ₹${a.price}${a.note ? ` — ${a.note}` : ''}`);
      }
    }
    save(st);
    return fired;
  });
}
