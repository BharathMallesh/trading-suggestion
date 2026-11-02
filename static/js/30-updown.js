// 30-updown.js — Home → Up/Down outlook: a 1–3 month lean for one stock with honest odds, today's lists, NIFTY, scorecard.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const udPc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const udMv = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const UD_TAG = { strong: ['🟢 STRONG', 'var(--up)'], neutral: ['⚪ NEUTRAL', 'var(--muted)'], weak: ['🔴 WEAK', 'var(--down)'] };

function udOddsRows(odds, base) {
  const h = [['1w', '1 week'], ['1m', '1 month'], ['3m', '3 months']];
  return `<table style="font-size:12px;margin-top:6px"><thead><tr><th style="text-align:left">After</th><th>Rose (2010–17)</th><th>Rose (2018→)</th><th>Beat NIFTY (2018→)</th><th>Average move (2018→)</th><th>All stocks: rose / average</th></tr></thead><tbody>${h.map(([k, l]) =>
    `<tr><td style="text-align:left">${l}</td><td>${udPc(odds.early[k].up)}</td><td><b>${udPc(odds.late[k].up)}</b></td><td>${udPc(odds.late[k].beatsNifty)}</td><td><b>${udMv(odds.late[k].avg)}</b></td><td class="note">${udPc(base.late[k].up)} / ${udMv(base.late[k].avg)}</td></tr>`).join('')}</tbody></table>`;
}

function udRender(d) {
  let html = '';
  const s = d.stock;
  if (s?.error) html += `<div class="err">${esc(s.symbol)}: ${esc(s.error)}</div>`;
  else if (s) {
    const [tag, col] = UD_TAG[s.label] || ['–', 'var(--muted)'];
    html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${col};font-size:14px"><b>${esc(s.symbol)}</b> ₹${s.close.toFixed(1)} — <b style="color:${col}">${tag}</b> for the next 1–3 months
      <ul style="margin:4px 0 0 18px;padding:0;font-size:13px">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${s.odds && s.base ? udOddsRows(s.odds, s.base) : '<div class="note">Odds tables not built yet (they build on Saturdays).</div>'}
      <div class="note" style="margin:4px 0 0">How often stocks with this label rose afterwards (weekly samples of the NSE top 200 since 2010). Even the best label rises only a little more often than average; most of the difference is in the size of the move. ${esc(s.source)}.</div></div>`;
  }
  if (d.nifty) {
    const n = d.nifty;
    html += `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>NIFTY</b> ${n.close.toFixed(0)} is <b>${n.above200 ? 'above' : 'below'}</b> its 200-day average (${n.sma200.toFixed(0)}).
      ${n.odds ? `Since 2010, from this position NIFTY rose over the next 3 months ${udPc(n.odds['3m'].up)} of the time (average ${udMv(n.odds['3m'].avg)}), vs ${udPc(n.base['3m'].up)} overall.` : ''}${!n.above200 ? ' Below the average has not been a reason to expect falls — NIFTY often recovered.' : ''}</div>`;
  }
  if (d.counts) {
    html += `<div style="font-size:14px;margin-top:12px"><b>Today's labels</b> (NSE top 200, close of ${esc(d.date)}): ${d.counts.strong} strong · ${d.counts.neutral} neutral · ${d.counts.weak} weak</div>
      <div style="font-size:13px;margin-top:4px"><span style="color:var(--up)"><b>🟢 Strong:</b></span> ${d.strong.map((x) => `<a href="#" data-ud="${esc(x.symbol)}">${esc(x.symbol)}</a>`).join(', ') || 'none'}</div>
      <div style="font-size:13px;margin-top:4px"><span style="color:var(--down)"><b>🔴 Weak:</b></span> ${d.weak.map((x) => `<a href="#" data-ud="${esc(x.symbol)}">${esc(x.symbol)}</a>`).join(', ') || 'none'}</div>`;
  }
  if (d.score) {
    const sc = d.score;
    const line = (lab) => ['1w', '1m', '3m'].map((k) => `${k}: ${sc[lab][k].n ? `${udPc(sc[lab][k].up)} rose, ${udMv(sc[lab][k].avg)}` : 'not yet'}`).join(' · ');
    html += `<div class="note" style="margin-top:8px"><b>Scorecard</b> (lists saved weekly since ${esc(d.since || '–')}, ${d.weeks} so far): strong — ${line('strong')} | weak — ${line('weak')}. Fills in as 1 week / 1 month / 3 months pass.</div>`;
  }
  $('udOut').innerHTML = html;
  for (const a of document.querySelectorAll('#udOut [data-ud]')) a.addEventListener('click', (e) => {
    e.preventDefault();
    $('udSym').value = a.dataset.ud;
    udLoad();
  });
}
async function udLoad() {
  $('udBtn').disabled = true;
  try { udRender(await api(`/api/updown?symbol=${encodeURIComponent($('udSym').value.trim() || 'RELIANCE')}`)); } catch (e) { $('udOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('udBtn').disabled = false; }
}
lazy('Up/Down outlook', udLoad);
$('udBtn').addEventListener('click', udLoad);
$('udSym').addEventListener('keydown', (e) => e.key === 'Enter' && udLoad());
