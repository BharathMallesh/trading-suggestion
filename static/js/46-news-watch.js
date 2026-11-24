// 46-news-watch.js — Investing → News watch: the scorecard of the AI news calls on top, then per stock the latest
// NSE announcements and headlines (times + links), event type, AI summary, the UP / DOWN / NO CALL call with its
// confidence, the tested history of that kind of news and any ⚠ don't-buy-now warning. Add / remove your own stocks.
// Phone width: blocks wrap (no wide tables); long titles and links break.
// Classic script (not a module): loaded in order by index.html.
const nwPct = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const nwSigned = (x, d = 2) => (x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
// any ISO time (UTC "Z" from the news feeds, +05:30 from NSE) → "YYYY-MM-DD HH:MM" in IST
const nwTime = (t) => {
  const ms = Date.parse(t || '');
  return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(0, 16).replace('T', ' ') : '';
};
const NW_COLOR = { UP: 'var(--up)', DOWN: 'var(--down)', 'NO CALL': 'var(--muted)' };
function nwCall(label, c) {
  if (!c) return '';
  const conf = c.confidence != null ? ` · ${Math.round(c.confidence * 100)}%` : '';
  return `<div style="flex:1 1 200px;min-width:0;padding:6px 8px;border:1px solid var(--line);border-radius:8px"><div class="note" style="margin:0">${esc(label)}</div>
    <b style="color:${NW_COLOR[c.call] || 'inherit'}">${esc(c.call)}</b><span class="note" style="display:inline">${conf}</span>
    ${c.reason ? `<div class="note" style="margin:2px 0 0;overflow-wrap:anywhere">${esc(c.reason)}</div>` : ''}</div>`;
}
function nwScore(sc, h, minN) {
  const s = sc?.[h] || { n: 0, pending: 0 };
  const ci = s.ci ? `${nwPct(s.ci[0])}–${nwPct(s.ci[1])}` : '–';
  const src = Object.entries(s.bySource || {}).map(([k, v]) => `${k === 'ai' ? 'AI' : 'rule'} ${v.hits}/${v.n}`).join(' · ');
  return `<div style="flex:1 1 240px;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:10px">
    <div><b>${h === 1 ? 'Next session' : '5 sessions'}</b> <span class="note" style="display:inline">vs NIFTY</span></div>
    <div style="font-size:20px;font-weight:600">${s.n ? nwPct(s.hitRate) : '–'} <span class="note" style="display:inline;font-size:12px">hit rate</span></div>
    <div class="note" style="margin:2px 0 0">${s.n} scored · ${s.pending || 0} waiting · 95% interval ${ci}${src ? ` · ${esc(src)}` : ''}</div>
    <div class="note" style="margin:2px 0 0">Paper P&amp;L if followed (0.3% costs): ${nwSigned(s.avgPnlPct)} a call on average, ${nwSigned(s.totalPnlPct, 1)} summed · hedged with NIFTY ${nwSigned(s.avgPnlVsNiftyPct)}</div>
    <div style="margin-top:4px;font-size:12.5px;color:${s.n >= minN && s.ci && s.ci[0] > 0.5 ? 'var(--up)' : 'var(--warn)'}"><b>${esc(s.verdict || `not better than a coin flip yet — 0 of ${minN} scored calls needed before judging`)}</b></div></div>`;
}
function nwItem(x) {
  const ev = x.event && !x.event.routine && x.event.type !== 'other' ? ` <span style="font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--line);white-space:nowrap">${esc(NW_TYPES[x.event.type] || x.event.type)}</span>` : '';
  const title = x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>` : esc(x.title);
  return `<li style="margin:3px 0;overflow-wrap:anywhere;${x.event?.routine ? 'opacity:.65' : ''}"><span class="note" style="display:inline">${esc(nwTime(x.time))} · ${esc(x.source)}</span> ${title}${ev}
    ${x.detail ? `<div class="note" style="margin:1px 0 0">${esc(x.detail.slice(0, 220))}${x.detail.length > 220 ? '…' : ''}</div>` : ''}</li>`;
}
let NW_TYPES = {};
function nwStock(s) {
  const tags = (s.from || []).map((f) => `<span class="note" style="display:inline;margin-left:4px">${esc(f)}</span>`).join('');
  const rm = (s.from || []).includes('added') ? ` <button type="button" class="nwRm" data-sym="${esc(s.symbol)}" style="width:auto;margin:0 0 0 6px;padding:1px 8px;font-size:11px">remove</button>` : '';
  if (s.notYet) return `<div style="padding:8px 0;border-top:1px solid var(--line)"><b>${esc(s.symbol)}</b>${tags}${rm}<div class="note">Not read yet — the evening job reads it, or press "Check now".</div></div>`;
  const warn = (s.warnings || []).length ? `<div style="color:var(--warn);font-size:12.5px;margin-top:4px">⚠ Don't buy now: ${s.warnings.map((w) => `${esc(w.reason)} (until ${esc(w.until)})`).join('; ')} — tested caution, not advice.</div>` : '';
  const items = s.items || [];
  const shown = items.filter((x) => !x.event?.routine);
  const routine = items.length - shown.length;
  return `<div style="padding:10px 0;border-top:1px solid var(--line);min-width:0">
    <div style="overflow-wrap:anywhere"><b>${esc(s.symbol)}</b>${s.company ? ` <span class="note" style="display:inline">${esc(s.company)}</span>` : ''}${tags}${rm}
      <span class="note" style="display:inline"> · read ${esc(s.date || '')} (calls vs the ${esc(s.base || '')} close) · ${s.source === 'ai' ? 'AI call' : 'rule call (no AI)'}</span></div>
    <div style="margin-top:4px;font-size:13px"><b>Event:</b> ${esc(s.eventLabel || 'none')}${s.quiet ? ' <span class="note" style="display:inline">(no company news in the last 2 sessions)</span>' : ''}</div>
    ${s.history ? `<div class="note" style="margin:2px 0 0;overflow-wrap:anywhere">Tested history — ${esc(s.history)}</div>` : ''}
    ${warn}
    ${s.summary ? `<div style="margin-top:4px;font-size:13px;overflow-wrap:anywhere"><b>AI summary:</b> ${esc(s.summary)}</div>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${nwCall('Next session', s.next)}${nwCall('Next 5 sessions', s.five)}</div>
    ${shown.length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px">${shown.map(nwItem).join('')}</ul>` : ''}
    ${routine ? `<div class="note" style="margin:2px 0 0">${routine} routine filing${routine === 1 ? '' : 's'} hidden (newspaper copies, trading window, analyst meets…).</div>` : ''}
    ${(s.errors || []).length ? `<div class="note" style="color:var(--down);margin:2px 0 0">fetchError: ${esc(s.errors.join(' · '))}</div>` : ''}
  </div>`;
}
function nwRender(d) {
  NW_TYPES = d.eventTypes || {};
  window.NW_WATCHED = (d.stocks || []).map((x) => x.symbol);
  const L = d.lastRun;
  let html = `<div style="display:flex;flex-wrap:wrap;gap:8px">${nwScore(d.scorecard, 1, d.minN)}${nwScore(d.scorecard, 5, d.minN)}</div>
    <div class="note" style="margin:6px 0 0">${esc(d.disclaimer || '')} A hit = the stock beat NIFTY after an UP call (or lagged it after a DOWN call) from the logged close to the close 1 or 5 sessions later; NO CALLs are not scored.
    ${d.relatedNewsValue ? `Related: on the Call/Put predictions, AI news sentiment matched the direction ${nwPct(d.relatedNewsValue.directionHitRate)} of the time (n = ${d.relatedNewsValue.n}).` : ''}</div>`;
  html += `<div style="margin-top:8px;font-size:12.5px">${L ? `Last read ${esc(nwTime(L.at))} IST (news times are IST too) · ${L.stocks} stock${L.stocks === 1 ? '' : 's'} · ${L.logged} new call${L.logged === 1 ? '' : 's'} logged${L.canLog ? '' : ' (market was open — shown, not logged)'}` : 'Not run yet — the evening job runs it after the NSE files.'}</div>`;
  if (d.fetchError) html += `<div class="note" style="color:var(--down);margin:2px 0 0;overflow-wrap:anywhere">fetchError: ${esc(d.fetchError)}</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px">
    <input id="nwSym" placeholder="NSE symbol, e.g. TCS" style="flex:1 1 160px;min-width:0;max-width:240px" autocomplete="off">
    <button type="button" id="nwAdd" style="width:auto;margin:0">Add</button>
    <button type="button" id="nwCheck" style="width:auto;margin:0" title="Read this stock's news now (AI call; logged only while the market is closed)">Check now</button>
    <span id="nwMsg" class="note" style="display:inline"></span></div>
    <div class="note" style="margin:2px 0 0">Your added stocks: ${d.userSymbols?.length ? d.userSymbols.map(esc).join(', ') : 'none'} · Momentum 10 / India mix stocks follow their strategy.</div>`;
  html += (d.stocks || []).map(nwStock).join('') || '<div class="note">No stocks to watch yet.</div>';
  const rc = d.recentCalls || [];
  if (rc.length) {
    html += `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px"><b>Call log</b> (latest ${rc.length})</summary>${rc.map((c) =>
      `<div style="font-size:12px;padding:3px 0;border-top:1px solid var(--line);overflow-wrap:anywhere">${esc(c.date)} · <b>${esc(c.symbol)}</b> · ${c.horizon === 1 ? 'next session' : '5 sessions'} · <b style="color:${NW_COLOR[c.call]}">${esc(c.call)}</b>${c.confidence != null ? ` ${Math.round(c.confidence * 100)}%` : ''} · ${esc(c.source)} · ${esc(NW_TYPES[c.eventType] || c.eventType || '')}${c.price ? ` · ₹${c.price.toFixed(2)}` : ''}
       — ${c.scored ? `${c.hit ? '<span style="color:var(--up)">hit</span>' : '<span style="color:var(--down)">miss</span>'} (stock ${nwSigned(c.stockPct)}, NIFTY ${nwSigned(c.niftyPct)}, P&amp;L ${nwSigned(c.pnlPct)})` : `waiting for ${esc(c.target || 'the close')}`}</div>`).join('')}</details>`;
  }
  html += '<div class="note" style="margin-top:8px">Calls are research, logged to be scored; they change no strategy. Not advice.</div>';
  $('nwOut').innerHTML = html;
  const msg = (t, bad) => { $('nwMsg').textContent = t; $('nwMsg').style.color = bad ? 'var(--down)' : ''; };
  const post = async (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('nwAdd').addEventListener('click', async () => {
    const s = $('nwSym').value.trim();
    if (!s) return msg('Type a symbol first.', true);
    try { const r = await post('/api/news-watch/add', { symbol: s }); msg(r.added ? `Added — the evening job reads it, or press Check now.` : 'Already in your list.'); nwLoad(); } catch (e) { msg(e.message, true); }
  });
  $('nwCheck').addEventListener('click', async () => {
    const s = $('nwSym').value.trim();
    if (!s) return msg('Type a symbol first.', true);
    msg('Reading NSE, headlines and the AI… (up to a minute)');
    try { if (!(window.NW_WATCHED || []).includes(s.toUpperCase().replace(/\.(NS|BO)$/, ''))) await post('/api/news-watch/add', { symbol: s }); nwRender(await post('/api/news-watch/check', { symbol: s })); } catch (e) { msg(e.message, true); }
  });
  for (const b of $('nwOut').querySelectorAll('.nwRm')) b.addEventListener('click', async () => {
    try { await post('/api/news-watch/remove', { symbol: b.dataset.sym }); nwLoad(); } catch (e) { msg(e.message, true); }
  });
}
async function nwLoad() {
  try { nwRender(await api('/api/news-watch')); } catch (e) { $('nwOut').innerHTML = `<div class="err">fetchError: could not load News watch (${esc(e.message)}). Not advice.</div>`; }
}
lazy('News watch', nwLoad);
