// Tests for the persistent paper portfolio, settings, news filtering and the
// "does Ling help?" measurement. Offline: injected candles, temp files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-app-'));
process.env.PORTFOLIO_PATH = join(TMP, 'portfolio.json');
process.env.SETTINGS_PATH = join(TMP, 'settings.json');
process.env.PREDICTION_LOG_PATH = join(TMP, 'prediction-history.json');
process.env.CALIBRATION_PATH = join(TMP, 'calibration.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const portfolio = await import('./paper-bot/portfolio.mjs');
const { currentSettings, saveSettings, resetSettings, validate } = await import('./paper-bot/settings.mjs');
const { PAPER } = await import('./paper-bot/config.mjs');
const { nameTokens, relevantHeadlines, parseRss, detectEvents } = await import('./paper-bot/news.mjs');
const { logPrediction, computeStats } = await import('./paper-bot/prediction-log.mjs');

/** Steady uptrend daily bars ending today, so the tech signal goes LONG. */
function uptrend(n = 130, start = 100) {
  const rows = [];
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  for (let i = 0; i < n; i++) {
    const c = start + i * 0.3 + Math.sin(i) * 1.5;
    const d = new Date(today - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, ts: Math.floor(Date.parse(d) / 1000), open: c * 0.998, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + (i % 5) * 100 });
  }
  return rows;
}

test('portfolio: reset → apply signals buys on LONG, persists, survives reload', async () => {
  portfolio.reset(10000);
  const rows = uptrend();
  const r = await portfolio.rebalance({ symbols: ['UP.NS'], loadCandles: async () => rows });
  const buy = r.actions.find((a) => a.action === 'buy');
  assert.ok(buy, `expected a buy, got ${JSON.stringify(r.actions)}`);
  assert.equal(r.positions.length, 1);
  assert.ok(r.totalCharges > 0, 'delivery charges applied');
  const saved = JSON.parse(readFileSync(process.env.PORTFOLIO_PATH, 'utf8'));
  assert.equal(saved.positions[0].symbol, 'UP.NS');
  const again = await portfolio.refresh({ loadCandles: async () => rows });
  assert.equal(again.positions.length, 1);
  assert.ok(Math.abs(again.equity - (again.cash + again.positions[0].mark * again.positions[0].qty)) < 1e-6);
});

test('portfolio: a later bar through the stop closes the position on refresh', async () => {
  const st = JSON.parse(readFileSync(process.env.PORTFOLIO_PATH, 'utf8'));
  const pos = st.positions[0];
  pos.entryDate = '2000-01-01'; // every bar is "after entry"
  writeFileSync(process.env.PORTFOLIO_PATH, JSON.stringify(st));
  const crash = uptrend().map((b, i, a) => (i === a.length - 1 ? { ...b, open: pos.stop * 0.9, low: pos.stop * 0.85, close: pos.stop * 0.9 } : b));
  const r = await portfolio.refresh({ loadCandles: async () => crash });
  assert.equal(r.positions.length, 0);
  assert.equal(r.closedTrades[0].reason, 'stop-loss');
});

test('portfolio: manual close of an unknown symbol is a 404; reset validates capital', async () => {
  await assert.rejects(() => portfolio.closeOne('NOPE.NS', { loadCandles: async () => uptrend() }), (e) => e.status === 404);
  assert.throws(() => portfolio.reset(10), /between/);
});

test('settings: validate, save, apply to PAPER, and restore defaults', () => {
  const before = currentSettings();
  assert.throws(() => validate({ minConfidence: 2 }), /between/);
  assert.throws(() => validate({ hack: 1 }), /Unknown setting/);
  const s = saveSettings({ maxOpenPositions: 5, 'costs.dpChargePerSell': 0, symbols: 'tcs.ns, infy.ns' });
  assert.equal(PAPER.maxOpenPositions, 5);
  assert.equal(PAPER.costs.dpChargePerSell, 0);
  assert.deepEqual(s.symbols, ['TCS.NS', 'INFY.NS']);
  const r = resetSettings();
  assert.equal(r.maxOpenPositions, before.maxOpenPositions);
  assert.deepEqual(r.symbols, before.symbols);
});

test('news: name tokens skip generic words; headlines must mention the company and be recent', () => {
  assert.deepEqual(nameTokens('Tata Consultancy Services Limited'), ['tata']);
  assert.deepEqual(nameTokens('HDFC Bank Limited'), ['hdfc', 'bank']);
  const now = Date.now();
  const items = [
    { title: 'HDFC Bank names new CEO', providerPublishTime: now / 1000 - 3600 },
    { title: 'Asian equities edge lower', providerPublishTime: now / 1000 - 3600 },
    { title: 'HDFC Bank results', providerPublishTime: now / 1000 - 30 * 86400 },
  ];
  const kept = relevantHeadlines(items, ['hdfc', 'bank'], { now });
  assert.deepEqual(kept.map((k) => k.title), ['HDFC Bank names new CEO']);
});

