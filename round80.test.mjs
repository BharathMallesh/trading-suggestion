// Tests for the Call / Put tournament — STOCKS (paper-bot/cp-stocks.mjs), a FORWARD test, PAPER ONLY:
//  • the frozen universe rule (prior 20-session traded value, avoid list, stock-option expiry day);
//  • the pre-open guard per stock (bars, Up/Down, momentum lists, News watch, news pick, the NIFTY majority);
//  • each new contestant (Up/Down lean, momentum list, News watch, news pick, beta to NIFTY, big-move, trend, models,
//    baselines per stock) and the skip reasons;
//  • pooled vs per-stock scoring, the date clustering (clustered p, day-summed t), the vs-NIFTY score;
//  • the option P&L proxy (costs, STT 0.15%) and its expiry skip;
//  • the "proven" bar (300 calls, 60 days, Wilson, Brier, P&L, Holm);
//  • the runtime budget with fake data; the predict → score walk; the Breakdown adapter; the wiring.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r80-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.CP_STOCKS_PATH = join(TMP, 'cp-stocks.json');
process.env.CP_STOCKS_PREP_PATH = join(TMP, 'cp-stocks-prep.json');

const M = await import('./paper-bot/cp-stocks.mjs');
const { isTradingDay } = await import('./paper-bot/market-calendar.mjs');

