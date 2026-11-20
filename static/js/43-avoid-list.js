// 43-avoid-list.js — Investing → Don't buy now: active warnings from NSE's daily files (loop 14), and the shared
// "⚠ don't buy now" badge used wherever the app lists stocks to buy (Momentum 10, India mix, Global mix, Do this month).
// Usage in a card: mark a stock with data-sym="SYM" (badge after it) or a block with data-avoid-list="A,B,C" (one line
// listing the flagged ones), then call avoidMark(container) after setting innerHTML. The list loads once per page.
// Classic script (not a module): loaded in order by index.html; other cards call avoidMark only after their data loads.
let AVOID_P = null;
function avoidLoad() {
  if (!AVOID_P) AVOID_P = api('/api/avoid-list').catch((e) => ({ active: [], bySymbol: {}, fetchError: `could not load the list: ${e.message}` }));
  return AVOID_P;
}
const avSym = (s) => String(s || '').replace(/\.NS$/i, '').trim();
const avTitle = (rs) => rs.map((r) => `${r.reason} (until ${r.until})`).join('; ');
function avoidBadgeHtml(rs) {
  return `<span class="avoidBadge" title="${esc(avTitle(rs))} — research caution, not advice" style="display:inline-block;margin-left:4px;padding:0 6px;border-radius:999px;border:1px solid var(--warn);color:var(--warn);font-size:10px;font-weight:600;white-space:nowrap">⚠ don't buy now</span>`;
}
async function avoidMark(el) {
  if (!el) return;
  const d = await avoidLoad();
  const by = d.bySymbol || {};
  for (const n of el.querySelectorAll('[data-sym]')) {
    if (n.dataset.avoidDone) continue;
    n.dataset.avoidDone = '1';
    const rs = by[avSym(n.dataset.sym)];
    if (rs?.length) n.insertAdjacentHTML('afterend', avoidBadgeHtml(rs));
  }
  for (const n of el.querySelectorAll('[data-avoid-list]')) {
    if (n.dataset.avoidDone) continue;
    n.dataset.avoidDone = '1';
    const hit = n.dataset.avoidList.split(',').map(avSym).filter((s) => by[s]?.length);
    if (hit.length) n.innerHTML = `<span style="color:var(--warn);font-size:12px">⚠ Don't buy now: ${hit.map((s) => `<b>${esc(s)}</b> <span class="note" style="display:inline">(${esc(avTitle(by[s]))})</span>`).join(' · ')} — research caution, not advice.</span>`;
  }
}

const AV_CODE_ORDER = ['uc3', 'bandCut', 't2t', 'ltasm', 'stasm'];
function avoidRender(d) {
  const act = d.active || [];
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px"><b>${act.length} active warning${act.length === 1 ? '' : 's'}</b> (${new Set(act.map((x) => x.symbol)).size} stocks)
    <div class="note" style="margin:4px 0 0">NSE daily files read to ${esc(d.lastDate || '–')} · ASM lists ${d.asm ? `${d.asm.long.length} long-term / ${d.asm.short.length} short-term as of ${esc(d.asm.asOf || d.asm.savedOn)}${d.asm.baselineOnly ? ' (first list saved as the baseline — new entries are flagged from the next evening)' : ''}` : 'not loaded yet'}${d.fetchError ? ` · <span style="color:var(--down)">last check had a problem (${esc(d.fetchError)})</span>` : ''}.</div></div>`;
  if (act.length) {
    const sorted = [...act].sort((a, b) => AV_CODE_ORDER.indexOf(a.code) - AV_CODE_ORDER.indexOf(b.code) || b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
    html += `<div style="overflow-x:auto;margin-top:8px;max-height:420px;overflow-y:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Stock</th><th style="text-align:left">Reason</th><th>Event</th><th>Avoid from</th><th>Until</th><th style="text-align:left">Detail</th></tr></thead><tbody>${sorted.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td style="text-align:left">${esc(x.reason)}</td><td>${esc(x.date)}</td><td>${esc(x.since)}</td><td>${esc(x.until)}</td><td style="text-align:left" class="note">${esc(x.detail || '')}${x.code === 'bandCut' && x.since ? ' · strongest in the first 5 sessions' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  } else html += '<div class="note" style="margin-top:6px">No active warnings (or the evening job has not run yet).</div>';
  const R = d.research;
  if (R) {
    html += `<div style="font-size:14px;margin-top:12px"><b>How it was tested</b> — return vs stocks of the same size after costs, from the next open (${esc(R.periods)})</div>
      <div style="overflow-x:auto"><table style="font-size:12px;white-space:nowrap"><thead><tr><th style="text-align:left">Warning</th><th>2010–22</th><th>2023–24</th><th>2025–26</th></tr></thead><tbody>${R.rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.rule)}</td><td style="color:var(--down)">${x.dev.toFixed(1)}%</td><td style="color:var(--down)">${x.val.toFixed(1)}%</td><td style="color:var(--down)">${x.test.toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>
      <div class="note">${esc(R.note)} ${esc(R.failed)} Not advice.</div>`;
  }
  $('avoidOut').innerHTML = html;
}
lazy("Don't buy now", async () => {
  try { avoidRender(await avoidLoad()); } catch (e) { $('avoidOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
