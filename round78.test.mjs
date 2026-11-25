// Tests for the Call / Put prediction tournament (paper-bot/cp-tournament.mjs), a FORWARD test, PAPER ONLY:
//  • the pre-open data guard: a contestant can't read data that was final at or after the session open (or after "now");
//  • each baseline (always CALL / PUT, seeded coin, continuation, reversal);
//  • frozen-version hashing (stable; changes with the code, a reused function or a parameter);
//  • scoring maths (hit, Wilson interval, Brier / skill, log loss, one-sided p, Holm, BH) and the leaderboard bar;
//  • the weighted ensemble only uses scores from BEFORE the prediction day;
//  • expiry-day handling (no option P&L, no option fetch);
//  • the no-key LLM skip (and a rejected key);
//  • the predict → score walk on fake data (late / duplicate / test runs, day + 5-session + T1 same-day scoring),
//    the CLI on a temp file, the Breakdown adapter (validation passes) and the UI / server / run.sh wiring.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r78-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.CP_TOURNAMENT_PATH = join(TMP, 'cp-tournament.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');

const CP = await import('./paper-bot/cp-tournament.mjs');
const { isTradingDay } = await import('./paper-bot/market-calendar.mjs');

// ------------------------------------------------------------------ fake data ---
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
/** `n` NSE sessions ending on `last` (inclusive), oldest first. */
function sessions(last, n) {
  const out = [];
  for (let d = last; out.length < n; d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
}
/** Daily NIFTY bars with a gentle up-trend and a wiggle; the last bar falls (for continuation / reversal). */
function niftyRows(last, n = 600, { lastUp = false } = {}) {
  return sessions(last, n).map((date, i) => {
    const c = 20000 + i * 5 + (i % 7) * 30;
    const close = i === n - 1 ? (lastUp ? c + 400 : c - 400) : c;
    return { date, open: c - 10, high: Math.max(c, close) + 60, low: Math.min(c, close) - 60, close, volume: 1000 };
  });
}
const vixRows = (last, n = 600) => sessions(last, n).map((date, i) => ({ date, open: 14, high: 15, low: 13, close: 12 + (i % 50) / 10 }));
const spxRows = (last, mv = 1) => sessions(last, 10).map((date, i) => ({ date, open: 5000, close: i === 9 ? 5000 * (1 + mv / 100) : 5000 }));
function rawInputs(date, over = {}) {
  const prev = sessions(addDays(date, -1), 1)[0];
  return {
    nifty: niftyRows(prev), vix: vixRows(prev), spx: spxRows(prev), positioning: [], fii: [], headlines: [],
    newsPick: null, cal: {}, bigMoveEval: null, posResult: null, llm: null, llmKey: false,
    baseRate: { day: 0.52, five: 0.56 }, trail: {}, errors: [], fetched: { positioning: 0, fii: 0 }, ...over,
  };
}
const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);
const D = '2026-11-26'; // Thursday, not a NIFTY expiry day

