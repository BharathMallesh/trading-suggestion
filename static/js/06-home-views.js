// 06-home-views.js — Analyse today; tabs and sub-tabs (views).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Analyse today ---
async function scanRun() {
  $('scanBtn').disabled = true;
  $('scanOut').innerHTML = '<div class="note">Scanning the NIFTY 50 stocks (10–20 seconds)…</div>';
  try {
    const d = await api('/api/today-scan');
    const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
    const sg = (x, k = 2) => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(k) + '%');
    const chip = (l) => {
      const c = { strong: 'var(--up)', partial: 'var(--accent)', weak: 'var(--muted)', mixed: 'var(--muted)' }[l];
      const t = { strong: 'Strong: trend, daily trend and morning/NIFTY agree', partial: 'Partial: some agree', weak: 'Weak: only today’s trend', mixed: 'No clear trend' }[l];
      return `<span title="${t}" style="display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid ${c};color:${c};font-size:11px;font-weight:600">${l}</span>`;
    };
    const h = d.history;
    const lvl = h?.byLevel || {};
    let html = `<div style="font-size:14px"><b>${d.live ? 'Live' : 'Last session'} · ${esc(d.date)} · candles to ${esc(d.lastBar)}</b> · NIFTY trending <b style="color:${d.nifty.trend === 'up' ? 'var(--up)' : d.nifty.trend === 'down' ? 'var(--down)' : 'var(--muted)'}">${esc(d.nifty.trend)}</b> ·
      <span style="color:var(--up)">${d.counts.up} up</span> · <span style="color:var(--down)">${d.counts.down} down</span> · ${d.counts.mixed} mixed</div>`;
    if (h) html += `<div style="margin:10px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--warn);background:var(--soft);font-size:13px">
      <b>Will they keep going?</b> Over the last ${h.sessions} trading days (${h.stocks} stocks), at about ${esc(h.checkTime)}:
      strong trends kept going until 3:15 PM <b>${pc(lvl.strong?.continued)}</b> of the time (average further move ${sg(lvl.strong?.avgMovePct)}), partial ${pc(lvl.partial?.continued)}, weak ${pc(lvl.weak?.continued)}.
      <b>That is close to a coin flip (50%)</b>, and the average move is smaller than trading costs (about 0.1% a round trip). So "trending up" describes now, not the rest of the day.</div>`;
    const table = (rows, title, color) => !rows.length ? '' : `<div style="font-size:14px;margin-top:12px;color:${color}"><b>${title}</b> (${rows.length})</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Price</th><th>Today</th><th>Trend since</th><th>Alignment</th><th>Daily trend</th><th>Morning move</th><th>Past cases kept going*</th><th style="text-align:left">Strategy setup</th></tr></thead><tbody>${rows.map((x) =>
        `<tr><td style="text-align:left"><b>${esc(x.symbol.replace('.NS', ''))}</b>${x.video ? ' <span class="note" style="display:inline">video stock</span>' : ''}</td><td>${x.price.toFixed(1)}</td><td style="color:${(x.changePct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${sg(x.changePct)}</td><td>${esc(x.since)}</td><td>${chip(x.alignment)}</td><td>${esc(x.dailyTrend || '–')}</td><td>${sg(x.gapPct)}</td><td>${x.history ? pc(x.history.continued) : '–'}</td><td style="text-align:left">${x.setup ? `<b>${x.setup.side === 'long' ? 'Buy' : 'Short'} setup ${esc(x.setup.time)}</b>: entry ${x.setup.entry.toFixed(1)}, stop ${x.setup.stop.toFixed(1)}, target ${x.setup.target.toFixed(1)}` : x.trend === 'mixed' ? 'no trade (mixed)' : `wait for a pullback to the 20 MA (${x.trend === 'up' ? 'buys' : 'shorts'} only)`}</td></tr>`).join('')}</tbody></table></div>`;
    const setups = d.stocks.filter((x) => x.setup);
    if (setups.length) html += `<div style="margin-top:10px;font-size:13px"><b>Fresh strategy setups (last 15 minutes):</b> ${setups.map((x) => `${esc(x.symbol.replace('.NS', ''))} ${x.setup.side === 'long' ? 'buy' : 'short'} at ${x.setup.entry.toFixed(1)}`).join(' · ')}. Past signals like these ended in profit about 38% of the time.</div>`;
    html += table(d.stocks.filter((x) => x.trend === 'up'), 'Trending up now: above its 20-candle average and VWAP', 'var(--up)');
    html += table(d.stocks.filter((x) => x.trend === 'down'), 'Trending down now: below its 20-candle average and VWAP', 'var(--down)');
    const mixed = d.stocks.filter((x) => x.trend === 'mixed');
    if (mixed.length) html += `<div class="note" style="margin-top:10px"><b>No clear trend (${mixed.length}):</b> ${mixed.map((x) => esc(x.symbol.replace('.NS', ''))).join(', ')}</div>`;
    html += `<div class="note">* Share of past cases (same time of day, same alignment) where the stock was further in that direction at 3:15 PM. ${esc(d.note)}</div>`;
    $('scanOut').innerHTML = html;
  } catch (e) {
    $('scanOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('scanBtn').disabled = false;
  }
}
$('scanBtn').addEventListener('click', scanRun);

