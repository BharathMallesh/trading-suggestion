// Tests for storage: compressed intraday store (with old plain files still readable),
// weekly price-history backup, slimmer daily backup, and the storage health check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r25-'));
process.env.CANDLE_STORE = join(TMP, 'store');
process.env.BACKUP_DIR = join(TMP, 'backups');
process.env.BACKUP_MIRROR = '';
after(() => rmSync(TMP, { recursive: true, force: true }));

test('intraday store: written compressed, old plain files read and converted', async () => {
  const c = await import('./paper-bot/collector.mjs');
  const dir = join(TMP, 'store', '5m');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'OLD.NS.json'), JSON.stringify([{ ts: 1, date: '2026-10-01 09:15', close: 5 }]));
  assert.equal(c.readStore('OLD.NS', '5m').length, 1, 'plain file still readable');
  assert.equal(c.compressStore(), 1);
  assert.ok(existsSync(join(dir, 'OLD.NS.json.gz')) && !existsSync(join(dir, 'OLD.NS.json')));
  assert.equal(c.readStore('OLD.NS', '5m')[0].close, 5);
  await c.collect({ symbols: ['NEW.NS'], intervals: ['5m'], loadCandles: async () => [{ ts: 0, date: '2026-10-02 09:15', close: 7 }], now: 2_000_000_000_000 });
  assert.ok(readdirSync(dir).includes('NEW.NS.json.gz'));
  assert.deepEqual(c.storeStatus().map((x) => x.symbol).sort(), ['NEW.NS', 'OLD.NS']);
});

test('backup: price history weekly in its own archive; daily skips it and the PIN file', async () => {
  const b = await import('./paper-bot/backup.mjs');
  const root = join(TMP, 'app');
  mkdirSync(join(root, 'paper-bot', 'data', 'candles', '5m'), { recursive: true });
  writeFileSync(join(root, 'paper-bot', 'settings.json'), '{}');
  writeFileSync(join(root, 'paper-bot', 'data', 'journal.json'), '{"trades":[]}');
  writeFileSync(join(root, 'paper-bot', 'data', 'lan.json'), '{"hash":"x"}');
  writeFileSync(join(root, 'paper-bot', 'data', 'candles', '5m', 'A.json.gz'), 'gz');
  const s = await b.backup({ root, now: new Date('2026-10-14T13:00:00Z') });
  assert.ok(s.weekly && /candles-2026-W42\.tar\.gz$/.test(s.weekly.file));
  const { execFileSync } = await import('node:child_process');
  const daily = execFileSync('tar', ['-tzf', s.file], { encoding: 'utf8' });
  assert.match(daily, /journal\.json/);
  assert.doesNotMatch(daily, /candles/);
  assert.doesNotMatch(daily, /lan\.json/);
  assert.match(execFileSync('tar', ['-tzf', s.weekly.file], { encoding: 'utf8' }), /candles\/5m\/A\.json\.gz/);
  const again = await b.backup({ root, now: new Date('2026-10-15T13:00:00Z') });
  assert.equal(again.weekly.skipped, true, 'one price-history archive a week');
  assert.equal(b.listWeekly().length, 1);
  assert.equal(b.isoWeekLabel('2027-01-03'), '2026-W53');
});

test('storage health check: ok under the limit, warning over it', async () => {
  const h = await import('./paper-bot/health.mjs');
  const base = { quoteFn: async () => ({ price: 1 }), newsProbe: async () => 1, diskFn: () => 50e9 };
  const ok = await h.healthChecks({ ...base, sizesFn: () => ({ data: 1e8, candles: 2e7, bhav: 6e7, backups: 1e7 }) });
  assert.equal(ok.checks.find((c) => c.name === 'storage').level, 'ok');
  const big = await h.healthChecks({ ...base, sizesFn: () => ({ data: 3e9, candles: 2e9, bhav: 6e8, backups: 1e7 }) });
  assert.equal(big.checks.find((c) => c.name === 'storage').level, 'warn');
  assert.ok(h.dirBytes(join(TMP, 'store')) > 0);
});

test('corporate actions: unadjusted bonus / split jumps are undone, real crashes are not', async () => {
  const bh = await import('./paper-bot/bhav-history.mjs');
  // Reliance-style 1:1 bonus in an old file: price halves, PREVCLOSE not adjusted
  const bonus = [{ date: 'd1', open: 1640, high: 1650, low: 1630, close: 1645, prev: 1632, val: 1 }, { date: 'd2', open: 820, high: 825, low: 812, close: 818, prev: 1645, val: 1 }];
  assert.ok(Math.abs(bh.actionFactor(bonus[0], bonus[1]) - 0.5) < 1e-12);
  const adj = bh.adjust(bonus);
  assert.ok(Math.abs(adj[0].close - 822.5) < 1e-9, 'earlier price halved');
  // newer files: NSE adjusts PREVCLOSE itself
  assert.ok(Math.abs(bh.actionFactor({ close: 1000 }, { open: 200, close: 201, prev: 200 }) - 0.2) < 1e-12);
  // a genuine 30% crash (not near a standard ratio) stays a crash
  assert.equal(bh.actionFactor({ close: 100 }, { open: 72, close: 70, prev: 100 }), 1);
  // an ordinary day
  assert.equal(bh.actionFactor({ close: 100 }, { open: 101, close: 99, prev: 100 }), 1);
});
