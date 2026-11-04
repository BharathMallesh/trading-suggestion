// "My F&O plan" (library): the 3-month plan for a ₹10,000 F&O account, run on the spread paper tracker.
// Practise on paper until 20–30 spreads have closed, then decide from the record: try real money at the
// same small size only if it made money after charges AND beat simply holding NIFTY over the same time;
// otherwise stop F&O and put the money in a tested monthly portfolio. A 30% fall stops it at any time.
// Also today's checklist: every plan rule checked against the open trades. Facts from the paper record,
// not advice — the app's tests found bought options and spreads about break-even at best.

import { candles } from '../market-data.mjs';
import { loadSpreadPaper, RULES } from './spread-paper.mjs';

export const PLAN = { early: 20, decide: 30, stopAtPct: 30 };
const rs = (v) => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** Worst fall of the account value from its high (0–1), from the start money on. */
export function worstFall(curve, capital) {
  let peak = capital;
  let worst = 0;
  for (const x of curve || []) {
    peak = Math.max(peak, x.value);
    worst = Math.max(worst, 1 - x.value / peak);
  }
  return worst;
}

/** t-statistic of the per-trade results (how far from luck the average is). */
const tStat = (xs) => {
  if (xs.length < 3) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null;
};

/** The plan's state from the paper record (+ NIFTY's change over the same time when given). */
export function foPlanFrom(st, { niftyRet = null, today = null } = {}) {
  const rules = { ...RULES, ...(st?.rules || {}) };
  const capital = rules.capital;
  if (!st?.trades) return { ready: false, capital, plan: PLAN, rules, note: 'The practice account starts with the next evening job.' };
  const closed = st.trades.filter((t) => !t.open);
  const open = st.trades.filter((t) => t.open);
  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const value = st.summary?.value ?? capital;
  const ret = value / capital - 1;
  const fall = worstFall(st.curve, capital);
  const t = tStat(closed.map((x) => x.pnl));
  const n = closed.length;
  // the decision
  let status;
  let text;
  if (st.stopped || fall >= PLAN.stopAtPct / 100) {
    status = 'stop';
    text = `Stop rule: the account fell ${Math.round(fall * 100)}% (limit ${PLAN.stopAtPct}%). No new trades — move the money to a tested monthly portfolio (Momentum 10 or India mix, Home → Do this month).`;
  } else if (n < PLAN.early) {
    status = 'practise';
    text = `Keep practising on paper: ${n} of ${PLAN.early} spreads closed. Don't use real money yet.`;
  } else {
    const beat = niftyRet == null ? null : ret > niftyRet;
    const good = net > 0 && beat !== false;
    const firm = n >= PLAN.decide;
    status = good ? (firm ? 'go-small' : 'early-good') : firm ? 'stop' : 'early-bad';
    text = good
      ? firm
        ? `The paper record passed: ${rs(net)} after charges over ${n} trades${niftyRet != null ? `, ahead of NIFTY (${(ret * 100).toFixed(1)}% vs ${(niftyRet * 100).toFixed(1)}%)` : ''}. You could try real money at the same small size and rules — and keep checking it here.${t != null && t < 2 ? ` It could still be luck (t ${t.toFixed(1)}; 2 or more is convincing).` : ''}`
        : `Early read is positive (${rs(net)} over ${n} trades). Wait for ${PLAN.decide} closed trades before deciding.`
      : firm
        ? `The paper record did not pass: ${rs(net)} after charges over ${n} trades${niftyRet != null ? ` (${(ret * 100).toFixed(1)}% vs NIFTY ${(niftyRet * 100).toFixed(1)}%)` : ''}. Stop F&O and move the ₹${capital.toLocaleString('en-IN')} to a tested monthly portfolio (Momentum 10 or India mix).`
        : `Early read is negative (${rs(net)} over ${n} trades). If it is still behind at ${PLAN.decide} trades, the plan says stop.`;
  }
  // today's checklist: each rule against the open trades
  const day = today?.kinds?.find((k) => k.kind === 'intraday');
  const checklist = [
    { rule: `At most ${rules.maxOpen} spreads open`, ok: open.length <= rules.maxOpen, detail: `${open.length} open` },
    { rule: `Most you can lose ≤ ₹${rules.perTrade.toLocaleString('en-IN')} a trade (cost + charges)`, ok: open.every((x) => (x.maxLoss ?? x.cost) <= rules.perTrade), detail: open.length ? open.map((x) => `${x.symbol} ₹${Math.round(x.maxLoss ?? x.cost).toLocaleString('en-IN')}`).join(', ') : 'no open trades' },
    { rule: `At most ${rules.maxPerSide} the same way (calls or puts)`, ok: ['call-spread', 'put-spread'].every((s) => open.filter((x) => x.strategy === s).length <= rules.maxPerSide), detail: `${open.filter((x) => x.strategy === 'call-spread').length} call · ${open.filter((x) => x.strategy === 'put-spread').length} put` },
    { rule: 'One trade per stock', ok: new Set(open.map((x) => x.symbol)).size === open.length, detail: open.map((x) => x.symbol).join(', ') || '–' },
    { rule: 'Calls only on STRONG stocks, puts only on WEAK (Up/Down outlook)', ok: open.every((x) => x.lean === 'index' || (x.lean === 'strong') === (x.strategy === 'call-spread')), detail: open.map((x) => `${x.symbol} ${x.lean}`).join(', ') || '–' },
    { rule: `No new trade on a Trade today? STAY OUT day`, ok: day ? day.level !== 'stay' : null, detail: day ? (day.level === 'stay' ? `STAY OUT today: ${today.signs.map((s) => s.text).join('; ')}` : `today: ${day.level === 'go' ? 'GO' : 'BE CAREFUL'}`) : 'not checked' },
    { rule: `Account above the ${PLAN.stopAtPct}% stop (₹${Math.round(capital * (1 - PLAN.stopAtPct / 100)).toLocaleString('en-IN')})`, ok: value > capital * (1 - PLAN.stopAtPct / 100), detail: `now ₹${Math.round(value).toLocaleString('en-IN')}` },
    { rule: 'Stock spreads sold 2 sessions before expiry (no delivery)', ok: true, detail: open.filter((x) => x.exitBy).map((x) => `${x.symbol} by ${x.exitBy}`).join(', ') || '–' },
  ];
  const manual = ['Skip a stock on its results day (check the company\'s announcements)', 'Skip F&O on RBI policy days and the Budget', 'Check NSE\'s F&O ban list before a stock trade', 'Never sell naked options with a small account'];
  return {
    ready: true, capital, plan: PLAN, rules, startedAt: st.startedAt,
    progress: { closed: n, early: PLAN.early, decide: PLAN.decide, wins: closed.filter((x) => x.pnl > 0).length, winRate: n ? closed.filter((x) => x.pnl > 0).length / n : null, net, value, ret, niftyRet, worstFall: fall, tStat: t, open: open.length, skippedDays: (st.skipped || []).length },
    decision: { status, text },
    checklist, manual,
    note: `Paper only. The plan's numbers come from the spread paper tracker (₹${capital.toLocaleString('en-IN')}, from ${st.startedAt}). "Beat NIFTY" compares the account with simply holding NIFTY over the same time. 20–30 trades is still a small sample — even a pass can be luck, so keep the same small size if you try real money.`,
  };
}

const niftyCache = { at: 0, key: '', ret: null };
export async function foPlan({ paper = loadSpreadPaper(), loadCandles = candles, dayCheck = null } = {}) {
  let niftyRet = null;
  if (paper?.startedAt) {
    try {
      if (niftyCache.key !== paper.startedAt || Date.now() - niftyCache.at > 3600_000) {
        const rows = (await loadCandles('^NSEI', { period1: Math.floor(Date.parse(`${paper.startedAt}T00:00:00Z`) / 1000) - 7 * 86400, interval: '1d' })).filter((x) => x.close > 0);
        const start = rows.filter((x) => x.date <= paper.startedAt).pop() || rows[0];
        niftyCache.ret = start && rows.length ? rows.at(-1).close / start.close - 1 : null;
        niftyCache.key = paper.startedAt;
        niftyCache.at = Date.now();
      }
      niftyRet = niftyCache.ret;
    } catch {
      niftyRet = null;
    }
  }
  let today = null;
  try {
    today = dayCheck ? await dayCheck() : await (await import('./trade-today.mjs')).tradeToday();
  } catch {
    today = null;
  }
  return foPlanFrom(paper, { niftyRet, today });
}
