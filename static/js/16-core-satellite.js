// 16-core-satellite.js — Investing → Core + satellite (paper): 80% index fund + 20% swing vs 100% NIFTY.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const csAmt = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const csPc = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
const csCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function csRender(r) {
  if (!r?.mixes) return ($('csOut').innerHTML = '<div class="note">Not calculated yet: it starts with the evening run (or press Recalculate now).</div>');
  const best = r.mixes.find((m) => m.key === 'm80');
  const idx = r.mixes.find((m) => m.key === 'nifty');
  let html = `<div style="font-size:14px"><b>Paper account of ${csAmt(r.capital)}</b> from ${esc(r.startedAt)} to ${esc(r.asOf)}</div>
    <div style="overflow-x:auto"><table style="font-size:13px"><thead><tr><th style="text-align:left">Plan</th><th>Value now</th><th>Return</th><th>Worst fall</th></tr></thead><tbody>${r.mixes.map((m) =>
      `<tr><td style="text-align:left">${m.key === 'm80' ? '<b>' : ''}${esc(m.label)}${m.key === 'm80' ? '</b>' : ''}</td><td>${csAmt(m.value)}</td><td style="color:${csCol(m.returnPct)}"><b>${csPc(m.returnPct)}</b></td><td>${m.worstFallPct.toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>
    <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">So far the 80 / 20 plan is <b style="color:${csCol(best.returnPct - idx.returnPct)}">${csPc(best.returnPct - idx.returnPct)}</b> against simply holding NIFTY;
      the swing slice on its own is <b style="color:${csCol(r.swingSlice.returnPct)}">${csPc(r.swingSlice.returnPct)}</b>. The backtests suggest the mix earns about the same as NIFTY with milder bad years — it takes years, not weeks, to see whether that holds.</div>`;
  if (r.swingSlice.positions.length) html += `<div style="font-size:13px"><b>Swing slice positions</b> (share of the slice)</div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Share of slice</th><th>Change after costs</th><th>Status</th></tr></thead><tbody>${r.swingSlice.positions.map((p) =>
    `<tr><td style="text-align:left">${esc(p.symbol.replace('.NS', ''))}</td><td>${esc(p.entryDate)}</td><td>${(p.value * 100).toFixed(0)}%</td><td style="color:${csCol(p.retPct)}">${csPc(p.retPct)}</td><td>${p.open ? 'held' : 'sold'}</td></tr>`).join('')}</tbody></table></div>`;
  const recent = r.curve.slice(-10).reverse();
  html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Day by day (last ${recent.length} sessions)</summary><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Day</th><th>80 / 20</th><th>50 / 50</th><th>100% NIFTY</th></tr></thead><tbody>${recent.map((d) =>
    `<tr><td style="text-align:left">${esc(d.date)}</td><td>${csAmt(d.m80)}</td><td>${csAmt(d.m50)}</td><td>${csAmt(d.nifty)}</td></tr>`).join('')}</tbody></table></div></details>
    <div class="note">${esc(r.note)}</div>`;
  $('csOut').innerHTML = html;
}
lazy('Core + satellite', async () => {
  try { csRender(await api('/api/core-satellite')); } catch (e) { $('csOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('csRunBtn').addEventListener('click', async () => {
  $('csRunBtn').disabled = true;
  $('csOut').innerHTML = '<div class="note">Recalculating from the swing paper record and NIFTY…</div>';
  try { csRender(await api('/api/core-satellite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })); } catch (e) { $('csOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('csRunBtn').disabled = false; }
});
