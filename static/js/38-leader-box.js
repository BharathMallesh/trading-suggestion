// 38-leader-box.js — Trading strategies → Leader box breakout: the best version built from the popular YouTube swing
// strategies (Darvas box + Minervini template + Weinstein 30-week exit). Paper account, signals for the next open,
// open positions, closed trades, how it was tested. Classic script (not a module): loaded in order by index.html.
const lbRs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const lbPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const lbCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function lbbRender(st) {
  if (!st.startedAt) {
    $('lbbOut').innerHTML = '<div class="note">Starts with the next evening job (after NSE\'s daily file).</div>';
    return;
  }
  const s = st.summary;
  const ret = st.value / st.rules.capital - 1;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper account ${lbRs(st.value)}</b> <span style="color:${lbCol(ret)}">(${lbPc(ret)})</span> from ${lbRs(st.rules.capital)} on ${esc(st.startedAt)}
    · cash ${lbRs(st.cash)} · ${s.open} open · ${s.closed} closed${s.closed ? `, won ${s.won}, ${lbRs(s.realised)} realised, ${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)} R a trade` : ''} · worst fall ${(st.maxDD * 100).toFixed(1)}%
    <div class="note" style="margin:4px 0 0">NSE data up to ${esc(st.lastDate)} · NIFTY is <b style="color:${st.niftyAbove200 ? 'var(--up)' : 'var(--down)'}">${st.niftyAbove200 ? 'above' : 'below'}</b> its 200-day average${st.niftyAbove200 ? '' : ' — no new buys until it recovers'} · updated each evening.</div></div>`;
  html += `<div style="font-size:14px;margin-top:10px"><b>Buy at the next open</b> (box breakouts on ${esc(st.lastDate)} that passed every filter, strongest first)</div>`;
  html += st.signals.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Close</th><th>Stop (box floor, ≤ 8%)</th><th>Risk to stop</th><th>Strength rank</th><th>Size (₹)</th></tr></thead><tbody>${st.signals.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td>₹${x.close.toFixed(1)}</td><td>₹${x.stop.toFixed(1)}</td><td>${(x.riskPct * 100).toFixed(1)}%</td><td>${Math.round(x.rs)}</td><td>${lbRs(x.wantValue)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Not bought if it opens at or below the stop. If cash is short, the weakest holding is swapped out when it ranks ≥ 20 points lower.</div>`
    : '<div class="note">No signal at the latest close.</div>';
  if (st.open.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Open positions</b></div><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Shares</th><th>Last</th><th>Stop</th><th>P&amp;L</th><th>Strength</th><th></th></tr></thead><tbody>${st.open.map((p) =>
      `<tr><td style="text-align:left"><b>${esc(p.symbol)}</b></td><td>${esc(p.entryDate)}</td><td>₹${p.entry.toFixed(1)}</td><td>${p.shares}</td><td>₹${p.last.toFixed(1)}</td><td>₹${p.stop.toFixed(1)}</td><td style="color:${lbCol(p.pnl)}">${lbRs(p.pnl)}</td><td>${p.rs == null ? '–' : Math.round(p.rs)}</td><td>${p.sellNextOpen ? `<b style="color:var(--down)">sell at the next open (${esc(p.exitReason || 'exit')})</b>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (st.closed.length) {
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Closed trades (${st.closed.length})</summary><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Sold</th><th>Entry → exit</th><th>Why</th><th>P&amp;L</th><th>R</th></tr></thead><tbody>${[...st.closed].reverse().map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol)}</td><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>₹${t.entry.toFixed(1)} → ₹${t.exit.toFixed(1)}</td><td>${esc(t.reason)}</td><td style="color:${lbCol(t.pnl)}">${lbRs(t.pnl)}</td><td>${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  const R = st.research;
  const row = (x) => `<tr><td style="text-align:left">${esc(x.period)}</td><td>${x.trades}</td><td>${x.perTradePct >= 0 ? '+' : ''}${x.perTradePct.toFixed(1)}%</td><td>${x.t.toFixed(1)}</td><td>${lbPc(x.afterTaxPerYear)}</td><td>${(x.maxDD * 100).toFixed(0)}%</td><td style="text-align:left" class="note">${esc(x.note || '')}</td></tr>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> (real NSE data, survivorship-free, 0.35% costs, ₹5 lakh, Indian tax)</div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Period</th><th>Trades</th><th>Per trade</th><th>t</th><th>Account a year, after tax</th><th>Worst fall</th><th style="text-align:left"></th></tr></thead><tbody>
      ${row(R.dev)}${row(R.val)}${row(R.test)}</tbody></table></div>
    <div class="note">Of 45 popular YouTube strategies tested, none passed; this combines the parts that showed some edge. It is a boom-market system (+80% in 2014, +60% in 2021) that goes flat in weak years. Judge it after 30–50 closed trades. Not advice.</div>`;
  $('lbbOut').innerHTML = html;
}
lazy('Leader box breakout', async () => {
  try { lbbRender(await api('/api/lbb-swing')); } catch (e) { $('lbbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
