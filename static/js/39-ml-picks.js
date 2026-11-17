// 39-ml-picks.js — Investing → ML stock picks: the walk-forward machine-learning ranking's paper portfolio
// (top 10 of the NSE top 200, re-made monthly), this month's list, holdings, and how it was tested.
// Classic script (not a module): loaded in order by index.html after 01-core.js.
const mlRs = (v) => `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const mlPc = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const mlCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function mlRender(st) {
  if (!st.startedAt) {
    $('mlOut').innerHTML = '<div class="note">Starts with the next evening job.</div>';
    return;
  }
  const ret = st.value / st.capital - 1;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>Paper portfolio ${mlRs(st.value)}</b> <span style="color:${mlCol(ret)}">(${mlPc(ret, 2)})</span> from ${mlRs(st.capital)} on ${esc(st.startedAt)}
    · ${st.rebalances.length} re-balance${st.rebalances.length === 1 ? '' : 's'} · worst fall ${((st.maxDD || 0) * 100).toFixed(1)}%
    <div class="note" style="margin:4px 0 0">NSE data up to ${esc(st.lastDate || '–')} · re-ranked once a month after the month-end · bought and sold at the first session after it (midpoint of open and close), 0.35% round-trip charges.</div></div>`;
  const p = st.pending;
  if (p) {
    html += `<div style="font-size:14px;margin-top:10px"><b>To buy at the next session</b> (ranking of ${esc(p.signal)}, 10% each)</div>
      <div style="font-size:13px">${p.list.map((s, i) => `<b>${esc(s)}</b> <span class="note" style="display:inline">#${p.ranks[i]}</span>`).join(' · ')}</div>
      ${p.sell?.length ? `<div class="note">Sell: ${p.sell.map(esc).join(', ')}</div>` : ''}`;
  }
  if (st.marks?.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Holdings</b></div><div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Price then</th><th>Last</th><th>Amount</th><th>Now</th><th>Result</th></tr></thead><tbody>${st.marks.map((m) =>
      `<tr><td style="text-align:left"><b>${esc(m.symbol)}</b></td><td>${esc(m.entryDate)}</td><td>₹${m.entry.toFixed(1)}</td><td>₹${m.last.toFixed(1)}</td><td>${mlRs(m.amount)}</td><td>${mlRs(m.value)}</td><td style="color:${mlCol(m.retPct)}">${m.retPct >= 0 ? '+' : ''}${m.retPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (st.rebalances.length) {
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Re-balances (${st.rebalances.length})</summary><table style="font-size:12px"><thead><tr><th style="text-align:left">Month-end</th><th>Traded</th><th style="text-align:left">Bought</th><th style="text-align:left">Sold</th><th>Value</th><th>Charges</th></tr></thead><tbody>${[...st.rebalances].reverse().map((r) =>
      `<tr><td style="text-align:left">${esc(r.signal)}</td><td>${esc(r.date)}</td><td style="text-align:left">${esc((r.buy || []).join(', ') || '–')}</td><td style="text-align:left">${esc((r.sell || []).join(', ') || '–')}</td><td>${mlRs(r.value)}</td><td>${mlRs(r.cost)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  const R = st.research;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> (${esc(R.method)}; ₹5 lakh, after tax)</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left"></th><th>2013–26 a year</th><th>Worst fall</th><th>2023–26 a year</th></tr></thead><tbody>${R.rows.map((x, i) =>
        `<tr><td style="text-align:left">${i ? '' : '<b>'}${esc(x.label)}${i ? '' : '</b>'}</td><td>${mlPc(x.all)}</td><td style="color:var(--down)">${(x.dd * 100).toFixed(0)}%</td><td>${mlPc(x.recent)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">${esc(R.ic)}. Verdict: ${esc(R.verdict)}. Judge the paper record after 12+ months. Not advice.</div>`;
  }
  $('mlOut').innerHTML = html;
}
lazy('ML stock picks', async () => {
  try { mlRender(await api('/api/ml-picks')); } catch (e) { $('mlOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
