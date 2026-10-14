// "Ask the app": answers plain-language questions in the UI with the app's
// VALIDATED tools only. Deterministic (no AI needed): recognises the intent and
// the stock, gathers the facts, and returns a structured answer.
//   "which is the best stock to invest today?" → today's briefing
//   "tell me about reliance" / "what will happen to TCS" → stock report
//   "nifty call put this week" / "options on infy" → option odds
//   "which index fund" → index-fund picker summary · "sip for 50 lakh" → goal planner hint
// Honesty rule built in: the app has no direction skill (tested from 30 minutes
// to 3 years), so answers never say buy / sell / Call / Put or "will go up".
// Research / education only — not investment advice.

import { quote, candles } from '../market-data.mjs';
import { bigMove } from './big-move.mjs';
import { volCheck } from './volatility.mjs';
import { optionOdds } from './option-odds.mjs';
import { crashBrake } from './trend-history.mjs';
import { newsBrief, ALIASES } from './news.mjs';
import { loadIndexList } from './ranking.mjs';
import { liveScorecard } from './prediction-log.mjs';
import { loadCalibration } from './calibration.mjs';
import { loadHoldings } from './holdings.mjs';
import { indexFunds } from './index-funds.mjs';
import { badRequest } from '../util.mjs';
import { todaySignals, paperSummary } from './vwap-pullback.mjs';
import { oddsFor, loadOdds } from './vwap-odds.mjs';

// Common names → NSE symbols (in addition to the NIFTY 500 tickers themselves).
const NAMES = {
  'nifty 50': '^NSEI', nifty: '^NSEI', sensex: '^BSESN', 'bank nifty': '^NSEBANK', banknifty: '^NSEBANK',
  reliance: 'RELIANCE', ril: 'RELIANCE', infosys: 'INFY', tcs: 'TCS', 'tata consultancy': 'TCS', 'hdfc bank': 'HDFCBANK', hdfc: 'HDFCBANK',
  'icici bank': 'ICICIBANK', icici: 'ICICIBANK', sbi: 'SBIN', 'state bank': 'SBIN', airtel: 'BHARTIARTL', 'bharti airtel': 'BHARTIARTL',
  itc: 'ITC', 'l&t': 'LT', 'larsen': 'LT', 'larsen & toubro': 'LT', maruti: 'MARUTI', 'maruti suzuki': 'MARUTI', titan: 'TITAN', trent: 'TRENT',
  'bajaj finance': 'BAJFINANCE', 'bajaj finserv': 'BAJAJFINSV', 'kotak bank': 'KOTAKBANK', kotak: 'KOTAKBANK', 'axis bank': 'AXISBANK', axis: 'AXISBANK',
  wipro: 'WIPRO', 'hcl tech': 'HCLTECH', hcl: 'HCLTECH', 'tech mahindra': 'TECHM', 'tata motors': 'TATAMOTORS', 'tata steel': 'TATASTEEL',
  'sun pharma': 'SUNPHARMA', 'asian paints': 'ASIANPAINT', hul: 'HINDUNILVR', 'hindustan unilever': 'HINDUNILVR', nestle: 'NESTLEIND',
  ongc: 'ONGC', ntpc: 'NTPC', 'power grid': 'POWERGRID', 'coal india': 'COALINDIA', 'adani enterprises': 'ADANIENT', 'adani ports': 'ADANIPORTS',
  'ultratech': 'ULTRACEMCO', 'mahindra': 'M&M', 'm&m': 'M&M', 'hero motocorp': 'HEROMOTOCO', eicher: 'EICHERMOT', 'dr reddy': 'DRREDDY',
  cipla: 'CIPLA', 'apollo hospitals': 'APOLLOHOSP', indusind: 'INDUSINDBK', zomato: 'ETERNAL', eternal: 'ETERNAL', paytm: 'PAYTM', irctc: 'IRCTC',
  'bharat electronics': 'BEL', hal: 'HAL', jio: 'JIOFIN', 'jio financial': 'JIOFIN', dmart: 'DMART', 'avenue supermarts': 'DMART',
};
for (const [sym, name] of Object.entries(ALIASES)) NAMES[name.toLowerCase()] = NAMES[name.toLowerCase()] || sym;

