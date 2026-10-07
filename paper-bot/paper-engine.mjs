// Paper-trading engine with long + short support, stops/targets, and stats.
// No real orders. Pure simulation.

import { PAPER } from './config.mjs';
import { orderCharges, slippedPrice, DEFAULT_COSTS } from './costs.mjs';

/**
 * @typedef {{
 *   symbol: string,
 *   side: 'LONG' | 'SHORT',
 *   qty: number,
 *   entryPrice: number,
 *   entryDate: string,
 *   stop: number | null,
 *   target: number | null,
 * }} Position
 */

export class PaperEngine {
  constructor(opts = {}) {
    this.startingCapital = opts.startingCapital ?? PAPER.startingCapital;
    this.cash = this.startingCapital;
    this.positions = new Map(); // symbol → Position
    this.closedTrades = [];
    this.equityCurve = [{ date: null, equity: this.startingCapital }];
    this.riskPerTradePct = opts.riskPerTradePct ?? PAPER.riskPerTradePct;
    this.maxPositionPct = opts.maxPositionPct ?? PAPER.maxPositionPct;
    this.maxOpenPositions = opts.maxOpenPositions ?? PAPER.maxOpenPositions;
    this.useStops = opts.useStops ?? PAPER.useStops;
    this.stopAtrMult = opts.stopAtrMult ?? PAPER.stopAtrMult;
    this.targetAtrMult = opts.targetAtrMult ?? PAPER.targetAtrMult;
    this.allowShort = opts.allowShort ?? PAPER.allowShort;
    this.minHoldBars = opts.minHoldBars ?? PAPER.minHoldBars ?? 0;
    this.cooldownBarsAfterLoss = opts.cooldownBarsAfterLoss ?? PAPER.cooldownBarsAfterLoss ?? 0;
    /** @type {Map<string, number>} symbol → bars remaining in cooldown */
    this.cooldownBars = new Map();
    // 'delivery' (positions held overnight, no shorts) or 'intraday'
    // (squared off same day, shorts allowed). Drives Indian cost rates.
    this.product = opts.product ?? 'delivery';
    this.costs = { ...DEFAULT_COSTS, ...(PAPER.costs || {}), ...(opts.costs || {}) };
    this.totalCharges = 0;
  }

  /** Statutory + brokerage charges for one order. */
  _charges(side, value) {
    const c = orderCharges({ side, value, product: this.product, costs: this.costs }).total;
    this.totalCharges += c;
    return c;
  }

  /** Current total equity (cash + mark-to-market of open positions) */
  equity(markPrices = {}) {
    let total = this.cash;
    for (const [sym, pos] of this.positions) {
      const px = markPrices[sym] ?? pos.entryPrice;
      const pnl = pos.side === 'LONG'
        ? (px - pos.entryPrice) * pos.qty
        : (pos.entryPrice - px) * pos.qty;
      // For both long and short we reserved the notional at entry
      total += pos.entryPrice * pos.qty + pnl;
    }
    return total;
  }

  /** Position size in shares */
  sizePosition(price, atr = null) {
    const eq = this.equity();
    const maxNotional = eq * (this.maxPositionPct / 100);
    let qty = Math.floor(maxNotional / price);

    if (atr && atr > 0) {
      const riskAmount = eq * (this.riskPerTradePct / 100);
      const riskPerShare = atr * this.stopAtrMult;
      const qtyByRisk = Math.floor(riskAmount / riskPerShare);
      qty = Math.min(qty, qtyByRisk);
    }

    return Math.max(0, qty);
  }

  _canOpen(symbol) {
    if (this.positions.has(symbol)) return { ok: false, reason: 'Already in position' };
    if (this.positions.size >= this.maxOpenPositions) {
      return { ok: false, reason: 'Max open positions reached' };
    }
    const cd = this.cooldownBars.get(symbol) || 0;
    if (cd > 0) return { ok: false, reason: `Cooldown (${cd} bars left after loss)` };
    return { ok: true };
  }

