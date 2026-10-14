// 10-lab.js — Paper portfolio, settings, events, strategies, Today card, news brief, FII test, model evaluation.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Paper portfolio ---
function renderPortfolio(d) {
  const money = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const col = (v) => (v >= 0 ? 'var(--up)' : 'var(--down)');
  let html = '';
  if (d.actions?.length) {
    html += '<div style="font-size:13px;margin-bottom:8px"><b>Today\'s actions</b><ul style="margin:6px 0 0 18px">';
    for (const a of d.actions) {
      const tag = a.action === 'buy' ? `<b style="color:var(--up)">BUY</b> ${a.qty} @ ${Number(a.price).toFixed(2)} (stop ${a.stop?.toFixed(2) ?? '–'}, target ${a.target?.toFixed(2) ?? '–'})`
        : a.action === 'close' ? `<b style="color:var(--down)">SELL</b> @ ${Number(a.price).toFixed(2)} · PnL <span style="color:${col(a.pnl)}">${money(a.pnl)}</span>`
        : esc(a.action);
      html += `<li>${esc(a.symbol)} — ${tag} · news ${sentimentBadge(a.news)} <span style="color:var(--muted)">${esc((a.reason || '').slice(0, 90))}</span></li>`;
    }
    html += '</ul></div>';
  }
  html += `<div class="kv">
    <div>Equity</div><div><b>${money(d.equity)}</b> <span style="color:${col(d.returnPct)}">(${d.returnPct >= 0 ? '+' : ''}${Number(d.returnPct).toFixed(2)}%)</span></div>
    <div>Cash</div><div>${money(d.cash)}</div>
    <div>Realised P&amp;L</div><div style="color:${col(d.realizedPnl)}">${money(d.realizedPnl)}</div>
    <div>Charges paid</div><div>${money(d.totalCharges)}</div>
    <div>Since</div><div>${esc((d.createdAt || '').slice(0, 10))} · refreshed ${d.lastRefresh ? esc(new Date(d.lastRefresh).toLocaleString()) : '–'}</div>
  </div>`;
  if (d.positions?.length) {
    html += '<table><thead><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>Last</th><th>Unrealised</th><th>Stop</th><th>Target</th><th>News</th><th></th></tr></thead><tbody>';
    for (const p of d.positions) {
      html += `<tr><td>${esc(p.symbol)}</td><td>${p.qty}</td><td>${Number(p.entryPrice).toFixed(2)}</td><td>${Number(p.mark).toFixed(2)}</td>
        <td style="color:${col(p.unrealized)}">${money(p.unrealized)} (${p.unrealizedPct.toFixed(1)}%)</td>
        <td>${p.stop != null ? Number(p.stop).toFixed(2) : '–'}</td><td>${p.target != null ? Number(p.target).toFixed(2) : '–'}</td>
        <td>${sentimentBadge(p.news)}</td>
        <td><button type="button" data-close="${esc(p.symbol)}" style="margin:0;padding:4px 10px;font-size:12px;background:var(--soft);color:var(--ink);border:1px solid var(--line)">Close</button></td></tr>`;
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="note">No open positions.</div>';
  }
  if (d.closedTrades?.length) {
    html += '<div style="margin-top:10px;font-size:13px"><b>Recent closed trades</b></div><table><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr></thead><tbody>';
    for (const t of d.closedTrades.slice(0, 10)) html += `<tr><td>${esc(t.symbol)}</td><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td style="color:${col(t.pnl)}">${money(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`;
    html += '</tbody></table>';
  }
  if ((d.equityHistory || []).length >= 2) html += renderEquityCurve(d.equityHistory);
  html += `<div class="note" style="margin-top:8px">${esc(d.disclaimer || '')}</div>`;
  return html;
}
async function pfCall(path, body, msg) {
  const out = $('pfOut');
  const status = $('pfStatus');
  status.style.display = 'block';
  status.textContent = msg;
  try {
    const d = body === undefined ? await api(path) : await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    out.innerHTML = renderPortfolio(d);
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    status.style.display = 'none';
  }
}
$('pfRefreshBtn').addEventListener('click', () => pfCall('/api/portfolio', undefined, 'Checking stops/targets and marking to market…'));
$('pfApplyBtn').addEventListener('click', () => pfCall('/api/portfolio/rebalance', { techOnly: true }, 'Scanning daily signals and applying them…'));
$('pfResetBtn').addEventListener('click', () => {
  if (confirm('Reset the paper portfolio? All simulated positions and history are cleared.')) pfCall('/api/portfolio/reset', {}, 'Resetting…');
});
$('pfOut').addEventListener('click', (e) => {
  const sym = e.target?.dataset?.close;
  if (sym) pfCall('/api/portfolio/close', { symbol: sym }, `Closing ${sym}…`);
});

// --- Settings ---
const ST_FIELDS = [
  ['startingCapital', 'Starting capital (₹)'],
  ['riskPerTradePct', 'Risk per trade (%)'],
  ['maxPositionPct', 'Max per position (%)'],
  ['maxOpenPositions', 'Max open positions'],
  ['minConfidence', 'Min signal confidence (0.5–0.95)'],
  ['newsTiltPts', 'News tilt max (pts, 0 = off)'],
  ['costs.brokerageIntradayCap', 'Intraday brokerage cap (₹/order)'],
  ['costs.brokerageDeliveryPct', 'Delivery brokerage (%)'],
  ['costs.dpChargePerSell', 'DP charge per delivery sell (₹)'],
  ['costs.slippagePct', 'Slippage per fill (%)'],
];
function renderSettings(st) {
  let html = '';
  for (const [k, label] of ST_FIELDS) html += `<div><label>${esc(label)}</label><input data-st="${esc(k)}" type="number" step="any" value="${esc(st[k])}" /></div>`;
  html += `<div style="flex:3;min-width:260px"><label>Symbols (comma-separated)</label><input data-st="symbols" value="${esc((st.symbols || []).join(', '))}" /></div>`;
  $('stForm').innerHTML = html;
}
async function loadSettings() {
  try {
    renderSettings((await api('/api/settings')).settings);
  } catch (e) {
    $('stOut').textContent = 'Error: ' + e.message;
  }
}
$('stSaveBtn').addEventListener('click', async () => {
  const patch = {};
  for (const el of document.querySelectorAll('[data-st]')) patch[el.dataset.st] = el.value;
  try {
    renderSettings((await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: patch }) })).settings);
    $('stOut').textContent = 'Saved.';
  } catch (e) {
    $('stOut').textContent = 'Error: ' + e.message;
  }
});
$('stResetBtn').addEventListener('click', async () => {
  try {
    renderSettings((await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })).settings);
    $('stOut').textContent = 'Defaults restored.';
  } catch (e) {
    $('stOut').textContent = 'Error: ' + e.message;
  }
});
loadSettings();

