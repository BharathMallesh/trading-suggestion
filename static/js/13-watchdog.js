// 13-watchdog.js — Home → System check: did the unattended jobs (collect, paper records, server, backup, refit) run?
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const wdTime = (iso) => new Date(new Date(iso).getTime() + 19800_000).toISOString().slice(11, 16); // IST HH:MM

function wdRender(r) {
  const bad = r.checks.filter((c) => !c.ok);
  const todayIst = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
  const when = `checked ${wdTime(r.at)}${r.date !== todayIst ? ` on ${esc(r.date)}` : ''}`;
  const about = `Looked at the ${esc(r.session)} evening run${r.note ? ` (${esc(r.note)})` : ''}.`;
  if (!bad.length) {
    $('wdOut').innerHTML = `<div style="font-size:14px;color:var(--up)"><b>All systems OK</b> · ${when}</div><div class="note" style="margin-top:2px">${about}</div>`;
    return;
  }
  $('wdOut').innerHTML = `<div style="font-size:14px;color:var(--down)"><b>${bad.length} problem${bad.length > 1 ? 's' : ''} found</b> · ${when}</div><div class="note" style="margin-top:2px">${about}</div>
    ${bad.map((c) => `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;border-left:4px solid var(--down);background:var(--soft);font-size:13px">
      <div><b>${esc(c.name)}</b>: ${esc(c.detail)}</div><div style="margin-top:4px">How to fix: ${esc(c.fix)}</div></div>`).join('')}`;
}
lazy('System check', async () => {
  try { wdRender(await api('/api/watchdog')); } catch (e) { $('wdOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('wdBtn').addEventListener('click', async () => {
  $('wdBtn').disabled = true;
  $('wdOut').innerHTML = '<div class="note">Checking…</div>';
  try {
    wdRender(await api('/api/watchdog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) { $('wdOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('wdBtn').disabled = false; }
});