// --- Views (tabs): each card goes to the first tab whose pattern matches its title ---
const VIEWS = [
  { key: 'home', match: /^(Daily results|System check|Ask the app|Analyse today|Today)/, note: 'Home: see what each strategy did today, ask a question in plain English, analyse today’s market, and see alerts and data health.' },
  { key: 'trades', match: /^(Plan a trade|Trade journal|Price alerts)/, note: 'My trades: plan every trade before you place it (size, charges, rules), record it in your journal, get alerts at your stop and target, and stop for the day at your loss limit. The app never places orders.' },
  { key: 'portfolio', match: /^My portfolio/, note: 'My portfolio: the shares you own, tax if you sold today, tax harvesting, risk, and whether your trading beat NIFTY. Stored only on this Mac.' },
  { key: 'invest', match: /^(What to expect|Goal planner|Market tilts|Index-fund picker|Strategies)/, note: 'Investing: long-term money — what SIPs and lump sums have done, what to invest for a goal, which index fund kept the most, and market tilts.' },
  { key: 'options', match: /^(Call \/ Put payoff odds|Live candles|Big-move odds|Volatility check|Option calculator|Selling volatility)/, note: 'Options & risk: the real chance an option pays off, how big a move is likely, volatility, and the Call / Put prediction (labelled: not better than chance).' },
  { key: 'intraday', match: /^(Strategy comparison|Strong-stock swing|Same stocks every day|Breakfast strategy|NIFTY dip-buy)/, note: 'Trading strategies: four rule-based strategies, each with live signals, an honest backtest and a paper record. Pick one below. Paper only until they prove themselves.' },
  { key: 'lab', match: /./, note: 'Research lab: every other experiment, including the ones that found no edge (AI direction calls, Kronos / Chronos, option positioning…), plus market data and settings.' },
];
const OLD_VIEW = { money: 'home' }; // tab names before the split
const SUBS = { compare: /^Strategy comparison/, ath: /^Strong-stock swing/, vwap: /^Same stocks every day/, breakfast: /^Breakfast strategy/, dip: /^NIFTY dip-buy/ };
// order inside a tab (cards not listed keep page order, after these; "no edge" cards go last)
const ORDER = ['Daily results', 'System check', 'Ask the app', 'Analyse today', 'Today', 'Plan a trade', 'Trade journal', 'Price alerts', 'Call / Put payoff odds', 'Live candles', 'Big-move odds', 'Volatility check', 'Option calculator', 'Selling volatility', 'Strategy comparison', 'Strong-stock swing', 'Same stocks every day', 'Breakfast strategy', 'NIFTY dip-buy',
  'What to expect', 'Goal planner', 'Index-fund picker', 'Market tilts', 'Strategies', 'Market data', 'Ask (research', 'Prediction hit-rate', 'Stock ranking', 'Earnings', 'Paper portfolio', 'Model evaluation', 'Settings', 'Phone access'];
