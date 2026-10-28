// "Which stocks to invest in?" research agent (library), for "Ask the app".
// It checks the market with the app's TESTED tools only and returns facts and
// rule-based screens — never "buy this":
//   1. the long-term base: the index funds that kept investors the most
//   2. stocks that meet the strong-stock swing rules today (the one strategy
//      that passed honest testing), with entry level, stop, risk and sizing
//   3. risk facts for each name: chance of a big move, recent headlines
//   4. what to be careful with: names unusually likely to swing a lot
//   5. the market regime (crash brake) and what the paper records show
// Direction is not predicted (nothing in the app beat chance at that).
// Research / education only — not investment advice.

import { athSwingScan, activeRules, RULES as ATH_RULES, loadSurvivorship } from './ath-swing.mjs';
import { bigMove } from './big-move.mjs';
import { crashBrake } from './trend-history.mjs';
import { indexFunds } from './index-funds.mjs';
import { newsBrief } from './news.mjs';
import { loadJournal } from './journal.mjs';
import { compareStrategies } from './compare.mjs';
import { loadMomentum, loadMomentumPaper } from './momentum.mjs';

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const rsAmt = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const sym = (s) => s.replace('.NS', '');
const settle = async (p) => {
  try {
    return await p;
  } catch (err) {
    return { error: err.message };
  }
};

let scanCache = null; // the swing scan reads ~200 daily series: reuse it for 10 minutes
async function scan(scanFn) {
  if (scanFn !== athSwingScan) return scanFn({});
  if (!scanCache || Date.now() - scanCache.at > 600_000) scanCache = { at: Date.now(), data: await scanFn({}) };
  return scanCache.data;
}

/** Shares for a stop-based plan: risk ≤ `riskPct` of capital, position ≤ capital. */
export function sizeFor(close, stop, { capital, riskPct }) {
  const perShare = close - stop;
  if (!(perShare > 0) || !(close > 0)) return null;
  const qty = Math.max(0, Math.min(Math.floor((capital * riskPct) / 100 / perShare), Math.floor(capital / close)));
  return { qty, value: qty * close, riskRs: qty * perShare };
}

/** Ratio of the chance of a ±4% week now vs its usual level (1 = usual). */
function weekRisk(m) {
  const o = m?.horizons?.['5d']?.odds?.find((x) => x.movePct === 4);
  return o && o.pastYear ? { now: o.prob, usual: o.pastYear, ratio: o.prob / o.pastYear } : null;
}

/**
 * The research answer (assistant format: title, summary, sections, caveat).
 * Injectable sources for tests.
 */
