// 09-options-risk.js — Big-move odds, options positioning, selling volatility, foundation models, Call / Put payoff odds, volatility check.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Big-move odds ---
const bmPct = (x) => (x == null ? '–' : (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%');
function bmEvalHtml(r) {
  if (!r || !r.horizons) return '<div class="note">Not replayed yet — use "Re-run replay".</div>';
  const col = (v) => (v === 'skill' ? 'var(--up)' : v === 'worse' ? 'var(--down)' : 'var(--warn)');
  return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px"><div style="font-size:13px"><b>Replay</b> · ${esc(String(r.at).slice(0, 10))} · ${r.series} series</div>
    <table><thead><tr><th style="text-align:left">Horizon</th><th>Odds Brier ↓</th><th>Past-year rate</th><th>Normal curve</th><th>Skill vs past year</th><th>t</th><th>Unseen stocks skill</th><th>Verdict</th></tr></thead><tbody>${Object.entries(r.horizons).map(([h, x]) =>
      `<tr><td style="text-align:left">${h === '1d' ? 'Next session' : 'Next 5 sessions'}</td><td>${x.main.brierModel.toFixed(4)}</td><td>${x.main.brierPastYear.toFixed(4)}</td><td>${x.main.brierNormal.toFixed(4)}</td>
      <td>${x.main.skillPct >= 0 ? '+' : ''}${x.main.skillPct.toFixed(1)}%</td><td>${x.main.tVsPastYear.toFixed(1)}</td><td>${x.holdout ? (x.holdout.skillPct >= 0 ? '+' : '') + x.holdout.skillPct.toFixed(1) + '%' : '–'}</td>
      <td style="color:${col(x.verdict)};font-weight:600">${esc(x.verdict)}</td></tr>`).join('')}</tbody></table>
    <div style="font-size:12px;margin-top:6px">Calibration (next session): ${(r.horizons['1d']?.reliability || []).map((b) => `said ${bmPct(b.predicted)} → happened ${bmPct(b.observed)}`).join(' · ')}</div>
    <div class="note">${esc(r.rule)}</div></div>`;
}
lazy('Big-move odds', async () => {
  try {
    $('bmEval').innerHTML = bmEvalHtml(await api('/api/big-move-eval'));
  } catch (e) {
    $('bmEval').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('bmBtn').addEventListener('click', async () => {
  $('bmOut').textContent = 'Calculating…';
  try {
    const r = await api('/api/big-move?' + new URLSearchParams({ symbol: $('bmSym').value.trim() }));
    const tbl = (x, title) => `<div style="font-size:13px;margin-top:6px"><b>${title}</b> · typical move ±${x.sigmaPct.toFixed(2)}% (1σ)${x.validated ? ' · <span style="color:var(--up)">validated by replay</span>' : ''}</div>
      <table><thead><tr><th>Move bigger than</th><th>Chance (up or down)</th><th>…up</th><th>…down</th><th>Past year</th><th>Normal curve</th></tr></thead><tbody>${x.odds.map((o) =>
        `<tr><td>±${o.movePct}%</td><td style="font-weight:700">${bmPct(o.prob)}</td><td>${bmPct(o.probUp)}</td><td>${bmPct(o.probDown)}</td><td style="color:var(--muted)">${bmPct(o.pastYear)}</td><td style="color:var(--muted)">${bmPct(o.normal)}</td></tr>`).join('')}</tbody></table>`;
    $('bmOut').innerHTML = `<div class="note">${esc(r.symbol)} · last ${r.last.toFixed(2)} · data to ${esc(r.asOf)}${r.eventPending ? ' · <span style="color:var(--warn)">results due — odds widened</span>' : ''}</div>` +
      tbl(r.horizons['1d'], 'Next session') + tbl(r.horizons['5d'], 'Next 5 sessions') + `<div class="note">${esc(r.note)} Up and down chances are the tail shares, not a direction forecast.</div>`;
  } catch (e) {
    $('bmOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('bmEvalBtn').addEventListener('click', async () => {
  $('bmEval').textContent = 'Replaying 5 years across ~40 stocks…';
  try {
    $('bmEval').innerHTML = bmEvalHtml(await api('/api/big-move-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) {
    $('bmEval').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Options positioning ---
const OP_NAMES = { pcrOi: 'Put-call ratio (open interest)', pcrOiZ: '… vs its last 60 days (z)', pcrVol: 'Put-call ratio (volume)', netDoi: 'Net OI added (puts − calls)', skew: 'Put skew (3% OTM put − call IV)', skewZ: '… vs its last 60 days (z)' };
function opHtml(r) {
  if (!r || !r.horizons) return '<div class="note">Not run yet — click the button (first run downloads NSE data, 20–40 min).</div>';
  const l = r.latest;
  let html = `<div style="font-size:14px;margin-bottom:6px"><b>${esc(r.verdict)}</b></div>
    <div class="note">${r.days} sessions · ${esc(r.from)} → ${esc(r.to)}${r.blocked ? ` · partial: ${esc(r.blocked)}` : ''}</div>
    <div class="kv" style="margin:6px 0"><div>Latest (${esc(l.date)})</div><div>PCR (OI) ${l.pcrOi?.toFixed(2)} (${l.percentiles.pcrOi?.toFixed(0)}th percentile) · PCR (volume) ${l.pcrVol?.toFixed(2)} · put skew ${l.skew?.toFixed(1)} vol pts (${l.percentiles.skew?.toFixed(0)}th) · ATM IV ${l.atmIv?.toFixed(1)}%</div></div>`;
  for (const [h, x] of Object.entries(r.horizons)) {
    html += `<div style="font-size:13px;margin-top:8px"><b>Next ${h === '1d' ? 'session' : '5 sessions'}</b> · ${x.periods} periods · NIFTY up ${(x.baseUpRate * 100).toFixed(0)}% of the time</div>
      <table><thead><tr><th style="text-align:left">Signal</th><th>IC</th><th>t</th><th>1st / 2nd half</th><th>Up % when high / low</th><th style="text-align:left">Evidence</th></tr></thead><tbody>${Object.entries(x.features).map(([f, v]) =>
        `<tr><td style="text-align:left">${esc(OP_NAMES[f] || f)}</td><td>${v.ic.toFixed(3)}</td><td>${v.tStat.toFixed(2)}</td><td>${v.icFirstHalf.toFixed(3)} / ${v.icSecondHalf.toFixed(3)}</td><td>${(v.upRateWhenHigh * 100).toFixed(0)}% / ${(v.upRateWhenLow * 100).toFixed(0)}%</td><td style="text-align:left">${esc(v.evidence)}</td></tr>`).join('')}</tbody></table>`;
  }
  for (const c of r.robustness || []) {
    html += `<div style="font-size:13px;margin-top:8px"><b>Robustness check: ${esc(OP_NAMES[c.feature] || c.feature)}</b> · next-morning open→close IC ${c.icNextOpenToClose.toFixed(3)} (t ${c.tNextOpenToClose.toFixed(2)}) ·
      t after controlling for that day's NIFTY move ${c.tAfterControllingTodaysMove.toFixed(2)} → <b>${esc(c.verdict)}</b></div>`;
  }
  return html + `<div class="note">${esc(r.rule)} A signal that passes must also work from the next morning's open (the NSE data is published after the close) and survive controlling for that day's NIFTY move.</div>`;
}
lazy('Options positioning', async () => {
  try {
    $('opOut').innerHTML = opHtml(await api('/api/options-positioning'));
  } catch (e) {
    $('opOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('opBtn').addEventListener('click', async () => {
  $('opOut').textContent = 'Running… (downloads any missing NSE days first)';
  $('opBtn').disabled = true;
  try {
    $('opOut').innerHTML = opHtml(await api('/api/options-positioning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) {
    $('opOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('opBtn').disabled = false;
  }
});

// --- Selling volatility (premium replay) ---
function vpRender(r) {
  if (!r || !r.model) return '<div class="note">Not run yet — click the button.</div>';
  const p2 = (x) => (x == null || !Number.isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
  const row = (s) => !s.all ? '' : `<tr><td style="text-align:left">${esc(s.name)}</td><td>${s.all.weeks}</td><td>${p2(s.all.meanWeeklyPct)}</td><td>${s.all.tStat?.toFixed(2) ?? '–'}</td>
    <td>${s.all.winRatePct.toFixed(0)}%</td><td style="color:var(--down)">${p2(s.all.worstWeekPct)}</td><td>${p2(s.all.accountCagrPct)}</td><td>${p2(-s.all.accountMaxDrawdownPct)}</td>
    <td style="text-align:left;font-size:12px">${esc(s.verdict)}</td></tr>`;
  const table = (strats) => `<table><thead><tr><th style="text-align:left">Strategy</th><th>Weeks</th><th>Avg week (on margin)</th><th>t</th><th>Win</th><th>Worst week</th>
    <th>Account CAGR</th><th>Account max drop</th><th style="text-align:left">Verdict</th></tr></thead><tbody>${Object.values(strats).map(row).join('')}</tbody></table>`;
  const m = r.model;
  let html = `<div style="font-size:14px;margin-bottom:8px"><b>${esc(r.verdict)}</b></div>
    <div class="kv"><div>The premium</div><div>India VIX averaged ${m.premium.avgImpliedPct.toFixed(1)}% vs ${m.premium.avgRealisedPct.toFixed(1)}% actually realised; implied was higher in ${m.premium.pctWeeksImpliedAbove.toFixed(0)}% of weeks (${esc(m.from)} → ${esc(m.to)}).</div></div>`;
  if (r.real && !r.real.error && r.real.strategies) {
    const x = r.real;
    html += `<div style="margin-top:10px;font-size:13px"><b>Actual NSE option prices</b> · ${x.weeks} weekly trades · ${esc(x.from)} → ${esc(x.to)}${x.weeklyIvVsVix ? ` · real weekly ATM implied vol = ${x.weeklyIvVsVix.median.toFixed(2)} × India VIX (median)` : ''}${x.blocked ? ` · <span style="color:var(--warn)">partial: ${esc(x.blocked)}</span>` : ''}</div>` + table(x.strategies);
  } else if (r.real?.error) {
    html += `<div class="err" style="margin-top:8px">Real-price replay: ${esc(r.real.error)}</div>`;
  }
  html += `<div style="margin-top:10px;font-size:13px"><b>Model: priced from India VIX</b> (assumption-dependent)</div>` + table(m.strategies);
  html += `<div class="note">${esc(m.rule)}<br>${m.caveats.map(esc).join('<br>')}</div>`;
  return html;
}
lazy('Selling volatility', async () => {
  try {
    $('vpOut').innerHTML = vpRender(await api('/api/vol-premium'));
  } catch (e) {
    $('vpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('vpBtn').addEventListener('click', async () => {
  $('vpOut').textContent = 'Replaying… (downloads any missing NSE days first)';
  $('vpBtn').disabled = true;
  try {
    $('vpOut').innerHTML = vpRender(await api('/api/vol-premium', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  } catch (e) {
    $('vpOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('vpBtn').disabled = false;
  }
});

// --- Foundation models (Kronos / Chronos-Bolt tabs) ---
const FM_LABEL = { kronos: 'Kronos', chronos: 'Chronos-Bolt' };
let fmModel = 'kronos';
const fmPct = (x) => (x == null ? '–' : (x * 100).toFixed(0) + '%');
const fmSigned = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');
function fmReplayHtml(r) {
  if (!r || !r.verdict) return `<div class="note">${FM_LABEL[fmModel]} has not been replay-tested yet — use "Re-run replay test".</div>`;
  const col = r.verdict === 'helps' ? 'var(--good, #3fb950)' : r.verdict === 'hurts' ? 'var(--bad, #f85149)' : 'var(--warn)';
  const row = (h, x) => `<tr><td style="text-align:left">${h === '1d' ? 'Next session' : 'Next 5 sessions'}</td>
    <td>${x.brierModel.toFixed(4)}</td><td>${x.brierCurrent == null ? '<span title="The app makes no 5-day probability — compare with base rates">n/a</span>' : x.brierCurrent.toFixed(4)}</td><td>${x.brierClimatology.toFixed(4)}</td>
    <td>${x.tVsCurrent == null ? '–' : x.tVsCurrent.toFixed(2)}</td>
    <td>${fmPct(x.directionHitRate)} <span style="color:var(--muted)">(n ${x.directionN})</span></td>
    <td>${fmPct(x.holdout?.directionHitRate)}</td></tr>`;
  return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px">
    <div style="font-size:13px"><b>Replay test of ${esc(r.modelLabel)}</b> · ${esc(String(r.at).slice(0, 10))} · ${r.moments} past moments ·
      verdict <b style="color:${col}">${esc(r.verdict.toUpperCase())}</b></div>
    <table><thead><tr><th style="text-align:left">Horizon</th><th>${esc(r.modelLabel)} Brier ↓</th><th>App Brier</th><th>Base rates</th><th>t vs app</th><th>Direction right</th><th>…on unseen stocks</th></tr></thead>
    <tbody>${Object.entries(r.horizons).map(([h, x]) => row(h, x)).join('')}</tbody></table>
    ${r.horizons['1d']?.confident ? `<div style="font-size:13px;margin-top:6px">When ${esc(r.modelLabel)} was confident (≥ 80%) about the next session it said
      <b>${fmPct(r.horizons['1d'].confident.avgStated)}</b> on average — it came true <b>${fmPct(r.horizons['1d'].confident.cameTrue)}</b> of the time
      (${r.horizons['1d'].confident.n} cases). Read its percentages with that in mind.</div>` : ''}
    ${(r.confirmations || []).map((c) => `<div style="font-size:13px;margin-top:6px">Confirmation on ${c.moments} <i>fresh</i> past moments: verdict
      <b>${esc(c.verdict.toUpperCase())}</b> · direction right <b>${fmPct(c.directionHitRate)}</b> (z ${c.directionZ?.toFixed(2)}) · on unseen stocks ${fmPct(c.holdoutDirectionHitRate)}.</div>`).join('')}
    <div class="note">${esc(r.rule)} Direction right ≈ 50% = coin flip; needs z ≥ 2 on fresh data to count.</div></div>`;
}
async function fmShowReplay() {
  try {
    $('fmReplay').innerHTML = fmReplayHtml(await api('/api/foundation-replay?model=' + fmModel));
  } catch (e) {
    $('fmReplay').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('fmTabs').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  fmModel = e.target.dataset.model;
  [...$('fmTabs').children].forEach((b) => b.classList.toggle('active', b === e.target));
  $('fmBtn').textContent = 'Forecast with ' + FM_LABEL[fmModel];
  $('fmOut').innerHTML = '';
  fmShowReplay();
});
$('fmBtn').addEventListener('click', async () => {
  const out = $('fmOut');
  const model = fmModel;
  out.textContent = `Running ${FM_LABEL[model]} locally… (first run loads the model, ~15 s)`;
  try {
    const r = await api('/api/foundation?' + new URLSearchParams({ model, symbol: $('fmSym').value.trim() }));
    if (model !== fmModel) return; // tab switched meanwhile
    const box = (h, title) => `<div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px">
        <div style="font-size:12px;color:var(--muted)">${title}</div>
        <div style="display:flex;gap:14px;margin-top:6px;font-size:14px">
          <div>Call (up) <b style="font-size:22px">${fmPct(h.probUp)}</b></div>
          <div>Put (down) <b style="font-size:22px">${fmPct(h.probDown)}</b></div>
          <div>Sideways <b style="font-size:22px">${fmPct(h.probSideways)}</b></div></div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Median move ${fmSigned(h.medianPct)} · 10–90% range ${fmSigned(h.lowPct)} to ${fmSigned(h.highPct)}</div></div>`;
    out.innerHTML = `<div style="font-size:13px;margin-bottom:8px"><span style="background:var(--accent);color:var(--on-accent);border-radius:6px;padding:2px 8px;font-weight:700">Result from ${esc(r.modelLabel)}</span>
        <span style="color:var(--muted)">${esc(r.source)}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${box(r.horizons['1d'], 'Next session')}${box(r.horizons['5d'], 'Next 5 sessions')}</div>
      <div class="kv" style="margin-top:8px">
        <div>Stock</div><div>${esc(r.symbol)} · last close ${r.lastClose.toFixed(2)} · data to ${esc(r.asOf)} · ${r.contextBars} daily candles</div>
        <div>Sideways band</div><div>±${r.sidewaysBandPct.toFixed(2)}% (0.35 × ATR, same rule as the rest of the app)</div>
        <div>Run time</div><div>${r.seconds.toFixed(1)} s</div></div>
      <div class="note">${esc(r.note)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('fmReplayBtn').addEventListener('click', async () => {
  const model = fmModel;
  $('fmReplay').textContent = `Replaying ${FM_LABEL[model]} on 200 past moments… (Chronos ~1 min, Kronos ~8 min)`;
  try {
    const r = await api('/api/foundation-replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, n: 200 }) });
    if (model === fmModel) $('fmReplay').innerHTML = fmReplayHtml(r);
  } catch (e) {
    $('fmReplay').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
lazy('Foundation models', fmShowReplay);

// --- Call / Put payoff odds ---
$('ooBtn').addEventListener('click', async () => {
  const out = $('ooOut');
  out.textContent = 'Calculating…';
  try {
    const q = new URLSearchParams({ symbol: $('ooSym').value.trim(), type: $('ooType').value, strike: $('ooStrike').value, days: $('ooDays').value });
    if ($('ooPremium').value) q.set('premium', $('ooPremium').value);
    if ($('ooIv').value) q.set('iv', $('ooIv').value);
    const o = await api('/api/option-odds?' + q.toString());
    const pct = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
    out.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:12px;color:var(--muted)">Chance of profit at expiry · forecast</div>
          <div style="font-size:30px;font-weight:700">${pct(o.probProfit.forecastHistory ?? o.probProfit.forecastNormal)}</div></div>
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:12px;color:var(--muted)">…as implied by the option's price</div>
          <div style="font-size:30px;font-weight:700;color:var(--muted)">${pct(o.probProfit.impliedNormal)}</div></div>
      </div>
      <div class="kv">
        <div>Option</div><div>${esc(o.symbol)} ${esc(o.type)} ${o.strike} · ${o.days} days · spot ${o.spot.toFixed(2)}</div>
        <div>Premium</div><div>${o.premium.toFixed(2)} (${esc(o.premiumSource)})</div>
        <div>Breakeven</div><div>${o.breakeven.toFixed(2)} — needs a ${o.breakevenMovePct >= 0 ? '+' : ''}${o.breakevenMovePct.toFixed(2)}% move</div>
        <div>Volatility</div><div>forecast ${o.forecastVolPct.toFixed(1)}% (${esc(o.volModel)})${o.impliedVolPct != null ? ` · implied ${o.impliedVolPct.toFixed(1)}%` : ''}${o.eventPending ? ' · <span style="color:var(--warn)">results due — widened</span>' : ''}</div>
        <div>Chance in the money</div><div>forecast ${pct(o.probItm.forecast)}${o.probItm.implied != null ? ` · implied ${pct(o.probItm.implied)}` : ''}</div>
        <div>Profit odds (normal model)</div><div>${pct(o.probProfit.forecastNormal)} · history-based ${pct(o.probProfit.forecastHistory)}</div>
        <div>Fair value at forecast vol</div><div>${o.fairValueForecast.toFixed(2)} vs premium ${o.premium.toFixed(2)} (${o.premiumVsFairPct != null ? (o.premiumVsFairPct >= 0 ? '+' : '') + o.premiumVsFairPct.toFixed(0) + '%' : '–'})</div>
      </div>
      <div style="margin-top:8px;font-size:14px">${esc(o.reading)}</div><div class="note">${esc(o.disclaimer)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('ooEvalBtn').addEventListener('click', async () => {
  const out = $('ooOut');
  out.textContent = 'Replaying 5 years of option-odds predictions…';
  try {
    const r = await api('/api/option-odds-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    out.innerHTML = '<table><thead><tr><th style="text-align:left">Method</th><th>Brier ↓</th><th>n</th></tr></thead><tbody>' +
      Object.entries(r.summary).map(([k, v]) => `<tr${k === r.best ? ' style="font-weight:700"' : ''}><td style="text-align:left">${esc(k)}${k === r.best ? ' ★' : ''}</td><td>${v.brier.toFixed(4)}</td><td>${v.n}</td></tr>`).join('') + '</tbody></table>' +
      `<div style="margin-top:8px;font-size:14px">Calibration (history method): ${r.reliability.map((b) => `predicted ${(b.meanPredicted * 100).toFixed(0)}% → happened ${(b.observed * 100).toFixed(0)}%`).join(' · ')}</div>
      <div class="note">${esc(r.note)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Volatility check ---
$('vcBtn').addEventListener('click', async () => {
  const out = $('vcOut');
  out.textContent = 'Loading…';
  try {
    const q = new URLSearchParams({ symbol: $('vcSym').value.trim(), days: $('vcDays').value });
    if ($('vcIv').value) q.set('iv', $('vcIv').value);
    if ($('vcExpiry').value) q.set('expiry', $('vcExpiry').value.trim());
    const d = await api('/api/vol-check?' + q.toString());
    const f = d.forecastsAnnualPct;
    out.innerHTML = `<div class="kv">
      <div>Symbol</div><div>${esc(d.symbol)} · ${esc(d.asOf)} · last ${Number(d.last).toFixed(2)}</div>
      <div>Forecast vol (annual)</div><div><b>${d.forecastPct?.toFixed(1)}%</b> (model: ${esc(d.model)}, the replay winner)${d.eventAddOnPct ? ` <span style="color:var(--warn)">incl. +${d.eventAddOnPct.toFixed(1)} pts for results due</span>` : ''} · EWMA ${f.ewma?.toFixed(1)}% · GARCH ${f.garch?.toFixed(1) ?? '–'}% · HAR ${f.har?.toFixed(1) ?? '–'}%</div>
      ${d.typicalRatio ? `<div>Usual VIX premium</div><div>×${d.typicalRatio.toFixed(2)} (India VIX vs realised, 5-year replay)</div>` : ''}
      <div>Implied vol</div><div>${d.impliedPct != null ? `<b>${d.impliedPct.toFixed(1)}%</b> (${esc(d.impliedSource)}) · ratio ${d.ratio.toFixed(2)}` : '–'}</div>
      <div>±1σ over ${d.days} days</div><div>forecast ${d.expectedMovePct.forecast?.toFixed(2)}%${d.expectedMovePct.implied != null ? ` · implied ${d.expectedMovePct.implied.toFixed(2)}%` : ''}</div>
      ${d.optionChain && !d.optionChain.error ? `<div>Option chain</div><div>ATM ${d.optionChain.atmStrike} · put/call OI ratio ${d.optionChain.pcr?.toFixed(2) ?? '–'} · ${d.optionChain.strikes} strikes</div>` : ''}
    </div>${d.optionChain?.error ? `<div class="note">Groww option chain unavailable: ${esc(d.optionChain.error)}</div>` : ''}
    <div style="margin-top:8px;font-size:14px">${esc(d.reading)}</div><div class="note">${esc(d.disclaimer)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('vcEvalBtn').addEventListener('click', async () => {
  const out = $('vcOut');
  out.textContent = 'Replaying 5 years of volatility forecasts…';
  try {
    const d = await api('/api/vol-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const tbl = (o, best) => '<table><thead><tr><th style="text-align:left">Forecaster</th><th>QLIKE ↓</th><th>n</th></tr></thead><tbody>' +
      Object.entries(o).map(([k, v]) => `<tr${k === best ? ' style="font-weight:700"' : ''}><td style="text-align:left">${esc(k)}${k === best ? ' ★' : ''}</td><td>${v.meanQlike.toFixed(4)}</td><td>${v.n}</td></tr>`).join('') + '</tbody></table>';
    const v = d.niftyImpliedVsRealised;
    out.innerHTML = `<div class="note">Next ${d.horizon} days · ${d.symbols} series · 5 years, non-overlapping</div>
      <div style="font-size:13px;margin-top:6px"><b>All series</b> (history-based forecasters)</div>${tbl(d.summary, d.best)}
      <div style="font-size:13px;margin-top:10px"><b>NIFTY only</b> — same dates, including India VIX</div>${tbl(d.niftyHeadToHead, d.niftyBest)}
      ${v ? `<div style="margin-top:8px;font-size:14px">India VIX averaged <b>${v.avgImpliedPct.toFixed(1)}%</b> vs <b>${v.avgRealisedPct.toFixed(1)}%</b> realised; implied was above realised <b>${v.pctTimeImpliedAbove.toFixed(0)}%</b> of the time (n=${v.n}).</div>` : ''}
      <div class="note">${esc(d.note)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
