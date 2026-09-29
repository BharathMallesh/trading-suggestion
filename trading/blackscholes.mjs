// Pure, deterministic Black-Scholes option maths for the research module.
// No network, no model, no advice — just the standard textbook formulas so
// analysis can cite real greeks and payoff numbers instead of hand-waving.
// Everything here is mechanical: given inputs, the outputs are fixed. It does
// NOT estimate future prices or say whether a trade is good.

const SQRT2PI = Math.sqrt(2 * Math.PI);

/** Standard normal probability density function. */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/**
 * Standard normal cumulative distribution function (Abramowitz & Stegun 7.1.26
 * approximation — accurate to ~1e-7, plenty for greeks).
 */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes price and greeks for a European option.
 * @param {object} p
 * @param {number} p.spot        underlying price (S)
 * @param {number} p.strike      strike price (K)
 * @param {number} p.tYears      time to expiry in YEARS (e.g. days/365)
 * @param {number} p.iv          implied volatility as a DECIMAL (0.18 for 18%)
 * @param {'CE'|'PE'} p.type     CE = call, PE = put
 * @param {number} [p.rate=0.065] annual risk-free rate (India ~6.5% default)
 * @returns {{price:number, delta:number, gamma:number, vegaPer1pct:number,
 *   thetaPerDay:number, d1:number, d2:number}}
 */
export function greeks({ spot, strike, tYears, iv, type, rate = 0.065 }) {
  const isCall = type === 'CE';
  // Guard the degenerate cases (expiry today, zero vol) so we return the
  // intrinsic value cleanly instead of dividing by zero.
  if (!(tYears > 0) || !(iv > 0)) {
    const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    const delta = isCall ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, vegaPer1pct: 0, thetaPerDay: 0, d1: NaN, d2: NaN };
  }
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * tYears) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const discK = strike * Math.exp(-rate * tYears);

  const price = isCall
    ? spot * normCdf(d1) - discK * normCdf(d2)
    : discK * normCdf(-d2) - spot * normCdf(-d1);
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (spot * iv * sqrtT);
  // Vega scaled to a 1-percentage-point IV move; theta scaled to one calendar day.
  const vegaPer1pct = (spot * normPdf(d1) * sqrtT) / 100;
  const thetaYear = isCall
    ? -(spot * normPdf(d1) * iv) / (2 * sqrtT) - rate * discK * normCdf(d2)
    : -(spot * normPdf(d1) * iv) / (2 * sqrtT) + rate * discK * normCdf(-d2);
  const thetaPerDay = thetaYear / 365;

  return { price, delta, gamma, vegaPer1pct, thetaPerDay, d1, d2 };
}

/**
 * Deterministic payoff mechanics for a SINGLE-LEG option position the user is
 * examining. This describes the position's math (breakeven, max loss, max
 * profit) — it is NOT a suggestion to take it. `action`/`type` come from the
 * user naming the position they want to understand.
 * @param {object} p
 * @param {'buy'|'sell'} p.action
 * @param {'CE'|'PE'} p.type
 * @param {number} p.strike
 * @param {number} p.premium     the option's last/entry price
 * @param {number} [p.lotSize=1] contract multiplier, for per-lot rupee figures
 * @returns {{position:string, breakeven:number, maxLoss:(number|'unlimited'),
 *   maxProfit:(number|'unlimited'), perLot:object}}
 */
export function payoff({ action, type, strike, premium, lotSize = 1 }) {
  const isCall = type === 'CE';
  const breakeven = isCall ? strike + premium : strike - premium;
  // Long option: pay premium, loss capped at premium. Short option: collect
  // premium, profit capped at premium, loss is the buyer's mirror.
  let maxLoss, maxProfit;
  if (action === 'buy') {
    maxLoss = premium; // per share
    maxProfit = isCall ? 'unlimited' : strike - premium; // put floors at 0
  } else {
    maxProfit = premium;
    maxLoss = isCall ? 'unlimited' : strike - premium;
  }
  const scale = (v) => (v === 'unlimited' ? 'unlimited' : +(v * lotSize).toFixed(2));
  return {
    position: `${action} ${type} ${strike}`,
    breakeven: +breakeven.toFixed(2),
    maxLoss, // per share
    maxProfit, // per share
    perLot: { maxLoss: scale(maxLoss), maxProfit: scale(maxProfit) },
  };
}

// CLI: an educational calculator. You supply every number; it does the maths.
// It does NOT fetch data, does NOT talk to any broker, and does NOT recommend
// anything — same numbers in, same numbers out.
//
//   node blackscholes.mjs --spot 2500 --strike 2520 --days 7 --iv 18 --type CE
//   ...add --action buy --lot 250 to also print the payoff of that position.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const num = (flag) => (get(flag) === undefined ? undefined : Number(get(flag)));

  const spot = num('--spot');
  const strike = num('--strike');
  const days = num('--days');
  const ivPct = num('--iv');
  const type = (get('--type') || 'CE').toUpperCase();
  const rate = num('--rate') ?? 0.065;

  if ([spot, strike, days, ivPct].some((v) => v === undefined || Number.isNaN(v)) || !['CE', 'PE'].includes(type)) {
    console.error('Usage: node blackscholes.mjs --spot S --strike K --days D --iv IV% --type CE|PE');
    console.error('  optional: --rate 0.065  --action buy|sell  --lot N  --premium P');
    console.error('  e.g. node blackscholes.mjs --spot 2500 --strike 2520 --days 7 --iv 18 --type CE');
    process.exit(1);
  }

  const g = greeks({ spot, strike, tYears: days / 365, iv: ivPct / 100, type, rate });
  console.log(`${type} ${strike} | spot ${spot} | ${days}d | IV ${ivPct}% | r ${(rate * 100).toFixed(1)}%`);
  console.log(`Theoretical price : ${g.price.toFixed(2)}`);
  console.log(`Delta             : ${g.delta.toFixed(4)}`);
  console.log(`Gamma             : ${g.gamma.toFixed(6)}`);
  console.log(`Vega (per 1% IV)  : ${g.vegaPer1pct.toFixed(4)}`);
  console.log(`Theta (per day)   : ${g.thetaPerDay.toFixed(4)}`);

  const action = get('--action');
  if (action && ['buy', 'sell'].includes(action)) {
    // Use --premium if given, else the theoretical price, for the payoff maths.
    const premium = num('--premium') ?? g.price;
    const lotSize = num('--lot') ?? 1;
    const p = payoff({ action, type, strike, premium, lotSize });
    console.log(`\nPosition          : ${p.position} @ ${premium.toFixed(2)}`);
    console.log(`Breakeven         : ${p.breakeven}`);
    console.log(`Max loss / lot    : ${p.perLot.maxLoss}`);
    console.log(`Max profit / lot  : ${p.perLot.maxProfit}`);
    console.log('\n(Mechanics of the position you described — not a suggestion to take it.)');
  }
}
