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
