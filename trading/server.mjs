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
import { quote, candles } from './market-data.mjs';
import { greeks, payoff } from './blackscholes.mjs';

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
