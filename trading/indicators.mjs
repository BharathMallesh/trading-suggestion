// Pure, deterministic technical indicators for the charts. Descriptive only —
// a moving average summarizes past prices; it is NOT a signal or a forecast.
// No network, no model. Same numbers in, same numbers out.

/**
 * Simple moving average of a numeric series. Returns an array the same length
 * as the input, with `null` for the leading positions that don't yet have a
 * full window.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function sma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1) {
    throw new Error('sma(values, period): values must be an array and period a positive integer.');
  }
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
