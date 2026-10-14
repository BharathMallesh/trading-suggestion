// 04-home-trades.js — Ask the app; My trades (plan a trade, journal, daily loss limit, price alerts).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Ask the app ---
function aaRender(r) {
  let html = `<div style="font-size:16px;font-weight:700;margin-bottom:6px">${esc(r.title)}</div>`;
  if (r.summary?.length) html += '<ul style="margin:0 0 8px 18px;padding:0;font-size:14px;line-height:1.5">' + r.summary.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>';
  for (const sec of r.sections || []) {
    html += `<div style="font-size:13px;margin-top:10px"><b>${esc(sec.heading)}</b></div>`;
    if (sec.kind === 'table') html += `<table><thead><tr>${sec.columns.map((c, i) => `<th${i === 0 ? ' style="text-align:left"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${sec.rows.map((row) => `<tr>${row.map((c, i) => `<td${i === 0 ? ' style="text-align:left"' : ''}>${esc(String(c ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    else if (sec.kind === 'kv') html += `<div class="kv">${sec.rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('')}</div>`;
    else if (sec.kind === 'list') html += '<ul style="margin:4px 0 0 18px;padding:0;font-size:13px">' + sec.items.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>';
    else html += `<div style="font-size:13px">${esc(sec.text || '')}</div>`;
    if (sec.note) html += `<div class="note">${esc(sec.note)}</div>`;
  }
  if (r.caveat) html += `<div class="note" style="margin-top:10px;border-left:3px solid var(--warn);padding-left:8px">${esc(r.caveat)}</div>`;
  $('aaOut').innerHTML = html + '<div class="note">Research / education only — not investment advice.</div>';
}
async function aaAsk(question) {
  const q = (question ?? $('aaQ').value).trim();
  if (!q) return;
  $('aaQ').value = q;
  $('aaOut').textContent = 'Looking it up with the app\'s tools…';
  $('aaBtn').disabled = true;
  try {
    aaRender(await api('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) }));
  } catch (e) {
    $('aaOut').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  } finally {
    $('aaBtn').disabled = false;
  }
}
$('aaBtn').addEventListener('click', () => aaAsk());
$('aaQ').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') aaAsk();
});
for (const chip of document.querySelectorAll('.aaChip')) chip.addEventListener('click', () => aaAsk(chip.textContent));

// --- My trades: plan, journal, alerts ---
const rsj = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let lastPlan = null;
function planInput() {
  return { symbol: $('plSym').value, side: $('plSide').value, product: $('plProduct').value, setup: $('plSetup').value, entry: $('plEntry').value, stop: $('plStop').value, target: $('plTarget').value };
}
$('plBtn').addEventListener('click', async () => {
  $('plOut').innerHTML = '<div class="note">Checking…</div>';
  try {
    const p = await post('/api/journal/plan', planInput());
    lastPlan = p;
    const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
    $('plOut').innerHTML = `<div style="font-size:15px"><b>${p.side === 'long' ? 'Buy' : 'Short'} ${p.qty} shares of ${esc(p.symbol.replace('.NS', ''))}</b> at ₹${p.entry} · stop ₹${p.stop} · target ₹${(+p.target).toFixed(2)}</div>
      <table style="font-size:13px"><tbody>
        <tr><td>Position size</td><td>${rsj(p.positionValue)}${p.product === 'intraday' ? ` · margin at 5× ≈ ${rsj(p.marginNeeded)}` : ''}${p.cappedByCash ? ' · <span style="color:var(--warn)">limited by your capital</span>' : ''}</td></tr>
        <tr><td>If the stop hits</td><td style="color:var(--down)"><b>−${rsj(p.lossAtStop)}</b> after charges (${p.stopPct.toFixed(2)}% away)</td></tr>
        <tr><td>If the target hits</td><td style="color:var(--up)"><b>+${rsj(p.gainAtTarget)}</b> after charges · ${p.rrAfterCosts != null ? p.rrAfterCosts.toFixed(2) + '× the risk' : '–'}</td></tr>
        <tr><td>Today's risk</td><td>${p.risk ? `a normal day moves about ±${(p.risk.dailyMovePct ?? 0).toFixed(1)}% · chance today moves ${p.stopPct.toFixed(2)}% against you: <b>${pc(p.risk.chanceStopDistanceToday)}</b>` : 'odds unavailable'}</td></tr>
      </tbody></table>
      <div style="margin-top:6px;font-size:13px"><b>Rules check</b></div>
      <ul style="margin:4px 0 0 18px;font-size:13px">${p.checks.map((c) => `<li style="color:${c.ok ? 'var(--up)' : 'var(--down)'}">${c.ok ? '✓' : '✗'} ${esc(c.rule)} <span class="note" style="display:inline">${esc(c.detail)}</span></li>`).join('')}</ul>
      <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px">${p.allOk ? '<b style="color:var(--up)">All rules kept.</b>' : `<b style="color:var(--down)">${p.checks.filter((c) => !c.ok).length} rule(s) broken.</b> You can still record it, but it will count as a rule-break in your scorecard.`} This checks discipline, not whether the trade will work.</div>
      <div class="row" style="gap:8px;align-items:flex-end">
        <div><label>Shares actually bought (blank = ${p.qty})</label><input id="plQty" type="number" min="1" step="1" /></div>
        <div style="flex:2"><label>Why this trade? (optional)</label><input id="plNote" placeholder="e.g. pullback to 20 MA in an uptrend" /></div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:6px"><input type="checkbox" id="plAlerts" checked style="width:auto" /> Add price alerts at the stop and the target</label>
      <button id="plSave" type="button">I placed this trade: save to journal</button> <span id="plSaved" class="note" style="display:inline"></span>`;
    $('plSave').addEventListener('click', async () => {
      try {
        await post('/api/journal/add', { ...planInput(), qty: $('plQty').value, note: $('plNote').value, withAlerts: $('plAlerts').checked });
        $('plSaved').textContent = 'Saved. It is in your journal below; close it there when you exit.';
        jnLoad();
      } catch (e) {
        $('plSaved').innerHTML = `<span class="err">${esc(e.message)}</span>`;
      }
    });
  } catch (e) {
    $('plOut').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
});
async function jnLoad() {
  try {
    const d = await api('/api/journal');
    if (!$('plSetup').options.length) $('plSetup').innerHTML = d.setups.map((x) => `<option>${esc(x)}</option>`).join('');
    const s = d.settings;
    if (!$('jsCap').value) { $('jsCap').value = s.capital; $('jsRisk').value = s.riskPct; $('jsLimit').value = s.dailyLossPct; $('jsMax').value = s.maxTradesPerDay; }
    const t = d.today;
    const pct = Math.min(100, Math.max(0, (-t.realisedRs / t.limitRs) * 100));
    $('jnToday').innerHTML = `<div style="padding:10px 12px;border-radius:10px;border:1px solid ${t.limitHit ? 'var(--down)' : 'var(--line)'};background:var(--soft)">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:14px"><b>Today ${esc(t.date)}</b>
        <span>Result <b style="color:${t.realisedRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rsj(t.realisedRs)}</b> · trades ${t.trades}/${t.maxTrades}${t.open ? ` · ${t.open} open` : ''}</span></div>
      <div style="height:8px;background:var(--panel);border-radius:4px;overflow:hidden;margin-top:6px"><div style="height:100%;width:${pct}%;background:${t.limitHit ? 'var(--down)' : 'var(--warn)'}"></div></div>
      <div class="note" style="color:${t.limitHit ? 'var(--down)' : 'var(--muted)'}">${t.limitHit ? `<b>Daily loss limit reached (−${rsj(t.limitRs)}). Stop trading for today.</b>` : `Daily loss limit −${rsj(t.limitRs)} · room left ${rsj(t.roomLeftRs)}${t.open ? ` · worst case if open trades hit their stops: ${rsj(t.worstCaseRs)}` : ''}`}</div></div>`;
    const st = d.stats;
    const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
    let html = '';
    const open = d.trades.filter((x) => x.status === 'open');
    if (open.length) html += `<div style="font-size:14px"><b>Open trades</b></div><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Side</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th><th>Risk</th><th>Exit price</th><th></th></tr></thead><tbody>${open.map((x) =>
      `<tr><td style="text-align:left">${esc(x.symbol.replace('.NS', ''))} <span class="note" style="display:inline">${esc(x.date)} ${esc(x.time)}</span></td><td>${x.side === 'long' ? 'buy' : 'short'}</td><td>${x.qty}</td><td>${x.entry}</td><td>${x.stop}</td><td>${(+x.target).toFixed(2)}</td><td>${rsj(x.lossAtStop)}</td>
        <td><input type="number" step="0.05" data-exit="${esc(x.id)}" style="width:90px" /></td><td><button type="button" data-close="${esc(x.id)}" style="margin:0;padding:3px 10px">Close</button> <button type="button" data-del="${esc(x.id)}" title="Delete (entered by mistake)" style="margin:0;padding:3px 8px;background:var(--soft);color:var(--ink);border:1px solid var(--line)">✕</button></td></tr>`).join('')}</tbody></table>`;
    if (st.all.trades) {
      const a = st.all;
      html += `<div style="font-size:14px;margin-top:10px"><b>Your scorecard</b> · ${a.trades} closed trades</div>
        <table style="font-size:13px"><tbody>
          <tr><td>Total after charges</td><td style="color:${a.totalRs >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${rsj(a.totalRs)}</b> (charges paid ${rsj(a.chargesRs)})</td></tr>
          <tr><td>Win rate</td><td>${pc(a.winRate)} · average win ${rsj(a.avgWinRs)} · average loss ${rsj(a.avgLossRs)}</td></tr>
          <tr><td>Per trade (expectancy)</td><td><b>${rsj(a.expectancyRs)}</b>${a.avgR != null ? ` · ${a.avgR.toFixed(2)} R` : ''}${a.profitFactor != null ? ` · profit factor ${a.profitFactor.toFixed(2)}` : ''}</td></tr>
          <tr><td>Worst drawdown</td><td>${rsj(-st.maxDrawdownRs)}</td></tr>
          <tr><td>Rules kept vs broken</td><td>kept: ${st.rulesKept.trades || 0} trades, ${rsj(st.rulesKept.totalRs ?? 0)} · broken: ${st.rulesBroken.trades || 0} trades, ${rsj(st.rulesBroken.totalRs ?? 0)}</td></tr>
        </tbody></table>
        <table style="font-size:12px"><thead><tr><th style="text-align:left">Setup</th><th>Trades</th><th>Win rate</th><th>Per trade</th><th>Total</th></tr></thead><tbody>${Object.entries(st.bySetup).map(([k, v]) =>
          `<tr><td style="text-align:left">${esc(k)}</td><td>${v.trades}</td><td>${pc(v.winRate)}</td><td>${rsj(v.expectancyRs)}</td><td style="color:${v.totalRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rsj(v.totalRs)}</td></tr>`).join('')}</tbody></table>
        <div class="note">Judge yourself after 30+ trades: a positive "per trade" after charges over many trades is the only real proof. Compare with "Did my trading beat NIFTY?" in My portfolio.</div>`;
    } else html += `<div class="note">No closed trades yet. Plan a trade above, save it, and close it here when you exit.</div>`;
    const closed = d.trades.filter((x) => x.status === 'closed').slice(0, 30);
    if (closed.length) html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Closed trades (latest ${closed.length})</summary><table style="font-size:12px"><thead><tr><th style="text-align:left">Date</th><th>Stock</th><th>Side</th><th>Entry → exit</th><th>Net</th><th>R</th><th>Rules</th><th></th></tr></thead><tbody>${closed.map((x) =>
      `<tr><td style="text-align:left">${esc(x.date)}</td><td>${esc(x.symbol.replace('.NS', ''))}</td><td>${x.side === 'long' ? 'buy' : 'short'}</td><td>${x.entry} → ${x.exit}</td><td style="color:${x.net >= 0 ? 'var(--up)' : 'var(--down)'}">${rsj(x.net)}</td><td>${x.r != null ? x.r.toFixed(2) : '–'}</td><td title="${esc((x.brokenRules || []).join(' · '))}">${x.rulesOk ? '✓' : '✗'}</td><td><button type="button" data-del="${esc(x.id)}" style="margin:0;padding:2px 8px;background:var(--soft);color:var(--ink);border:1px solid var(--line)">✕</button></td></tr>`).join('')}</tbody></table></details>`;
    $('jnOut').innerHTML = html;
    alRender(d.alerts);
  } catch (e) {
    $('jnOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('jnOut').addEventListener('click', async (e) => {
  const c = e.target?.dataset?.close;
  const del = e.target?.dataset?.del;
  try {
    if (c) {
      const inp = $('jnOut').querySelector(`input[data-exit="${CSS.escape(c)}"]`);
      if (!inp.value) return (inp.style.outline = '2px solid var(--down)');
      const r = await post('/api/journal/close', { id: c, exit: inp.value });
      if (r.limitJustHit) $('jnToday').scrollIntoView({ behavior: 'smooth' });
      jnLoad();
    } else if (del) {
      e.target.textContent = 'Sure?';
      if (e.target.dataset.confirm !== '1') return (e.target.dataset.confirm = '1');
      await post('/api/journal/delete', { id: del });
      jnLoad();
    }
  } catch (err) {
    $('jnOut').insertAdjacentHTML('afterbegin', `<div class="err">${esc(err.message)}</div>`);
  }
});
$('jsSave').addEventListener('click', async () => {
  try {
    await post('/api/journal/settings', { capital: $('jsCap').value, riskPct: $('jsRisk').value, dailyLossPct: $('jsLimit').value, maxTradesPerDay: $('jsMax').value });
    $('jsNote').textContent = 'Saved.';
    jnLoad();
  } catch (e) {
    $('jsNote').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
});
function alRender(alerts) {
  const act = alerts.filter((a) => !a.triggeredAt);
  const done = alerts.filter((a) => a.triggeredAt && a.triggeredAt !== 'closed').slice(0, 15);
  $('alOut').innerHTML = (act.length ? `<div style="font-size:14px"><b>Active (${act.length})</b></div><table style="font-size:12px"><tbody>${act.map((a) =>
    `<tr><td style="text-align:left"><b>${esc(a.symbol.replace('.NS', ''))}</b> ${a.op === 'above' ? 'rises above' : 'falls below'} ₹${a.price}</td><td class="note" style="text-align:left">${esc(a.note || '')}</td><td><button type="button" data-al="${esc(a.id)}" style="margin:0;padding:2px 8px;background:var(--soft);color:var(--ink);border:1px solid var(--line)">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="note">No active alerts.</div>') +
    (done.length ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px">Triggered (${done.length})</summary><ul style="margin:4px 0 0 18px;font-size:12px">${done.map((a) => `<li>${esc(a.symbol.replace('.NS', ''))} ${a.op === 'above' ? 'rose above' : 'fell below'} ₹${a.price} at ${esc(new Date(new Date(a.triggeredAt).getTime() + 19800000).toISOString().slice(0, 16).replace('T', ' '))} IST${a.note ? ` — ${esc(a.note)}` : ''}</li>`).join('')}</ul></details>` : '');
}
$('alOut').addEventListener('click', async (e) => {
  const a = e.target?.dataset?.al;
  if (!a) return;
  try {
    await post('/api/alerts/delete', { id: a });
    jnLoad();
  } catch (err) {
    $('alOut').insertAdjacentHTML('afterbegin', `<div class="err">${esc(err.message)}</div>`);
  }
});
$('alBtn').addEventListener('click', async () => {
  try {
    await post('/api/alerts/add', { symbol: $('alSym').value, op: $('alOp').value, price: $('alPrice').value, note: $('alNote').value });
    $('alPrice').value = '';
    $('alNote').value = '';
    jnLoad();
  } catch (e) {
    $('alOut').insertAdjacentHTML('afterbegin', `<div class="err">${esc(e.message)}</div>`);
  }
});
lazy('Trade journal', jnLoad);
