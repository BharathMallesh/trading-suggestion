// 02-research-tools.js — Ask (Ling), market data, option calculator, Paper-Bot, Candle AI read, Call / Put prediction and its live scorecard.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// --- Ask ---
let mode = 'research';
$('askTabs').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  mode = e.target.dataset.mode;
  [...$('askTabs').children].forEach((b) => b.classList.toggle('active', b === e.target));
  $('sumWrap').style.display = mode === 'summarize' ? 'block' : 'none';
  $('qWrap').style.display = mode === 'summarize' ? 'none' : 'block';
  $('qLabel').textContent = mode === 'explain' ? 'Concept to explain' : 'Question';
  // Don't leave the previous tab's answer/error on screen.
  $('askOut').className = 'out';
  $('askOut').textContent = '';
});
$('askBtn').addEventListener('click', async () => {
  const out = $('askOut');
  out.className = 'out';
  out.textContent = 'Thinking…';
  $('askBtn').disabled = true;
  try {
    const body = mode === 'summarize'
      ? { mode, text: $('text').value, focus: $('focus').value }
      : { mode, question: $('q').value };
    const { answer, model } = await api('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    out.textContent = answer || '(empty response)';
    if (model) {
      const tag = document.createElement('div');
      tag.className = 'note';
      tag.textContent = /:free$/.test(model)
        ? `Answered by ${model} (free fallback — Ling is unavailable, e.g. out of credits). Not finance-tuned; double-check facts.`
        : `Answered by ${model}.`;
      out.appendChild(tag);
    }
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  } finally {
    $('askBtn').disabled = false;
  }
});

// --- Market data ---
$('mktBtn').addEventListener('click', async () => {
  const out = $('mktOut');
  out.className = 'out';
  out.textContent = 'Loading…';
  $('chartOut').innerHTML = '';
  try {
    const sym = $('sym').value.trim();
    // Intraday one-day view (TradingView style): its own endpoint + chart.
    if ($('range').value === 'yesterday') {
      const d = await api('/api/intraday?symbol=' + encodeURIComponent(sym) + '&interval=1m&date=previous');
      $('chartOut').innerHTML = renderIntradayChart(d);
      out.innerHTML = `<div class="note">${esc(d.symbol)} — ${esc(d.date)} — ${d.count} one-minute candles. Public data, may be delayed.</div>`;
      return;
    }
    const q = await api('/api/quote?symbol=' + encodeURIComponent(sym));
    const { rows } = await api('/api/candles?symbol=' + encodeURIComponent(sym) + '&' + rangeParams());
    $('chartOut').innerHTML = renderCandles(rows, $('range').selectedOptions[0].textContent, sym);
    const chg = q.price - q.previousClose;
    const pct = q.previousClose ? (chg / q.previousClose) * 100 : 0;
    const col = chg >= 0 ? 'var(--up)' : 'var(--down)';
    let html = `<div class="quote-head">${esc(q.name)} <span style="color:var(--muted)">(${esc(q.symbol)} · ${esc(q.exchange || '')})</span></div>`;
    html += `<div class="kv">
      <div>Price</div><div>${q.price} ${esc(q.currency || '')} <span style="color:${col}">(${chg >= 0 ? '+' : ''}${chg.toFixed(2)}, ${pct.toFixed(2)}%)</span></div>
      <div>Prev close</div><div>${q.previousClose}</div>
      <div>Day range</div><div>${q.dayLow} – ${q.dayHigh}</div>
      <div>52-week</div><div>${q.fiftyTwoWeekLow} – ${q.fiftyTwoWeekHigh}</div>
      <div>Volume</div><div>${(q.volume || 0).toLocaleString()}</div>
    </div>`;
    const tail = rows.slice(-10).reverse();
    html += '<table><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr>';
    for (const r of tail) html += `<tr><td>${r.date}</td><td>${r.open}</td><td>${r.high}</td><td>${r.low}</td><td>${r.close}</td></tr>`;
    html += '</table><div class="note">Public data, may be delayed. Latest 10 rows shown.</div>';
    out.innerHTML = html;
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  }
});

// --- Describe the data (facts always; narration if the key is set) ---
$('descBtn').addEventListener('click', async () => {
  const out = $('descOut');
  out.className = 'out';
  out.textContent = 'Reading the data…';
  const sym = $('sym').value.trim();
  const rp = rangeParams();
  try {
    let d;
    try {
      d = await api('/api/describe?symbol=' + encodeURIComponent(sym) + '&' + rp + '&narrate=1');
    } catch (e) {
      // No API key (or narration failed) — still show the deterministic facts.
      if (/OPENROUTER_API_KEY|401|402|out of credits|rejected the API key/i.test(e.message)) {
        d = await api('/api/describe?symbol=' + encodeURIComponent(sym) + '&' + rp + '&narrate=0');
        d._noNarrate = true;
      } else throw e;
    }
    let html = '<div style="font-family:var(--mono,monospace);font-size:13px">' + esc(d.facts).replace(/\n/g, '<br>') + '</div>';
    if (d.narrative) {
      html += '<div style="margin-top:12px;white-space:pre-wrap">' + esc(d.narrative) + '</div>';
    } else if (d._noNarrate) {
      html += '<div class="note">Plain-English description needs a working OpenRouter key with credits (see the health chips on Today). Facts above are computed offline.</div>';
    }
    html += '<div class="note">Describes what the data shows — not a forecast or a suggestion.</div>';
    out.innerHTML = html;
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  }
});

// --- Call / Put probability (Yahoo + Ling) ---
$('probBtn').addEventListener('click', async () => {
  const out = $('probOut');
  out.className = 'out';
  out.textContent = 'Estimating Call / Put probabilities…';
  const sym = $('sym').value.trim();
  if (!sym) {
    out.className = 'out err';
    out.textContent = 'Enter a symbol first, e.g. RELIANCE.NS';
    return;
  }
  try {
    const d = await api('/api/groww-predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, intervalMinutes: 15, preferYahoo: true, includeNews: true }),
    });
    const p = d.prediction || {};
    const callPct = ((Number(p.probUp) || 0) * 100).toFixed(0);
    const putPct = ((Number(p.probDown) || 0) * 100).toFixed(0);
    const sidePct = ((Number(p.probSideways) || 0) * 100).toFixed(0);
    const confPct = ((Number(p.confidence) || 0) * 100).toFixed(0);
    const biasColor =
      p.bias === 'UP' ? 'var(--up)' : p.bias === 'DOWN' ? 'var(--down)' : 'var(--muted)';
    out.innerHTML = `
      <div class="note" style="margin-bottom:8px">${esc(d.disclaimer || '')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:11px;color:var(--muted)">CALL (up)</div>
          <div style="font-size:28px;font-weight:700;color:var(--muted)">${callPct}%</div>
        </div>
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:11px;color:var(--muted)">PUT (down)</div>
          <div style="font-size:28px;font-weight:700;color:var(--muted)">${putPct}%</div>
        </div>
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:11px;color:var(--muted)">SIDEWAYS</div>
          <div style="font-size:28px;font-weight:700;color:var(--muted)">${sidePct}%</div>
        </div>
      </div>
      ${renderEdge(d.edge)}
      ${renderTilt(d.newsTilt, d.news)}
      <div class="kv">
        <div>Bias</div><div style="color:${biasColor};font-weight:700">${esc(p.bias || '–')}</div>
        <div>Confidence</div><div>${confPct}%</div>
        <div>As of</div><div>${esc(d.asOf || '')} · last ${Number(d.lastClose || 0).toFixed(2)}</div>
      </div>
      <div style="margin-top:10px;white-space:pre-wrap;font-size:13px">${esc(p.summary || '')}</div>
      <div class="note">${d.hybrid?.calibration?.windowsCalibrated ? `Calibrated to past data (${d.hybrid.calibration.windowsCalibrated}/${d.hybrid.calibration.windows} windows).` : 'Uncalibrated formula — see Model evaluation below.'}</div>`;
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  }
});

