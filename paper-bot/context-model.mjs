// Multinomial logistic regression (UP / DOWN / SIDEWAYS) over the context
// features. Small, transparent, and calibrated by construction (it minimises
// log loss), so its probabilities are directly comparable with the
// score-bucket calibration. Pure JS, no dependencies.
// Research only — not investment advice.

const CLASSES = ['UP', 'DOWN', 'SIDEWAYS'];

/** Column means / stds over training rows (std floor avoids divide-by-zero). */
export function standardizer(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}

const scale = (x, { mean, std }) => x.map((v, j) => Math.max(-5, Math.min(5, (v - mean[j]) / std[j])));

function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/**
 * Fit weights by full-batch gradient descent on L2-regularised log loss.
 * @param {number[][]} X  raw feature rows
 * @param {('UP'|'DOWN'|'SIDEWAYS')[]} labels
 * @returns {{ mean:number[], std:number[], W:number[][] }}  W[c] = [bias, w1..wd]
 */
export function fitLogistic(X, labels, { lambda = 1e-3, iters = 400, lr = 0.5 } = {}) {
  const st = standardizer(X);
  const Z = X.map((x) => scale(x, st));
  const y = labels.map((l) => CLASSES.indexOf(l));
  const n = Z.length;
  const d = Z[0].length;
  const W = CLASSES.map(() => new Array(d + 1).fill(0));
  for (let it = 0; it < iters; it++) {
    const G = CLASSES.map(() => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      const p = softmax(W.map((w) => w[0] + z.reduce((a, v, j) => a + v * w[j + 1], 0)));
      for (let c = 0; c < 3; c++) {
        const g = p[c] - (y[i] === c ? 1 : 0);
        G[c][0] += g / n;
        for (let j = 0; j < d; j++) G[c][j + 1] += (g * z[j]) / n;
      }
    }
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j <= d; j++) W[c][j] -= lr * (G[c][j] + (j ? lambda * W[c][j] : 0));
    }
  }
  return { mean: st.mean, std: st.std, W };
}

/** Probabilities for one raw feature row. */
export function predictLogistic(model, x) {
  const z = scale(x, model);
  const p = softmax(model.W.map((w) => w[0] + z.reduce((a, v, j) => a + v * w[j + 1], 0)));
  return { probUp: p[0], probDown: p[1], probSideways: p[2] };
}

/** Feature object → ordered row for a given feature list. */
export const toRow = (f, names) => names.map((n) => Number(f[n]) || 0);

/** Sideways chance from `ctx`, up/down split from `dir` (for context that predicts volatility, not direction). */
export function moveOnly(ctx, dir) {
  const move = 1 - ctx.probSideways;
  const ud = dir.probUp + dir.probDown;
  const up = ud > 0 ? dir.probUp / ud : 0.5;
  return { probUp: move * up, probDown: move * (1 - up), probSideways: ctx.probSideways };
}
