// Hybrid signal generator (experimental)
// 1. Technical filters first (transparent rules)
// 2. Optionally ask Ling for a structured signal + short reasoning
//
// THIS IS EXPERIMENTAL RESEARCH CODE ONLY.
// Signals are NOT investment advice and have no proven edge.

import { chat } from '../ling-client.mjs';
import { computeIndicators } from './indicators.mjs';
import { PAPER, TECH } from './config.mjs';
import { extractJson, normalizeConfidence } from './llm-json.mjs';

/**
 * Build a compact, factual context string from candles + indicators.
 */
function buildContext(symbol, candles, ind) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const lines = [
    `Symbol: ${symbol}`,
    `Latest close: ${last.close.toFixed(2)} (${last.date})`,
    `Previous close: ${prev.close.toFixed(2)}`,
    `Day range: ${last.low.toFixed(2)} – ${last.high.toFixed(2)}`,
    `Volume vs 20-day avg: ${ind.volRatio != null ? ind.volRatio.toFixed(2) + 'x' : 'n/a'}`,
    '',
    `SMA-20: ${ind.sma20?.toFixed(2) ?? 'n/a'}  (price ${ind.aboveSma20 ? 'above' : 'below'})`,
    `SMA-50: ${ind.sma50?.toFixed(2) ?? 'n/a'}  (price ${ind.aboveSma50 ? 'above' : 'below'})`,
    `SMA-20 vs SMA-50: ${ind.sma20AboveSma50 == null ? 'n/a' : ind.sma20AboveSma50 ? 'bullish cross' : 'bearish cross'}`,
    `RSI-14: ${ind.rsi14?.toFixed(1) ?? 'n/a'}`,
    `ATR-14: ${ind.atr14?.toFixed(2) ?? 'n/a'}`,
    `5-day return: ${ind.ret5 != null ? ind.ret5.toFixed(2) + '%' : 'n/a'}`,
    `20-day return: ${ind.ret20 != null ? ind.ret20.toFixed(2) + '%' : 'n/a'}`,
  ];
  return lines.join('\n');
}

/**
 * Tightened technical pre-filter.
 * Returns 'LONG_BIAS' | 'SHORT_BIAS' | 'NEUTRAL'
 */
function technicalBias(ind) {
  if (ind.rsi14 == null || ind.sma20 == null || ind.sma50 == null) return 'NEUTRAL';

  const smaSepPct = Math.abs(ind.sma20 - ind.sma50) / ind.sma50 * 100;
  const enoughSeparation = smaSepPct >= (TECH.minSmaSeparationPct ?? 0.5);
  const volOk = ind.volRatio == null || ind.volRatio >= (TECH.minVolRatio ?? 1.0);
  const trendAlign = TECH.requireTrendAlign !== false;

  const bullish =
    ind.aboveSma20 &&
    ind.sma20AboveSma50 &&
    (!trendAlign || ind.aboveSma50) &&
    enoughSeparation &&
    volOk &&
    ind.rsi14 >= 50 &&
    ind.rsi14 <= TECH.rsiOverbought;

  const bearish =
    !ind.aboveSma20 &&
    !ind.sma20AboveSma50 &&
    (!trendAlign || !ind.aboveSma50) &&
    enoughSeparation &&
    volOk &&
    ind.rsi14 <= 50 &&
    ind.rsi14 >= TECH.rsiOversold;

  if (bullish) return 'LONG_BIAS';
  if (bearish) return 'SHORT_BIAS';
  return 'NEUTRAL';
}

/**
 * Pure technical signal (no LLM). Useful for testing without an API key.
 */
function techOnlySignal(techBias, ind) {
  // (4) Calibrated confidence: base + bonuses for volume / RSI mid-zone
  let bonus = 0;
  if (ind.volRatio != null && ind.volRatio >= 1.2) bonus += 0.05;
  if (ind.rsi14 != null && ind.rsi14 >= 45 && ind.rsi14 <= 55) bonus += 0.03;

  if (techBias === 'LONG_BIAS') {
    return {
      signal: 'LONG',
      confidence: Math.min(0.85, 0.66 + bonus),
      reasoning: 'Trend-aligned long: above SMAs, separation, volume ok (tech-only)',
    };
  }
  if (techBias === 'SHORT_BIAS') {
    return {
      signal: 'SHORT',
      confidence: Math.min(0.85, 0.66 + bonus),
      reasoning: 'Trend-aligned short: below SMAs, separation, volume ok (tech-only)',
    };
  }
  return {
    signal: 'FLAT',
    confidence: 0.3,
    reasoning: 'Filters not met — no trade (tech-only)',
  };
}

