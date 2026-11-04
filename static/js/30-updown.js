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

let UD_SORT = { key: 'mom', dir: -1 };
function udTable(title, col, rows) {
  if (!rows.length) return `<div style="font-size:13px;margin-top:8px"><b style="color:${col}">${title}</b>: none today</div>`;
  const k = UD_SORT.key;
  const val = (x) => (k === 'symbol' ? x.symbol : k === 'fromHigh' ? 1 - x.hi52 : x[k] ?? -Infinity);
  const sorted = [...rows].sort((a, b) => (typeof val(a) === 'string' ? val(a).localeCompare(val(b)) : val(a) - val(b)) * UD_SORT.dir);
  const th = (key, label) => `<th data-udsort="${key}" style="cursor:pointer;white-space:nowrap">${label}${UD_SORT.key === key ? (UD_SORT.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  return `<div style="font-size:14px;margin-top:10px"><b style="color:${col}">${title}</b> (${rows.length})</div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr>${th('symbol', 'Stock')}${th('close', 'Price')}${th('mom', '12-month momentum')}${th('momPct', 'Rank')}${th('fromHigh', 'Below 52-week high')}${th('rsi', 'RSI')}<th>200-day avg</th>${th('foLot', 'F&O lot')}<th></th></tr></thead><tbody>${sorted.map((x) =>
      `<tr><td style="text-align:left"><b>${esc(x.symbol)}</b></td><td>₹${x.close.toFixed(1)}</td><td style="color:${x.mom >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${x.mom >= 0 ? '+' : ''}${(x.mom * 100).toFixed(0)}%</b></td><td>${Math.round(x.momPct * 100)}</td><td>${((1 - x.hi52) * 100).toFixed(1)}%</td><td>${x.rsi.toFixed(0)}</td><td>${x.above200 ? 'above' : 'below'}</td><td>${x.foLot ?? '–'}</td>
        <td style="white-space:nowrap"><a href="#" data-ud="${esc(x.symbol)}">Outlook</a>${x.foLot ? ` · <a href="#" data-fr="${esc(x.symbol)}" data-lean="${x.label}">Risk check</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
let UD_LAST = null;
function udRender(d) {
  UD_LAST = d;
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
  if (d.baskets) {
    const b = d.baskets;
    const hs = [['1m', '1 month'], ['3m', '3 months'], ['6m', '6 months'], ['12m', '1 year']];
    const cell = (x) => `${udPc(x.early)} / ${udPc(x.late)}`;
    const get = (k, w, f) => ({ early: b.early[k][w][f], late: b.late[k][w][f] });
    html += `<div style="font-size:14px;margin-top:12px"><b>Basket odds</b> — hold <b>all ${d.counts?.strong ?? ''} STRONG stocks together</b> instead of one (share of times up · 2010–17 / 2018→)</div>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Held for</th>${hs.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
        <tr><td style="text-align:left"><b>🟢 All STRONG stocks together</b></td>${hs.map(([k]) => `<td><b>${cell(get(k, 'strongBasket', 'up'))}</b></td>`).join('')}</tr>
        <tr><td style="text-align:left">One STRONG stock alone</td>${hs.map(([k]) => `<td>${cell(get(k, 'singleStrong', 'up'))}</td>`).join('')}</tr>
        <tr><td style="text-align:left">NIFTY</td>${hs.map(([k]) => `<td>${cell(get(k, 'nifty', 'up'))}</td>`).join('')}</tr>
        <tr><td style="text-align:left">🔴 All WEAK stocks together</td>${hs.map(([k]) => `<td>${cell(get(k, 'weakBasket', 'up'))}</td>`).join('')}</tr>
        <tr><td style="text-align:left">STRONG basket beat NIFTY</td>${hs.map(([k]) => `<td>${cell(get(k, 'strongBasket', 'beatsNifty'))}</td>`).join('')}</tr>
        <tr><td style="text-align:left">Average move: STRONG / WEAK basket (all years)</td>${hs.map(([k]) => `<td>${udMv(b.all[k].strongBasket.avg)} / ${udMv(b.all[k].weakBasket.avg)}</td>`).join('')}</tr>
      </tbody></table></div>
      <div class="note">Equal amounts in every STRONG stock on the first trading day of each month since 2010 (before costs and tax). Holding many strong stocks together is far more reliable than one, and a longer hold raises the odds further — Momentum 10 / 20 is this idea as a ready portfolio.</div>`;
  }
  if (d.counts) {
    html += `<div style="font-size:14px;margin-top:12px"><b>Today's labels</b> (NSE top 200, close of ${esc(d.date)}): ${d.counts.strong} strong · ${d.counts.neutral} neutral · ${d.counts.weak} weak</div>
      ${udTable('🟢 Strong — slight lean up', 'var(--up)', d.strong)}${udTable('🔴 Weak — slight lean down', 'var(--down)', d.weak)}
      <div class="note">Click a column to sort. <b>Outlook</b> shows the stock above; <b>Risk check</b> opens it in Options & risk → F&O risk check (F&O stocks only). Momentum = return from 12 months ago to 1 month ago; rank = where that sits among the NSE top 200 (100 = strongest).</div>`;
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
  for (const t of document.querySelectorAll('#udOut [data-udsort]')) t.addEventListener('click', () => {
    const key = t.dataset.udsort;
    UD_SORT = { key, dir: UD_SORT.key === key ? -UD_SORT.dir : key === 'symbol' || key === 'fromHigh' ? 1 : -1 };
    udRender(UD_LAST);
  });
  // open a stock in the F&O risk check (Options & risk tab), with the side its lean points to
  for (const a of document.querySelectorAll('#udOut [data-fr]')) a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#options';
    setTimeout(() => {
      $('frSym').value = a.dataset.fr;
      $('frStrat').value = a.dataset.lean === 'weak' ? 'buy-put' : 'buy-call';
      $('foRiskCard')?.scrollIntoView();
      frLoad();
    }, 300);
  });
}
async function udLoad() {
  $('udBtn').disabled = true;
  try { udRender(await api(`/api/updown?symbol=${encodeURIComponent($('udSym').value.trim() || 'RELIANCE')}`)); } catch (e) { $('udOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; } finally { $('udBtn').disabled = false; }
}
lazy('Up/Down outlook', udLoad);
$('udBtn').addEventListener('click', udLoad);
$('udSym').addEventListener('keydown', (e) => e.key === 'Enter' && udLoad());
