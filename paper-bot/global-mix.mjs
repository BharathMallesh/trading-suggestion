#!/usr/bin/env node
// Global mix (library + CLI) — PAPER ONLY: ⅓ Momentum 10 stocks / ⅓ Nasdaq-100 (MON100 ETF on NSE) / ⅓ gold
// (GOLDBEES), put back to ⅓ each at a month-end only when a part has drifted 5+ points (same engine and band as
// India mix). From the Nov 2026 loop-11 study: 2010–22 17.0%/yr after tax, worst daily fall 23.4% vs India mix
// 14.7% / 26.4% — the nearest miss, NOT a pass (t vs NIFTY 1.0; most of its edge was Nasdaq's 2010–21 run in
// rupees), so it is tracked on paper from the 30 Nov 2026 month-end to see how it does live.
// US shares in rupees helped in India-only and rupee crises (2011, 2013) but not in global ones (2008, 2022).
// Caution: MON100 has traded well above its fair value at times (10–24% in 2017–18; up to 11% in 2022 when
// overseas-fund limits stopped new units) — buying at a premium can lose money even if Nasdaq rises.
// Taxed as a non-equity fund (US ETF), unlike Indian equity ETFs. Not advice.
//
//   node paper-bot/global-mix.mjs --paper

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { indiaMixPaperUpdate, MIX } from './india-mix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = () => process.env.GLOBAL_MIX_PAPER_PATH || join(HERE, 'data', 'global-mix-paper.json');

export const GLOBAL_PARTS = {
  label: 'Global mix', path: () => PAPER(),
  funds: [
    { key: 'nasdaq', symbol: 'MON100.NS', name: 'Nasdaq-100 (MON100)', kind: 'fund', w: 1 / 3 },
    { key: 'gold', symbol: MIX.goldSymbol, name: 'Gold (GOLDBEES)', kind: 'gold', w: 1 / 3 },
  ],
  stocks: 1 / 3, bandPts: 5,
};
export const RESEARCH = {
  period: '2010–2022 (₹10 lakh, after tax, cashed out; worst fall on daily values)',
  rows: [
    { label: 'Global mix (⅓ Momentum 10 · ⅓ Nasdaq-100 · ⅓ gold)', cagr: 0.170, dd: 0.234 },
    { label: 'India mix (5-point band)', cagr: 0.147, dd: 0.264 },
    { label: 'Momentum 10', cagr: 0.202, dd: 0.384 },
    { label: 'NIFTY', cagr: 0.112, dd: 0.383 },
  ],
  crises: [
    { when: '2011', nifty: -0.24, nasdaq: 0.20, mix: 0.119, india: -0.074 },
    { when: '2013 rupee crash (May–Aug)', nifty: -0.11, nasdaq: 0.30, mix: null, india: -0.059 },
    { when: 'Covid crash (Jan–Mar 2020)', nifty: -0.37, nasdaq: -0.15, mix: -0.146, india: -0.215 },
    { when: '2022', nifty: 0.055, nasdaq: -0.26, mix: -0.083, india: 0.012 },
  ],
  verdict: 'nearest miss, not a pass: beat India mix by 2.3 points a year with a smaller fall, but not statistically reliable (t 1.0) and weaker with a smaller Nasdaq share',
};
export const loadGlobalMixPaper = () => {
  try {
    return JSON.parse(readFileSync(PAPER(), 'utf8'));
  } catch {
    return null;
  }
};
export const globalMixPaperUpdate = (opts = {}) => indiaMixPaperUpdate({ ...opts, cfg: GLOBAL_PARTS });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const st = await globalMixPaperUpdate();
    console.log(`Global mix paper: since ${st.startedAt} · ${st.rebalances.length} re-balance(s) · value ₹${Math.round(st.curve.at(-1)?.value ?? st.capital).toLocaleString('en-IN')}${st.rebalances.length ? '' : ' · first buy after the next month-end'}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
