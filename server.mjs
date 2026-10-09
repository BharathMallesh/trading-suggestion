// Local research dashboard server for the trading module. Zero dependencies —
// built on Node's http module. It serves index.html and proxies the module's
// functions so the browser never sees your API key: OPENROUTER_API_KEY is read
// from the environment here, server-side, and never sent to the page.
//
// SCOPE: this is a research/education dashboard. Its endpoints return factual
// answers, read-only market data, and deterministic option maths. There is no
// endpoint that recommends a trade or connects to a broker — by design.
//
//   export OPENROUTER_API_KEY="sk-or-..."   # only needed for the Ask panel
//   node trading/server.mjs                  # then open http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { research, summarize, explain } from './research.mjs';
import { quote, candles, intraday } from './market-data.mjs';
import { greeks, payoff } from './blackscholes.mjs';
import { describeCandles } from './describe-candles.mjs';
import { generateSignal } from './paper-bot/signal.mjs';
import { PaperEngine } from './paper-bot/paper-engine.mjs';
import { PAPER, productFor } from './paper-bot/config.mjs';
import { runAgents } from './agents/coordinator.mjs';
import { researchAgent } from './agents/research-agent.mjs';
import { signalAgent } from './agents/signal-agent.mjs';
import { candlePredict } from './paper-bot/candle-predict.mjs';
import { growwProbability } from './paper-bot/groww-predict.mjs';
import { evaluatePending, computeStats, getHistory } from './paper-bot/prediction-log.mjs';
import { runBacktest } from './paper-bot/backtest.mjs';
import { evaluateModels, saveReport } from './paper-bot/evaluate.mjs';
import { loadCalibration } from './paper-bot/calibration.mjs';
import { newsBrief } from './paper-bot/news.mjs';
import { currentSettings, saveSettings, resetSettings } from './paper-bot/settings.mjs';
import * as portfolio from './paper-bot/portfolio.mjs';
import { evaluateRanking, liveRanking } from './paper-bot/ranking.mjs';
import { volCheck, evaluateVolForecasts } from './paper-bot/volatility.mjs';
import { healthChecks } from './paper-bot/health.mjs';
import { scanEvents, updateEventReturns, eventStats, loadEvents } from './paper-bot/events.mjs';
import { runMonitor, latestReport } from './paper-bot/monitor.mjs';
import { latestWeekly } from './paper-bot/weekly.mjs';
import { loadIndexList } from './paper-bot/ranking.mjs';
import { runStrategyTests } from './paper-bot/strategies.mjs';
import { optionOdds, evaluateOptionOdds } from './paper-bot/option-odds.mjs';
import { testFii } from './paper-bot/fii.mjs';
import { runAndSaveVolPremium, loadVolPremium } from './paper-bot/vol-premium.mjs';
import { analyzeHoldings, addLot, removeLot, setRealized, importTradebook } from './paper-bot/holdings.mjs';
import { trendHistory, saveTrendHistory, loadTrendHistory, crashBrake } from './paper-bot/trend-history.mjs';
import { expectations } from './paper-bot/expectations.mjs';
import { loadDirectionLong } from './paper-bot/direction-long.mjs';
import { loadIntradayTest } from './paper-bot/intraday-test.mjs';
import { bigMove, evaluateBigMove, saveBigMoveEval, loadBigMoveEval } from './paper-bot/big-move.mjs';
import { testPositioning, saveResult as savePositioning, loadResult as loadPositioning } from './paper-bot/options-positioning.mjs';
import { llmLastModel } from './ling-client.mjs';
import { foundationForecast, foundationReplay, saveReplay, loadReplay, stopWorker, MODELS as FOUNDATION_MODELS } from './paper-bot/foundation.mjs';
import { rebalanceAccounts, resetAccounts, loadAccounts, summarize as summarizeAccounts } from './paper-bot/strategy-accounts.mjs';
import { HttpError, badRequest, parseSymbols, parseBool, mapLimit } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
let expectCache = null; // /api/expectations (daily)
// Bind to loopback only — this is a local tool holding a server-side API key,
// not something to expose on the network.
const HOST = '127.0.0.1';

