// User-editable settings (dashboard → Settings), saved to paper-bot/settings.json
// and applied on top of config.mjs at startup. Only a validated subset is
// editable; everything else stays in code.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PAPER } from './config.mjs';
import { DEFAULT_COSTS } from './costs.mjs';
import { badRequest, parseSymbols } from '../util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PATH = process.env.SETTINGS_PATH || join(__dir, 'settings.json');

// key → [min, max] (numbers) — costs.* keys live under PAPER.costs
export const NUMERIC = {
  startingCapital: [1000, 1e8],
  riskPerTradePct: [0.1, 10],
  maxPositionPct: [1, 100],
  maxOpenPositions: [1, 20],
  minConfidence: [0.5, 0.95],
  'costs.brokerageIntradayCap': [0, 100],
  'costs.brokerageDeliveryPct': [0, 1],
  'costs.dpChargePerSell': [0, 50],
  'costs.slippagePct': [0, 1],
};

const DEFAULTS = JSON.parse(JSON.stringify({ ...PAPER, costs: { ...DEFAULT_COSTS, ...(PAPER.costs || {}) } }));

/** Current effective values of the editable settings. */
export function currentSettings() {
  const out = { symbols: [...PAPER.symbols] };
  const costs = { ...DEFAULT_COSTS, ...(PAPER.costs || {}) };
  for (const k of Object.keys(NUMERIC)) out[k] = k.startsWith('costs.') ? costs[k.slice(6)] : PAPER[k];
  return out;
}

/** Validate a partial settings object; returns the normalised patch. */
export function validate(patch = {}) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'symbols') {
      const list = parseSymbols(v).map((s) => s.toUpperCase());
      if (!list.length || list.length > 30) throw badRequest('Symbols: give 1–30 tickers.');
      out.symbols = list;
    } else if (NUMERIC[k]) {
      const n = Number(v);
      const [lo, hi] = NUMERIC[k];
      if (!Number.isFinite(n) || n < lo || n > hi) throw badRequest(`${k} must be between ${lo} and ${hi}.`);
      out[k] = k === 'maxOpenPositions' ? Math.round(n) : n;
    } else {
      throw badRequest(`Unknown setting "${k}".`);
    }
  }
  return out;
}

/** Apply a validated patch to the live PAPER config (all modules see it). */
function apply(patch) {
  PAPER.costs = { ...(PAPER.costs || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('costs.')) PAPER.costs[k.slice(6)] = v;
    else PAPER[k] = v;
  }
}

function loadSaved() {
  try {
    return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** Save + apply a patch (merged with what was saved before). */
export function saveSettings(patch) {
  const clean = validate(patch);
  const merged = { ...loadSaved(), ...clean };
  writeFileSync(PATH, JSON.stringify(merged, null, 2));
  apply(clean);
  return currentSettings();
}

/** Forget saved settings and go back to config.mjs defaults. */
export function resetSettings() {
  try {
    writeFileSync(PATH, '{}');
  } catch {
    /* ignore */
  }
  apply(Object.fromEntries(Object.keys(NUMERIC).map((k) => [k, k.startsWith('costs.') ? DEFAULTS.costs[k.slice(6)] : DEFAULTS[k]])));
  PAPER.symbols = [...DEFAULTS.symbols];
  return currentSettings();
}

// Apply saved settings once on import (server and CLI).
try {
  apply(validate(loadSaved()));
} catch {
  /* invalid saved file → keep defaults */
}
