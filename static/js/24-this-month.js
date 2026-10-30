// 24-this-month.js — Home → Do this month: the monthly action list for the tested investing rules, in rupees.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const tmAmt = (v) => `₹${Math.round(v || 0).toLocaleString('en-IN')}`;
const tmDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const tmList = (xs) => (xs?.length ? xs.map((x) => `<b>${esc(x)}</b>`).join(', ') : 'none');

function tmRender(r) {
  const tone = r.phase === 'hold' ? 'var(--line)' : 'var(--up)';
  let html = `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${tone};font-size:14px"><b>${r.phase === 'month-end' ? 'Month-end today' : r.phase === 'change-day' ? 'Change day today' : 'Nothing to do now'}.</b> ${esc(r.steps)}
    <div class="note" style="margin:4px 0 0">Month-end: <b>${esc(tmDate(r.monthEnd))}</b> · change at the open: <b>${esc(tmDate(r.changeDay))}</b></div></div>`;
  if (r.filter) html += `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">Market filter (NIFTY vs its 200-day average): <b style="color:${r.filter.inMarket ? 'var(--up)' : 'var(--down)'}">${r.filter.inMarket ? 'IN' : 'OUT'}</b> at the ${esc(r.filter.decidedAt || '–')} month-end${r.filter.flipLikely ? ` · <b>on the latest close it reads ${r.filter.latest ? 'IN' : 'OUT'}</b> — it changes only if that holds at the month-end` : ''}.</div>`;
  for (const p of r.plans) {
    if (!p.ready) {
      html += `<div style="margin-top:10px;font-size:14px"><b>${esc(p.name)}</b> <span class="note" style="display:inline">${esc(p.note || '')}</span></div>`;
      continue;
    }
    if (p.parts) {
      html += `<div style="margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--up)"><div style="font-size:14px"><b>${esc(p.name)}</b> <span class="note" style="display:inline">${p.key === 'steady' ? 'fewest losses in testing' : 'best balance in testing (Indian only)'} · ${tmAmt(p.money)}</span></div>
        <table style="font-size:12px;margin-top:4px"><tbody>${p.parts.map((x) => `<tr><td style="text-align:left;white-space:nowrap"><b>${esc(x.part)}</b></td><td style="white-space:nowrap">${tmAmt(x.amount)}</td><td style="text-align:left">${esc(x.what)}</td></tr>`).join('')}</tbody></table>
        <div class="note">${esc(p.next)} ${esc(p.rebalanceNote)}</div></div>`;
      continue;
    }
    html += `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--line)"><div style="font-size:14px"><b>${esc(p.name)}</b> <span class="note" style="display:inline">${p.key === 'm10' ? 'higher return, bigger falls' : 'the original momentum screen'} · ${tmAmt(p.perStock)} a stock for ${tmAmt(p.money)}</span></div>
      <div style="font-size:13px;margin-top:4px">${p.started ? 'Holding now' : 'Current list (paper starts at the next change)'}: ${tmList(p.hold)}</div>
      ${p.today ? `<div style="font-size:13px;margin-top:4px;color:var(--up)">Changed today: bought ${tmList(p.today.bought)} · sold ${tmList(p.today.sold)}</div>` : ''}
      ${p.likelyIn.length || p.likelyOut.length ? `<div style="font-size:13px;margin-top:4px">At the month-end (on the ${esc(p.previewAt || '')} prices): likely in ${tmList(p.likelyIn)} · likely out ${tmList(p.likelyOut)}</div>` : '<div class="note">No change expected at the month-end on the latest prices.</div>'}</div>`;
  }
  html += `<div class="note" style="margin-top:8px">${esc(r.note)}</div>`;
  $('monthOut').innerHTML = html;
}
async function tmLoad() {
  $('monthBtn').disabled = true;
  try { tmRender(await api(`/api/this-month?amount=${encodeURIComponent($('monthAmt').value || 100000)}`)); } catch (e) { $('monthOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('monthBtn').disabled = false; }
}
lazy('Do this month', tmLoad);
$('monthBtn').addEventListener('click', tmLoad);
