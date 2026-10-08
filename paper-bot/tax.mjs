// Indian capital-gains tax ledger for the strategy backtests (individual,
// resident; listed equity shares and equity ETFs held in demat).
//   Equity, sold ≤ 12 months after purchase → short-term (STCG)
//     20% from 23 Jul 2024 (15% before)
//   Equity, held > 12 months → long-term (LTCG), on gains above an annual
//     exemption: 12.5% above ₹1.25 lakh from 23 Jul 2024 (10% above ₹1 lakh before)
//   + 4% cess on the tax.
//   Set-off (per financial year, Apr–Mar): short-term losses offset short- or
//   long-term gains; long-term losses offset only long-term gains; unused
//   losses carry forward 8 years.
//   Dividends and liquid-fund (debt) returns: taxed at the income slab rate
//   (assumption — default 30% bracket), charged each financial year.
// Lots are matched first-in, first-out. Simplifications: no surcharge, no
// 2018 grandfathering, liquid-fund gains taxed yearly rather than on redemption.
// Research only — not tax advice.

export const TAX_RULES = {
  cess: 0.04,
  slabRate: 0.3, // dividends + liquid fund (debt) returns
  change: '2024-07-23', // Budget 2024 rates apply to sales on/after this date
  before: { stcg: 0.15, ltcg: 0.1, ltcgExemption: 100000 },
  after: { stcg: 0.2, ltcg: 0.125, ltcgExemption: 125000 },
};

/** Financial year (Apr–Mar) label for an ISO date, e.g. '2024-25'. */
export function fyOf(date) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const DAY = 86400000;
const longTerm = (buy, sell) => {
  // "more than 12 months": held past the same calendar date a year later
  const b = new Date(`${buy}T00:00:00Z`);
  const anniv = Date.UTC(b.getUTCFullYear() + 1, b.getUTCMonth(), b.getUTCDate());
  return Date.parse(`${sell}T00:00:00Z`) > anniv;
};

export class TaxLedger {
  constructor(rules = TAX_RULES) {
    this.rules = rules;
    this.lots = new Map(); // symbol → [{ units, cost, date }]
    this.fy = new Map(); // FY → { st, lt, ltRateGains: [{gain, rate, exemption}], income, regime }
    this.carryST = []; // [{ fy, amount }] unused losses (positive numbers)
    this.carryLT = [];
    this.paid = 0;
  }

  _year(date) {
    const k = fyOf(date);
    if (!this.fy.has(k)) this.fy.set(k, { st: [], lt: [], income: 0 });
    return this.fy.get(k);
  }

  buy(symbol, units, price, date) {
    if (!(units > 0)) return;
    const l = this.lots.get(symbol) || [];
    l.push({ units, cost: price, date });
    this.lots.set(symbol, l);
  }

  /** Sell units FIFO; records realised gains by holding period and rate regime. */
  sell(symbol, units, price, date) {
    const l = this.lots.get(symbol) || [];
    let left = units;
    const y = this._year(date);
    const regime = date >= this.rules.change ? 'after' : 'before';
    while (left > 1e-12 && l.length) {
      const lot = l[0];
      const u = Math.min(lot.units, left);
      const gain = u * (price - lot.cost);
      (longTerm(lot.date, date) ? y.lt : y.st).push({ gain, regime });
      lot.units -= u;
      left -= u;
      if (lot.units <= 1e-12) l.shift();
    }
    this.lots.set(symbol, l);
  }

  /** Slab-taxed income (dividends, liquid-fund returns). */
  income(amount, date) {
    if (amount) this._year(date).income += amount;
  }

  /**
   * Tax due for one financial year (and update carried-forward losses).
   * Rates follow the regime of each sale; the LTCG exemption is the one in
   * force at the year's end.
   */
  settle(fy) {
    const y = this.fy.get(fy);
    if (!y) return 0;
    const r = this.rules;
    const sum = (a) => a.reduce((s, x) => s + x.gain, 0);
    // Net within each bucket, keeping each regime's rate on the gains.
    let st = sum(y.st);
    let lt = sum(y.lt);
    // 1. this year's ST loss offsets LT gains
    if (st < 0 && lt > 0) {
      const use = Math.min(-st, lt);
      st += use;
      lt -= use;
    }
    // 2. carried-forward losses (oldest first; drop after 8 years)
    const fyStart = Number(fy.slice(0, 4));
    this.carryST = this.carryST.filter((c) => fyStart - Number(c.fy.slice(0, 4)) <= 8);
    this.carryLT = this.carryLT.filter((c) => fyStart - Number(c.fy.slice(0, 4)) <= 8);
    const absorb = (gain, pools) => {
      for (const pool of pools) {
        for (const c of pool) {
          if (gain <= 0) return gain;
          const use = Math.min(c.amount, gain);
          c.amount -= use;
          gain -= use;
        }
      }
      return gain;
    };
    if (st > 0) st = absorb(st, [this.carryST]);
    if (lt > 0) lt = absorb(lt, [this.carryLT, this.carryST]);
    if (st < 0) this.carryST.push({ fy, amount: -st });
    if (lt < 0) this.carryLT.push({ fy, amount: -lt });
    this.carryST = this.carryST.filter((c) => c.amount > 1e-9);
    this.carryLT = this.carryLT.filter((c) => c.amount > 1e-9);
    // 3. rates: blend by each regime's share of the year's gross gains
    const share = (arr) => {
      const pos = arr.filter((x) => x.gain > 0);
      const tot = pos.reduce((s, x) => s + x.gain, 0);
      return tot ? pos.filter((x) => x.regime === 'after').reduce((s, x) => s + x.gain, 0) / tot : 1;
    };
    const aSt = share(y.st);
    const aLt = share(y.lt);
    const stRate = aSt * r.after.stcg + (1 - aSt) * r.before.stcg;
    const ltRate = aLt * r.after.ltcg + (1 - aLt) * r.before.ltcg;
    const fyEnd = `${fyStart + 1}-03-31`;
    const exemption = fyEnd >= r.change ? r.after.ltcgExemption : r.before.ltcgExemption;
    const tax = (Math.max(0, st) * stRate + Math.max(0, lt - exemption) * ltRate + Math.max(0, y.income) * r.slabRate) * (1 + r.cess);
    this.paid += tax;
    return tax;
  }

  /** Plain-object state (for saving in JSON). */
  toJSON() {
    return { lots: Object.fromEntries(this.lots), fy: Object.fromEntries(this.fy), carryST: this.carryST, carryLT: this.carryLT, paid: this.paid };
  }

  static from(obj, rules = TAX_RULES) {
    const L = new TaxLedger(rules);
    if (!obj) return L;
    L.lots = new Map(Object.entries(obj.lots || {}).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
    L.fy = new Map(Object.entries(obj.fy || {}).map(([k, v]) => [k, { st: [...v.st], lt: [...v.lt], income: v.income }]));
    L.carryST = (obj.carryST || []).map((x) => ({ ...x }));
    L.carryLT = (obj.carryLT || []).map((x) => ({ ...x }));
    L.paid = obj.paid || 0;
    return L;
  }

  /** Units held of a symbol. */
  units(symbol) {
    return (this.lots.get(symbol) || []).reduce((s, l) => s + l.units, 0);
  }
}

/** True if `date` is the last session of a financial year (next session is in a new FY). */
export function isFyEnd(date, nextDate) {
  return !nextDate || fyOf(date) !== fyOf(nextDate);
}

export { DAY };
