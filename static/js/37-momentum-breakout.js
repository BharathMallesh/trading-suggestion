// 37-momentum-breakout.js — Trading strategies → Momentum breakout swing (E2): the paper account, today's signals, open positions,
// the research results that led to it. Classic script (not a module): loaded in order by index.html after 01-core.js.
const e2Rs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const e2Pc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const e2Col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function e2Render(st) {
  if (!st.startedAt) {
    $('e2Out').innerHTML = '<div class="note">Starts with the next evening job.</div>';
    return;
  }
  const s = st.summary;
  const ret = st.value / st.rules.capital - 1;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper account ${e2Rs(st.value)}</b> <span style="color:${e2Col(ret)}">(${e2Pc(ret)})</span> from ${e2Rs(st.rules.capital)} on ${esc(st.startedAt)}
    · cash ${e2Rs(st.cash)} · ${s.open} open · ${s.closed} closed${s.closed ? `, won ${s.won}, ${e2Rs(s.realised)} realised, ${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)} R a trade` : ''} · worst fall ${(st.maxDD * 100).toFixed(1)}%
    <div class="note" style="margin:4px 0 0">NSE data up to ${esc(st.lastDate)} · updated each evening after NSE's daily file.</div></div>`;
  html += `<div style="font-size:14px;margin-top:10px"><b>Signals on ${esc(st.lastDate)}</b> (first close at a 52-week high, top-25% momentum — bought on paper at that close)</div>`;
  html += st.signals.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Close</th><th>Stop</th><th>Risk to stop</th><th>Momentum rank</th><th>Paper account</th></tr></thead><tbody>${st.signals.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td>₹${x.close.toFixed(1)}</td><td>₹${x.stop.toFixed(1)}</td><td>${(x.riskPct * 100).toFixed(1)}%</td><td>${Math.round(x.momPct * 100)}</td><td>${x.taken ? 'bought' : st.startedAt > st.lastDate ? 'before the start' : 'no free slot / cash'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="note">No signal at the latest close.</div>';
  if (st.open.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Open positions</b></div><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Shares</th><th>Last</th><th>Stop / trail now</th><th>P&amp;L</th><th></th></tr></thead><tbody>${st.open.map((p) =>
      `<tr><td style="text-align:left"><b>${esc(p.symbol)}</b></td><td>${esc(p.entryDate)}</td><td>₹${p.entry.toFixed(1)}</td><td>${p.shares}</td><td>₹${p.last.toFixed(1)}</td><td>₹${p.trail.toFixed(1)}</td><td style="color:${e2Col(p.pnl)}">${e2Rs(p.pnl)}</td><td>${p.sellNextOpen ? '<b style="color:var(--down)">sell at the next open</b>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (st.closed.length) {
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Closed trades (${st.closed.length})</summary><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Sold</th><th>Entry → exit</th><th>Why</th><th>P&amp;L</th><th>R</th></tr></thead><tbody>${[...st.closed].reverse().map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol)}</td><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>₹${t.entry.toFixed(1)} → ₹${t.exit.toFixed(1)}</td><td>${esc(t.reason)}</td><td style="color:${e2Col(t.pnl)}">${e2Rs(t.pnl)}</td><td>${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  const R = st.research;
  const row = (x) => `<tr><td style="text-align:left">${esc(x.period)}</td><td>${x.trades}</td><td>${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(2)} R</td><td>${x.t.toFixed(1)}</td><td>${e2Pc(x.afterTaxPerYear)}</td><td>${(x.maxDD * 100).toFixed(0)}%</td><td style="text-align:left" class="note">${esc(x.note || '')}</td></tr>`;
  html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> (real NSE data, survivorship-free, 0.35% costs, ₹5 lakh, 1.25% risk a trade)</div>
    <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Period</th><th>Trades</th><th>Per trade</th><th>t</th><th>Account a year, after tax</th><th>Worst fall</th><th style="text-align:left"></th></tr></thead><tbody>
      ${row({ ...R.dev, note: 'found here (development)' })}${row({ ...R.val, note: `checked by an independent validator — ${R.val.note}` })}${row({ ...R.test, note: `final one-time test — ${R.test.note}; NIFTY made ${e2Pc(R.test.niftyPerYear)} a year` })}</tbody></table></div>
    <div class="note">Most of its edge is the momentum itself plus a wide trailing stop that keeps falls small; the breakout timing adds little, and since 2024 each trade has been only slightly positive. That is why it is on paper only — judge it after 30–50 closed trades. Not advice.</div>`;
  $('e2Out').innerHTML = html;
}
lazy('Momentum breakout', async () => {
  try { e2Render(await api('/api/e2-swing')); } catch (e) { $('e2Out').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