const STOP = new Set(['A', 'I', 'IS', 'IT', 'ON', 'OF', 'TO', 'THE', 'AND', 'FOR', 'ME', 'MY', 'WHAT', 'WILL', 'TELL', 'ABOUT', 'BUY', 'SELL', 'CALL', 'PUT', 'BEST', 'STOCK', 'TODAY', 'NOW', 'IN', 'BE', 'DO', 'HOW', 'WHICH', 'WEEK', 'THIS', 'SHOULD', 'CAN', 'HAPPEN', 'INVEST', 'OPTION', 'OPTIONS', 'STRATEGY', 'SIGNAL', 'SIGNALS', 'PAPER', 'SCANNER', 'ANY', 'DID', 'GO', 'VWAP', 'SETUP']);

let universe = null; // NIFTY 500 tickers (cached per process)
async function tickers() {
  if (!universe) {
    try {
      universe = new Set((await loadIndexList('nifty500')).symbols.map((s) => s.replace(/\.NS$/, '')));
    } catch {
      universe = new Set();
    }
  }
  return universe;
}

/** Find the stock (or index) a question is about. */
export async function resolveSymbol(question) {
  const q = ` ${String(question).toLowerCase().replace(/[^a-z0-9&.^ ]/g, ' ').replace(/\s+/g, ' ')} `;
  const explicit = String(question).match(/\b([A-Za-z0-9&-]{1,20}\.(NS|BO))\b/i) || String(question).match(/(\^[A-Za-z]{2,12})/);
  if (explicit) return explicit[1].toUpperCase();
  // longest name first so "hdfc bank" beats "hdfc"
  for (const name of Object.keys(NAMES).sort((a, b) => b.length - a.length)) {
    if (q.includes(` ${name} `)) {
      const s = NAMES[name];
      return s.startsWith('^') ? s : `${s}.NS`;
    }
  }
  const set = await tickers();
  for (const tok of String(question).toUpperCase().split(/[^A-Z0-9&-]+/)) {
    if (tok.length >= 2 && !STOP.has(tok) && set.has(tok)) return `${tok}.NS`;
  }
  return null;
}

/** What is the user asking for? */
export function detectIntent(question, symbol) {
  const q = String(question).toLowerCase();
  if (/\b(index fund|etf|mutual fund|which fund)\b/.test(q)) return 'funds';
  if (/\b(sip|goal|target|lakh|crore|retire)\b/.test(q) && !symbol) return 'goal';
  if (/\b(strategy|vwap|pullback|signals?|paper (trade|trades|record)|scanner|setup|intraday trade)\b/.test(q)) return 'strategy';
  if (/\b(call|put|option|options|ce|pe|straddle)\b/.test(q)) return 'options';
  if (symbol) return 'stock';
  if (/\b(best|invest|buy|which stock|stocks|today|market|briefing|tomorrow|week)\b/.test(q)) return 'briefing';
  return 'help';
}

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const settle = async (p) => {
  try {
    return await p;
  } catch (err) {
    return { error: err.message };
  }
};
const atmStrike = (spot, sym) => {
  const step = sym === '^NSEI' ? 50 : sym === '^NSEBANK' || sym === '^BSESN' ? 100 : spot > 5000 ? 50 : spot > 1000 ? 20 : spot > 250 ? 5 : 1;
  return Math.round(spot / step) * step;
};

function rangeText(price, lo, hi) {
  const at = hi > lo ? Math.min(1, Math.max(0, (price - lo) / (hi - lo))) : 0.5;
  if (at <= 0.02) return `at its 52-week low (₹${lo.toFixed(0)}; high ₹${hi.toFixed(0)})`;
  if (at >= 0.98) return `at its 52-week high (₹${hi.toFixed(0)}; low ₹${lo.toFixed(0)})`;
  return `${(at * 100).toFixed(0)}% of the way from its 52-week low (₹${lo.toFixed(0)}) to high (₹${hi.toFixed(0)})`;
}
const label = (s) => (s === '^NSEI' ? 'NIFTY 50' : s === '^BSESN' ? 'Sensex' : s === '^NSEBANK' ? 'Bank NIFTY' : s.replace('.NS', ''));

const NO_DIRECTION = 'The app does not say whether it will go up or down: tested from 30 minutes to 3 years, nothing predicted direction better than chance (see the Call/Put card\'s live scorecard). Use these facts for risk and sizing, not as a buy / sell signal.';

