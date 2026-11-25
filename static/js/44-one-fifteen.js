// 44-one-fifteen.js — Trading strategies → 1:15 PM reversal: the video's rules, the 5-year test with controls, the paper record.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
const r1F = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const r1R = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`);
const r1Rs = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const r1Pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const r1Col = (x) => (x > 0 ? 'var(--up)' : x < 0 ? 'var(--down)' : 'var(--muted)');
const R1_PS = [['build', '2020–22 build'], ['check', '2023–24 check'], ['test', '2025→ test']];

function r1Cell(x) {
  if (!x?.trades) return '<td class="note">no trades</td>';
  return `<td>${x.trades} · ${r1Pc(x.winRate)} won<br><b style="color:${r1Col(x.avgRNet)};white-space:nowrap">${r1R(x.avgRNet)}</b> <span class="note" style="display:inline">(before costs ${r1R(x.avgRGross)}) · t ${r1F(x.tDay, 1)}</span></td>`;
}
function r1Table(rows) {
  return `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th>${R1_PS.map(([, l]) => `<th>${l}</th>`).join('')}<th>All: ₹ total · without the best 10 trades</th></tr></thead><tbody>${rows.map(([label, rep]) =>
    `<tr><td style="text-align:left">${label}</td>${R1_PS.map(([k]) => r1Cell(rep?.[k])).join('')}<td>${rep?.all?.trades ? `<span style="color:${r1Col(rep.all.totalNetRs)};white-space:nowrap">${r1Rs(rep.all.totalNetRs)}</span> · <span style="white-space:nowrap">${r1Rs(rep.all.exBest10Rs)}</span>` : '–'}</td></tr>`).join('')}</tbody></table></div>`;
}

function r1Render(d) {
  const b = d.backtest;
  const p = d.paper;
  let html = '';
  if (b) {
    const R = b.results;
    const pass = b.verdicts?.V?.pass || b.verdicts?.S?.pass;
    html += `<div style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid ${pass ? 'var(--up)' : 'var(--down)'};font-size:13px"><b>${esc(b.verdict)}</b>
      <div class="note" style="margin:4px 0 0">In plain words: before costs the reversal trade is about break-even (a coin flip with a 1:1 target), and charges plus slippage take about 0.2 R a trade, because the stop is tight (often under 1% of the price).
      The video's "level stays valid next day" part is the worst: next morning the level is usually hit in the first, very wide 5-minute candle together with the stop. Trading the break the other way (with the move) did a bit better than the reversal — big moves tend to continue — but also lost after costs.
      ${b.stocks} stocks (${b.fnoStocks} F&amp;O) and NIFTY, ${esc(b.from)} → ${esc(b.to)}, ₹1,000 risk a trade, at most 2 new trades a day.</div></div>`;
    html += `<div style="font-size:14px;margin-top:6px"><b>The rules tested</b> (fixed before the test)</div>
      <ul style="font-size:12px;margin:4px 0 8px 18px;padding:0">
        <li>Move = price at 13:15 vs yesterday's close; |move| ≥ 3% (also ≥ 5%, the video's "strong day").</li>
        <li>Level = the 13:15–13:45 candle. Up-move → sell below its low, stop its high. Down-move → buy above its high, stop its low. Fill at the level, or worse if price jumps through it.</li>
        <li>Skip if the stop is closer than 0.3% or further than 3%. Target 1R. Stop counted first when both fall in one 5-minute candle.</li>
        <li><b>Video version</b>: out the same day at the target, otherwise carried overnight (stock futures; non-F&amp;O stocks out at 15:15), next day out at target / stop / 15:15; a level not triggered stays valid the next day until 15:15.
          <b>Same-day version</b>: out by 15:15, no carry, no next-day levels. <b>NIFTY</b>: video rules, move ≥ 1% (index moves are smaller) and ≥ 3%; BANKNIFTY has no 5-minute history here.</li>
        <li>Costs: intraday equity charges for same-day trades, futures charges for carried and NIFTY trades, plus slippage. The video trades ATM options — those can't be tested (no intraday stock-option prices), and they would add time decay and wider spreads.</li>
      </ul>`;
    const g = (id) => R[id]?.account;
    html += `<div style="font-size:14px;margin-top:10px"><b>5-year backtest</b> — after costs, per trade (account: max 2 new trades a day)</div>`;
    html += r1Table([
      ['<b>Video version</b>, move ≥ 3%', g('V|3|reversal')],
      ['Video version, move ≥ 5%', g('V|5|reversal')],
      ['<b>Same-day version</b>, move ≥ 3%', g('S|3|reversal')],
      ['Same-day version, move ≥ 5%', g('S|5|reversal')],
      ['<span class="note" style="display:inline">Control</span> trade with the move (video exits)', g('V|3|continuation')],
      ['<span class="note" style="display:inline">Control</span> trade with the move (same-day)', g('S|3|continuation')],
      ['<span class="note" style="display:inline">Control</span> fade at 13:45, no level (video exits)', g('V|3|fade')],
      ['<span class="note" style="display:inline">Control</span> fade at 13:45, no level (same-day)', g('S|3|fade')],
      ['<span class="note" style="display:inline">Control</span> random side at 13:45 (same-day)', g('S|3|random')],
      ...Object.entries(b.sensitivity || {}).map(([id, x]) => [`<span class="note" style="display:inline">Kinder fill rule*</span> ${id.startsWith('V') ? 'video' : 'same-day'} version`, x.account]),
    ]);
    html += '<div class="note">* Added after the first run, not used for the verdict: on the entry candle, its colour decides whether the stop or the entry came first (instead of always the stop). Still negative after costs.</div>';
    const side = (v) => [[`${v === 'V' ? 'Video' : 'Same-day'} · buys (after a fall)`, g(`${v}|3|reversal`)?.long], [`${v === 'V' ? 'Video' : 'Same-day'} · sells (after a rise)`, g(`${v}|3|reversal`)?.short]];
    html += `<div style="font-size:14px;margin-top:10px"><b>Buys vs sells</b> (move ≥ 3%)</div>${r1Table([...side('V'), ...side('S')])}`;
    const years = Object.keys(g('V|3|reversal')?.byYear || {});
    html += `<div style="font-size:14px;margin-top:10px"><b>Year by year</b> (move ≥ 3%, after costs)</div><div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Version</th>${years.map((y) => `<th>${y}</th>`).join('')}</tr></thead><tbody>${['V', 'S'].map((v) =>
      `<tr><td style="text-align:left">${v === 'V' ? 'Video' : 'Same-day'}</td>${years.map((y) => { const x = g(`${v}|3|reversal`)?.byYear?.[y]; return `<td>${x?.trades ? `${x.trades} · <b style="color:${r1Col(x.avgRNet)};white-space:nowrap">${r1R(x.avgRNet)}</b>` : '–'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (b.parts) {
      const P = b.parts;
      const ln = (l, x) => (x?.trades ? `${l}: ${x.trades} trades, ${r1R(x.avgRNet)} (before costs ${r1R(x.avgRGross)})` : `${l}: none`);
      html += `<div class="note" style="margin-top:6px">Video version, where the losses come from — ${ln('same-day setups', P.sameDaySetups)} · ${ln('next-day levels', P.nextDayLevels)} (${ln('at the 9:15 candle', P.nextDayAt0915)}) · ${ln('carried overnight', P.carried)}.</div>`;
    }
    const I = b.index || {};
    html += `<div style="font-size:14px;margin-top:10px"><b>NIFTY</b> (video rules, futures proxy)</div>${r1Table([
      ['Reversal, move ≥ 1%', I['1|reversal']], ['Reversal, move ≥ 3% (rare)', I['3|reversal']],
      ['<span class="note" style="display:inline">Control</span> with the move, ≥ 1%', I['1|continuation']], ['<span class="note" style="display:inline">Control</span> fade at 13:45, ≥ 1%', I['1|fade']],
    ])}`;
    html += `<div class="note">${esc(b.note)}</div>`;
  } else html += '<div class="note">Backtest not run yet (node paper-bot/one-fifteen.mjs --backtest; it re-runs with the Saturday re-tests).</div>';

  if (p?.startedAt) {
    const vs = p.byVersion || {};
    const recLine = (k) => { const x = vs[k] || {}; return `${esc(x.label || k)}: ${x.trades ? `${x.trades} closed · won ${r1Pc(x.winRate)} · ${r1R(x.avgRNet)} a trade · ${r1Rs(x.totalNetRs)}` : 'no closed trades yet'}${x.open ? ` · ${x.open} open` : ''}`; };
    html += `<div style="font-size:14px;margin-top:12px"><b>Paper record</b> since ${esc(p.startedAt)} (updated after the close from the saved 5-minute candles)</div>
      <ul style="font-size:12px;margin:4px 0 6px 18px;padding:0">${['V', 'S', 'I'].map((k) => `<li>${recLine(k)}</li>`).join('')}</ul>`;
    const su = p.setups;
    if (su?.list) html += `<div style="font-size:13px"><b>Setups on ${esc(su.date || '–')}</b>: ${su.list.length ? su.list.map((x) => `${esc(x.symbol.replace('.NS', ''))} ${x.move >= 0 ? '+' : ''}${r1F(x.move, 1)}% → ${x.side === 'short' ? 'sell below' : 'buy above'} ₹${r1F(x.level, 2)} (stop ₹${r1F(x.stop, 2)}) ${x.triggered ? `· triggered ${esc(x.triggered)}` : '· not triggered'}`).join(' · ') : 'no stock moved 3% by 13:15.'}</div>`;
    const lv = p.levels;
    if (lv?.list) html += `<div class="note">Levels still valid next session until 15:15 (video version, paper): ${lv.list.length ? lv.list.map((x) => `${esc(x.symbol.replace('.NS', ''))} ${x.side === 'short' ? 'sell below' : 'buy above'} ₹${r1F(x.level, 2)}, stop ₹${r1F(x.stop, 2)}${x.fno ? '' : ' (not F&amp;O)'}`).join(' · ') : 'none'}.</div>`;
    if (p.trades?.length) html += `<div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th style="text-align:left">Stock</th><th>Version</th><th>Entered</th><th>Side</th><th>Move</th><th>Entry</th><th>Stop</th><th>Exit</th><th>Why</th><th>Result</th></tr></thead><tbody>${p.trades.map((t) =>
      `<tr><td style="text-align:left">${esc(t.symbol.replace('.NS', ''))}</td><td>${t.symbol === '^NSEI' ? 'NIFTY' : t.version === 'V' ? 'video' : 'same-day'}</td><td>${esc(t.date)} ${esc(t.time)}${t.fromPrev ? ' (yesterday\'s level)' : ''}</td><td>${t.side === 'short' ? 'sell' : 'buy'}</td><td>${r1F(t.move, 1)}%</td><td>₹${r1F(t.entry, 2)}</td><td>₹${r1F(t.stop, 2)}</td><td>${t.open ? 'open' : `₹${r1F(t.exit, 2)} ${esc(t.exitDate === t.date ? '' : t.exitDate || '')}`}</td><td>${t.open ? 'carried' : esc(t.reason)}${t.carried ? ' (overnight)' : ''}</td><td style="color:${r1Col(t.net)}">${t.open ? '–' : `<b>${r1R(t.rNet)}</b> ${r1Rs(t.net)}`}</td></tr>`).join('')}</tbody></table></div>`;
  } else html += '<div class="note" style="margin-top:10px">Paper record starts with the next evening run.</div>';
  html += '<div class="note" style="margin-top:8px">Research and paper trading only. Not advice.</div>';
  $('r115Out').innerHTML = html;
}
lazy('1:15 PM reversal', async () => {
  try { r1Render(await api('/api/one-fifteen')); } catch (e) { $('r115Out').innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
});
