// Reliability / data-safety tests: atomic JSON, 413 delivery, backup verification, cache cap. All offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, readJsonSafe, withFileLock } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'trading-rel-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

test('writeJsonAtomic round-trips and leaves no temp files', () => {
  const p = join(TMP, 'a', 'b.json');
  writeJsonAtomic(p, { x: 1 });
  writeJsonAtomic(p, { x: 2 });
  assert.deepEqual(readJsonSafe(p, null), { x: 2 });
  assert.deepEqual(readdirSync(dirname(p)), ['b.json']);
});

test('readJsonSafe: fallback only when missing; corrupt is quarantined and throws', () => {
  assert.deepEqual(readJsonSafe(join(TMP, 'nope.json'), { d: 1 }), { d: 1 });
  const p = join(TMP, 'bad.json');
  writeFileSync(p, '{"half":');
  assert.throws(() => readJsonSafe(p, {}), /Corrupt JSON/);
  assert.equal(existsSync(p), false);
  assert.ok(readdirSync(TMP).some((f) => f.startsWith('bad.json.corrupt-')));
});

test('withFileLock serializes work per key', async () => {
  const order = [];
  const job = (n, ms) => withFileLock('k', async () => { order.push(`s${n}`); await new Promise((r) => setTimeout(r, ms)); order.push(`e${n}`); });
  await Promise.all([job(1, 30), job(2, 1)]);
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2']);
});

test('oversized body gets a 413 JSON response (not a reset socket)', async () => {
  const PORT = 4000 + Math.floor(Math.random() * 900);
  const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), AUTO_EVALUATE: '0', SETTINGS_PATH: join(TMP, 'settings.json'), PORTFOLIO_PATH: join(TMP, 'portfolio.json'), PREDICTION_LOG_PATH: join(TMP, 'pl.json') },
    stdio: 'pipe',
  });
  after(() => server.kill());
  await new Promise((resolve) => server.stdout.once('data', resolve));
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/settings', method: 'POST', headers: { host: `localhost:${PORT}`, 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end('{"a":"' + 'x'.repeat(2_000_000) + '"}');
  });
  assert.equal(r.status, 413);
  assert.match(JSON.parse(r.body).error, /too large/i);
});

function fakeRoot() {
  const root = join(TMP, 'root-' + Math.random().toString(36).slice(2));
  mkdirSync(join(root, 'paper-bot', 'data', 'fo-bhav'), { recursive: true });
  writeFileSync(join(root, 'paper-bot', 'prediction-history.json'), '{"entries":[]}');
  writeFileSync(join(root, 'paper-bot', 'data', 'replay.json'), '{"r":1}');
  writeFileSync(join(root, 'paper-bot', 'data', 'news-daily.json'), '{}');
  writeFileSync(join(root, 'paper-bot', 'data', 'fo-bhav', 'x.json'), '{}');
  return root;
}

test('backup includes data results, excludes caches, and refuses corrupt JSON without touching today\'s archive', async () => {
  const { execFileSync } = await import('node:child_process');
  process.env.BACKUP_DIR = join(TMP, 'bk');
  process.env.BACKUP_MIRROR = '';
  const { backup, backupStatus } = await import('./paper-bot/backup.mjs');
  const root = fakeRoot();
  const now = new Date('2026-01-05T06:00:00Z');
  const ok = await backup({ root, now });
  const names = execFileSync('tar', ['-tzf', ok.file]).toString();
  assert.match(names, /paper-bot\/data\/replay\.json/);
  assert.doesNotMatch(names, /news-daily|fo-bhav/);
  const before = readFileSync(ok.file);

  writeFileSync(join(root, 'paper-bot', 'data', 'replay.json'), '{"r":');
  await assert.rejects(backup({ root, now }), /Corrupt JSON/);
  assert.deepEqual(readFileSync(ok.file), before);
  assert.match(backupStatus().error.message, /replay\.json/);
  assert.equal(readdirSync(process.env.BACKUP_DIR).some((f) => f.includes('.tmp-')), false);
});

test('market-data cache is capped', async () => {
  const { candles, clearMarketCache, marketCacheSize, CACHE_MAX_ENTRIES } = await import('./market-data.mjs');
  clearMarketCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ chart: { result: [{ timestamp: [], indicators: { quote: [{}] }, meta: {} }] } }) });
  try {
    for (let i = 0; i < CACHE_MAX_ENTRIES + 20; i++) await candles(`S${i}.NS`, { range: '5d', interval: '1d' }).catch(() => {});
    assert.ok(marketCacheSize() <= CACHE_MAX_ENTRIES);
    assert.ok(marketCacheSize() > 0);
  } finally {
    globalThis.fetch = realFetch;
    clearMarketCache();
  }
});