// ------------------------------------------------------------------ fake data ---
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
function sessions(last, n) {
  const out = [];
  for (let d = last; out.length < n; d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
}
function nextSessions(first, n) {
  const out = [];
  for (let d = first; out.length < n; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}
/** Deterministic wiggly daily bars; `val` sets the traded value (liquidity rank). */
function bars(dates, { seed = 1, val = 1e9, drift = 0.0005 } = {}) {
  let x = 100 + seed;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return dates.map((date) => {
    const r = drift + (rnd() - 0.5) * 0.03;
    const open = x * (1 + (rnd() - 0.5) * 0.01);
    x *= 1 + r;
    return { date, open, high: Math.max(open, x) * 1.005, low: Math.min(open, x) * 0.995, close: x, val };
  });
}
const SYMS = Array.from({ length: 26 }, (_, i) => `STK${String(i).padStart(2, '0')}`);
const D = '2026-11-27'; // Friday, not a stock-option expiry day
const PREV = sessions(addDays(D, -1), 1)[0];
function fakeSeries(last = PREV, n = 620, extra = {}) {
  const ds = sessions(last, n);
  return new Map(SYMS.map((s, i) => [s, bars(ds, { seed: i + 1, val: (SYMS.length - i) * 1e9, ...(extra[s] || {}) })]));
}
const chain = (spot) => {
  const k = Math.round(spot);
  return { [k]: { CE: +(spot * 0.03).toFixed(2), ceVol: 10, PE: +(spot * 0.028).toFixed(2), peVol: 10 }, [k + 5]: { CE: 1, ceVol: 0, PE: 9, peVol: 0 } };
};
function fakeFo(series, date = PREV, expiry = '2026-12-29') {
  const data = {};
  for (const s of SYMS) {
    const spot = series.get(s).filter((r) => r.date <= date).at(-1).close;
    data[s] = { underlying: spot, lot: 500, lots: { [expiry]: 500 }, expiries: { [expiry]: chain(spot) } };
  }
  return { date, data };
}
const emptyGlobals = () => ({ updown: null, momentum: { m10: [], m20: [] }, newsWatch: null, newsPick: null, niftyMajority: null, cal: {}, trail: {} });
const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);
const inputs = (over = {}, g = {}) => M.guardStockInputs({ symbol: 'STK00', bars: bars(sessions(PREV, 600)), global: { ...emptyGlobals(), ...g }, ...over }, D, ist(D, '08:20'));

// ------------------------------------------------------------------ the universe rule ---
test('universe: top 20 by prior 20-session traded value from the F&O list; avoid list and expiry day excluded', () => {
  const series = fakeSeries();
  // a non-F&O stock with huge value is ignored; STK25 (least liquid) gets a big value only ON the day (future) → ignored
  series.set('NOTFO', bars(sessions(PREV, 620), { val: 1e15 }));
  const s25 = series.get('STK25');
  s25.push({ ...s25.at(-1), date: D, val: 1e16 });
  const u = M.selectUniverse({ date: D, foSymbols: SYMS, bars: series });
  assert.equal(u.universe.length, 20);
  assert.deepEqual(u.universe.map((x) => x.symbol), SYMS.slice(0, 20), 'ranked by traded value, only F&O stocks, no future rows');
  assert.equal(u.window.length, 20);
  assert.ok(u.window.every((d) => d < D));
  // the avoid list: STK01 is in force on D → left out, STK20 fills its place; an expired / not-yet event does nothing
  const avoid = [{ symbol: 'STK01', since: '2026-11-20', until: '2026-12-10', reason: 'price band cut' }, { symbol: 'STK02', since: '2026-10-01', until: '2026-11-26', reason: 'old' }, { symbol: 'STK03', since: '2026-11-30', until: '2026-12-20', reason: 'later' }];
  const a = M.selectUniverse({ date: D, foSymbols: SYMS, bars: series, avoid });
  assert.ok(!a.universe.some((x) => x.symbol === 'STK01'));
  assert.ok(a.universe.some((x) => x.symbol === 'STK20') && a.universe.some((x) => x.symbol === 'STK02') && a.universe.some((x) => x.symbol === 'STK03'));
  assert.deepEqual(a.excluded, [{ symbol: 'STK01', rank: 2, reason: 'avoid list: price band cut' }]);
  // a stock's own expiry day (its listed expiries) — and the NSE stock-option expiry day leaves nobody
  const e = M.selectUniverse({ date: D, foSymbols: SYMS, bars: series, expiries: { STK00: [D] } });
  assert.ok(!e.universe.some((x) => x.symbol === 'STK00') && e.excluded[0].reason === 'stock-option expiry day');
  const all = M.selectUniverse({ date: D, foSymbols: SYMS, bars: series, stockExpiry: true });
  assert.equal(all.universe.length, 0);
  // too few sessions in the window → not ranked
  const thin = new Map(series);
  thin.set('STK00', series.get('STK00').slice(0, -10));
  assert.ok(!M.selectUniverse({ date: D, foSymbols: SYMS, bars: thin }).universe.some((x) => x.symbol === 'STK00'));
});

test('universe rule is frozen into every contestant version', () => {
  const v = M.versions();
  assert.equal(Object.keys(v).length, M.CONTESTANTS.length);
  assert.ok(Object.values(v).every((x) => /^[0-9a-f]{12}$/.test(x)));
  assert.deepEqual(M.versions(), v, 'stable');
  const src = readFileSync('paper-bot/cp-stocks.mjs', 'utf8');
  assert.match(src, /\$\{selectUniverse\.toString\(\)\}/, 'the universe function is hashed into versionOf');
  assert.equal(M.ST.universeSize, 20);
  assert.equal(M.ST.liquiditySessions, 20);
});

test('prepare: universe + cached inputs from data before the day only; ATM option from the prior NSE file', async () => {
  const series = fakeSeries();
  const fo = fakeFo(series);
  const p = await M.prepare(D, { seriesFn: async () => series, foFn: () => fo, avoidFn: () => ({ events: [] }) });
  assert.equal(p.universe.length, 20);
  assert.equal(p.forDate, D);
  assert.equal(p.ruleVersion, M.universeVersion());
  const s = p.stocks.STK00;
  assert.ok(s.bars.length <= M.ST.barsKeep && s.bars.every((r) => r.date < D));
  assert.ok(s.bars.at(-1).volume > 0, 'volume from traded value ÷ close');
  assert.ok(s.baseRate.day > 0 && s.baseRate.day < 1);
  assert.equal(s.atm.expiry, '2026-12-29');
  assert.equal(s.atm.CE.strike, Math.round(fo.data.STK00.underlying));
  assert.equal(s.atm.lot, 500);
  assert.deepEqual(p.errors, [], 'files are from the last session');
});

// ------------------------------------------------------------------ the pre-open guard ---
test('pre-open guard per stock: nothing final at/after 09:15 (or now) reaches a contestant', async () => {
  const ds = sessions(PREV, 600);
  const b = [...bars(ds), { date: D, open: 999, high: 999, low: 999, close: 999, val: 1 }];
  const g = {
    updown: { date: D, labels: { STK00: 'strong' } }, // published at D's close → after the open
    momentum: { m10: [{ monthEnd: '2026-10-30', symbols: ['STK00'] }, { monthEnd: '2026-11-27', symbols: [] }], m20: [] },
    newsWatch: { at: '2026-11-27T04:00:00Z', calls: { STK00: { date: D, next: { call: 'UP' }, five: { call: 'UP' } } } }, // 09:30 IST
    newsPick: { at: '2026-11-27T03:50:00Z', picks: ['STK00'] }, // 09:20 IST
    niftyMajority: { at: '2026-11-27T02:40:00Z', day: { call: 'PUT' }, five: { call: 'PUT' } }, // 08:10 IST → fine
  };
  const inp = M.guardStockInputs({ symbol: 'STK00', bars: b, global: { ...emptyGlobals(), ...g } }, D, ist(D, '08:20'));
  assert.ok(inp.bars.every((r) => r.date < D), 'the session bar is dropped');
  assert.equal(inp.updown, null);
  assert.equal(inp.momentum.m10.monthEnd, '2026-10-30', 'the latest list BEFORE the day');
  assert.equal(inp.newsWatch, null);
  assert.equal(inp.newsPick, null);
  assert.equal(inp.niftyMajority.day.call, 'PUT');
  assert.ok(Object.isFrozen(inp) && Object.isFrozen(inp.bars));
  assert.ok(M.assertStockPreOpen(inp));
  // "now" earlier than the open is the cut-off: a news pick at 08:10 is refused at 08:05
  const early = M.guardStockInputs({ symbol: 'STK00', bars: b, global: { ...emptyGlobals(), newsPick: { at: '2026-11-27T02:40:00Z', picks: [] } } }, D, ist(D, '08:05'));
  assert.equal(early.newsPick, null);
  // assertStockPreOpen throws on a leaked row, and runStock refuses to run on it
  const leaked = { ...inp, bars: [...inp.bars, { date: D, open: 1, high: 1, low: 1, close: 1 }] };
  assert.throws(() => M.assertStockPreOpen(leaked), /pre-open guard: STK00 bar 2026-11-27/);
  await assert.rejects(() => M.runStock(leaked), /pre-open guard/);
  assert.throws(() => M.assertStockPreOpen({ ...inp, newsPick: { at: '2026-11-27T04:00:00Z', picks: [] } }), /news pick/);
});

// ------------------------------------------------------------------ the contestants ---
const run = async (inp) => M.runStock(inp);
test('baselines per stock: always CALL / PUT, coin seeded by date + stock, continuation / reversal on the stock', async () => {
  const inp = inputs();
  const p = await run(inp);
  assert.equal(p['always-call'].day.call, 'CALL');
  assert.equal(p['always-put'].five.call, 'PUT');
  assert.equal(p['always-call'].day.pUp, Math.round(inp.baseRate.day * 1000) / 1000, 'the stock\'s own base rate');
  const p2 = await run(inp);
  assert.deepEqual(p.coin, p2.coin, 'seeded: same date + stock → same flip');
  const coins = new Set();
  for (const s of SYMS) coins.add((await run(M.guardStockInputs({ symbol: s, bars: inp.bars, global: emptyGlobals() }, D, ist(D, '08:20'))))['coin'].day.call);
  assert.equal(coins.size, 2, 'different stocks flip differently');
  const up = inp.bars.at(-1).close > inp.bars.at(-2).close;
  assert.equal(p.continuation.day.call, up ? 'CALL' : 'PUT');
  assert.equal(p.reversal.day.call, up ? 'PUT' : 'CALL');
});

test('models on the stock: Call/Put raw + calibrated, 20/50 trend, big-move; skips when bars are short', async () => {
  const p = await run(inputs());
  assert.ok(['CALL', 'PUT', 'NO TRADE'].includes(p['cp-model'].day.call));
  assert.match(p['cp-model'].day.why, /technical score/);
  assert.match(p['cp-calibrated'].skipped, /no validated 1d calibration table/, 'empty table → skipped with a reason');
  assert.match(p['trend-20-50'].day.why, /20-day/);
  assert.ok(['CALL', 'NO TRADE'].includes(p['big-move'].day.call), 'never a PUT: size, not direction');
  assert.match(p['big-move'].day.why, /P\(\|move\| > 2%\)/);
  assert.match(p['big-move'].five.why, /P\(\|move\| > 4%\)/);
  const short = await run(inputs({ bars: bars(sessions(PREV, 40)) }));
  assert.match(short['cp-model'].skipped, /fewer than 50 daily bars/);
  assert.match(short['trend-20-50'].skipped, /fewer than 50 closes/);
  assert.match(short['big-move'].skipped, /fewer than 400 daily bars/);
});

test('Up/Down lean, momentum list, News watch, news pick and beta to NIFTY', async () => {
  const ud = (label) => run(inputs({}, { updown: { date: PREV, labels: label ? { STK00: label } : {} } }));
  assert.equal((await ud('strong')).updown.day.call, 'CALL');
  assert.equal((await ud('weak')).updown.five.call, 'PUT');
  assert.equal((await ud('neutral')).updown.day.call, 'NO TRADE');
  assert.match((await ud(null)).updown.skipped, /not in the Up\/Down top-200 list/);
  assert.match((await run(inputs())).updown.skipped, /no Up\/Down outlook list/);
  const mom = await run(inputs({}, { momentum: { m10: [{ monthEnd: '2026-10-30', symbols: ['STK00'] }], m20: [{ monthEnd: '2026-10-30', symbols: ['X'] }] } }));
  assert.equal(mom.momentum.day.call, 'CALL');
  assert.match(mom.momentum.day.why, /Momentum 10/);
  const momOut = await run(inputs({}, { momentum: { m10: [{ monthEnd: '2026-10-30', symbols: ['X'] }], m20: [] } }));
  assert.equal(momOut.momentum.day.call, 'NO TRADE');
  assert.match((await run(inputs())).momentum.skipped, /no Momentum 10 \/ 20 list/);
  const nw = await run(inputs({}, { newsWatch: { at: '2026-11-26T12:00:00Z', calls: { STK00: { date: PREV, next: { call: 'DOWN', confidence: 0.6, reason: 'x' }, five: { call: 'UP', confidence: 0.55 } } } } }));
  assert.equal(nw['news-watch'].day.call, 'PUT');
  assert.equal(nw['news-watch'].five.call, 'CALL');
  const nw2 = await run(inputs({}, { newsWatch: { at: '2026-11-26T12:00:00Z', calls: { OTHER: {} } } }));
  assert.match(nw2['news-watch'].skipped, /not on the News watch list/);
  const np = await run(inputs({}, { newsPick: { at: '2026-11-27T02:40:00Z', picks: ['STK00'] } }));
  assert.equal(np['news-pick'].day.call, 'CALL');
  const np2 = await run(inputs({}, { newsPick: { at: '2026-11-27T02:40:00Z', picks: ['STK09'] } }));
  assert.equal(np2['news-pick'].day.call, 'NO TRADE');
  assert.match((await run(inputs()))['news-pick'].skipped, /did not run before the open/);
  const beta = await run(inputs({}, { niftyMajority: { at: '2026-11-27T02:40:00Z', day: { call: 'PUT', conf: 0.5, why: '1 CALL · 5 PUT' }, five: { call: 'NO TRADE' } } }));
  assert.equal(beta['beta-nifty'].day.call, 'PUT');
  assert.equal(beta['beta-nifty'].five.call, 'NO TRADE');
  assert.match((await run(inputs()))['beta-nifty'].skipped, /no NIFTY tournament majority/);
  // the ensembles: majority of the model votes; weighted needs a past pooled record
  assert.match(beta.majority.day.why, /model votes/);
  assert.equal(beta.weighted.day.call, 'NO TRADE');
  const tr = await run(inputs({}, { niftyMajority: { at: '2026-11-27T02:40:00Z', day: { call: 'PUT' }, five: { call: 'PUT' } }, trail: { 'beta-nifty': { day: { n: 200, hits: 130 }, five: { n: 10, hits: 9 } } } }));
  assert.equal(tr.weighted.day.call, 'PUT', 'follows the contestant with a positive past record');
  assert.equal(tr.weighted.five.call, 'NO TRADE', 'fewer than 30 pooled calls → no weight');
});

test('weighted ensemble trail uses only real days strictly before the date (5-session calls once ended)', () => {
  const v = M.versions();
  const pred = (hit, end) => ({ version: v['cp-model'], day: { call: 'CALL' }, five: { call: 'CALL' }, score: { day: { hit, endDate: 'x' }, five: { hit, endDate: end } } });
  const st = { days: [
    { date: '2026-11-20', stocks: { A: { preds: { 'cp-model': pred(true, '2026-11-26') } }, B: { preds: { 'cp-model': pred(false, '2026-11-26') } } } },
    { date: '2026-11-26', stocks: { A: { preds: { 'cp-model': pred(true, '2026-12-03') } } } },
    { date: '2026-11-19', test: true, stocks: { A: { preds: { 'cp-model': pred(true, '2026-11-25') } } } },
  ] };
  const t = M.trailingScores(st, '2026-11-26');
  assert.deepEqual(t['cp-model'].day, { n: 2, hits: 1 }, 'pooled across stocks, the day itself and tests excluded');
  assert.equal(t['cp-model'].five, undefined, '5-session calls ending on/after the date are not known yet');
  assert.deepEqual(M.trailingScores(st, '2026-11-27')['cp-model'].five, { n: 2, hits: 1 });
});

// ------------------------------------------------------------------ scoring ---
test('vs-NIFTY score: a stock CALL that rose less than NIFTY is right on its own but wrong vs NIFTY', () => {
  const s = M.scoreStock({ call: 'CALL', pUp: 0.6 }, { up: true, ret: 0.004, niftyRet: 0.01, endDate: D }, 0.5);
  assert.equal(s.hit, true);
  assert.equal(s.hitVsNifty, false);
  const p = M.scoreStock({ call: 'PUT', pUp: 0.4 }, { up: true, ret: 0.002, niftyRet: 0.012, endDate: D }, 0.5);
  assert.equal(p.hit, false);
  assert.equal(p.hitVsNifty, true, 'a PUT wins vs NIFTY when the stock lagged NIFTY');
  const n = M.scoreStock({ call: 'NO TRADE', pUp: 0.5 }, { up: false, ret: -0.01, niftyRet: null, endDate: D }, 0.52);
  assert.equal(n.hit, null);
  assert.equal(n.noTrade, true);
  assert.ok(Math.abs(n.brierRef - 0.52 ** 2) < 1e-12, 'Brier vs the stock\'s base rate');
  assert.equal(M.scoreStock({ call: 'CALL', pUp: 0.6 }, { up: true, ret: 0.01, niftyRet: null }, 0.5).hitVsNifty, null);
});

test('P&L proxy: ₹2,000 of ATM premium, stock move × 0.5 delta, option costs (STT 0.15% on the sale); none on expiry', () => {
  const atm = { spot: 1000, lot: 500, expiry: '2026-12-29', CE: { strike: 1000, prem: 20 }, PE: { strike: 1000, prem: 18 } };
  const c = M.optionProxy({ callSide: 'CALL', ret: 0.01, atm, date: D });
  // qty 100, premium 20 → 25 (1% × 1000 × 0.5): gross +500
  assert.ok(Math.abs(c.gross - 500) < 1e-9);
  assert.ok(c.charges > 40 && c.charges < 80, `charges ${c.charges}`);
  assert.ok(Math.abs(c.pnl - (500 - c.charges)) < 1e-9);
  assert.ok(Math.abs(c.lots - 0.2) < 1e-12, 'a fifth of a lot: one lot costs ₹10,000 of premium');
  assert.match(c.source, /proxy/);
  const p = M.optionProxy({ callSide: 'PUT', ret: 0.01, atm, date: D });
  assert.ok(p.gross < 0 && Math.abs(p.gross + (2000 / 18) * 5) < 1e-9, 'the PUT loses when the stock rises');
  const crash = M.optionProxy({ callSide: 'CALL', ret: -0.5, atm, date: D });
  assert.ok(crash.gross >= -2000 - 1e-9, 'a bought option cannot lose more than its premium');
  // STT on the sale: 0.15% from 1 Apr 2026, 0.1% before
  const after = M.optionCosts(20, 20, 100, '2026-06-01') - M.optionCosts(20, 20, 100, '2026-03-02');
  assert.ok(Math.abs(after - 2000 * 0.0005) < 1e-6, 'the STT step on ₹2,000 of premium sold');
  assert.deepEqual(M.optionProxy({ callSide: 'CALL', ret: 0.01, atm, date: D, expiryInWindow: true }), { pnl: null, source: 'stock-option expiry in the window — no option (physically settled)' });
  assert.equal(M.optionProxy({ callSide: 'NO TRADE', ret: 0.01, atm, date: D }), null);
  assert.equal(M.optionProxy({ callSide: 'CALL', ret: 0.01, atm: null, date: D }), null, 'no NSE premium → no P&L');
});

test('date clustering: correlated same-day calls give a weaker p than independent ones; t sums P&L per day', () => {
  // 10 days × 20 stocks; on 6 days every stock is right, on 4 days every stock is wrong → 60% hit, but only 10 independent days
  const rows = [];
  for (let d = 0; d < 10; d++) for (let s = 0; s < 20; s++) rows.push({ date: `2026-01-${String(d + 1).padStart(2, '0')}`, hit: d < 6, pnl: d < 6 ? 10 : -12 });
  const pc = M.clusteredP(rows, 0.5);
  const iid = M.clusteredP(rows.map((r, i) => ({ ...r, date: `d${i}` })), 0.5);
  assert.ok(iid < 0.01, `as 200 independent calls the 60% looks strong (p ${iid})`);
  assert.ok(pc > 0.2, `clustered by day it is not (p ${pc})`);
  assert.equal(M.clusteredP([{ date: 'a', hit: true }], 0.5), null, 'needs two days');
  const t = M.dayClusteredT(rows);
  const daily = [...Array(6).fill(200), ...Array(4).fill(-240)];
  const m = daily.reduce((a, b) => a + b) / 10;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / 9);
  assert.ok(Math.abs(t - m / (sd / Math.sqrt(10))) < 1e-9);
});

