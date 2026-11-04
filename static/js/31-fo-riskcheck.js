// 31-fo-riskcheck.js — Options & risk → F&O risk check: how bad can one week get for this account, before the trade.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const frRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const frCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');

function frRender(r) {
  const pct = (v) => `${((Math.abs(v) / r.account) * 100).toFixed(1)}%`;
  let html = `<div style="padding:10px 12px;border-radius:10px;border:2px solid ${r.ok ? 'var(--up)' : 'var(--down)'};font-size:14px"><b style="color:${r.ok ? 'var(--up)' : 'var(--down)'}">${r.ok ? '✅ Fits the account' : '⛔ Too big — don\'t place it like this'}</b> · ${esc(r.verdict)}
    ${r.tips.length ? `<ul style="margin:6px 0 0 18px;padding:0;font-size:13px">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
  if (r.lean) {
    const L = r.lean;
    const tag = { strong: ['🟢 STRONG — a slight lean up', 'var(--up)'], weak: ['🔴 WEAK — a slight lean down', 'var(--down)'], neutral: ['⚪ NEUTRAL — no lean', 'var(--muted)'] }[L.label] || [`NIFTY is ${L.label}`, 'var(--muted)'];
    const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const sideHint = L.label === 'strong' ? 'If you pick a side, this leans toward a call — the lean is small.' : L.label === 'weak' ? 'If you pick a side, this leans toward a put — the lean is small.' : 'No side is favoured.';
    html += `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--soft);font-size:13px"><b>Up/Down lean:</b> <b style="color:${tag[1]}">${esc(tag[0])}</b> · over the next month, ${L.label === 'strong' || L.label === 'weak' || L.label === 'neutral' ? 'stocks with this label' : 'NIFTY from here'} rose ${pc(L.up1m)} of the time (average ${L.avg1m == null ? '–' : `${(L.avg1m * 100).toFixed(1)}%`}) vs ${pc(L.baseUp1m)} overall (2018→). ${esc(sideHint)}
      ${L.why ? `<div class="note" style="margin:2px 0 0">${L.why.map((w) => esc(w)).join(' · ')}</div>` : ''}
      <div class="note" style="margin:2px 0 0">A 1–3 month tilt from the Up/Down outlook, not a forecast for this option's expiry: bought options lost money in the app's tests whichever side was picked.</div></div>`;
  }
  html += `<div style="font-size:13px;margin-top:8px"><b>${esc(r.symbol)} · ${esc(r.label)}</b> · ${r.lots} lot${r.lots === 1 ? '' : 's'} of ${r.lot} · price ${r.spot.toFixed(1)} · expiry ${esc(r.expiry)} (${r.sessions} sessions): ${r.legs.map((l) => `${l.side} ${l.strike} ${l.type} at ${l.price.toFixed(1)}`).join(' · ')}</div>`;
  html += `<div style="overflow-x:auto"><table style="font-size:12px;margin-top:6px"><tbody>
    <tr><td style="text-align:left">${r.sold ? 'Premium received' : 'Premium paid'}</td><td><b>${frRs(r.premium)}</b></td></tr>
    <tr><td style="text-align:left">Chance of profit at expiry</td><td><b>${Math.round(r.chanceOfProfit * 100)}%</b></td></tr>
    <tr><td style="text-align:left">Typical result to expiry</td><td style="color:${frCol(r.typical)}">${frRs(r.typical)}</td></tr>
    <tr><td style="text-align:left">Bad case (1 in 20)</td><td style="color:${frCol(r.bad20)}">${frRs(r.bad20)} (${pct(r.bad20)} of the account)</td></tr>
    <tr><td style="text-align:left"><b>Very bad case (1 in 100)</b></td><td style="color:${frCol(r.bad100)}"><b>${frRs(r.bad100)} (${pct(r.bad100)})</b> · your limit ${frRs(-r.allowedLoss)}</td></tr>
    <tr><td style="text-align:left">Worst since 2010</td><td style="color:${frCol(r.worstEver)}">${frRs(r.worstEver)} (${pct(r.worstEver)})</td></tr>
    <tr><td style="text-align:left">Maximum possible loss</td><td>${r.definedMaxLoss != null ? frRs(-r.definedMaxLoss) : '<b style="color:var(--down)">no limit</b>'}</td></tr>
    <tr><td style="text-align:left">Margin / money tied up</td><td>₹${Math.round(r.margin).toLocaleString('en-IN')}</td></tr>
  </tbody></table></div><div class="note">${esc(r.note)}</div>`;
  $('frOut').innerHTML = html;
}
let FR_REQ = 0; // only the newest check is shown (a slower earlier one must not overwrite it)
async function frLoad() {
  const my = ++FR_REQ;
  $('frBtn').disabled = true;
  const qs = new URLSearchParams({ symbol: ($('frSym').value || 'NIFTY').trim().toUpperCase(), strategy: $('frStrat').value, account: $('frAcct').value, lots: $('frLots').value, distance: $('frDist').value, wing: $('frWing').value, wingPct: $('frWingPct').value, maxLoss: $('frMax').value });
  try {
    const r = await api(`/api/fo-riskcheck?${qs}`);
    if (my === FR_REQ) frRender(r);
  } catch (e) {
    if (my === FR_REQ) $('frOut').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  } finally {
    if (my === FR_REQ) $('frBtn').disabled = false;
  }
}
lazy('F&O risk check', async () => {
  try {
    const s = await api('/api/fo-riskcheck?symbols=1');
    $('frSyms').innerHTML = s.symbols.map((x) => `<option value="${esc(x)}"></option>`).join('');
  } catch {
    /* the list is optional */
  }
  try {
    // today's Strong / Weak stocks that have options, with their momentum, to pick from
    const u = await api('/api/updown');
    const opt = (x, lean) => `<option value="${esc(x.symbol)}" data-lean="${lean}">${lean === 'strong' ? '🟢' : '🔴'} ${esc(x.symbol)} · ${x.mom >= 0 ? '+' : ''}${(x.mom * 100).toFixed(0)}% · ${((1 - x.hi52) * 100).toFixed(0)}% off high</option>`;
    const strong = (u.strong || []).filter((x) => x.foLot).sort((a, b) => b.mom - a.mom);
    const weak = (u.weak || []).filter((x) => x.foLot).sort((a, b) => a.mom - b.mom);
    $('frPick').innerHTML = '<option value="">— choose —</option>' + (strong.length ? `<optgroup label="Strong (lean up)">${strong.map((x) => opt(x, 'strong')).join('')}</optgroup>` : '') + (weak.length ? `<optgroup label="Weak (lean down)">${weak.map((x) => opt(x, 'weak')).join('')}</optgroup>` : '');
  } catch {
    /* the picker is optional */
  }
  if (!FR_REQ) frLoad(); // a check already asked for (e.g. from the Up/Down table) wins
});
$('frBtn').addEventListener('click', frLoad);
$('frPick').addEventListener('change', () => {
  const o = $('frPick').selectedOptions[0];
  if (!o?.value) return;
  $('frSym').value = o.value;
  if ($('frStrat').value.startsWith('buy')) $('frStrat').value = o.dataset.lean === 'weak' ? 'buy-put' : 'buy-call';
  frLoad();
});