// ------------------------------------------------------------------ the pre-open guard ---
test('pre-open guard: rows final at/after the open (or after now) never reach a contestant', async () => {
  const raw = rawInputs(D);
  // a leaked bar for the session itself (as Yahoo serves once the market opens) and a US bar not closed yet
  raw.nifty = [...raw.nifty, { date: D, open: 30000, high: 31000, low: 29000, close: 30500, volume: 1 }];
  raw.spx = [...raw.spx, { date: D, open: 5000, close: 9000 }];
  raw.headlines = [{ time: '2026-11-26T03:00:00Z', title: 'before' }, { time: '2026-11-26T04:00:00Z', title: 'after the open' }];
  const now = ist(D, '08:40');
  assert.throws(() => CP.assertPreOpen({ ...raw, cutoff: CP.cutoffFor(D, now) }), /pre-open guard: nifty row 2026-11-26/);
  const inp = CP.guardInputs(raw, D, now);
  assert.ok(inp.nifty.every((r) => r.date < D), 'no NIFTY bar of the session');
  assert.equal(inp.nifty.at(-1).date, '2026-11-25');
  assert.equal(inp.spx.at(-1).date, '2026-11-25', 'the US bar of 25 Nov (closed 02:30 IST on the 26th) is kept, the 26th is not');
  assert.deepEqual(inp.headlines.map((h) => h.title), ['before']);
  assert.ok(CP.assertPreOpen(inp));
  assert.ok(Object.isFrozen(inp) && Object.isFrozen(inp.nifty) && Object.isFrozen(inp.nifty[0]), 'contestants get frozen copies');
  // the continuation contestant reads yesterday's move, not the leaked one (+30500 would be "up")
  const cont = CP.CONTESTANTS.find((c) => c.id === 'continuation');
  assert.equal((await cont.predict(inp)).day.call, 'PUT');
  // runContestants refuses unguarded input
  await assert.rejects(CP.runContestants({ ...raw, cutoff: CP.cutoffFor(D, now) }), /pre-open guard/);
  // a test run made BEFORE the previous close: the in-progress bar of the 25th is not final yet → dropped
  const early = CP.guardInputs(rawInputs(D), D, ist('2026-11-25', '14:00'));
  assert.equal(early.nifty.at(-1).date, '2026-11-23', '24 Nov is an NSE holiday; the 25th was still trading');
  // close-time rules
  assert.equal(CP.CLOSE_TIME.m5({ date: '2026-11-26 09:10' }), Date.parse('2026-11-26T09:15:00+05:30'));
  assert.equal(CP.preOpen([{ date: '2026-11-26 09:10' }, { date: '2026-11-26 09:15' }], 'm5', CP.openMs(D)).length, 0, 'a 09:10 bar closes at 09:15 — not before the open');
});

// ------------------------------------------------------------------ baselines ---
test('baselines: always CALL / PUT, seeded coin, continuation, reversal', async () => {
  const by = Object.fromEntries(CP.CONTESTANTS.map((c) => [c.id, c]));
  const inp = CP.guardInputs(rawInputs(D), D, ist(D, '08:40'));
  const ac = await by['always-call'].predict(inp);
  assert.equal(ac.day.call, 'CALL');
  assert.equal(ac.day.pUp, 0.52, 'the base rate');
  assert.equal(ac.five.pUp, 0.56);
  assert.equal((await by['always-put'].predict(inp)).day.call, 'PUT');
  const c1 = await by.coin.predict(inp);
  assert.deepEqual(c1, await by.coin.predict(inp), 'same date → same flip');
  assert.equal(c1.day.pUp, 0.5);
  const flips = new Set();
  for (const d of sessions('2026-12-31', 30)) flips.add((await by.coin.predict({ ...inp, date: d })).day.call);
  assert.deepEqual([...flips].sort(), ['CALL', 'PUT'], 'the coin lands both ways over a month');
  const down = await by.continuation.predict(inp);
  assert.equal(down.day.call, 'PUT');
  assert.ok(down.day.pUp < 0.52);
  assert.equal((await by.reversal.predict(inp)).day.call, 'CALL');
  const upInp = CP.guardInputs(rawInputs(D, { nifty: niftyRows('2026-11-25', 600, { lastUp: true }) }), D, ist(D, '08:40'));
  assert.equal((await by.continuation.predict(upInp)).day.call, 'CALL');
  assert.equal((await by.reversal.predict(upInp)).day.call, 'PUT');
  assert.match((await by.continuation.predict(CP.guardInputs(rawInputs(D, { nifty: [] }), D, ist(D, '08:40')))).skip, /not enough/);
});