// JSON can't represent Infinity (it becomes null); send it as the string
// "Infinity" so e.g. a profit factor with no losing trades survives the trip.
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v)));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // keep draining (discarding) so the 413 response can actually be delivered
      data += c;
      if (data.length > 1e6) {
        tooBig = true;
        data = '';
        reject(new HttpError(413, 'Request body too large')); // ~1MB cap
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/** Read a JSON object body. Empty → {}. Bad JSON / non-object → 400. */
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object.');
  return body;
}

// --- Local-only request guard ---------------------------------------------
// The server holds a paid API key, so only this dashboard may call it:
// - Host must be localhost / 127.0.0.1 / [::1] on our port (blocks DNS rebinding).
// - Browsers label cross-site requests with Sec-Fetch-Site / Origin; reject
//   any that don't come from this page (blocks CSRF from other tabs).
// - POSTs must be application/json, which a foreign page can't send without
//   a CORS preflight that this server never approves.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function guard(req, url) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new HttpError(421, 'Unknown Host header — open the dashboard via http://localhost:' + PORT);
  if (!url.pathname.startsWith('/api/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site requests are not allowed.');
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase())) {
    throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'POST requests must use Content-Type: application/json.');
  }
}

const PAPER_INTERVALS = new Set(['1d', '15m', '5m', '1h']);

/**
 * News sentiment + event flags for NSE/BSE symbols (4 at a time, cached 10 min
 * in news.mjs). Shown next to signals; never changes them. Failures → null.
 */
async function sentimentFor(symbols) {
  const indian = [...new Set(symbols)].filter((s) => /\.(NS|BO)$/i.test(s));
  const res = await mapLimit(indian, 4, async (sym) => {
    try {
      const n = await newsBrief(sym);
      return [sym, { sentiment: n.sentiment, events: n.events || [], facts: n.facts || {}, headline: n.headlines?.[0]?.title || null, note: n.note || null }];
    } catch {
      return [sym, null];
    }
  });
  return Object.fromEntries(res);
}

/** Validate the paper-bot interval and resolve its data settings. */
function paperData(interval = '1d') {
  if (!PAPER_INTERVALS.has(interval)) throw badRequest(`Unsupported interval "${interval}". Use 1d, 15m, 5m, or 1h.`);
  if (interval === '1d') return { range: PAPER.candleRange, candleInterval: '1d', lookbackBars: PAPER.lookbackBars };
  const p = PAPER.intraday[interval];
  return { range: p.range, candleInterval: p.interval, lookbackBars: p.lookbackBars };
}