/** A state with `days` real days × `perDay` stocks where contestant `good` is right with `rate`. */
function synthState({ days = 60, perDay = 5, rate = 0.8, good = 'trend-20-50', pnl = 100, endDays = 0 } = {}) {
  const v = M.versions();
  const dates = nextSessions('2026-01-01', days + endDays).slice(0, days);
  const st = { startedAt: dates[0], days: [], tests: [] };
  let k = 0;
  for (const date of dates) {
    const stocks = {};
    for (let s = 0; s < perDay; s++) {
      const up = (k++ % 2) === 0;
      const preds = {};
      for (const c of M.CONTESTANTS) {
        let callC;
        if (c.id === good) callC = (k % 10) < rate * 10 ? (up ? 'CALL' : 'PUT') : up ? 'PUT' : 'CALL';
        else if (c.id === 'always-call') callC = 'CALL';
        else callC = 'NO TRADE';
        const pUp = callC === 'CALL' ? 0.6 : callC === 'PUT' ? 0.4 : 0.5;
        const hit = callC === 'NO TRADE' ? null : callC === 'CALL' ? up : !up;
        const sc = { up, ret: up ? 0.01 : -0.01, niftyRet: 0, brier: (pUp - (up ? 1 : 0)) ** 2, brierRef: 0.25, endDate: date, hit, hitVsNifty: hit, ...(hit == null ? { noTrade: true } : { pnl: hit ? pnl : -pnl / 2, pnlSource: 'proxy' }) };
        preds[c.id] = { version: v[c.id], day: { call: callC, pUp }, five: { call: callC, pUp }, score: { day: sc, five: sc } };
      }
      stocks[`S${s}`] = { rank: s + 1, preds, baseRate: { day: 0.5, five: 0.5 } };
    }
    st.days.push({ date, test: false, stocks, scored: { day: 'x', five: 'x' } });
  }
  return st;
}