function oddsRows(bm) {
  const o = (h, k) => bm.horizons?.[h]?.odds?.find((x) => x.movePct === k);
  return [['Next session: move > ±1%', o('1d', 1)], ['Next session: move > ±2%', o('1d', 2)], ['Next week: move > ±4%', o('5d', 4)]]
    .filter(([, x]) => x).map(([label, x]) => [label, pct(x.prob), pct(x.pastYear), x.pastYear ? `${(x.prob / x.pastYear).toFixed(1)}×` : '–']);
}

// ------------------------------------------------------------- briefing ---

export async function briefing({ symbols }) {
  const [cb, vc, card, nq] = await Promise.all([
    settle(crashBrake({})),
    settle(volCheck({ symbol: '^NSEI', days: 7 })),
    settle(Promise.resolve(liveScorecard(null))),
    settle(quote('^NSEI')),
  ]);
  const list = ['^NSEI', ...symbols];
  const moves = await Promise.all(list.map((s) => settle(bigMove({ symbol: s }))));
  const rows = moves.map((m, i) => {
    if (m.error) return [list[i], '–', '–', '–'];
    const o = (h, k) => m.horizons[h].odds.find((x) => x.movePct === k);
    const n2 = o('1d', 2);
    const w4 = o('5d', 4);
    return [label(m.symbol), `${pct(n2.prob)} (usual ${pct(n2.pastYear)})`, `${pct(w4.prob)} (usual ${pct(w4.pastYear)})`, m.eventPending ? 'results due' : '', w4.pastYear ? w4.prob / w4.pastYear : 1];
  });
  const hot = rows.filter((r) => r[4] >= 1.5).map((r) => r[0]);
  let opts = [];
  if (!nq.error) {
    const K = atmStrike(nq.price, '^NSEI');
    opts = await Promise.all(['CE', 'PE'].map((t) => settle(optionOdds({ symbol: '^NSEI', type: t, strike: K, days: 7 }))));
  }
  const summary = [
    cb.error ? null : `Crash brake ${cb.state === 'out' ? 'OFF' : cb.state === 'in' ? 'ON (invested)' : 'unchanged'}: ${cb.reading}`,
    vc.error ? null : `NIFTY volatility: ${vc.reading}`,
    hot.length ? `Unusually likely to swing a lot this week: ${hot.join(', ')} — higher risk either way, not an opportunity.` : 'No watchlist stock is unusually risky right now (none at 1.5× its usual chance of a big move).',
    opts.length && !opts[0].error ? `NIFTY weekly at-the-money Call: ${pct(opts[0].probProfit.forecastHistory ?? opts[0].probProfit.forecastNormal, 0)} chance of ending profitable; Put: ${pct(opts[1].probProfit.forecastHistory ?? opts[1].probProfit.forecastNormal, 0)}. Option buyers usually win about 1 time in 3.`
      : null,
    'For long-term investing, the evidence favours a low-cost index fund held 10+ years — see "Index-fund picker" and "Goal planner" in the Investing tab.',
  ].filter(Boolean);
  return {
    intent: 'briefing',
    title: `Today's briefing — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}`,
    summary,
    sections: [
      { heading: 'Chance of a big move (either direction)', kind: 'table', columns: ['Stock', 'Move > ±2% next session', 'Move > ±4% next week', 'Events'], rows: rows.map((r) => r.slice(0, 4)) },
      opts.length && !opts[0].error ? {
        heading: `NIFTY weekly options (strike ${opts[0].strike}, ${opts[0].days} days)`, kind: 'table', columns: ['Option', 'Premium (est.)', 'Breakeven', 'Chance profitable at expiry'],
        rows: opts.map((o) => [o.type === 'CE' ? 'Call' : 'Put', `₹${o.premium.toFixed(0)}`, o.breakeven.toFixed(0), pct(o.probProfit.forecastHistory ?? o.probProfit.forecastNormal, 0)]),
      } : null,
      card.error ? null : { heading: 'Why there is no "buy this" list', kind: 'text', text: `The Call/Put card's live record: ${card.scored} scored predictions; ${card.verdict}` },
    ].filter(Boolean),
    caveat: NO_DIRECTION,
  };
}

// ---------------------------------------------------------- stock report ---

