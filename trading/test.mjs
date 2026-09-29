// Tests for the trading-research module. No dependencies — uses Node's built-in
// test runner and a mocked global fetch, so no network or API key is touched.
//
//   node --test trading/          (or: npm test, from inside trading/)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { chat } from './ling-client.mjs';
import { RESEARCH_SYSTEM, research, summarize, explain } from './research.mjs';
import { quote, candles, fetchChart } from './market-data.mjs';

// --- fetch mock ------------------------------------------------------------
const realFetch = globalThis.fetch;
let lastRequest; // { url, options } captured from the most recent fetch call

/** Install a fake fetch that returns `payload` (JSON) with the given status. */
function mockFetch(payload, { ok = true, status = 200, statusText = 'OK' } = {}) {
  globalThis.fetch = async (url, options) => {
    lastRequest = { url, options };
    return {
      ok,
      status,
      statusText,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
}

beforeEach(() => {
  lastRequest = undefined;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- ling-client -----------------------------------------------------------
test('chat() throws a helpful error when the API key is missing', async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(
    () => chat([{ role: 'user', content: 'hi' }]),
    /Missing OPENROUTER_API_KEY/,
  );
});

test('chat() sends model + messages and returns the assistant text', async () => {
  mockFetch({ choices: [{ message: { content: 'hello from ling' } }] });
  const out = await chat([{ role: 'user', content: 'ping' }], { model: 'test-model', temperature: 0.1 });
  assert.equal(out, 'hello from ling');

  const body = JSON.parse(lastRequest.options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
  assert.match(lastRequest.options.headers.Authorization, /^Bearer sk-or-test-key$/);
});

test('chat() surfaces HTTP errors with status and body', async () => {
  mockFetch('rate limited', { ok: false, status: 429, statusText: 'Too Many Requests' });
  await assert.rejects(() => chat([{ role: 'user', content: 'x' }]), /HTTP 429.*rate limited/s);
});

test('chat() tolerates a missing content field', async () => {
  mockFetch({ choices: [] });
  assert.equal(await chat([{ role: 'user', content: 'x' }]), '');
});

// --- guardrail prompt ------------------------------------------------------
test('RESEARCH_SYSTEM encodes the hard scope rules', () => {
  const p = RESEARCH_SYSTEM.toLowerCase();
  assert.match(p, /do not predict prices/);
  assert.match(p, /buy\/sell\/hold/);
  assert.match(p, /personalized investment advice/);
  // Must always close with the not-advice disclaimer.
  assert.match(RESEARCH_SYSTEM, /not investment\s*\n?advice/i);
});

test('research() puts the guardrail in the system role and the question in the user role', async () => {
  mockFetch({ choices: [{ message: { content: 'ok' } }] });
  await research('what is a P/E ratio?');
  const body = JSON.parse(lastRequest.options.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, RESEARCH_SYSTEM);
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /P\/E ratio/);
});

// --- research helpers ------------------------------------------------------
test('summarize() rejects empty input and embeds the source text under the guardrail', async () => {
  await assert.rejects(() => summarize('   '), /Nothing to summarize/);

  mockFetch({ choices: [{ message: { content: 'summary' } }] });
  await summarize('Q3 revenue was 100cr, up 10% YoY.', { focus: 'revenue' });
  const body = JSON.parse(lastRequest.options.body);
  assert.equal(body.messages[0].content, RESEARCH_SYSTEM);
  assert.match(body.messages[1].content, /Q3 revenue was 100cr/);
  assert.match(body.messages[1].content, /Focus especially on: revenue/);
  assert.match(body.messages[1].content, /do NOT judge whether this is bullish\/bearish/i);
});

test('explain() rejects empty input and asks for a general, ticker-agnostic explanation', async () => {
  await assert.rejects(() => explain(''), /Pass a topic/);

  mockFetch({ choices: [{ message: { content: 'explanation' } }] });
  await explain('net interest margin');
  const body = JSON.parse(lastRequest.options.body);
  assert.equal(body.messages[0].content, RESEARCH_SYSTEM);
  assert.match(body.messages[1].content, /net interest margin/);
  assert.match(body.messages[1].content, /general and educational/i);
});

// --- market data -----------------------------------------------------------
const CHART_FIXTURE = {
  chart: {
    error: null,
    result: [
      {
        meta: {
          symbol: 'AAPL',
          longName: 'Apple Inc.',
          currency: 'USD',
          fullExchangeName: 'NasdaqGS',
          regularMarketPrice: 200.5,
          chartPreviousClose: 198.0,
          regularMarketDayHigh: 201,
          regularMarketDayLow: 197,
          regularMarketVolume: 1234567,
          fiftyTwoWeekHigh: 260,
          fiftyTwoWeekLow: 150,
          regularMarketTime: 1700000000,
        },
        timestamp: [1699996800, 1700083200, 1700169600],
        indicators: {
          quote: [
            {
              open: [100, null, 102],
              high: [105, null, 106],
              low: [99, null, 101],
              close: [104, null, 105],
              volume: [1000, null, 1200],
            },
          ],
          adjclose: [{ adjclose: [103.9, null, 104.9] }],
        },
      },
    ],
  },
};

test('quote() maps the meta block into a flat snapshot', async () => {
  mockFetch(CHART_FIXTURE);
  const q = await quote('AAPL');
  assert.equal(q.symbol, 'AAPL');
  assert.equal(q.name, 'Apple Inc.');
  assert.equal(q.currency, 'USD');
  assert.equal(q.price, 200.5);
  assert.equal(q.previousClose, 198.0);
  assert.equal(q.fiftyTwoWeekLow, 150);
  assert.equal(q.marketTime, new Date(1700000000 * 1000).toISOString());
});

test('candles() returns clean OHLC rows and drops the null (market-closed) row', async () => {
  mockFetch(CHART_FIXTURE);
  const rows = await candles('AAPL', { range: '5d', interval: '1d' });
  assert.equal(rows.length, 2); // middle null row skipped
  assert.deepEqual(rows[0], {
    date: '2023-11-14',
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    adjClose: 103.9,
    volume: 1000,
  });
  assert.equal(rows[1].close, 105);
});

test('fetchChart() validates symbol, range, and interval before hitting the network', async () => {
  // These should fail without any fetch happening.
  globalThis.fetch = async () => assert.fail('fetch should not be called on invalid input');
  await assert.rejects(() => fetchChart(''), /symbol is required/);
  await assert.rejects(() => fetchChart('AAPL', { range: 'decade' }), /Unsupported range/);
  await assert.rejects(() => fetchChart('AAPL', { interval: '7d' }), /Unsupported interval/);
});

test('fetchChart() surfaces an API error payload', async () => {
  mockFetch({ chart: { error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });
  await assert.rejects(() => fetchChart('NOPE'), /No data found/);
});

test('fetchChart() throws when the result set is empty', async () => {
  mockFetch({ chart: { error: null, result: [] } });
  await assert.rejects(() => fetchChart('AAPL'), /No market data found/);
});