test('pooled vs per-stock: the board pools every stock-call; the drill-down splits by stock; leader best / worst', () => {
  const st = synthState({ days: 10, perDay: 4 });
  const b = M.leaderboard(st, 'day');
  const r = b.rows.find((x) => x.id === 'trend-20-50');
  assert.equal(r.n, 40);
  assert.equal(r.days, 10);
  assert.equal(r.stocks, 4);
  const ps = M.perStock(st, 'day', 'trend-20-50');
  assert.equal(ps.length, 4);
  assert.equal(ps.reduce((a, x) => a + x.n, 0), r.n, 'per-stock adds back to the pooled count');
  assert.ok(Math.abs(ps.reduce((a, x) => a + x.pnl, 0) - r.pnl) < 1e-9);
  assert.equal(b.leader, 'trend-20-50');
  assert.equal(r.status, 'LEADING — still unproven');
  assert.ok(b.leaderStocks.best.length === 3 && b.leaderStocks.worst.length === 3);
  assert.match(b.leaderStocks.note, /mostly luck/);
  assert.match(b.correction, /clustered by date/);
});

test('the "proven" bar: ≥ 300 stock-calls on ≥ 60 days, Wilson > max(50%, always-CALL), Brier > 0, P&L > 0, Holm p < 0.05', () => {
  const ok = M.leaderboard(synthState({ days: 60, perDay: 5, rate: 0.8 }), 'day');
  const r = ok.rows.find((x) => x.id === 'trend-20-50');
  assert.equal(r.n, 300);
  assert.equal(r.days, 60);
  assert.ok(r.proven, JSON.stringify(r.why));
  assert.equal(r.status, 'PROVEN (forward, after Holm)');
  assert.deepEqual(ok.proven, ['trend-20-50']);
  assert.ok(!ok.rows.find((x) => x.id === 'always-call').proven, 'the reference is never "proven"');
  // 59 days (295 calls) → not proven, with both reasons
  const few = M.leaderboard(synthState({ days: 59, perDay: 5 }), 'day').rows.find((x) => x.id === 'trend-20-50');
  assert.ok(!few.proven);
  assert.ok(few.why.some((w) => /295 of 300/.test(w)) && few.why.some((w) => /59 of 60 different days/.test(w)));
  // 300 calls but on only 30 days → not proven
  const crowded = M.leaderboard(synthState({ days: 30, perDay: 10 }), 'day').rows.find((x) => x.id === 'trend-20-50');
  assert.ok(!crowded.proven && crowded.why.some((w) => /30 of 60 different days/.test(w)));
  // losing P&L → not proven
  const neg = M.leaderboard(synthState({ days: 60, perDay: 5, pnl: -100 }), 'day').rows.find((x) => x.id === 'trend-20-50');
  assert.ok(!neg.proven && neg.why.includes('P&L after costs not positive'));
  // a coin-like hit rate → not proven, "LEADING — still unproven" at most
  const coin = M.leaderboard(synthState({ days: 60, perDay: 5, rate: 0.5 }), 'day');
  assert.equal(coin.proven.length, 0);
  assert.match(coin.verdict, /No contestant is proven/);
});