// --- Option calculator ---
$('optBtn').addEventListener('click', async () => {
  const out = $('optOut');
  out.className = 'out';
  out.textContent = 'Calculating…';
  try {
    const p = new URLSearchParams({
      spot: $('spot').value, strike: $('strike').value, days: $('days').value,
      iv: $('iv').value, type: $('otype').value,
    });
    if ($('action').value) {
      p.set('action', $('action').value);
      p.set('lot', $('lot').value);
      if ($('premium').value) p.set('premium', $('premium').value);
    }
    const d = await api('/api/option?' + p.toString());
    const g = d.greeks;
    let html = `<div class="kv">
      <div>Theoretical price</div><div>${g.price.toFixed(2)}</div>
      <div>Delta</div><div>${g.delta.toFixed(4)}</div>
      <div>Gamma</div><div>${g.gamma.toFixed(6)}</div>
      <div>Vega (per 1% IV)</div><div>${g.vegaPer1pct.toFixed(4)}</div>
      <div>Theta (per day)</div><div>${g.thetaPerDay.toFixed(4)}</div>
    </div>`;
    if (d.payoff) {
      const po = d.payoff;
      html += `<div class="kv" style="margin-top:14px">
        <div>Position</div><div>${esc(po.position)} @ ${d.premiumUsed.toFixed(2)}</div>
        <div>Breakeven</div><div>${po.breakeven}</div>
        <div>Max loss / lot</div><div>${po.perLot.maxLoss}</div>
        <div>Max profit / lot</div><div>${po.perLot.maxProfit}</div>
      </div>`;
      html += '<div class="note">Mechanics of the position you described — not a suggestion to take it.</div>';
    }
    out.innerHTML = html;
  } catch (e) {
    out.className = 'out err';
    out.textContent = 'Error: ' + e.message;
  }
});