// --- Events ---
function renderEventStats(stats) {
  if (!stats?.length) return '<div class="note">No events recorded yet — they appear as companies report (results seasons: mid-Jan/Apr/Jul/Oct).</div>';
  const cell = (x) => (x ? `${x.avgAbnormalPct != null ? (x.avgAbnormalPct >= 0 ? '+' : '') + x.avgAbnormalPct.toFixed(2) + '% vs NIFTY' : (x.avgRetPct >= 0 ? '+' : '') + x.avgRetPct.toFixed(2) + '%'} <span style="color:var(--muted)">(n=${x.n})</span>` : '<span style="color:var(--muted)">pending</span>');
  return '<table><thead><tr><th style="text-align:left">Event</th><th>Count</th><th>+1 day</th><th>+5 days</th><th>+20 days</th></tr></thead><tbody>' +
    stats.map((t) => `<tr><td style="text-align:left">${esc(t.type)}</td><td>${t.events}</td><td>${cell(t.d1)}</td><td>${cell(t.d5)}</td><td>${cell(t.d20)}</td></tr>`).join('') + '</tbody></table>';
}
async function evtLoad(scan) {
  const out = $('evtOut');
  out.textContent = scan ? 'Scanning NIFTY 50 news (one AI reading per stock per day)…' : 'Loading…';
  try {
    const d = scan
      ? await api('/api/events/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ universe: 'nifty50' }) })
      : await api('/api/events');
    let html = scan ? `<div class="note">New events: ${d.added.length ? d.added.map((e) => esc(e.symbol + ' ' + e.type)).join(', ') : 'none'} · tracked ${d.tracked}</div>` : '';
    html += renderEventStats(d.stats);
    const list = d.events || [];
    if (list.length) {
      html += '<div style="margin-top:8px;font-size:13px"><b>Recent events</b></div><table><thead><tr><th>Date</th><th style="text-align:left">Stock</th><th>Event</th><th>Price</th><th>+5d vs NIFTY</th><th style="text-align:left">Headline</th></tr></thead><tbody>';
      for (const e of list.slice(0, 15)) {
        const r5 = e.returns?.[5];
        html += `<tr><td>${esc(e.date)}</td><td style="text-align:left">${esc(e.symbol)}</td><td>${esc(e.type)}</td><td>${Number(e.price).toFixed(2)}</td><td>${r5?.abnormal != null ? (r5.abnormal * 100).toFixed(2) + '%' : '–'}</td><td style="text-align:left;font-size:12px">${esc((e.headline || '').slice(0, 80))}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('evtShowBtn').addEventListener('click', () => evtLoad(false));
$('evtScanBtn').addEventListener('click', () => evtLoad(true));


// --- Strategies ---
function multiCurve(series) {
  // series: [{ name, color, points: [{date, equity}] }] normalised to 100 at the first common date
  const all = series.filter((x) => x.points?.length >= 2);
  if (!all.length) return '';
  const W = 680, H = 200, pl = 46, pr = 10, pt = 10, pb = 22;
  const norm = all.map((x) => ({ ...x, pts: x.points.map((p) => ({ date: p.date, v: (p.equity / x.points[0].equity) * 100 })) }));
  const vals = norm.flatMap((x) => x.pts.map((p) => p.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || 1) * 0.05;
  lo -= pad; hi += pad;
  const n = Math.max(...norm.map((x) => x.pts.length));
  const xf = (i) => pl + (i / (n - 1 || 1)) * (W - pl - pr);
  const yf = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  let g = `<text x="${pl - 4}" y="${yf(hi) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${hi.toFixed(0)}</text><text x="${pl - 4}" y="${yf(lo)}" text-anchor="end" font-size="10" fill="var(--muted)">${lo.toFixed(0)}</text>`;
  g += `<line x1="${pl}" x2="${W - pr}" y1="${yf(100)}" y2="${yf(100)}" stroke="var(--line)" stroke-dasharray="3 3"/>`;
  for (const x of norm) g += `<polyline fill="none" stroke="${x.color}" stroke-width="1.8" points="${x.pts.map((p, i) => `${xf(i).toFixed(1)},${yf(p.v).toFixed(1)}`).join(' ')}"/>`;
  const first = norm[0].pts[0].date, last = norm[0].pts[norm[0].pts.length - 1].date;
  g += `<text x="${pl}" y="${H - 6}" font-size="10" fill="var(--muted)">${esc(first)}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(last)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--soft);border-radius:8px;margin-top:8px">${g}</svg>
    <div class="note">${all.map((x) => `<span style="color:${x.color}">■</span> ${esc(x.name)}`).join(' · ')} (start = 100)</div>`;
}
const COLORS = { nifty: 'var(--muted)', trend: 'var(--accent)', momentum: 'var(--up)' };
function renderAccounts(d) {
  if (!d.accounts?.length) return `<div class="note">${esc(d.note || 'Not started.')}</div>`;
  let html = `<div class="note">Forward test since ${esc(String(d.startedAt).slice(0, 10))} · ₹${Number(d.capital).toLocaleString('en-IN')} each</div>`;
  if (d.actions?.length) html += `<div class="note">This run: ${d.actions.map((a) => esc(`${a.account}: ${a.action}`)).join(' · ')}</div>`;
  html += '<table><thead><tr><th style="text-align:left">Account</th><th>Equity</th><th>Return</th><th>After tax if sold today</th><th>Cash</th><th>Charges</th><th>Tax paid</th><th style="text-align:left">Holdings</th></tr></thead><tbody>';
  for (const a of d.accounts) {
    const col = a.returnPct >= 0 ? 'var(--up)' : 'var(--down)';
    html += `<tr><td style="text-align:left">${esc(a.name)}</td><td>₹${a.equity.toFixed(0)}</td><td style="color:${col}">${a.returnPct >= 0 ? '+' : ''}${a.returnPct.toFixed(2)}%</td>
      <td>${a.afterTaxIfSold == null ? '–' : `₹${a.afterTaxIfSold.toFixed(0)} (${a.afterTaxReturnPct >= 0 ? '+' : ''}${a.afterTaxReturnPct.toFixed(2)}%)`}</td>
      <td>₹${a.cash.toFixed(0)}</td><td>₹${a.charges.toFixed(0)}</td><td>₹${(a.taxPaid || 0).toFixed(0)}</td>
      <td style="text-align:left;font-size:12px">${a.holdings.length ? esc(a.holdings.map((h) => h.symbol.replace('.NS', '') + '×' + h.qty).join(', ')) : 'cash / liquid fund'}</td></tr>`;
  }
  html += '</tbody></table>';
  html += multiCurve(d.accounts.map((a) => ({ name: a.name, color: COLORS[a.key], points: a.history })));
  return html + `<div class="note">${esc(d.note)}</div>`;
}
function renderBacktests(d) {
  const row = (name, s, extra = '') => `<tr><td style="text-align:left">${esc(name)}</td><td>${s.cagrPct.toFixed(1)}%</td><td>${s.volPct.toFixed(1)}%</td><td>${s.sharpe?.toFixed(2)}</td><td>${s.maxDrawdownPct.toFixed(1)}%</td><td style="text-align:left;font-size:12px">${extra}</td></tr>`;
  const head = '<table><thead><tr><th style="text-align:left">Strategy</th><th>CAGR</th><th>Vol</th><th>Sharpe</th><th>Max drawdown</th><th style="text-align:left">Notes</th></tr></thead><tbody>';
  const a0 = d.A[0];
  let html = `<div style="font-size:13px"><b>A · NIFTY trend</b> · ${esc(a0.all.from)} → ${esc(a0.all.to)}</div>` + head + row('NIFTY buy-and-hold (+dividends)', a0.benchmark.all, 'benchmark');
  for (const x of d.A) html += row(x.name, x.all, `${x.switchesPerYear.toFixed(1)} switches/yr · ${x.pctTimeInvested.toFixed(0)}% invested · ${esc(x.verdict)}`);
  html += '</tbody></table>';
  html += multiCurve([{ name: 'NIFTY buy-and-hold', color: 'var(--muted)', points: d.curves.AB }, { name: 'A · trend (month-end)', color: 'var(--accent)', points: d.curves.A }]);
  const b0 = d.B[0];
  html += `<div style="font-size:13px;margin-top:12px"><b>B · Momentum on ${esc(d.universe.name)}</b> (${d.universe.used} stocks) · ${esc(b0.all.from)} → ${esc(b0.all.to)} · ₹${Number(d.capital).toLocaleString('en-IN')}</div>` + head;
  html += row('NIFTY buy-and-hold (+dividends)', d.benchmarkB.all, 'benchmark');
  html += row(d.equalWeight.name, d.equalWeight.all, `shares B's survivorship bias · costs ${d.equalWeight.chargesPctPerYear.toFixed(2)}%/yr`);
  for (const x of d.B) {
    const ex = d.momentumExcessPct.find((m) => m.variant === x.variant);
    html += row(x.name, x.all, `costs ${x.chargesPctPerYear.toFixed(2)}%/yr · ${ex.cagrAboveEqualWeightPct >= 0 ? '+' : ''}${ex.cagrAboveEqualWeightPct.toFixed(1)} pts vs equal-weight · ${esc(x.verdict)}`);
  }
  html += '</tbody></table>';
  if (d.realEtf) {
    const r = d.realEtf;
    html += `<div style="font-size:13px;margin-top:12px"><b>Reality check (no survivorship bias): real ETFs</b> · ${esc(r.from)} → ${esc(r.to)}</div>` + head +
      row('Momentum 30 ETF (MOMENTUM.NS)', r.momentum, 'actual investable returns, after fund costs') + row('NIFTY 50 ETF (NIFTYBEES)', r.nifty, '') + '</tbody></table>';
  }
  if (d.C) {
    html += `<div style="font-size:13px;margin-top:12px"><b>C · Volatility-targeted NIFTY</b> · ${esc(d.benchmarkC.all.from)} → ${esc(d.benchmarkC.all.to)}</div>` + head + row('NIFTY buy-and-hold (+dividends)', d.benchmarkC.all, 'benchmark');
    for (const x of d.C) html += row(x.name, x.all, `${x.avgExposurePct.toFixed(0)}% avg exposure · ${esc(x.verdict)}`);
    html += '</tbody></table>';
  }
  if (d.afterTax) {
    const t = d.afterTax;
    const p1 = (x) => (x == null ? '–' : x.toFixed(1) + '%');
    const trow = (n, x) => `<tr><td style="text-align:left">${esc(n)}</td><td>${p1(x.holdingCagrPct)}</td><td>${p1(x.cagrIfSoldPct)}</td><td>${x.taxPerYearPct.toFixed(2)}%</td><td>${x.sharpe?.toFixed(2) ?? '–'}</td><td>${p1(x.maxDrawdownPct)}</td></tr>`;
    html += `<div style="font-size:13px;margin-top:12px"><b>After Indian tax</b> · ₹${Number(d.capital).toLocaleString('en-IN')}</div>
      <table><thead><tr><th style="text-align:left">Strategy</th><th>CAGR still holding</th><th>CAGR if sold at the end</th><th>Tax / year (of capital)</th><th>Sharpe</th><th>Max drawdown</th></tr></thead><tbody>` +
      trow('NIFTY buy-and-hold', t.A.benchmark) + [...t.A.strategies, ...t.C, ...t.B].map((x) => trow(x.name, x)).join('') + '</tbody></table>' +
      `<div class="note">${esc(t.note)} Momentum rows use the 10-year stock window; the others use NIFTY's.</div>`;
  }
  return html + `<div class="note">${d.caveats.map(esc).join(' ')}</div>`;
}
async function stsRun(kind) {
  const out = $('stsOut');
  const status = $('stsStatus');
  status.style.display = 'block';
  status.textContent = kind === 'back' ? 'Running 10-year backtests on NIFTY and NIFTY 200 (~30 s)…' : kind === 'reset' ? 'Restarting the forward test…' : 'Updating paper accounts…';
  try {
    if (kind === 'back') out.innerHTML = renderBacktests(await api('/api/strategy-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    else if (kind === 'reset') out.innerHTML = renderAccounts(await api('/api/strategy-accounts/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capital: 1000000 }) }));
    else out.innerHTML = renderAccounts(await api('/api/strategy-accounts/rebalance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    status.style.display = 'none';
  }
}
$('stfBtn').addEventListener('click', () => stsRun('fwd'));
$('stbBtn').addEventListener('click', () => stsRun('back'));
$('stResetAcctBtn').addEventListener('click', () => {
  if (confirm('Restart the strategy forward test? All three paper accounts start over at ₹10 lakh.')) stsRun('reset');
});

// --- Today ---
function renderToday(d) {
  const r = d.report;
  const h = d.health;
  const lvlCol = (l) => (l === 'ok' ? 'var(--up)' : l === 'warn' ? 'var(--warn)' : 'var(--down)');
  let html = '';
  if (h) {
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + h.checks.map((c) =>
      `<span title="${esc(c.detail)}" style="border:1px solid ${lvlCol(c.level)};color:${lvlCol(c.level)};border-radius:999px;padding:2px 8px;font-size:12px">${esc(c.name)}: ${esc(c.level)}</span>`).join('') + '</div>';
  }
  if (!r) return html + '<div class="note">No monitor run yet — click <b>Run now</b>.</div>';
  const ageMin = (Date.now() - new Date(r.finishedAt)) / 60000;
  html += `<div class="note">Last run ${esc(r.market.ist)} (${ageMin < 90 ? Math.round(ageMin) + ' min' : (ageMin / 60).toFixed(1) + ' h'} ago) · market ${r.market.open ? 'open' : r.market.holiday ? `closed (NSE holiday: ${esc(r.market.holiday)})` : 'closed'}</div>`;
  if (d.weekly) {
    const w = d.weekly;
    html += `<details style="margin:8px 0;border:1px solid var(--line);border-radius:10px;padding:8px 10px"><summary style="cursor:pointer;font-size:13px"><b>Weekly scorecard ${esc(w.week.label)}</b> · ${esc(w.summary)}</summary>
      <table><thead><tr><th style="text-align:left">Account</th><th>Equity</th><th>This week</th><th>Since start</th></tr></thead><tbody>${w.accounts.map((a) =>
        `<tr><td style="text-align:left">${esc(a.name)}</td><td>₹${Math.round(a.equity).toLocaleString('en-IN')}</td><td>${a.weekPct == null ? '–' : (a.weekPct >= 0 ? '+' : '') + a.weekPct.toFixed(2) + '%'}</td><td>${a.totalPct == null ? '–' : (a.totalPct >= 0 ? '+' : '') + a.totalPct.toFixed(2) + '%'}</td></tr>`).join('')}</tbody></table>
      ${w.strategy ? (() => {
        const fmt = (v, u) => (u === 'R' ? `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} R` : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
        return `<table style="font-size:12px"><thead><tr><th style="text-align:left">Strategy (paper)</th><th>Trades this week</th><th>Week result</th><th>Total</th><th style="text-align:left">Can we trust it?</th></tr></thead><tbody>${w.strategy.map((x) => {
          const wk = x.weekResult ?? x.weekNetRs ?? 0;
          const tot = x.totalResult ?? x.totalNetRs ?? 0;
          return `<tr><td style="text-align:left">${esc(x.label)}</td><td>${x.weekTrades}</td><td style="color:${wk >= 0 ? 'var(--up)' : 'var(--down)'}">${fmt(wk, x.unit)}</td><td>${fmt(tot, x.unit)}</td><td style="text-align:left" class="note">${esc(x.trust?.verdict || '')}</td></tr>`;
        }).join('')}</tbody></table>`;
      })() : ''}
      <div class="note">${w.predictions.scored ? `${w.predictions.scored} predictions scored this week · Brier ${w.predictions.brier.app.toFixed(4)} vs coin-flip ${w.predictions.brier.uniform.toFixed(4)}` : 'No predictions scored this week.'}${w.allTime?.verdict ? ' · All time: ' + esc(w.allTime.verdict) : ''}</div></details>`;
  }
  if (r.alerts?.length) {
    html += '<div style="margin:8px 0;padding:10px;border:1px solid var(--warn);border-radius:10px"><b>Alerts</b><ul style="margin:6px 0 0 18px;font-size:13px">' +
      r.alerts.map((a) => `<li style="color:${a.level === 'high' ? 'var(--down)' : 'var(--ink)'}">${esc(a.text)}</li>`).join('') + '</ul></div>';
  } else {
    html += '<div class="note">No alerts.</div>';
  }
  const cb = r.crashBrake;
  if (cb && !cb.error) html += `<div style="font-size:14px;margin:6px 0"><b>Crash brake:</b> <span style="color:${cb.state === 'out' ? 'var(--down)' : cb.state === 'in' ? 'var(--up)' : 'var(--warn)'}">${cb.state === 'out' ? 'OFF the market' : cb.state === 'in' ? 'invested' : 'no change'}</span> — ${esc(cb.reading)}</div>`;
  const mp = r.myPortfolio;
  if (mp && !mp.error && mp.value) html += `<div style="font-size:14px;margin:6px 0"><b>My portfolio:</b> ₹${Math.round(mp.value).toLocaleString('en-IN')} (${mp.gainPct >= 0 ? '+' : ''}${mp.gainPct?.toFixed(1)}%) · tax if sold today ₹${Math.round(mp.taxIfSoldAllToday || 0).toLocaleString('en-IN')}</div>`;
  const v = r.volatility;
  if (v && !v.error) html += `<div style="font-size:14px;margin:6px 0"><b>NIFTY volatility:</b> India VIX ${v.impliedPct?.toFixed(1)}% vs forecast ${v.forecastPct?.toFixed(1)}% (ratio ${v.ratio?.toFixed(2)}). ${esc(v.reading)}</div>`;
  html += '<table><thead><tr><th style="text-align:left">Stock</th><th>Last</th><th title="Base rates — no validated direction skill">Up/Down/Side <span style="font-weight:400">(no validated skill)</span></th><th>Signal</th><th>News</th><th>±1 ATR</th><th title="Chance of a move bigger than ±2% next session, up or down (big-move odds)">Move &gt; ±2%</th><th style="text-align:left">Events</th></tr></thead><tbody>';
  for (const w of r.watchlist || []) {
    if (w.error) {
      html += `<tr><td style="text-align:left">${esc(w.symbol)}</td><td colspan="7" class="err">${esc(w.error)}</td></tr>`;
      continue;
    }
    html += `<tr><td style="text-align:left">${esc(w.symbol)}</td><td>${Number(w.last).toFixed(1)}</td>
      <td style="color:var(--muted)">${Math.round(w.up * 100)}/${Math.round(w.down * 100)}/${Math.round(w.side * 100)}</td><td>–</td>
      <td>${sentimentBadge({ sentiment: w.sentiment, events: w.events })}</td><td>${w.atrPct != null ? w.atrPct.toFixed(2) + '%' : '–'}</td>
      <td>${w.big2 != null ? Math.round(w.big2 * 100) + '%' : '–'}</td>
      <td style="text-align:left;font-size:12px">${esc((w.events || []).join(', '))}</td></tr>`;
  }
  html += '</tbody></table>';
  const rk = r.ranking;
  if (rk && !rk.error) html += `<div class="note">Ranking (${esc(rk.asOf)}): top ${esc(rk.top.join(', '))} · bottom ${esc(rk.bottom.join(', '))} — see Stock ranking → Evidence.</div>`;
  if (r.events && !r.events.error) html += `<div class="note">Earnings/rating events tracked: ${r.events.tracked}${r.events.added?.length ? ' · new today: ' + esc(r.events.added.map((e) => e.symbol + ' ' + e.type).join(', ')) : ''}</div>`;
  const sa = r.strategies;
  if (sa?.accounts) html += `<div class="note">Strategy forward test (since ${esc(String(sa.startedAt).slice(0, 10))}): ${sa.accounts.map((a) => `${esc(a.key)} ${a.returnPct >= 0 ? '+' : ''}${a.returnPct.toFixed(2)}%`).join(' · ')}</div>`;
  const p = r.portfolio;
  if (p?.equity != null) html += `<div class="note">Paper portfolio ₹${p.equity.toFixed(0)} (${p.returnPct >= 0 ? '+' : ''}${p.returnPct.toFixed(2)}%) · ${p.positions.length} open · charges ₹${p.charges.toFixed(0)}</div>`;
  const c = r.scorecard;
  html += `<div class="note">Scorecard: ${esc(c?.verdict || 'no scored predictions yet')}${c?.scored ? ` · hit-rate ${c.hitRatePct.toFixed(0)}% · Brier ${c.brier.app.toFixed(3)} vs coin-flip ${c.brier.uniform.toFixed(3)}` : ''}</div>`;
  return html + `<div class="note">${esc(r.disclaimer)}</div>`;
}
async function tdLoad(run) {
  const out = $('tdOut');
  const status = $('tdStatus');
  status.style.display = 'block';
  status.textContent = run ? 'Running the investor monitor (watchlist, news, scoring, events, portfolio)… ~1–2 min' : 'Loading…';
  $('tdRunBtn').disabled = $('tdRefreshBtn').disabled = true;
  try {
    const d = run ? await api('/api/today/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }) : await api('/api/today');
    out.innerHTML = renderToday(d);
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    status.style.display = 'none';
    $('tdRunBtn').disabled = $('tdRefreshBtn').disabled = false;
  }
}
$('tdRefreshBtn').addEventListener('click', () => tdLoad(false));
$('tdRunBtn').addEventListener('click', () => tdLoad(true));
lazy('Today', () => tdLoad(false));

// News sentiment chip: −1 … +1, coloured, with event flags on hover.
function sentimentBadge(n) {
  if (!n) return '<span style="color:var(--muted)">–</span>';
  const s = Number(n.sentiment);
  const ev = n.events?.length ? ` ⚠` : '';
  const title = esc([n.headline, n.events?.length ? 'Events: ' + n.events.join(', ') : '', n.note].filter(Boolean).join(' · '));
  if (!Number.isFinite(s)) return `<span title="${title}" style="color:var(--muted)">n/a${ev}</span>`;
  const col = s > 0.2 ? 'var(--up)' : s < -0.2 ? 'var(--down)' : 'var(--muted)';
  return `<span title="${title}" style="color:${col};font-weight:600">${s > 0 ? '+' : ''}${s.toFixed(1)}${ev}</span>`;
}

// What the news tilt did to the numbers.
function renderTilt(t, n) {
  if (!t || (!t.applied && !n)) return '';
  if (t.applied) {
    return `<div class="note">News tilt applied: sentiment ${t.sentiment > 0 ? '+' : ''}${Number(t.sentiment).toFixed(2)} moved ${Math.abs(t.shiftPts).toFixed(1)} pts toward ${t.shiftPts > 0 ? 'UP' : 'DOWN'}
      (before: ${Math.round(t.before.probUp * 100)}/${Math.round(t.before.probDown * 100)}/${Math.round(t.before.probSideways * 100)})${t.note ? ` — ${esc(t.note)}` : ''}.${n?.events?.length ? ` ⚠ Event risk: ${esc(n.events.join(', '))}.` : ''}</div>`;
  }
  return `<div class="note">News: sentiment ${sentimentBadge(n)} — no tilt (${esc(t.reason || 'n/a')}).${n?.events?.length ? ` ⚠ Event risk: ${esc(n.events.join(', '))}.` : ''}</div>`;
}

// Signal strength vs historical base rates.
function renderEdge(e) {
  if (!e) return '';
  const col = e.level === 'none' ? 'var(--muted)' : e.level === 'weak' ? 'var(--warn)' : 'var(--accent)';
  const b = e.baseRates || {};
  return `<div style="margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">
    <b style="color:${col}">No validated direction skill</b> · ${esc(e.note)}
    <span style="color:var(--muted)">(base rates ${Math.round((b.probUp || 0) * 100)}/${Math.round((b.probDown || 0) * 100)}/${Math.round((b.probSideways || 0) * 100)})</span></div>`;
}

const FACT_LABEL = { results: 'Results', guidance: 'Guidance', rating: 'Rating', orderWin: 'Order win', managementChange: 'Management change', regulatoryAction: 'Regulatory action' };
function renderFacts(f) {
  const keys = Object.keys(f || {});
  if (!keys.length) return '';
  return '<div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">' + keys.map((k) => {
    const v = f[k];
    const good = ['beat', 'raised', 'upgrade'].includes(v) || (k === 'orderWin' && v === true);
    const bad = ['miss', 'cut', 'downgrade'].includes(v) || (k === 'regulatoryAction' && v === true);
    const col = good ? 'var(--up)' : bad ? 'var(--down)' : 'var(--muted)';
    return `<span style="border:1px solid ${col};color:${col};border-radius:999px;padding:2px 8px;font-size:12px">${esc(FACT_LABEL[k] || k)}${v === true ? '' : ': ' + esc(v)}</span>`;
  }).join('') + '</div>';
}

// --- News brief ---
function renderNews(n) {
  let html = `<div style="margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)">
    <div style="font-weight:700;margin-bottom:6px">News · ${esc(n.company || n.symbol || '')}</div>`;
  if (n.events?.length) html += `<div style="margin-bottom:6px;font-size:13px;color:var(--warn)">⚠ Event risk in recent headlines: <b>${esc(n.events.join(', '))}</b> — moves around events are usually larger and less predictable.</div>`;
  if (n.brief) {
    const sc = Number(n.sentiment);
    const col = sc > 0.2 ? 'var(--up)' : sc < -0.2 ? 'var(--down)' : 'var(--muted)';
    html += `<div style="font-size:13px">${esc(n.brief)}</div>
      ${renderFacts(n.facts)}
      ${n.factEvidence && Object.keys(n.factEvidence).length ? `<div class="note">Source headlines: ${Object.entries(n.factEvidence).map(([k, t]) => `<b>${esc(FACT_LABEL[k] || k)}</b> — ${esc(t || '')}`).join(' · ')}</div>` : ''}
      <div class="note">Headline sentiment: <b style="color:${col}">${Number.isFinite(sc) ? (sc > 0 ? '+' : '') + sc.toFixed(2) : '–'}</b> (−1 negative … +1 positive). Shown for context and logged so its value can be measured — it does not change the probabilities.</div>`;
  }
  if (n.headlines?.length) {
    html += '<ul style="margin:8px 0 0 18px;font-size:12px">';
    for (const h of n.headlines) html += `<li>${esc(h.title)} <span style="color:var(--muted)">— ${esc(h.publisher || '')}, ${esc((h.time || '').slice(0, 10))}</span></li>`;
    html += '</ul>';
  }
  if (n.note) html += `<div class="note">${esc(n.note)}</div>`;
  if (n.cachedForDay) html += '<div class="note">Today\'s AI reading (fixed for the day so it doesn\'t drift between runs).</div>';
  return html + '</div>';
}
$('newsBtn').addEventListener('click', async () => {
  const out = $('newsOut');
  const sym = $('sym').value.trim();
  out.className = 'out';
  if (!sym) {
    out.className = 'out err';
    out.textContent = 'Enter a symbol first, e.g. RELIANCE.NS';
    return;
  }
  out.textContent = 'Fetching headlines…';
  try {
    out.innerHTML = renderNews(await api('/api/news?symbol=' + encodeURIComponent(sym)));
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  }
});


// --- FII positioning test ---
$('fiiBtn').addEventListener('click', async () => {
  const out = $('evOut');
  out.textContent = 'Fetching NSE participant open interest (cached after the first run) and testing…';
  try {
    const r = await api('/api/fii-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const NAME = { longRatio: 'FII index-futures long ratio', longRatioZ: '…its z-score (60 days)', ratioChg5: '…its 5-day change', optNet: 'FII index-options net (calls − puts)' };
    let html = `<div class="note">${r.days} sessions · ${esc(r.from)} → ${esc(r.to)} · does FII positioning predict NIFTY?</div>`;
    for (const [h, x] of Object.entries(r.horizons)) {
      html += `<div style="font-size:13px;margin-top:8px"><b>Next ${h} sessions</b> · ${x.periods} periods · NIFTY up ${(x.baseUpRate * 100).toFixed(0)}% of the time</div>
        <table><thead><tr><th style="text-align:left">Feature</th><th>IC</th><th>t</th><th>1st / 2nd half</th><th>Up% when high / low</th><th>Evidence</th></tr></thead><tbody>` +
        Object.entries(x.features).map(([f, v]) => `<tr><td style="text-align:left">${esc(NAME[f] || f)}</td><td>${v.ic.toFixed(3)}</td><td>${v.tStat.toFixed(2)}</td><td>${v.icFirstHalf.toFixed(3)} / ${v.icSecondHalf.toFixed(3)}</td><td>${(v.upRateWhenHigh * 100).toFixed(0)}% / ${(v.upRateWhenLow * 100).toFixed(0)}%</td><td style="font-weight:700;color:${v.evidence === 'strong' ? 'var(--up)' : v.evidence === 'weak' ? 'var(--warn)' : 'var(--muted)'}">${esc(v.evidence)}</td></tr>`).join('') + '</tbody></table>';
    }
    const l = r.latest;
    html += `<div style="margin-top:8px;font-size:14px">Latest (${esc(l.date)}): FIIs are <b>${(l.longRatio * 100).toFixed(1)}% long</b> in index futures (z ${l.longRatioZ?.toFixed(2) ?? '–'} vs the last 60 days). Context only.</div><div class="note">${esc(r.note)}</div>`;
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Model evaluation (replay + calibration) ---
const MODEL_NAMES = {
  uniform: 'Uniform 33/33/33',
  climatology: 'Base rates (history)',
  persistence: 'Last move repeats',
  current: 'Formula (uncalibrated)',
  calibrated: 'Calibrated to data',
  context: 'Context model (full)',
  contextMove: 'Context: move vs sideways',
};

// Reliability diagram: predicted probability (x) vs how often it happened (y).
function renderReliability(rel, title) {
  const W = 300, H = 230, pl = 36, pr = 10, pt = 22, pb = 30;
  const x = (v) => pl + v * (W - pl - pr);
  const y = (v) => H - pb - v * (H - pt - pb);
  const colors = { UP: 'var(--up)', DOWN: 'var(--down)', SIDEWAYS: 'var(--muted)' };
  let g = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--line)" stroke-dasharray="4 3"/>`;
  for (const t of [0, 0.5, 1]) {
    g += `<text x="${x(t)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="var(--muted)">${t * 100}%</text>`;
    g += `<text x="${pl - 6}" y="${y(t) + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${t * 100}%</text>`;
  }
  for (const [label, bins] of Object.entries(rel || {})) {
    const pts = bins.filter((b) => b.n >= 15);
    if (pts.length > 1) g += `<polyline fill="none" stroke="${colors[label]}" stroke-width="1.5" points="${pts.map((b) => `${x(b.meanPredicted).toFixed(1)},${y(b.observed).toFixed(1)}`).join(' ')}"/>`;
    for (const b of pts) g += `<circle cx="${x(b.meanPredicted).toFixed(1)}" cy="${y(b.observed).toFixed(1)}" r="${Math.min(6, 2 + Math.sqrt(b.n) / 8).toFixed(1)}" fill="${colors[label]}"><title>${label}: predicted ${(b.meanPredicted * 100).toFixed(0)}% → happened ${(b.observed * 100).toFixed(0)}% (n=${b.n})</title></circle>`;
  }
  return `<div style="flex:1;min-width:260px"><div style="font-size:12px;color:var(--muted);margin-bottom:2px">${esc(title)}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)} reliability diagram" style="display:block;background:var(--soft);border-radius:8px">${g}
    <text x="${W / 2}" y="${H - 1}" text-anchor="middle" font-size="9" fill="var(--muted)">predicted</text></svg></div>`;
}

function renderEval(d) {
  const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const b = d.testBaseRates;
  let html = `<div class="note" style="margin-bottom:8px">${esc(d.settings.label)} · ${d.symbols.length} symbols · ${esc(d.period.from)} → ${esc(d.period.to)} ·
    ${d.samples.train.toLocaleString()} bars to fit, ${d.samples.test.toLocaleString()} scored · actual outcomes: UP ${(b.probUp * 100).toFixed(0)}% / DOWN ${(b.probDown * 100).toFixed(0)}% / SIDEWAYS ${(b.probSideways * 100).toFixed(0)}%</div>`;
  if (d.skipped?.length) html += `<div class="err" style="margin-bottom:8px">Skipped: ${esc(d.skipped.join(' · '))}</div>`;
  html += `<table><thead><tr><th style="text-align:left">Model</th><th>Brier ↓</th><th>Log loss ↓</th><th>Top-label accuracy</th><th>Skill vs base rates</th><th title="On bars that moved: does the up-vs-down split beat base rates?">Direction skill</th></tr></thead><tbody>`;
  for (const [m, v] of Object.entries(d.metrics)) {
    const best = m === d.best;
    const col = v.skillPct > 0.5 ? 'var(--up)' : v.skillPct < -0.5 ? 'var(--down)' : 'var(--muted)';
    html += `<tr${best ? ' style="font-weight:700"' : ''}><td style="text-align:left">${esc(MODEL_NAMES[m] || m)}${best ? ' ★' : ''}</td>
      <td>${v.brier.toFixed(4)}</td><td>${v.logLoss.toFixed(4)}</td><td>${v.accuracyPct.toFixed(1)}%</td><td style="color:${col}">${pct(v.skillPct)}</td>
      <td style="color:${v.directionSkillPct > 0.5 ? 'var(--up)' : v.directionSkillPct < -0.5 ? 'var(--down)' : 'var(--muted)'}">${pct(v.directionSkillPct)}</td></tr>`;
  }
  html += '</tbody></table>';
  const m = d.metrics;
  const verdict = m.calibrated.skillPct > 1
    ? `The technical score carries some information here: calibrated probabilities beat base rates by ${pct(m.calibrated.skillPct)} on unseen bars.`
    : `The technical score carries little or no predictive information at this horizon: calibrated probabilities are about as good as quoting base rates (${pct(m.calibrated.skillPct)}).`;
  html += `<div style="margin-top:10px;font-size:14px">${verdict} The uncalibrated formula scores ${pct(m.current.skillPct)}; calibration ${d.useCalibrated ? `<b>fixes that</b>${d.saved ? ' and is now used live.' : ' — click <b>Fit &amp; use calibration</b> to apply it live.'}` : 'did not beat it, so live keeps the formula.'}</div>`;
  if (d.ablation?.length) {
    html += `<div style="margin-top:12px;font-size:13px"><b>Context features</b> — added one group at a time (skill vs base rates on unseen bars)</div>
      <table><thead><tr><th style="text-align:left">Adds</th><th>Features</th><th>Brier</th><th>Skill</th></tr></thead><tbody>`;
    const GROUP = { tech: 'Technical score', stock: 'Stock regime (RSI, returns, volatility, trend, volume)', market: 'Market: NIFTY trend + relative strength', vix: 'India VIX level + change', session: 'Session: gap, first/last half hour, results season' };
    for (const a of d.ablation) html += `<tr><td style="text-align:left">+ ${esc(GROUP[a.group] || a.group)}</td><td>${a.features}</td><td>${a.brier.toFixed(4)}</td><td>${pct(a.skillPct)}</td></tr>`;
    html += '</tbody></table>';
    const st = d.stability;
    html += `<div style="margin-top:8px;font-size:14px">${d.useContext
      ? `Context model <b>wins</b> (${d.contextMode === 'move' ? 'move-vs-sideways only — up/down still from calibration, because context showed no direction skill' : 'full'}), stable in both halves of the test period${d.saved ? ' and is now used live for Indian listings.' : ' — <b>Fit &amp; use</b> to apply it live.'}`
      : `Context model does not beat calibration reliably (needs ≥0.2 pts and a win in both halves${st ? `; halves: ${st.gainFirstHalf.toFixed(4)} / ${st.gainSecondHalf.toFixed(4)}` : ''}) — live keeps calibration.`}</div>`;
  } else if (d.contextNote) {
    html += `<div class="note" style="margin-top:8px">${esc(d.contextNote)}</div>`;
  }
  for (const [v, x] of Object.entries(d.variants || {})) {
    html += `<div class="note">Short window "${v === 'short12' ? 'last hour' : 'last 15 min'}": formula ${pct(x.skillPct.current)} · calibrated ${pct(x.skillPct.calibrated)} → ${x.useCalibrated ? 'calibrated used' : 'formula kept'}</div>`;
  }
  html += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px">
    ${renderReliability(d.reliability.current, 'Formula: predicted vs actual')}
    ${renderReliability(d.reliability.calibrated, 'Calibrated: predicted vs actual')}
    ${d.reliability.contextMove ? renderReliability(d.reliability.contextMove, 'Context (move): predicted vs actual') : ''}</div>
    <div class="note">Points on the dashed diagonal = honest probabilities. <span style="color:var(--up)">●</span> UP <span style="color:var(--down)">●</span> DOWN <span style="color:var(--muted)">●</span> SIDEWAYS (bins with ≥15 bars).</div>`;
  html += `<div style="margin-top:12px;font-size:13px"><b>Fitted table</b> (technical score → what followed)</div>
    <table><thead><tr><th>Score</th><th>UP</th><th>DOWN</th><th>SIDEWAYS</th><th>bars</th></tr></thead><tbody>`;
  for (const k of d.calibrationTable.buckets) {
    html += `<tr><td>${k.lo.toFixed(2)} … ${k.hi.toFixed(2)}</td><td>${(k.probUp * 100).toFixed(0)}%</td><td>${(k.probDown * 100).toFixed(0)}%</td><td>${(k.probSideways * 100).toFixed(0)}%</td><td>${k.n}</td></tr>`;
  }
  html += '</tbody></table>';
  if (d.saved) html += `<div class="note" style="margin-top:8px;color:var(--warn)">Saved. ${d.useCalibrated ? 'Live Call / Put now uses these probabilities for this interval.' : 'Stored, but live keeps the formula (calibration did not beat it).'}</div>`;
  html += `<div class="note" style="margin-top:8px">${esc(d.disclaimer)}</div>`;
  return html;
}

async function runEval(save) {
  const out = $('evOut');
  const status = $('evStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  status.textContent = save ? 'Replaying history and fitting calibration…' : 'Replaying history…';
  $('evRunBtn').disabled = $('evFitBtn').disabled = true;
  try {
    const raw = $('evSyms').value.trim();
    const d = await api('/api/model-eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: $('evInterval').value, symbols: raw || undefined, save }),
    });
    out.innerHTML = renderEval(d);
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    status.style.display = 'none';
    $('evRunBtn').disabled = $('evFitBtn').disabled = false;
  }
}
$('evRunBtn').addEventListener('click', () => runEval(false));
$('evFitBtn').addEventListener('click', () => runEval(true));
$('evShowBtn').addEventListener('click', async () => {
  const out = $('evOut');
  try {
    const { calibration } = await api('/api/calibration');
    const keys = Object.keys(calibration);
    if (!keys.length) {
      out.innerHTML = '<div class="note">No calibration saved yet — live Call / Put uses the formula. Run <b>Fit &amp; use calibration</b>.</div>';
      return;
    }
    let html = '<table><thead><tr><th>Interval</th><th>Fitted</th><th>Bars</th><th>Formula skill</th><th>Calibrated skill</th><th>Context skill</th><th>Live uses</th></tr></thead><tbody>';
    for (const k of keys) {
      const c = calibration[k];
      const sk = c.test?.skillPct || {};
      const f = (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
      html += `<tr><td>${esc(k)}</td><td>${esc((c.fittedAt || '').slice(0, 16).replace('T', ' '))}</td><td>${c.samples}</td><td>${f(sk.current)}</td><td>${f(sk.calibrated)}</td><td>${f(c.context?.useContext ? sk[c.context.mode === 'move' ? 'contextMove' : 'context'] : sk.contextMove)}</td><td>${c.context?.useContext ? `context (${esc(c.context.mode)}) + calibrated` : c.useCalibrated ? 'calibrated' : 'formula'}</td></tr>`;
    }
    html += '</tbody></table><div class="note">Refit regularly (e.g. weekly) — market behaviour drifts.</div>';
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
