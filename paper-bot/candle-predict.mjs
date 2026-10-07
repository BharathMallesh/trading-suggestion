// Experimental: send candle snapshot to Ling and get a structured directional read.
// NOT investment advice. Predictions are unreliable. Paper/research only.

import { chat } from '../ling-client.mjs';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { PAPER } from './config.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';
import { HttpError, badRequest } from '../util.mjs';

const SYSTEM = `
You are a market-structure research assistant for PAPER TRADING education only.
Never place real trades. Never give personalised investment advice.

Given OHLC stats and indicators, return ONLY a JSON object (no markdown fences):
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "horizon": "short-term (days)" | "swing (1-2 weeks)" | "unclear",
  "confidence": 0.0,
  "summary": "2-4 sentences on candle structure and a cautious lean",
  "supports": ["evidence 1", "evidence 2"],
  "risks": ["risk 1", "risk 2"],
  "invalidation": "what would invalidate the lean"
}

Rules:
- Use only the data provided.
- Prefer NEUTRAL when mixed or low volume.
- confidence is a number 0-1 (not a word).
- Not investment advice. Past patterns do not guarantee future results.
`.trim();

function buildUserPayload(symbol, rows, ind) {
  const last = rows[rows.length - 1];
  // Keep payload short — long CSV tables often cause empty model replies
  const tail = rows.slice(-8);
  const recentLines = tail
    .map(
      (r) =>
        `${r.date}: O=${Number(r.open).toFixed(2)} H=${Number(r.high).toFixed(2)} L=${Number(r.low).toFixed(2)} C=${Number(r.close).toFixed(2)}`,
    )
    .join('\n');

  return [
    `Symbol: ${symbol}`,
    `Bars in window: ${rows.length}`,
    `Latest: ${last.date} close=${Number(last.close).toFixed(2)}`,
    `SMA-20: ${ind.sma20 != null ? ind.sma20.toFixed(2) : 'n/a'} (price ${ind.aboveSma20 ? 'above' : 'below'})`,
    `SMA-50: ${ind.sma50 != null ? ind.sma50.toFixed(2) : 'n/a'} (price ${ind.aboveSma50 ? 'above' : 'below'})`,
    `RSI-14: ${ind.rsi14 != null ? ind.rsi14.toFixed(1) : 'n/a'}`,
    `ATR-14: ${ind.atr14 != null ? ind.atr14.toFixed(2) : 'n/a'}`,
    `Vol vs avg: ${ind.volRatio != null ? ind.volRatio.toFixed(2) + 'x' : 'n/a'}`,
    `5-bar ret: ${ind.ret5 != null ? ind.ret5.toFixed(2) + '%' : 'n/a'} | 20-bar ret: ${ind.ret20 != null ? ind.ret20.toFixed(2) + '%' : 'n/a'}`,
    '',
    'Last 8 candles:',
    recentLines,
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/** Map a model bias string onto the enum. Only exact words count, so "NOT BEARISH" → NEUTRAL. */
export function normalizeBias(b) {
  const t = String(b || '').trim().toUpperCase();
  if (['BULLISH', 'BULL', 'UP'].includes(t)) return 'BULLISH';
  if (['BEARISH', 'BEAR', 'DOWN'].includes(t)) return 'BEARISH';
  return 'NEUTRAL';
}

export function parseResponse(raw) {
  const text = String(raw || '').trim();
  const p = extractJson(text, (o) => 'bias' in o || 'summary' in o);
  if (!p) {
    const looksLikeJson = /\{[\s\S]*\}/.test(text);
    return {
      bias: 'NEUTRAL',
      horizon: 'unclear',
      confidence: 0,
      summary: !text
        ? 'Empty model response — try again or use daily interval.'
        : looksLikeJson
          ? `Invalid JSON from model: ${text.slice(0, 200)}`
          : `Could not parse model response: ${text.slice(0, 200)}`,
      supports: [],
      risks: [looksLikeJson ? 'Parse error' : 'Model output was not valid JSON'],
      invalidation: 'n/a',
      raw,
    };
  }
  return {
    bias: normalizeBias(p.bias),
    horizon: String(p.horizon || 'unclear').slice(0, 40),
    confidence: normalizeConfidence(p.confidence, 0.4),
    summary: String(p.summary || '').slice(0, 800),
    supports: Array.isArray(p.supports) ? p.supports.map(String).slice(0, 6) : [],
    risks: Array.isArray(p.risks) ? p.risks.map(String).slice(0, 6) : [],
    invalidation: String(p.invalidation || '').slice(0, 300),
    raw,
  };
}

// Yahoo serves minute bars only for a recent window (~60 days); longer ranges
// return HTTP 422. Clamp the range for intraday intervals instead of failing.
const INTRADAY_MAX_RANGE = { '1m': '5d', '2m': '1mo', '5m': '1mo', '15m': '1mo', '30m': '1mo', '90m': '1mo' };

/**
 * Fetch candles, send to Ling, return structured directional read.
 * @param {string} symbol
 * @param {{ range?: string, interval?: string }} [opts]
 */
export async function candlePredict(symbol, opts = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) throw badRequest('symbol is required, e.g. RELIANCE.NS');
  let range = opts.range || PAPER.candleRange || '3mo';
  let interval = opts.interval || '1d';
  // Yahoo interval aliases
  if (interval === '15-min' || interval === '15min') interval = '15m';
  if (interval === '1-hour' || interval === '1h') interval = '60m';
  let rangeAdjusted = null;
  const maxRange = INTRADAY_MAX_RANGE[interval];
  if (maxRange && !['1d', '5d', maxRange].includes(range)) {
    rangeAdjusted = `Range ${range} isn't available for ${interval} bars; used ${maxRange} instead.`;
    range = maxRange;
  }
  symbol = sym;

  const rows = await candles(symbol, { range, interval });
  if (!rows || rows.length < 30) {
    throw new HttpError(400, `Not enough candles for ${symbol} (${rows?.length || 0} bars). Try range 3mo and interval Daily.`);
  }

  const recent = rows.slice(-(PAPER.lookbackBars || 60));
  const ind = computeIndicators(recent);
  const user = buildUserPayload(symbol, recent, ind);

  let raw = '';
  try {
    raw = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      { temperature: 0.15, timeoutMs: 45_000 },
    );
  } catch (err) {
    throw new HttpError(err.status || 502, `Ling request failed: ${err.message || err}`);
  }

  // One retry with ultra-compact prompt if empty
  if (!String(raw || '').trim()) {
    try {
      raw = await chat(
        [
          {
            role: 'system',
            content:
              'Return ONLY JSON: {"bias":"BULLISH"|"BEARISH"|"NEUTRAL","horizon":"short-term","confidence":0.5,"summary":"...","supports":[],"risks":[],"invalidation":"..."}',
          },
          {
            role: 'user',
            content: `${symbol} close=${ind.close} RSI=${ind.rsi14?.toFixed(1)} SMA20=${ind.sma20?.toFixed(2)} SMA50=${ind.sma50?.toFixed(2)} volRatio=${ind.volRatio?.toFixed(2)}. JSON now.`,
          },
        ],
        { temperature: 0.1, timeoutMs: 30_000 },
      );
    } catch {
      /* keep empty */
    }
  }

  const parsed = parseResponse(raw);
  return {
    symbol,
    range,
    interval,
    rangeAdjusted,
    asOf: recent[recent.length - 1].date,
    lastClose: ind.close,
    indicators: {
      sma20: ind.sma20,
      sma50: ind.sma50,
      rsi14: ind.rsi14,
      atr14: ind.atr14,
      volRatio: ind.volRatio,
      ret5: ind.ret5,
      ret20: ind.ret20,
    },
    prediction: parsed,
    disclaimer:
      'Experimental AI read of candles only. Not investment advice. Models cannot reliably predict prices. Paper/research use only.',
  };
}
