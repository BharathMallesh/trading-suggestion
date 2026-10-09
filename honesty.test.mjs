// Honesty + input-validation tests. Offline: the server is started on a random
// local port with temp env paths; every validation fails before any network call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'trading-honesty-'));
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { pairedVerdict } = await import('./paper-bot/prediction-log.mjs');
const { optionOdds } = await import('./paper-bot/option-odds.mjs');
const { validate } = await import('./paper-bot/settings.mjs');
const { parseSymbols } = await import('./util.mjs');
const { fetchChart } = await import('./market-data.mjs');

// --- Part B: HTTP ---------------------------------------------------------
const PORT = 4100 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), AUTO_EVALUATE: '0', SETTINGS_PATH: join(TMP, 'settings.json'), PORTFOLIO_PATH: join(TMP, 'portfolio.json') },
  stdio: 'pipe',
});
after(() => server.kill());
await new Promise((resolve) => server.stdout.once('data', resolve));

// --- Part A ---------------------------------------------------------------
test('verdicts need n >= 300 and |t| >= 2', () => {
  const better = (n) => Array.from({ length: n }, (_, i) => -0.05 + (i % 2 ? 0.01 : -0.01));
  const small = pairedVerdict(better(50));
  assert.equal(small.verdict, 'not enough evidence (n = 50 of 300)');
  assert.equal(pairedVerdict(better(300)).verdict, 'helps');
  assert.equal(pairedVerdict(better(300).map((d) => -d)).verdict, 'hurts');
  const noisy = Array.from({ length: 400 }, (_, i) => (i % 2 ? 0.1 : -0.1) + 0.0001);
  assert.match(pairedVerdict(noisy).verdict, /no significant difference/);
  assert.match(pairedVerdict([]).verdict, /n = 0 of 300/);
});

test('premium synthesized from IV is not compared with fair value', async () => {
  const rows = Array.from({ length: 800 }, (_, i) => ({ date: `2024-01-${i}`, close: 100 * Math.exp(0.01 * Math.sin(i)) }));
  const vol = async () => ({ symbol: 'X.NS', forecastPct: 20, impliedPct: 30, model: 'har', eventPending: false });
  const o = await optionOdds({ symbol: 'X.NS', type: 'CE', strike: 102, days: 7, loadCandles: async () => rows, vol });
  assert.equal(o.premiumVsFairPct, null);
  assert.match(o.reading, /estimated from implied volatility/);
  assert.ok(Number.isFinite(o.breakeven) && o.probProfit.forecastNormal != null);
  const e = await optionOdds({ symbol: 'X.NS', type: 'CE', strike: 102, premium: 1, days: 7, loadCandles: async () => rows, vol });
  assert.ok(e.premiumVsFairPct != null);
  await assert.rejects(() => optionOdds({ symbol: 'X.NS', type: 'CE', strike: 102, premium: -1, days: 7, loadCandles: async () => rows, vol }), /premium must be 0 or more/);
});

// --- Part B: unit ---------------------------------------------------------
test('settings validate: object + symbol rules', () => {
  for (const bad of [null, [], 'x', 5]) assert.throws(() => validate(bad), /object/);
  for (const bad of ['TCS', 5, null, {}, [5], [null], [{}], [''], ['A'.repeat(21)], ['TC S'], Array(31).fill('A')]) {
    assert.throws(() => validate({ symbols: bad }), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(validate({ symbols: [' tcs.ns ', 'M&M.NS', '^nsei'] }).symbols, ['TCS.NS', 'M&M.NS', '^NSEI']);
});

test('parseSymbols rejects non-strings, long and odd symbols', () => {
  for (const bad of [[1], [null], [{}], 5, {}, 'A'.repeat(21), ['A/B'], 'TCS;DROP']) {
    assert.throws(() => parseSymbols(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(parseSymbols(['M&M.NS', '^NSEI']), ['M&M.NS', '^NSEI']);
});

test('market-data rejects over-long / odd symbols before any network call', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be touched'); };
  try {
    await assert.rejects(() => fetchChart('A'.repeat(21)), (e) => e.status === 400);
    await assert.rejects(() => fetchChart('A B'), (e) => e.status === 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function call(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `localhost:${PORT}` };
    if (method === 'POST') headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (path, body) => call(path, { method: 'POST', body });

test('POST /api/settings validates shape and symbols', async () => {
  for (const b of ['{"settings":5}', '{"settings":null}', '{"settings":[]}', '{"settings":{"symbols":"TCS"}}', '{"settings":{"symbols":[1]}}', '{"settings":{"symbols":[null]}}', '{"settings":{"symbols":["bad sym"]}}']) {
    const r = await post('/api/settings', b);
    assert.equal(r.status, 400, b);
  }
});

test('/api/option validates type, days and iv', async () => {
  const base = 'spot=100&strike=100&days=7&iv=20';
  assert.equal((await call(`/api/option?${base}&type=CE`)).status, 200);
  assert.equal((await call(`/api/option?${base}&type=XX`)).status, 400);
  assert.equal((await call(`/api/option?${base}&type=XX&type=CE`)).status, 400, 'first value wins');
  assert.equal((await call(`/api/option?spot=100&strike=100&days=400&iv=20`)).status, 400);
  assert.equal((await call(`/api/option?spot=100&strike=100&days=-1&iv=20`)).status, 400);
  assert.equal((await call(`/api/option?spot=100&strike=100&days=7&iv=301`)).status, 400);
  assert.equal((await call(`/api/option?spot=100&strike=100&days=7&iv=-5`)).status, 400);
});

test('body-ignoring POST routes reject malformed bodies', async () => {
  for (const path of ['/api/fii-test', '/api/big-move-eval', '/api/today/run', '/api/strategy-accounts/rebalance', '/api/options-positioning', '/api/vol-premium']) {
    for (const b of ['{bad', '[]', 'null']) assert.equal((await post(path, b)).status, 400, `${path} ${b}`);
  }
});

test('option-odds, rankings and prediction-history validation', async () => {
  const neg = await call('/api/option-odds?symbol=TCS.NS&type=CE&strike=100&premium=-5&days=7');
  assert.equal(neg.status, 400);
  assert.match(neg.body, /premium must be 0 or more/);
  const rk = await call('/api/rankings?sortBy=bogus');
  assert.equal(rk.status, 400);
  assert.match(rk.body, /composite/);
  assert.equal((await call('/api/prediction-history?limit=abc')).status, 400);
  assert.equal((await call('/api/prediction-history?limit=')).status, 400);
  const big = await call('/api/prediction-history?limit=99999');
  assert.equal(big.status, 200);
  assert.equal((await call('/api/prediction-history?limit=-3')).status, 200);
  assert.equal((await call('/api/prediction-history')).status, 200);
});
