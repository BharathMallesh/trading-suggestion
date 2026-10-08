// Tests for health checks, the earnings-event tracker, Groww option-chain
// parsing, NSE index lists, alerts and ranking sort. Offline, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-ops-'));
process.env.EVENTS_PATH = join(TMP, 'events.json');
process.env.INDEX_LIST_DIR = TMP;
process.env.CANDLE_STORE = join(TMP, 'candles');
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'pred.json');
process.env.MONITOR_DIR = join(TMP, 'monitor');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { lastSessionDate, healthChecks } = await import('./paper-bot/health.mjs');
const ev = await import('./paper-bot/events.mjs');
const { summarizeChain, defaultMonthlyExpiry } = await import('./groww-data.mjs');
const { parseIndexCsv, loadIndexList, liveRanking } = await import('./paper-bot/ranking.mjs');
const { computeAlerts } = await import('./paper-bot/monitor.mjs');

test('lastSessionDate: weekday after close counts; weekends roll back', () => {
  assert.equal(lastSessionDate(new Date('2026-10-08T11:00:00Z')), '2026-10-08'); // Thu 16:30 IST
  assert.equal(lastSessionDate(new Date('2026-10-08T05:00:00Z')), '2026-10-07'); // Thu 10:30 IST
  assert.equal(lastSessionDate(new Date('2026-10-11T05:00:00Z')), '2026-10-09'); // Sunday → Friday
});

test('health: flags missing key, empty store, missing calibration; fails on market-data errors', async () => {
  delete process.env.OPENROUTER_API_KEY;
  const h = await healthChecks({ quoteFn: async () => ({ price: 22000 }), newsProbe: async () => 5 });
  const by = Object.fromEntries(h.checks.map((c) => [c.name, c]));
  assert.equal(by['market data'].level, 'ok');
  assert.equal(by['AI key'].level, 'warn');
  assert.equal(by['intraday store'].level, 'warn');
  assert.equal(by.calibration.level, 'warn');
  assert.equal(h.level, 'warn');
  assert.ok(!JSON.stringify(h).includes('sk-or'), 'never leaks a key');
  const bad = await healthChecks({ quoteFn: async () => { throw new Error('Market data is rate-limiting requests'); }, newsProbe: async () => 0 });
  assert.equal(bad.level, 'fail');
  assert.match(bad.checks[0].detail, /rate-limiting/);
});

test('events: facts → event types; duplicates within 10 days count once', () => {
  assert.deepEqual(ev.eventsFromFacts({ results: 'beat', rating: 'upgrade', guidance: 'maintained', orderWin: true }), ['results:beat', 'rating:upgrade']);
  const a = ev.recordEvents('X.NS', { results: 'beat' }, { price: 100, date: '2026-10-08' });
  const b = ev.recordEvents('X.NS', { results: 'beat' }, { price: 101, date: '2026-10-10' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  assert.equal(ev.recordEvents('Y.NS', {}, { price: 1, date: '2026-10-08' }).length, 0);
});

test('events: returns at +1/+5/+20 days, abnormal vs NIFTY, and stats', async () => {
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 8 + i)).toISOString().slice(0, 10));
  const stock = days.map((d, i) => ({ date: d, close: 100 * (1 + 0.01 * i) })); // +1%/day
  const nifty = days.map((d, i) => ({ date: d, close: 20000 * (1 + 0.002 * i) }));
  await ev.updateEventReturns({ load: async (s) => (s === '^NSEI' ? nifty : stock) });
  const e = ev.loadEvents().find((x) => x.symbol === 'X.NS');
  assert.ok(Math.abs(e.returns[5].ret - 0.05) < 1e-9);
  assert.ok(Math.abs(e.returns[5].abnormal - (0.05 - 0.01)) < 1e-9);
  assert.ok(e.returns[20]);
  const st = ev.eventStats().find((t) => t.type === 'results:beat');
  assert.equal(st.events, 1);
  assert.ok(st.d5.avgAbnormalPct > 3.9 && st.d5.pctBeatNifty === 100);
});

test('events: scan records facts from news at the latest close', async () => {
  const added = await ev.scanEvents(['Z.NS', 'AAPL'], {
    brief: async () => ({ facts: { rating: 'downgrade' }, headlines: [{ title: 'Z downgraded' }] }),
    quoteRows: async () => [{ date: '2026-10-08', close: 50 }],
  });
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'rating:downgrade');
  assert.equal(added[0].price, 50);
});

