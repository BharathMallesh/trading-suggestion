// Tests for the Day patterns study helpers (weekday grouping, gap kinds, verdicts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const d = await import('./paper-bot/day-patterns.mjs');

test('weekday, gap kind and stats', () => {
  assert.equal(d.weekdayOf('2026-10-26'), 'Mon');
  assert.equal(d.weekdayOf('2026-10-23 09:40'), 'Fri');
  assert.equal(d.gapKind(0.5), 'gap up');
  assert.equal(d.gapKind(-0.31), 'gap down');
  assert.equal(d.gapKind(0.1), 'flat open');
  assert.equal(d.gapKind(null), null);
  const s = d.stats([1, -1, 2, 2]);
  assert.equal(s.n, 4);
  assert.equal(s.win, 0.75);
  assert.equal(s.avg, 1);
  assert.deepEqual(d.stats([]), { n: 0 });
  const g = d.groupBy([{ day: 'Mon', v: 1 }, { day: 'Mon', v: 3 }, { day: 'Tue', v: -1 }], (t) => t.day, (t) => t.v);
  assert.equal(g.Mon.avg, 2);
  assert.equal(g.Tue.n, 1);
});

test('verdict: best / worst day, enough trades, consistent only if both halves agree', () => {
  const mk = (vals, n = 50) => Object.fromEntries(d.WEEKDAYS.map((w, i) => [w, { n, avg: vals[i] }]));
  const all = mk([-0.1, 0.2, 0.2, 0.4, 0.0]);
  const v = d.verdictFor(all, { early: mk([0.0, 0.5, 0.1, 0.6, 0.05], 30), late: mk([-0.1, 0.0, 0.3, 0.3, -0.01], 30) });
  assert.equal(v.best, 'Thu');
  assert.equal(v.worst, 'Mon');
  assert.equal(v.consistent, true);
  const flip = d.verdictFor(all, { early: mk([0.6, 0.1, 0.1, 0.0, 0.05], 30), late: mk([-0.1, 0.0, 0.3, 0.3, -0.01], 30) });
  assert.equal(flip.consistent, false, 'Monday best in one half → not consistent');
  const small = d.verdictFor(mk([1, 2, 3, 4, 5], 10));
  assert.equal(small.enough, false);
  assert.equal(small.consistent, false);
});
