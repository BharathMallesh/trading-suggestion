// 11-day-results.js — Home → Daily results: one day's paper trades across all four strategies.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const drRs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : v > 0 ? '+₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
const drCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const drSym = (s) => esc(String(s || '').replace('.NS', ''));
const drPx = (v) => (v == null ? '–' : (+v).toFixed(v >= 1000 ? 1 : 2));
const DR_REASON = { stop: 'Hit stop', target: 'Hit target', '15:00': 'Closed 3 PM', '9:45': 'Closed 9:45', open: 'Still open', chandelier: 'Trailing stop', trail: 'Trailing stop' };
const drReason = (r) => esc(DR_REASON[r] || r || '–');
const drDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function drTradeTable(trades, extra = null) {
  return `<table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Side</th>${extra ? `<th>${extra.head}</th>` : '<th>Entry time</th>'}<th>Entry</th><th>Stop</th><th>Target</th><th>Exit</th><th>Shares</th><th>Result</th><th>Charges</th><th>Net</th></tr></thead><tbody>${trades.map((t) =>
    `<tr><td style="text-align:left"><b>${drSym(t.symbol)}</b>${t.seenLive === false ? ' <span class="note" style="display:inline" title="Not seen while the market was open; Yahoo may have revised the candles">(not seen live)</span>' : ''}</td><td>${t.side === 'short' ? 'Short (sell first)' : 'Buy'}</td><td>${extra ? extra.cell(t) : esc(t.time || '–')}</td><td>${drPx(t.entry)}</td><td>${drPx(t.stop)}</td><td>${drPx(t.target)}</td><td>${drPx(t.exit)}</td><td>${t.qty ?? '–'}</td><td>${drReason(t.reason)}</td><td>₹${Math.round(t.charges ?? 0).toLocaleString('en-IN')}</td><td style="color:${drCol(t.net)}"><b>${drRs(t.net)}</b></td></tr>`).join('')}</tbody></table>`;
}