const SIGNAL_SYSTEM = `
You are an experimental market-signal assistant used only for paper-trading research.
You never place real trades and you never give personalised investment advice.

Your only job is to look at the factual technical snapshot provided and return a
structured JSON signal.

Hard rules:
- Reply with ONLY a valid JSON object. No markdown, no extra text.
- The JSON must have exactly these keys:
  {
    "signal": "LONG" | "SHORT" | "FLAT",
    "confidence": number between 0 and 1,
    "reasoning": "one or two short factual sentences"
  }
- Confidence calibration (be honest, not inflated):
  - 0.75–0.90 only if trend, RSI, and volume all clearly agree
  - 0.60–0.74 if lean is reasonable but one factor is soft
  - below 0.60 if mixed — prefer signal FLAT instead
- Prefer FLAT when the picture is mixed or unclear.
- Never invent price targets, stop levels, or "sure" outcomes.
- Treat this as research / education only. Past patterns do not guarantee future results.
`.trim();

/**
 * Ask Ling for a structured signal given the context and technical bias.
 */
async function askLing(context, techBias) {
  const userMsg = [
    'Here is the latest technical snapshot:',
    '',
    context,
    '',
    `Simple technical pre-filter bias: ${techBias}`,
    '',
    'Return the JSON signal now.',
  ].join('\n');

  const raw = await chat(
    [
      { role: 'system', content: SIGNAL_SYSTEM },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.2, jsonKeys: ['signal'] },
  );

  const parsed = extractJson(raw, (o) => 'signal' in o);
  if (!parsed) {
    const looksLikeJson = /\{[\s\S]*\}/.test(raw);
    return {
      signal: 'FLAT',
      confidence: 0,
      reasoning: looksLikeJson ? 'Invalid JSON from model' : 'Could not parse model response',
      raw,
    };
  }
  const sigText = String(parsed.signal || '').trim().toUpperCase();
  const signal = ['LONG', 'SHORT', 'FLAT'].includes(sigText) ? sigText : 'FLAT';
  const confidence = normalizeConfidence(parsed.confidence, 0);
  const reasoning = String(parsed.reasoning || '').slice(0, 300);
  return { signal, confidence, reasoning, raw };
}

/**
 * Full hybrid (or tech-only) signal for one symbol.
 * @param {string} symbol
 * @param {{open:number,high:number,low:number,close:number,volume:number,date:string}[]} candles
 * @param {{ techOnly?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export async function generateSignal(symbol, candles, opts = {}) {
  const lookback = opts.lookbackBars ?? PAPER.lookbackBars;
  if (!candles || candles.length < Math.min(55, lookback)) {
    return {
      symbol,
      signal: 'FLAT',
      confidence: 0,
      reasoning: 'Not enough history',
      techBias: 'NEUTRAL',
      indicators: null,
      mode: opts.techOnly ? 'tech-only' : 'hybrid',
    };
  }

  const recent = candles.slice(-lookback);
  const ind = computeIndicators(recent);
  const techBias = technicalBias(ind);
  const context = buildContext(symbol, recent, ind);

  let result;

  if (opts.techOnly) {
    result = techOnlySignal(techBias, ind);
  } else if (techBias === 'NEUTRAL' && !opts.forceLlm) {
    // Skip LLM when technicals are mixed — faster backtests, fewer weak signals
    result = {
      signal: 'FLAT',
      confidence: 0.4,
      reasoning: 'Technicals mixed / neutral — skipped LLM call',
    };
  } else {
    try {
      const llm = await askLing(context, techBias);
      result = llm;
      if (techBias === 'LONG_BIAS' && result.signal === 'SHORT') result.signal = 'FLAT';
      if (techBias === 'SHORT_BIAS' && result.signal === 'LONG') result.signal = 'FLAT';
    } catch (err) {
      result = {
        signal: 'FLAT',
        confidence: 0,
        reasoning: `LLM unavailable (${String(err.message || err).slice(0, 80)}) — stayed flat`,
      };
    }
  }

  // Respect minimum confidence
  let finalSignal = result.signal;
  if (result.confidence < PAPER.minConfidence) {
    finalSignal = 'FLAT';
  }

  return {
    symbol,
    signal: finalSignal,
    confidence: result.confidence,
    reasoning: result.reasoning,
    techBias,
    indicators: ind,
    date: recent[recent.length - 1].date,
    mode: opts.techOnly ? 'tech-only' : 'hybrid',
  };
}