// ------------------------------------------------------------------ version hashing ---
test('frozen versions: stable, and change with the code, a reused function or a parameter', () => {
  const v = CP.versions();
  assert.deepEqual(v, CP.versions());
  assert.equal(Object.keys(v).length, CP.CONTESTANTS.length + 1);
  for (const h of Object.values(v)) assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(new Set(Object.values(v)).size, Object.keys(v).length, 'every contestant has its own hash');
  const c = CP.CONTESTANTS.find((x) => x.id === 'trend-20-50');
  assert.equal(CP.versionOf(c), v['trend-20-50']);
  assert.notEqual(CP.versionOf({ ...c, predict: (inp) => ({ skip: String(inp) }) }), v['trend-20-50'], 'code change → new version');
  assert.notEqual(CP.versionOf({ ...c, params: { x: 1 } }), v['trend-20-50'], 'parameter change → new version');
  assert.notEqual(CP.versionOf({ ...c, deps: [() => 1] }), v['trend-20-50'], 'a reused function changes → new version');
  // an old version's record is not counted for the current one
  const st = { days: [{ date: '2026-11-26', preds: { 'trend-20-50': { version: 'aaaaaaaaaaaa', day: { call: 'CALL', pUp: 0.55 }, score: { day: { hit: true, brier: 0.2, brierRef: 0.25, ll: 0.6, llRef: 0.7 } } } } }] };
  assert.equal(CP.contestantStats(st, 'day', 'trend-20-50').n, 0);
});

// ------------------------------------------------------------------ scoring maths ---
test('scoring maths: hit, Wilson, Brier skill, log loss, p-values, Holm, BH', () => {
  const [lo, hi] = CP.wilson(50, 100);
  assert.ok(Math.abs(lo - 0.4038) < 1e-3 && Math.abs(hi - 0.5962) < 1e-3);
  assert.equal(CP.wilson(0, 0), null);
  assert.ok(Math.abs(CP.brier(0.7, true) - 0.09) < 1e-12);
  assert.ok(Math.abs(CP.brier(0.7, false) - 0.49) < 1e-12);
  assert.ok(Math.abs(CP.brierSkill(0.2, 0.25) - 0.2) < 1e-12);
  assert.ok(Math.abs(CP.logLoss(0.5, true) - Math.log(2)) < 1e-12);
  const s = CP.scoreOne({ call: 'PUT', pUp: 0.4 }, { up: false, ret: -0.01, endDate: D }, 0.5);
  assert.equal(s.hit, true);
  assert.ok(Math.abs(s.brier - 0.16) < 1e-12 && s.brierRef === 0.25);
  const nt = CP.scoreOne({ call: 'NO TRADE', pUp: 0.5 }, { up: true, ret: 0.01, endDate: D }, 0.5);
  assert.equal(nt.hit, null);
  assert.equal(nt.noTrade, true, 'NO TRADE is counted apart (still in the Brier score)');
  assert.ok(Math.abs(CP.pAbove(60, 100, 0.5) - 0.02275) < 1e-4);
  const hol = CP.holm([0.01, 0.04, 0.03, null]);
  assert.deepEqual(hol.map((x) => (x == null ? null : Math.round(x * 1e6) / 1e6)), [0.03, 0.06, 0.06, null]);
  const q = CP.bh([0.01, 0.04, 0.03, null]);
  assert.deepEqual(q.map((x) => (x == null ? null : Math.round(x * 1e6) / 1e6)), [0.03, 0.04, 0.04, null]);
  assert.equal(CP.tStat([1]), null);
  assert.ok(Math.abs(CP.tStat([1, 2, 3]) - 2 / (1 / Math.sqrt(3))) < 1e-9);
});

