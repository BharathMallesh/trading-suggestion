// Indian equity (NSE cash segment) trading costs for the paper engine.
// Statutory rates as published by exchanges/brokers (checked Oct 2026):
//   STT            delivery 0.1% buy + sell · intraday 0.025% sell only
//   Exchange txn   NSE 0.00297% of turnover (both)
//   SEBI fee       ₹10 per crore (0.0001%)
//   Stamp duty     delivery 0.015% buy · intraday 0.003% buy
//   GST            18% on brokerage + exchange txn + SEBI fee
//   DP charge      delivery sell, per scrip per day (≈ ₹15.93 incl. GST at
//                  discount brokers; broker-specific)
// Brokerage is broker-specific; the default models a discount broker:
// delivery ₹0, intraday min(₹20, 0.03%) per executed order.
// Slippage (bid-ask / impact) is added on top of the fill price.
// Research simulation only — not investment advice; verify with your broker.

export const DEFAULT_COSTS = {
  brokerageDeliveryPct: 0, // % of order value
  brokerageDeliveryCap: 0, // ₹ per order (0 = no cap / not used)
  brokerageIntradayPct: 0.03,
  brokerageIntradayCap: 20,
  dpChargePerSell: 15.93, // ₹, delivery sells only
  slippagePct: 0.05, // % adverse move per fill
};

const RATES = {
  sttEtfSellPct: 0.001, // equity ETFs: STT only on sale, 0.001%
  sttDeliveryPct: 0.1,
  sttIntradaySellPct: 0.025,
  exchangePct: 0.00297,
  sebiPct: 0.0001,
  stampDeliveryBuyPct: 0.015,
  stampIntradayBuyPct: 0.003,
  gstPct: 18,
};

/**
 * Charges for ONE executed order (excluding slippage, which is applied to the
 * fill price by the engine).
 * @param {{ side:'buy'|'sell', value:number, product:'delivery'|'intraday'|'etf', costs?:object }} p
 * @returns {{ total:number, breakdown:object }}
 */
export function orderCharges({ side, value, product, costs = DEFAULT_COSTS }) {
  const v = Math.max(0, Number(value) || 0);
  const pct = (x) => (v * x) / 100;
  const intra = product === 'intraday';
  const brokerage = intra
    ? Math.min(pct(costs.brokerageIntradayPct), costs.brokerageIntradayCap || Infinity)
    : costs.brokerageDeliveryCap
      ? Math.min(pct(costs.brokerageDeliveryPct), costs.brokerageDeliveryCap)
      : pct(costs.brokerageDeliveryPct);
  const etf = product === 'etf'; // held in demat like delivery, but ETF STT
  const stt = intra ? (side === 'sell' ? pct(RATES.sttIntradaySellPct) : 0) : etf ? (side === 'sell' ? pct(RATES.sttEtfSellPct) : 0) : pct(RATES.sttDeliveryPct);
  const exchange = pct(RATES.exchangePct);
  const sebi = pct(RATES.sebiPct);
  const stamp = side === 'buy' ? pct(intra ? RATES.stampIntradayBuyPct : RATES.stampDeliveryBuyPct) : 0;
  const gst = ((brokerage + exchange + sebi) * RATES.gstPct) / 100;
  const dp = !intra && side === 'sell' && v > 0 ? costs.dpChargePerSell : 0;
  const breakdown = { brokerage, stt, exchange, sebi, stamp, gst, dp };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

/** Fill price after adverse slippage: buys pay up, sells receive less. */
export function slippedPrice(price, side, costs = DEFAULT_COSTS) {
  const s = (costs.slippagePct || 0) / 100;
  return side === 'buy' ? price * (1 + s) : price * (1 - s);
}

/**
 * Charges for ONE executed futures order (stock or index futures, NSE), excluding slippage.
 * STT 0.02% on sells from 1 Oct 2024 (0.0125% before), exchange 0.00173%, SEBI ₹10/crore, stamp 0.002% on buys,
 * brokerage min(₹20, 0.03%), GST 18% on brokerage + exchange + SEBI. `date` (YYYY-MM-DD) picks the STT rate.
 */
export function futuresCharges({ side, value, date = '2099-01-01', brokeragePct = 0.03, brokerageCap = 20 }) {
  const v = Math.max(0, Number(value) || 0);
  const pct = (x) => (v * x) / 100;
  const brokerage = Math.min(pct(brokeragePct), brokerageCap || Infinity);
  const stt = side === 'sell' ? pct(String(date) >= '2024-10-01' ? 0.02 : 0.0125) : 0;
  const exchange = pct(0.00173);
  const sebi = pct(RATES.sebiPct);
  const stamp = side === 'buy' ? pct(0.002) : 0;
  const gst = ((brokerage + exchange + sebi) * RATES.gstPct) / 100;
  const breakdown = { brokerage, stt, exchange, sebi, stamp, gst };
  return { total: Object.values(breakdown).reduce((a, b) => a + b, 0), breakdown };
}