// ------------------------------------------------------------------ runtime + the walk ---
/** A clock that starts at `start` and advances with real time (so runtime is measured but the day is the fake one). */
const simClock = (start) => {
  const t0 = Date.now();
  return () => new Date(start.getTime() + (Date.now() - t0));
};
const prepOpts = (series, fo) => ({ seriesFn: async () => series, foFn: () => fo, avoidFn: () => ({ events: [{ symbol: 'STK03', since: '2026-11-20', until: '2026-12-31', reason: 'price band cut' }] }) });

test('runtime budget: 20 stocks × every contestant (fake data) finishes well inside the 09:05 stop', async () => {
  const series = fakeSeries();
  const fo = fakeFo(series);
  const file = join(TMP, 'rt.json');
  const t0 = Date.now();
  const r = await M.predictStocks({ now: ist(D, '08:20'), file, prepFile: join(TMP, 'none.json'), prepFn: (d) => M.prepare(d, prepOpts(series, fo)), globalsFn: () => emptyGlobals(), clock: simClock(ist(D, '08:20')) });
  const ms = Date.now() - t0;
  assert.equal(r.rec.universe.length, 20);
  assert.equal(r.rec.test, false);
  assert.ok(Object.values(r.rec.stocks).every((s) => Object.keys(s.preds).length === M.CONTESTANTS.length));
  assert.ok(ms < 10_000, `predict took ${ms} ms (budget 10 s; the real run has ~10 minutes)`);
  assert.ok(r.rec.runtimeMs >= 0 && r.rec.runtimeMs <= ms);
  // with the evening cache: only the overnight inputs are read in the morning
  const prepFile = join(TMP, 'prep.json');
  const p = await M.prepare(D, prepOpts(series, fo));
  writeFileSync(prepFile, JSON.stringify(p));
  let built = 0;
  const r2 = await M.predictStocks({ now: ist(D, '08:20'), file: join(TMP, 'rt2.json'), prepFile, prepFn: async (d) => { built++; return M.prepare(d, prepOpts(series, fo)); }, freshFn: async () => ({ foFile: p.foFile, dataTo: p.dataTo }), globalsFn: () => emptyGlobals(), clock: simClock(ist(D, '08:20')) });
  assert.equal(built, 0);
  assert.equal(r2.rec.prepCached, true);
  // a newer NSE file than the cache → rebuilt
  await M.predictStocks({ now: ist(D, '08:20'), file: join(TMP, 'rt3.json'), prepFile, prepFn: async (d) => { built++; return M.prepare(d, prepOpts(series, fo)); }, freshFn: async () => ({ foFile: 'newer', dataTo: p.dataTo }), globalsFn: () => emptyGlobals() });
  assert.equal(built, 1);
});