  /** Call once per bar (all symbols) to tick cooldowns and position hold age */
  tickBar() {
    for (const [sym, left] of this.cooldownBars) {
      if (left <= 1) this.cooldownBars.delete(sym);
      else this.cooldownBars.set(sym, left - 1);
    }
    for (const pos of this.positions.values()) {
      pos.barsHeld = (pos.barsHeld || 0) + 1;
    }
  }

  /** True if signal-based exit is allowed (min hold elapsed). Stops always allowed. */
  canSignalExit(symbol) {
    const pos = this.positions.get(symbol);
    if (!pos) return false;
    return (pos.barsHeld || 0) >= this.minHoldBars;
  }

  /**
   * Open LONG. Sets ATR-based stop (below) and target (above).
   */
  openLong(symbol, price, date, atr = null) {
    const gate = this._canOpen(symbol);
    if (!gate.ok) return gate;

    const qty = this.sizePosition(price, atr);
    if (qty <= 0) return { ok: false, reason: 'Size too small' };

    const fill = slippedPrice(price, 'buy', this.costs);
    const notional = qty * fill;
    const fees = orderCharges({ side: 'buy', value: notional, product: this.product, costs: this.costs }).total;
    const totalCost = notional + fees;

    if (totalCost > this.cash) return { ok: false, reason: 'Insufficient cash' };
    this.totalCharges += fees;
    price = fill;

    let stop = null;
    let target = null;
    if (this.useStops && atr && atr > 0) {
      stop = price - atr * this.stopAtrMult;
      target = price + atr * this.targetAtrMult;
    }

    this.cash -= totalCost;
    this.positions.set(symbol, {
      symbol, side: 'LONG', qty, entryPrice: price, entryDate: date, entryFees: fees, stop, target, barsHeld: 0,
    });

    return { ok: true, qty, cost: totalCost, stop, target, side: 'LONG' };
  }

  /**
   * Open SHORT (paper only). Sets ATR-based stop (above) and target (below).
   * Margin is simplified: we reserve the full notional from cash (conservative).
   */
  openShort(symbol, price, date, atr = null) {
    if (!this.allowShort) return { ok: false, reason: 'Short selling disabled' };
    if (this.product === 'delivery') {
      // Retail can't carry a short overnight in the NSE cash segment (that needs futures).
      return { ok: false, reason: 'Overnight shorts are not allowed in the cash segment (intraday only)' };
    }

    const gate = this._canOpen(symbol);
    if (!gate.ok) return gate;

    const qty = this.sizePosition(price, atr);
    if (qty <= 0) return { ok: false, reason: 'Size too small' };

    const fill = slippedPrice(price, 'sell', this.costs);
    const notional = qty * fill;
    const fees = orderCharges({ side: 'sell', value: notional, product: this.product, costs: this.costs }).total;
    const totalReserved = notional + fees;

    if (totalReserved > this.cash) return { ok: false, reason: 'Insufficient cash/margin' };
    this.totalCharges += fees;
    price = fill;

    let stop = null;
    let target = null;
    if (this.useStops && atr && atr > 0) {
      stop = price + atr * this.stopAtrMult;   // stop above for short
      target = price - atr * this.targetAtrMult; // target below
    }

    this.cash -= totalReserved;
    this.positions.set(symbol, {
      symbol, side: 'SHORT', qty, entryPrice: price, entryDate: date, entryFees: fees, stop, target, barsHeld: 0,
    });

    return { ok: true, qty, cost: totalReserved, stop, target, side: 'SHORT' };
  }

