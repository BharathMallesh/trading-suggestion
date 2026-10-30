// 28-matrix-calendar.js — Trading strategies → Matrix calendar: the option-selling setup on real NSE prices, vs an iron condor.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const mcRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const mcCol = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');

function mcRender(r) {
  if (!r.all) {
    $('mcOut').innerHTML = '<div class="note">Not run yet (it runs with the Saturday re-tests).</div>';
    return;
  }
  const row = (label, p, bold = false) => `<tr><td style="text-align:left">${bold ? '<b>' : ''}${esc(label)}${bold ? '</b>' : ''}</td><td>${p.matrix.n}</td><td>${p.matrix.n ? `${Math.round(p.matrix.win * 100)}%` : '–'}</td>
    <td style="color:${mcCol(p.matrix.avg)}"><b>${mcRs(p.matrix.avg)}</b></td><td>${mcRs(p.matrix.avgWin)} / ${mcRs(p.matrix.avgLoss)}</td><td style="color:var(--down)">${mcRs(p.matrix.worst)}</td><td>${p.matrix.t?.toFixed(1) ?? '–'}</td>
    <td style="color:${mcCol(p.condor.avg)}">${mcRs(p.condor.avg)}</td><td style="color:var(--down)">${mcRs(p.condor.worst)}</td></tr>`;
  const head = '<thead><tr><th style="text-align:left"></th><th>Weeks</th><th>Won</th><th>Matrix: average a week</th><th>Average win / loss</th><th>Worst week</th><th>t</th><th>Iron condor: average</th><th>Condor worst</th></tr></thead>';
  let html = `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${r.passed ? 'var(--up)' : 'var(--warn)'};font-size:13px"><b>${esc(r.verdict)}</b></div>`;
  html += `<div style="overflow-x:auto"><table style="font-size:12px">${head}<tbody>${row('All weeks', r.all, true)}${Object.entries(r.halves).map(([k, v]) => row(k, v)).join('')}${Object.entries(r.byVix).map(([k, v]) => row(k, v)).join('')}</tbody></table></div>`;
  html += `<div style="overflow-x:auto;margin-top:6px"><table style="font-size:12px">${head}<tbody>${Object.entries(r.byYear).map(([k, v]) => row(k, v)).join('')}</tbody></table></div>`;
  if (r.worst?.length) html += `<div class="note">Worst weeks (₹ a set, matrix vs condor): ${r.worst.map((w) => `${esc(w.entryDate)} NIFTY ${w.move >= 0 ? '+' : ''}${(w.move * 100).toFixed(1)}% ${mcRs(w.matrix)} vs ${mcRs(w.condor)}`).join(' · ')}</div>`;
  const last = r.recent?.[0];
  if (last) html += `<div class="note">Latest week (${esc(last.entryDate)} → ${esc(last.exitDate)}): ${last.legs.map((l) => `${l.qty > 0 ? 'buy' : 'sell'} ${Math.abs(l.qty)} × ${l.strike} ${l.typ} (${esc(l.expiry)}) at ${l.entry.toFixed(1)}`).join(' · ')} → ${mcRs(last.matrix)}</div>`;
  html += `<div class="note" style="margin-top:6px">${r.weeks} weeks, ${esc(r.from || '')} → ${esc(r.to || '')}; skipped: ${Object.entries(r.skippedWhy || {}).map(([k, v]) => `${v} (${esc(k)})`).join(', ') || 'none'}. ${esc(r.note)}${r.blocked ? ` Download stopped early: ${esc(r.blocked)}` : ''}</div>`;
  $('mcOut').innerHTML = html;
}
lazy('Matrix calendar', async () => {
  try { mcRender(await api('/api/matrix-calendar')); } catch (e) { $('mcOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