export async function stockReport(symbol) {
  const isIndex = symbol.startsWith('^');
  const [q, bm, vc, daily, news] = await Promise.all([
    settle(quote(symbol)),
    settle(bigMove({ symbol })),
    settle(volCheck({ symbol, days: 7 })),
    settle(candles(symbol, { range: '1y', interval: '1d' })),
    isIndex ? Promise.resolve(null) : settle(newsBrief(symbol, { useLlm: false })),
  ]);
  if (q.error) throw badRequest(`Couldn't find "${symbol}". Try the NSE ticker, e.g. RELIANCE or HDFCBANK.`);
  let eventPending = !!news?.events?.includes('results');
  const bm2 = eventPending && !bm.error ? await settle(bigMove({ symbol, eventPending: true })) : bm;
  const K = atmStrike(q.price, symbol);
  const opts = await Promise.all(['CE', 'PE'].map((t) => settle(optionOdds({ symbol, type: t, strike: K, days: 7, eventPending }))));
  const rows = Array.isArray(daily) ? daily : [];
  const closes = rows.map((r) => r.close);
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  const ret1y = closes.length > 200 ? closes[closes.length - 1] / closes[0] - 1 : null;
  const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  const cal = loadCalibration();
  const clim = cal['1d']?.climatology;
  const base = clim ? { up: (clim.probUp + clim.probDown) / 2, side: clim.probSideways } : null;
  const held = loadHoldings().lots.filter((l) => l.symbol === symbol);
  const heldQty = held.reduce((a, l) => a + l.qty, 0);
  const heldCost = held.reduce((a, l) => a + l.qty * l.price, 0);
  const n2 = bm2.horizons?.['1d']?.odds?.find((x) => x.movePct === 2);
  const summary = [
    `${q.name || symbol} at ₹${q.price?.toFixed(2)} (${q.previousClose ? `${q.price >= q.previousClose ? '+' : ''}${(((q.price - q.previousClose) / q.previousClose) * 100).toFixed(2)}% today` : ''}).`,
    ret1y != null ? `Past year: ${ret1y >= 0 ? '+' : ''}${(ret1y * 100).toFixed(1)}%; ${rangeText(q.price, lo, hi)}${sma200 ? `; ${q.price > sma200 ? 'above' : 'below'} its 200-day average` : ''}.` : null,
    n2 ? `Chance of a move bigger than ±2% next session: ${pct(n2.prob)} (usual ${pct(n2.pastYear)})${n2.pastYear && n2.prob / n2.pastYear >= 1.5 ? ' — higher than usual, expect bigger swings' : ''}.` : null,
    eventPending ? 'Results / earnings news in the headlines — moves around results are larger and can go either way.' : null,
    vc.error || vc.impliedPct == null ? null : vc.reading,
    base ? `Up / down / sideways next session: about ${pct(base.up, 0)} / ${pct(base.up, 0)} / ${pct(base.side, 0)} — the historical base rates; the app has no edge on direction.` : null,
    heldQty ? `You hold ${heldQty} shares (cost ₹${Math.round(heldCost).toLocaleString('en-IN')}, now ₹${Math.round(heldQty * q.price).toLocaleString('en-IN')}) — see My portfolio for tax and risk.` : null,
  ].filter(Boolean);
  const sections = [];
  if (!bm2.error) sections.push({ heading: 'How much it could move', kind: 'table', columns: ['Measure', 'Chance now', 'Usual (past year)', 'vs usual'], rows: oddsRows(bm2) });
  if (!opts.some((o) => !o.error) && !isIndex) {
    sections.push({ heading: 'Options', kind: 'text', text: 'No live implied volatility for this stock (needs the Groww Trading API), so option premiums can\'t be estimated. Enter the real premium from your broker in "Call / Put payoff odds" to get the chance of profit.' });
  }
  if (opts.some((o) => !o.error)) {
    sections.push({
      heading: `Options this week (strike ${K}, ${opts.find((o) => !o.error)?.days ?? 7} days)`,
      kind: 'table', columns: ['Option', 'Premium (est.)', 'Breakeven', 'Chance profitable at expiry'],
      rows: opts.filter((o) => !o.error).map((o) => [o.type === 'CE' ? 'Call' : 'Put', `₹${o.premium.toFixed(1)}`, o.breakeven.toFixed(1), pct(o.probProfit.forecastHistory ?? o.probProfit.forecastNormal, 0)]),
      note: 'Premiums are estimated from volatility — enter your broker\'s real premium in "Call / Put payoff odds" for exact odds. Stock options are less liquid with big lot sizes.',
    });
  }
  if (!vc.error) sections.push({ heading: 'Volatility', kind: 'kv', rows: [['Forecast (annual)', `${vc.forecastPct?.toFixed(1)}% (${vc.model})`], ['Implied', vc.impliedPct != null ? `${vc.impliedPct.toFixed(1)}% (${vc.impliedSource})` : 'not available (enter the option IV in Volatility check)'], ['Expected ±1σ move over 7 days', `${vc.expectedMovePct?.forecast?.toFixed(2)}%`]] });
  if (news && !news.error && news.headlines?.length) sections.push({ heading: 'Recent headlines', kind: 'list', items: news.headlines.slice(0, 5).map((h) => `${h.title}${h.source ? ` — ${h.source}` : ''}`) });
  return { intent: 'stock', symbol, title: `${q.name || symbol} (${symbol.replace('.NS', '')})`, summary, sections, caveat: NO_DIRECTION };
}

