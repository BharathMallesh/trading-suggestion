// 08-intraday-vwap.js — YouTube intraday strategy (VWAP + 20 MA pullback).
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Same stocks every day (VWAP + 20 MA pullback) ---
function vpbRender(d) {
  const b = d.backtest;
  const rs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
  const row = (name, x) => !x || !x.trades ? '' : `<tr><td style="text-align:left">${esc(name)}</td><td>${x.trades}</td><td>${Math.round(x.winRate * 100)}%</td><td>${rs(x.avgGrossRs)}</td><td>${rs(x.avgChargesRs)}</td>
    <td style="color:${x.avgNetRs >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${rs(x.avgNetRs)}</b></td><td style="color:${x.totalNetRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(x.totalNetRs)}</td><td>${x.tStat?.toFixed(1) ?? '–'}</td></tr>`;
  const head = '<table><thead><tr><th style="text-align:left">Version</th><th>Trades</th><th>Win</th><th>Avg before costs</th><th>Avg charges</th><th>Avg after costs</th><th>Total</th><th>t</th></tr></thead><tbody>';
  let html = '';
  if (b) {
    html += `<div style="font-size:14px"><b>Backtest verdict: ${esc(b.verdict)}</b></div>
      <div class="note">${b.sessions} sessions (${esc(b.from)} → ${esc(b.to)}) · risk ₹${b.rules.riskRs.toLocaleString('en-IN')} per trade</div>` + head +
      row('Video rules (target 1:2)', b.perTrade) + row('…first half', b.firstHalf) + row('…second half', b.secondHalf) + row('Account: max 2 trades a day', b.account2PerDay) +
      Object.entries(b.sensitivity).filter(([k]) => k !== '1:2').map(([k, v]) => row(`Target ${k}`, v)).join('') +
      Object.entries(b.variants || {}).map(([k, v]) => row(k, v)).join('') +
      row(`Same rules on ${b.widerList.stocks} other large stocks`, b.widerList) +
      Object.entries(b.perStock).map(([k, v]) => row(k.replace('.NS', ''), v)).join('') + '</tbody></table>' +
      `<div class="note">${esc(b.note)}</div>`;
  }
  const p = d.paper;
  html += `<div style="font-size:14px;margin-top:10px"><b>Live paper record</b> ${p.startedAt ? `since ${esc(p.startedAt)}` : '(starts with the first session after today)'} — recorded every trading day after the close, for the video's rules, the improved version and the morning scanner side by side.</div>`;
  const imp = d.improve?.pick;
  if (imp) html += `<div class="note">Improvement test (chosen on the first half, judged on the second): best was <b>${esc(imp.name)}</b> — ${imp.testVideoStocks.avgNetRs >= 0 ? '+' : '−'}₹${Math.abs(Math.round(imp.testVideoStocks.avgNetRs))}/trade on the video stocks but ${imp.testWiderStocks.avgNetRs >= 0 ? '+' : '−'}₹${Math.abs(Math.round(imp.testWiderStocks.avgNetRs))}/trade on 16 other stocks → ${imp.adopt ? 'adopted' : 'not adopted'}.</div>`;
  const r2 = d.improve?.round2;
  if (r2) {
    const cell = (x) => !x || !x.trades ? '<td>0</td><td>–</td><td>–</td>' : `<td>${x.trades}</td><td>${Math.round(x.winRate * 100)}%</td><td style="color:${x.avgNetRs >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${rs(x.avgNetRs)}</b></td>`;
    const names = { limitEntry: 'limit order at the 20 MA', trailMa: 'trailing exit (close back across the MA)', volumeConfirm: 'volume confirmation', morningGap: 'morning gap ≥ 0.5% (in-play stocks)', trendDay: 'trend day (first 30 min ≥ 0.5%)' };
    const label = (n) => n.replace(/limitEntry|trailMa|volumeConfirm|morningGap|trendDay/g, (k) => names[k]);
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px"><b>Round 2 ideas</b>: unseen days only (${esc(d.improve.splitDate)} →), ${d.improve.sessions || '?'} sessions of saved history</summary>
      <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th><th>Video stocks: trades</th><th>Win</th><th>Avg after costs</th><th>16 other stocks: trades</th><th>Win</th><th>Avg after costs</th></tr></thead><tbody>${r2.map((v) => `<tr><td style="text-align:left">${esc(label(v.name))}</td>${cell(v.video)}${cell(v.others)}</tr>`).join('')}</tbody></table></div>
      <div class="note">None is proven: every version lost in the first half of the period and did better in the second, so the market's mood mattered more than the filter. The best (morning gap) is now paper-tracked as a third version. The test gets longer every day as 5-minute candles are saved.</div></details>`;
  }
  const od = d.odds;
  if (od?.model) {
    const e = od.evaluation || {};
    const pc = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
    const L = { dailyTrend: 'Daily trend', morningMove: 'Move by 09:30', nifty: 'NIFTY', time: 'Time of signal', volatility: 'Volatility (ATR %)' };
    const LV = { with: 'with the trade', against: 'against', flat: 'small', mixed: 'mixed', early: 'before 10:30', midday: '10:30–12:00', late: 'after 12:00', high: 'above median', low: 'below median' };
    html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px"><b>Signal odds</b>: ${pc(od.model.base)} of ${od.signals} past signals ended in profit after costs · ${od.adopted ? 'condition-adjusted odds in use' : 'plain rate in use (conditions did not help on unseen days)'}</summary>
      <table style="font-size:12px"><thead><tr><th style="text-align:left">Condition at the signal</th><th>Won (after costs)</th><th>Signals</th></tr></thead><tbody>${Object.entries(od.model.table).flatMap(([k, lv]) => Object.entries(lv).map(([l, c]) =>
        `<tr><td style="text-align:left">${esc(L[k] || k)}: ${esc(LV[l] || l)}</td><td>${pc(c.rawRate)}</td><td>${c.n}</td></tr>`)).join('')}</tbody></table>
      ${e.enough ? `<div class="note">Unseen-days check (fit before ${esc(e.splitDate)}, scored after): adjusted odds ${e.skill > 0 ? (e.skill * 100).toFixed(1) + '% better' : (-e.skill * 100).toFixed(1) + '% worse'} than the plain rate (Brier). Higher-odds half won ${pc(e.higherOdds.winRate)} (avg ${rs(e.higherOdds.avgNetRs)}/trade), lower-odds half ${pc(e.lowerOdds.winRate)} (avg ${rs(e.lowerOdds.avgNetRs)}). Break-even at 1:2 after costs needs about 38–40%.</div>` : '<div class="note">Not enough signals yet for the unseen-days check.</div>'}
    </details>`;
  }
  const meters = Object.values(p.byVariant || {}).filter((x) => x.trust);
  if (meters.length) {
    const col = { pass: 'var(--up)', fail: 'var(--down)', unclear: 'var(--warn)', early: 'var(--accent)' };
    html += `<div style="font-size:13px;margin-top:8px"><b>When can we trust it?</b> <span class="note" style="display:inline">Finish line set in advance: ${meters[0].trust.needTrades} trades over ${meters[0].trust.needDays} trading days, profitable after costs with t ≥ 2.</span></div>` +
      meters.map((x) => `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;gap:8px;font-size:12px"><span>${esc(x.label)}</span><span>${x.trust.trades}/${x.trust.needTrades} trades · ${x.trust.days}/${x.trust.needDays} days</span></div>
        <div style="height:8px;background:var(--soft);border-radius:4px;overflow:hidden"><div style="height:100%;width:${Math.round(x.trust.progress * 100)}%;background:${col[x.trust.level]}"></div></div>
        <div class="note" style="color:${x.trust.level === 'early' ? 'var(--muted)' : col[x.trust.level]}">${esc(x.trust.verdict)}</div></div>`).join('');
  }
  const unseen = Object.values(p.byVariant || {}).filter((x) => x.live?.notSeen);
  if (unseen.length) html += `<div class="note" style="color:var(--warn)">Seen live check: ${unseen.map((x) => `${esc(x.label.split(':')[0])}: ${x.live.notSeen} of ${x.live.checked} recorded trades were not visible during the day (net ${rs(x.live.netNotSeen)})`).join(' · ')}. Yahoo corrected those candles after the close, so a live trader could not have taken them.</div>`;
  const yours = Object.values(p.byVariant || {}).filter((x) => x.yours?.trades);
  if (yours.length) html += `<div class="note" style="color:var(--ink)"><b>At your size</b> (${esc(sizeLabel())}): ${yours.map((x) => `${esc(x.label.split(':')[0])} ${x.yours.trades} trades, total <b style="color:${x.yours.totalNetRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(x.yours.totalNetRs)}</b>`).join(' · ')}</div>`;
  const anyPaper = Object.values(p.byVariant || {}).some((x) => x.trades);
  if (anyPaper) {
    html += head + Object.values(p.byVariant).map((x) => row(x.label, x)).join('') + '</tbody></table>' +
      `<table style="font-size:12px"><thead><tr><th style="text-align:left">Date</th><th>Stock</th><th>Side</th><th>Entry</th><th>Exit</th><th>Why</th><th>Net</th></tr></thead><tbody>${p.trades.map((t) =>
        `<tr><td style="text-align:left">${esc(t.date)} ${esc(t.time)} <span style="color:var(--muted);font-size:11px">${esc(t.variant || 'video')}</span></td><td>${esc(t.symbol.replace('.NS', ''))}</td><td>${esc(t.side)}</td><td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>${esc(t.reason)}${t.seenLive === false ? ' <span style="color:var(--warn)" title="Not visible during the day: Yahoo corrected the candles after the close">· not seen live</span>' : ''}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(t.net)}</td></tr>`).join('')}</tbody></table>`;
  } else html += '<div class="note">No paper trades recorded yet.</div>';
  $('vpbOut').innerHTML = html;
}
// your capital / risk % (kept in this browser only)
const SIZE_KEY = 'vpbSize';
function getSize() {
  try { return JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'); } catch { return null; }
}
function sizeQuery() {
  const z = getSize();
  return z ? `?capital=${encodeURIComponent(z.capital)}&riskPct=${encodeURIComponent(z.riskPct)}` : '';
}
function sizeLabel() {
  const z = getSize() || { capital: 100000, riskPct: 1 };
  return `₹${Number(z.capital).toLocaleString('en-IN')} capital · ${z.riskPct}% risk = ₹${Math.round(z.capital * z.riskPct / 100).toLocaleString('en-IN')} a trade`;
}
{
  const z = getSize();
  if (z) { $('vpbCap').value = z.capital; $('vpbRisk').value = z.riskPct; }
  $('vpbSizeNote').textContent = (z ? 'Showing your size: ' : 'Standard size: ') + sizeLabel();
}
$('vpbSizeBtn').addEventListener('click', async () => {
  const capital = Number($('vpbCap').value);
  const riskPct = Number($('vpbRisk').value);
  if (!(capital >= 10000) || !(riskPct > 0 && riskPct <= 5)) {
    $('vpbSizeNote').textContent = 'Capital must be at least ₹10,000 and risk between 0.1% and 5%.';
    return;
  }
  try { localStorage.setItem(SIZE_KEY, JSON.stringify({ capital, riskPct })); } catch { /* storage unavailable: applies to this view only */ }
  $('vpbSizeNote').textContent = 'Showing your size: ' + sizeLabel();
  vpbToday();
  try { vpbRender(await api('/api/vwap-pullback' + sizeQuery())); } catch (e) { $('vpbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
$('vpbCalcBtn').addEventListener('click', async () => {
  const z = getSize() || { capital: Number($('vpbCap').value) || 100000, riskPct: Number($('vpbRisk').value) || 1 };
  try {
    const r = await api(`/api/position-size?entry=${encodeURIComponent($('vpbEntry').value)}&stop=${encodeURIComponent($('vpbStop').value)}&capital=${z.capital}&riskPct=${z.riskPct}`);
    const rs = (v) => '₹' + Math.round(v).toLocaleString('en-IN');
    $('vpbCalcOut').innerHTML = r.qty
      ? `<b>${r.side === 'long' ? 'Buy' : 'Sell short'} ${r.qty} shares</b> (risking ${rs(r.riskRs)} at ${r.perShareRisk.toFixed(2)} a share) · position ${rs(r.positionValue)} · margin at 5× ≈ ${rs(r.marginNeeded)}${r.cappedByLeverage ? ' · <span style="color:var(--warn)">capped by 5× intraday leverage</span>' : ''}<br>
         Loss if the stop hits: <b style="color:var(--down)">−${rs(r.lossAtStop)}</b> (incl. charges) · 1:2 target ${r.target.toFixed(2)}: <b style="color:var(--up)">+${rs(r.gainAtTarget)}</b> after charges`
      : esc(r.note);
  } catch (e) {
    $('vpbCalcOut').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
});
async function vpbToday() {
  try {
    const d = await api('/api/vwap-today' + sizeQuery());
    const rs = (v) => (v == null ? '–' : (v < 0 ? '−₹' : '+₹') + Math.abs(Math.round(v)).toLocaleString('en-IN'));
    $('vpbTodayWhen').textContent = d.date ? `${d.live ? 'live' : 'last session'} · ${d.date} · candles to ${d.lastBar} · new trades until ${d.newEntriesUntil}, all closed by ${d.exitAt}` : '';
    let h = '';
    for (const v of Object.values(d.variants || {})) {
      h += `<div style="font-size:13px;margin-top:8px"><b>${esc(v.label)}</b> — ${v.trades.length ? `${v.trades.length} trade${v.trades.length > 1 ? 's' : ''}, <span style="color:${v.netRs >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(v.netRs)}</span>` : 'no trades'}${d.live ? ` · ${v.slotsLeft} slot${v.slotsLeft === 1 ? '' : 's'} left today` : ''}</div>`;
      if (v.trades.length) h += `<table style="font-size:12px;margin-top:4px"><thead><tr><th style="text-align:left">Stock</th><th>Side</th><th>Entry time</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th><th>${d.live ? 'Now / exit' : 'Exit'}</th><th>Status</th><th>P&amp;L after charges</th><th>Chance at entry*</th></tr></thead><tbody>${v.trades.map((t) =>
        `<tr><td style="text-align:left">${esc(t.symbol.replace('.NS', ''))}</td><td>${esc(t.side)}</td><td>${esc(t.time)}</td><td>${t.qty}</td><td>${t.entry.toFixed(2)}</td><td>${t.stop.toFixed(2)}</td><td>${t.target == null ? 'trailing' : t.target.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>${t.open ? '<b>open</b>' : esc(t.reason === 'close' ? 'closed at last candle' : t.reason)}</td><td style="color:${t.net >= 0 ? 'var(--up)' : 'var(--down)'}"><b>${rs(t.net)}</b></td><td title="${esc(t.odds?.reasons?.map((r) => `${r.condition}: ${r.level} (${Math.round(r.winRate * 100)}% of ${r.signals})`).join(' · ') || 'plain win rate of past signals')}">${t.odds ? Math.round(t.odds.prob * 100) + '%' + (t.odds.adjusted ? '' : ' <span class="note" style="display:inline">(avg)</span>') : '–'}</td></tr>`).join('')}</tbody></table>`;
    }
    const anyOdds = Object.values(d.variants || {}).some((v) => v.trades.some((t) => t.odds));
    if (anyOdds) h += `<div class="note">* Chance the trade ends in profit after costs, judged when it was entered, from how past signals turned out (a trade already well in profit has better odds than this). "(avg)" = the plain win rate of all past signals: adjusting for conditions didn't beat it on unseen days.</div>`;
    const st = (d.stocks || []).filter((x) => x.video || x.inPlay);
    if (st.length) h += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Where each stock stands (4 video stocks + scanner stocks that moved ≥ 0.5% by 09:30)</summary>
      <table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Price</th><th>20 MA</th><th>VWAP</th><th>Trend now</th><th>Daily trend</th><th>Move by 09:30</th></tr></thead><tbody>${st.map((x) =>
        `<tr><td style="text-align:left">${esc(x.symbol.replace('.NS', ''))}${x.video ? '' : ' <span class="note" style="display:inline">scanner</span>'}</td><td>${x.price.toFixed(1)}</td><td>${x.ma?.toFixed(1) ?? '–'}</td><td>${x.vwap.toFixed(1)}</td><td style="color:${x.trend === 'up' ? 'var(--up)' : x.trend === 'down' ? 'var(--down)' : 'var(--muted)'}">${x.trend === 'up' ? 'above both → longs only' : x.trend === 'down' ? 'below both → shorts only' : 'mixed → no trade'}</td><td>${esc(x.dailyTrend || '–')}</td><td>${x.gapPct == null ? '–' : (x.gapPct >= 0 ? '+' : '') + x.gapPct.toFixed(2) + '%'}</td></tr>`).join('')}</tbody></table></details>`;
    h += `<div class="note">${esc(d.note || '')}</div>`;
    $('vpbToday').innerHTML = h;
    return d.live;
  } catch (e) {
    $('vpbToday').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
    return false;
  }
}
// refresh every 3 minutes while the market is open
lazy('Same stocks every day', async function tick() {
  const live = await vpbToday();
  if (live) setTimeout(tick, 180_000);
});
$('vpbTodayBtn').addEventListener('click', () => {
  $('vpbToday').textContent = 'Loading…';
  vpbToday();
});
lazy('Same stocks every day', async () => {
  try {
    vpbRender(await api('/api/vwap-pullback' + sizeQuery()));
  } catch (e) {
    $('vpbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('vpbBtn').addEventListener('click', async () => {
  $('vpbOut').textContent = 'Running the backtest on ~60 days of 5-minute candles…';
  try {
    vpbRender(await api('/api/vwap-pullback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) {
    $('vpbOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
