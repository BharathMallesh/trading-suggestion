#!/usr/bin/env node
// Ling replay (library + CLI): does Ling's bounded adjustment make the
// Call / Put / Sideways probabilities more accurate? Answered now from history
// instead of waiting weeks for live predictions to be scored.
//
// - Samples N past moments (deterministic) across the replay universe, daily
//   bars, outcome = next session (same label rule as live scoring).
// - Ling sees the IDENTICAL prompt used live (lingAdjust), but ANONYMISED:
//   "STOCK", relative dates (D-7 … D0), prices rebased to 100 — so it can't
//   recall what actually happened next from its training data.
// - Paired comparison per sample: Brier(with Ling) − Brier(base). Verdict
//   rule fixed in advance: "helps" only if the mean difference is negative
//   with t ≤ −2; "hurts" if t ≥ 2; otherwise "inconclusive".
// - `--apply`: keep the adjustment on only if it helps (Settings → llmAdjust).
//
//   OPENROUTER_API_KEY=… node paper-bot/ling-replay.mjs --n 200 [--apply]
// Research only — not investment advice.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { candles } from '../market-data.mjs';
import { computeIndicators } from './indicators.mjs';
import { techScore, baseProbabilities, lingAdjust } from './groww-predict.mjs';
import { calibratedProbs, loadCalibration } from './calibration.mjs';
import { labelMove, brier } from './evaluate.mjs';
import { EVAL_UNIVERSE } from './config.mjs';
import { mapLimit } from '../util.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'ling-replay.json');

/** Rebase prices to 100 at the last bar and replace dates with D-n labels. */
export function anonymise(rows) {
  const k = 100 / rows[rows.length - 1].close;
  return rows.map((r, i) => ({
    date: `D-${rows.length - 1 - i}`,
    open: r.open * k,
    high: r.high * k,
    low: r.low * k,
    close: r.close * k,
    volume: r.volume,
  }));
}

/** Deterministic sample of (symbol, index) pairs. */
function sample(seriesList, n, seed = 42) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const s = seriesList[Math.floor(rnd() * seriesList.length)];
    const i = 120 + Math.floor(rnd() * (s.rows.length - 125)); // leave room for history + outcome
    if (!out.some((o) => o.s === s && Math.abs(o.i - i) < 5)) out.push({ s, i });
  }
  return out;
}

export async function lingReplay({ n = 200, symbols = EVAL_UNIVERSE, loadCandles = candles, adjust = lingAdjust, concurrency = 4 } = {}) {
  const loaded = await mapLimit(symbols, 4, async (sym) => {
    try {
      const rows = await loadCandles(sym, { range: '2y', interval: '1d' });
      return rows.length > 200 ? { sym, rows } : null;
    } catch {
      return null;
    }
  });
  const seriesList = loaded.filter(Boolean);
  const cal = loadCalibration();
  const picks = sample(seriesList, n);
  const results = await mapLimit(picks, concurrency, async ({ s, i }) => {
    const window = anonymise(s.rows.slice(i - 79, i + 1));
    const ind = computeIndicators(window.slice(-60));
    const score = techScore(ind);
    const base = calibratedProbs('1d', score, cal)?.probs ?? baseProbabilities(score);
    const horizons = [{ key: '1d', label: 'Primary daily', weight: 1, score, bars: window.length, base, rsi: ind.rsi14 }];
    const meta = { symbol: 'STOCK', intervalMinutes: 1440, source: 'history' };
    let pred;
    let err = null;
    try {
      const r = await adjust({ meta, rows: window, ind, base, score, horizons });
      pred = r.prediction;
      err = r.llmError;
    } catch (e) {
      err = e.message;
    }
    const close = s.rows[i].close;
    const next = s.rows[i + 1].close;
    const label = labelMove(((next - close) / close) * 100, computeIndicators(s.rows.slice(i - 59, i + 1)).atr14, close);
    const adjusted = pred && pred.adjustmentNote !== 'No LLM adjustment applied';
    return {
      symbol: s.sym,
      date: s.rows[i].date,
      label,
      base,
      final: pred ? { probUp: pred.probUp, probDown: pred.probDown, probSideways: pred.probSideways } : null,
      adjusted,
      error: err,
      brierBase: brier(base, label),
      brierFinal: pred ? brier(pred, label) : null,
    };
  });
  const ok = results.filter((r) => r.adjusted && r.brierFinal != null);
  const diffs = ok.map((r) => r.brierFinal - r.brierBase);
  const mean = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1);
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
  const t = diffs.length > 1 && sd > 0 ? mean / (sd / Math.sqrt(diffs.length)) : null;
  const verdict = t == null ? 'inconclusive' : t <= -2 ? 'helps' : t >= 2 ? 'hurts' : 'inconclusive';
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return {
    at: new Date().toISOString(),
    requested: n,
    sampled: results.length,
    adjusted: ok.length,
    failed: results.filter((r) => !r.adjusted).length,
    brierBase: avg(ok.map((r) => r.brierBase)),
    brierWithLing: avg(ok.map((r) => r.brierFinal)),
    meanDiff: mean,
    tStat: t,
    verdict,
    rule: 'helps only if mean Brier difference < 0 with t ≤ −2; hurts if t ≥ 2; else inconclusive',
    samples: results,
  };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const nIdx = args.indexOf('--n');
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 200;
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('Set OPENROUTER_API_KEY first (e.g. from the Keychain: export OPENROUTER_API_KEY="$(security find-generic-password -a "$USER" -s trading-research-openrouter -w)")');
    process.exit(1);
  }
  const t0 = Date.now();
  lingReplay({ n })
    .then(async (r) => {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(r, null, 2));
      console.log(`\nLING REPLAY · ${r.sampled} past moments (anonymised) · ${r.adjusted} adjusted by Ling · ${r.failed} without a usable reply · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      console.log(`Brier before Ling ${r.brierBase.toFixed(4)} · with Ling ${r.brierWithLing.toFixed(4)} · mean difference ${r.meanDiff >= 0 ? '+' : ''}${r.meanDiff.toFixed(4)} (t = ${r.tStat?.toFixed(2)})`);
      console.log(`Verdict: Ling's adjustment ${r.verdict.toUpperCase()} (${r.rule}).`);
      if (args.includes('--apply')) {
        const { saveSettings } = await import('./settings.mjs');
        saveSettings({ llmAdjust: r.verdict === 'helps' });
        console.log(`Applied: Settings → llmAdjust = ${r.verdict === 'helps'} (${r.verdict === 'helps' ? 'kept on' : 'switched off — base probabilities used; Ling still writes news briefs'}).`);
      }
      console.log(`Saved ${OUT}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