/** A state where `good` is right on every day, always-call right on half, others right 50%; n days of +₹100 P&L for good. */
function synthState(n, good = 'trend-20-50') {
  const v = CP.versions();
  const days = sessions('2027-06-30', n).map((date, i) => {
    const up = i % 2 === 0;
    const preds = {};
    for (const c of CP.CONTESTANTS) {
      const pc = c.id === good ? (up ? 'CALL' : 'PUT') : c.id === 'always-call' ? 'CALL' : i % 4 < 2 ? 'CALL' : 'PUT';
      const pUp = c.id === good ? (up ? 0.7 : 0.3) : 0.5;
      const sc = CP.scoreOne({ call: pc, pUp }, { up, ret: up ? 0.01 : -0.01, endDate: date }, 0.5);
      sc.pnl = sc.hit ? 100 : -100;
      preds[c.id] = { version: v[c.id], day: { call: pc, pUp, conf: 0, why: '' }, score: { day: sc } };
    }
    return { date, preds };
  });
  return { days, baseRate: { day: 0.5, five: 0.5 } };
}
test('leaderboard: proven only with ≥100 calls, CI above the bar, Brier skill, P&L and Holm; else LEADING — unproven', () => {
  const small = CP.leaderboard(synthState(40), 'day');
  assert.deepEqual(small.proven, []);
  const lead = small.rows.find((r) => r.id === 'trend-20-50');
  assert.equal(lead.status, 'LEADING — still unproven');
  assert.ok(lead.why.some((w) => /40 of 100 scored calls/.test(w)));
  assert.match(small.verdict, /^No contestant is proven\./);
  assert.match(small.correction, /Holm step-down/);
  assert.match(small.correction, /Benjamini–Hochberg/);
  assert.equal(small.baseHit, 0.5);
  const big = CP.leaderboard(synthState(120), 'day');
  assert.deepEqual(big.proven, ['trend-20-50']);
  const p = big.rows.find((r) => r.id === 'trend-20-50');
  assert.equal(p.status, 'PROVEN (forward, after Holm)');
  assert.ok(p.pHolm < 0.05 && p.qBH <= p.pHolm && p.brierSkill > 0 && p.pnl > 0);
  assert.equal(p.spark.length, 120);
  assert.equal(p.spark.at(-1), 120);
  assert.ok(big.rows.filter((r) => r.id !== 'trend-20-50').every((r) => r.status !== 'PROVEN (forward, after Holm)'));
});

// ------------------------------------------------------------------ ensembles use the past only ---
test('the weighted ensemble only uses scores from BEFORE the prediction day', async () => {
  const st = synthState(30, 'trend-20-50');
  const cut = st.days[20].date;
  const tr = CP.trailingScores(st, cut);
  assert.equal(tr['trend-20-50'].day.n, 20, 'only the 20 days before the cut');
  assert.equal(tr['trend-20-50'].day.hits, 20);
  // a 5-session score counts only once its 5th session ended before the prediction day
  const st5 = { days: [{ date: '2026-11-20', preds: { fii: { version: CP.versions().fii, five: { call: 'CALL', pUp: 0.5 }, score: { five: { hit: true, endDate: '2026-11-26' } } } } }] };
  assert.equal(CP.trailingScores(st5, '2026-11-26').fii, undefined);
  assert.equal(CP.trailingScores(st5, '2026-11-27').fii.five.n, 1);
  // test entries never count
  assert.equal(CP.trailingScores({ days: st.days.map((d) => ({ ...d, test: true })) }, '2027-12-31')['trend-20-50'], undefined);
  // the ensemble follows a contestant with a positive PAST record, ignores the future
  const w = CP.CONTESTANTS.find((c) => c.id === 'weighted');
  const calls = { 'trend-20-50': { day: { call: 'PUT', pUp: 0.4 }, five: { call: 'PUT', pUp: 0.4 } }, fii: { day: { call: 'CALL', pUp: 0.6 }, five: { call: 'CALL', pUp: 0.6 } } };
  const inp = CP.guardInputs(rawInputs(D, { trail: CP.trailingScores(st, cut) }), D, ist(D, '08:40'));
  const r = await w.predict(inp, { calls, groupOf: CP.groupOf });
  assert.equal(r.day.call, 'PUT');
  const none = await w.predict(CP.guardInputs(rawInputs(D, { trail: CP.trailingScores(st, st.days[0].date) }), D, ist(D, '08:40')), { calls, groupOf: CP.groupOf });
  assert.equal(none.day.call, 'NO TRADE', 'no past record → no weighted call');
  // majority: models only
  const m = CP.CONTESTANTS.find((c) => c.id === 'majority');
  const mm = await m.predict(inp, { calls: { ...calls, 'always-put': { day: { call: 'PUT', pUp: 0.4 }, five: { call: 'PUT', pUp: 0.4 } }, 'cp-model': calls.fii }, groupOf: CP.groupOf });
  assert.equal(mm.day.call, 'CALL', '2 model CALLs vs 1 model PUT; the always-PUT baseline does not vote');
});