export async function investResearch({
  scanFn = athSwingScan, moveFn = bigMove, brakeFn = crashBrake, fundsFn = indexFunds, newsFn = (s) => newsBrief(s, { useLlm: false }),
  sizing = loadJournal().settings, compare = () => compareStrategies(), maxNames = 8, momentum = () => ({ test: loadMomentum(), paper: loadMomentumPaper() }),
} = {}) {
  const [sc, cb, funds] = await Promise.all([settle(scan(scanFn)), settle(brakeFn({})), settle(fundsFn({}))]);
  const triggered = sc.error ? [] : (sc.triggered || []).filter((t) => !t.held);
  const held = sc.error ? [] : (sc.triggered || []).filter((t) => t.held).map((t) => sym(t.symbol));
  const strong = sc.error ? [] : (sc.strong || []).filter((x) => !triggered.some((t) => t.symbol === x.symbol)).slice(0, Math.max(0, maxNames - triggered.length));
  const names = [...triggered.map((t) => t.symbol), ...strong.map((x) => x.symbol)].slice(0, maxNames);
  const moves = new Map((await Promise.all(names.map(async (s) => [s, await settle(moveFn({ symbol: s }))]))));
  const news = new Map((await Promise.all(triggered.slice(0, 5).map(async (t) => [t.symbol, await settle(newsFn(t.symbol))]))));
  const capital = Number(sizing?.capital) || 100000;
  const riskPct = Number(sizing?.riskPct) || 1;
  const careful = names.filter((s) => (weekRisk(moves.get(s))?.ratio ?? 1) >= 1.5);

  // what the paper records and tests say, from the comparison
  const cmp = await settle(Promise.resolve().then(compare));
  const swingRow = cmp.rows?.find((r) => r.key === 'ath');
  const sv = loadSurvivorship();
  const wide = sv?.results?.wide;

  const summary = [
    cb.error ? null : `Market regime (crash brake): ${cb.state === 'out' ? 'OUT — NIFTY is below its long-term trend; the tested rule would hold cash/bonds' : cb.state === 'in' ? 'IN — NIFTY is above its long-term trend' : 'unchanged'}. ${cb.reading || ''}`.trim(),
    'Long-term base: a low-cost NIFTY 50 index fund held 10+ years beat every trading strategy in this app after tax. Start there (table below).',
    'Tested stock screen: the Momentum 20 list (the stocks that rose most over 6 and 12 months, refreshed monthly) beat NIFTY in its survivorship-free test — table below. It is a screen with a record, not a prediction.',
    triggered.length
      ? `${triggered.length} stock${triggered.length > 1 ? 's' : ''} met the strong-stock swing rules at the latest close: ${triggered.map((t) => sym(t.symbol)).join(', ')}. These are rule-based screens, not predictions — about 6 in 10 such trades lose; the winners are bigger than the losers.`
      : 'No stock met the strong-stock swing rules at the latest close. Waiting is a valid choice; the strategy only trades when its setup appears.',
    held.length ? `Signalled again but already held on paper: ${held.join(', ')}.` : null,
    careful.length ? `Be careful with ${careful.map(sym).join(', ')}: unusually likely to move 4%+ this week (higher risk either way, not an opportunity).` : null,
    `Sizing uses your My trades settings: ₹${capital.toLocaleString('en-IN')} capital, ${riskPct}% risk per trade.`,
  ].filter(Boolean);

  const sections = [];
  if (!funds.error && funds.categories) {
    const rows = [];
    for (const c of Object.values(funds.categories).slice(0, 3)) for (const f of c.funds.slice(0, 2)) rows.push([c.label, f.name, f.type, pct(f.r3, 2), pct(f.gap3, 2)]);
    if (rows.length) sections.push({ heading: '1. Long-term base: index funds that kept investors the most (3 years)', kind: 'table', columns: ['Index', 'Fund', 'Type', '3y / yr', 'Gap to best'], rows, note: 'Funds on the same index should earn the same; the gap is what costs and tracking took. Any of the top few is fine.' });
  }
  // the monthly momentum screen (passed its survivorship-free test)
  const mom = (() => {
    try {
      return momentum();
    } catch {
      return null;
    }
  })();
  if (mom?.paper?.list?.length) {
    const t = mom.test;
    sections.push({
      heading: `Momentum 20: this month's list (ranked at the ${mom.paper.monthEnd} close — a tested screen, not a pick)`, kind: 'table',
      columns: ['#', 'Stock', '12-month change', 'Yearly volatility', `≈ amount each (₹${capital.toLocaleString('en-IN')} / 20)`],
      rows: mom.paper.list.slice(0, 20).map((x) => [x.rank, sym(x.symbol), `${x.ret12 >= 0 ? '+' : ''}${(x.ret12 * 100).toFixed(0)}%`, x.vol != null ? `${(x.vol * 100).toFixed(0)}%` : '–', rsAmt(capital / 20)]),
      note: t ? `${t.passed ? 'Passed' : 'Did not pass'} its survivorship-free test: ${pct(t.methods[t.chosen].cagr)} a year (${pct(t.methods[t.chosen].cagrAfterTax)} after tax) vs NIFTY ${pct(t.index.cagr)} (${pct(t.index.cagrAfterTax)}), worst fall ${pct(t.methods[t.chosen].maxDrawdown, 0)}, with bad years (e.g. 2025). Expect less in practice; a momentum index fund does a similar job with less effort. Full record: Investing → Momentum 20.` : 'Full record: Investing → Momentum 20.',
    });
  }
  if (triggered.length) {
    sections.push({
      heading: '2. Stocks that met the strong-stock swing rules today (screen, not a pick)', kind: 'table',
      columns: ['Stock', 'Setup', 'Close', 'Stop (exit if hit)', 'Risk to stop', `Shares at ${riskPct}% risk`, 'Chance of a ±4% week', 'Headlines'],
      rows: triggered.map((t) => {
        const z = sizeFor(t.close, t.stop, { capital, riskPct });
        const w = weekRisk(moves.get(t.symbol));
        const n = news.get(t.symbol);
        return [sym(t.symbol), t.setup, `₹${t.close.toFixed(1)}`, `₹${t.stop.toFixed(1)}`, `${t.riskPct.toFixed(1)}%`, z ? `${z.qty} (${rsAmt(z.value)}, risk ${rsAmt(z.riskRs)})` : '–', w ? `${pct(w.now, 0)} (usual ${pct(w.usual, 0)})` : '–', n?.headlines?.length ? n.headlines.slice(0, 2).map((h) => h.title).join(' · ') : '–'];
      }),
      note: 'The rules buy at the next open with this stop and then follow a trailing stop. Open Trading strategies → Strong-stock swing → "Plan this trade" to see exact shares and charges.',
    });
  }
  if (strong.length) {
    sections.push({
      heading: `${triggered.length ? '3' : '2'}. Strong stocks to watch (near their all-time high, no setup yet)`, kind: 'table',
      columns: ['Stock', 'Close', 'Below all-time high', 'Weekly RSI', 'Chance of a ±4% week'],
      rows: strong.map((x) => {
        const w = weekRisk(moves.get(x.symbol));
        return [sym(x.symbol), `₹${x.close.toFixed(1)}`, `${x.fromAthPct.toFixed(1)}%`, x.weeklyRsi?.toFixed(0) ?? '–', w ? `${pct(w.now, 0)} (usual ${pct(w.usual, 0)})` : '–'];
      }),
      note: 'Strength alone is not a buy signal; the tested rules wait for a base or flag breakout.',
    });
  }
  sections.push({
    heading: 'What the tests and paper records say', kind: 'list',
    items: [
      swingRow ? `Strong-stock swing: ${swingRow.backtest}.` : null,
      !swingRow && wide ? `Wide-trail version (paper): ${pct(wide.portfolioCagr)} a year (${pct(wide.portfolioCagrAfterTax)} after tax) in the survivorship-free test, vs NIFTY ${pct(sv.index?.cagr)} — not statistically proven.` : null,
      'YouTube intraday, Breakfast, F&O option selling and spreads: lost money after charges in testing or on paper. Not used here.',
      'Predicting up / down (AI models, Kronos, Chronos, the Call/Put model): no better than chance — so this answer never says a stock will rise.',
    ].filter(Boolean),
  });
  if (sc.error) sections.push({ heading: 'Swing screen unavailable', kind: 'text', text: `The daily scan could not run (${sc.error}). Try again in a minute.` });

  return {
    intent: 'invest',
    title: `Research check — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}`,
    summary, sections,
    caveat: 'Facts and rule-based screens from the app\'s tested tools, not advice or a recommendation to buy. Most of your money is best in a low-cost index fund; size any single trade so a stop-out costs about 1% of your capital. Decide yourself — or with a SEBI-registered adviser.',
    rulesInUse: activeRules() !== ATH_RULES ? 'improved' : 'original',
  };
}