test('prediction log keeps pre-Ling probabilities and measures whether Ling helped', async () => {
  const base = { probUp: 0.25, probDown: 0.25, probSideways: 0.5 };
  const e = logPrediction({
    symbol: 'X.NS', mode: '15m', intervalMinutes: 15, lastClose: 100, asOf: '2026-10-07 10:00',
    hybrid: { techScore: 0, baseProbabilities: base },
    prediction: { bias: 'UP', probUp: 0.4, probDown: 0.2, probSideways: 0.4, confidence: 0.6, adjustmentNote: 'tilted up on momentum' },
    news: { sentiment: 0.6 },
  });
  assert.deepEqual(e.base, base);
  assert.equal(e.llmAdjusted, true);
  assert.equal(e.newsSentiment, 0.6);
  // Mark it evaluated as an UP outcome and check the comparison.
  const log = JSON.parse(readFileSync(process.env.PREDICTION_LOG_PATH, 'utf8'));
  Object.assign(log.entries[0], { evaluated: true, realizedLabel: 'UP', hitBias: true });
  writeFileSync(process.env.PREDICTION_LOG_PATH, JSON.stringify(log));
  const s = computeStats();
  assert.equal(s.llmValue.n, 1);
  assert.equal(s.llmValue.verdict, 'helps'); // 0.4 up beats 0.25 up when it went up
  assert.equal(s.newsValue.n, 1);
  assert.equal(s.newsValue.directionHitRate, 1);
});

test('news: Google News RSS parsing strips the publisher suffix; quote pages and duplicates are dropped', () => {
  const now = Date.now();
  const pub = new Date(now - 3600_000).toUTCString();
  const xml = `<rss><channel>
    <item><title>TCS Q2 results preview - Mint</title><link>https://x/1</link><pubDate>${pub}</pubDate><source url="https://mint">Mint</source></item>
    <item><title>TCS Q2 results preview - Mint</title><link>https://x/1b</link><pubDate>${pub}</pubDate><source url="https://mint">Mint</source></item>
    <item><title>Tata Consultancy Services Limited (TCS.NS) stock price, news - Yahoo</title><link>https://x/2</link><pubDate>${pub}</pubDate><source url="https://y">Yahoo</source></item>
    <item><title>Infosys wins deal &amp; more - ET</title><link>https://x/3</link><pubDate>${pub}</pubDate><source url="https://et">ET</source></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items[0].title, 'TCS Q2 results preview');
  assert.equal(items[0].publisher, 'Mint');
  assert.equal(items[3].title, 'Infosys wins deal & more');
  const kept = relevantHeadlines(items, ['tata'], { now, ticker: 'TCS' });
  assert.deepEqual(kept.map((k) => k.title), ['TCS Q2 results preview']);
});

test('news: event detection flags results, dividends, corporate actions, policy', () => {
  const ev = detectEvents([
    { title: 'TCS Q2 Results Preview: revenue in focus' },
    { title: 'TCS dividend record date announced' },
    { title: 'Reliance Jio IPO expected launch date' },
    { title: 'RBI MPC meeting: banks may gain' },
    { title: 'Company opens new office' },
  ]);
  assert.deepEqual(ev.sort(), ['corporate action', 'dividend', 'policy / regulatory', 'results']);
  assert.deepEqual(detectEvents([{ title: 'Company opens new office' }]), []);
});

test('Call/Put output says how far it is from base rates (signal strength)', async () => {
  const { growwProbability } = await import('./paper-bot/groww-predict.mjs');
  const rows = uptrend(90);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '',
    json: async () => ({ chart: { error: null, result: [{ meta: { symbol: 'X.NS', gmtoffset: 19800 }, timestamp: rows.map((r) => r.ts),
      indicators: { quote: [{ open: rows.map((r) => r.open), high: rows.map((r) => r.high), low: rows.map((r) => r.low), close: rows.map((r) => r.close), volume: rows.map((r) => r.volume) }] } }] } }) });
  try {
    const out = await growwProbability('X.NS', { mode: '15m', intervalMinutes: 15, preferYahoo: true });
    assert.ok(['none', 'weak', 'moderate'].includes(out.edge.level));
    assert.ok(Number.isFinite(out.edge.maxDeviationPts));
    assert.ok(out.edge.note.length > 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});
