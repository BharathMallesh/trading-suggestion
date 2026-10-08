// Tests for: volatility-premium replay (costs, P&L, NSE bhavcopy parsing and
// caching), volatility-targeted NIFTY, horizon labels, disk-space health
// check, the free-model AI fallback and the weekly scorecard. Offline.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r8-'));
process.env.FO_BHAV_DIR = join(TMP, 'fo');
process.env.MONITOR_DIR = join(TMP, 'monitor');
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'pred.json');
process.env.LING_FALLBACK_MODELS = 'free/a:free,free/b:free';
after(() => rmSync(TMP, { recursive: true, force: true }));

const vp = await import('./paper-bot/vol-premium.mjs');
const { volTargetStrategy, trendStrategy } = await import('./paper-bot/strategies.mjs');
const { healthChecks } = await import('./paper-bot/health.mjs');
const { computeAlerts } = await import('./paper-bot/monitor.mjs');
const { chat, llmLastModel } = await import('./ling-client.mjs');
const weekly = await import('./paper-bot/weekly.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------- volatility premium

test('leg costs: STT only on sales, slippage floor, brokerage per unit', () => {
  const sell = vp.legCosts({ side: 'sell', premium: 100 });
  const buy = vp.legCosts({ side: 'buy', premium: 100 });
  assert.ok(sell > buy, 'selling pays STT');
  // tiny premium → slippage floor of 0.5 pt dominates
  assert.ok(vp.legCosts({ side: 'buy', premium: 1 }) >= 0.5);
});

test('short straddle P&L: keeps the credit when NIFTY ends at the strike, loses on a big move', () => {
  const legs = [{ type: 'CE', strike: 20000, side: 'sell' }, { type: 'PE', strike: 20000, side: 'sell' }];
  const flat = vp.positionPnl({ legs, spot: 20000, settle: 20000, iv: 0.15, days: 7 });
  const crash = vp.positionPnl({ legs, spot: 20000, settle: 18000, iv: 0.15, days: 7 });
  assert.ok(flat.pnl > 0 && flat.pnl < flat.credit, 'profit = credit − costs');
  assert.ok(crash.pnl < -1500, 'a 10% fall costs ~2000 points less the credit');
});

const OLD_CSV = 'INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,\n' +
  'FUTIDX,NIFTY,26-Sep-2019,0,XX,1,1,1,11000,1,1,1,1,1,05-SEP-2019,\n' +
  'OPTIDX,NIFTY,12-Sep-2019,11000,CE,1,1,1,95.5,1,1200,1,1,1,05-SEP-2019,\n' +
  'OPTIDX,NIFTY,12-Sep-2019,11000,PE,1,1,1,80.25,1,900,1,1,1,05-SEP-2019,\n' +
  'OPTIDX,BANKNIFTY,12-Sep-2019,27000,CE,1,1,1,300,1,10,1,1,1,05-SEP-2019,\n';
const NEW_CSV = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal\n' +
  '2025-09-05,2025-09-05,FO,NSE,IDO,1,,NIFTY,,2025-09-09,2025-09-09,24750.00,CE,X,0,0,0,120.5,0,0,24741.00,0,0,0,5000,0\n' +
  '2025-09-05,2025-09-05,FO,NSE,IDO,1,,NIFTY,,2025-09-09,2025-09-09,24750.00,PE,X,0,0,0,110.0,0,0,24741.00,0,0,0,4000,0\n' +
  '2025-09-05,2025-09-05,FO,NSE,STO,1,,TCS,,2025-09-30,2025-09-30,3000.00,CE,X,0,0,0,50,0,0,3000,0,0,0,10,0\n';

test('bhavcopy parser: old and new NSE formats, NIFTY options only', () => {
  const o = vp.parseFoBhav(OLD_CSV);
  assert.deepEqual(Object.keys(o.expiries), ['2019-09-12']);
  assert.equal(o.expiries['2019-09-12'][11000].CE, 95.5);
  assert.equal(o.expiries['2019-09-12'][11000].peVol, 900);
  const n = vp.parseFoBhav(NEW_CSV);
  assert.equal(n.underlying, 24741);
  assert.equal(n.expiries['2025-09-09'][24750].PE, 110);
  assert.equal(vp.parseFoBhav('a,b\n1,2'), null);
});

test('bhavcopy download: 404 on both URLs is cached as a holiday; blocks throw and are not cached', async () => {
  let calls = 0;
  const notFound = async () => {
    calls++;
    return { ok: false, status: 404 };
  };
  assert.equal(await vp.foBhav('2020-01-26', { fetchFn: notFound }), null);
  assert.equal(calls, 2, 'tries both formats');
  assert.equal(await vp.foBhav('2020-01-26', { fetchFn: async () => assert.fail('cached') }), null);
  await assert.rejects(() => vp.foBhav('2020-01-27', { fetchFn: async () => ({ ok: false, status: 403 }) }), /blocking/);
  assert.ok(!existsSync(join(process.env.FO_BHAV_DIR, '2020-01-27.json')));
  // network failure mid-download → not cached, retried later
  const flaky = async () => ({ ok: true, status: 200, arrayBuffer: async () => { throw new Error('terminated'); } });
  assert.equal(await vp.foBhav('2020-01-28', { fetchFn: flaky }), null);
  assert.ok(!existsSync(join(process.env.FO_BHAV_DIR, '2020-01-28.json')));
});

test('overall verdict prefers real prices over the VIX-priced model', () => {
  const real = { strategies: { S1: { name: 'S1 · x', verdict: 'loses money after costs', all: {} }, S2: { name: 'S2 · y', verdict: 'positive, but not reliable', all: {} }, S3: { name: 'S3 · z', verdict: 'positive, but not reliable', all: {} } } };
  assert.match(vp.overallVerdict({}, real), /no strategy showed a reliable edge/);
  real.strategies.S2.verdict = 'edge after costs (both halves positive, t ≥ 2)';
  assert.match(vp.overallVerdict({}, real), /S2 showed an edge/);
  assert.match(vp.overallVerdict({}, { error: 'x' }), /Only the VIX-priced model/);
});

// ------------------------------------------------- volatility targeting

const day = (i) => new Date(Date.UTC(2015, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('vol-targeted NIFTY: smaller exposure when the forecast is wild, never above 100%', () => {
  let x = 9;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647 - 0.5);
  let p = 100;
  // calm first half, wild second half
  const idx = Array.from({ length: 900 }, (_, i) => ({ date: day(i), close: (p *= 1 + rnd() * (i < 450 ? 0.01 : 0.06)) }));
  const c = volTargetStrategy(idx, { forecaster: 'ewma' });
  assert.ok(c.avgExposurePct <= 100 && c.avgExposurePct > 0);
  assert.ok(c.all.volPct < 60, `vol held down (${c.all.volPct.toFixed(1)}%)`);
  const both = volTargetStrategy(idx, { forecaster: 'ewma', withTrend: true });
  assert.ok(both.avgExposurePct <= c.avgExposurePct + 1e-9, 'trend filter can only reduce exposure');
  assert.ok(trendStrategy(idx).all, 'trend strategy still works');
});

// ------------------------------------------------------- disk + alerts

test('disk-space check: ok / warn / fail thresholds and a high alert when low', async () => {
  const base = { quoteFn: async () => ({ price: 1 }), newsProbe: async () => 1 };
  const level = async (gb) => (await healthChecks({ ...base, diskFn: () => gb * 1e9 })).checks.find((c) => c.name === 'disk space');
  assert.equal((await level(20)).level, 'ok');
  assert.equal((await level(1.5)).level, 'warn');
  assert.equal((await level(0.2)).level, 'fail');
  const alerts = computeAlerts({ health: { checks: [await level(1.5)] } });
  assert.ok(alerts.some((a) => a.level === 'high' && /Disk/.test(a.text)));
});

// --------------------------------------------------------- AI fallback

test('AI fallback: out of credits on Ling → free model answers; bad key does not fall back', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const model = JSON.parse(opts.body).model;
    seen.push(model);
    if (model === 'free/b:free') return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from b' } }] }) };
    return { ok: false, status: model.startsWith('free/a') ? 429 : 402, text: async () => 'nope' };
  };
  assert.equal(await chat([{ role: 'user', content: 'hi' }]), 'from b');
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.slice(1), ['free/a:free', 'free/b:free'], 'main model first, then fallbacks in order');
  assert.equal(llmLastModel(), 'free/b:free');

  seen.length = 0;
  globalThis.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body).model);
    return { ok: false, status: 401, text: async () => 'bad key' };
  };
  await assert.rejects(() => chat([{ role: 'user', content: 'hi' }]), /rejected the API key/);
  assert.equal(seen.length, 1, 'a bad key is not retried on other models');

  seen.length = 0;
  globalThis.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body).model);
    return { ok: false, status: 402, text: async () => 'no credits' };
  };
  await assert.rejects(() => chat([{ role: 'user', content: 'hi' }]), /out of credits/);
  assert.equal(seen.length, 3, 'all fail → the main model\'s error is reported');
  delete process.env.OPENROUTER_API_KEY;
});

