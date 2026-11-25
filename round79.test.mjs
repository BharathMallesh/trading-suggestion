// Round 79: fixes from the 25 Nov 2026 QA pass (Home / trades / portfolio, Investing, Options / F&O plan,
// Strategies / Calendar / Day patterns / Breakdown / Research lab). Test names start with the QA bug id.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r79-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.SWING_SCAN_PATH = join(TMP, 'scan.json');
process.env.ATH_PAPER_PATH = join(TMP, 'ath-paper.json');
process.env.JOURNAL_PATH = join(TMP, 'journal.json');
process.env.HOLDINGS_PATH = join(TMP, 'holdings.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

// ------------------------------------------------------------------------- H1 ---
const tp = await import('./paper-bot/trade-plan.mjs');
const { wideRules } = await import('./paper-bot/ath-swing.mjs');
const wr = wideRules();
const slip = 1 - wr.slippagePct / 100;
const openT = (symbol, entryDate, entry, stop, last) => ({ symbol: `${symbol}.NS`, version: 'wide', open: true, entryDate, entry, stop, trail: stop, exit: last * slip, r: 0 });

test('H1: swing plan holds never cost more than the capital nor exceed maxOpen; the rest are paper only (oldest first)', () => {
  const trades = Array.from({ length: 25 }, (_, i) => openT(`H${String(i).padStart(2, '0')}`, `2026-10-${String(10 + (i % 15)).padStart(2, '0')}`, 100, 90, 105));
  const p = tp.tradePlan({ capital: 500000, paper: { trades }, scan: { date: '2026-10-30', triggered: [] }, r: wr });
  const inPlan = p.hold.filter((h) => h.inPlan);
  assert.ok(inPlan.length <= wr.maxOpen);
  assert.ok(p.invested <= 500000 + 1e-6, `invested ${p.invested}`);
  assert.equal(p.paperOnly, 25 - inPlan.length);
  assert.ok(p.hold.filter((h) => !h.inPlan).every((h) => h.shares === 0 && /paper only/.test(h.why)));
  // oldest entries are the ones kept
  const oldestOut = Math.min(...p.hold.filter((h) => !h.inPlan).map((h) => Date.parse(h.entryDate)));
  assert.ok(inPlan.every((h) => Date.parse(h.entryDate) <= oldestOut));
  // when the cash is enough for all of them, still at most maxOpen
  const wideStops = trades.map((t) => ({ ...t, stop: 50, trail: 50 })); // 3% of capital each: 20 fit in the cash, slots bind
  const big = tp.tradePlan({ capital: 1e9, paper: { trades: wideStops }, scan: { date: '2026-10-30', triggered: [] }, r: wr });
  assert.equal(big.hold.filter((h) => h.inPlan).length, wr.maxOpen);
  assert.match(big.hold.find((h) => !h.inPlan).why, /slots/);
});

// ------------------------------------------------------------------ H2 / M1 ---
const J = await import('./paper-bot/journal.mjs');
const noOdds = { loadBigMove: async () => { throw new Error('no data'); } };

test('H2: a trade saved with more shares than planned re-runs the risk / daily-room / cash checks', async () => {
  const now = new Date('2026-11-24T05:00:00Z');
  const input = { symbol: 'TCS', side: 'long', product: 'delivery', entry: 1000, stop: 975, target: 1100 };
  const plan = await J.planTrade(input, { now, ...noOdds });
  assert.ok(plan.checks.find((c) => c.rule.startsWith('Risk at most')).ok, 'the planned quantity keeps the risk rule');
  const t = await J.addTrade({ ...input, qty: plan.qty * 25 }, { now, plan });
  assert.equal(t.rulesOk, false);
  assert.ok(t.brokenRules.some((r) => r.startsWith('Risk at most')));
  assert.ok(t.brokenRules.includes('Position fits the capital'));
  const same = await J.addTrade(input, { now, plan });
  assert.equal(same.qty, plan.qty);
  assert.equal(same.rulesOk, plan.allOk, 'the planned quantity keeps the plan\'s verdict');
});

test('M1: a target on the wrong side of the entry is a loss and fails the reward check', async () => {
  const p = await J.planTrade({ symbol: 'TCS', side: 'long', product: 'delivery', entry: 1000, stop: 975, target: 990 }, { now: new Date('2026-11-24T05:00:00Z'), ...noOdds });
  assert.ok(p.gainAtTarget < 0, `gainAtTarget ${p.gainAtTarget}`);
  assert.ok(p.rrAfterCosts < 0);
  assert.equal(p.checks.find((c) => c.rule.startsWith('Reward')).ok, false);
});

test('M2/M3/M7: plan UI signs the target result, warns on a tiny stop; alerts load on their own card; only the latest answer shows', () => {
  const js = src('./static/js/04-home-trades.js');
  assert.match(js, /p\.gainAtTarget > 0 \? '\+' : ''/);
  assert.match(js, /p\.stopPct < 0\.1/);
  assert.match(js, /lazy\('Price alerts', jnLoad\)/);
  assert.match(js, /lazy\('Plan a trade', jnLoad\)/);
  assert.match(js, /my === aaSeq/);
});

// ---------------------------------------------------------------- O-B1 / O-B2 ---
const PL = await import('./paper-bot/prediction-log.mjs');

test('O-B2/S-B5: a bare logged symbol settles on the NSE listing, never the US ADR', () => {
  assert.equal(PL.yahooSymbolFor('INFY'), 'INFY.NS');
  assert.equal(PL.yahooSymbolFor('INFY.NS'), 'INFY.NS');
  assert.equal(PL.yahooSymbolFor('^NSEI'), '^NSEI');
  assert.equal(PL.yahooSymbolFor('M&M.NS'), 'M&M.NS');
  const g = src('./paper-bot/groww-predict.mjs');
  assert.match(g, /logPrediction\(out\.source === 'groww' \? \{ \.\.\.out, symbol: yahooSymbolFor\(out\.symbol\) \} : out\)/);
});

test('O-B1: old unsettleable rows no longer use up the scoring budget; implausible moves are set aside', async () => {
  const now = Date.parse('2026-11-25T12:00:00Z'); // 17:30 IST
  const mk = (i, symbol, ts, asOf, extra = {}) => ({ id: `e${i}`, ts, symbol, mode: 'multi', intervalMinutes: 15, asOf, lastClose: 1000, bias: 'UP', probUp: 0.5, probDown: 0.3, probSideways: 0.2, atr: 10, evaluated: false, ...extra });
  const entries = [];
  // 40 old entries (Oct) for a symbol Yahoo has nothing for → set aside, one download for all of them
  for (let i = 0; i < 40; i++) entries.push(mk(i, 'GONE', '2026-10-01T05:00:00Z', '2026-10-01'));
  // newer, due: a bare symbol (settles on .NS) and a normal one
  entries.push(mk(100, 'INFY', '2026-11-20T05:00:00Z', '2026-11-20'));
  entries.push(mk(101, 'TCS.NS', '2026-11-20T05:00:00Z', '2026-11-20'));
  entries.push(mk(102, 'WRONG.NS', '2026-11-20T05:00:00Z', '2026-11-20')); // a −99% "move"
  entries.push(mk(103, 'TCS.NS', '2026-11-25T05:00:00Z', '2026-11-25')); // not due: next session is tomorrow
  writeFileSync(process.env.PREDICTION_LOG_PATH, JSON.stringify({ version: 1, entries }));
  const asked = [];
  const loadCandles = async (sym) => {
    asked.push(sym);
    if (sym === 'GONE.NS') return [];
    const close = sym === 'WRONG.NS' ? 12.4 : 1010;
    return [{ date: '2026-11-20', close: 1000 }, { date: '2026-11-23', close }, { date: '2026-11-24', close }];
  };
  const r = await PL.evaluatePending({ limit: 4, now, loadCandles }) // 4 downloads: GONE, INFY.NS, TCS.NS, WRONG.NS;
  assert.ok(!asked.includes('INFY'), 'never the US ticker');
  assert.ok(asked.includes('INFY.NS'));
  assert.equal(asked.filter((s) => s === 'GONE.NS').length, 1, 'one download per symbol per run');
  const log = JSON.parse(readFileSync(process.env.PREDICTION_LOG_PATH, 'utf8')).entries;
  const by = Object.fromEntries(log.map((e) => [e.id, e]));
  assert.equal(by.e100.evaluated, true);
  assert.ok(Math.abs(by.e100.realizedRetPct - 1) < 1e-9);
  assert.equal(by.e101.evaluated, true);
  assert.equal(by.e102.evaluated, false);
  assert.equal(by.e102.unscorable, true);
  assert.equal(by.e103.evaluated, false);
  assert.ok(!by.e103.unscorable);
  assert.ok(log.filter((e) => e.symbol === 'GONE').every((e) => e.unscorable));
  assert.equal(r.stats.pending, 1, 'set-aside rows are not "pending"');
  assert.equal(r.stats.unscorable, 41);
});

// ------------------------------------------------------------ INV-1 / L8 ---
const { curveDate } = await import('./util.mjs');
const REP = await import('./paper-bot/repair-2026-11.mjs');

test('INV-1/L8: a paper curve point is keyed by its closes\' trading date, never a Sunday / holiday run date', () => {
  assert.equal(curveDate(['2026-11-23', '2026-11-20', null], '2026-11-24'), '2026-11-23');
  assert.equal(curveDate([], '2026-11-24'), '2026-11-24', 'no dated price: the run date as before');
  assert.equal(curveDate(['2026-11-26'], '2026-11-25'), '2026-11-25', 'never after the run date');
  for (const f of ['india-mix', 'steady-mix', 'momentum10', 'momentum']) assert.match(src(`./paper-bot/${f}.mjs`), /curveDate\(seen, today\)/, f);
});

test('INV-1 repair: a holiday point is dropped when the session has one, re-keyed only when that session\'s closes reproduce it; idempotent', async () => {
  const path = join(TMP, 'm10-paper.json');
  const reb = { date: '2026-11-02', value: 100000, holdings: [{ symbol: 'AAA', entry: 100, weight: 0.5 }, { symbol: 'BBB', entry: 200, weight: 0.5 }] };
  writeFileSync(path, JSON.stringify({ rebalances: [reb], curve: [{ date: '2026-11-12', value: 100500 }, { date: '2026-11-15', value: 105000 }, { date: '2026-11-23', value: 99000 }, { date: '2026-11-24', value: 99000 }] }));
  const closes = { 'AAA.NS|2026-11-13': 110, 'BBB.NS|2026-11-13': 200 }; // 0.5×1.1 + 0.5×1 = 1.05 → ₹1,05,000
  const closeOn = async (s, d) => closes[`${s}|${d}`] ?? null;
  const r = await REP.repairCurve(path, 'equal', { closeOn, apply: true });
  assert.deepEqual(r.changes.map((c) => [c.date, c.action, c.to || null]), [['2026-11-15', 're-key', '2026-11-13'], ['2026-11-24', 'drop', null]]);
  const st = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(st.curve.map((c) => c.date), ['2026-11-12', '2026-11-13', '2026-11-23']);
  assert.equal((await REP.repairCurve(path, 'equal', { closeOn, apply: true })).changes.length, 0, 'second run changes nothing');
  // a value the closes don't reproduce is dropped, never re-keyed
  writeFileSync(path, JSON.stringify({ rebalances: [reb], curve: [{ date: '2026-11-15', value: 123456 }] }));
  assert.equal((await REP.repairCurve(path, 'equal', { closeOn })).changes[0].action, 'drop');
});

test('O-B2 repair: bare symbols mapped to .NS, impossible scores voided (kept aside), idempotent', () => {
  const path = join(TMP, 'pred-repair.json');
  writeFileSync(path, JSON.stringify({ entries: [
    { id: 'a', symbol: 'INFY', evaluated: true, realizedRetPct: -98.9, futureClose: 12.46, lastClose: 1160 },
    { id: 'b', symbol: 'TCS', evaluated: true, realizedRetPct: 0.4 },
    { id: 'c', symbol: '^NSEI', evaluated: false },
  ] }));
  const r = REP.repairPredictions(path, { apply: true });
  assert.equal(r.remapped, 2);
  assert.equal(r.voided.length, 1);
  const e = JSON.parse(readFileSync(path, 'utf8')).entries;
  assert.equal(e[0].symbol, 'INFY.NS');
  assert.equal(e[0].evaluated, false);
  assert.equal(e[0].voidedScore.futureClose, 12.46);
  assert.equal(e[1].evaluated, true);
  assert.equal(e[2].symbol, '^NSEI');
  const again = REP.repairPredictions(path, { apply: true });
  assert.equal(again.remapped + again.voided.length, 0);
});

// ------------------------------------------------------------------- S-B1 ---
test('S-B1: the weekly refit rebuilds the Breakdown after intraday-5y / day patterns; the build reads intraday-5y\'s own loop', () => {
  const sh = src('./scripts/run.sh');
  const i5 = sh.indexOf('paper-bot/intraday-5y.mjs');
  const dp = sh.indexOf('paper-bot/day-patterns.mjs');
  const bd = sh.indexOf('paper-bot/breakdown.mjs --build');
  assert.ok(i5 > 0 && dp > i5 && bd > dp, 'order: intraday-5y → day-patterns → breakdown --build');
  assert.match(sh, /--max-old-space-size=12000 paper-bot\/breakdown\.mjs --build/);
  const b = src('./paper-bot/breakdown.mjs');
  assert.match(b, /intradayTrades\(/);
  assert.match(src('./paper-bot/intraday-5y.mjs'), /export async function intradayTrades/);
});

// ------------------------------------------------------- options mediums ---
test('O-B4: vol check ±1σ uses trading days', () => {
  assert.match(src('./paper-bot/volatility.mjs'), /Math\.sqrt\(h \/ TRADING_DAYS\) \* 100\);/);
});

test('O-B5: a chain whose expiry passed, or > 2 sessions old, is stale with a plain reason', async () => {
  const rc = await import('./paper-bot/fo-riskcheck.mjs');
  const now = new Date('2026-11-25T06:00:00Z'); // Wed 11:30 IST
  assert.equal(rc.chainStale({ date: '2026-11-23', expiry: '2026-12-01' }, now).stale, false);
  const old = rc.chainStale({ date: '2026-11-04', expiry: '2026-11-24' }, now);
  assert.equal(old.stale, true);
  assert.match(old.why, /prices are from 2026-11-04 and their expiry \(2026-11-24\) has passed/);
  assert.equal(rc.chainStale({ date: '2026-11-16', expiry: '2026-12-29' }, now).stale, true, '4 sessions old');
  assert.match(src('./paper-bot/fo-riskcheck.mjs'), /if \(age\.stale\) throw new Error\(age\.why\)/);
});

test('O-B6/O-B7: bare tickers resolve NSE-first in the single-stock tools; the F&O banner uses the F&O practice money', () => {
  const s = src('./server.mjs');
  assert.equal((s.match(/await nseFirst\(/g) || []).length, 3);
  assert.match(s, /fo = foSizes\(loadSpreadPaper\(\)\?\.rules\?\.capital \|\| SPREAD_RULES\.capital\)\.text/);
});

const EX = await import('./paper-bot/expiry.mjs');
test('O-B8: expiry advice names what expires and what does not', () => {
  assert.equal(EX.adviceFor([{ index: 'SENSEX' }]), "Don't buy SENSEX options today (NIFTY and stock options are not expiring); if you must trade, use limit orders and defined risk.");
  assert.match(EX.adviceFor([{ index: 'NIFTY' }, { index: 'STOCKS' }], 'on Tue, 29 Dec'), /^Don't buy NIFTY and stock options on Tue, 29 Dec \(SENSEX options are not expiring\)/);
});

test('O-B9: dates past the published holiday list are flagged, not guessed', async () => {
  const mc = await import('./paper-bot/market-calendar.mjs');
  const until = mc.calendarCoveredUntil();
  assert.match(until, /^\d{4}-12-31$/);
  assert.equal(mc.calendarCovers(until), true);
  const next = `${Number(until.slice(0, 4)) + 1}-01-26`;
  assert.equal(mc.calendarCovers(next), false);
  const s = EX.expiryStatus(new Date(`${until.slice(0, 4)}-12-31T12:00:00Z`)); // evening of the last covered day: the next expiries are past the list
  assert.ok(s.next.some((n) => n.unverified?.length && n.calendarNote === 'holiday list not yet published'));
});

// ---------------------------------------------------- strategies mediums ---
test('S-B2: "What works today?" recent results use the logic\'s own unit (% / % of margin), not ₹', async () => {
  const { recentFor } = await import('./paper-bot/day-today.mjs');
  const r = recentFor('fo-strangle', { fo: { trades: [{ open: false, expiry: '2026-11-24', rupees: -38150, retOnMargin: -0.1724 }] } });
  assert.ok(Math.abs(r[0].result + 17.24) < 1e-9);
  const d = recentFor('nifty-dip', { dip: { trades: [{ open: false, exitDate: '2026-11-20', net: 900, retPct: 0.9, version: 'standard' }] } });
  assert.equal(d[0].result, 0.9);
});

test('S-B3: NSE holidays after the calendar data ends show on the grid', async () => {
  const { withUpcomingHolidays } = await import('./paper-bot/day-patterns.mjs');
  const d = withUpcomingHolidays({ calendar: { to: '2026-11-23', detail: { holidays: [] } } });
  assert.equal(d.calendar.detail.upcomingHolidays['2026-11-24'], 'Prakash Gurpurb Sri Guru Nanak Dev');
  assert.ok(!('2026-11-10' in d.calendar.detail.upcomingHolidays), 'past holidays stay with the data');
  assert.match(src('./static/js/36-calendar.js'), /upcomingHolidays\?\.\[d\]/);
});

test('S-B4: Compare all covers every strategy sub-tab, intraday rows use the 5-year run, no hard-coded counts', async () => {
  const { compareStrategies } = await import('./paper-bot/compare.mjs');
  const i5 = { vwap: { video: { from: '2020-01-01', to: '2026-11-23', stocks: 4, all: { trades: 3384, avg: -193, tStat: -9.5, total: -653145 } } }, breakfast: { from: '2020-01-02', to: '2026-11-23', stocks: 200, all: { trades: 3070, avg: -682, tStat: -10.2, total: -2093198 } } };
  const r = compareStrategies({ i5 });
  const keys = r.rows.map((x) => x.key);
  for (const k of ['ath', 'vwap', 'breakfast', 'r115', 'dip', 'fo', 'fno', 'rsi', 'mc', 'imb', 'e2', 'lbb', 'bsr', 'ipo']) assert.ok(keys.includes(k), k);
  assert.match(r.rows.find((x) => x.key === 'vwap').backtest, /3,384 trades/);
  assert.match(r.rows.find((x) => x.key === 'breakfast').backtest, /3,070 trades/);
  assert.match(r.advice, new RegExp(`^${r.rows.length} trading strategies`));
  assert.match(r.advice, /India mix/);
  assert.doesNotMatch(src('./index.html'), /All four strategies|The three strategies side by side/);
  assert.doesNotMatch(src('./static/js/06-home-views.js'), /eleven rule-based/);
});

// ------------------------------------------------------ Home / portfolio ---
test('M4/M5/L2: My plan says it is the older plan, names its swing version, and only says "falling markets" when OUT', () => {
  const m = src('./paper-bot/my-plan.mjs');
  assert.match(m, /superseded: 'This is the older 80 \/ 20 plan/);
  assert.match(m, /raw\.regime\?\.state === 'out' \? '; in falling markets like now/);
  assert.match(m, /swingNote:/);
  assert.match(src('./paper-bot/ath-swing.mjs'), /Swing paper \(\$\{ver\} rules, as the Swing trade plan\)/); // version label (follows "wide" since the M4 decision)
});

test('M6: a merge import adds this year\'s booked gains and skips trades already imported', async () => {
  const h = await import('./paper-bot/holdings.mjs');
  const now = new Date('2026-11-20T06:00:00Z');
  const csv = 'symbol,trade_date,trade_type,quantity,price\nAAA,2026-05-01,buy,10,100\nAAA,2026-06-01,sell,10,150\n';
  h.importTradebook({ csv, now });
  const first = h.loadHoldings().realized;
  assert.equal(first.stcg, 500);
  const csv2 = 'symbol,trade_date,trade_type,quantity,price\nBBB,2026-07-01,buy,5,100\nBBB,2026-08-01,sell,5,120\n';
  const r = h.importTradebook({ csv: csv2, now, mode: 'merge' });
  assert.equal(r.realized.stcg, 600, 'added, not overwritten');
  const again = h.importTradebook({ csv: csv2, now, mode: 'merge' });
  assert.equal(again.duplicates, 2);
  assert.equal(again.realized.stcg, 600, 're-importing the same file adds nothing');
});

test('P1/L3/L8: impossible dates rejected; future dates say so; recordedUpTo is a session', async () => {
  const dr = await import('./paper-bot/day-results.mjs');
  assert.throws(() => dr.dayResults('2026-02-30'), /not a real date/);
  assert.equal(dr.isRealDate('2024-02-29'), true);
  const r = dr.dayResults('2026-12-10', { vwap: { trades: [], updatedAt: '2026-11-24T11:00:00Z' }, breakfast: null, swing: null, dip: null, fo: null, now: new Date('2026-11-25T06:00:00Z') });
  assert.match(r.note, /future/);
  assert.equal(r.recordedUpTo, '2026-11-23', 'a run on the 24 Nov holiday covers the 23 Nov session');
  const h = await import('./paper-bot/holdings.mjs');
  assert.throws(() => h.addLot({ symbol: 'TCS', qty: 1, price: 100, date: '2024-02-30' }), /real YYYY-MM-DD/);
});

test('L5/L6/L7: journal settings ranges, unknown symbols, one alert per fired stop', async () => {
  await assert.rejects(() => J.saveSettings({ maxTradesPerDay: 0.3 }), /1 to 50/);
  await assert.rejects(() => J.saveSettings({ capital: 1e12 }), /1,000 crore/);
  await assert.rejects(() => J.saveSettings({ riskPct: 2, dailyLossPct: 1 }), /at least the risk per trade/);
  await assert.rejects(() => J.addAlert({ symbol: 'XYZZYQ', op: 'above', price: 10 }), /Unknown NSE symbol/);
  const p = await J.planTrade({ symbol: 'XYZZYQ', entry: 100, stop: 95 }, { now: new Date('2026-11-24T05:00:00Z'), ...noOdds });
  assert.match(p.warning, /Unknown NSE symbol/);
  // a fired stop alert is not re-created by the next sync at the same price
  await J.syncSourceAlerts('swing-paper', [{ symbol: 'TCS', op: 'below', price: 3000 }]);
  const st = J.loadJournal();
  st.alerts.find((a) => a.source === 'swing-paper').triggeredAt = new Date().toISOString();
  writeFileSync(process.env.JOURNAL_PATH, JSON.stringify(st));
  assert.equal(await J.syncSourceAlerts('swing-paper', [{ symbol: 'TCS', op: 'below', price: 3000 }]), 0);
  assert.equal(await J.syncSourceAlerts('swing-paper', [{ symbol: 'TCS', op: 'below', price: 3050 }]), 1, 'a raised stop is a new alert');
});

// ------------------------------------------------------------- Investing ---
test('INV-2: one-word names shared with foreign companies need the Indian company\'s phrase', async () => {
  const { ALIAS_MATCH } = await import('./paper-bot/news.mjs');
  assert.equal(ALIAS_MATCH.RAYMOND.test('Raymond James upgrades bank stocks'), false);
  assert.equal(ALIAS_MATCH.RAYMOND.test('Raymond shares jump after demerger'), true);
  assert.equal(ALIAS_MATCH.TITAN.test('Titan Machinery reports Q3'), false);
  assert.equal(ALIAS_MATCH.TITAN.test('Titan Company Q2 profit rises'), true);
});

test('INV-3: algo plan sizes Momentum 10 at the latest marked close, not the ranking close', async () => {
  const { latestCloseOf } = await import('./paper-bot/algo-plan.mjs');
  assert.equal(latestCloseOf('AAA', { marks: [{ symbol: 'AAA', last: 591 }] }, null), 591);
  assert.equal(latestCloseOf('BBB.NS', null, { marks: [{ symbol: 'BBB.NS', last: 50 }] }), 50);
  assert.equal(latestCloseOf('CCC', { marks: [] }, { marks: [] }), null);
});

test('INV-6: News watch rejects a symbol NSE does not list', async () => {
  const nw = await import('./paper-bot/news-watch.mjs');
  const { nseSymbols } = await import('./paper-bot/bhav-history.mjs');
  if (!nseSymbols()) return; // no NSE files on this machine: nothing to check against
  process.env.NEWS_WATCH_PATH ||= join(TMP, 'nw-list.json');
  assert.throws(() => nw.addWatchSymbol('ZZQQXX'), /Unknown NSE symbol/);
});

// -------------------------------------------------------------------- lows ---
test('L1/O-B10: no "-0.0"; ordinals', () => {
  const core = src('./static/js/01-core.js');
  const fixedNz = new Function(`${core.match(/const fixedNz = [\s\S]*?\n};/)[0]}; return fixedNz;`)();
  const ordinal = new Function(`${core.match(/const ordinal = [\s\S]*?\n};/)[0]}; return ordinal;`)();
  assert.equal(fixedNz(-0.04, 1), '0.0');
  assert.equal(fixedNz(-0.04, 1, true), '0.0');
  assert.equal(fixedNz(0.26, 1, true), '+0.3');
  assert.equal(fixedNz(-1.26, 1, true), '-1.3');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  assert.doesNotMatch(src('./static/js/09-options-risk.js'), /toFixed\(0\)\}th/);
  assert.match(src('./static/js/47-algo-plan.js'), /fixedNz\(z\.offPts, 1, true\)/);
});

test('L4: out-of-range amounts get a 400 naming the range', () => {
  const s = src('./server.mjs');
  assert.match(s, /rangedParam\(url\.searchParams\.get\('amount'\), 100000, 10000, 1e9, 'Amount'\)/);
  assert.match(s, /rangedParam\(url\.searchParams\.get\('capital'\), 500000, 50000, 1e9, 'Capital'\)/);
});

test('L10/INV-4/INV-5/INV-7/INV-8: wording', () => {
  const idx = src('./index.html');
  assert.doesNotMatch(idx, /ALL FOUR STRATEGIES/);
  assert.doesNotMatch(src('./static/js/46-news-watch.js') + src('./static/js/51-cp-tournament.js') + idx, /08:40/);
  assert.match(src('./static/js/46-news-watch.js'), /window\.NW_FLASH/);
  const inv = src('./static/js/07-investing.js');
  assert.match(inv, /hdSignedRs\(r\.realized\.stcg\)/);
  assert.match(inv, /ten\.lumpSum\.worstPct >= 0 \? 'every 10-year hold made money'/);
  assert.match(inv, /Number\(\$\('glSip'\)\.value\) > 0/);
  assert.match(inv, /lump sum alone reached the target/);
  for (const t of ['Ask (research', 'Market data', 'Stock ranking', 'Settings', 'Phone access', 'Direction over months']) {
    const i = idx.indexOf(`<h2>${t}`);
    assert.match(idx.slice(i, idx.indexOf('</section>', i)), /Not advice/i, t);
  }
});

test('O-B11: risk check accepts SBIN.NS and says plainly which symbols are covered', () => {
  const s = src('./server.mjs');
  assert.match(s, /\.replace\(\/\\\.NS\$\/, ''\);\n\s+if \(!\/\^\[A-Z0-9&-\]/);
  assert.match(s, /Only NIFTY and NSE stock options are covered here/);
});

test('O-B13: zero-vol price with time left is the discounted intrinsic value', async () => {
  const { greeks } = await import('./blackscholes.mjs');
  assert.ok(Math.abs(greeks({ spot: 2500, strike: 2520, tYears: 7 / 365, iv: 0, type: 'PE' }).price - (2520 * Math.exp(-0.065 * 7 / 365) - 2500)) < 1e-9);
  assert.equal(greeks({ spot: 2500, strike: 2520, tYears: 0, iv: 0.2, type: 'PE' }).price, 20, 'at expiry: plain intrinsic');
  assert.equal(greeks({ spot: 2500, strike: 2499, tYears: 30 / 365, iv: 0, type: 'PE' }).price, 0);
});

test('O-B14/O-B15/O-B16/O-B17/O-B18: payoff-odds guards, NIFTY window, hit-rate labels, live intro, months wording', () => {
  const oo = src('./paper-bot/option-odds.mjs');
  assert.match(oo, /is more than the/);
  assert.match(oo, /fair < 0\.05/);
  assert.match(src('./paper-bot/fo-plan.mjs'), /const endDate = paper\.curve\?\.at\(-1\)\?\.date/);
  assert.match(src('./static/js/03-lab-scores.js'), /one per stock per day/);
  assert.match(src('./static/js/03-lab-scores.js'), /' IST'/);
  assert.match(src('./paper-bot/cp-tournament.mjs'), /on the live scorecard, \$\{history\.scored\} scored/);
  assert.match(src('./static/js/35-fo-plan.js'), /months with a closed trade/);
});

test('S-B6..S-B13: 1:15 nowrap, Breakdown banner / dates / series, calendar month source, one day-patterns fetch, IPO label', async () => {
  assert.match(src('./static/js/44-one-fifteen.js'), /white-space:nowrap/);
  const bd = await import('./paper-bot/breakdown.mjs');
  assert.throws(() => bd.breakdownQuery({ from: '2026-02-01', to: '2026-01-01' }), /after To/);
  assert.match(src('./paper-bot/breakdown.mjs'), /failing: validation\.filter/);
  assert.match(src('./static/js/45-breakdown.js'), /"From" is after "To"/);
  assert.match(src('./paper-bot/breakdown.mjs'), /dateField: 'entry', includeOpen: true/);
  assert.match(src('./static/js/36-calendar.js'), /det\.niftyMonth\?\.\[ym\]/);
  assert.match(src('./static/js/17-day-patterns.js'), /dayPatternsOnce\(\)/);
  assert.match(src('./static/js/36-calendar.js'), /dayPatternsOnce\(\)/);
  assert.match(src('./static/js/42-ipo-apply.js'), /among the \$\{t\.settled \|\| 0\} settled/);
});

test('ORDER: ML stock picks after Momentum 10; Leader box, Bonus/split, IPO apply before Matrix calendar', () => {
  const v = src('./static/js/06-home-views.js');
  assert.match(v, /'Momentum 10', 'ML stock picks'/);
  assert.match(v, /'Momentum breakout', 'Leader box breakout', 'Bonus\/split run-up', 'IPO apply', 'Matrix calendar'/);
});

// ------------------------------------------------- owner decisions (25 Nov 2026) ---
test('H1 (decision): the paper record keeps every signal; the plan card says so', () => {
  assert.match(src('./static/js/29-trade-plan.js'), /The paper record tracks every signal[^']*this plan shows what fits your capital/);
  // the paper bot's rules are unchanged: every signal is recorded
  assert.match(src('./paper-bot/ath-swing.mjs'), /for \(const t of data\.flatMap\(\(\{ s, rows \}\) => tradesFor\(s, rows, rules\)\)\.filter\(\(x\) => x\.entryDate >= st\.startedAt\)\) fresh\.push/);
});

test('M4 (decision): swing alerts follow the Swing trade plan\'s "wide" version and say so', async () => {
  const { swingAlertList, SWING_ALERT_VERSION } = await import('./paper-bot/ath-swing.mjs');
  assert.equal(SWING_ALERT_VERSION, 'wide');
  const paper = { trades: [
    { symbol: 'AAA.NS', version: 'wide', open: true, trail: 95, entryDate: '2026-11-02' },
    { symbol: 'BBB.NS', version: 'improved', open: true, trail: 50, entryDate: '2026-11-02' },
    { symbol: 'CCC.NS', version: 'wide', open: false, trail: 10, entryDate: '2026-11-02' },
  ] };
  const l = swingAlertList(paper);
  assert.deepEqual(l.map((x) => [x.symbol, x.price]), [['AAA.NS', 95]]);
  assert.match(l[0].note, /wide rules, as the Swing trade plan/);
  assert.match(src('./paper-bot/ath-swing.mjs'), /syncSourceAlerts\('swing-paper', swingAlertList\(loadAthPaper\(\)\)\)/);
});

test('INV-2 (decision): the company\'s own non-routine NSE filing sets the event over headlines', async () => {
  const nw = await import('./paper-bot/news-watch.mjs');
  const items = [
    { source: 'Economic Times', title: 'results', event: { type: 'results', sub: null, routine: false } },
    { source: 'NSE', title: 'order win', event: { type: 'order', sub: null, routine: false } },
    { source: 'NSE', title: 'trading window', event: { type: 'other', sub: null, routine: true } },
  ];
  assert.equal(nw.mainEvent(items).type, 'order');
  assert.equal(nw.mainEvent(items.slice(0, 1)).type, 'results', 'headlines alone still count');
  assert.equal(nw.MAIN_EVENT_RULE_SINCE, '2026-11-25');
  assert.match(src('./paper-bot/news-pick.mjs'), /Change 25 Nov 2026/);
  assert.match(src('./static/js/46-news-watch.js'), /since 25 Nov 2026/);
});

test('O-B19 (decision): today\'s unfinished daily bar is left out during the session only', async () => {
  const { completedDaily } = await import('./paper-bot/market-calendar.mjs');
  const rows = [{ date: '2026-11-24' }, { date: '2026-11-25' }];
  const at = (hhmm) => new Date(`2026-11-25T${hhmm}:00+05:30`);
  assert.deepEqual(completedDaily(rows, at('10:15')), { rows: rows.slice(0, 1), dropped: true });
  assert.equal(completedDaily(rows, at('15:40')).dropped, false, 'after the close: unchanged');
  assert.equal(completedDaily([{ date: '2026-11-21' }], new Date('2026-11-22T05:00:00Z')).dropped, false, 'weekend: unchanged');
  const { bigMove } = await import('./paper-bot/big-move.mjs');
  const days = [];
  for (let t = Date.parse('2024-01-01'); days.length < 600; t += 86400000) { const d = new Date(t).toISOString().slice(0, 10); const wd = new Date(t).getUTCDay(); if (wd && wd < 6) days.push(d); }
  days.push('2026-11-25');
  const fake = async () => days.map((date, i) => ({ date, open: 100 + (i % 9), high: 103 + (i % 9), low: 98 + (i % 9), close: 100 + ((i * 7) % 11) }));
  const r = await bigMove({ symbol: 'TEST.NS', loadCandles: fake, now: at('10:15') });
  assert.equal(r.asOf, days.at(-2));
  assert.equal(r.partialDropped, true);
  for (const f of ['volatility', 'option-odds']) assert.match(src(`./paper-bot/${f}.mjs`), /completedDaily\(await loadCandles/, f);
  assert.match(src('./static/js/09-options-risk.js'), /today's unfinished bar left out/);
});

test('S-B11 (decision): the swing loader drops bars dated on NSE holidays, keeps weekend special sessions', async () => {
  const { dropHolidayBars } = await import('./paper-bot/market-calendar.mjs');
  const rows = [{ date: '2026-01-14' }, { date: '2026-01-15' }, { date: '2026-01-16' }, { date: '2026-02-01' }];
  assert.deepEqual(dropHolidayBars(rows).map((r) => r.date), ['2026-01-14', '2026-01-16', '2026-02-01']);
  const { loadDaily } = await import('./paper-bot/ath-swing.mjs');
  const bars = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.parse('2025-01-01') + i * 86400000).toISOString().slice(0, 10), open: 1, high: 1, low: 1, close: 1 }));
  const [x] = await loadDaily(async () => bars, ['X.NS'], '2025-01-01', new Date('2026-11-25T12:00:00Z'));
  assert.ok(!x.rows.some((r) => r.date === '2026-01-15'));
});

test('UX (decision): Investing order, Strategies card in Research lab with the survivorship banner, phone expiry chip', () => {
  const v = src('./static/js/06-home-views.js');
  assert.match(v, /'India mix', 'Momentum 10', 'ML stock picks', "Don't buy now", 'News watch', 'Global mix', 'Finalist 2', 'Steady mix', 'Momentum 20', 'What to expect', 'Goal planner', 'Index-fund picker', 'Market tilts', 'New ideas test', 'Core \+ satellite'/);
  const inv = v.match(/key: 'invest', match: (\/.*?\/),/)[1];
  assert.doesNotMatch(inv, /Strategies/);
  assert.match(src('./index.html'), /Uses today's stock list \(survivorship-biased\) — see <a href="#" data-goto="momCard">Momentum 20<\/a> for the honest, survivorship-free test\./);
  const xp = src('./static/js/48-expiry.js');
  assert.match(xp, /matchMedia\('\(max-width: 639\.98px\)'\)/);
  assert.match(xp, /class="xpMini/);
  assert.match(xp, /class="xpChip/);
  assert.match(src('./static/app.css'), /\.xpChip \{/);
});
