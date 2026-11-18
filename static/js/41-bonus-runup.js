// 41-bonus-runup.js — Trading strategies → Bonus/split run-up: paper account that buys before a bonus/split ex-date and
// sells the day before it (loop 13). Planned trades, open positions, closed trades, how it was tested.
// Classic script (not a module): loaded in order by index.html.
const brRs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v || 0)).toLocaleString('en-IN')}`;
const brPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const brCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function bsrRender(st) {
  if (!st.startedAt) {
    $('bsrOut').innerHTML = '<div class="note">Starts with the next evening job (after NSE\'s daily file).</div>';
    return;
  }
  const s = st.summary || {};
  const cap = st.rules?.capital || 500000;
  const ret = st.value / cap - 1;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper account ${brRs(st.value)}</b> <span style="color:${brCol(ret)}">(${brPc(ret, 2)})</span> from ${brRs(cap)} on ${esc(st.startedAt)}
    · cash ${brRs(st.cash)} · ${s.open || 0} open · ${s.closed || 0} closed${s.closed ? `, won ${s.won}, ${brRs(s.realised)} realised, ${s.avgRetPct >= 0 ? '+' : ''}${s.avgRetPct.toFixed(2)}% a trade · after estimated tax ${brRs(s.afterTaxValue)}` : ''} · worst fall ${((s.maxDD || 0) * 100).toFixed(1)}%
    <div class="note" style="margin:4px 0 0">NSE data up to ${esc(st.lastDate)} · corporate-actions list checked each evening${st.fetchError ? ` · <span style="color:var(--down)">last check failed (${esc(st.fetchError)})</span>` : ''}.</div></div>`;
  html += `<div style="font-size:14px;margin-top:10px"><b>Planned</b> (bonus/split ex-dates on NSE that pass every filter)</div>`;
  html += st.upcoming?.length
    ? `<div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th style="text-align:left">Action</th><th>Buy at open</th><th>Sell at close</th><th>Ex-date</th><th>Sessions</th></tr></thead><tbody>${st.upcoming.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td style="text-align:left">${esc((x.subject || '').slice(0, 60))}</td><td>${esc(x.entryDate)}</td><td>${esc(x.exitDate)}</td><td>${esc(x.ex)}</td><td>${x.sessions}${x.late ? ' <span class="note">(late)</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="note">None right now — bonus/split ex-dates are announced a few weeks ahead at most.</div>';
  if (st.open?.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Open positions</b></div><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Entry</th><th>Shares</th><th>Last</th><th>Sell at close</th><th>Ex-date</th><th>P&amp;L</th></tr></thead><tbody>${st.open.map((p) =>
      `<tr><td style="text-align:left"><b>${esc(p.symbol)}</b></td><td>${esc(p.entryDate)}</td><td>₹${p.entry.toFixed(1)}</td><td>${p.shares}</td><td>₹${p.last.toFixed(1)}</td><td>${esc(p.exitDate)}</td><td>${esc(p.ex)}</td><td style="color:${brCol(p.last - p.entry)}">${brRs(p.shares * (p.last - p.entry))}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (st.closed?.length) {
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Closed trades (${st.closed.length}${s.late ? `, ${s.late} bought late` : ''})</summary><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Sold</th><th>Entry → exit</th><th>P&amp;L</th><th>Return</th></tr></thead><tbody>${[...st.closed].reverse().map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol)}${t.late ? ' <span class="note">late</span>' : ''}</td><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>₹${t.entry.toFixed(1)} → ₹${t.exit.toFixed(1)}</td><td style="color:${brCol(t.pnl)}">${brRs(t.pnl)}</td><td style="color:${brCol(t.retPct)}">${t.retPct >= 0 ? '+' : ''}${t.retPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table></details>`;
  }
  if (st.recentSkips?.length) {
    html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Recent bonus/splits not traded (${st.recentSkips.length})</summary><table style="font-size:12px"><tbody>${st.recentSkips.map((x) =>
      `<tr><td style="text-align:left">${esc(x.symbol)}</td><td>${esc(x.ex)}</td><td style="text-align:left" class="note">${esc(x.reason)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  const R = st.research;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> (real NSE data, survivorship-free, 0.35% + 0.30% costs for less-traded stocks, ₹5 lakh, 10 slots, Indian tax)</div>
      <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Period</th><th>Trades</th><th>Beat same-size stocks by</th><th>t</th><th>Account a year, after tax</th><th>Worst fall</th><th style="text-align:left"></th></tr></thead><tbody>${R.rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.period)}</td><td>${x.trades}</td><td>+${x.excessPct.toFixed(1)}% a trade</td><td>${x.t.toFixed(1)}</td><td>${brPc(x.account)}</td><td>${x.maxDD == null ? '–' : `${(x.maxDD * 100).toFixed(0)}%`}</td><td style="text-align:left" class="note">${esc(x.note)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Verdict: ${esc(R.verdict)}. Live change: NSE often lists the ex-date fewer than 10 sessions ahead, so a trade is bought at the next open after it appears ("late") — the research could not check this. Avoid buying ON the ex-date (−6% vs same-size stocks) or right after a bonus board meeting. Not advice.</div>`;
  }
  $('bsrOut').innerHTML = html;
}
lazy('Bonus/split run-up', async () => {
  try { bsrRender(await api('/api/bonus-runup')); } catch (e) { $('bsrOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
