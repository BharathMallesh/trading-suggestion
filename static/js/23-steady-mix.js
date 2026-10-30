// 23-steady-mix.js — Investing → Steady mix: 30% Momentum 10 with filter / 10% gold / 60% liquid — test and paper portfolio.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const smPc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const smCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');
const smAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;

function smRender(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const m = b.results.mix;
    const n = b.results.nifty;
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(b.verdict)}</b><div class="note" style="margin:4px 0 0">${esc(b.caution)}</div></div>`;
    const row = (x, bold) => `<tr><td style="text-align:left">${bold ? '<b>' : ''}${esc(x.label)}${bold ? '</b>' : ''}</td><td>${smPc(x.dev.cagr)}</td><td>${smPc(x.val.cagr)}</td><td>${smPc(x.holdout.cagr)}</td><td><b>${smPc(x.all.cagr)}</b></td><td style="color:var(--down)">${smPc(x.all.maxDrawdown, 0)}</td><td style="color:var(--down)">${smPc(x.all.worstMonth)}</td><td>${smPc(x.all.upMonths, 0)}</td><td>${smPc(x.all.pos12, 0)}</td><td><b>${smPc(x.all.pos24, 0)}</b></td></tr>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Before tax, a year</th><th>2010–17 (picked on)</th><th>2018–22</th><th>2023→</th><th>All years</th><th>Worst fall</th><th>Worst month</th><th>Months up</th><th>12-month stretches up</th><th>2-year stretches up</th></tr></thead><tbody>${row(m, true)}${row(n, false)}</tbody></table></div>`;
    const yrs = Object.keys(m.yearly);
    html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Year</th>${yrs.map((y) => `<th>${y.slice(2)}</th>`).join('')}</tr></thead><tbody>
      <tr><td style="text-align:left">Steady mix</td>${yrs.map((y) => `<td style="color:${smCol(m.yearly[y])}">${smPc(m.yearly[y], 0)}</td>`).join('')}</tr>
      <tr><td style="text-align:left">NIFTY</td>${yrs.map((y) => `<td style="color:${smCol(n.yearly[y])}">${smPc(n.yearly[y], 0)}</td>`).join('')}</tr></tbody></table></div>
      <div class="note">${esc(b.from)} → ${esc(b.to)}. ${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p) {
    const cur = p.rebalances.at(-1);
    const value = p.curve.at(-1)?.value ?? p.capital;
    const f = p.filter || {};
    html += `<div style="margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">Market filter at the ${esc(f.monthEnd || '–')} month-end: <b style="color:${f.inMarket ? 'var(--up)' : 'var(--down)'}">${f.inMarket ? 'IN — the stock part holds the Momentum 10 stocks' : 'OUT — the stock part waits in the liquid fund'}</b>${f.today != null && f.today !== f.inMarket ? ` · on the latest close it would be <b>${f.today ? 'IN' : 'OUT'}</b> (decided at the month-end)` : ''}.</div>`;
    html += `<div style="font-size:14px;margin-top:10px"><b>Paper portfolio</b> (${smAmt(p.capital)} from ${esc(p.startedAt)}): ${cur ? `<b style="color:${smCol(value - p.capital)}">${smAmt(value)}</b> (${smPc(value / p.capital - 1, 2)}) · ${p.rebalances.length} monthly re-balance${p.rebalances.length === 1 ? '' : 's'}` : 'starts at the first session after the month-end'}</div>`;
    if (cur && p.marks?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Holding</th><th>Amount at re-balance</th><th>Entry</th><th>Last</th><th>Result</th></tr></thead><tbody>${p.marks.map((x) => `<tr><td style="text-align:left">${esc(x.name)}</td><td>${smAmt(x.amount)}</td><td>${x.entry ? `₹${x.entry.toFixed(1)}` : '–'}</td><td>${x.last ? `₹${x.last.toFixed(1)}` : '–'}</td><td style="color:${smCol(x.retPct)}">${x.retPct >= 0 ? '+' : ''}${x.retPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('steadyOut').innerHTML = html;
}
lazy('Steady mix', async () => {
  try { smRender(await api('/api/steady-mix')); } catch (e) { $('steadyOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