// Tools whose direction calls were tested and found no edge: labelled, and (except the Call/Put card) moved to the end of their view.
const NO_EDGE = /^(Paper-Bot|Candle AI read|Live candles|Foundation models|Direction over months|Options positioning|Same stocks every day|Breakfast strategy)/;
let noEdgeDone = false;
function markNoEdge() {
  if (noEdgeDone) return;
  noEdgeDone = true;
  const main = document.querySelector('main');
  for (const sec of [...document.querySelectorAll('main > section.card')]) {
    const t = sec.querySelector('h2')?.textContent.trim() || '';
    if (!NO_EDGE.test(t)) continue;
    const b = document.createElement('div');
    b.className = 'noEdge';
    b.style.cssText = 'margin:-4px 0 10px;padding:6px 10px;border-radius:8px;font-size:12px;background:var(--soft);color:var(--muted);border-left:3px solid var(--warn)';
    b.textContent = /^(Same stocks|Breakfast)/.test(t)
      ? 'Tested: loses money after costs so far; improvements not proven. Kept as a paper experiment, not for real trades.'
      : 'Tested: no reliable edge for up / down — the live scorecard and back-tests matched chance. Kept for curiosity and tracking, not for decisions.';
    sec.querySelector('h2').after(b);
    if (!/^Live candles/.test(t)) main.appendChild(sec); // keeps its listeners; last in whichever view (the Call/Put card stays where you put it)
  }
}
function tagViews() {
  markNoEdge();
  for (const sec of document.querySelectorAll('main > section.card')) {
    if (sec.dataset.view) continue;
    const t = sec.querySelector('h2')?.textContent.trim() || '';
    sec.dataset.view = VIEWS.find((x) => x.match.test(t)).key;
    const i = ORDER.findIndex((o) => t.startsWith(o));
    sec.style.order = i >= 0 ? i : sec.querySelector('.noEdge') ? 90 : 60;
  }
}
function showView(v) {
  v = OLD_VIEW[v] || v;
  if (!VIEWS.some((x) => x.key === v)) v = 'home';
  tagViews();
  // Trading strategies: one strategy at a time, chosen with the sub-tabs
  let sub = null;
  if (v === 'intraday') {
    try { sub = localStorage.getItem('strategySub'); } catch { /* default */ }
    if (!SUBS[sub]) sub = 'compare';
  }
  for (const sec of document.querySelectorAll('main > section.card')) {
    const t = sec.querySelector('h2')?.textContent.trim() || '';
    sec.style.display = sec.dataset.view === v && (!sub || SUBS[sub].test(t)) ? '' : 'none';
  }
  $('subTabs').hidden = v !== 'intraday';
  [...$('subTabs').children].forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  [...$('viewTabs').children].forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('viewNote').textContent = VIEWS.find((x) => x.key === v).note;
  try { localStorage.setItem('view', v); } catch { /* storage unavailable */ }
  if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`);
  LAZY_READY = true;
  runLazy(); // first view of a card: load its data now
}
$('viewTabs').addEventListener('click', (e) => {
  if (e.target.dataset?.view) {
    showView(e.target.dataset.view);
    window.scrollTo({ top: 0 });
  }
});
$('subTabs').addEventListener('click', (e) => {
  const k = e.target.dataset?.sub;
  if (!k) return;
  try { localStorage.setItem('strategySub', k); } catch { /* this view only */ }
  showView('intraday');
});
// a link like /#options opens that tab
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
let startView = location.hash.slice(1);
if (!VIEWS.some((x) => x.key === startView)) {
  try { startView = localStorage.getItem('view') || 'home'; } catch { startView = 'home'; }
}
showView(startView);