// ------------------------------------------------------------------ expiry day ---
test('expiry day: never an option, no P&L, no option fetch', async () => {
  assert.deepEqual(CP.dayPnl({ call: 'CALL' }, { ret: 0.01 }, { date: '2026-12-01', atrPct: 0.01, expiry: true }), { pnl: null, source: 'NIFTY expiry day — no option bought (never on expiry day)' });
  const real = { pnl: 300, source: 'real option (Groww 5-minute)' };
  assert.equal(CP.dayPnl({ call: 'PUT' }, { ret: -0.01 }, { date: D, atrPct: 0.01, expiry: false, option: { PUT: real } }), real);
  const proxy = CP.dayPnl({ call: 'PUT' }, { ret: -0.01 }, { date: D, atrPct: 0.01, expiry: false, option: { PUT: null } });
  assert.match(proxy.source, /futures-move proxy/);
  assert.ok(proxy.pnl > 1800 && proxy.pnl < 2000, '1 ATR in the right direction ≈ +₹2,000 less futures costs');
  assert.equal(CP.dayPnl({ call: 'NO TRADE' }, { ret: 0.01 }, { date: D, atrPct: 0.01 }), null);
  // a real option day trade: bought at the 09:20 bar open, sold at the 15:15 bar open, STT 0.15% of the premium on the sale
  const bars = [['09:15', 90], ['09:20', 100], ['12:00', 120], ['15:15', 110], ['15:20', 50]].map(([t, o]) => ({ date: `${D} ${t}`, open: o, close: o }));
  const t = CP.optionDayTrade(bars, D);
  assert.equal(t.entry.price, 100);
  assert.equal(t.exit.price, 110);
  assert.ok(t.ret > 0.07 && t.ret < 0.09, "+10% gross less slippage, ₹20 orders, STT, exchange, stamp, GST");
  assert.ok(Math.abs(t.pnl - t.ret * 2000) < 1e-9);
  // the walk on a NIFTY expiry day (Tue 1 Dec 2026): no option fetched
  const file = join(TMP, 'expiry.json');
  const r = await CP.predictDay({ file, now: ist('2026-12-01', '08:40'), clock: () => ist('2026-12-01', '08:41'), inputsFn: async (d) => rawInputs(d) });
  assert.equal(r.rec.expiry, true);
  assert.equal(r.rec.test, false);
  let fetched = 0;
  await CP.scoreTournament({ file, now: ist('2026-12-01', '20:00'), outcomesFn: async () => niftyRows('2026-12-01', 10), optionFn: async () => { fetched++; return null; }, barsFn: async () => [], afternoonFile: join(TMP, 'none.json') });
  assert.equal(fetched, 0);
  const st = CP.loadTournament(file);
  const p = st.days[0].preds['always-call'].score.day;
  assert.equal(p.pnl, null);
  assert.match(p.pnlSource, /expiry day/);
});

// ------------------------------------------------------------------ LLM ---
test('the LLM contestant: skipped without a key, skipped on a rejected key, read when it answers', async () => {
  const llm = CP.CONTESTANTS.find((c) => c.id === 'llm');
  let called = 0;
  const base = rawInputs(D, { llm: async () => { called++; return '{}'; } });
  const noKey = await llm.predict(CP.guardInputs({ ...base, llmKey: false }, D, ist(D, '08:40')));
  assert.equal(noKey.skip, 'no OpenRouter key — skipped');
  assert.equal(called, 0, 'no call is made without a key');
  const bad = await llm.predict(CP.guardInputs({ ...base, llmKey: true, llm: async () => { throw new Error('OpenRouter rejected the API key (401) — check or replace the key.'); } }, D, ist(D, '08:40')));
  assert.match(bad.skip, /rejected \(401\)/);
  const ok = await llm.predict(CP.guardInputs({ ...base, llmKey: true, llm: async () => '```json\n{"day":{"call":"PUT","prob_up":0.42,"confidence":0.3},"five":{"call":"no_trade","prob_up":0.5,"confidence":0.1},"reason":"r"}\n```' }, D, ist(D, '08:40')));
  assert.equal(ok.day.call, 'PUT');
  assert.equal(ok.day.pUp, 0.42);
  assert.equal(ok.five.call, 'NO TRADE');
  // inside the whole run, a skipped contestant is recorded as skipped and the others still call
  const preds = await CP.runContestants(CP.guardInputs({ ...base, llmKey: false }, D, ist(D, '08:40')));
  assert.equal(preds.llm.skipped, 'no OpenRouter key — skipped');
  assert.equal(preds['always-call'].day.call, 'CALL');
  assert.equal(preds.positioning.skipped.startsWith('no NSE F&O positioning'), true);
});

