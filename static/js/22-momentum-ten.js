// 22-momentum-ten.js — Investing → Momentum 10 + buffer (candidate): test vs Momentum 20, this month's list, paper portfolio.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const m10Pc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const m10Col = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function m10Render(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const a = b.results.m10;
    const m = b.results.m20;
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.beatsAllThree ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(b.verdict)}</b><div class="note" style="margin:4px 0 0">${esc(b.caution)}</div></div>`;
    const row = (x, bold) => `<tr><td style="text-align:left">${bold ? '<b>' : ''}${esc(x.label)}${bold ? '</b>' : ''}</td><td>${m10Pc(x.periods.dev.cagrAfterTax)}</td><td>${m10Pc(x.periods.val.cagrAfterTax)}</td><td><b>${m10Pc(x.periods.holdout.cagrAfterTax)}</b></td><td>${m10Pc(x.cagrAfterTax)}</td><td style="color:var(--down)">${m10Pc(x.periods.holdout.maxDrawdown, 0)}</td><td style="color:var(--down)">${m10Pc(x.maxDrawdown, 0)}</td><td>${Math.round(x.turnoverPerYear * 100)}%</td></tr>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">After tax, a year</th><th>2010–17 (search)</th><th>2018–22 (check)</th><th>2023→ (never seen)</th><th>All years</th><th>Worst fall 2023→</th><th>Worst fall (all)</th><th>Traded a year</th></tr></thead><tbody>
      ${row(a, true)}${row(m, false)}
      <tr><td style="text-align:left">NIFTY 50 (before tax)</td><td>${m10Pc(b.index.dev.cagr)}</td><td>${m10Pc(b.index.val.cagr)}</td><td>${m10Pc(b.index.holdout.cagr)}</td><td>–</td><td style="color:var(--down)">${m10Pc(b.index.holdout.maxDrawdown, 0)}</td><td>–</td><td>–</td></tr></tbody></table></div>`;
    const yrs = Object.keys(a.yearly).filter((y) => y >= '2018');
    html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Year (before tax)</th>${yrs.map((y) => `<th>${y}</th>`).join('')}</tr></thead><tbody>
      <tr><td style="text-align:left">Momentum 10 + buffer</td>${yrs.map((y) => `<td style="color:${m10Col(a.yearly[y])}">${m10Pc(a.yearly[y], 0)}</td>`).join('')}</tr>
      <tr><td style="text-align:left">Momentum 20</td>${yrs.map((y) => `<td style="color:${m10Col(m.yearly[y])}">${m10Pc(m.yearly[y], 0)}</td>`).join('')}</tr></tbody></table></div>
      <div class="note">${esc(b.from)} → ${esc(b.to)}. ${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p) {
    const cur = p.rebalances.at(-1);
    const value = p.curve.at(-1)?.value ?? p.capital;
    html += `<div style="font-size:14px;margin-top:12px"><b>Paper portfolio</b> (₹${Math.round(p.capital).toLocaleString('en-IN')} from ${esc(p.startedAt)}): ${cur ? `<b style="color:${m10Col(value - p.capital)}">₹${Math.round(value).toLocaleString('en-IN')}</b> (${m10Pc(value / p.capital - 1)}) · ${p.rebalances.length} monthly change${p.rebalances.length === 1 ? '' : 's'}` : 'starts at the first session after the month-end'}</div>`;
    if (cur && p.marks?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Holding</th><th>Since</th><th>Entry</th><th>Last</th><th>Result</th></tr></thead><tbody>${p.marks.map((x) => `<tr><td style="text-align:left">${esc(x.symbol)}</td><td>${esc(x.entryDate || '')}</td><td>₹${x.entry.toFixed(1)}</td><td>${x.last ? `₹${x.last.toFixed(1)}` : '–'}</td><td style="color:${m10Col(x.retPct)}"><b>${x.retPct >= 0 ? '+' : ''}${x.retPct.toFixed(1)}%</b></td></tr>`).join('')}</tbody></table></div>`;
    if (cur && (cur.bought?.length || cur.sold?.length)) html += `<div class="note">Last change (${esc(cur.date)}): bought ${esc(cur.bought.join(', ') || 'none')} · sold ${esc(cur.sold.join(', ') || 'none')}.</div>`;
    html += `<div style="font-size:13px;margin-top:8px">List from the ${esc(p.monthEnd)} close: ${p.list.map((x) => `<b>${esc(x.symbol)}</b>`).join(', ')}</div>`;
    if (p.preview?.list?.length) html += `<div class="note">On the ${esc(p.preview.date)} prices the next list would be: ${p.preview.list.map((x) => esc(x.symbol)).join(', ')} (made from the month-end close, swapped at the next open).</div>`;
  }
  $('m10Out').innerHTML = html;
}
lazy('Momentum 10', async () => {
  try { m10Render(await api('/api/momentum10')); } catch (e) { $('m10Out').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
