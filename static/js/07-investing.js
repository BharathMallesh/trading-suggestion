// 07-investing.js — Goal planner, index-fund picker, what to expect, my portfolio, market tilts, trend filter, direction research.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Goal planner ---
$('glBtn').addEventListener('click', async () => {
  const out = $('glOut');
  out.textContent = 'Checking every past start month…';
  try {
    const q = new URLSearchParams({ target: $('glTarget').value, years: $('glYears').value, lump: $('glLump').value || 0, index: $('glIdx').value });
    if ($('glSip').value) q.set('sip', $('glSip').value);
    const g = await api('/api/goal?' + q);
    const rs = (v) => '₹' + Math.round(v).toLocaleString('en-IN');
    const lk = (v) => '₹' + (v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : (v / 1e5).toFixed(1) + ' L');
    let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">${[['Worked half the time', g.sipNeeded.p50], ['Worked 3 times in 4', g.sipNeeded.p75], ['Worked 9 times in 10', g.sipNeeded.p90], ['Worked every time (worst start)', g.sipNeeded.p100]].map(([t, v], i) =>
      `<div style="background:var(--soft);border:1px solid ${i === 2 ? 'var(--accent)' : 'var(--line)'};border-radius:10px;padding:10px;text-align:center"><div style="font-size:12px;color:var(--muted)">${t}</div><div style="font-size:20px;font-weight:700">${rs(v)}<span style="font-size:12px;color:var(--muted)">/mo</span></div></div>`).join('')}</div>
      <div style="font-size:13px;margin-top:8px">To reach <b>${lk(g.target)}</b> in <b>${g.years} years</b>${g.lumpSum ? ` (with ${lk(g.lumpSum)} invested now)` : ''}: a SIP of about <b>${rs(g.sipNeeded.p90)}/month</b> would have been enough in 90% of the ${g.windows} past start months (you'd invest ${lk(g.invested90)} in total).</div>`;
    if (g.withSip) {
      const w = g.withSip;
      html += `<div style="font-size:13px;margin-top:6px">With your <b>${rs(w.sip)}/month</b> (${lk(w.invested)} invested): reached the target in <b>${Math.round(w.successRate * 100)}%</b> of past windows · ending value worst ${lk(w.worst)}, typical ${lk(w.median)}, best ${lk(w.best)}.</div>`;
    }
    out.innerHTML = html + `<div class="note">${esc(g.index === 'nifty' ? 'NIFTY 50' : 'Sensex')} ${esc(g.from)} → ${esc(g.to)}. ${esc(g.note)} Not investment advice.</div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Index-fund picker ---
let ifData = null;
function ifRender() {
  if (!ifData) return;
  const c = ifData.categories[$('ifCat').value];
  if (!c) return;
  const p = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%');
  const rows = c.funds.map((f, i) => `<tr><td>${i + 1}</td><td style="text-align:left">${esc(f.name)}</td><td>${esc(f.type)}</td><td>${p(f.r1)}</td><td>${p(f.r3)}</td><td>${p(f.r5)}</td>
    <td style="color:${(f.gap3 ?? 0) < -0.003 ? 'var(--down)' : 'var(--muted)'}">${f.gap3 == null ? '–' : p(f.gap3)}</td><td>${f.te == null ? '–' : (f.te * 100).toFixed(2) + '%'}</td><td style="font-size:11px;color:var(--muted)">${esc(f.since)}</td></tr>`).join('');
  const worst = Math.min(...c.funds.map((f) => f.gap3).filter((v) => v != null));
  $('ifOut').innerHTML = `<div style="font-size:13px">${c.funds.length} ${esc(c.label)} funds. Over 3 years the worst one lagged the best by <b>${(Math.abs(worst) * 100).toFixed(2)}% a year</b> — on ₹10 lakh over 20 years that gap compounds to roughly ₹${Math.round(1e6 * ((1.12) ** 20 - (1.12 + worst) ** 20) / 1e5).toLocaleString('en-IN')} lakh.</div>
    <div style="max-height:420px;overflow:auto"><table><thead><tr><th>#</th><th style="text-align:left">Fund</th><th>Type</th><th>1y</th><th>3y/yr</th><th>5y/yr</th><th>Gap to best (3y)</th><th>Tracking error</th><th>Since</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="note">${esc(ifData.note)}</div>`;
}
$('ifCat').addEventListener('change', ifRender);
lazy('Index-fund picker', async () => {
  $('ifOut').textContent = 'Loading AMFI NAV history (first load ~10–20 s)…';
  try {
    ifData = await api('/api/index-funds');
    ifRender();
  } catch (e) {
    $('ifOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- What to expect ---
let exData = null;
function fvSip(monthly, months, irr) {
  // value of `months` monthly payments growing at annual rate irr until the end
  let v = 0;
  for (let k = 0; k < months; k++) v += monthly * (1 + irr) ** ((months - k) / 12);
  return v;
}
function exRender() {
  if (!exData) return;
  const x = exData.indices[Number($('exIdx').value) || 0];
  const sipAmt = Math.max(0, Number($('exSip').value) || 0);
  const p1 = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const lakh = (v) => '₹' + (v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : (v / 1e5).toFixed(1) + ' L');
  let html = `<div class="note">${esc(x.index)} · ${esc(x.from)} → ${esc(x.to)}</div>
    <table><thead><tr><th>Held for</th><th>Lump sum: worst / typical / best (per year)</th><th>Lost money</th><th>Below FD (6.5%)</th><th>Fall you'd sit through (typical / worst)</th>
    <th>SIP ${sipAmt ? `₹${sipAmt.toLocaleString('en-IN')}/mo` : ''}: worst / typical / best ending value</th></tr></thead><tbody>`;
  for (const h of x.horizons) {
    const l = h.lumpSum;
    const s = h.sip;
    const n = h.years * 12;
    const inv = sipAmt * n;
    const sipCell = sipAmt
      ? `${lakh(fvSip(sipAmt, n, s.worstPct / 100))} / <b>${lakh(fvSip(sipAmt, n, s.medianPct / 100))}</b> / ${lakh(fvSip(sipAmt, n, s.bestPct / 100))} <span style="color:var(--muted)">(invested ${lakh(inv)})</span>`
      : `${p1(s.worstPct)} / <b>${p1(s.medianPct)}</b> / ${p1(s.bestPct)}`;
    html += `<tr><td>${h.years} years <span style="color:var(--muted);font-size:11px">(${h.windows} starts)</span></td>
      <td>${p1(l.worstPct)} / <b>${p1(l.medianPct)}</b> / ${p1(l.bestPct)}</td>
      <td style="color:${l.pctWindowsLosing > 0 ? 'var(--down)' : 'var(--up)'}">${l.pctWindowsLosing.toFixed(0)}%</td><td>${l.pctWindowsBelowFd.toFixed(0)}%</td>
      <td>${l.medianDeepestFallPct.toFixed(0)}% / ${l.worstDeepestFallPct.toFixed(0)}%</td><td>${sipCell}</td></tr>`;
  }
  html += '</tbody></table>';
  const ten = x.horizons.find((h) => h.years === 10);
  if (ten) html += `<div style="font-size:13px;margin-top:6px">In this history, every 10-year hold made money (worst ${p1(ten.lumpSum.worstPct)} a year), but along the way the typical investor sat through a fall of about ${ten.lumpSum.medianDeepestFallPct.toFixed(0)}%. Short holds (3 years) lost money ${x.horizons[0].lumpSum.pctWindowsLosing.toFixed(0)}% of the time.</div>`;
  $('exOut').innerHTML = html + `<div class="note">${esc(exData.note)} Not investment advice.</div>`;
}
lazy('What to expect', async () => {
  $('exOut').textContent = 'Loading 25+ years of index history…';
  try {
    exData = await api('/api/expectations');
    exRender();
  } catch (e) {
    $('exOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});
$('exSip').addEventListener('input', exRender);
$('exIdx').addEventListener('change', exRender);

// --- My portfolio (tax & risk) ---
const rupee = (x) => (x == null || !Number.isFinite(x) ? '–' : (x < 0 ? '−₹' : '₹') + Math.abs(Math.round(x)).toLocaleString('en-IN'));
const pct1 = (x) => (x == null || !Number.isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%');
function hdRender(a) {
  if (a.empty) return `<div class="note">${esc(a.note)}</div>`;
  const t = a.tax;
  const box = (title, val, sub = '') => `<div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center">
    <div style="font-size:12px;color:var(--muted)">${title}</div><div style="font-size:22px;font-weight:700">${val}</div><div style="font-size:12px;color:var(--muted)">${sub}</div></div>`;
  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px">
    ${box('Value', rupee(a.totals.value), `cost ${rupee(a.totals.cost)} · ${pct1(a.totals.gainPct)}`)}
    ${box('Tax if sold today', rupee(t.taxIfSoldAllToday), `FY ${esc(a.fy)}, on top of gains already booked`)}
    ${box('LTCG exemption unused', rupee(a.harvest.remaining), `of ${rupee(a.harvest.exemption)} this year`)}
    ${a.risk ? box('Typical week', '±' + rupee(a.risk.typicalWeek.rupees), `±${a.risk.typicalWeek.pct.toFixed(1)}% · day ±${rupee(a.risk.typicalDay.rupees)}`) : ''}
  </div>`;
  if (a.flags.length) html += `<div style="margin-top:8px;color:var(--warn);font-size:13px">⚠ ${a.flags.map(esc).join(' · ')}</div>`;
  html += `<table style="margin-top:8px"><thead><tr><th style="text-align:left">Stock</th><th>Qty</th><th>Bought</th><th>Last</th><th>Value</th><th>Gain</th><th>Term</th><th></th></tr></thead><tbody>${a.lots.map((l) =>
    `<tr><td style="text-align:left">${esc(l.symbol)}${l.error ? ` <span class="err" title="${esc(l.error)}">!</span>` : ''}</td><td>${l.qty}</td><td>${rupee(l.price)} · ${esc(l.date)}</td><td>${l.last == null ? '–' : l.last.toFixed(2)}</td>
     <td>${rupee(l.value)}</td><td style="color:${(l.gain || 0) >= 0 ? 'var(--up)' : 'var(--down)'}">${rupee(l.gain)} (${pct1(l.gainPct)})</td>
     <td>${l.term === 'long' ? 'long-term' : `short-term → long from ${esc(l.longTermFrom)}`}</td>
     <td><button type="button" data-lot="${esc(l.id)}" style="margin:0;padding:2px 8px;background:var(--soft);color:var(--muted);border:1px solid var(--line)">remove</button></td></tr>`).join('')}</tbody></table>`;
  html += `<div class="kv" style="margin-top:8px">
    <div>Unrealised short-term</div><div>gains ${rupee(t.unrealisedShortGain)} · losses ${rupee(t.unrealisedShortLoss)} (taxed at 20% + cess)</div>
    <div>Unrealised long-term</div><div>gains ${rupee(t.unrealisedLongGain)} · losses ${rupee(t.unrealisedLongLoss)} (12.5% + cess above ₹1.25 lakh/yr)</div></div>`;
  if (t.soonLongTerm.length) html += `<div style="margin-top:6px;font-size:13px">⏳ Turning long-term within 60 days: ${t.soonLongTerm.map((x) => `${esc(x.symbol)} ×${x.qty} on ${esc(x.longTermFrom)} (waiting would save ~${rupee(x.taxSavedByWaiting)} if sold)`).join(' · ')}</div>`;
  const h = a.harvest;
  html += `<div style="margin-top:10px;font-size:14px"><b>Use the LTCG exemption</b> — ${rupee(h.usedThisYear)} used of ${rupee(h.exemption)} this year.</div>`;
  html += h.sells.length
    ? `<div style="font-size:13px">Selling and rebuying ${h.sells.map((x) => `${esc(x.symbol)} ×${x.qty}`).join(', ')} would book ${rupee(h.harvested)} of long-term gains tax-free and raise your cost basis — about ${rupee(h.taxSaved)} less tax later, minus ~${rupee(h.charges)} charges = <b>${rupee(h.netBenefit)}</b>. Oldest shares are sold first (FIFO).</div>`
    : '<div class="note">No long-term gains available to harvest (or the exemption is already used).</div>';
  const l = a.lossHarvest;
  html += `<div style="margin-top:8px;font-size:14px"><b>Offset gains with losses</b></div>`;
  html += l.lots.length
    ? `<div style="font-size:13px">Selling the loss-making holdings (${l.lots.map((x) => `${esc(x.symbol)} ${x.term}-term ${rupee(-x.loss)}`).join(', ')}) would cut this year's tax on gains already booked by <b>${rupee(l.taxSavedThisYear)}</b> (charges ~${rupee(l.charges)}). ${esc(l.note)}</div>`
    : '<div class="note">No holdings entirely at a loss.</div>';
  if (a.risk) {
    html += `<div style="margin-top:10px;font-size:14px"><b>Risk at today's weights</b> · ~${a.risk.annualVolPct.toFixed(0)}% a year</div>
      <div style="font-size:13px">Chance of losing more than ${a.risk.weeklyLossOdds.map((o) => `${o.lossPct}% (${rupee(o.rupees)}) in a week: <b>${(o.prob * 100).toFixed(o.prob < 0.1 ? 1 : 0)}%</b>`).join(' · ')}</div>`;
  }
  if (a.scenarios.length) {
    html += `<table style="margin-top:6px"><thead><tr><th style="text-align:left">If this happened again</th><th>NIFTY</th><th>Your portfolio</th><th>In ₹</th></tr></thead><tbody>${a.scenarios.map((sc) =>
      `<tr><td style="text-align:left">${esc(sc.name)}${sc.proxiedPct > 0 ? ` <span style="color:var(--muted);font-size:11px">(${sc.proxiedPct.toFixed(0)}% estimated via beta)</span>` : ''}</td><td>${pct1(sc.niftyPct)}</td><td>${pct1(sc.portfolioPct)}</td><td style="color:var(--down)">${rupee(sc.rupees)}</td></tr>`).join('')}</tbody></table>`;
  }
  html += `<div style="margin-top:8px;font-size:13px"><b>Spread by industry:</b> ${a.sectors.map((x) => `${esc(x.industry)} ${x.weightPct.toFixed(0)}%`).join(' · ')}</div>`;
  return html + `<div class="note" style="margin-top:8px">${esc(a.note)}</div>`;
}
async function hdLoad() {
  $('hdOut').textContent = 'Analysing… (first load fetches price history, ~10 s)';
  try {
    const a = await api('/api/holdings');
    $('hdOut').innerHTML = hdRender(a);
    if (a.realized) {
      $('hdStcg').value = a.realized.stcg || 0;
      $('hdLtcg').value = a.realized.ltcg || 0;
    }
  } catch (e) {
    $('hdOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
const hdPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
$('hdAddBtn').addEventListener('click', async () => {
  try {
    await hdPost('/api/holdings/add', { symbol: $('hdSym').value, qty: Number($('hdQty').value), price: Number($('hdPrice').value), date: $('hdDate').value });
    $('hdSym').value = $('hdQty').value = $('hdPrice').value = '';
    hdLoad();
  } catch (e) {
    $('hdOut').insertAdjacentHTML('afterbegin', `<div class="err">Error: ${esc(e.message)}</div>`);
  }
});
$('hdRealBtn').addEventListener('click', async () => {
  try {
    await hdPost('/api/holdings/realized', { stcg: Number($('hdStcg').value) || 0, ltcg: Number($('hdLtcg').value) || 0 });
    hdLoad();
  } catch (e) {
    $('hdOut').insertAdjacentHTML('afterbegin', `<div class="err">Error: ${esc(e.message)}</div>`);
  }
});
$('hdRefreshBtn').addEventListener('click', hdLoad);
async function viLoad() {
  $('viOut').textContent = 'Comparing with NIFTY…';
  try {
    const r = await api('/api/holdings/vs-index');
    if (r.empty) return ($('viOut').innerHTML = `<div class="note">${esc(r.note)}</div>`);
    const rs = (v) => (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN');
    const pc = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
    $('viOut').innerHTML = `<div style="font-size:15px;color:${r.beat ? 'var(--up)' : 'var(--down)'}"><b>${esc(r.verdict)}</b></div>
      <table style="font-size:13px"><tbody>
        <tr><td>Period</td><td>${esc(r.from)} → ${esc(r.to)} · ${r.trades} trades</td></tr>
        <tr><td>Your result</td><td>${rs(r.yourPnl)} profit/loss · ${pc(r.yourXirr)} a year (money-weighted)</td></tr>
        <tr><td>Same money in NIFTY</td><td>${r.niftyXirr != null ? pc(r.niftyXirr) + ' a year' : '–'} · mirror worth ${rs(r.niftyMirrorValue)} vs your open positions ${rs(r.openValue)}</td></tr>
        <tr><td>Charges you paid (est.)</td><td>${rs(r.charges)}</td></tr>
        <tr><td>Score vs NIFTY (PME)</td><td>${r.pme.toFixed(2)} (above 1.00 = beat NIFTY)</td></tr>
      </tbody></table>
      ${r.perStock?.length ? `<details><summary style="cursor:pointer;font-size:13px">By stock (best and worst)</summary><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Bought</th><th>Sold</th><th>Still held</th><th>P&amp;L</th></tr></thead><tbody>${r.perStock.map((s) =>
        `<tr><td style="text-align:left">${esc(s.symbol.replace(/\.(NS|BO)$/, ''))}</td><td>${rs(s.bought)}</td><td>${rs(s.sold)}</td><td>${s.openValue ? rs(s.openValue) : '–'}</td><td style="color:${s.pnl >= 0 ? 'var(--up)' : 'var(--down)'}">${rs(s.pnl)}</td></tr>`).join('')}</tbody></table></details>` : ''}
      ${r.skippedSells ? `<div class="note" style="color:var(--warn)">${r.skippedSells} sold shares had no matching buy in the file (bought earlier) and were left out — export the full history for an exact answer.</div>` : ''}
      ${r.unpriced?.length ? `<div class="note" style="color:var(--warn)">No current price for: ${r.unpriced.map(esc).join(', ')} (not counted).</div>` : ''}
      <div class="note">${esc(r.note)}</div>`;
  } catch (e) {
    $('viOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('viBtn').addEventListener('click', viLoad);
lazy('My portfolio', viLoad);

// --- Market tilts (factor lab) ---
lazy('Market tilts', async () => {
  try {
    const r = await api('/api/factor-lab');
    if (!r.rows?.length) return ($('flOut').innerHTML = `<div class="note">${esc(r.note)}</div>`);
    const pc = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
    const col = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--ink)');
    const rows = r.rows.filter((x) => x.enough).sort((a, b) => b.excess - a.excess);
    $('flOut').innerHTML = `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Index</th><th>Since</th><th>Per year</th><th>NIFTY same period</th><th>Extra per year</th><th>₹1 lakh became</th><th>Worst fall (NIFTY)</th><th>Beat NIFTY in 5-yr windows</th><th>Longest behind NIFTY</th><th style="text-align:left">Verdict</th></tr></thead><tbody>${rows.map((x) =>
      `<tr><td style="text-align:left">${esc(x.label)}${x.fundsExist ? '' : ' <span class="note" style="display:inline">(few funds)</span>'}</td><td>${esc(x.from)}</td><td>${pc(x.cagr)}</td><td>${pc(x.niftyCagr)}</td><td style="color:${col(x.excess)}"><b>${x.excess >= 0 ? '+' : ''}${pc(x.excess)}</b></td><td>₹${Math.round(x.growthOf1L).toLocaleString('en-IN')} <span class="note" style="display:inline">(NIFTY ₹${Math.round(x.niftyGrowthOf1L).toLocaleString('en-IN')})</span></td><td>${pc(x.maxDrawdown, 0)} (${pc(x.niftyMaxDrawdown, 0)})</td><td>${x.roll5 ? pc(x.roll5.pctBeat, 0) : x.roll3 ? pc(x.roll3.pctBeat, 0) + ' (3-yr)' : '–'}</td><td>${(x.longestBehindMonths / 12).toFixed(1)} yrs</td><td style="text-align:left">${esc(x.verdict)}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">What it means: tilts have beaten NIFTY over long periods, but each spent years behind it, and the high-return ones (Alpha, Momentum, Midcap) fell harder in crashes. A tilt only pays if you can hold it through those years. Funds cost more than a NIFTY fund (≈0.3–1% a year) and some of these hold less-liquid stocks, so a real fund trails its index.</div>
      <div class="note">${esc(r.note)} Data ${esc(r.from)} → ${esc(r.to)}.</div>`;
  } catch (e) {
    $('flOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

$('hdImportBtn').addEventListener('click', async () => {
  const f = $('hdFile').files?.[0];
  if (!f) return ($('hdImportOut').textContent = 'Choose a CSV file first.');
  if (f.size > 900000) return ($('hdImportOut').textContent = 'File too large (max ~900 KB) — export a shorter period or equity only.');
  if ($('hdMode').value === 'replace' && !confirm('Replace all purchases in My portfolio with this file?')) return;
  $('hdImportOut').textContent = 'Importing…';
  try {
    const r = await hdPost('/api/holdings/import', { csv: await f.text(), mode: $('hdMode').value });
    $('hdImportOut').innerHTML = `Imported ${r.trades} trades (${r.buys} buys, ${r.sells} sells) → ${r.lots} lots in ${r.holdings} stocks. Booked this year: short-term ₹${Math.round(r.realized.stcg).toLocaleString('en-IN')}, long-term ₹${Math.round(r.realized.ltcg).toLocaleString('en-IN')}.` +
      (r.warnings.length ? `<br><span style="color:var(--warn)">${r.warnings.map(esc).join('<br>')}</span>` : '') +
      (r.skipped.length ? `<br>Skipped: ${r.skipped.map(esc).join(', ')}` : '') + `<br>${esc(r.note)}`;
    hdLoad();
    viLoad();
  } catch (e) {
    $('hdImportOut').innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
  }
});
$('hdOut').addEventListener('click', async (e) => {
  const id = e.target?.dataset?.lot;
  if (!id || !confirm('Remove this purchase from My portfolio?')) return;
  try {
    await hdPost('/api/holdings/remove', { id });
    hdLoad();
  } catch (err) {
    $('hdOut').insertAdjacentHTML('afterbegin', `<div class="err">Error: ${esc(err.message)}</div>`);
  }
});
lazy('My portfolio', hdLoad);

// --- Trend filter: 25-year crisis test ---
function renderTrendHistory(r) {
  if (!r || !r.indices) return '<div class="note">Not run yet.</div>';
  let html = `<div style="font-size:14px;margin-bottom:6px"><b>${esc(r.verdict)}</b></div>`;
  for (const x of r.indices) {
    const a = x.all;
    html += `<div style="font-size:13px;margin-top:8px"><b>${esc(x.index)}</b> · ${esc(x.from)} → ${esc(x.to)} · buy-and-hold ${a.buyHold.cagrPct.toFixed(1)}%/yr (max drop ${a.buyHold.maxDrawdownPct.toFixed(0)}%) vs trend month-end ${a.monthEnd.cagrPct.toFixed(1)}%/yr (max drop ${a.monthEnd.maxDrawdownPct.toFixed(0)}%), before tax</div>
      <table><thead><tr><th style="text-align:left">Crisis</th><th>Buy-and-hold drop</th><th>Trend (month-end) drop</th><th>Trend (daily) drop</th><th>Cut</th></tr></thead><tbody>${x.crises.map((c) =>
        `<tr><td style="text-align:left">${esc(c.name)}</td><td>${c.buyHold.maxDrawdownPct.toFixed(1)}%</td><td>${c.monthEnd.maxDrawdownPct.toFixed(1)}%</td><td>${c.daily ? c.daily.maxDrawdownPct.toFixed(1) + '%' : '–'}</td><td style="color:${c.cutPts >= 5 ? 'var(--up)' : 'var(--muted)'}">${c.cutPts >= 0 ? '−' : '+'}${Math.abs(c.cutPts).toFixed(1)} pts</td></tr>`).join('')}</tbody></table>
      ${x.partialCrisesSkipped?.length ? `<div class="note">Skipped (history starts mid-crisis): ${x.partialCrisesSkipped.map(esc).join(', ')}</div>` : ''}`;
  }
  return html + `<div class="note">${esc(r.rule)}</div>`;
}
$('stHistBtn').addEventListener('click', async () => {
  const out = $('stsOut');
  out.textContent = 'Loading the saved 25-year test…';
  try {
    let r = await api('/api/trend-history');
    if (!r.indices) {
      out.textContent = 'Running on Sensex (1997→) and NIFTY (2007→)… ~20 s';
      r = await api('/api/trend-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    out.innerHTML = renderTrendHistory(r);
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Longer-horizon direction research ---
lazy('Direction over months', async () => {
  try {
    const r = await api('/api/direction-long');
    if (!r.valuation) return ($('dlOut').innerHTML = `<div class="note">${esc(r.note || 'Not run yet.')}</div>`);
    const v = r.valuation;
    const pc = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
    const NAMES = { earningsYield: 'Earnings yield (1/P/E)*', bookYield: 'Book yield (1/P/B)*', dividendYield: 'Dividend yield' };
    let html = `<div style="font-size:14px;margin-bottom:6px"><b>${esc(r.verdict)}</b></div>
      <div class="note">NIFTY 50 valuation ${esc(v.from)} → ${esc(v.to)} · today P/E ${v.latest?.pe}, P/B ${v.latest?.pb}, dividend yield ${v.latest?.dy}%</div>`;
    for (const [h, x] of Object.entries(v.horizons)) {
      html += `<div style="font-size:13px;margin-top:6px"><b>Valuation → next ${esc(h)}</b> · ~${x.independentPeriods} independent periods</div>
        <table><thead><tr><th style="text-align:left">Predictor</th><th>NW t</th><th>In-sample R²</th><th>Out-of-sample R²</th><th>Without 2020 crash (t / R²os)</th><th style="text-align:left">Verdict</th></tr></thead><tbody>${Object.entries(x.predictors).map(([k, p]) =>
          `<tr><td style="text-align:left">${esc(NAMES[k] || k)}</td><td>${p.t?.toFixed(2)}</td><td>${pc(p.r2)}</td><td>${pc(p.r2os)}</td><td>${p.withoutCovidCrash.t?.toFixed(2)} / ${pc(p.withoutCovidCrash.r2os)}</td><td style="text-align:left">${esc(p.verdict)}</td></tr>`).join('')}</tbody></table>`;
    }
    html += `<div style="font-size:13px;margin-top:6px"><b>Trend → next months</b> (Sensex ${esc(r.trend.from)} → ${esc(r.trend.to)})</div>
      <table><thead><tr><th style="text-align:left">Signal</th><th>Avg after up-trend</th><th>Avg after down-trend</th><th>NW t</th><th>Out-of-sample R²</th><th style="text-align:left">Verdict</th></tr></thead><tbody>${Object.entries(r.trend.signals).map(([k, sg]) =>
        `<tr><td style="text-align:left">${esc(k.replace('past', 'past ').replace('_next', ' → next '))}</td><td>${sg.avgAfterUpTrendPct.toFixed(2)}%</td><td>${sg.avgAfterDownTrendPct.toFixed(2)}%</td><td>${sg.t?.toFixed(2)}</td><td>${pc(sg.r2os)}</td><td style="text-align:left">${esc(sg.verdict)}</td></tr>`).join('')}</tbody></table>`;
    $('dlOut').innerHTML = html + `<div class="note">* NSE switched index P/E and P/B from standalone to consolidated earnings in 2021, so those series have a level break. ${esc(r.rule)}</div>`;
  } catch (e) {
    $('dlOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
});

// --- Next 30–40 minutes test ---
lazy('Direction over months', async () => {
  try {
    const r = await api('/api/intraday-test');
    if (!r.model35m) return;
    const p = (x) => (x == null ? '–' : (x * 100).toFixed(1) + '%');
    const a = r.currentApp.secondHalf;
    const m = r.model35m.outOfSample;
    const im = r.intradayMomentum;
    $('itOut').innerHTML = `<div style="font-size:14px"><b>Next ${r.horizonMinutes} minutes</b> · ${r.sessions} sessions (${esc(r.from)} → ${esc(r.to)}, all Yahoo keeps)</div>
      <div class="kv" style="margin-top:4px">
        <div>Base rates</div><div>up ${p(r.baseRates.UP)} · down ${p(r.baseRates.DOWN)} · sideways ${p(r.baseRates.SIDEWAYS)}</div>
        <div>App's intraday odds</div><div>Brier ${a.brierApp.toFixed(3)} vs base rates ${a.brierBase.toFixed(3)} (t ${a.t?.toFixed(1)}) — <b>${a.t > 2 ? 'worse than base rates' : 'no better than base rates'}</b> at this horizon</div>
        <div>Model built for ${r.horizonMinutes} min</div><div>confident calls right ${p(m.callHitRate)}, ${m.avgNetPerCallPct?.toFixed(3)}% per trade after costs → <b>${r.model35m.adopt ? 'adopted' : 'not usable'}</b></div>
        <div>First 30 min → last 30 min</div><div>same direction ${p(im.stocks?.sameDirectionRate)} of stock-days (NIFTY ${p(im.nifty?.sameDirectionRate)}) — no momentum</div>
      </div>
      <div class="note">${esc(r.rule)}</div>`;
  } catch {
    /* optional */
  }
});