// ------------------------------------------------------------------ the walk ---
test('predict → score walk on fake data (late, duplicate and test runs; day, 5 sessions, T1)', async () => {
  const file = join(TMP, 'walk.json');
  const inputsFn = async (d) => rawInputs(d, { newsPick: { picks: [{ symbol: 'ABC' }] } });
  // after the open: no real run
  const late = await CP.predictDay({ file, now: ist(D, '09:20'), inputsFn });
  assert.equal(late.skipped, 'late');
  // a holiday
  assert.equal((await CP.predictDay({ file, now: ist('2026-11-28', '08:40'), inputsFn })).skipped, 'holiday');
  // a TEST entry first (never scored, does not start the record)
  const t = await CP.predictDay({ file, date: D, now: ist('2026-11-25', '20:00'), inputsFn });
  assert.equal(t.rec.test, true);
  assert.equal(t.st.startedAt, null);
  // the real 08:40 run
  const r = await CP.predictDay({ file, now: ist(D, '08:40'), clock: () => ist(D, '08:42'), inputsFn });
  assert.equal(r.rec.test, false);
  assert.equal(r.st.startedAt, D);
  assert.equal(r.rec.preds['news-pick'].day.call, 'CALL');
  for (const c of CP.CONTESTANTS) assert.ok(r.rec.preds[c.id].day || r.rec.preds[c.id].skipped, c.id);
  assert.equal((await CP.predictDay({ file, now: ist(D, '08:50'), inputsFn })).skipped, 'done', 'the first calls stand');
  // a run that FINISHES after the open is not scored
  const slow = await CP.predictDay({ file, now: ist('2026-11-27', '08:40'), clock: () => ist('2026-11-27', '09:16'), inputsFn });
  assert.equal(slow.rec.test, true);
  assert.match(slow.rec.testReason, /after the 09:15 open/);
  // evening of 26 Nov: the day horizon scores, the 5-session one waits; T1 from 5-minute bars (signal at 12:25)
  const daily = (upTo) => sessions(upTo, 12).map((date, i) => ({ date, open: 20000 + i * 10, high: 0, low: 0, close: 20000 + i * 10 + (date === D ? 100 : -20) }));
  const m5 = [];
  for (let m = 555; m <= 925; m += 5) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const px = 20000 + (m - 555) * 0.6; // a steady up-trend: +0.4% well before 12:25, at the high
    m5.push({ date: `${D} ${hhmm}`, open: px - 0.2, close: px, volume: 0 });
  }
  const optionCalls = [];
  const optionFn = async (o) => { optionCalls.push(o.type); return o.type === 'CE' ? { pnl: 250, ret: 0.125, source: 'real option (Groww 5-minute)' } : null; };
  const s1 = await CP.scoreTournament({ file, now: ist(D, '20:00'), outcomesFn: async () => daily(D), optionFn, barsFn: async () => m5, afternoonFile: join(TMP, 'none.json') });
  assert.ok(s1.scoredNow >= 2);
  let st = CP.loadTournament(file);
  const day = st.days.find((x) => x.date === D);
  assert.ok(day.scored.day && !day.scored.five && day.scored.pm);
  assert.equal(day.outcome.day.up, true);
  assert.deepEqual(optionCalls.sort(), ['CE', 'PE'], 'one option fetch per side');
  const ac = day.preds['always-call'].score.day;
  assert.equal(ac.hit, true);
  assert.equal(ac.pnl, 250);
  assert.match(ac.pnlSource, /real option/);
  assert.equal(day.preds['always-put'].score.day.hit, false);
  assert.match(day.preds['always-put'].score.day.pnlSource, /futures-move proxy/, 'no PUT option prices → the proxy');
  const t1 = day.preds['afternoon-t1'];
  assert.equal(t1.pm.call, 'CALL');
  assert.equal(t1.score.pm.hit, true);
  assert.match(t1.predictedAt, /bars up to 12:25 only/);
  assert.ok(!st.tests.some((x) => x.scored), 'test entries are never scored');
  // a week later: the 5-session horizon (26, 27, 30 Nov, 1, 2 Dec)
  await CP.scoreTournament({ file, now: ist('2026-12-04', '20:00'), outcomesFn: async () => daily('2026-12-04'), optionFn, barsFn: async () => [], afternoonFile: join(TMP, 'none.json') });
  st = CP.loadTournament(file);
  const d2 = st.days.find((x) => x.date === D);
  assert.equal(d2.outcome.five.endDate, '2026-12-02');
  assert.ok(d2.preds['always-call'].score.five.hit != null);
  // the leaderboards + the card view
  const v = CP.tournamentView({ file, now: ist('2026-12-04', '20:00') });
  assert.equal(v.startedAt, D);
  assert.equal(v.boards.day.rows.find((x) => x.id === 'always-call').n, 1);
  assert.equal(v.boards.pm.rows[0].id, 'afternoon-t1');
  assert.match(v.boards.day.verdict, /^No contestant is proven/);
  assert.equal(v.today.calls.length, CP.CONTESTANTS.length + 1);
  assert.match(v.why, /replaces backtest searching with forward testing/);
  assert.match(v.note, /Not advice\.$/);
  assert.ok(v.history && v.history.scored === 0, 'the Call/Put card\'s live record (empty temp log here) is the starting history');
});

