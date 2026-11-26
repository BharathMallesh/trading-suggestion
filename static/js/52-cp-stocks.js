// 52-cp-stocks.js — Options & risk → Call / Put tournament → "Stocks" toggle (paper-bot/cp-stocks.mjs): the same kind of
// frozen contestants calling the 20 most liquid F&O stocks before the 09:15 open, scored forward only, against the
// stock's own move AND against NIFTY; pooled leaderboard (day-clustered tests), per-stock drill-down, expiry and
// avoid-list notes. Wide tables scroll inside their own box (phone width). PAPER ONLY, no broker orders. Classic script.
const cpsPc = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const cpsRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const cpsCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const cpsCallCol = (c) => (c === 'CALL' ? 'var(--up)' : c === 'PUT' ? 'var(--down)' : 'var(--muted)');
const cpsDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–');
const CPS_SHORT = { 'always-call': 'Always C', 'always-put': 'Always P', coin: 'Coin', continuation: 'Contin.', reversal: 'Revers.', 'cp-model': 'CP raw', 'cp-calibrated': 'CP cal.', updown: 'Up/Down', momentum: 'Mom.', 'news-watch': 'News W', 'news-pick': 'News pick', 'trend-20-50': '20/50', 'beta-nifty': 'β NIFTY', 'big-move': 'Big move', majority: 'Majority', weighted: 'Weighted' };
const cpsBox = (inner) => `<div style="overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch">${inner}</div>`;
let CPS = null;
const cpsUi = { stock: '', drill: null, drillH: 'day' };

function cpsCiCell(o) {
  return o && o.n ? `${cpsPc(o.hitRate)} <span class="note" style="display:inline">[${cpsPc(o.ci[0])}–${cpsPc(o.ci[1])}] n ${o.n}</span>` : '–';
}

function cpsBoard(b) {
  const head = '<thead><tr><th style="text-align:left">Contestant</th><th>Calls · days</th><th>Hit [95%]</th><th>Beat NIFTY [95%]</th><th>No trade</th><th>Brier skill</th><th>P&amp;L proxy</th><th>t (by day)</th><th>p · Holm · BH q</th><th style="text-align:left">Status</th></tr></thead>';
  const row = (r) => `<tr><td style="text-align:left;white-space:normal;min-width:150px">${esc(r.name)} <span class="note" style="display:inline">${esc(r.group)}</span></td>
    <td>${r.n} · ${r.days}</td><td>${r.n ? `${cpsPc(r.hitRate)}${r.ci ? ` [${cpsPc(r.ci[0])}–${cpsPc(r.ci[1])}]` : ''}` : '–'}</td>
    <td>${r.vsNifty.n ? `${cpsPc(r.vsNifty.hitRate)} [${cpsPc(r.vsNifty.ci[0])}–${cpsPc(r.vsNifty.ci[1])}]` : '–'}</td><td>${r.noTrade}</td>
    <td style="color:${cpsCol(r.brierSkill)}">${r.brierSkill == null ? '–' : `${(r.brierSkill * 100).toFixed(1)}%`}</td>
    <td style="color:${cpsCol(r.pnl)}">${r.pnlCalls ? cpsRs(r.pnl) : '–'}</td><td>${r.tDay == null ? '–' : r.tDay.toFixed(2)}</td>
    <td>${r.p == null ? '–' : `${r.p.toFixed(2)} · ${r.pHolm.toFixed(2)} · ${r.qBH.toFixed(2)}`}</td>
    <td style="text-align:left;white-space:normal;min-width:120px;color:${r.proven ? 'var(--up)' : r.status.startsWith('LEADING') ? 'var(--warn)' : 'var(--muted)'}"><b>${esc(r.status)}</b></td></tr>`;
  let html = `<div style="font-size:14px;margin-top:12px"><b>Pooled leaderboard — ${esc(b.label)}</b>${b.baseHit != null ? ` · always-CALL hit rate ${cpsPc(b.baseHit)}` : ''} · bar ${cpsPc(b.bar)}</div>`;
  html += cpsBox(`<table style="font-size:12px;width:100%">${head}<tbody>${b.rows.map(row).join('')}</tbody></table>`);
  html += `<div class="note"><b>${esc(b.verdict)}</b> ${esc(b.correction)}</div>`;
  const ls = b.leaderStocks;
  if (ls && ls.best.length) {
    const one = (x) => `${esc(x.symbol)} ${cpsPc(x.hitRate)} of ${x.n}`;
    html += `<div class="note">Leader's best stocks: ${ls.best.map(one).join(' · ')}; worst: ${ls.worst.map(one).join(' · ')}. <b>${esc(ls.note)}</b></div>`;
  }
  return html;
}