function drRender(r) {
  let html = `<div style="font-size:16px;font-weight:700">${esc(drDate(r.date))}</div>`;
  if (r.note) html += `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">${esc(r.note)}</div>`;
  if (!r.tradingDay) return ($('dayOut').innerHTML = html);
  const sw = r.swing;
  const swOpenR = sw.open.reduce((a, t) => a + (t.r || 0), 0);
  // summary strip
  const box = (title, main, color, sub) => `<div style="flex:1 1 150px;padding:10px 12px;border:1px solid var(--line);border-radius:10px"><div style="font-size:12px;color:var(--muted)">${title}</div><div style="font-size:18px;font-weight:700;color:${color}">${main}</div><div style="font-size:12px;color:var(--muted)">${sub}</div></div>`;
  const v = r.vwap.variants.find((x) => x.key === 'video');
  const nV = r.vwap.variants.reduce((a, x) => a + x.trades.length, 0);
  html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
    ${box('YouTube intraday (video rules)', v.trades.length ? drRs(v.dayNet) : 'No trade', drCol(v.dayNet), `${nV} trade${nV === 1 ? '' : 's'} across the 3 versions`)}
    ${box('Breakfast', r.breakfast.trades.length ? drRs(r.breakfast.dayNet) : 'No trade', drCol(r.breakfast.dayNet), `${r.breakfast.trades.length} trade${r.breakfast.trades.length === 1 ? '' : 's'} · since start ${drRs(r.breakfast.total.net)}`)}
    ${box('Strong-stock swing', `${sw.open.length} open`, drCol(swOpenR), `${sw.bought.length} bought · ${sw.exited.length} exited · ${sw.newSignals.length} new signal${sw.newSignals.length === 1 ? '' : 's'}`)}
    ${r.dip?.started ? box('NIFTY dip-buy', r.dip.bought.length ? 'Bought' : r.dip.sold.length ? drRs(r.dip.sold.reduce((a, t) => a + t.net, 0)) : r.dip.holding?.stillOpen ? 'Holding' : 'No signal', r.dip.sold.length ? drCol(r.dip.sold.reduce((a, t) => a + t.net, 0)) : 'var(--muted)', `${r.dip.total.trades} closed since start${r.dip.deep && (r.dip.deep.bought.length || r.dip.deep.sold.length) ? ` · deep dip ${r.dip.deep.bought.length ? 'bought' : 'sold'} today` : ''}`) : ''}
  </div>`;

  // YouTube intraday
  html += '<div style="font-size:15px;margin-top:14px"><b>YouTube intraday (VWAP + 20 MA)</b></div>';
  for (const x of r.vwap.variants) {
    html += `<div style="font-size:13px;margin-top:8px"><b>${esc(x.label)}</b> · today <b style="color:${drCol(x.dayNet)}">${x.trades.length ? drRs(x.dayNet) : 'no trade'}</b>${x.trades.length ? ` (${x.wins} of ${x.trades.length} won)` : ''} · since start ${x.total.trades} trades, <span style="color:${drCol(x.total.net)}">${drRs(x.total.net)}</span></div>`;
    if (x.trades.length) html += `<div style="overflow-x:auto">${drTradeTable(x.trades)}</div>`;
  }

  // Breakfast
  html += '<div style="font-size:15px;margin-top:16px"><b>Breakfast (9:20 strongest sector)</b></div>';
  html += r.breakfast.trades.length
    ? `<div style="overflow-x:auto">${drTradeTable(r.breakfast.trades, { head: 'Why picked', cell: (t) => `${esc(t.sector || '')}: first 5 min ${t.firstMovePct >= 0 ? '+' : ''}${(t.firstMovePct ?? 0).toFixed(1)}% · NIFTY ${t.niftyMovePct >= 0 ? '+' : ''}${(t.niftyMovePct ?? 0).toFixed(2)}%` })}</div>
      <div class="note">Since start: ${r.breakfast.total.trades} trades, <span style="color:${drCol(r.breakfast.total.net)}">${drRs(r.breakfast.total.net)}</span>.</div>`
    : '<div class="note">No Breakfast trade on this day.</div>';

  // Swing
  html += `<div style="font-size:15px;margin-top:16px"><b>Strong-stock swing</b> <span class="note" style="display:inline">(${sw.version === 'improved' ? 'improved rules, 4 ATR trailing stop' : 'original rules'})</span></div>`;
  const swLines = [];
  for (const t of sw.bought) swLines.push(`<li><b>Bought ${drSym(t.symbol)}</b> at the open, ₹${drPx(t.entry)} (${esc(t.setup)}) · stop ₹${drPx(t.stop)}</li>`);
  for (const t of sw.exited) swLines.push(`<li><b>Sold ${drSym(t.symbol)}</b> at ₹${drPx(t.exit)} (${drReason(t.reason)}) after ${t.days} days · <b style="color:${drCol(t.r)}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)} R</b> (${(t.retPct * 100).toFixed(1)}%)</li>`);
  for (const t of sw.newSignals) swLines.push(`<li><b>New signal: ${drSym(t.symbol)}</b> (${esc(t.setup)}) · paper buys at the next open · stop ₹${drPx(t.stop)} (${t.riskPct.toFixed(1)}% risk)</li>`);
  for (const s of sw.heldSignals) swLines.push(`<li>${drSym(s)} signalled again, but it is already held on paper, so no new buy</li>`);
  if (!sw.signalsChecked && sw.open.length + sw.bought.length + sw.exited.length === 0) swLines.push('<li>No swing activity on this day.</li>');
  else if (!swLines.length) swLines.push('<li>No buys, exits or new signals on this day.</li>');
  html += `<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${swLines.join('')}</ul>`;
  if (sw.open.length) {
    html += `<div style="font-size:13px;margin-top:8px"><b>Positions held at the end of this day (${sw.open.length})</b> <span class="note" style="display:inline">· prices and R as of the latest close</span></div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Buy price</th><th>Latest price</th><th>Change after costs</th><th>In R</th><th>Trailing stop</th><th>Days held</th></tr></thead><tbody>${sw.open.map((t) =>
      `<tr><td style="text-align:left"><b>${drSym(t.symbol)}</b>${t.stillOpen ? '' : ' <span class="note" style="display:inline">(sold since)</span>'}</td><td>${esc(t.entryDate)}</td><td>${drPx(t.entry)}</td><td>${drPx(t.last)}</td><td style="color:${drCol(t.retPct)}">${t.retPct >= 0 ? '+' : ''}${(t.retPct * 100).toFixed(1)}%</td><td style="color:${drCol(t.r)}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}</td><td>${drPx(t.trail)}</td><td>${t.days}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">R = the profit or loss measured in units of the risk taken (entry minus first stop). A price alert sits at each trailing stop (My trades → Price alerts).</div>`;
  }
  // NIFTY dip-buy: standard version, then the deep-dip version (−5% in 10 days)
  const dp = r.dip;
  if (dp?.started) {
    html += '<div style="font-size:15px;margin-top:16px"><b>NIFTY dip-buy</b> <span class="note" style="display:inline">(index ETF, two versions on paper)</span></div>';
    const dipLines = (x, n) => {
      const dl = [];
      for (const t of x.bought) dl.push(`<li><b>Bought the NIFTY ETF</b> at the open, NIFTY ≈ ${Math.round(t.entry)} (after a ${t.signalChangePct.toFixed(1)}% fall in ${n} sessions)</li>`);
      for (const t of x.sold) dl.push(`<li><b>Sold</b> after ${t.days} days (${t.reason === 'bounce' ? 'bounce above the 5-day average' : '10-day limit'}) · <b style="color:${drCol(t.net)}">${t.retPct >= 0 ? '+' : ''}${t.retPct.toFixed(2)}% (${drRs(t.net)})</b></li>`);
      if (x.holding && !x.bought.length) dl.push(`<li>Holding since ${esc(x.holding.entryDate)}${x.holding.stillOpen ? ` · now ${x.holding.retPct >= 0 ? '+' : ''}${x.holding.retPct.toFixed(2)}% (${drRs(x.holding.net)})` : ' (sold since)'}</li>`);
      if (!dl.length) dl.push(`<li>${esc(x.status?.message || 'No signal on this day.')}</li>`);
      return `<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${dl.join('')}</ul><div class="note">Since start: ${x.total.trades} closed trade${x.total.trades === 1 ? '' : 's'}${x.total.trades ? `, ${x.total.wins} won, ${drRs(x.total.net)}` : ''}.</div>`;
    };
    html += `<div style="font-size:13px;margin-top:8px"><b>${esc(dp.label || 'Standard: −3% in 5 days')}</b></div>${dipLines(dp, 5)}`;
    if (dp.deep) html += `<div style="font-size:13px;margin-top:8px"><b>${esc(dp.deep.label)}</b></div>${dipLines(dp.deep, 10)}`;
  }
  // NIFTY short strangle (F&O)
  const fo = r.fo;
  if (fo) {
    html += '<div style="font-size:15px;margin-top:16px"><b>NIFTY short strangle (F&amp;O)</b> <span class="note" style="display:inline">(weekly options, 1 lot, paper only)</span></div>';
    const fl = [];
    for (const t of fo.opened) fl.push(`<li><b>Sold</b> the ${t.putStrike} put and ${t.callStrike} call (expiry ${esc(t.expiry)}) for ${t.credit.toFixed(1)} points, NIFTY at ${Math.round(t.spot)}</li>`);
    for (const t of fo.settled) fl.push(`<li><b>Expired</b>: NIFTY settled at ${Math.round(t.settle)} · <b style="color:${drCol(t.rupees)}">${drRs(t.rupees)}</b> a lot${t.breached ? ` (${esc(t.breached)} side hit)` : ' (both expired worthless)'}</li>`);
    for (const t of fo.holding.filter((x) => !fo.opened.length)) fl.push(`<li>Holding ${t.putStrike} / ${t.callStrike} to ${esc(t.expiry)}${t.markDate ? ` · ${drRs(t.rupees)} a lot on ${esc(t.markDate)}'s prices` : ''}</li>`);
    if (!fl.length) fl.push('<li>No position on this day.</li>');
    html += `<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6">${fl.join('')}</ul><div class="note">Since start: ${fo.total.weeks} week${fo.total.weeks === 1 ? '' : 's'} settled${fo.total.weeks ? `, ${drRs(fo.total.rupees)}` : ''}. NSE option prices arrive in the evening, so this runs one session behind (latest: ${esc(fo.lastDataDate || 'none yet')}).</div>`;
  }
  html += `<div class="note" style="margin-top:12px">Paper trades only, recorded up to ${esc(r.recordedUpTo || '–')}, ₹1,000 risk per intraday trade after all charges. A few days say nothing about whether a strategy works: see Trading strategies → Strategy comparison for the full record. Not investment advice.</div>`;
  $('dayOut').innerHTML = html;
}

async function drLoad(date) {
  $('dayOut').innerHTML = '<div class="note">Loading the paper records…</div>';
  $('dayBtn').disabled = true;
  try {
    const r = await api('/api/day-results' + (date ? `?date=${encodeURIComponent(date)}` : ''));
    const pick = $('dayPick');
    if (pick.options.length <= 1) for (const d of r.dates) pick.add(new Option(drDate(d), d));
    drRender(r);
  } catch (e) {
    $('dayOut').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  } finally {
    $('dayBtn').disabled = false;
  }
}
$('dayBtn').addEventListener('click', () => {
  $('dayPick').value = '';
  drLoad(null);
});
$('dayPick').addEventListener('change', () => drLoad($('dayPick').value || null));
