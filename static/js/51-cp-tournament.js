// 51-cp-tournament.js — Options & risk → Call / Put tournament (paper-bot/cp-tournament.mjs): today's calls from every
// frozen contestant (made before the 09:15 open), the forward leaderboards (today / 5 sessions / same-day T1) with a
// sparkline of cumulative hits, the multiple-testing correction, and the existing Call/Put card's live record as the
// starting history. Forward test only — PAPER ONLY, no broker orders. Classic script (not a module).
const cpPc = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const cpRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const cpCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const cpDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–');
const cpCallCol = (c) => (c === 'CALL' ? 'var(--up)' : c === 'PUT' ? 'var(--down)' : 'var(--muted)');

function cpSpark(xs) {
  if (!xs || xs.length < 2) return '<span class="note" style="display:inline">–</span>';
  const w = 90;
  const h = 22;
  const n = xs.length;
  const pts = xs.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - (v / n) * h).toFixed(1)}`).join(' ');
  const coin = `0,${h} ${w},${(h / 2).toFixed(1)}`; // half the calls right (a coin flip)
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="cumulative hits"><polyline points="${coin}" fill="none" stroke="var(--muted)" stroke-dasharray="2 2" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="var(--accent, #4a7)" stroke-width="1.5"/></svg>`;
}

function cpBoard(b) {
  const head = '<thead><tr><th style="text-align:left">Contestant</th><th>Calls</th><th>Hit rate [95%]</th><th>No trade</th><th>Brier skill</th><th>P&amp;L (₹2k risk)</th><th>t (days)</th><th>p · Holm · BH q</th><th>Cumulative hits</th><th style="text-align:left">Status</th></tr></thead>';
  const row = (r) => `<tr><td style="text-align:left;white-space:normal">${esc(r.name)} <span class="note" style="display:inline">${esc(r.group)}</span></td><td>${r.n}</td>
    <td>${cpPc(r.hitRate)}${r.ci ? ` [${cpPc(r.ci[0])}–${cpPc(r.ci[1])}]` : ''}</td><td>${r.noTrade}</td>
    <td style="color:${cpCol(r.brierSkill)}">${r.brierSkill == null ? '–' : `${(r.brierSkill * 100).toFixed(1)}%`}</td>
    <td style="color:${cpCol(r.pnl)}">${r.pnlDays ? cpRs(r.pnl) : '–'}${r.realOption ? ` <span class="note" style="display:inline">(${r.realOption} real option)</span>` : ''}</td>
    <td>${r.tDay == null ? '–' : r.tDay.toFixed(2)}</td>
    <td>${r.p == null ? '–' : `${r.p.toFixed(2)} · ${r.pHolm.toFixed(2)} · ${r.qBH.toFixed(2)}`}</td><td>${cpSpark(r.spark)}</td>
    <td style="text-align:left;white-space:normal;color:${r.proven ? 'var(--up)' : r.status.startsWith('LEADING') ? 'var(--warn)' : 'var(--muted)'}"><b>${esc(r.status)}</b></td></tr>`;
  return `<div style="font-size:14px;margin-top:12px"><b>Leaderboard — ${esc(b.label)}</b>${b.baseHit != null ? ` · always-CALL hit rate ${cpPc(b.baseHit)}` : ''} · bar ${cpPc(b.bar)}</div>
    <div style="overflow-x:auto"><table style="font-size:12px;width:100%">${head}<tbody>${b.rows.map(row).join('')}</tbody></table></div>
    <div class="note"><b>${esc(b.verdict)}</b> ${esc(b.correction)}</div>`;
}

