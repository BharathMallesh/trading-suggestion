// 01-core.js — Shared helpers: api(), esc(), lazy loading, formatting.
// Classic script (not a module): loaded in order by index.html after 01-core.js; top-level names are shared across these files.
// Load each card's data the first time its tab is shown, not all at page start
// (the page has ~30 cards; most people open one or two tabs).
const LAZY = [];
const cardEl = (title) => [...document.querySelectorAll('main > section.card')].find((s) => (s.querySelector('h2')?.textContent.trim() || '').startsWith(title));
const cardShown = (title) => { const el = cardEl(title); return !!el && el.style.display !== 'none' && !document.hidden; };
function lazy(title, fn) {
  LAZY.push({ title, fn, done: false });
  if (typeof runLazy === 'function' && LAZY_READY) runLazy();
}
let LAZY_READY = false;
function runLazy() {
  for (const x of LAZY) {
    if (x.done) continue;
    const el = cardEl(x.title);
    if (el && el.style.display !== 'none') {
      x.done = true;
      Promise.resolve().then(x.fn).catch(() => {});
    }
  }
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Map the range dropdown to Yahoo range+interval. "Today (5-min)" is
// intraday; everything else is daily candles.
function rangeParams() {
  const v = $('range').value;
  if (v === '1d-intra') return 'range=1d&interval=5m';
  return 'range=' + v + '&interval=1d';
}

// Draw a candlestick chart from OHLC rows — pure SVG, no library.
function renderCandles(rows, rangeLabel, sym) {
  if (!rows || !rows.length) return '';
  const view = rows.slice(-120);
  const W = 600, H = 280, padL = 48, padR = 10, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let min = Infinity, max = -Infinity;
  for (const r of view) { if (r.low < min) min = r.low; if (r.high > max) max = r.high; }
  const raw = max - min || 1;
  min -= raw * 0.04; max += raw * 0.04;
  const yFor = (p) => padT + ((max - p) / (max - min)) * plotH;
  const step = plotW / view.length;
  const bodyW = Math.max(1, Math.min(14, step * 0.6));
  const dec = max >= 1000 ? 1 : 2;
  let s = '';
  for (let k = 0; k <= 4; k++) {
    const price = min + ((max - min) * k) / 4;
    const y = yFor(price).toFixed(1);
    s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>`;
    s += `<text x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="central" fill="var(--muted)" font-size="10">${price.toFixed(dec)}</text>`;
  }
  view.forEach((r, i) => {
    const cx = padL + (i + 0.5) * step;
    const col = r.close >= r.open ? 'var(--up)' : 'var(--down)';
    const yH = yFor(r.high), yL = yFor(r.low), yO = yFor(r.open), yC = yFor(r.close);
    const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yO - yC));
    s += `<line x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    s += `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`;
  });
  s += `<text x="${padL}" y="${H - 8}" text-anchor="start" fill="var(--muted)" font-size="10">${view[0].date}</text>`;
  s += `<text x="${W - padR}" y="${H - 8}" text-anchor="end" fill="var(--muted)" font-size="10">${view[view.length - 1].date}</text>`;
  const trunc = rows.length > view.length ? ` (last ${view.length})` : '';
  return (
    `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">${esc(sym)} · ${esc(rangeLabel)}${trunc} — ` +
    `<span style="color:var(--up)">■</span> up  <span style="color:var(--down)">■</span> down</div>` +
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Candlestick chart for ${esc(sym)}" style="display:block">${s}</svg>`
  );
}

