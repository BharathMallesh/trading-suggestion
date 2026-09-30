// Tests for the trading-research module. No dependencies — uses Node's built-in
// test runner and a mocked global fetch, so no network or API key is touched.
//
//   node --test trading/          (or: npm test, from inside trading/)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { chat } from './ling-client.mjs';
import { RESEARCH_SYSTEM, research, summarize, explain } from './research.mjs';
import { quote, candles, fetchChart, intraday } from './market-data.mjs';
import { normCdf, greeks, payoff } from './blackscholes.mjs';
import { computeStats, candleShape } from './describe-candles.mjs';

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

test('intraday() filters to one exchange-local day and formats HH:MM from gmtoffset', async () => {
  const off = 19800; // IST +5:30
  const t1 = Date.UTC(2024, 0, 2, 3, 45, 0) / 1000; // 09:15 IST, Jan 2
  const t2 = t1 + 60; // 09:16 IST, Jan 2
  const t0 = Date.UTC(2024, 0, 1, 4, 0, 0) / 1000; // 09:30 IST, Jan 1 (prior day)
  const chart = {
    chart: {
      error: null,
      result: [
        {
          meta: { symbol: 'X.NS', gmtoffset: off, currency: 'INR', fullExchangeName: 'NSE' },
          timestamp: [t0, t1, t2],
          indicators: { quote: [{ open: [10, 20, 21], high: [11, 21, 22], low: [9, 19, 20], close: [10.5, 20.5, 21.5], volume: [100, 200, 300] }] },
        },
      ],
    },
  };
  mockFetch(chart);
  const d = await intraday('X.NS', { interval: '1m' }); // default: latest day present
  assert.equal(d.date, '2024-01-02');
  assert.equal(d.count, 2);
  assert.equal(d.rows[0].hhmm, '09:15');
  assert.equal(d.rows[1].hhmm, '09:16');
  assert.equal(d.rows[0].volume, 200);

  mockFetch(chart);
  const prior = await intraday('X.NS', { interval: '1m', date: '2024-01-01' });
  assert.equal(prior.count, 1);
  assert.equal(prior.rows[0].hhmm, '09:30');
});

// --- black-scholes (pure maths, no network/model) --------------------------
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('normCdf() matches known reference values', () => {
  assert.ok(near(normCdf(0), 0.5));
  assert.ok(near(normCdf(1.96), 0.975, 2e-3)); // ~97.5%
  assert.ok(near(normCdf(-1.96), 0.025, 2e-3));
});

test('greeks() reproduces a textbook ATM call and put (put-call parity)', () => {
  const base = { spot: 100, strike: 100, tYears: 1, iv: 0.2, rate: 0.05 };
  const call = greeks({ ...base, type: 'CE' });
  const put = greeks({ ...base, type: 'PE' });
  // Known BS value for these inputs: call ~= 10.45, put ~= 5.57.
  assert.ok(near(call.price, 10.4506, 1e-2), `call ${call.price}`);
  assert.ok(near(put.price, 5.5735, 1e-2), `put ${put.price}`);
  // Put-call parity: C - P = S - K*e^{-rT}.
  const parity = base.spot - base.strike * Math.exp(-base.rate * base.tYears);
  assert.ok(near(call.price - put.price, parity, 1e-6));
  // Call delta in (0,1); put delta = callDelta - 1; gamma shared and positive.
  assert.ok(call.delta > 0 && call.delta < 1);
  assert.ok(near(put.delta, call.delta - 1, 1e-9));
  assert.ok(call.gamma > 0 && near(call.gamma, put.gamma, 1e-9));
});

test('greeks() returns intrinsic value at expiry (tYears = 0)', () => {
  const itm = greeks({ spot: 110, strike: 100, tYears: 0, iv: 0.2, type: 'CE' });
  assert.equal(itm.price, 10);
  assert.equal(itm.delta, 1);
  assert.equal(itm.gamma, 0);
  const otm = greeks({ spot: 90, strike: 100, tYears: 0, iv: 0.2, type: 'CE' });
  assert.equal(otm.price, 0);
});

