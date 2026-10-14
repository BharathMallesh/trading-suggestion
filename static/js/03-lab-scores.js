// 03-lab-scores.js — Hit-rate calibration and stock ranking.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Hit-rate calibration ---
function renderHitStats(stats, note) {
  const out = $('hrOut');
  if (!stats) {
    out.innerHTML = '<div class="note">No stats yet. Run Call/Put a few times, wait for their horizon to pass, then Evaluate.</div>';
    return;
  }
  const pct = (x) => (x == null ? '–' : (x * 100).toFixed(0) + '%');
  let html = '';
  if (note) html += `<div class="note" style="margin-bottom:8px">${esc(note)}</div>`;
  html += `<div class="kv">
    <div>Logged</div><div>${stats.totalLogged}</div>
    <div>Pending</div><div>${stats.pending}</div>
    <div>Evaluated</div><div>${stats.evaluated}</div>
    <div>Hit-rate (bias)</div><div><b>${pct(stats.hitRateBias)}</b></div>
    <div>Hit-rate (top prob)</div><div>${pct(stats.hitRateTopProb)}</div>
  </div>`;
  if (stats.llmValue?.n) {
    const v = stats.llmValue;
    html += `<div class="note" style="margin-top:8px">Ling adjustment <b>${esc(v.verdict)}</b> so far: Brier ${v.brierAdjusted.toFixed(4)} adjusted vs ${v.brierBase.toFixed(4)} before Ling (n=${v.n}, lower is better).</div>`;
  } else {
    html += '<div class="note" style="margin-top:8px">Ling adjustment value: no evaluated AI-adjusted predictions yet.</div>';
  }
  const tilt = stats.newsValue?.tilt;
  if (tilt?.n) {
    html += `<div class="note">News tilt <b>${esc(tilt.verdict)}</b>: Brier ${tilt.brierWithTilt.toFixed(4)} with vs ${tilt.brierWithout.toFixed(4)} without (n=${tilt.n})${tilt.autoDisabled ? ' — <b>auto-disabled</b>' : tilt.n < 20 ? ' — auto-off check starts at 20 scored' : ''}.</div>`;
  }
  const facts = Object.entries(stats.newsValue?.facts || {});
  if (facts.length) {
    html += '<div class="note">What followed extracted news facts: ' + facts.map(([k, v]) => `${esc(k)} → UP ${v.UP}/DOWN ${v.DOWN}/SIDE ${v.SIDEWAYS} (n=${v.n})`).join(' · ') + '</div>';
  }
  if (stats.newsValue?.n) {
    html += `<div class="note">News sentiment matched the direction ${(stats.newsValue.directionHitRate * 100).toFixed(0)}% of the time on moves (n=${stats.newsValue.n}; 50% = no information).</div>`;
  }
  if (stats.byBias) {
    html += '<div style="margin-top:10px;font-size:13px"><b>By bias</b><ul style="margin:6px 0 0 18px">';
    for (const [k, v] of Object.entries(stats.byBias)) {
      html += `<li>${esc(k)}: ${v.hits}/${v.n} (${pct(v.hitRate)})</li>`;
    }
    html += '</ul></div>';
  }
  if (stats.confidenceBuckets?.length) {
    html += '<div style="margin-top:8px;font-size:13px"><b>By confidence</b><ul style="margin:6px 0 0 18px">';
    for (const b of stats.confidenceBuckets) {
      html += `<li>${esc(b.label)}: ${b.hits}/${b.n} (${pct(b.hitRate)})</li>`;
    }
    html += '</ul></div>';
  }
  if (stats.recentEvaluated?.length) {
    html += '<div style="margin-top:10px;font-size:12px;overflow-x:auto"><b>Recent evaluated</b><table style="width:100%;margin-top:6px;border-collapse:collapse">';
    html += '<tr style="color:var(--muted)"><th style="text-align:left;padding:3px">When</th><th style="text-align:left;padding:3px">Sym</th><th style="text-align:left;padding:3px">Bias</th><th style="text-align:left;padding:3px">Realized</th><th style="text-align:left;padding:3px">Ret%</th><th style="text-align:left;padding:3px">Hit</th></tr>';
    for (const e of stats.recentEvaluated.slice(0, 8)) {
      html += `<tr>
        <td style="padding:3px">${esc((e.ts || '').slice(0, 16))}</td>
        <td style="padding:3px">${esc(e.symbol)}</td>
        <td style="padding:3px">${esc(e.bias)}</td>
        <td style="padding:3px">${esc(e.realizedLabel)}</td>
        <td style="padding:3px">${e.realizedRetPct != null ? Number(e.realizedRetPct).toFixed(2) : '–'}</td>
        <td style="padding:3px">${e.hitBias ? '✓' : '✗'}</td>
      </tr>`;
    }
    html += '</table></div>';
  }
  html += '<div class="note" style="margin-top:10px">Research metric only. Past hit-rate ≠ future performance.</div>';
  out.innerHTML = html;
}