test('predict: holidays, after 09:15, duplicates, the 09:05 stop, a late finish, TEST entries; real calls never read a TEST NIFTY call', async () => {
  const series = fakeSeries();
  const fo = fakeFo(series);
  const file = join(TMP, 'walk-p.json');
  const base = { file, prepFile: join(TMP, 'none.json'), prepFn: (d) => M.prepare(d, prepOpts(series, fo)), clock: simClock(ist(D, '08:20')) };
  assert.equal((await M.predictStocks({ ...base, now: ist('2026-11-28', '08:20'), globalsFn: emptyGlobals })).skipped, 'holiday');
  assert.equal((await M.predictStocks({ ...base, now: ist(D, '09:20'), globalsFn: emptyGlobals })).skipped, 'late');
  const nm = { at: '2026-11-27T02:40:00Z', test: true, day: { call: 'PUT' }, five: { call: 'PUT' } };
  const r = await M.predictStocks({ ...base, now: ist(D, '08:20'), globalsFn: () => ({ ...emptyGlobals(), niftyMajority: nm }) });
  assert.ok(!r.rec.universe.includes('STK03') && r.rec.excluded[0].symbol === 'STK03', 'avoid list left out');
  assert.match(r.rec.stocks.STK00.preds['beta-nifty'].skipped, /no NIFTY tournament majority/, 'a TEST NIFTY call is not used for a real stock call');
  assert.equal((await M.predictStocks({ ...base, now: ist(D, '08:30'), globalsFn: emptyGlobals })).skipped, 'done');
  // the 09:05 stop: the clock passes it after a few stocks
  let t = ist('2026-12-01', '09:04').getTime();
  const r3 = await M.predictStocks({ ...base, now: ist('2026-12-01', '08:20'), globalsFn: emptyGlobals, clock: () => new Date((t += 20_000)) });
  const stopped = Object.values(r3.rec.stocks).filter((s) => s.skipped === 'not reached before the 09:05 stop');
  assert.ok(stopped.length > 0 && stopped.length < 20);
  // finishing after 09:15 → kept as a test (not scored)
  const r4 = await M.predictStocks({ ...base, now: ist('2026-12-02', '08:20'), globalsFn: emptyGlobals, clock: () => ist('2026-12-02', '09:16') });
  assert.equal(r4.rec.test, true);
  assert.match(r4.rec.testReason, /after the 09:15 open — not scored/);
  // a TEST entry: kept apart, may read the TEST NIFTY call
  const r5 = await M.predictStocks({ ...base, now: ist(D, '11:00'), date: '2026-12-03', globalsFn: () => ({ ...emptyGlobals(), niftyMajority: { ...nm, at: '2026-11-27T05:00:00Z' } }) });
  assert.equal(r5.rec.test, true);
  assert.equal(r5.rec.stocks.STK00.preds['beta-nifty'].day.call, 'PUT');
  const st = M.loadStocks(file);
  assert.deepEqual(st.days.map((d) => d.date), [D, '2026-12-01']);
  assert.deepEqual(st.tests.map((d) => d.date), ['2026-12-02', '2026-12-03']);
});

