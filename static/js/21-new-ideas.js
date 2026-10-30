// 21-new-ideas.js — Investing → New ideas test: low volatility, momentum + low volatility, market filter, index inclusion.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const niPc = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);

function niRender(r) {
  if (!r.ideas) {
    $('ideasOut').innerHTML = '<div class="note">Not run yet (it runs with the Saturday re-tests).</div>';
    return;
  }
  const b = r.baseline;
  const n = r.index;
  const row = (label, x, bold = false, extra = '') => `<tr><td style="text-align:left">${bold ? '<b>' : ''}${esc(label)}${bold ? '</b>' : ''}${extra}</td><td>${niPc(x.cagr)}</td><td><b>${niPc(x.cagrAfterTax)}</b></td><td>${niPc(x.early)}</td><td>${niPc(x.late)}</td><td style="color:var(--down)">${niPc(x.lateDd ?? x.maxDrawdown, 0)}</td><td style="color:var(--down)">${niPc(x.maxDrawdown, 0)}</td></tr>`;
  const head = '<thead><tr><th style="text-align:left">Version</th><th>A year</th><th>After tax</th><th>2010–17</th><th>2018–now</th><th>Worst fall since 2018</th><th>Worst fall (all)</th></tr></thead>';
  let html = `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid var(--warn);font-size:13px"><b>${r.ideas.some((i) => i.passed) ? 'An idea passed.' : 'No new idea beat Momentum 20.'}</b>
    Low volatility halves the falls but earns less than NIFTY; the momentum + calm blend and the market filter cut falls a little but gave up return. Momentum 20 alone (or the 80% index fund + 20% satellite plan) is still the best tested option.</div>`;
  html += `<div style="overflow-x:auto"><table style="font-size:12px">${head}<tbody>${row(b.label, b, true)}${n ? row('NIFTY 50 (with dividends)', { ...n, lateDd: null }) : ''}</tbody></table></div>`;
  for (const i of r.ideas) {
    html += `<div style="font-size:14px;margin-top:12px"><b>${esc(i.name)}</b> ${i.passed == null ? '<span class="note" style="display:inline">not testable</span>' : i.passed ? '<span style="color:var(--up);font-size:12px">passed</span>' : '<span style="color:var(--warn);font-size:12px">did not pass</span>'}</div>`;
    if (i.results) html += `<div style="overflow-x:auto"><table style="font-size:12px">${head}<tbody>${Object.entries(i.results).map(([k, x]) => row(x.label, x, k === i.pick, k === i.pick ? ' (picked on 2010–17)' : x.monthsInCash ? ` (${x.monthsInCash} months in cash)` : '')).join('')}</tbody></table></div>`;
    html += `<div class="note">${esc(i.verdict)}</div>`;
  }
  html += `<div class="note" style="margin-top:8px">${esc(r.from)} → ${esc(r.to)}. ${esc(r.note)} The pass rule was fixed before the test: beat NIFTY in both halves, stay within 1 point a year of Momentum 20 after tax, and a worst fall at least 5 points smaller since 2018. "Worst fall" for NIFTY is over the whole period.</div>`;
  $('ideasOut').innerHTML = html;
}
lazy('New ideas test', async () => {
  try { niRender(await api('/api/new-ideas')); } catch (e) { $('ideasOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
