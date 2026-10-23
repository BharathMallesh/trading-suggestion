// One day's results across all three strategies (library), for the Home tab's
// "Today's results" button: every paper trade the YouTube intraday versions
// and the Breakfast strategy took that day, and the strong-stock swing
// strategy's buys, exits, open positions and new signals.
// Read-only: built from the paper records the 4:05 PM collect job writes.

import { loadPaper } from './vwap-pullback.mjs';
import { loadBreakfastPaper } from './breakfast.mjs';
import { loadAthPaper } from './ath-swing.mjs';
import { isTradingDay, lastSessionDate } from './market-calendar.mjs';
import { badRequest } from '../util.mjs';
import { loadFoStranglePaper } from './fo-strangle.mjs';
import { loadNiftyDipPaper, ofVersion, VERSION_LABELS } from './nifty-dip.mjs';

const istDate = (iso) => (iso ? new Date(new Date(iso).getTime() + 19800_000).toISOString().slice(0, 10) : null);
const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
const LABELS = { video: 'Video rules', improved: 'Improved (daily trend + 3×ATR stop)', scanner: 'Morning scanner (20 stocks)' };
const trade = (t) => ({ symbol: t.symbol, side: t.side, time: t.time || null, entry: t.entry, stop: t.stop, target: t.target, exit: t.exit, qty: t.qty, reason: t.reason, gross: t.gross, charges: t.charges, net: t.net, seenLive: t.seenLive ?? null });

/**
 * Results for `date` (default: the latest completed NSE session).
 * `scan` = the latest swing scan (its signals are shown only when it is for `date`).
 */
