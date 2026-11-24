// 47-algo-plan.js — Home → Today's algo plan: the rules that passed testing as one checklist for the next session.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// The app never places orders; ticks are saved on this Mac (data/algo-plan.json) and change no paper record.
const apRs = (v) => (v == null ? '–' : `₹${Math.round(v).toLocaleString('en-IN')}`);
const apDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const AP_SUB = { ipoCard: 'ipo', bsrCard: 'bsr' }; // cards that live in a Trading strategies sub-tab

/** Show another card (switching tab / sub-tab), open it and scroll to it. */
function apGoCard(id) {
  const sec = $(id);
  if (!sec) return;
  if (AP_SUB[id]) {
    try { localStorage.setItem('strategySub', AP_SUB[id]); } catch { /* this view only */ }
  }
  if (sec.dataset.view) showView(sec.dataset.view);
  openCard(sec.querySelector('h2'));
  sec.scrollIntoView({ block: 'start' });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-goto]');
  if (!a) return;
  e.preventDefault();
  apGoCard(a.dataset.goto);
});

let AP_LAST = null;
function apRender(p) {
  AP_LAST = p;
  const real = p.actions.filter((a) => !a.paper && !a.skip);
  const tone = p.nothing ? 'var(--line)' : 'var(--up)';
  let html = `<div style="padding:10px 12px;border-radius:10px;border:2px solid ${tone};font-size:15px;overflow-wrap:anywhere"><b>${esc(p.nothing ? `Nothing to do ${p.sessionIsToday ? 'today' : `on ${apDay(p.date)}`}` : `${real.length} thing${real.length === 1 ? '' : 's'} to do ${p.sessionIsToday ? 'today' : `on ${apDay(p.date)}`}`)}</b>
    <div class="note" style="margin:4px 0 0">${esc(p.summary)}</div>
    <div style="font-size:12px;margin-top:6px"><b>🔒 ${esc(p.noBroker)}</b></div></div>`;
  for (const w of p.warnings) html += `<div class="xpBox ${w.level === 'expiry' ? 'expiry' : 'eve'}" style="margin-top:8px"><b>⚠ ${esc(w.title)}</b> — ${esc(w.text)} <a href="#" data-goto="researchCard">Research summary</a></div>`;
  for (const i of p.info) html += `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">${esc(i.text)}</div>`;
  if (p.actions.length) {
    html += `<div style="font-size:14px;margin-top:10px"><b>Checklist for ${esc(apDay(p.date))}</b> <span class="note" style="display:inline">tick when done — saved on this Mac only</span></div>`;
    for (const a of p.actions) {
      const tags = `${a.paper ? '<span class="apTag paper">PAPER ONLY</span>' : ''}${a.skip ? '<span class="apTag skip">SKIP</span>' : ''}<span class="apTag">${esc({ 'india-mix': 'India mix', momentum10: 'Momentum 10', ipo: 'IPO apply', bonus: 'Bonus/split run-up' }[a.kind] || a.kind)}</span>`;
      html += `<label class="apAct${a.done ? ' done' : ''}${a.skip ? ' skip' : ''}"><input type="checkbox" data-ap="${esc(a.id)}" ${a.done ? 'checked' : ''} />
        <div><div class="apTitle"><b>${esc(a.title)}</b>${a.amount ? ` ≈ <b>${apRs(a.amount)}</b>` : ''} ${tags}</div>
          ${a.detail ? `<div style="margin-top:2px">${esc(a.detail)}</div>` : ''}
          ${a.skip ? `<div style="margin-top:2px;color:var(--warn)">${esc(a.skip)}</div>` : ''}
          ${a.small || a.flags?.length ? `<div style="margin-top:2px;color:var(--warn)">${a.small ? `⚠ Under ₹1,000: charges ${a.chargesPct.toFixed(2)}% of this order. ` : ''}${(a.flags || []).map((f) => `⚠ ${esc(f)}`).join(' ')}</div>` : ''}
          <div class="note" style="margin:3px 0 0"><b>Why:</b> ${esc(a.why)} <a href="#" data-goto="${esc(a.link)}">paper record</a></div></div></label>`;
    }
  }
  if (p.sizing?.length) {
    const flagged = p.sizing.filter((z) => z.flags.length);
    html += `<details style="margin-top:10px;font-size:13px"${flagged.length ? ' open' : ''}><summary><b>Momentum 10 in whole shares at ${apRs(p.settings.capital)}</b> — slot ≈ ${apRs(p.sizing[0].slot)} a stock${flagged.length ? ` · <span style="color:var(--warn)">⚠ ${flagged.length} flagged</span>` : ' · all fit'}</summary>
      <div style="overflow-x:auto"><table style="font-size:12px;margin-top:4px"><thead><tr><th style="text-align:left">Stock</th><th>Price</th><th>Shares</th><th>Value</th><th>Weight off</th><th style="text-align:left">Flag</th></tr></thead><tbody>${p.sizing.map((z) =>
        `<tr><td style="text-align:left"><b>${esc(z.symbol)}</b></td><td>₹${z.price.toFixed(1)}</td><td>${z.shares}</td><td>${apRs(z.value)}</td><td>${z.offPts >= 0 ? '+' : ''}${z.offPts.toFixed(1)} pts</td><td style="text-align:left;color:var(--warn)">${esc(z.flags.join('; '))}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">The ₹1 lakh paper account splits the stock third into 10 exact-rupee slots; real orders are whole shares, so a flagged stock's weight differs. Flags: one share above its slot, or rounding that moves the weight by more than 1 point.</div></details>`;
  }
  html += `<div style="margin-top:10px;font-size:13px"><b>Standing rules</b> (every day, no tick needed)<ul style="margin:4px 0 0 18px;padding:0">${p.standing.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ul></div>`;
  const r = p.record;
  if (r) {
    const pc = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
    html += `<div style="margin-top:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px"><b>Track record = the paper accounts</b> · ${r.days} past day${r.days === 1 ? '' : 's'} logged${r.since ? ` since ${esc(r.since)}` : ''} (${r.nothingDays} nothing-to-do) · ${r.matched}/${r.checks.length} plan actions matched the paper records
      <ul style="margin:4px 0 0 18px;padding:0">${r.accounts.map((x) => `<li><a href="#" data-goto="${esc(x.card)}">${esc(x.name)}</a>${x.since ? ` since ${esc(x.since)}` : ''}: ${x.value != null ? `${apRs(x.value)} (${pc(x.ret)} on ${apRs(x.capital)})` : x.expectedNet != null ? `${x.applications} applications, ${x.settled} settled, expected ${x.expectedNet >= 0 ? '+' : '−'}${apRs(Math.abs(x.expectedNet))} after tax` : 'not started'}</li>`).join('')}</ul>
      ${r.checks.length ? `<div class="note" style="margin:4px 0 0">${r.checks.slice(-5).map((c) => `${esc(c.date)} ${esc(c.what)}: ${c.matched ? '✓' : '✗'} ${esc(c.paper)}`).join(' · ')}</div>` : ''}
      <div class="note" style="margin:4px 0 0">${esc(r.note)}</div></div>`;
  }
  html += `<div class="note" style="margin-top:8px">${esc(p.assumes)} ${esc(p.note)}</div>`;
  $('apOut').innerHTML = html;
}
async function apLoad() {
  try {
    const p = await api('/api/algo-plan');
    $('apCap').value = p.settings.capital;
    $('apIpo').value = p.settings.ipoBuffer;
    apRender(p);
  } catch (e) {
    $('apOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('apSave').addEventListener('click', async () => {
  $('apSave').disabled = true;
  try {
    await api('/api/algo-plan/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capital: Number($('apCap').value), ipoBuffer: Number($('apIpo').value || 0) }) });
    await apLoad();
  } catch (e) {
    $('apOut').insertAdjacentHTML('afterbegin', `<div class="err">${esc(e.message)}</div>`);
  } finally {
    $('apSave').disabled = false;
  }
});
$('apOut').addEventListener('change', async (e) => {
  const box = e.target.closest?.('input[data-ap]');
  if (!box || !AP_LAST) return;
  box.closest('.apAct')?.classList.toggle('done', box.checked);
  try {
    await api('/api/algo-plan/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: AP_LAST.date, id: box.dataset.ap, done: box.checked }) });
  } catch (err) {
    box.checked = !box.checked;
    box.closest('.apAct')?.classList.toggle('done', box.checked);
    $('apOut').insertAdjacentHTML('afterbegin', `<div class="err">Not saved: ${esc(err.message)}</div>`);
  }
});
// open the card once by default (cards start folded); after that the viewer's own open / fold choice is kept
try {
  if (!localStorage.getItem('algo-plan-shown')) {
    localStorage.setItem('algo-plan-shown', '1');
    if ($('algoPlanCard').classList.contains('folded')) setFold($('algoPlanCard'), true);
  }
} catch {
  /* storage blocked: stays folded */
}
lazy("Today's algo plan", apLoad);