function cpsToday(t) {
  if (!t) return '<div class="note">No stock calls yet — the first run is the morning job (after the NIFTY calls).</div>';
  let html = `<div style="font-size:14px;margin-top:12px"><b>Stock calls for ${esc(cpsDay(t.date))}</b>${t.test ? ` <span style="color:var(--warn)">${esc(t.testReason || 'TEST — not scored')}</span>` : ''} · made ${esc(String(t.madeAt).slice(0, 16).replace('T', ' '))} UTC from data before ${esc(String(t.cutoff).slice(0, 16).replace('T', ' '))} UTC · ${t.universe.length} stocks · run ${t.runtimeMs == null ? '–' : `${(t.runtimeMs / 1000).toFixed(1)} s`}${t.prepCached ? ' (inputs cached the evening before)' : ''}</div>`;
  if (t.niftyMajority) html += `<div class="note">NIFTY tournament majority (the "β NIFTY" contestant): today ${esc(t.niftyMajority.day || '–')} · 5 sessions ${esc(t.niftyMajority.five || '–')}${t.niftyMajority.test ? ' (a TEST NIFTY entry)' : ''}.</div>`;
  const opts = ['<option value="">All stocks</option>', ...t.stocks.map((s) => `<option value="${esc(s.symbol)}"${cpsUi.stock === s.symbol ? ' selected' : ''}>${esc(s.symbol)}</option>`)].join('');
  html += `<div class="row" style="margin-top:6px;align-items:end"><div style="flex:0 1 220px"><label for="cpsStock">Filter by stock</label><select id="cpsStock">${opts}</select></div></div>`;
  const ids = CPS.contestants.map((c) => c.id);
  const shown = t.stocks.filter((s) => !cpsUi.stock || s.symbol === cpsUi.stock);
  if (!cpsUi.stock) {
    const cell = (c) => {
      if (!c) return '<td>–</td>';
      if (c.skipped) return `<td title="skipped: ${esc(c.skipped)}" style="color:var(--muted)">skip</td>`;
      const a = c.day.call === 'NO TRADE' ? '–' : c.day.call === 'CALL' ? 'C' : 'P';
      const b = c.five.call === 'NO TRADE' ? '–' : c.five.call === 'CALL' ? 'C' : 'P';
      return `<td title="today ${esc(c.day.call)} P(up) ${cpsPc(c.day.pUp)} · 5 sessions ${esc(c.five.call)} — ${esc(c.day.why || '')}"><b style="color:${cpsCallCol(c.day.call)}">${a}</b><span class="note" style="display:inline">/${b}</span></td>`;
    };
    const head = `<thead><tr><th style="text-align:left">Stock</th>${ids.map((id) => `<th title="${esc(CPS.contestants.find((c) => c.id === id).name)}">${esc(CPS_SHORT[id] || id)}</th>`).join('')}</tr></thead>`;
    const body = shown.map((s) => `<tr><td style="text-align:left"><b>${esc(s.symbol)}</b>${s.expiry ? ' <span style="color:var(--down)">expiry</span>' : ''}</td>${s.skipped ? `<td colspan="${ids.length}" style="text-align:left;color:var(--muted)">${esc(s.skipped)}</td>` : ids.map((id) => cell(s.calls[id])).join('')}</tr>`).join('');
    html += cpsBox(`<table style="font-size:12px;width:100%">${head}<tbody>${body}</tbody></table>`);
    html += '<div class="note">Each cell: today\'s call (C = CALL, P = PUT, – = NO TRADE) / the 5-session call; tap or hover a cell for P(up) and the reason. Pick a stock above for every contestant\'s reasons.</div>';
  } else {
    const s = shown[0];
    const cell = (x) => (x ? `<b style="color:${cpsCallCol(x.call)}">${esc(x.call)}</b> ${cpsPc(x.pUp)}` : '–');
    html += `<div class="note">${esc(s.symbol)} · last close ${esc(s.lastClose?.date || '–')} ${s.lastClose ? s.lastClose.close.toFixed(2) : ''} · base rate up open → close ${cpsPc(s.baseRate?.day, 1)} (${s.baseRate?.sessions || 0} sessions) · ATM ${s.atm ? `${esc(s.atm.expiry)} expiry, lot ${s.atm.lot ?? '–'}, CE ${s.atm.CE ? `${s.atm.CE.strike} @ ${s.atm.CE.prem}` : '–'}, PE ${s.atm.PE ? `${s.atm.PE.strike} @ ${s.atm.PE.prem}` : '–'}` : 'no NSE option price'}</div>`;
    const rows = ids.map((id) => {
      const c = s.calls[id];
      const name = CPS.contestants.find((x) => x.id === id).name;
      return `<tr><td style="text-align:left;white-space:normal;min-width:140px">${esc(name)}</td>${!c ? '<td colspan="3">–</td>' : c.skipped ? `<td colspan="3" style="text-align:left;white-space:normal;color:var(--muted)">skipped: ${esc(c.skipped)}</td>` : `<td>${cell(c.day)}</td><td>${cell(c.five)}</td><td style="text-align:left;white-space:normal;min-width:160px">${esc(c.day.why || '')}</td>`}</tr>`;
    }).join('');
    html += cpsBox(`<table style="font-size:12px;width:100%"><thead><tr><th style="text-align:left">Contestant</th><th>Today (P up)</th><th>5 sessions (P up)</th><th style="text-align:left">Why</th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  if (t.errors?.length) html += `<div class="note">Data notes: ${t.errors.map(esc).join(' · ')}</div>`;
  return html;
}

function cpsNotes(d) {
  const t = d.today;
  const parts = [];
  if (t) {
    const xp = t.stocks.find((s) => s.atm?.expiry)?.atm?.expiry;
    if (t.stockExpiry) parts.push(`<b style="color:var(--down)">${esc(cpsDay(t.date))} is the NSE stock-option expiry day: every stock is left out (no calls, no option P&amp;L) — stock options are physically settled.</b>`);
    else if (xp) parts.push(`Next stock-option expiry: ${esc(cpsDay(xp))} — on that day every stock is left out and no option is bought.`);
    const av = (t.excluded || []).filter((x) => /^avoid/.test(x.reason));
    const ex = (t.excluded || []).filter((x) => !/^avoid/.test(x.reason));
    parts.push(av.length ? `Left out (avoid list): ${av.map((x) => `${esc(x.symbol)} (#${x.rank}, ${esc(x.reason.replace(/^avoid list: /, ''))})`).join(' · ')}.` : 'No top-ranked stock was on the avoid list this session.');
    if (ex.length && !t.stockExpiry) parts.push(`Left out (expiry): ${ex.map((x) => esc(x.symbol)).join(' · ')}.`);
  }
  return `<div class="note">${parts.join(' ')}</div>`;
}

function cpsDrill(d) {
  const ids = d.contestants.map((c) => c.id);
  const id = cpsUi.drill && ids.includes(cpsUi.drill) ? cpsUi.drill : d.boards.day.leader || 'majority';
  const h = cpsUi.drillH;
  const rows = d.perStock[h]?.[id] || [];
  let html = `<div style="font-size:14px;margin-top:12px"><b>Per-stock drill-down</b></div>
    <div class="row" style="align-items:end"><div style="flex:1 1 200px"><label for="cpsDrill">Contestant</label><select id="cpsDrill">${d.contestants.map((c) => `<option value="${esc(c.id)}"${c.id === id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div style="flex:0 1 180px"><label for="cpsDrillH">Horizon</label><select id="cpsDrillH"><option value="day"${h === 'day' ? ' selected' : ''}>Today (open → close)</option><option value="five"${h === 'five' ? ' selected' : ''}>5 sessions</option></select></div></div>`;
  if (!rows.length) return `${html}<div class="note">No scored calls for this contestant yet.</div>`;
  html += cpsBox(`<table style="font-size:12px;width:100%"><thead><tr><th style="text-align:left">Stock</th><th>Hit [95%]</th><th>Beat NIFTY</th><th>No trade</th><th>Brier skill</th><th>P&amp;L proxy</th></tr></thead><tbody>${rows.map((r) => `<tr><td style="text-align:left"><b>${esc(r.symbol)}</b></td><td>${cpsCiCell(r)}</td><td>${r.vsNifty.n ? cpsPc(r.vsNifty.hitRate) : '–'}</td><td>${r.noTrade}</td><td style="color:${cpsCol(r.brierSkill)}">${r.brierSkill == null ? '–' : `${(r.brierSkill * 100).toFixed(1)}%`}</td><td style="color:${cpsCol(r.pnl)}">${r.pnlCalls ? cpsRs(r.pnl) : '–'}</td></tr>`).join('')}</tbody></table>`);
  html += '<div class="note"><b>Per-stock results on a few calls are mostly luck</b> — judge a contestant on the pooled board, not on its best stock.</div>';
  return html;
}

function cpsRender() {
  const d = CPS;
  let html = `<div class="note" style="margin-top:0"><b>Why two scores:</b> ${esc(d.whyVsNifty)}</div>`;
  html += `<div class="note"><b>What the research found:</b> ${esc(d.evidence)}</div>`;
  html += `<div style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px;margin-top:8px">${d.startedAt ? `<b>Scored since ${esc(cpsDay(d.startedAt))}</b>` : '<b>Not started:</b> real scoring starts with the first morning run (Mon–Fri, before the 09:15 open). Test entries are shown but never scored.'}</div>`;
  html += cpsNotes(d);
  html += cpsToday(d.today);
  const sk = Object.entries(d.skips || {});
  if (sk.length) html += `<div class="note"><b>Skipped (no data for that stock):</b> ${sk.map(([id, r]) => `${esc(CPS_SHORT[id] || id)} — ${Object.entries(r).map(([why, syms]) => `${esc(why)} (${syms.length})`).join('; ')}`).join(' · ')}</div>`;
  for (const k of ['day', 'five']) html += cpsBoard(d.boards[k]);
  html += cpsDrill(d);
  html += `<div class="note"><b>Universe:</b> ${esc(d.universeRule)}</div>`;
  html += `<div class="note"><b>P&amp;L:</b> ${esc(d.pnlNote)}</div>`;
  html += `<div class="note"><b>Rules:</b> ${d.rules.map(esc).join(' ')}</div>`;
  html += `<div class="note"><b>Contestants</b> (reused app models): ${d.contestants.map((c) => `${esc(CPS_SHORT[c.id] || c.id)} = ${esc(c.name)}${c.reuses ? ` — ${esc(c.reuses)}` : ''}`).join(' · ')}</div>`;
  html += `<div class="note">${esc(d.note)}</div>`;
  $('cpsOut').innerHTML = html;
  const on = (id, f) => $(id) && $(id).addEventListener('change', f);
  on('cpsStock', (e) => { cpsUi.stock = e.target.value; cpsRender(); });
  on('cpsDrill', (e) => { cpsUi.drill = e.target.value; cpsRender(); });
  on('cpsDrillH', (e) => { cpsUi.drillH = e.target.value; cpsRender(); });
}

async function cpsShow(stocks) {
  const a = $('cpShowNifty');
  const b = $('cpShowStocks');
  if (!a || !b) return;
  $('cptOut').style.display = stocks ? 'none' : '';
  $('cpsOut').style.display = stocks ? '' : 'none';
  for (const [el, onIt] of [[a, !stocks], [b, stocks]]) {
    el.setAttribute('aria-selected', String(onIt));
    el.style.background = onIt ? '' : 'var(--soft)';
    el.style.color = onIt ? '' : 'var(--ink)';
  }
  if (stocks && !CPS) {
    try {
      CPS = await api('/api/cp-stocks');
      cpsRender();
    } catch (e) {
      $('cpsOut').innerHTML = `<div class="err">Error: ${esc(e.message)}. Not advice.</div>`;
    }
  }
}
if ($('cpShowNifty')) {
  $('cpShowNifty').addEventListener('click', () => cpsShow(false));
  $('cpShowStocks').addEventListener('click', () => cpsShow(true));
}