  closePosition(symbol, price, date, reason = 'signal') {
    const pos = this.positions.get(symbol);
    if (!pos) return { ok: false, reason: 'No position' };

    // Exit: a long sells (receives less after slippage), a short buys back (pays more).
    const exitSide = pos.side === 'LONG' ? 'sell' : 'buy';
    price = slippedPrice(price, exitSide, this.costs);
    const notional = pos.qty * price;
    const fees = this._charges(exitSide, notional);

    const entryFees = pos.entryFees || 0;
    const entryNotional = pos.qty * pos.entryPrice;
    let pnl;
    let cashBack;

    if (pos.side === 'LONG') {
      // Sell: receive proceeds minus exit fees. PnL counts BOTH legs of fees.
      cashBack = notional - fees;
      pnl = cashBack - entryNotional - entryFees;
    } else {
      // Cover short: profit when price fell. Release the reserved notional
      // (entry fees were already paid at open), adjusted by the move and exit fees.
      cashBack = entryNotional + (pos.entryPrice - price) * pos.qty - fees;
      pnl = (pos.entryPrice - price) * pos.qty - fees - entryFees;
    }

    this.cash += cashBack;
    this.positions.delete(symbol);

    if (pnl < 0 && this.cooldownBarsAfterLoss > 0) {
      this.cooldownBars.set(symbol, this.cooldownBarsAfterLoss);
    }

    const trade = {
      symbol,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      entryDate: pos.entryDate,
      exitPrice: price,
      exitDate: date,
      pnl,
      pnlPct: (pnl / entryNotional) * 100,
      charges: entryFees + fees,
      reason,
      stop: pos.stop,
      target: pos.target,
    };
    this.closedTrades.push(trade);

    return { ok: true, trade };
  }

  /**
   * Check open positions against bar high/low for stop / target hits.
   * LONG:  stop if low <= stop,  target if high >= target
   * SHORT: stop if high >= stop, target if low <= target
   */
  checkStopsAndTargets(symbol, bar) {
    const pos = this.positions.get(symbol);
    if (!pos || !this.useStops) return [];

    const closed = [];

    // Fills are gap-aware: if the bar OPENS beyond the level, the realistic
    // fill is the open (worse for stops, better for targets), not the level.
    const open = Number.isFinite(bar.open) ? bar.open : null;
    if (pos.side === 'LONG') {
      if (pos.stop != null && bar.low <= pos.stop) {
        const px = open != null && open < pos.stop ? open : pos.stop;
        const res = this.closePosition(symbol, px, bar.date, 'stop-loss');
        if (res.ok) closed.push(res.trade);
        return closed;
      }
      if (pos.target != null && bar.high >= pos.target) {
        const px = open != null && open > pos.target ? open : pos.target;
        const res = this.closePosition(symbol, px, bar.date, 'take-profit');
        if (res.ok) closed.push(res.trade);
        return closed;
      }
    } else if (pos.side === 'SHORT') {
      if (pos.stop != null && bar.high >= pos.stop) {
        const px = open != null && open > pos.stop ? open : pos.stop;
        const res = this.closePosition(symbol, px, bar.date, 'stop-loss');
        if (res.ok) closed.push(res.trade);
        return closed;
      }
      if (pos.target != null && bar.low <= pos.target) {
        const px = open != null && open < pos.target ? open : pos.target;
        const res = this.closePosition(symbol, px, bar.date, 'take-profit');
        if (res.ok) closed.push(res.trade);
        return closed;
      }
    }

    return closed;
  }

  mark(date, markPrices = {}) {
    this.equityCurve.push({ date, equity: this.equity(markPrices) });
  }

  summary() {
    const finalEquity = this.equity();
    const totalReturn = ((finalEquity / this.startingCapital) - 1) * 100;
    const wins = this.closedTrades.filter((t) => t.pnl > 0);
    const losses = this.closedTrades.filter((t) => t.pnl <= 0);
    const winRate = this.closedTrades.length
      ? (wins.length / this.closedTrades.length) * 100
      : 0;

    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    let peak = this.startingCapital;
    let maxDd = 0;
    for (const pt of this.equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = ((peak - pt.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }

    const reasons = {};
    const sides = { LONG: 0, SHORT: 0 };
    for (const t of this.closedTrades) {
      reasons[t.reason] = (reasons[t.reason] || 0) + 1;
      sides[t.side] = (sides[t.side] || 0) + 1;
    }

    return {
      startingCapital: this.startingCapital,
      finalEquity,
      totalReturnPct: totalReturn,
      closedTrades: this.closedTrades.length,
      openPositions: this.positions.size,
      winRatePct: winRate,
      profitFactor,
      maxDrawdownPct: maxDd,
      cash: this.cash,
      totalCharges: this.totalCharges,
      product: this.product,
      exitReasons: reasons,
      sideBreakdown: sides,
      trades: this.closedTrades,
      equityCurve: this.equityCurve,
    };
  }
}
