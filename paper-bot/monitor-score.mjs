// Scorecard over scored predictions (shared by the monitor and the weekly
// scorecard; kept separate to avoid a circular import).
import { dedupeDaily } from './prediction-log.mjs';

const KEYS = { UP: 'probUp', DOWN: 'probDown', SIDEWAYS: 'probSideways' };
const brier = (p, l) => ['UP', 'DOWN', 'SIDEWAYS'].reduce((a, k) => a + ((Number(p?.[KEYS[k]]) || 0) - (k === l ? 1 : 0)) ** 2, 0);

/** Scorecard over every scored prediction in the log. */
export function scorecard(entries) {
  // One prediction per stock per day (see prediction-log dedupeDaily).
  const ev = dedupeDaily(entries.filter((e) => e.evaluated && e.realizedLabel));
  if (!ev.length) return { scored: 0 };
  const avg = (f) => ev.reduce((a, e) => a + f(e), 0) / ev.length;
  const freq = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  for (const e of ev) freq[e.realizedLabel]++;
  const base = { probUp: freq.UP / ev.length, probDown: freq.DOWN / ev.length, probSideways: freq.SIDEWAYS / ev.length };
  const out = {
    scored: ev.length,
    outcomes: freq,
    hitRatePct: (ev.filter((e) => e.hitBias).length / ev.length) * 100,
    brier: {
      app: avg((e) => brier(e, e.realizedLabel)),
      beforeLing: ev.every((e) => e.base) ? avg((e) => brier(e.base, e.realizedLabel)) : null,
      uniform: avg((e) => brier({ probUp: 1 / 3, probDown: 1 / 3, probSideways: 1 / 3 }, e.realizedLabel)),
      // hindsight base rates of the scored set — a tough, slightly unfair benchmark
      hindsightBaseRates: avg((e) => brier(base, e.realizedLabel)),
    },
  };
  out.verdict =
    out.scored < 30
      ? `Too early: ${out.scored} scored predictions (need ~30+ before reading much into it).`
      : out.brier.app < out.brier.uniform
        ? out.brier.app < out.brier.hindsightBaseRates
          ? 'App beats both a coin-flip and hindsight base rates — promising, keep watching.'
          : 'App beats a coin-flip but not hindsight base rates — honest, no clear edge.'
        : 'App is worse than a coin-flip — probabilities are not helping.';
  return out;
}