function cpRender(d) {
  let html = `<div class="note" style="margin-top:0"><b>Forward testing, not backtest searching.</b> ${esc(d.why)}</div>`;
  if (d.expiry) {
    html += `<div class="note">${d.expiry.niftyExpiry ? `<b style="color:var(--down)">Next session (${esc(cpDay(d.expiry.session))}) is a NIFTY expiry day: no option is bought for the P&amp;L that day.</b>` : `Next session ${esc(cpDay(d.expiry.session))} is not a NIFTY expiry day.`} Next NIFTY weekly expiry: ${esc(cpDay(d.expiry.next))}.</div>`;
  }
  html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px">${d.startedAt
    ? `<b>Scored since ${esc(cpDay(d.startedAt))}</b> · base rate (NIFTY up open → close, ${d.baseRate?.sessions || '–'} sessions before the start) ${cpPc(d.baseRate?.day, 1)} · 5 sessions ${cpPc(d.baseRate?.five, 1)}`
    : '<b>Not started:</b> real scoring starts with the first 08:40 run (Mon–Fri, before the 09:15 open). Test entries are shown but never scored.'}</div>`;
  // today's calls
  const t = d.today;
  if (t) {
    html += `<div style="font-size:14px;margin-top:12px"><b>Calls for ${esc(cpDay(t.date))}</b>${t.test ? ` <span style="color:var(--warn)">TEST — ${esc(t.testReason || 'not scored')}</span>` : ''} · made ${esc(String(t.madeAt).slice(0, 16).replace('T', ' '))} UTC from data before ${esc(String(t.cutoff).slice(0, 16).replace('T', ' '))} UTC · last close ${esc(t.lastClose?.date || '–')} ${t.lastClose ? t.lastClose.close.toFixed(2) : ''}${t.expiry ? ' · <b style="color:var(--down)">NIFTY expiry day</b>' : ''}</div>`;
    const cell = (x) => (x ? `<b style="color:${cpCallCol(x.call)}">${esc(x.call)}</b> ${cpPc(x.pUp)} <span class="note" style="display:inline">conf ${x.conf.toFixed(2)}</span>` : '–');
    html += `<div style="overflow-x:auto"><table style="font-size:12px;width:100%"><thead><tr><th style="text-align:left">Contestant</th><th>Today (P up)</th><th>5 sessions (P up)</th><th style="text-align:left">Why</th></tr></thead><tbody>${t.calls.map((c) => `<tr><td style="text-align:left;white-space:normal">${esc(c.name)} <span class="note" style="display:inline">${esc(c.group)} · v${esc(c.version)}</span></td>${c.skipped ? `<td colspan="3" style="text-align:left;color:var(--muted)">skipped: ${esc(c.skipped)}</td>` : c.pm ? `<td colspan="2">12:30–15:15: ${cell(c.pm)}</td><td style="text-align:left;white-space:normal">${esc(c.pm.why)}</td>` : `<td>${cell(c.day)}</td><td>${cell(c.five)}</td><td style="text-align:left;white-space:normal">${esc(c.day.why)}</td>`}</tr>`).join('')}</tbody></table></div>`;
    if (t.errors?.length) html += `<div class="note">Data problems: ${t.errors.map(esc).join(' · ')}</div>`;
  } else html += '<div class="note">No calls yet.</div>';
  // leaderboards
  for (const k of ['day', 'five', 'pm']) html += cpBoard(d.boards[k]);
  // starting history
  const h = d.history;
  if (h) {
    html += `<div class="note"><b>Starting history — the existing Call / Put prediction card's live record</b> (stocks, next session; scored before this tournament): ${h.scored} scored · top call right ${cpPc(h.topCallRight)} vs ${cpPc(h.alwaysMostCommonRight)} for always "${esc(h.mostCommon)}" · direction right ${cpPc(h.directionRight)} of ${h.directionCalls} · Brier ${h.brierApp == null ? '–' : h.brierApp.toFixed(3)} vs coin ${h.brierCoin == null ? '–' : h.brierCoin.toFixed(3)}. ${esc(h.verdict)}</div>`;
  }
  html += `<div class="note"><b>Rules:</b> ${d.rules.map(esc).join(' ')}</div>`;
  html += `<div class="note">${esc(d.gift)}</div>`;
  html += `<div class="note"><b>Contestants</b> (reused app models): ${d.contestants.map((c) => `${esc(c.name)}${c.reuses ? ` — ${esc(c.reuses)}` : ''}`).join(' · ')}</div>`;
  html += `<div class="note">${esc(d.note)}</div>`;
  $('cptOut').innerHTML = html;
}
lazy('Call / Put tournament', async () => {
  try { cpRender(await api('/api/cp-tournament')); } catch (e) { $('cptOut').innerHTML = `<div class="err">Error: ${esc(e.message)}. Not advice.</div>`; }
});