// TradingView-style intraday chart: candles on top, volume strip below,
// price axis on the right, time axis (HH:MM) underneath. Pure SVG.
function renderIntradayChart(d) {
  const rows = d.rows || [];
  if (!rows.length) return '<div class="err">No intraday candles.</div>';
  const W = 700, H = 430, plotL = 8, plotR = W - 54;
  const plotW = plotR - plotL;
  const priceTop = 30, priceH = 250, volTop = 296, volH = 74;
  let min = Infinity, max = -Infinity, maxVolRaw = 0;
  const vols = [];
  for (const r of rows) {
    if (r.low < min) min = r.low;
    if (r.high > max) max = r.high;
    if (r.volume != null) { vols.push(r.volume); if (r.volume > maxVolRaw) maxVolRaw = r.volume; }
  }
  const rawSpan = max - min || 1;
  min -= rawSpan * 0.03; max += rawSpan * 0.03;
  // Robust volume scale: use the 98th percentile so a closing-auction
  // spike doesn't flatten every other bar (spikes just max out).
  const sorted = [...vols].sort((a, b) => a - b);
  const volScale = sorted.length ? sorted[Math.floor(sorted.length * 0.98)] || maxVolRaw : 1;
  const yP = (p) => priceTop + ((max - p) / (max - min)) * priceH;
  const step = plotW / rows.length;
  const bodyW = Math.max(1, Math.min(6, step * 0.7));
  const dec = max >= 1000 ? 1 : 2;
  let s = '';
  // price gridlines + right axis
  for (let k = 0; k <= 4; k++) {
    const price = min + ((max - min) * k) / 4;
    const y = yP(price).toFixed(1);
    s += `<line x1="${plotL}" y1="${y}" x2="${plotR}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>`;
    s += `<text x="${plotR + 6}" y="${y}" text-anchor="start" dominant-baseline="central" fill="var(--muted)" font-size="10">${price.toFixed(dec)}</text>`;
  }
  // candles + volume
  rows.forEach((r, i) => {
    const cx = plotL + (i + 0.5) * step;
    const col = r.close >= r.open ? 'var(--up)' : 'var(--down)';
    const yH = yP(r.high), yL = yP(r.low), yO = yP(r.open), yC = yP(r.close);
    s += `<line x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${col}" stroke-width="0.7"/>`;
    s += `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(0.8, Math.abs(yO - yC)).toFixed(1)}" fill="${col}"/>`;
    if (r.volume != null) {
      const vh = Math.min(volH, (r.volume / (volScale || 1)) * volH);
      s += `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${(volTop + volH - vh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity="0.5"/>`;
    }
  });
  // time axis: ~8 labels evenly across the session
  const nLabels = Math.min(8, rows.length);
  for (let j = 0; j < nLabels; j++) {
    const i = Math.round((j * (rows.length - 1)) / (nLabels - 1 || 1));
    const cx = plotL + (i + 0.5) * step;
    s += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${rows[i].hhmm}</text>`;
  }
  // header O/H/L/C for the day
  const o = rows[0].open, c = rows[rows.length - 1].close;
  const dayHi = Math.max(...rows.map((r) => r.high)), dayLo = Math.min(...rows.map((r) => r.low));
  const chg = c - o, pct = o ? (chg / o) * 100 : 0;
  const chgCol = chg >= 0 ? 'var(--up)' : 'var(--down)';
  const hdr =
    `<div style="font-size:12px;margin-bottom:6px"><span style="color:var(--ink)">${esc(d.symbol)}</span> ` +
    `<span style="color:var(--muted)">· ${esc(d.date)} · ${esc(d.interval)} · ${esc(d.exchange || '')} · ${d.count} candles</span><br>` +
    `<span style="color:var(--muted)">O</span> ${o.toFixed(dec)} <span style="color:var(--muted)">H</span> ${dayHi.toFixed(dec)} ` +
    `<span style="color:var(--muted)">L</span> ${dayLo.toFixed(dec)} <span style="color:var(--muted)">C</span> ${c.toFixed(dec)} ` +
    `<span style="color:${chgCol}">${chg >= 0 ? '+' : ''}${chg.toFixed(dec)} (${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></div>`;
  return hdr + `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Intraday candlestick chart for ${esc(d.symbol)} on ${esc(d.date)}" style="display:block">${s}</svg>`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
