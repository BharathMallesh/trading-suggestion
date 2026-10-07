// Simple, transparent technical indicators for the hybrid signal filter.
// Pure maths — no external libraries.

/**
 * Simple Moving Average
 * @param {number[]} values
 * @param {number} period
 */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Relative Strength Index (simple-average variant over the last `period` changes)
 * @param {number[]} closes
 * @param {number} period
 */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0 && avgGain === 0) return 50; // flat series: no momentum either way
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average True Range
 * @param {{high:number,low:number,close:number}[]} bars
 * @param {number} period
 */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const high = bars[i].high;
    const low = bars[i].low;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }

  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

/**
 * Compute a snapshot of key indicators from a candle series (oldest → newest)
 * @param {{open:number,high:number,low:number,close:number,volume:number}[]} candles
 */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);

  // Simple volume context
  const volumes = candles.map((c) => c.volume || 0).filter((v) => v > 0);
  const avgVol = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;
  const volRatio = avgVol && last.volume ? last.volume / avgVol : null;

  // Recent return
  const ret5 = closes.length >= 6
    ? ((closes[closes.length - 1] / closes[closes.length - 6]) - 1) * 100
    : null;
  const ret20 = closes.length >= 21
    ? ((closes[closes.length - 1] / closes[closes.length - 21]) - 1) * 100
    : null;

  return {
    close: last.close,
    sma20,
    sma50,
    rsi14,
    atr14,
    volRatio,
    ret5,
    ret20,
    // Derived flags used by the hybrid filter
    aboveSma20: sma20 != null ? last.close > sma20 : null,
    aboveSma50: sma50 != null ? last.close > sma50 : null,
    sma20AboveSma50: sma20 != null && sma50 != null ? sma20 > sma50 : null,
  };
}