test('Groww option chain: ATM IV (fraction or %), put/call OI ratio', () => {
  const payload = {
    underlying_ltp: 2104,
    strikes: {
      2080: { CE: { greeks: { iv: 0.24 }, open_interest: 100 }, PE: { greeks: { iv: 0.26 }, open_interest: 300 } },
      2100: { CE: { greeks: { iv: 0.22 }, open_interest: 200 }, PE: { greeks: { iv: 0.24 }, open_interest: 100 } },
    },
  };
  const c = summarizeChain(payload, { underlying: 'TCS', expiry: '2026-10-27' });
  assert.equal(c.atmStrike, 2100);
  assert.ok(Math.abs(c.atmIvPct - 23) < 1e-9);
  assert.ok(Math.abs(c.pcr - 400 / 300) < 1e-9);
  payload.strikes[2100].CE.greeks.iv = 22; // already a percentage
  payload.strikes[2100].PE.greeks.iv = 24;
  assert.ok(Math.abs(summarizeChain(payload).atmIvPct - 23) < 1e-9);
  assert.throws(() => summarizeChain({ strikes: {} }), /unexpected response/);
});

test('default monthly expiry is the last Tuesday, rolling to next month once passed', () => {
  assert.equal(defaultMonthlyExpiry(new Date('2026-10-08T06:00:00Z')), '2026-10-27');
  assert.equal(defaultMonthlyExpiry(new Date('2026-10-28T06:00:00Z')), '2026-11-24');
});

test('NSE index list: parse, cache, and fall back to built-in NIFTY 50', async () => {
  const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\n' + Array.from({ length: 45 }, (_, i) => `Co ${i},X,SYM${i},EQ,IN${i}`).join('\n');
  assert.deepEqual(parseIndexCsv(csv).slice(0, 2), ['SYM0.NS', 'SYM1.NS']);
  const l = await loadIndexList('nifty100', { fetchFn: async () => ({ ok: true, text: async () => csv }) });
  assert.equal(l.source, 'NSE');
  const cached = await loadIndexList('nifty100', { fetchFn: async () => assert.fail('should use cache') });
  assert.equal(cached.source, 'cache');
  const fb = await loadIndexList('nifty200', { fetchFn: async () => ({ ok: false }) });
  assert.match(fb.source, /built-in/);
  await assert.rejects(() => loadIndexList('sensex'), /Unknown universe/);
});

test('live ranking can sort by a chosen signal', async () => {
  const mk = (drift) => Array.from({ length: 320 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), close: 100 * (1 + drift) ** i }));
  const data = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`S${k}.NS`, mk(0.0005 * k)]));
  const r = await liveRanking({ symbols: Object.keys(data), sortBy: 'mom12_1', loadCandles: async (s) => data[s] });
  assert.equal(r.sortBy, 'mom12_1');
  assert.equal(r.ranking[0].symbol, 'S7.NS');
});

test('alerts: held stock with results, rich options, tilt off, health failures, new events', () => {
  const a = computeAlerts({
    health: { checks: [{ name: 'market data', level: 'fail', detail: 'down' }, { name: 'calibration', level: 'warn', detail: 'old' }] },
    portfolio: { positions: [{ symbol: 'TCS.NS' }], actions: [] },
    watchlist: [{ symbol: 'TCS.NS', events: ['results'] }, { symbol: 'INFY.NS', events: ['results'] }],
    volatility: { ratio: 1.4, impliedPct: 18 },
    evaluation: { newsValue: { tilt: { autoDisabled: true } } },
    scorecard: { scored: 40, brier: { app: 0.7, uniform: 0.667 } },
    events: { added: [{ symbol: 'X.NS', type: 'results:beat', price: 10 }] },
  });
  const text = a.map((x) => x.text).join(' | ');
  assert.match(text, /market data failing/);
  assert.match(text, /TCS\.NS \(held/);
  assert.doesNotMatch(text, /INFY\.NS \(held/);
  assert.match(text, /40% more volatility/);
  assert.match(text, /switched itself off/);
  assert.match(text, /coin-flip/);
  assert.match(text, /New event: X\.NS results:beat/);
});
