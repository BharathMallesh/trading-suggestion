// Tests for the bonus/split run-up paper account (loop 13): event planning (late listing, board-meeting check),
// traded-value ranks, and a full walk — bought at the open before the ex-date, sold at the close the day before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const br = await import('./paper-bot/bonus-runup.mjs');
const { tradingDaysBetween } = await import('./paper-bot/market-calendar.mjs');

const days = tradingDaysBetween('2026-09-01', '2026-12-31');
const ex = days[days.indexOf('2026-11-02') + 20];

test('bonus/split subjects are recognised; dividends are not', () => {
  assert.ok(br.isBonusSplit('Bonus 1:1'));
  assert.ok(br.isBonusSplit('Face Value Split (Sub-Division) - From Rs 5/- Per Share To Rs 2/- Per Share'));
  assert.ok(!br.isBonusSplit('Interim Dividend - Rs 5 Per Share'));
});

test('planEvent: 10 sessions before ex when known early, later ("late") when listed late, skipped when too late or no meeting', () => {
  const bm = ['2026-10-01'];
  const p = br.planEvent({ ex, firstSeen: '2026-11-02', bmDates: bm, days });
  assert.equal(p.entryDate, days[days.indexOf(ex) - 10]);
  assert.equal(p.exitDate, days[days.indexOf(ex) - 1]);
  assert.equal(p.sessions, 10);
  assert.equal(p.late, false);
  const seen = days[days.indexOf(ex) - 6];
  const q = br.planEvent({ ex, firstSeen: seen, bmDates: bm, days });
  assert.equal(q.entryDate, days[days.indexOf(ex) - 5], 'next session after it was first seen');
  assert.equal(q.late, true);
  assert.match(br.planEvent({ ex, firstSeen: days[days.indexOf(ex) - 3], bmDates: bm, days }).skip, /too late/);
  assert.match(br.planEvent({ ex, firstSeen: '2026-11-02', bmDates: [], days }).skip, /board meeting/);
  assert.match(br.planEvent({ ex, firstSeen: '2026-11-02', bmDates: [days[days.indexOf(ex) - 11]], days }).skip, /board meeting/, 'meeting must be ≥ 3 sessions before entry');
});

test('valueRanks: by median traded value', () => {
  const m = new Map();
  for (let i = 0; i < 12; i++) m.set(`d${i}`, new Map([['A', { val: 10 }], ['B', { val: 100 }]]));
  const r = br.valueRanks(m);
  assert.equal(r.get('B'), 1);
  assert.equal(r.get('A'), 2);
});

test('paper walk: plans from the NSE list, buys at the open 10 sessions before ex, sells at the close the day before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-'));
  const paper = join(dir, 'paper.json');
  const env = { ...process.env };
  process.env.BHAV_EQ_DIR = dir;
  process.env.BONUS_RUNUP_PAPER_PATH = paper;
  try {
    const all = days.filter((d) => d >= '2026-10-01' && d < ex);
    const writeBhav = (upto) => {
      const months = {};
      for (const d of all.filter((x) => x <= upto)) {
        const k = all.indexOf(d);
        (months[d.slice(0, 7)] ||= {})[d] = [['XYZ', 100 + k, 0, 0, 101 + k, 0, 5e7], ['BIG', 50, 0, 0, 50, 0, 9e9]];
      }
      for (const [ym, m] of Object.entries(months)) writeFileSync(join(dir, `${ym}.json.gz`), gzipSync(JSON.stringify(m)));
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ tracked: ['XYZ', 'BIG'], done: [], lastDate: upto }));
    };
    const fetchFn = async () => ({ actions: [{ symbol: 'XYZ', ex, subject: 'Bonus 1:1' }, { symbol: 'NOPE', ex, subject: 'Bonus 1:1' }], meetings: [{ symbol: 'XYZ', date: '2026-10-01' }] });
    writeBhav('2026-11-02');
    const s1 = await br.bonusRunupPaperUpdate({ now: new Date('2026-11-02T14:00:00Z'), fetchFn });
    assert.equal(s1.upcoming.length, 1);
    assert.equal(s1.upcoming[0].symbol, 'XYZ');
    assert.ok(s1.recentSkips.some((x) => x.symbol === 'NOPE'), 'untracked stock skipped');
    writeBhav(all.at(-1));
    const s2 = await br.bonusRunupPaperUpdate({ now: new Date(`${ex}T14:00:00Z`), fetchFn });
    assert.equal(s2.closed.length, 1);
    const t = s2.closed[0];
    const ei = all.indexOf(days[days.indexOf(ex) - 10]);
    assert.equal(t.entryDate, all[ei]);
    assert.equal(t.entry, 100 + ei, 'bought at the open');
    assert.equal(t.exitDate, all.at(-1));
    assert.equal(t.exit, 101 + all.length - 1, 'sold at the close the day before ex');
    assert.ok(t.pnl > 0);
    assert.equal(s2.open.length, 0);
    assert.ok(s2.value > 500000);
  } finally {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