// ------------------------------------------------------- weekly scorecard

test('isoWeek labels and bounds', () => {
  assert.deepEqual(weekly.isoWeek('2026-10-08'), { label: '2026-W41', from: '2026-10-05', to: '2026-10-11' });
  assert.equal(weekly.isoWeek('2027-01-01').label, '2026-W53');
});

test('weekly scorecard: account change this week, predictions scored, health issues', () => {
  const acc = (eqN, eqT) => ({ strategies: { accounts: [{ key: 'nifty', name: 'NIFTY 50 buy-and-hold', equity: eqN, returnPct: 0, holdings: 1 }, { key: 'trend', name: 'A · trend', equity: eqT, returnPct: 0, holdings: 0 }] } });
  const reports = [acc(1000000, 1000000), { ...acc(1010000, 1000100), health: { checks: [{ name: 'disk space', level: 'warn', detail: '1.5 GB free' }] } }];
  const entries = [
    { ts: '2026-10-06T05:00:00Z', evaluated: true, realizedLabel: 'UP', probUp: 0.5, probDown: 0.25, probSideways: 0.25, hitBias: true, symbol: 'A' },
    { ts: '2026-09-01T05:00:00Z', evaluated: true, realizedLabel: 'DOWN', probUp: 0.5, probDown: 0.25, probSideways: 0.25, hitBias: false, symbol: 'B' },
  ];
  const w = weekly.buildWeekly({ reports, entries, week: weekly.isoWeek('2026-10-08') });
  assert.ok(Math.abs(w.accounts[0].weekPct - 1) < 1e-9);
  assert.equal(w.predictions.scored, 1, 'only this week');
  assert.equal(w.allTime.scored, 2);
  assert.deepEqual(w.issues, ['disk space: 1.5 GB free']);
  assert.match(w.summary, /NIFTY \+1\.00%.*trend \+0\.01%/);
  assert.match(w.markdown, /# Weekly scorecard · 2026-W41/);
});

test('maybeWeekly: only Friday after 15:00 IST, once per week', () => {
  mkdirSync(process.env.MONITOR_DIR, { recursive: true });
  writeFileSync(join(process.env.MONITOR_DIR, '2026-10-09-15-00.json'), JSON.stringify({ strategies: { accounts: [] } }));
  const notes = [];
  const notifyFn = (t, m) => notes.push(t);
  assert.equal(weekly.maybeWeekly({ entries: [], now: new Date('2026-10-08T10:00:00Z'), notifyFn }), null, 'Thursday');
  assert.equal(weekly.maybeWeekly({ entries: [], now: new Date('2026-10-09T08:00:00Z'), notifyFn }), null, 'Friday 13:30 IST');
  const w = weekly.maybeWeekly({ entries: [], now: new Date('2026-10-09T09:45:00Z'), notifyFn });
  assert.equal(w.week.label, '2026-W41');
  assert.equal(weekly.maybeWeekly({ entries: [], now: new Date('2026-10-09T10:30:00Z'), notifyFn }), null, 'already written');
  assert.deepEqual(notes, ['Weekly scorecard · 2026-W41']);
  assert.equal(weekly.latestWeekly().week.label, '2026-W41');
});