test('payoff() computes breakeven, capped/unlimited legs, and per-lot scaling', () => {
  const longCall = payoff({ action: 'buy', type: 'CE', strike: 2500, premium: 30, lotSize: 250 });
  assert.equal(longCall.breakeven, 2530);
  assert.equal(longCall.maxLoss, 30);
  assert.equal(longCall.maxProfit, 'unlimited');
  assert.equal(longCall.perLot.maxLoss, 7500); // 30 * 250

  const shortCall = payoff({ action: 'sell', type: 'CE', strike: 2500, premium: 30, lotSize: 250 });
  assert.equal(shortCall.maxProfit, 30);
  assert.equal(shortCall.maxLoss, 'unlimited');
  assert.equal(shortCall.perLot.maxProfit, 7500);

  const longPut = payoff({ action: 'buy', type: 'PE', strike: 2500, premium: 40 });
  assert.equal(longPut.breakeven, 2460);
  assert.equal(longPut.maxLoss, 40);
  assert.equal(longPut.maxProfit, 2460); // strike - premium, floored at 0
});

// --- describe-candles (deterministic stats, no forecast) -------------------
const SERIES = [
  { date: '2024-01-01', open: 100, high: 104, low: 99, close: 103, volume: 1000 },
  { date: '2024-01-02', open: 103, high: 108, low: 102, close: 107, volume: 1500 },
  { date: '2024-01-03', open: 107, high: 110, low: 101, close: 102, volume: 3000 }, // biggest range + down
  { date: '2024-01-04', open: 102, high: 106, low: 101, close: 105, volume: 1200 },
  { date: '2024-01-05', open: 105, high: 112, low: 104, close: 111, volume: 2000 },
];

test('computeStats() summarizes trend, up/down days, range position, and streak', () => {
  const s = computeStats(SERIES);
  assert.equal(s.days, 5);
  assert.equal(s.firstClose, 103);
  assert.equal(s.lastClose, 111);
  assert.equal(s.change, 8);
  assert.equal(s.upDays, 4); // only 2024-01-03 closed below its open
  assert.equal(s.downDays, 1);
  assert.deepEqual(s.highestHigh, { value: 112, date: '2024-01-05' });
  assert.deepEqual(s.lowestLow, { value: 99, date: '2024-01-01' });
  // last close 111 between low 99 and high 112 -> (111-99)/(112-99) ≈ 92.3%
  assert.ok(Math.abs(s.rangePositionPct - 92.31) < 0.1);
  // closes 103,107,102,105,111: the ending up-streak is 102->105->111 (2 up moves)
  assert.equal(s.streak.direction, 'up');
  assert.equal(s.streak.days, 2);
  assert.equal(s.biggestDownDay.date, '2024-01-03');
});

test('computeStats() flags last volume vs the window average', () => {
  const s = computeStats(SERIES);
  // avg of [1000,1500,3000,1200,2000] = 1740; last 2000 -> +14.9%
  assert.equal(s.avgVolume, 1740);
  assert.ok(Math.abs(s.lastVolVsAvgPct - 14.94) < 0.1);
});

test('computeStats() throws on empty input', () => {
  assert.throws(() => computeStats([]), /No candles to describe/);
});

test('candleShape() reports geometry as percentages of range', () => {
  const s = candleShape({ date: 'x', open: 102, high: 110, low: 101, close: 107 });
  assert.equal(s.direction, 'up');
  // range 9; body |107-102|=5 -> 55.6%; upper 110-107=3 -> 33.3%; lower 102-101=1 -> 11.1%
  assert.equal(s.bodyPct, 55.6);
  assert.equal(s.upperWickPct, 33.3);
  assert.equal(s.lowerWickPct, 11.1);
});