test('CLI: usage, holiday, nothing to score — on a temp file, no network', () => {
  const env = { ...process.env, CP_TOURNAMENT_PATH: join(TMP, 'cli.json') };
  const u = spawnSync(process.execPath, ['paper-bot/cp-tournament.mjs'], { env, encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(u.stdout, /usage: node paper-bot\/cp-tournament\.mjs --predict/);
  const h = execFileSync(process.execPath, ['paper-bot/cp-tournament.mjs', '--predict', '--date', '2026-11-28'], { env, encoding: 'utf8' });
  assert.match(h, /2026-11-28: not an NSE trading day/);
  const s = execFileSync(process.execPath, ['paper-bot/cp-tournament.mjs', '--score'], { env, encoding: 'utf8' });
  assert.match(s, /Nothing to score yet: the tournament starts with the first real 08:40 run/);
  assert.match(s, /Not advice\./);
  // the walk through the CLI: copy the scored walk file, re-score (nothing new), leaderboard printed
  writeFileSync(join(TMP, 'cli.json'), readFileSync(join(TMP, 'walk.json')));
  const s2 = execFileSync(process.execPath, ['paper-bot/cp-tournament.mjs', '--score'], { env, encoding: 'utf8' });
  assert.match(s2, /No contestant is proven/);
});

// ------------------------------------------------------------------ Breakdown ---
test('Breakdown adapter: scored day calls with a P&L by contestant; validation passes', async () => {
  const bd = await import('./paper-bot/breakdown.mjs');
  const dir = join(TMP, 'bd');
  mkdirSync(dir, { recursive: true });
  const st = synthState(30);
  st.days.push({ date: '2027-07-01', test: true, preds: st.days[0].preds });
  writeFileSync(join(dir, 'cp-tournament.json'), JSON.stringify(st));
  const data = bd.loadAll({ dir });
  const rows = data.rows.filter((x) => x.strategy === 'cp-tournament');
  assert.equal(rows.filter((r) => r.version === 'trend-20-50').length, 30, 'test entries left out');
  assert.equal(data.warnings.filter((w) => /cp-tournament/.test(w)).length, 0);
  const val = bd.validate(data).filter((x) => x.strategy === 'cp-tournament');
  assert.ok(val.length >= 2 && val.every((x) => x.pass), JSON.stringify(val.filter((x) => !x.pass)));
  assert.equal(bd.STRATEGIES['cp-tournament'], 'Call / Put tournament');
  const wd = bd.aggregate(rows.filter((r) => r.version === 'trend-20-50'), { groupBy: 'weekday' });
  assert.equal(wd.buckets.reduce((a, b) => a + b.trades, 0), 30);
  const mo = bd.aggregate(rows.filter((r) => r.version === 'trend-20-50'), { groupBy: 'month' });
  assert.ok(Math.abs(mo.buckets.reduce((a, b) => a + b.net, 0) - 3000) < 0.01);
});

// ------------------------------------------------------------------ wiring ---
test('wiring: card in Options & risk, expiry box, route, run.sh morning + evening lines, Not advice, no orders', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /<section class="card span2" id="cpTournamentCard">\s*<h2>Call \/ Put tournament/);
  assert.match(html, /\/static\/js\/51-cp-tournament\.js/);
  const views = readFileSync('static/js/06-home-views.js', 'utf8');
  assert.match(views, /key: 'options', match: \/\^\([^)]*Call \\\/ Put tournament\|/);
  assert.match(views, /'Call \/ Put tournament', 'Fits my budget'/);
  assert.match(readFileSync('static/js/48-expiry.js', 'utf8'), /'cpTournamentCard'/);
  const js = readFileSync('static/js/51-cp-tournament.js', 'utf8');
  assert.match(js, /lazy\('Call \/ Put tournament'/);
  assert.match(js, /Not advice/);
  assert.match('/static/js/51-cp-tournament.js', /^\/static\/(app\.css|js\/\d\d-[a-z-]+\.js)$/);
  assert.match(readFileSync('server.mjs', 'utf8'), /url\.pathname === '\/api\/cp-tournament'\) return json\(res, 200, tournamentView\(\)\)/);
  const sh = readFileSync('scripts/run.sh', 'utf8');
  const pl = sh.split('\n').find((l) => /cp-tournament\.mjs --predict/.test(l));
  const sl = sh.split('\n').find((l) => /cp-tournament\.mjs --score/.test(l));
  assert.ok(pl && /\|\| true$/.test(pl.trim()) && sl && /\|\| true$/.test(sl.trim()));
  const morning = sh.slice(sh.indexOf('  morning)'));
  assert.ok(morning.indexOf('news-pick.mjs --run') < morning.indexOf('cp-tournament.mjs --predict') && morning.indexOf('cp-tournament.mjs --predict') < morning.indexOf(';;'), 'in the 08:40 job, after the news pick');
  assert.ok(sh.indexOf('afternoon-trend.mjs --paper') < sh.indexOf('cp-tournament.mjs --score') && sh.indexOf('cp-tournament.mjs --score') < sh.indexOf('do_refit()'), 'in the evening collect job, after the afternoon-trend record');
  const mod = readFileSync('paper-bot/cp-tournament.mjs', 'utf8');
  assert.doesNotMatch(mod, /placeOrder|\/v1\/order|order\/create/i, 'no broker orders');
  assert.equal((mod.match(/writeJsonAtomic\(/g) || []).length, 2, 'writes only its own state file (predict + score)');
  assert.ok(!/writeJsonAtomic\([^)]*news-pick/.test(mod) && !/runNewsPick|scoreNewsPick/.test(mod), 'reads the news pick, never writes or runs it');
  assert.doesNotMatch(mod, /saveCalibration|writeFileSync\([^)]*(calibration|vol-model)/, 'never writes the calibration / vol-model files');
  assert.match(CP.NOTE, /Paper only — no broker orders\. Not advice\.$/);
});