$('hrStatsBtn').addEventListener('click', async () => {
  $('hrOut').textContent = 'Loading…';
  try {
    const d = await api('/api/prediction-stats');
    renderHitStats(d.stats, d.disclaimer);
  } catch (e) {
    $('hrOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

$('hrEvalBtn').addEventListener('click', async () => {
  $('hrOut').textContent = 'Evaluating pending predictions against later prices…';
  try {
    const d = await api('/api/prediction-evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 40 }),
    });
    renderHitStats(
      d.stats,
      `Checked ${d.checked}, newly scored ${d.updated}. ${d.disclaimer || ''}`,
    );
  } catch (e) {
    $('hrOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});




// --- Stock ranking ---
const SIG_NAME = { mom12_1: '12-1 month momentum', mom6_1: '6-1 month momentum', mom3: '3-month momentum', reversal1m: '1-month reversal', lowVol: 'Low volatility', high52: 'Near 52-week high', trend: 'Trend (50/200-day)', composite: 'Composite' };
async function rkRun(kind) {
  const out = $('rkOut');
  const status = $('rkStatus');
  status.style.display = 'block';
  status.textContent = kind === 'live' ? 'Loading 5 years of prices for the universe…' : 'Replaying 5 years of rankings…';
  $('rkLiveBtn').disabled = $('rkEvalBtn').disabled = true;
  try {
    const syms = $('rkSyms').value.trim();
    if (kind === 'live') {
      const q = new URLSearchParams({ universe: $('rkUniverse').value, sortBy: $('rkSort').value });
      if (syms) q.set('symbols', syms);
      const d = await api('/api/rankings?' + q.toString());
      let html = `<div class="note">As of ${esc(d.asOf)} · ${d.universe} stocks · sorted by <b>${esc(SIG_NAME[d.sortBy] || d.sortBy)}</b>${d.skipped?.length ? ' · skipped ' + d.skipped.length : ''}</div>
        <table><thead><tr><th>#</th><th style="text-align:left">Symbol</th><th>Composite</th><th>12-1m momentum</th><th>Volatility (ann.)</th><th>% of 52w high</th></tr></thead><tbody>`;
      for (const r of d.ranking.slice(0, 50)) {
        html += `<tr><td>${r.rank}</td><td style="text-align:left">${esc(r.symbol)}</td><td>${r.composite.toFixed(2)}</td><td>${r.mom12_1Pct?.toFixed(1)}%</td><td>${r.vol60Pct?.toFixed(1)}%</td><td>${r.pctOf52wHigh?.toFixed(0)}%</td></tr>`;
      }
      out.innerHTML = html + `</tbody></table><div class="note">${esc(d.note)} Run <b>Evidence</b> to see whether this composite has worked historically.</div>`;
    } else {
      const d = await api('/api/ranking-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ horizon: Number($('rkHorizon').value), symbols: syms || undefined, universe: $('rkUniverse').value }) });
      const col = (e) => (e === 'strong' ? 'var(--up)' : e === 'weak' ? 'var(--warn)' : 'var(--muted)');
      let html = `<div class="note">${esc(d.universeName)} (${esc(d.universeSource)}) · ${d.periods} rebalances every ${d.horizon} trading days · ${esc(d.from)} → ${esc(d.to)} · ${d.universe} stocks · top ${d.topN}, ${d.costPct}% cost per replaced name</div>
        <table><thead><tr><th style="text-align:left">Signal</th><th>Mean IC</th><th>t-stat</th><th>% periods &gt; 0</th><th>IC 1st / 2nd half</th><th>Top − bottom fifth</th><th>Top-${d.topN} CAGR</th><th>Evidence</th></tr></thead><tbody>`;
      for (const [k, v] of Object.entries(d.summary)) {
        html += `<tr><td style="text-align:left">${esc(SIG_NAME[k] || k)}</td><td>${v.meanIC.toFixed(3)}</td><td>${v.tStat?.toFixed(2) ?? '–'}</td><td>${v.pctPositive.toFixed(0)}%</td>
          <td>${v.meanICFirstHalf.toFixed(3)} / ${v.meanICSecondHalf.toFixed(3)}</td><td>${v.spreadPerPeriodPct.toFixed(2)}%</td><td>${v.topNCagrPct.toFixed(1)}%</td>
          <td style="color:${col(v.evidence)};font-weight:700">${esc(v.evidence)}</td></tr>`;
      }
      html += `</tbody></table><div class="note">Benchmarks: equal-weight universe ${d.benchmark.equalWeightCagrPct.toFixed(1)}% CAGR · NIFTY 50 ${d.benchmark.niftyCagrPct?.toFixed(1) ?? '–'}% CAGR.
        IC = rank correlation between the signal and the following return (0 = none). "Strong" needs t ≥ 2 and positive IC in both halves.</div>
        <div class="note">${esc(d.caveats.join(' '))}</div>`;
      out.innerHTML = html;
    }
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    status.style.display = 'none';
    $('rkLiveBtn').disabled = $('rkEvalBtn').disabled = false;
  }
}
$('rkLiveBtn').addEventListener('click', () => rkRun('live'));
$('rkEvalBtn').addEventListener('click', () => rkRun('eval'));