// --- Paper-Bot helpers ---
function pbParams() {
  const raw = $('pbSyms').value.trim();
  const symbols = raw
    ? raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    symbols,
    techOnly: $('pbMode').value === 'tech',
    interval: $('pbInterval').value,
    includeNews: $('pbNews').checked,
  };
}

function renderEquityCurve(curve) {
  if (!curve || curve.length < 2) return '';
  const W = 640, H = 160, padL = 48, padR = 12, padT = 12, padB = 22;
  const vals = curve.map((p) => p.equity);
  let min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  min -= span * 0.05; max += span * 0.05;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xFor = (i) => padL + (i / (curve.length - 1)) * plotW;
  const yFor = (v) => padT + ((max - v) / (max - min)) * plotH;
  let path = '';
  curve.forEach((p, i) => {
    path += (i === 0 ? 'M' : 'L') + xFor(i).toFixed(1) + ',' + yFor(p.equity).toFixed(1);
  });
  const last = curve[curve.length - 1];
  const first = curve[0];
  const col = last.equity >= first.equity ? 'var(--up)' : 'var(--down)';
  return `<div style="margin-top:12px">
    <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Equity curve</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:var(--soft);border-radius:8px">
      <path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>
      <text x="${padL}" y="${H - 6}" fill="var(--muted)" font-size="10">${esc(String(first.date || ''))}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="var(--muted)" font-size="10">${esc(String(last.date || ''))}</text>
      <text x="${padL - 4}" y="${yFor(max) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${max.toFixed(0)}</text>
      <text x="${padL - 4}" y="${yFor(min) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${min.toFixed(0)}</text>
    </svg>
  </div>`;
}

