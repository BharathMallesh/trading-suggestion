// Paper-bot configuration (experimental signal + paper trading system)
// Tuned for fewer, higher-quality paper trades on a ₹10k account.

export const PAPER = {
  // Starting paper capital (INR)
  startingCapital: 10_000,

  // Risk management — (2) larger size than before, still capped
  riskPerTradePct: 2.5,       // % of equity risked per trade (was 1.5)
  maxPositionPct: 35,         // max % of equity in one name (was 25)
  maxOpenPositions: 3,

  // Stop / Target — (3) better R:R for win-rate economics
  stopAtrMult: 1.5,           // stop distance = ATR × this
  targetAtrMult: 3.0,         // target = 3× ATR (was 2.5) → need fewer wins to break even
  useStops: true,

  // (3) Win-rate helpers
  minHoldBars: 3,             // don't exit on signal for at least N bars
  cooldownBarsAfterLoss: 3,   // no re-entry in same symbol for N bars after a loss

  allowShort: true,

  symbols: [
    'RELIANCE.NS',
    'HDFCBANK.NS',
    'TCS.NS',
    'INFY.NS',
    'ICICIBANK.NS',
    'SBIN.NS',
    'BHARTIARTL.NS',
    'ITC.NS',
    'LT.NS',
    'AXISBANK.NS',
  ],

  candleRange: '6mo',
  candleInterval: '1d',

  intraday: {
    // 15m needs ~1 month of bars: 5d (~80 bars) is too short for SMA-50 warm-up + a walk.
    '15m': { range: '1mo', interval: '15m', lookbackBars: 80 },
    '5m':  { range: '5d', interval: '5m',  lookbackBars: 100 },
    '1h':  { range: '1mo', interval: '60m', lookbackBars: 60 },
  },

  lookbackBars: 60,

  // (1) Confidence threshold — only act at/above this
  minConfidence: 0.60,

  // News sentiment may shift up vs down by at most this many points
  // (0 = off). Auto-disabled if scored predictions show it hurts.
  newsTiltPts: 5,

  // Indian cash-segment costs (see costs.mjs for the statutory rates). Override
  // brokerage / DP charge / slippage here to match your broker.
  costs: {},

  // Longer history for backtests (signals still use lookbackBars). Yahoo
  // limits: 60m ≈ 730 days, 15m/5m ≈ 60 days.
  backtestRange: { '1d': '2y', '1h': '6mo', '15m': '1mo', '5m': '1mo' },
};

// Technical filters — stricter for higher-quality setups
export const TECH = {
  rsiPeriod: 14,
  rsiOverbought: 65,
  rsiOversold: 35,
  smaFast: 20,
  smaSlow: 50,
  atrPeriod: 14,
  minVolRatio: 1.0,           // prefer average-or-better volume
  minSmaSeparationPct: 0.5,   // clearer trend separation
  // (3) Trend alignment: LONG only above SMA-50, SHORT only below
  requireTrendAlign: true,
};

/** Daily bars → delivery (overnight, long-only); minute/hour bars → intraday (same-day, shorts allowed). */
export const productFor = (interval) => (interval === '1d' ? 'delivery' : 'intraday');

/** Default replay / collection universe: the paper-bot's 10 symbols plus 8 more NIFTY 50 names. */
export const EVAL_UNIVERSE = [
  ...PAPER.symbols,
  'MARUTI.NS', 'SUNPHARMA.NS', 'HINDUNILVR.NS', 'KOTAKBANK.NS', 'BAJFINANCE.NS', 'ASIANPAINT.NS', 'NTPC.NS', 'TITAN.NS',
];