test('score walk: day + 5 sessions vs the stock and vs NIFTY, P&L proxy, expiry-window skip; tests never scored', async () => {
  const file = join(TMP, 'walk.json');
  const days = ['2026-12-21', '2026-12-22', '2026-12-23'];
  const series = fakeSeries('2027-01-08', 640);
  const fo = fakeFo(series, '2026-12-18');
  for (const d of days) {
    const foD = { ...fo, date: sessions(addDays(d, -1), 1)[0] };
    const r = await M.predictStocks({ file, now: ist(d, '08:20'), prepFile: join(TMP, 'none.json'), prepFn: (x) => M.prepare(x, prepOpts(series, foD)), globalsFn: () => emptyGlobals(), clock: simClock(ist(d, '08:20')) });
    assert.equal(r.rec.test, false);
  }
  await M.predictStocks({ file, now: ist(days[0], '12:00'), date: '2026-12-24', prepFile: join(TMP, 'none.json'), prepFn: (x) => M.prepare(x, prepOpts(series, fo)), globalsFn: () => emptyGlobals() });
  const nifty = sessions('2027-01-08', 30).map((date, i) => ({ date, open: 26000, close: 26000 * (1 + (i % 2 ? 0.004 : -0.002)) }));
  const s = await M.scoreStocks({ file, now: ist('2027-01-05', '18:00'), seriesFn: async () => series, niftyFn: async () => nifty });
  assert.equal(s.scoredNow, 6, '3 days × (day + 5 sessions)');
  const st = s.st;
  const d0 = st.days[0];
  const sym = Object.keys(d0.stocks)[0];
  const sc = d0.stocks[sym].preds['always-call'].score;
  const bar = series.get(sym).find((r) => r.date === days[0]);
  assert.ok(Math.abs(sc.day.ret - (bar.close / bar.open - 1)) < 1e-12);
  assert.equal(sc.day.hit, bar.close > bar.open);
  const nb = nifty.find((r) => r.date === days[0]);
  assert.equal(sc.day.hitVsNifty, sc.day.ret - (nb.close / nb.open - 1) > 0);
  assert.ok(sc.day.pnl != null && /proxy/.test(sc.day.pnlSource));
  // the 5-session window of 23 Dec ends after the 29 Dec stock expiry → no option P&L; 21 Dec's ends 28 Dec → priced
  assert.ok(st.days[0].stocks[sym].preds['always-call'].score.five.pnl != null);
  assert.equal(st.days[2].stocks[sym].preds['always-call'].score.five.pnl, null);
  assert.match(st.days[2].stocks[sym].preds['always-call'].score.five.pnlSource, /expiry in the window/);
  assert.ok(st.tests.every((x) => !x.scored), 'TEST entries are never scored');
  const again = await M.scoreStocks({ file, now: ist('2027-01-05', '18:00'), seriesFn: async () => series, niftyFn: async () => nifty });
  assert.equal(again.scoredNow, 0, 'no double scoring');
  const v = M.stocksView({ file });
  assert.equal(v.boards.day.rows.find((x) => x.id === 'always-call').n, 60);
  assert.equal(v.perStock.day['always-call'].length, 20);
  assert.match(v.note, /Not advice\.$/);
  assert.match(v.whyVsNifty, /against NIFTY/);
  assert.match(v.pnlNote, /PROXY/);
  assert.equal(v.today.date, '2026-12-24');
  assert.ok(v.today.test);
  writeFileSync(join(TMP, 'scored.json'), readFileSync(file));
});