// ---------------------------------------------------------- other intents ---

export async function optionsAnswer(symbol = '^NSEI') {
  const q = await quote(symbol);
  const K = atmStrike(q.price, symbol);
  const opts = await Promise.all(['CE', 'PE'].map((t) => settle(optionOdds({ symbol, type: t, strike: K, days: 7 }))));
  const ok = opts.filter((o) => !o.error);
  if (!ok.length) {
    return {
      intent: 'options', symbol, title: `${label(symbol)} options`,
      summary: [`No live implied volatility for ${label(symbol)} (that needs the Groww Trading API), so the option premium can't be estimated here.`, 'Open "Call / Put payoff odds", enter the strike and the premium your broker shows, and it will give the real chance of ending profitable and the breakeven.'],
      sections: [], caveat: NO_DIRECTION,
    };
  }
  return {
    intent: 'options', symbol, title: `${label(symbol)} options this week`,
    summary: [
      `At-the-money strike ${K}. Call: ${pct(ok[0].probProfit.forecastHistory ?? ok[0].probProfit.forecastNormal, 0)} chance of ending profitable (breakeven ${ok[0].breakeven.toFixed(0)}).${ok[1] ? ` Put: ${pct(ok[1].probProfit.forecastHistory ?? ok[1].probProfit.forecastNormal, 0)} (breakeven ${ok[1].breakeven.toFixed(0)}).` : ''}`,
      'Both are typically about 1 in 3 for buyers. Selling options wins more often but can lose many weeks of profit in one week — on real NSE prices neither side showed a reliable edge after costs.',
    ],
    sections: [{ heading: 'Odds', kind: 'table', columns: ['Option', 'Premium (est.)', 'Breakeven', 'Chance profitable'], rows: ok.map((o) => [o.type === 'CE' ? 'Call' : 'Put', `₹${o.premium.toFixed(1)}`, o.breakeven.toFixed(1), pct(o.probProfit.forecastHistory ?? o.probProfit.forecastNormal, 0)]) }],
    caveat: NO_DIRECTION,
  };
}

export async function fundsAnswer() {
  const r = await indexFunds({});
  const sections = Object.values(r.categories).map((c) => ({
    heading: `${c.label}: best 3 by what investors actually got (3 years)`, kind: 'table', columns: ['Fund', 'Type', '3y / yr', 'Gap to best', 'Tracking error'],
    rows: c.funds.slice(0, 3).map((f) => [f.name, f.type, pct(f.r3, 2), pct(f.gap3, 2), pct(f.te, 2)]),
  }));
  return { intent: 'funds', title: 'Index funds', summary: ['Funds on the same index should return the same; the gap to the best is what costs and tracking took. The top few are within a few hundredths of a percent — any of them is fine. Full list in "Index-fund picker" (Investing tab).'], sections, caveat: 'Not a recommendation of any fund; check the expense ratio and (for ETFs) trading liquidity.' };
}

const rs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

