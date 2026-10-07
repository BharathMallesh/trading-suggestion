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
import { PAPER } from './paper-bot/config.mjs';
import { runAgents } from './agents/coordinator.mjs';
import { researchAgent } from './agents/research-agent.mjs';
import { signalAgent } from './agents/signal-agent.mjs';
import { candlePredict } from './paper-bot/candle-predict.mjs';
import { growwProbability } from './paper-bot/groww-predict.mjs';
import { evaluatePending, computeStats, getHistory } from './paper-bot/prediction-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Bind to loopback only — this is a local tool holding a server-side API key,
// not something to expose on the network.
const HOST = '127.0.0.1';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Request body too large')); // ~1MB cap
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // --- static page ---
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(HERE, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // --- Ask Ling: research / explain / summarize (needs the API key) ---
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const { mode = 'research', question = '', text = '', focus = '' } = JSON.parse(
        (await readBody(req)) || '{}',
      );
      let answer;
      if (mode === 'summarize') answer = await summarize(text, { focus });
      else if (mode === 'explain') answer = await explain(question);
      else answer = await research(question);
      return json(res, 200, { answer });
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
      });
      return json(res, 200, out);
    }

    // --- offline option maths (no data, no key) ---
    if (req.method === 'GET' && url.pathname === '/api/option') {
      const p = url.searchParams;
      const n = (k) => Number(p.get(k));
      const type = (p.get('type') || 'CE').toUpperCase();
      const g = greeks({ spot: n('spot'), strike: n('strike'), tYears: n('days') / 365, iv: n('iv') / 100, type });
      const out = { greeks: g };
      const action = p.get('action');
      if (action === 'buy' || action === 'sell') {
        const premium = p.get('premium') ? n('premium') : g.price;
        out.payoff = payoff({ action, type, strike: n('strike'), premium, lotSize: p.get('lot') ? n('lot') : 1 });
        out.premiumUsed = premium;
      }
      return json(res, 200, out);
    }

    // --- Paper-bot scan (experimental signals + paper snapshot) ---
    // POST /api/paper-scan  { symbols?: string[], techOnly?: boolean, interval?: string }
    if (req.method === 'POST' && url.pathname === '/api/paper-scan') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const techOnly = Boolean(body.techOnly);
      const interval = body.interval || '1d';
      let symbolList = Array.isArray(body.symbols) && body.symbols.length
        ? body.symbols.map((s) => String(s).trim()).filter(Boolean)
        : PAPER.symbols.slice(0, 6); // keep UI scans light by default

      // Resolve data settings
      let range = PAPER.candleRange;
      let candleInterval = '1d';
      let lookbackBars = PAPER.lookbackBars;
      if (interval !== '1d' && PAPER.intraday[interval]) {
        range = PAPER.intraday[interval].range;
        candleInterval = PAPER.intraday[interval].interval;
        lookbackBars = PAPER.intraday[interval].lookbackBars;
      }

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
      const engine = new PaperEngine();
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
      const body = JSON.parse((await readBody(req)) || '{}');
      const techOnly = body.techOnly !== false; // default true for UI speed
      const interval = body.interval || '1d';
      const symbolList = Array.isArray(body.symbols) && body.symbols.length
        ? body.symbols.map((s) => String(s).trim()).filter(Boolean)
        : PAPER.symbols.slice(0, 4);

      let range = PAPER.candleRange;
      let candleInterval = '1d';
      let lookbackBars = PAPER.lookbackBars;
      if (interval !== '1d' && PAPER.intraday[interval]) {
        range = PAPER.intraday[interval].range;
        candleInterval = PAPER.intraday[interval].interval;
        lookbackBars = PAPER.intraday[interval].lookbackBars;
      }

      const engine = new PaperEngine();
      const history = {};
      for (const sym of symbolList) {
        try {
          history[sym] = await candles(sym, { range, interval: candleInterval });
        } catch (_) {}
      }
      const available = Object.keys(history);
      if (!available.length) {
        return json(res, 400, { error: 'No market data loaded for requested symbols.' });
      }

      const minLen = Math.min(...available.map((s) => history[s].length));
      const startIdx = Math.max(55, lookbackBars);
      if (minLen <= startIdx + 2) {
        return json(res, 400, { error: 'Not enough bars for backtest.' });
      }

      for (let i = startIdx; i < minLen - 1; i++) {
        const marks = {};
        engine.tickBar();
        for (const sym of available) {
          const bars = history[sym];
          const bar = bars[i];
          const nextBar = bars[i + 1];
          marks[sym] = nextBar.open;

          engine.checkStopsAndTargets(sym, bar);

          const slice = bars.slice(0, i + 1);
          const signal = await generateSignal(sym, slice, { techOnly, lookbackBars });
          const hasPos = engine.positions.has(sym);
          const fillPrice = nextBar.open;

          if (!hasPos && signal.confidence >= PAPER.minConfidence) {
            if (signal.signal === 'LONG') {
              engine.openLong(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
            } else if (signal.signal === 'SHORT') {
              engine.openShort(sym, fillPrice, nextBar.date, signal.indicators?.atr14);
            }
          } else if (hasPos && engine.canSignalExit(sym)) {
            const pos = engine.positions.get(sym);
            const shouldExit =
              signal.signal === 'FLAT' ||
              (pos.side === 'LONG' && signal.signal === 'SHORT') ||
              (pos.side === 'SHORT' && signal.signal === 'LONG');
            if (shouldExit) {
              engine.closePosition(sym, fillPrice, nextBar.date, 'signal');
            }
          }
        }
        engine.mark(history[available[0]][i].date, marks);
      }

      // Close remaining
      const lastMarks = {};
      for (const sym of available) {
        const last = history[sym][history[sym].length - 1];
        lastMarks[sym] = last.close;
        if (engine.positions.has(sym)) {
          engine.closePosition(sym, last.close, last.date, 'end-of-test');
        }
      }
      engine.mark('end', lastMarks);

      const s = engine.summary();
      // Downsample equity curve for UI
      const curve = s.equityCurve.filter((_, idx) => idx % 3 === 0 || idx === s.equityCurve.length - 1);

      return json(res, 200, {
        mode: techOnly ? 'tech-only' : 'hybrid',
        interval,
        symbols: available,
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
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = await runAgents({
        symbols: body.symbols,
        question: body.question,
        techOnly: Boolean(body.techOnly),
        interval: body.interval || '1d',
      });
      return json(res, 200, out);
    }

    // Individual agents
    if (req.method === 'POST' && url.pathname === '/api/agents/research') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, await researchAgent(body));
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/signal') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, await signalAgent(body));
    }

    // --- Candle → Ling directional read (experimental prediction-style) ---
    // POST /api/candle-predict { symbol, range?, interval? }
    if (req.method === 'POST' && url.pathname === '/api/candle-predict') {
      const body = JSON.parse((await readBody(req)) || '{}');
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
      const body = JSON.parse((await readBody(req)) || '{}');
      const symbol = String(body.symbol || '').trim();
      if (!symbol) return json(res, 400, { error: 'symbol is required, e.g. HDFCBANK or RELIANCE.NS' });
      const out = await growwProbability(symbol, {
        intervalMinutes: body.intervalMinutes ? Number(body.intervalMinutes) : 15,
        lookbackDays: body.lookbackDays ? Number(body.lookbackDays) : 10,
        preferYahoo: Boolean(body.preferYahoo),
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
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await evaluatePending({
        minAgeMinutes: body.minAgeMinutes != null ? Number(body.minAgeMinutes) : 60,
        thresholdPct: body.thresholdPct != null ? Number(body.thresholdPct) : 0.15,
        limit: body.limit != null ? Number(body.limit) : 30,
      });
      return json(res, 200, {
        ...result,
        disclaimer:
          'Evaluation compares logged bias to later Yahoo price. Research calibration only — not investment advice.',
      });
    }

    // GET /api/prediction-history
    if (req.method === 'GET' && url.pathname === '/api/prediction-history') {
      const limit = Number(url.searchParams.get('limit') || 30);
      return json(res, 200, { entries: getHistory(limit) });
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    // Surface the module's own helpful messages (e.g. missing API key) to the UI.
    json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Trading research dashboard: http://${HOST}:${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('(Ask panel needs OPENROUTER_API_KEY — market data and the option calculator work without it.)');
  }
});