// ------------------------------------------------------------------ Breakdown ---
test('Breakdown adapter: one row per scored stock call with a P&L, by contestant; validation passes', async () => {
  const bd = await import('./paper-bot/breakdown.mjs');
  const dir = join(TMP, 'bd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cp-stocks.json'), readFileSync(join(TMP, 'scored.json')));
  const data = bd.loadAll({ dir });
  const rows = data.rows.filter((x) => x.strategy === 'cp-stocks');
  assert.equal(rows.filter((r) => r.version === 'always-call').length, 60, 'tests left out, one row per stock-day');
  assert.ok(rows.every((r) => /^STK\d\d$/.test(r.symbol)));
  assert.equal(data.warnings.filter((w) => /cp-stocks/.test(w)).length, 0);
  const val = bd.validate(data).filter((x) => x.strategy === 'cp-stocks');
  assert.ok(val.length >= 2 && val.every((x) => x.pass), JSON.stringify(val.filter((x) => !x.pass)));
  assert.equal(bd.STRATEGIES['cp-stocks'], 'Call / Put tournament — stocks');
});

// ------------------------------------------------------------------ CLI + wiring ---
test('CLI: usage and a holiday TEST date, on temp files', () => {
  const env = { ...process.env, CP_STOCKS_PATH: join(TMP, 'cli.json'), CP_STOCKS_PREP_PATH: join(TMP, 'cli-prep.json') };
  const u = spawnSync(process.execPath, ['paper-bot/cp-stocks.mjs'], { env, encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(u.stdout, /usage: node paper-bot\/cp-stocks\.mjs --predict/);
  const h = spawnSync(process.execPath, ['paper-bot/cp-stocks.mjs', '--predict', '--date', '2026-11-28'], { env, encoding: 'utf8' });
  assert.match(h.stdout, /2026-11-28: not an NSE trading day/);
  assert.match(h.stdout, /Not advice\./);
});

test('wiring: Stocks toggle in the Call / Put tournament card, route, run.sh morning + evening lines, Not advice, no orders', () => {
  const html = readFileSync('index.html', 'utf8');
  const card = html.slice(html.indexOf('id="cpTournamentCard"'), html.indexOf('</section>', html.indexOf('id="cpTournamentCard"')));
  assert.match(card, /id="cpShowStocks"[^>]*>Stocks<\/button>/);
  assert.match(card, /id="cpsOut"/);
  assert.match(html, /\/static\/js\/52-cp-stocks\.js/);
  const js = readFileSync('static/js/52-cp-stocks.js', 'utf8');
  assert.match(js, /api\('\/api\/cp-stocks'\)/);
  assert.match(js, /Not advice/);
  assert.match(js, /overflow-x:auto/, 'wide tables scroll inside their own box');
  assert.match(readFileSync('server.mjs', 'utf8'), /url\.pathname === '\/api\/cp-stocks'\) return json\(res, 200, cpStocksView\(\)\)/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  const lines = sh.split('\n').filter((l) => /cp-stocks\.mjs/.test(l) && !/^\s*#/.test(l));
  assert.ok(lines.length === 3 && lines.every((l) => /\|\| true$/.test(l.trim())), lines.join('\n'));
  const morning = sh.slice(sh.indexOf('  morning)'));
  assert.ok(morning.indexOf('cp-tournament.mjs --predict') < morning.indexOf('cp-stocks.mjs --predict') && morning.indexOf('cp-stocks.mjs --predict') < morning.indexOf(';;'), 'after the NIFTY calls');
  const collect = sh.slice(sh.indexOf('do_collect() {'), sh.indexOf('do_refit()'));
  assert.ok(collect.indexOf('bhav-history.mjs') < collect.indexOf('cp-stocks.mjs --score --prepare'), 'after today\'s NSE file');
  const mod = readFileSync('paper-bot/cp-stocks.mjs', 'utf8');
  assert.doesNotMatch(mod, /placeOrder|\/v1\/order|order\/create/i, 'no broker orders');
  assert.equal((mod.match(/writeJsonAtomic\(/g) || []).length, 4, 'writes only its own state + prep files');
  assert.doesNotMatch(mod, /saveCalibration|writeFileSync|vol-model|prob-calibration/, 'never writes the calibration / vol-model files');
  assert.match(M.NOTE, /Paper only — no broker orders\. Not advice\.$/);
});