/** "How did the strategy do today?" / "Any signal on Trent?" — the VWAP pullback paper versions. */
export async function strategyAnswer(symbol = null, { loadSignals = todaySignals, loadPaper = paperSummary, odds = loadOdds() } = {}) {
  const [live, paper] = await Promise.all([loadSignals({ oddsLookup: (t) => oddsFor(t, odds) }), Promise.resolve(loadPaper())]);
  const when = live.date ? `${live.live ? 'today so far' : `on ${live.date}`} (candles to ${live.lastBar})` : 'now';
  const summary = [];
  for (const v of Object.values(live.variants || {})) {
    const tr = symbol ? v.trades.filter((t) => t.symbol === symbol) : v.trades;
    const name = v.label.split(':')[0].replace(/ \(.*$/, '');
    summary.push(tr.length
      ? `${name}: ${tr.map((t) => `${t.symbol.replace('.NS', '')} ${t.side} at ${t.time} (${t.open ? 'open' : t.reason}) ${rs(t.net)}${t.odds ? `, chance at entry ${Math.round(t.odds.prob * 100)}%${t.odds.adjusted ? '' : ' (average of past signals)'}` : ''}`).join('; ')}.`
      : `${name}: no trade${symbol ? ` on ${label(symbol)}` : ''} ${when}.`);
  }
  if (odds?.model) summary.push(`Past signals: ${Math.round(odds.model.base * 100)}% of ${odds.signals} ended in profit after costs (break-even needs about 38–40%). ${odds.adopted ? 'Odds above are adjusted for today\'s conditions.' : 'Adjusting for conditions did not beat that average on unseen days, so every signal gets the same odds.'}`);
  const sections = [];
  const stocks = (live.stocks || []).filter((x) => (symbol ? x.symbol === symbol : x.video || x.inPlay));
  if (symbol && !stocks.length) summary.unshift(`${label(symbol)} is not on the strategy's lists (the 4 video stocks + 20 scanner stocks), so it has no signals.`);
  if (stocks.length) {
    sections.push({
      heading: `Position vs 20 MA and VWAP ${when}`, kind: 'table', columns: ['Stock', 'Price', '20 MA', 'VWAP', 'Trend', 'Daily trend', 'Move by 09:30'],
      rows: stocks.map((x) => [x.symbol.replace('.NS', ''), x.price.toFixed(1), x.ma?.toFixed(1) ?? '–', x.vwap.toFixed(1), x.trend === 'up' ? 'above both (longs only)' : x.trend === 'down' ? 'below both (shorts only)' : 'mixed (no trade)', x.dailyTrend || '–', x.gapPct == null ? '–' : `${x.gapPct >= 0 ? '+' : ''}${x.gapPct.toFixed(2)}%`]),
    });
  }
  const pv = Object.values(paper.byVariant || {});
  if (pv.length) {
    sections.push({
      heading: `Paper record since ${paper.startedAt || '–'}: can we trust it yet?`, kind: 'table', columns: ['Version', 'Trades', 'Avg after costs', 'Verdict'],
      rows: pv.map((v) => [v.label.split(':')[0].replace(/ \(.*$/, ''), String(v.trades || 0), v.trades ? rs(v.avgNetRs) : '–', v.trust?.verdict || '–']),
    });
  }
  return {
    intent: 'strategy', symbol, title: symbol ? `${label(symbol)} in the VWAP pullback strategy` : 'VWAP pullback strategy',
    summary, sections,
    caveat: 'Paper simulation of the Dhan video strategy. The backtest lost money after costs and no improvement is proven yet — not a signal to trade.',
  };
}

export function helpAnswer() {
  return {
    intent: 'help', title: 'What you can ask',
    summary: ['Try: "Which is the best stock to invest today?", "Tell me about Reliance", "What will happen to TCS?", "NIFTY call put this week", "Options on INFY", "Which index fund?", "How did the strategy do today?", "Any signal on Trent?"', 'New to all this? Open "Help & guide" at the top of the page: it explains every card and word step by step.'],
    sections: [], caveat: NO_DIRECTION,
  };
}

/** Entry point for POST /api/assistant. */
export async function ask(question, { symbols = [] } = {}) {
  const q = String(question || '').trim();
  if (!q) throw badRequest('Type a question, e.g. "Tell me about Reliance".');
  if (q.length > 300) throw badRequest('Please keep the question under 300 characters.');
  const symbol = await resolveSymbol(q);
  const intent = detectIntent(q, symbol);
  if (intent === 'strategy') return strategyAnswer(symbol && symbol !== '^NSEI' ? symbol : null);
  if (intent === 'stock') return stockReport(symbol);
  if (intent === 'options') return optionsAnswer(symbol || '^NSEI');
  if (intent === 'funds') return fundsAnswer();
  if (intent === 'goal') return { intent: 'goal', title: 'Goal planner', summary: ['Open the Investing tab → "Goal planner": enter your target, years and planned SIP to see what worked in every past start month.'], sections: [], caveat: 'Past ranges, not a promise.' };
  if (intent === 'briefing') return briefing({ symbols });
  return helpAnswer();
}