export function dayResults(date = null, { vwap = loadPaper(), breakfast = loadBreakfastPaper(), swing = loadAthPaper(), dip = loadNiftyDipPaper(), fo = loadFoStranglePaper(), scan = null, swingVersion = 'original', now = new Date() } = {}) {
  const d = date || lastSessionDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest('Date must be YYYY-MM-DD.');
  const vt = vwap?.trades || [];
  const bt = breakfast?.trades || [];
  const st = (swing?.trades || []).filter((t) => (t.version || 'original') === swingVersion);

  const variants = Object.keys(LABELS).map((k) => {
    const all = vt.filter((t) => (t.variant || 'video') === k);
    const day = all.filter((t) => t.date === d);
    return { key: k, label: vwap?.variants?.[k]?.label?.replace(/ \(unproven\)$/, '') || LABELS[k], trades: day.map(trade), dayNet: sum(day, (t) => t.net), wins: day.filter((t) => t.net > 0).length, total: { trades: all.length, net: sum(all, (t) => t.net) } };
  });
  const bDay = bt.filter((t) => t.date === d);
  const signals = scan && scan.date === d ? scan.triggered || [] : [];

  const dates = [...new Set([...vt.map((t) => t.date), ...bt.map((t) => t.date), ...st.flatMap((t) => [t.entryDate, t.exitDate]), ...(dip?.trades || []).flatMap((t) => [t.entryDate, t.exitDate])].filter(Boolean))].sort().reverse();
  const updated = [vwap?.updatedAt, breakfast?.updatedAt, swing?.updatedAt, dip?.updatedAt].map(istDate).filter(Boolean).sort().pop() || null;
  const todayIst = istDate(now.toISOString());
  const pending = isTradingDay(d) && (!updated || updated < d);

  return {
    date: d,
    tradingDay: isTradingDay(d),
    recordedUpTo: updated,
    pending,
    note: !isTradingDay(d)
      ? 'NSE was closed on this day (weekend or holiday): no trades.'
      : pending
        ? (d === todayIst ? 'Today\'s results are filled in after the market closes, by the 4:05 PM run. Until then, see Trading strategies for the live view.' : 'The paper records were not updated for this day (the Mac may have been off at 4:05 PM).')
        : null,
    dates: dates.slice(0, 40),
    vwap: { variants, dayNet: sum(variants, (v) => v.dayNet) },
    breakfast: {
      trades: bDay.map((t) => ({ ...trade(t), sector: t.sector, firstMovePct: t.firstMovePct, niftyMovePct: t.niftyMovePct, targetPct: t.targetPct })),
      dayNet: sum(bDay, (t) => t.net),
      total: { trades: bt.filter((t) => !t.open).length, net: sum(bt.filter((t) => !t.open), (t) => t.net) },
    },
    swing: {
      version: swingVersion,
      bought: st.filter((t) => t.entryDate === d).map((t) => ({ symbol: t.symbol, setup: t.setup, entry: t.entry, stop: t.stop })),
      exited: st.filter((t) => !t.open && t.exitDate === d).map((t) => ({ symbol: t.symbol, setup: t.setup, entry: t.entry, exit: t.exit, reason: t.reason, r: t.r, retPct: t.retPct, days: t.days })),
      // held at the end of that day (bought by then, not yet sold); prices are the latest close
      open: st.filter((t) => t.entryDate <= d && (t.open || t.exitDate > d)).map((t) => ({ symbol: t.symbol, setup: t.setup, entryDate: t.entryDate, entry: t.entry, last: t.exit, stillOpen: !!t.open, stop: t.stop, trail: t.trail, r: t.r, retPct: t.retPct, days: t.days })),
      newSignals: signals.filter((x) => !x.held).map((x) => ({ symbol: x.symbol, setup: x.setup, close: x.close, stop: x.stop, riskPct: x.riskPct })),
      heldSignals: signals.filter((x) => x.held).map((x) => x.symbol),
      signalsChecked: !!(scan && scan.date === d),
      total: { closed: st.filter((t) => !t.open).length, sumR: sum(st.filter((t) => !t.open), (t) => t.r) },
    },
    // standard version at the top level (as before), the deep-dip version under `deep`
    fo: fo ? {
      opened: (fo.trades || []).filter((t) => t.entryDate === d).map((t) => ({ callStrike: t.callStrike, putStrike: t.putStrike, credit: t.credit, expiry: t.expiry, spot: t.spot })),
      settled: (fo.trades || []).filter((t) => !t.open && t.expiry === d).map((t) => ({ callStrike: t.callStrike, putStrike: t.putStrike, settle: t.settle, rupees: t.rupees, retOnMargin: t.retOnMargin, breached: t.breached })),
      holding: (fo.trades || []).filter((t) => t.entryDate <= d && t.expiry > d).map((t) => ({ callStrike: t.callStrike, putStrike: t.putStrike, expiry: t.expiry, rupees: t.rupees, markDate: t.markDate || null, open: !!t.open })),
      lastDataDate: fo.lastDataDate || null,
      total: { weeks: (fo.trades || []).filter((t) => !t.open).length, rupees: sum((fo.trades || []).filter((t) => !t.open), (t) => t.rupees) },
    } : null,
    dip: (() => {
      const one = (v, status) => {
        const dt = ofVersion(dip?.trades, v);
        const held = dt.find((t) => t.entryDate <= d && (t.open || t.exitDate > d));
        const closed = dt.filter((t) => !t.open);
        return {
          label: VERSION_LABELS[v],
          bought: dt.filter((t) => t.entryDate === d).map((t) => ({ entry: t.entry, signalChangePct: t.signalChangePct })),
          sold: closed.filter((t) => t.exitDate === d).map((t) => ({ entryDate: t.entryDate, entry: t.entry, exit: t.exit, reason: t.reason, net: t.net, retPct: t.retPct, days: t.days })),
          holding: held ? { entryDate: held.entryDate, entry: held.entry, stillOpen: !!held.open, retPct: held.retPct, net: held.net } : null,
          status: status && status.date === d ? status : null,
          total: { trades: closed.length, net: sum(closed, (t) => t.net), wins: closed.filter((t) => t.net > 0).length },
          started: !!dip,
        };
      };
      return { ...one('standard', dip?.status), deep: one('deep', dip?.statuses?.deep) };
    })(),
  };
}
