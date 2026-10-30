// 25-india-mix.js — Investing → India mix: ⅓ Nifty Next 50 / ⅓ gold / ⅓ Momentum 10 — test and paper portfolio.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const imPc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const imCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');
const imAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;

function imRender(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const rows = [b.results.mix, b.results.simple, b.results.nifty];
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${b.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(b.verdict)}</b><div class="note" style="margin:4px 0 0">${esc(b.caution)}</div></div>`;
    html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Before tax, a year</th><th>2010–17</th><th>2018–22</th><th>2023→</th><th>All years</th><th>Worst fall</th><th>Worst month</th><th>Months up</th><th>2-year stretches up</th></tr></thead><tbody>${rows.map((x, i) =>
      `<tr><td style="text-align:left">${i ? '' : '<b>'}${esc(x.label)}${i ? '' : '</b>'}</td><td>${imPc(x.dev.cagr)}</td><td>${imPc(x.val.cagr)}</td><td>${imPc(x.holdout.cagr)}</td><td><b>${imPc(x.all.cagr)}</b></td><td style="color:var(--down)">${imPc(x.all.maxDrawdown, 0)}</td><td style="color:var(--down)">${imPc(x.all.worstMonth)}</td><td>${imPc(x.all.upMonths, 0)}</td><td>${imPc(x.all.pos24, 0)}</td></tr>`).join('')}</tbody></table></div>`;
    const m = b.results.mix;
    const n = b.results.nifty;
    const yrs = Object.keys(m.yearly);
    html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px"><thead><tr><th style="text-align:left">Year</th>${yrs.map((y) => `<th>${y.slice(2)}</th>`).join('')}</tr></thead><tbody>
      <tr><td style="text-align:left">India mix</td>${yrs.map((y) => `<td style="color:${imCol(m.yearly[y])}">${imPc(m.yearly[y], 0)}</td>`).join('')}</tr>
      <tr><td style="text-align:left">NIFTY</td>${yrs.map((y) => `<td style="color:${imCol(n.yearly[y])}">${imPc(n.yearly[y], 0)}</td>`).join('')}</tr></tbody></table></div>
      <div class="note">${esc(b.from)} → ${esc(b.to)}. ${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (it runs with the Saturday re-tests).</div>';
  if (p) {
    const cur = p.rebalances.at(-1);
    const value = p.curve.at(-1)?.value ?? p.capital;
    html += `<div style="font-size:14px;margin-top:12px"><b>Paper portfolio</b> (${imAmt(p.capital)} from ${esc(p.startedAt)}): ${cur ? `<b style="color:${imCol(value - p.capital)}">${imAmt(value)}</b> (${imPc(value / p.capital - 1, 2)}) · ${p.rebalances.length} monthly re-balance${p.rebalances.length === 1 ? '' : 's'}` : 'starts at the first session after the month-end'}</div>`;
    if (cur && p.marks?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Holding</th><th>Amount at re-balance</th><th>Entry</th><th>Last</th><th>Result</th></tr></thead><tbody>${p.marks.map((x) => `<tr><td style="text-align:left">${esc(x.name)}</td><td>${imAmt(x.amount)}</td><td>${x.entry ? `₹${x.entry.toFixed(1)}` : '–'}</td><td>${x.last ? `₹${x.last.toFixed(1)}` : '–'}</td><td style="color:${imCol(x.retPct)}">${x.retPct >= 0 ? '+' : ''}${x.retPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('indiaOut').innerHTML = html;
}
lazy('India mix', async () => {
  try { imRender(await api('/api/india-mix')); } catch (e) { $('indiaOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
