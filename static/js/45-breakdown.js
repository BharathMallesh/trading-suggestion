// 45-breakdown.js — Breakdown tab: every strategy's backtest + paper results by weekday / week of month / month /
// quarter / FY quarter / year, paper beside backtest, and the both-ways validation table.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const bdRs = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const bdR = (v) => (v == null ? '–' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)} R`);
const bdPc = (v, k = 2) => (v == null ? '–' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(k)}%`);
const bdCol = (v) => (v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--muted)');
const bdVal = (unit, v) => (unit === '₹' ? bdRs(v) : unit === 'R' ? bdR(v) : unit === 'curve' ? bdPc(v * 100) : bdPc(v));
const BD_SRC = { backtest: 'Backtest', paper: 'Paper (forward)' };
// tables keep their columns and scroll inside their own box (opt out of the phone "stack" layout in 01-core.js)
const bdTable = (head, body, rows) => `<div style="overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch"><table style="font-size:12px;white-space:nowrap" data-labelled="1" data-rows="${rows + 1}">${head}<tbody>${body}</tbody></table></div>`;
const BD_NOT_ADVICE = '<div class="note" style="margin-top:4px">Not advice.</div>';
let BD_OPTIONS = null;
let BD_SEL = null;

function bdBar(v, max) {
  if (v == null || !max) return '';
  const w = Math.max(2, Math.round((Math.abs(v) / max) * 100));
  return `<div style="width:90px;height:10px;background:var(--soft);border-radius:3px;overflow:hidden"><div style="width:${w}%;height:100%;background:${bdCol(v)}"></div></div>`;
}

function bdSeries(s) {
  const curve = s.kind === 'curve';
  const main = (b) => (curve ? b.compounded : s.unit === '₹' ? b.net : s.unit === 'R' ? b.totalR : b.avgRetPct);
  const max = Math.max(0, ...s.buckets.map((b) => Math.abs(main(b) ?? 0)));
  const head = curve
    ? '<thead><tr><th style="text-align:left">Bucket</th><th>Days</th><th>Up days</th><th>Avg daily</th><th>Compounded</th><th>Best day</th><th>Worst day</th><th>t</th><th></th><th style="text-align:left">Sample</th></tr></thead>'
    : '<thead><tr><th style="text-align:left">Bucket</th><th>Trades</th><th>Won</th><th>Win %</th><th>Net ₹</th><th>Avg ₹</th><th>Avg R</th><th>Total R</th><th>Best</th><th>Worst</th><th>t</th><th></th><th style="text-align:left">Sample</th></tr></thead>';
  const row = (b, label, bold) => {
    const grey = b.few ? 'opacity:.5' : '';
    const sample = b.few ? 'too few to judge' : '';
    const L = `<td style="text-align:left">${bold ? '<b>' : ''}${esc(label)}${bold ? '</b>' : ''}</td>`;
    if (curve) return `<tr style="${grey}">${L}<td>${b.days}</td><td>${b.won}</td><td style="color:${bdCol(b.avgRet)}">${bdPc(b.avgRet * 100, 3)}</td><td style="color:${bdCol(b.compounded)}"><b>${bdPc(b.compounded * 100)}</b></td><td>${bdPc(b.best * 100)}</td><td>${bdPc(b.worst * 100)}</td><td>${b.t?.toFixed(1) ?? '–'}</td><td>${bold ? '' : bdBar(b.compounded, max)}</td><td style="text-align:left;color:var(--muted)">${sample}</td></tr>`;
    const fmtV = (v) => (s.unit === '₹' ? bdRs(v) : s.unit === 'R' ? bdR(v) : bdPc(v));
    return `<tr style="${grey}">${L}<td>${b.trades}</td><td>${b.won}</td><td>${b.winPct == null ? '–' : `${Math.round(b.winPct)}%`}</td><td style="color:${bdCol(b.net)}"><b>${bdRs(b.net)}</b></td><td>${bdRs(b.avg)}</td><td>${bdR(b.avgR)}</td><td style="color:${bdCol(b.totalR)}">${bdR(b.totalR)}</td><td>${fmtV(b.best)}</td><td>${fmtV(b.worst)}</td><td>${b.t?.toFixed(1) ?? '–'}</td><td>${bold ? '' : bdBar(main(b), max)}</td><td style="text-align:left;color:var(--muted)">${sample}</td></tr>`;
  };
  const body = s.buckets.map((b) => row(b, b.label)).join('') + row({ ...s.total, few: (s.total.trades ?? s.total.days) < 20 }, 'All', true);
  const n = s.total.trades ?? s.total.days ?? 0;
  const unitNote = curve ? 'daily % change of the paper account (monthly for a backtest marked "monthly")' : s.unit === '₹' ? '₹ after costs' : s.unit === 'R' ? 'R = multiples of the risk taken (no ₹ in this record)' : '% return per trade';
  return `<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line)">
    <div style="font-size:14px"><b>${esc(s.label)}</b> · ${esc(s.version)} · <span style="color:${s.source === 'paper' ? 'var(--accent)' : 'var(--muted)'}">${BD_SRC[s.source]}</span>
    <span class="note" style="display:inline"> ${n} ${curve ? 'days' : 'closed trades'}${s.open ? ` · ${s.open} open (not counted)` : ''} · ${esc(s.from || '')} → ${esc(s.to || '')} · ${unitNote}</span></div>
    ${n ? bdTable(head, body, s.buckets.length + 1) : '<div class="note">No closed trades in this selection yet.</div>'}
    ${n && n < 20 ? '<div class="note" style="color:var(--warn)">Fewer than 20 in total: too few to judge anything.</div>' : ''}
    ${BD_NOT_ADVICE}</div>`;
}

function bdCompare(list) {
  if (!list.length) return '';
  const fmt = (c, v) => (c.unit === '₹' ? bdRs(v) : c.unit === 'R' ? bdR(v) : bdPc(v));
  let html = '<div style="font-size:15px;margin-top:18px"><b>Paper vs backtest</b> <span class="note" style="display:inline">same strategy, same version, same bucket · average per trade</span></div>';
  for (const c of list) {
    const head = '<thead><tr><th style="text-align:left">Bucket</th><th>Paper trades</th><th>Paper total</th><th>Paper avg</th><th>Backtest trades</th><th>Backtest avg</th><th>z</th><th style="text-align:left">Reading</th></tr></thead>';
    const row = (x, bold) => `<tr style="${x.paperTrades ? '' : 'opacity:.5'}"><td style="text-align:left">${bold ? '<b>' : ''}${esc(x.label)}${bold ? '</b>' : ''}</td><td>${x.paperTrades}</td><td style="color:${bdCol(x.paperTotal)}">${fmt(c, x.paperTotal)}</td><td style="color:${bdCol(x.paperAvg)}">${fmt(c, x.paperAvg)}</td><td>${x.backtestTrades}</td><td style="color:${bdCol(x.backtestAvg)}">${fmt(c, x.backtestAvg)}</td><td>${x.z?.toFixed(1) ?? '–'}</td><td style="text-align:left;${x.differs ? 'color:var(--warn);font-weight:600' : 'color:var(--muted)'}">${esc(x.note || (x.paperTrades ? '' : 'no paper trades'))}</td></tr>`;
    const o = c.overall;
    html += `<div style="margin-top:10px;font-size:13px"><b>${esc(BD_OPTIONS?.[c.strategy]?.label || c.strategy)} · ${esc(c.version)}</b> — paper ${o.paperTrades} trades (${esc(c.paperFrom || '')} → ${esc(c.paperTo || '')}) vs backtest ${o.backtestTrades}</div>`;
    if (o.differs) html += `<div style="margin:6px 0;padding:8px 10px;border-radius:8px;border-left:3px solid var(--warn);background:var(--soft);font-size:12.5px"><b>Live result differs from long-run test${o.paperTrades < 100 ? ' — likely luck / sample size' : ''}:</b> paper ${fmt(c, o.paperTotal)} over ${o.paperTrades} trades (${fmt(c, o.paperAvg)} a trade) vs ${fmt(c, o.backtestAvg)} a trade over ${o.backtestTrades.toLocaleString('en-IN')} backtest trades. Trust the long test over a few weeks of paper.</div>`;
    html += bdTable(head, c.buckets.map((x) => row(x)).join('') + row(o, true), c.buckets.length + 1);
  }
  return html + BD_NOT_ADVICE;
}

function bdValidation(v, all) {
  const ck = (x) => (x == null ? '<span style="color:var(--muted)">–</span>' : x ? '<span style="color:var(--up)">✓</span>' : '<b style="color:var(--down)">✗</b>');
  const fv = (x, u) => bdVal(u, x);
  const head = '<thead><tr><th style="text-align:left">Strategy · version · source</th><th>Trades / days</th><th>Card count</th><th>Total (rows)</th><th>Card total</th><th>Σ weekday</th><th>Σ week of month</th><th>Σ month</th><th>Σ quarter</th><th>Σ FY quarter</th><th>Σ year</th><th>Groups add up</th><th>Wkday = month = year</th><th>Counts</th><th>= card</th><th>Card by year</th><th style="text-align:left">Card number from</th></tr></thead>';
  const body = v.map((x) => `<tr><td style="text-align:left">${x.pass ? '✓' : '<b style="color:var(--down)">✗</b>'} ${esc(BD_OPTIONS?.[x.strategy]?.label || x.strategy)} · ${esc(x.version)} · ${esc(x.source)}</td><td>${x.trades}</td><td>${x.reportedTrades ?? '–'}</td><td>${fv(x.total, x.unit)}</td><td>${fv(x.reported, x.unit)}</td>${['weekday', 'weekOfMonth', 'month', 'quarter', 'fyQuarter', 'year'].map((g) => `<td>${fv(x.byGroup[g], x.unit)}</td>`).join('')}<td>${ck(x.ok.sums)}</td><td>${ck(x.ok.cross)}</td><td>${ck(x.ok.counts)}</td><td>${ck(x.ok.reported)}</td><td>${ck(x.ok.years)}</td><td style="text-align:left;color:var(--muted)">${esc(x.reportedBy)}</td></tr>`).join('');
  const failed = v.filter((x) => !x.pass).length;
  return `<div style="font-size:15px;margin-top:18px"><b>Validation — every number checked both ways</b></div>
    <div style="margin:6px 0;padding:8px 10px;border-radius:8px;border:1px solid ${all.failed ? 'var(--down)' : 'var(--up)'};font-size:13px">${all.failed ? `<b style="color:var(--down)">${all.failed} of ${all.series} series fail a check</b> (✗ below)` : `<b style="color:var(--up)">All ${all.series} series pass</b>`}: each grouping adds back to the ungrouped total (to the rupee; R to 6 decimals; curves multiply back), weekday = month = year totals, trade counts match, and the total equals the strategy's own card${failed ? '' : ''}. Checked on all closed trades by entry date, before the filters above.</div>
    ${bdTable(head, body, v.length)}
    <div class="note">"–" = no card total to compare with. Files that keep ₹ rounded per trade are allowed ±₹0.50 a trade against the card. Not advice.</div>`;
}

function bdRender(d) {
  BD_OPTIONS = d.options;
  // strategy checkboxes (kept as chosen)
  if (!BD_SEL) BD_SEL = new Set(String(d.filters.strategy || 'vwap').split(','));
  $('bdStrats').innerHTML = Object.entries(d.options).sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([k, o]) => {
    const srcs = [...new Set(Object.values(o.versions).flat())];
    return `<label style="display:inline-flex;align-items:center;gap:4px;margin:0;color:var(--ink);font-size:13px;min-height:28px"><input type="checkbox" value="${esc(k)}" ${BD_SEL.has(k) ? 'checked' : ''} style="width:auto;min-height:0;margin:0"> ${esc(o.label)} <span style="color:var(--muted);font-size:11px">${srcs.map((s) => (s === 'paper' ? 'P' : 'B')).join('')}</span></label>`;
  }).join('') + '<span class="note" style="display:block;width:100%;margin:2px 0 0">B = backtest trades, P = paper trades.</span>';
  const versions = new Set();
  for (const k of BD_SEL) for (const v of Object.keys(d.options[k]?.versions || {})) versions.add(v);
  const cur = $('bdVersion').value;
  $('bdVersion').innerHTML = '<option value="">All versions</option>' + [...versions].sort().map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const sides = new Set(['long', 'short']);
  for (const k of BD_SEL) for (const s of d.options[k]?.sides || []) sides.add(s);
  const cs = $('bdSide').value;
  $('bdSide').innerHTML = '<option value="">Both sides</option>' + [...sides].map((s) => `<option value="${esc(s)}" ${s === cs ? 'selected' : ''}>${esc(s === 'long' ? 'Buy (long)' : s === 'short' ? 'Short' : s)}</option>`).join('');

  let html = '';
  if (!d.builtAt) html += '<div style="padding:8px 10px;border-radius:8px;border-left:3px solid var(--warn);background:var(--soft);font-size:12.5px">Most backtest trades are not built yet: run <code>node --max-old-space-size=12000 paper-bot/breakdown.mjs --build</code> once (2–5 minutes). Until then only the backtests that save their own trades are shown.</div>';
  else html += `<div class="note" style="margin-top:0">Backtest trades re-run ${esc(d.builtAt.slice(0, 10))} with each strategy's own code; checked against each card below.</div>`;
  if (d.combined && d.series.length > 1) html += bdSeries({ label: 'All selected (₹ trades only)', version: 'combined', source: d.filters.source, kind: 'trades', unit: '₹', total: d.combined.total, buckets: d.combined.buckets, open: 0, from: d.filters.from, to: d.filters.to });
  html += d.series.length ? d.series.map(bdSeries).join('') : '<div class="note">Nothing matches these filters.</div>';
  html += bdCompare(d.compare);
  html += bdValidation(d.validation, d.validationAll);
  if (d.skipped.length || d.warnings.length) html += `<details style="margin-top:10px;font-size:12.5px"><summary>Included / skipped sources (${d.skipped.length} skipped, ${d.warnings.length} warnings)</summary><ul style="margin:6px 0;padding-left:18px">${d.skipped.map((s) => `<li><b>${esc(s.file)}</b> ${esc(s.strategy)} ${esc(s.version)} (${esc(s.source)}): ${esc(s.why)}</li>`).join('')}${d.warnings.map((w) => `<li style="color:var(--warn)">${esc(w)}</li>`).join('')}</ul></details>`;
  html += `<div class="note">${esc(d.note)}</div>`;
  $('bdOut').innerHTML = html;
}

async function bdLoad() {
  const q = new URLSearchParams();
  const strat = BD_SEL ? [...BD_SEL].join(',') : 'vwap';
  q.set('strategy', strat);
  q.set('groupBy', $('bdGroup').value);
  q.set('source', $('bdSource').value);
  q.set('dateField', $('bdDate').value);
  for (const [k, id] of [['version', 'bdVersion'], ['side', 'bdSide'], ['from', 'bdFrom'], ['to', 'bdTo']]) if ($(id).value) q.set(k, $(id).value);
  $('bdRun').disabled = true;
  try {
    bdRender(await api(`/api/breakdown?${q}`));
  } catch (e) {
    $('bdOut').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('bdRun').disabled = false;
  }
}
$('bdStrats').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  BD_SEL = new Set([...$('bdStrats').querySelectorAll('input:checked')].map((x) => x.value));
  if (!BD_SEL.size) BD_SEL.add(e.target.value), (e.target.checked = true); // at least one
  $('bdVersion').value = '';
  bdLoad();
});
for (const id of ['bdGroup', 'bdSource', 'bdVersion', 'bdSide', 'bdDate']) $(id).addEventListener('change', bdLoad);
$('bdRun').addEventListener('click', bdLoad);
lazy('Breakdown', bdLoad);