// Scan
$('pbBtn').addEventListener('click', async () => {
  const out = $('pbOut');
  const status = $('pbStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  status.textContent = 'Scanning…';
  $('pbBtn').disabled = true;
  try {
    const d = await api('/api/paper-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pbParams()),
    });
    let html = `<div class="note" style="margin-bottom:10px">
      Mode: <b>${esc(d.mode)}</b> · Interval: <b>${esc(d.interval)}</b> · ${esc(d.disclaimer)}
    </div>`;
    html += `<table><thead><tr>
      <th>Symbol</th><th>Signal</th><th>Conf</th><th>Tech bias</th>
      <th>Close</th><th>RSI</th><th>News</th><th>Reasoning</th>
    </tr></thead><tbody>`;
    for (const s of d.signals || []) {
      const color = s.signal === 'LONG' ? 'var(--up)' : s.signal === 'SHORT' ? 'var(--down)' : 'var(--muted)';
      html += `<tr>
        <td>${esc(s.symbol)}</td>
        <td style="color:${color};font-weight:600">${esc(s.signal)}</td>
        <td>${((s.confidence || 0) * 100).toFixed(0)}%</td>
        <td>${esc(s.techBias || '–')}</td>
        <td>${s.indicators?.close != null ? s.indicators.close.toFixed(2) : '–'}</td>
        <td>${s.indicators?.rsi14 != null ? s.indicators.rsi14.toFixed(1) : '–'}</td>
        <td>${sentimentBadge(s.news)}</td>
        <td style="text-align:left;max-width:280px;font-size:12px">${esc((s.reasoning || '').slice(0, 140))}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    const p = d.paper || {};
    html += `<div class="kv" style="margin-top:16px">
      <div>Starting capital</div><div>₹${Number(p.startingCapital || 0).toLocaleString('en-IN')}</div>
      <div>Paper equity</div><div>₹${Number(p.equity || 0).toFixed(0)}</div>
      <div>Cash</div><div>₹${Number(p.cash || 0).toFixed(0)}</div>
      <div>Open positions</div><div>${p.openPositions || 0}</div>
    </div>`;
    if (p.opened?.length) {
      html += '<div style="margin-top:10px;font-size:13px"><b>Opened this scan:</b><ul style="margin:6px 0 0 18px">';
      for (const o of p.opened) {
        const sideColor = o.side === 'LONG' ? 'var(--up)' : 'var(--down)';
        html += `<li><span style="color:${sideColor};font-weight:600">${esc(o.side)}</span>
          ${esc(o.symbol)} qty=${o.qty} @ ${Number(o.price).toFixed(2)}
          stop=${o.stop != null ? Number(o.stop).toFixed(2) : '–'}
          tgt=${o.target != null ? Number(o.target).toFixed(2) : '–'}</li>`;
      }
      html += '</ul></div>';
    } else {
      html += '<div class="note" style="margin-top:10px">No positions opened (FLAT or below confidence).</div>';
    }
    out.innerHTML = html;
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('pbBtn').disabled = false;
  }
});

// Backtest
$('pbBacktestBtn').addEventListener('click', async () => {
  const out = $('pbOut');
  const status = $('pbStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  status.textContent = $('pbMode').value === 'hybrid' ? 'Running hybrid backtest (asks Ling on each setup)… may take 1–2 minutes.' : 'Running backtest… may take 10–30s.';
  $('pbBacktestBtn').disabled = true;
  try {
    const d = await api('/api/paper-backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pbParams()),
    });
    const s = d.summary || {};
    let html = `<div class="note" style="margin-bottom:10px">
      Backtest · ${esc(d.mode)} · ${esc(d.interval)} · ${esc((d.symbols || []).join(', '))}
      ${d.period ? ` · ${esc(d.period.from)} → ${esc(d.period.to)}` : ''}
    </div>`;
    if (d.skipped?.length) html += `<div class="err" style="margin-bottom:8px">Skipped: ${esc(d.skipped.join(' · '))}</div>`;
    html += `<div class="kv">
      <div>Starting capital</div><div>₹${Number(s.startingCapital || 0).toLocaleString('en-IN')}</div>
      <div>Final equity</div><div>₹${Number(s.finalEquity || 0).toFixed(0)}</div>
      <div>Total return</div><div>${Number(s.totalReturnPct || 0).toFixed(1)}%</div>
      <div>Closed trades</div><div>${s.closedTrades || 0}</div>
      <div>LONG / SHORT</div><div>${s.sideBreakdown?.LONG || 0} / ${s.sideBreakdown?.SHORT || 0}</div>
      <div>Win rate</div><div>${Number(s.winRatePct || 0).toFixed(1)}%</div>
      <div>Profit factor</div><div>${s.profitFactor === 'Infinity' ? '∞' : Number(s.profitFactor || 0).toFixed(2)}</div>
      <div>Max drawdown</div><div>${Number(s.maxDrawdownPct || 0).toFixed(1)}%</div>
      <div>Exit reasons</div><div>${esc(JSON.stringify(s.exitReasons || {}))}</div>
      <div>Charges paid</div><div>₹${Number(s.totalCharges || 0).toFixed(0)} <span style="color:var(--muted)">(${esc(s.product || '')}: STT, exchange, SEBI, stamp, GST${s.product === 'delivery' ? ', DP' : ', brokerage'} · slippage in fills)</span></div>
      ${d.benchmark ? `<div>Buy &amp; hold same stocks</div><div>${Number(d.benchmark.buyHoldPct).toFixed(1)}%</div>` : ''}
      ${d.benchmark?.indexPct != null ? `<div>NIFTY 50</div><div>${Number(d.benchmark.indexPct).toFixed(1)}%</div>` : ''}
    </div>
    ${d.benchmark ? `<div class="note">${Number(s.totalReturnPct) > Number(d.benchmark.buyHoldPct) ? 'Beat' : 'Lagged'} buy-and-hold of the same stocks by ${Math.abs(Number(s.totalReturnPct) - Number(d.benchmark.buyHoldPct)).toFixed(1)} pts. ${s.product === 'delivery' ? 'Daily mode is long-only: retail can’t hold cash-segment shorts overnight.' : 'Intraday mode squares off every position at the session end.'}</div>` : ''}`;
    html += renderEquityCurve(d.equityCurve || []);
    if (d.trades?.length) {
      html += `<div style="margin-top:14px;font-size:13px"><b>Recent trades</b></div>
        <table><thead><tr>
          <th>Entry</th><th>Exit</th><th>Side</th><th>Symbol</th><th>PnL</th><th>Reason</th>
        </tr></thead><tbody>`;
      for (const t of d.trades.slice(-15).reverse()) {
        const col = t.pnl >= 0 ? 'var(--up)' : 'var(--down)';
        html += `<tr>
          <td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td>
          <td>${esc(t.side)}</td><td>${esc(t.symbol)}</td>
          <td style="color:${col}">${t.pnl >= 0 ? '+' : ''}₹${Number(t.pnl).toFixed(0)} (${Number(t.pnlPct).toFixed(1)}%)</td>
          <td>${esc(t.reason)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }
    html += `<div class="note" style="margin-top:10px">${esc(d.disclaimer || '')}</div>`;
    out.innerHTML = html;
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('pbBacktestBtn').disabled = false;
  }
});

// Multi-agent
$('pbAgentsBtn').addEventListener('click', async () => {
  const out = $('pbOut');
  const status = $('pbStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  status.textContent = 'Running research + signal agents…';
  $('pbAgentsBtn').disabled = true;
  try {
    const params = pbParams();
    const d = await api('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    let html = `<div class="note" style="margin-bottom:10px">
      Multi-agent brief · ${(d.disclaimers || []).join(' ')}
    </div>`;

    // Research
    const r = d.agents?.research || {};
    html += `<div style="margin-top:8px"><b>Research agent</b> ${r.symbol ? '(' + esc(r.symbol) + ')' : ''}</div>`;
    if (r.quote) {
      html += `<div class="kv">
        <div>Price</div><div>${Number(r.quote.price).toFixed(2)} ${esc(r.quote.currency || '')}</div>
        <div>Day range</div><div>${Number(r.quote.dayLow).toFixed(2)} – ${Number(r.quote.dayHigh).toFixed(2)}</div>
      </div>`;
    }
    if (r.description) {
      html += `<div style="margin-top:8px;font-family:var(--mono,monospace);font-size:12px">${esc(r.description).replace(/\n/g, '<br>')}</div>`;
    }
    if (r.answer) {
      html += `<div class="out" style="margin-top:8px;white-space:pre-wrap;font-size:13px">${esc(r.answer)}</div>`;
    } else if (r.error) {
      html += `<div class="err" style="margin-top:8px">Research answer unavailable: ${esc(r.error)}</div>`;
    }

    // Signals
    const sigs = d.agents?.signal?.signals || [];
    html += `<div style="margin-top:16px"><b>Signal agent</b> (${esc(d.agents?.signal?.mode || '')})</div>`;
    html += `<table><thead><tr><th>Symbol</th><th>Signal</th><th>Conf</th><th>Reasoning</th></tr></thead><tbody>`;
    for (const s of sigs) {
      const color = s.signal === 'LONG' ? 'var(--up)' : s.signal === 'SHORT' ? 'var(--down)' : 'var(--muted)';
      html += `<tr>
        <td>${esc(s.symbol)}</td>
        <td style="color:${color};font-weight:600">${esc(s.signal)}</td>
        <td>${((s.confidence || 0) * 100).toFixed(0)}%</td>
        <td style="text-align:left;font-size:12px">${esc((s.reasoning || '').slice(0, 120))}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    // Experimental paper suggestions
    html += `<div style="margin-top:16px"><b>Experimental paper suggestions</b>
      <span style="color:var(--warn);font-size:12px"> — paper simulation only, not advice</span></div>`;
    if (d.experimentalSuggestions?.length) {
      html += '<ul style="margin:8px 0 0 18px;font-size:13px">';
      for (const s of d.experimentalSuggestions) {
        const col = s.action.includes('LONG') ? 'var(--up)' : 'var(--down)';
        html += `<li>
          <span style="color:${col};font-weight:600">${esc(s.action)}</span>
          ${esc(s.symbol)} qty=${s.qty} @ ${Number(s.entry).toFixed(2)}
          stop=${s.stop != null ? Number(s.stop).toFixed(2) : '–'}
          tgt=${s.target != null ? Number(s.target).toFixed(2) : '–'}
          <div style="color:var(--muted);font-size:12px">${esc(s.why || '')}</div>
        </li>`;
      }
      html += '</ul>';
    } else {
      html += '<div class="note">No paper suggestions (all FLAT or below confidence).</div>';
    }

    const p = d.paper || {};
    html += `<div class="kv" style="margin-top:14px">
      <div>Paper equity</div><div>₹${Number(p.equity || 0).toFixed(0)}</div>
      <div>Open positions</div><div>${p.openPositions || 0}</div>
    </div>`;

    out.innerHTML = html;
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('pbAgentsBtn').disabled = false;
  }
});

// --- Candle AI read (Ling prediction-style) ---
$('cpBtn').addEventListener('click', async () => {
  const out = $('cpOut');
  const status = $('cpStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  status.textContent = 'Fetching candles and asking Ling…';
  $('cpBtn').disabled = true;
  try {
    const symbol = $('cpSym').value.trim();
    if (!symbol) throw new Error('Enter a symbol, e.g. RELIANCE.NS');
    const d = await api('/api/candle-predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        range: $('cpRange').value,
        interval: $('cpInterval').value,
      }),
    });
    const p = d.prediction || {};
    const biasColor =
      p.bias === 'BULLISH' ? 'var(--up)' : p.bias === 'BEARISH' ? 'var(--down)' : 'var(--muted)';
    let html = `<div class="note" style="margin-bottom:10px">${esc(d.disclaimer || '')}</div>`;
    if (d.rangeAdjusted) html += `<div class="note" style="margin-bottom:8px;color:var(--warn)">${esc(d.rangeAdjusted)}</div>`;
    html += `<div class="kv">
      <div>Symbol</div><div>${esc(d.symbol)} · as of ${esc(d.asOf || '')}</div>
      <div>Last close</div><div>${Number(d.lastClose || 0).toFixed(2)}</div>
      <div>Bias</div><div style="color:${biasColor};font-weight:700;font-size:16px">${esc(p.bias || '–')}</div>
      <div>Horizon</div><div>${esc(p.horizon || '–')}</div>
      <div>Confidence</div><div>${((p.confidence || 0) * 100).toFixed(0)}%</div>
      <div>RSI / ATR</div><div>${d.indicators?.rsi14 != null ? Number(d.indicators.rsi14).toFixed(1) : '–'} / ${d.indicators?.atr14 != null ? Number(d.indicators.atr14).toFixed(2) : '–'}</div>
    </div>`;
    html += `<div style="margin-top:12px;white-space:pre-wrap;font-size:14px">${esc(p.summary || '')}</div>`;
    if (p.supports?.length) {
      html += '<div style="margin-top:12px"><b>Supports</b><ul style="margin:6px 0 0 18px">';
      for (const s of p.supports) html += `<li>${esc(s)}</li>`;
      html += '</ul></div>';
    }
    if (p.risks?.length) {
      html += '<div style="margin-top:10px"><b>Risks</b><ul style="margin:6px 0 0 18px">';
      for (const s of p.risks) html += `<li>${esc(s)}</li>`;
      html += '</ul></div>';
    }
    if (p.invalidation) {
      html += `<div class="note" style="margin-top:10px"><b>Invalidation:</b> ${esc(p.invalidation)}</div>`;
    }
    out.innerHTML = html;
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('cpBtn').disabled = false;
  }
});

// --- Groww → Ling probability (tabs: 15m vs multi-horizon) ---
function setGpTab(mode) {
  $('gpMode').value = mode;
  const on = 'margin-top:0;background:var(--accent);color:var(--on-accent);font-weight:700';
  const off = 'margin-top:0;background:var(--soft);color:var(--ink);border:1px solid var(--line)';
  $('gpTab15').style.cssText = mode === '15m' ? on : off;
  $('gpTabMulti').style.cssText = mode === 'multi' ? on : off;
}
$('gpTab15').addEventListener('click', () => setGpTab('15m'));
$('gpTabMulti').addEventListener('click', () => setGpTab('multi'));

$('gpBtn').addEventListener('click', async () => {
  const out = $('gpOut');
  const status = $('gpStatus');
  out.innerHTML = '';
  status.style.display = 'block';
  const mode = $('gpMode').value || '15m';
  status.textContent =
    mode === 'multi'
      ? 'Multi-horizon mix: scoring 2m + 1m + today + 1h + 15m…'
      : '15-min only: scoring primary interval…';
  $('gpBtn').disabled = true;
  try {
    const symbol = $('gpSym').value.trim();
    if (!symbol) throw new Error('Enter a symbol, e.g. HDFCBANK');
    const d = await api('/api/groww-predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        intervalMinutes: Number($('gpInterval').value),
        preferYahoo: $('gpSource').value === 'yahoo',
        includeNews: $('gpNews').checked,
        mode,
      }),
    });
    const p = d.prediction || {};
    const biasColor =
      p.bias === 'UP' ? 'var(--up)' : p.bias === 'DOWN' ? 'var(--down)' : 'var(--muted)';
    const pctNum = (x) => ((Number(x) || 0) * 100).toFixed(0);
    const pct = (x) => pctNum(x) + '%';
    const callPct = pctNum(p.probUp);
    const putPct = pctNum(p.probDown);
    const sidePct = pctNum(p.probSideways);
    let html = `<div class="note" style="margin-bottom:10px">${esc(d.disclaimer || '')}</div>`;
    html += `<div class="note" style="margin-bottom:8px">Source: <b>${esc(d.source || 'yahoo')}</b> · ${d.bars || 0} bars · ${esc(String(d.intervalMinutes || ''))}m · as of ${esc(d.asOf || '')}</div>`;

    // Big Call / Put / Sideways cards
    html += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:12px 0">
      <div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:12px;color:var(--muted)">CALL · probability price goes UP</div>
        <div style="font-size:32px;font-weight:700;color:var(--muted);margin-top:4px">${callPct}%</div>
      </div>
      <div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:12px;color:var(--muted)">PUT · probability price goes DOWN</div>
        <div style="font-size:32px;font-weight:700;color:var(--muted);margin-top:4px">${putPct}%</div>
      </div>
      <div style="background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:12px;color:var(--muted)">SIDEWAYS · chop / no clear move</div>
        <div style="font-size:32px;font-weight:700;color:var(--muted);margin-top:4px">${sidePct}%</div>
      </div>
    </div>`;

    html += renderEdge(d.edge);
    html += renderTilt(d.newsTilt, d.news);
    html += `<div class="kv">
      <div>Symbol</div><div>${esc(d.symbol)} · last ${Number(d.lastClose || 0).toFixed(2)}</div>
      <div>Bias</div><div style="color:${biasColor};font-weight:700">${esc(p.bias || '–')}</div>
      <div>Model confidence</div><div>${pct(p.confidence)}</div>
      <div>Horizon</div><div>${esc(p.horizon || 'next session')}</div>
    </div>`;

    // Expected move (ATR bands) + time window
    const em = d.expectedMove || {};
    if (em.available) {
      const fmt = (x) => Number(x).toFixed(2);
      const fp = (x) => Number(x).toFixed(2);
      html += `<div style="margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)">
        <div style="font-weight:700;margin-bottom:6px">Research range (ATR-based) · not a trade target</div>
        <div class="kv">
          <div>Time window</div><div>${esc(em.timeWindow || '–')}</div>
          <div>ATR-14</div><div>${fmt(em.atr)}</div>
          <div>Upside band</div><div style="color:var(--up)">soft +${fp(em.upside.softPct)}% (${fmt(em.upside.soft)}) · typical +${fp(em.upside.typicalPct)}% (${fmt(em.upside.typical)}) · extended +${fp(em.upside.extendedPct)}% (${fmt(em.upside.extended)})</div>
          <div>Downside band</div><div style="color:var(--down)">soft −${fp(em.downside.softPct)}% (${fmt(em.downside.soft)}) · typical −${fp(em.downside.typicalPct)}% (${fmt(em.downside.typical)}) · extended −${fp(em.downside.extendedPct)}% (${fmt(em.downside.extended)})</div>
        </div>
        <div class="note" style="margin-top:8px">${esc(em.note || '')} ${em.lean ? '(' + esc(em.lean) + ')' : ''}</div>
      </div>`;
    } else if (em.timeWindow) {
      html += `<div class="note" style="margin-top:10px"><b>Time window:</b> ${esc(em.timeWindow)} — ${esc(em.note || '')}</div>`;
    }

    // Hybrid / multi-horizon breakdown
    const h = d.hybrid || {};
    if (h.calibration) {
      const c = h.calibration;
      html += c.windowsCalibrated
        ? `<div class="note" style="margin-top:10px">Probabilities calibrated to past data for ${c.windowsCalibrated} of ${c.windows} window(s) · fitted ${esc((c.fittedAt || '').slice(0, 10))}</div>`
        : `<div class="note" style="margin-top:10px;color:var(--warn)">Uncalibrated formula — run <b>Model evaluation → Fit &amp; use calibration</b> for honest probabilities.</div>`;
    }
    if (h.baseProbabilities) {
      const b = h.baseProbabilities;
      const modeLabel = (h.multiHorizon || h.mode === 'multi') ? 'Multi-horizon hybrid' : 'Single timeframe (primary interval)';
      html += `<div class="note" style="margin-top:10px">
        <b>${modeLabel}</b> · score <b>${Number(h.techScore || 0).toFixed(2)}</b> (−1 bear … +1 bull)
        · base Call ${pctNum(b.probUp)}% / Put ${pctNum(b.probDown)}% / Side ${pctNum(b.probSideways)}%
        · Ling adjust ≤${Math.round((h.maxAdjust || 0.15) * 100)}%
      </div>`;
    }
    if (h.horizons?.length) {
      html += `<div style="margin-top:8px;overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">
        <tr style="color:var(--muted);text-align:left">
          <th style="padding:4px 6px">Horizon</th>
          <th style="padding:4px 6px">Weight</th>
          <th style="padding:4px 6px">Score</th>
          <th style="padding:4px 6px">Call</th>
          <th style="padding:4px 6px">Put</th>
          <th style="padding:4px 6px">Side</th>
        </tr>`;
      for (const hz of h.horizons) {
        html += `<tr>
          <td style="padding:4px 6px">${esc(hz.label || hz.key)}</td>
          <td style="padding:4px 6px">${Math.round((hz.weight || 0) * 100)}%</td>
          <td style="padding:4px 6px">${Number(hz.score || 0).toFixed(2)}</td>
          <td style="padding:4px 6px;color:var(--up)">${pctNum(hz.probUp)}%</td>
          <td style="padding:4px 6px;color:var(--down)">${pctNum(hz.probDown)}%</td>
          <td style="padding:4px 6px">${pctNum(hz.probSideways)}%</td>
        </tr>`;
      }
      html += `</table></div>`;
    }

    html += `<div style="margin-top:12px;display:flex;height:22px;border-radius:8px;overflow:hidden;border:1px solid var(--line)">
      <div style="width:${callPct}%;background:var(--up)" title="Call ${callPct}%"></div>
      <div style="width:${sidePct}%;background:#4b5563" title="Sideways ${sidePct}%"></div>
      <div style="width:${putPct}%;background:var(--down)" title="Put ${putPct}%"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px">
      <span>Call ${callPct}%</span><span>Sideways ${sidePct}%</span><span>Put ${putPct}%</span>
    </div>`;

    html += `<div style="margin-top:14px;white-space:pre-wrap;font-size:14px">${esc(p.summary || '')}</div>`;
    if (d.news) html += renderNews(d.news);
    if (p.adjustmentNote) {
      html += `<div class="note" style="margin-top:8px"><b>Ling adjustment:</b> ${esc(p.adjustmentNote)}</div>`;
    }
    if (p.drivers?.length) {
      html += '<div style="margin-top:10px"><b>Why (drivers)</b><ul style="margin:6px 0 0 18px">';
      for (const s of p.drivers) html += `<li>${esc(s)}</li>`;
      html += '</ul></div>';
    }
    if (p.risks?.length) {
      html += '<div style="margin-top:8px"><b>Risks</b><ul style="margin:6px 0 0 18px">';
      for (const s of p.risks) html += `<li>${esc(s)}</li>`;
      html += '</ul></div>';
    }
    out.innerHTML = html;
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  } finally {
    $('gpBtn').disabled = false;
    gpScoreLoad();
  }
});

// --- Live scorecard for the Call / Put card (its own scored predictions) ---
async function gpScoreLoad() {
  const out = $('gpScore');
  try {
    const r = await api('/api/callput-scorecard?mode=' + $('gpScoreMode').value);
    const p = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
    let html = `<div style="font-size:13px"><b>${esc(r.verdict)}</b></div>
      <div class="note">${r.scored} scored · ${r.pending} waiting for their time window to finish (scored automatically every 15 min).</div>`;
    if (r.scored) {
      html += `<table style="margin-top:6px"><thead><tr><th style="text-align:left">When it leaned…</th><th>Times</th><th>It said (avg)</th><th>Came true</th><th style="text-align:left">What actually happened</th></tr></thead><tbody>${Object.values(r.byLean).map((g) =>
        `<tr><td style="text-align:left">${esc(g.label)}</td><td>${g.calls}</td><td>${p(g.avgStated)}</td><td><b>${p(g.cameTrue)}</b></td>
         <td style="text-align:left;font-size:12px">${g.calls ? `up ${g.happened.UP} · down ${g.happened.DOWN} · sideways ${g.happened.SIDEWAYS}` : '–'}</td></tr>`).join('')}</tbody></table>
        <div class="kv" style="margin-top:6px">
          <div>Right direction (when it moved)</div><div><b>${p(r.directionRight)}</b> of ${r.directionCalls} Call/Put calls — a coin flip is 50%</div>
          <div>Top call right</div><div>${p(r.topCallRight)} — always saying "${esc(r.mostCommon)}" would have been right ${p(r.alwaysMostCommonRight)}</div>
          <div>Accuracy score (Brier, lower = better)</div><div>${r.brierApp?.toFixed(3)} vs ${r.brierCoin?.toFixed(3)} for a coin flip</div>
        </div>`;
      html += `<table style="margin-top:6px;font-size:12px"><thead><tr><th style="text-align:left">Recent</th><th>Stock</th><th>Leaned</th><th>Said</th><th>Happened</th><th>Move</th><th></th></tr></thead><tbody>${r.recent.map((x) =>
        `<tr><td style="text-align:left">${esc(new Date(x.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td>${esc(String(x.symbol).replace('.NS', ''))}</td><td>${esc(x.lean)}</td><td>${p(x.stated)}</td><td>${esc(x.happened)}</td>
         <td>${x.retPct == null ? '–' : (x.retPct >= 0 ? '+' : '') + Number(x.retPct).toFixed(2) + '%'}</td><td style="color:${x.right ? 'var(--up)' : 'var(--down)'}">${x.right ? '✓' : '✗'}</td></tr>`).join('')}</tbody></table>`;
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`;
  }
}
$('gpScoreMode').addEventListener('change', gpScoreLoad);
lazy('Live candles', gpScoreLoad);
setInterval(() => { if (cardShown('Live candles')) gpScoreLoad(); }, 5 * 60 * 1000); // refresh every 5 minutes while visible