/** Required finite number from a query string. */
function num(params, key, label) {
  const raw = params.get(key);
  const n = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isFinite(n)) throw badRequest(`${label} is required and must be a number.`);
  return n;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return json(res, 400, { error: 'Bad URL' });
  }
  try {
    guard(req, url);

    // --- static page ---
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(HERE, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // --- Ask Ling: research / explain / summarize (needs the API key) ---
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const { mode = 'research', question = '', text = '', focus = '' } = await readJson(req);
      // Long-form answers can take 15–30s; allow more than the 25s default.
      const llm = { timeoutMs: 90_000 };
      let answer;
      if (mode === 'summarize') answer = await summarize(text, { focus, ...llm });
      else if (mode === 'explain') answer = await explain(question, llm);
      else answer = await research(question, llm);
      return json(res, 200, { answer, model: llmLastModel() });
    }

    // --- read-only market data ---
    if (req.method === 'GET' && url.pathname === '/api/quote') {
      return json(res, 200, await quote(url.searchParams.get('symbol')));
    }
    if (req.method === 'GET' && url.pathname === '/api/candles') {
      const rows = await candles(url.searchParams.get('symbol'), {
        range: url.searchParams.get('range') || '1mo',
        interval: url.searchParams.get('interval') || '1d',
      });
      return json(res, 200, { rows });
    }

    // --- one day of intraday candles with timestamps ---
    if (req.method === 'GET' && url.pathname === '/api/intraday') {
      const out = await intraday(url.searchParams.get('symbol'), {
        date: url.searchParams.get('date') || undefined,
        interval: url.searchParams.get('interval') || '1m',
      });
      return json(res, 200, out);
    }

    // --- factual description of the candles (stats always; narration needs key) ---
    if (req.method === 'GET' && url.pathname === '/api/describe') {
      const out = await describeCandles(url.searchParams.get('symbol'), {
        range: url.searchParams.get('range') || '3mo',
        interval: url.searchParams.get('interval') || '1d',
        narrate: url.searchParams.get('narrate') === '1',
        timeoutMs: 90_000,
      });
      return json(res, 200, out);
    }

    // --- offline option maths (no data, no key) ---
    if (req.method === 'GET' && url.pathname === '/api/option') {
      const p = url.searchParams;
      const type = (p.get('type') || 'CE').toUpperCase(); // first value if repeated
      if (type !== 'CE' && type !== 'PE') throw badRequest('type must be CE or PE.');
      const strike = num(p, 'strike', 'Strike');
      const days = num(p, 'days', 'Days');
      if (days < 0 || days > 365) throw badRequest('Days must be between 0 and 365.');
      const ivPct = num(p, 'iv', 'IV %');
      if (ivPct < 0 || ivPct > 300) throw badRequest('IV % must be between 0 and 300.');
      const g = greeks({
        spot: num(p, 'spot', 'Spot'),
        strike,
        tYears: days / 365,
        iv: ivPct / 100,
        type,
      });
      const out = { greeks: g };
      const action = p.get('action');
      if (action) {
        if (action !== 'buy' && action !== 'sell') throw badRequest('Action must be buy or sell.');
        const premium = p.get('premium') ? num(p, 'premium', 'Premium') : g.price;
        const lotSize = p.get('lot') ? num(p, 'lot', 'Lot size') : 1;
        out.payoff = payoff({ action, type, strike, premium, lotSize });
        out.premiumUsed = premium;
      }
      return json(res, 200, out);
    }

    // --- Paper-bot scan (experimental signals + paper snapshot) ---
    // POST /api/paper-scan  { symbols?: string[], techOnly?: boolean, interval?: string }
    if (req.method === 'POST' && url.pathname === '/api/paper-scan') {
      const body = await readJson(req);
      const techOnly = parseBool(body.techOnly);
      const interval = body.interval || '1d';
      const { range, candleInterval, lookbackBars } = paperData(interval);
      const given = parseSymbols(body.symbols);
      const symbolList = given.length ? given : PAPER.symbols.slice(0, 6); // keep UI scans light by default

      const signals = [];
      for (const sym of symbolList) {
        try {
          const data = await candles(sym, { range, interval: candleInterval });
          const sig = await generateSignal(sym, data, { techOnly, lookbackBars });
          signals.push(sig);
        } catch (err) {
          signals.push({
            symbol: sym,
            signal: 'FLAT',
            confidence: 0,
            reasoning: err.message || 'Fetch/signal error',
            techBias: 'NEUTRAL',
            indicators: null,
            error: true,
          });
        }
      }

      // Paper snapshot
      const engine = new PaperEngine({ product: productFor(interval) });
      const opened = [];
      for (const s of signals) {
        if (s.confidence < PAPER.minConfidence || !s.indicators?.close) continue;
        const px = s.indicators.close;
        let res;
        if (s.signal === 'LONG') {
          res = engine.openLong(s.symbol, px, s.date, s.indicators.atr14);
        } else if (s.signal === 'SHORT') {
          res = engine.openShort(s.symbol, px, s.date, s.indicators.atr14);
        }
        if (res?.ok) {
          opened.push({
            symbol: s.symbol,
            side: res.side,
            qty: res.qty,
            price: px,
            stop: res.stop,
            target: res.target,
          });
        }
      }

      const summary = engine.summary();
      if (parseBool(body.includeNews)) {
        const news = await sentimentFor(signals.map((s) => s.symbol));
        for (const s of signals) s.news = news[s.symbol] ?? null;
      }
      return json(res, 200, {
        mode: techOnly ? 'tech-only' : 'hybrid',
        interval,
        signals,
        paper: {
          startingCapital: summary.startingCapital,
          equity: summary.finalEquity,
          cash: summary.cash,
          openPositions: summary.openPositions,
          opened,
        },
        disclaimer:
          'Experimental research only. Not investment advice. Signals have no proven edge.',
      });
    }

    // --- Paper-bot backtest (tech-only recommended for speed) ---
    // POST /api/paper-backtest { symbols?, techOnly?, interval? }
    if (req.method === 'POST' && url.pathname === '/api/paper-backtest') {
      const body = await readJson(req);
      const techOnly = body.techOnly === undefined ? true : parseBool(body.techOnly); // default true for UI speed
      const interval = body.interval || '1d';
      const { candleInterval, lookbackBars } = paperData(interval);
      const range = PAPER.backtestRange[interval] || paperData(interval).range;
      const given = parseSymbols(body.symbols);
      const symbolList = given.length ? given : PAPER.symbols.slice(0, 4);

      const history = {};
      const loadErrors = [];
      for (const sym of symbolList) {
        try {
          history[sym] = await candles(sym, { range, interval: candleInterval });
        } catch (err) {
          loadErrors.push(`${sym}: ${err.message}`);
        }
      }
      if (!Object.keys(history).length) {
        throw badRequest(`No market data loaded for the requested symbols. ${loadErrors.join(' ')}`.trim());
      }

      const product = productFor(interval);
      let benchmarkRows = null;
      try {
        benchmarkRows = await candles('^NSEI', { range, interval: candleInterval });
      } catch {
        /* benchmark is optional */
      }
      const result = await runBacktest(history, { techOnly, lookbackBars, product, benchmarkRows });
      const s = result.summary;
      // Downsample equity curve for UI
      const curve = s.equityCurve.filter((_, idx) => idx % 3 === 0 || idx === s.equityCurve.length - 1);

      return json(res, 200, {
        mode: techOnly ? 'tech-only' : 'hybrid',
        interval,
        symbols: result.symbols,
        skipped: loadErrors,
        period: { from: result.startDate, to: result.endDate, bars: result.bars },
        benchmark: result.benchmark,
        summary: {
          startingCapital: s.startingCapital,
          finalEquity: s.finalEquity,
          totalReturnPct: s.totalReturnPct,
          closedTrades: s.closedTrades,
          sideBreakdown: s.sideBreakdown,
          winRatePct: s.winRatePct,
          profitFactor: s.profitFactor,
          maxDrawdownPct: s.maxDrawdownPct,
          exitReasons: s.exitReasons,
          totalCharges: s.totalCharges,
          product,
        },
        trades: s.trades.slice(-40), // last 40 trades
        equityCurve: curve,
        disclaimer:
          'Experimental backtest only. Not investment advice. Results are not indicative of future performance.',
      });
    }

    // --- Multi-agent run ---
    // POST /api/agents  { symbols?, question?, techOnly?, interval? }
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      const body = await readJson(req);
      const interval = body.interval || '1d';
      paperData(interval); // validate
      const out = await runAgents({
        symbols: parseSymbols(body.symbols),
        question: body.question,
        techOnly: parseBool(body.techOnly),
        interval,
      });
      return json(res, 200, out);
    }

    // Individual agents
    if (req.method === 'POST' && url.pathname === '/api/agents/research') {
      const body = await readJson(req);
      return json(res, 200, await researchAgent({ symbol: body.symbol, question: body.question, mode: body.mode }));
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/signal') {
      const body = await readJson(req);
      const interval = body.interval || '1d';
      paperData(interval); // validate
      return json(res, 200, await signalAgent({ symbols: parseSymbols(body.symbols), techOnly: parseBool(body.techOnly), interval }));
    }

    // --- Candle → Ling directional read (experimental prediction-style) ---
    // POST /api/candle-predict { symbol, range?, interval? }
    if (req.method === 'POST' && url.pathname === '/api/candle-predict') {
      const body = await readJson(req);
      const symbol = String(body.symbol || '').trim();
      if (!symbol) return json(res, 400, { error: 'symbol is required, e.g. RELIANCE.NS' });
      const out = await candlePredict(symbol, {
        range: body.range || '3mo',
        interval: body.interval || '1d',
      });
      return json(res, 200, out);
    }

    // --- Groww (or Yahoo fallback) → Ling up/down probabilities ---
    // POST /api/groww-predict { symbol, intervalMinutes?, lookbackDays?, preferYahoo?, mode? }
    if (req.method === 'POST' && url.pathname === '/api/groww-predict') {
      const body = await readJson(req);
      const symbol = String(body.symbol || '').trim();
      if (!symbol) return json(res, 400, { error: 'symbol is required, e.g. HDFCBANK or RELIANCE.NS' });
      const out = await growwProbability(symbol, {
        intervalMinutes: body.intervalMinutes ? Number(body.intervalMinutes) : 15,
        lookbackDays: Number(body.lookbackDays) > 0 ? Number(body.lookbackDays) : 10,
        preferYahoo: parseBool(body.preferYahoo),
        includeNews: parseBool(body.includeNews),
        mode: body.mode === '15m' ? '15m' : 'multi',
      });
      return json(res, 200, out);
    }

    // GET /api/prediction-stats — hit-rate calibration (research)
    if (req.method === 'GET' && url.pathname === '/api/prediction-stats') {
      return json(res, 200, {
        stats: computeStats(),
        disclaimer:
          'Hit-rates are descriptive research metrics only. Past accuracy does not guarantee future results. Not investment advice.',
      });
    }

    // POST /api/prediction-evaluate — score old predictions against later prices
    if (req.method === 'POST' && url.pathname === '/api/prediction-evaluate') {
      const body = await readJson(req);
      const result = await evaluatePending({
        minAgeMinutes: body.minAgeMinutes != null ? Number(body.minAgeMinutes) : 0,
        thresholdPct: body.thresholdPct != null ? Number(body.thresholdPct) : 0.15,
        limit: body.limit != null ? Number(body.limit) : 30,
      });
      return json(res, 200, {
        ...result,
        disclaimer:
          'Evaluation compares logged bias to later Yahoo price. Research calibration only — not investment advice.',
      });
    }

    // POST /api/model-eval { interval?, symbols?, save? } — replay history and
    // score the probability model vs baselines; save=true stores the fitted
    // calibration table for live predictions.
    if (req.method === 'POST' && url.pathname === '/api/model-eval') {
      const body = await readJson(req);
      const report = await evaluateModels({ interval: body.interval || '1d', symbols: parseSymbols(body.symbols) });
      if (parseBool(body.save)) saveReport(report);
      return json(res, 200, { ...report, saved: parseBool(body.save) });
    }

    // --- Cross-sectional ranking (weeks–months) ---
    if (req.method === 'GET' && url.pathname === '/api/rankings') {
      return json(res, 200, await liveRanking({
        symbols: parseSymbols(url.searchParams.get('symbols')),
        universe: url.searchParams.get('universe') || undefined,
        sortBy: url.searchParams.get('sortBy') || undefined,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/ranking-eval') {
      const body = await readJson(req);
      return json(res, 200, await evaluateRanking({ horizon: Number(body.horizon) || 20, symbols: parseSymbols(body.symbols), universe: body.universe || undefined }));
    }

    // --- FII positioning test ---
    if (req.method === 'POST' && url.pathname === '/api/fii-test') {
      await readJson(req);
      return json(res, 200, await testFii({}));
    }

    // --- My portfolio: tax & risk for the user's own holdings (local only) ---
    if (req.method === 'GET' && url.pathname === '/api/holdings') {
      return json(res, 200, await analyzeHoldings({}));
    }
    if (req.method === 'POST' && url.pathname === '/api/holdings/add') {
      const b = await readJson(req);
      return json(res, 200, addLot({ symbol: b.symbol, qty: b.qty, price: b.price, date: b.date }));
    }
    if (req.method === 'POST' && url.pathname === '/api/holdings/remove') {
      const b = await readJson(req);
      return json(res, 200, removeLot(b.id));
    }
    if (req.method === 'POST' && url.pathname === '/api/holdings/import') {
      const b = await readJson(req);
      return json(res, 200, importTradebook({ csv: b.csv, mode: b.mode === 'merge' ? 'merge' : 'replace' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/expectations') {
      // history changes slowly: cache for a day
      if (!expectCache || Date.now() - expectCache.at > 86400000) expectCache = { at: Date.now(), data: await expectations({}) };
      return json(res, 200, expectCache.data);
    }
    if (req.method === 'GET' && url.pathname === '/api/intraday-test') {
      return json(res, 200, loadIntradayTest() || { note: 'Not run yet (node paper-bot/intraday-test.mjs).' });
    }
    if (req.method === 'GET' && url.pathname === '/api/direction-long') {
      return json(res, 200, loadDirectionLong() || { verdict: null, note: 'Not run yet (node paper-bot/direction-long.mjs).' });
    }
    if (req.method === 'GET' && url.pathname === '/api/crash-brake') {
      return json(res, 200, await crashBrake({}));
    }
    if (req.method === 'POST' && url.pathname === '/api/holdings/realized') {
      const b = await readJson(req);
      return json(res, 200, setRealized({ stcg: b.stcg ?? 0, ltcg: b.ltcg ?? 0 }));
    }

    // --- Trend filter on 25+ years (crisis by crisis) ---
    if (req.method === 'GET' && url.pathname === '/api/trend-history') {
      return json(res, 200, loadTrendHistory() || { verdict: null, note: 'Not run yet.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/trend-history') {
      await readJson(req);
      const r = await trendHistory({});
      saveTrendHistory(r);
      return json(res, 200, r);
    }

    // --- Big-move odds (size, not direction) ---
    if (req.method === 'GET' && url.pathname === '/api/big-move') {
      const symbol = (url.searchParams.get('symbol') || '^NSEI').trim();
      let eventPending = false;
      if (/\.(NS|BO)$/i.test(symbol)) {
        try {
          eventPending = (await newsBrief(symbol, { useLlm: false })).events?.includes('results') || false;
        } catch {
          /* no news → no add-on */
        }
      }
      return json(res, 200, await bigMove({ symbol, eventPending }));
    }
    if (req.method === 'GET' && url.pathname === '/api/big-move-eval') {
      return json(res, 200, loadBigMoveEval() || { horizons: null, note: 'Not replayed yet.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/big-move-eval') {
      await readJson(req);
      const r = await evaluateBigMove({});
      saveBigMoveEval(r);
      return json(res, 200, r);
    }

    // --- Options positioning test (PCR, OI change, skew → NIFTY) ---
    if (req.method === 'GET' && url.pathname === '/api/options-positioning') {
      return json(res, 200, loadPositioning() || { verdict: null, note: 'Not run yet.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/options-positioning') {
      await readJson(req);
      const r = await testPositioning({});
      savePositioning(r);
      return json(res, 200, r);
    }

    // --- Volatility premium: is selling NIFTY options profitable after costs? ---
    if (req.method === 'GET' && url.pathname === '/api/vol-premium') {
      await readJson(req);
      return json(res, 200, loadVolPremium() || { verdict: null, note: 'Not run yet.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/vol-premium') {
      await readJson(req);
      return json(res, 200, await runAndSaveVolPremium({}));
    }

    // --- Local foundation models: Kronos + Chronos-Bolt ---
    if (req.method === 'GET' && url.pathname === '/api/foundation') {
      const model = url.searchParams.get('model') || '';
      if (!FOUNDATION_MODELS[model]) throw badRequest('model must be kronos or chronos');
      return json(res, 200, await foundationForecast({ symbol: (url.searchParams.get('symbol') || '^NSEI').trim(), model }));
    }
    if (req.method === 'GET' && url.pathname === '/api/foundation-replay') {
      const model = url.searchParams.get('model') || '';
      if (!FOUNDATION_MODELS[model]) throw badRequest('model must be kronos or chronos');
      return json(res, 200, loadReplay(model) || { model, verdict: null, note: 'Not replayed yet.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/foundation-replay') {
      const body = await readJson(req);
      if (!FOUNDATION_MODELS[body.model]) throw badRequest('model must be kronos or chronos');
      const n = Math.min(400, Math.max(30, Number(body.n) || 200));
      const r = await foundationReplay({ model: body.model, n });
      saveReplay(r);
      delete r.samples;
      return json(res, 200, r);
    }

    // --- Call / Put payoff odds (volatility-based) ---
    if (req.method === 'GET' && url.pathname === '/api/option-odds') {
      const p = url.searchParams;
      const symbol = p.get('symbol') || '^NSEI';
      let eventPending = false;
      if (/\.(NS|BO)$/i.test(symbol)) {
        try {
          eventPending = (await newsBrief(symbol, { useLlm: false })).events?.includes('results') || false;
        } catch {
          /* no news → no add-on */
        }
      }
      return json(res, 200, await optionOdds({
        symbol, type: p.get('type') || 'CE', strike: p.get('strike'), premium: p.get('premium') || undefined,
        iv: p.get('iv') || undefined, days: Number(p.get('days') || 7), expiry: p.get('expiry') || undefined, eventPending,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/option-odds-eval') {
      const body = await readJson(req);
      return json(res, 200, await evaluateOptionOdds({ symbols: parseSymbols(body.symbols), horizon: Number(body.horizon) || 5 }));
    }

    // --- Strategy backtests + forward-test accounts ---
    if (req.method === 'POST' && url.pathname === '/api/strategy-tests') {
      const body = await readJson(req);
      return json(res, 200, await runStrategyTests({ capital: Number(body.capital) || 1e6, universe: body.universe || 'nifty200' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/strategy-accounts') {
      const st = loadAccounts();
      return json(res, 200, st ? summarizeAccounts(st) : { accounts: [], note: 'Not started yet — run Rebalance (or wait for the monitor).' });
    }
    if (req.method === 'POST' && url.pathname === '/api/strategy-accounts/rebalance') {
      await readJson(req);
      return json(res, 200, await rebalanceAccounts());
    }
    if (req.method === 'POST' && url.pathname === '/api/strategy-accounts/reset') {
      const body = await readJson(req);
      resetAccounts(body.capital ?? 1e6);
      return json(res, 200, await rebalanceAccounts());
    }

    // --- Health, events, Today ---
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, await healthChecks());
    }
    if (req.method === 'POST' && url.pathname === '/api/events/scan') {
      const body = await readJson(req);
      const symbols = parseSymbols(body.symbols).length ? parseSymbols(body.symbols) : (await loadIndexList(body.universe || 'nifty50')).symbols;
      const added = await scanEvents(symbols);
      await updateEventReturns();
      return json(res, 200, { added, tracked: loadEvents().length, stats: eventStats() });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return json(res, 200, { events: loadEvents().slice(-100).reverse(), stats: eventStats() });
    }
    if (req.method === 'GET' && url.pathname === '/api/today') {
      return json(res, 200, { report: latestReport(), health: await healthChecks(), weekly: latestWeekly() });
    }
    if (req.method === 'POST' && url.pathname === '/api/today/run') {
      await readJson(req);
      // Runs the investor monitor in-process against this same server.
      const report = await runMonitor({ base: `http://127.0.0.1:${PORT}`, trade: true });
      return json(res, 200, { report, health: report.health });
    }

    // --- Volatility: implied vs forecast ---
    if (req.method === 'GET' && url.pathname === '/api/vol-check') {
      const p = url.searchParams;
      const symbol = p.get('symbol') || '^NSEI';
      // Results due for a stock? (headline-based, no AI call) → event add-on.
      let eventPending = false;
      if (/\.(NS|BO)$/i.test(symbol)) {
        try {
          eventPending = (await newsBrief(symbol, { useLlm: false })).events?.includes('results') || false;
        } catch {
          /* no news → no add-on */
        }
      }
      return json(res, 200, await volCheck({ symbol, iv: p.get('iv') || undefined, days: Number(p.get('days') || 7), expiry: p.get('expiry') || undefined, eventPending }));
    }
    if (req.method === 'POST' && url.pathname === '/api/vol-eval') {
      const body = await readJson(req);
      return json(res, 200, await evaluateVolForecasts({ symbols: parseSymbols(body.symbols), horizon: Number(body.horizon) || 5 }));
    }

    // --- Persistent paper portfolio (delivery, long-only) ---
    if (req.method === 'GET' && url.pathname === '/api/portfolio') {
      const out = await portfolio.refresh();
      if (url.searchParams.get('news') !== '0') {
        const news = await sentimentFor(out.positions.map((p) => p.symbol));
        for (const p of out.positions) p.news = news[p.symbol] ?? null;
      }
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/portfolio/rebalance') {
      const body = await readJson(req);
      const out = await portfolio.rebalance({ techOnly: body.techOnly === undefined ? true : parseBool(body.techOnly), symbols: parseSymbols(body.symbols) });
      if (body.includeNews !== false) {
        const news = await sentimentFor([...out.actions.map((a) => a.symbol), ...out.positions.map((p) => p.symbol)]);
        for (const a of out.actions) a.news = news[a.symbol] ?? null;
        for (const p of out.positions) p.news = news[p.symbol] ?? null;
      }
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/portfolio/close') {
      const body = await readJson(req);
      const symbol = String(body.symbol || '').trim();
      if (!symbol) throw badRequest('symbol is required');
      return json(res, 200, await portfolio.closeOne(symbol));
    }
    if (req.method === 'POST' && url.pathname === '/api/portfolio/reset') {
      const body = await readJson(req);
      return json(res, 200, portfolio.reset(body.capital ?? PAPER.startingCapital));
    }

    // --- Settings (validated subset of config, saved to settings.json) ---
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, { settings: currentSettings() });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      return json(res, 200, { settings: body.reset ? resetSettings() : saveSettings(body.settings === undefined ? {} : body.settings) });
    }

    // GET /api/news?symbol= — recent headlines + factual Ling brief (sentiment shown, not used in numbers)
    if (req.method === 'GET' && url.pathname === '/api/news') {
      return json(res, 200, await newsBrief(url.searchParams.get('symbol'), { refresh: url.searchParams.get('refresh') === '1' }));
    }

    // GET /api/calibration — fitted tables currently stored
    if (req.method === 'GET' && url.pathname === '/api/calibration') {
      const cal = loadCalibration();
      const summary = Object.fromEntries(
        Object.entries(cal).map(([k, v]) => [
          k,
          { fittedAt: v.fittedAt, samples: v.samples, period: v.period, useCalibrated: v.useCalibrated, test: v.test,
            context: v.context ? { useContext: v.context.useContext, mode: v.context.mode, ablation: v.context.ablation } : null,
            variants: Object.fromEntries(Object.entries(v.variants || {}).map(([n, x]) => [n, { useCalibrated: x.useCalibrated, test: x.test }])) },
        ]),
      );
      return json(res, 200, { calibration: summary });
    }

    // GET /api/prediction-history
    if (req.method === 'GET' && url.pathname === '/api/prediction-history') {
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null && (rawLimit.trim() === '' || !Number.isFinite(Number(rawLimit)))) throw badRequest('limit must be a number between 1 and 500.');
      const limit = Math.min(500, Math.max(1, Math.round(rawLimit === null ? 30 : Number(rawLimit))));
      return json(res, 200, { entries: getHistory(limit) });
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    // Surface the module's own helpful messages (e.g. missing API key) to the UI,
    // with the status the module attached (400 bad input, 404 unknown symbol…).
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    // Only our own HttpErrors carry messages meant for the UI; anything else may leak paths/internals.
    const isHttp = err instanceof HttpError;
    if (!isHttp) console.error('[server] unhandled error:', req.method, req.url, err);
    if (status === 413) {
      // Answer first, then drop the connection so the client still gets the 413.
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    if (!res.headersSent) json(res, status, { error: isHttp ? err.message : 'Internal error' });
  }
});

// Background jobs (auto-evaluate, monitor) must not take the whole server down.
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e));

// Clean shutdown so launchd restarts don't orphan the foundation-model worker.
const shutdown = () => {
  try { stopWorker(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // keep-alive sockets must not block exit
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Trading research dashboard: http://${HOST}:${PORT}`);
  // Score due predictions automatically (every 15 min) so hit-rates stay current.
  if (process.env.AUTO_EVALUATE !== '0') {
    const tick = () => evaluatePending({}).catch(() => {});
    setTimeout(tick, 10_000).unref();
    setInterval(tick, 15 * 60_000).unref();
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('(Ask panel needs OPENROUTER_API_KEY — market data and the option calculator work without it.)');
  }
});
