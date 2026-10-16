// Tests for the daily watchdog (paper-bot/watchdog.mjs): healthy day, missing collect,
// stale paper record, weekends / holidays / before 16:05 (no false alarms), server down,
// notification only on failure. Everything runs in a temp dir via env overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'watchdog-'));
const LOGS = join(TMP, 'logs');
const STORE = join(TMP, 'candles');
Object.assign(process.env, {
  WATCHDOG_PATH: join(TMP, 'watchdog.json'),
  TRADING_LOG_DIR: LOGS,
  CANDLE_STORE: STORE,
  VWAP_PAPER_PATH: join(TMP, 'vwap-paper.json'),
  ATH_PAPER_PATH: join(TMP, 'ath-paper.json'),
  BREAKFAST_PAPER_PATH: join(TMP, 'breakfast-paper.json'),
  NIFTY_DIP_PAPER_PATH: join(TMP, 'nifty-dip-paper.json'),
  BACKUP_DIR: join(TMP, 'backups'),
  NSE_HOLIDAYS_PATH: join(TMP, 'no-holidays-file.json'), // built-in 2026 list only
  WATCHDOG_SERVER_URL: 'http://127.0.0.1:1/',
});
const wd = await import('./paper-bot/watchdog.mjs');

const PAPERS = ['vwap-paper.json', 'ath-paper.json', 'breakfast-paper.json', 'nifty-dip-paper.json'];
const LABELS = wd.LABELS.map((l, i) => `${i}\t0\t${l}`).join('\n');
const okFetch = async () => ({ status: 200 });

/** A healthy evening run on `date` (YYYY-MM-DD): log, NIFTY bars, paper records, refit 6 days before. */
function healthyRun(date, { legacy = false } = {}) {
  rmSync(LOGS, { recursive: true, force: true });
  rmSync(STORE, { recursive: true, force: true });
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(join(STORE, '5m'), { recursive: true });
  writeFileSync(join(LOGS, 'collect.log'), `2026-10-01 16:05:01 collect\nCollected 404 series · +100 new bars · 0 failed\n${date} 16:05:04 collect\nCollected 404 series · +19578 new bars · 0 failed\nStore: 404 series\n  OK   collect ran: earlier watchdog output\n`);
  const refit = new Date(Date.parse(`${date}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  writeFileSync(join(LOGS, 'refit.log'), `${refit} 10:14:43 refit\nsome output\n`);
  const bars = JSON.stringify([{ date: '2026-10-01 09:15', close: 1 }, { date: `${date} 09:15`, close: 2 }, { date: `${date} 15:25`, close: 3 }]);
  if (legacy) writeFileSync(join(STORE, '5m', '^NSEI.json'), bars);
  else writeFileSync(join(STORE, '5m', '^NSEI.json.gz'), gzipSync(bars));
  for (const f of PAPERS) writeFileSync(join(TMP, f), JSON.stringify({ startedAt: '2026-10-10', trades: [], updatedAt: `${date}T10:36:00.000Z` }));
}
const opts = (now, extra = {}) => ({
  now: new Date(now),
  fetchFn: okFetch,
  listFn: async () => LABELS,
  sizesFn: () => ({ data: 176e6, backups: 27e6 }),
  backupFn: () => ({ at: new Date(new Date(now).getTime() - 20 * 3600000).toISOString(), bytes: 4e5, files: 61 }),
  ...extra,
});
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test('healthy trading day after 16:05: every check passes, saved with { at, date, ok, checks }', async () => {
  healthyRun('2026-10-16');
  const r = await wd.runWatchdog(opts('2026-10-16T11:30:00Z', { notifyFn: () => assert.fail('no notification on a healthy day') , notify: true }));
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.date, '2026-10-16');
  assert.equal(r.session, '2026-10-16');
  assert.equal(r.checks.length, 11);
  for (const c of r.checks) assert.ok(c.name && typeof c.detail === 'string' && c.fix === '');
  const saved = JSON.parse(readFileSync(process.env.WATCHDOG_PATH, 'utf8'));
  assert.deepEqual(Object.keys(saved).filter((k) => ['at', 'date', 'ok', 'checks'].includes(k)).sort(), ['at', 'checks', 'date', 'ok']);
  assert.equal(wd.watchdogFresh(saved, new Date('2026-10-16T12:00:00Z')), true);
  assert.equal(wd.watchdogFresh(saved, new Date('2026-10-19T11:30:00Z')), false, 'Monday after 16:05: about an older run');
});

test('legacy plain .json store is read too', async () => {
  healthyRun('2026-10-16', { legacy: true });
  const r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'));
  assert.equal(r.checks.find((c) => c.name === '5-minute prices saved').ok, true);
});

test('missing collect run: collect and price checks fail with a fix hint', async () => {
  healthyRun('2026-10-15'); // only Thursday ran; it is Friday evening
  const r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'));
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name === 'collect ran');
  assert.equal(c.ok, false);
  assert.match(c.detail, /no collect run logged for 2026-10-16/);
  assert.match(c.fix, /scripts\/run\.sh collect/);
  assert.ok(failed(r).includes('5-minute prices saved'));
  assert.ok(failed(r).includes('paper record: Breakfast'));
});

test('collect logged an Error: line, or some series failed → collect check fails', async () => {
  healthyRun('2026-10-16');
  writeFileSync(join(LOGS, 'collect.log'), '2026-10-16 16:05:04 collect\nError: Yahoo is rate-limiting\n');
  let r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'));
  assert.match(r.checks.find((x) => x.name === 'collect ran').detail, /Error: Yahoo/);
  writeFileSync(join(LOGS, 'collect.log'), '2026-10-16 16:05:04 collect\nCollected 404 series · +10 new bars · 3 failed\n');
  r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'));
  const c = r.checks.find((x) => x.name === 'collect ran');
  assert.equal(c.ok, false);
  assert.match(c.detail, /3 failed/);
});

test('stale paper record: only that record fails', async () => {
  healthyRun('2026-10-16');
  writeFileSync(join(TMP, 'breakfast-paper.json'), JSON.stringify({ trades: [], updatedAt: '2026-10-15T10:36:00.000Z' }));
  const r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'));
  assert.deepEqual(failed(r), ['paper record: Breakfast']);
  const c = r.checks.find((x) => x.name === 'paper record: Breakfast');
  assert.match(c.detail, /last updated 2026-10-15, expected 2026-10-16/);
  assert.match(c.fix, /breakfast\.mjs --paper/);
  rmSync(join(TMP, 'nifty-dip-paper.json'));
  assert.ok(failed(await wd.watchdogChecks(opts('2026-10-16T11:30:00Z'))).includes('paper record: NIFTY dip-buy'));
});

test('weekend, NSE holiday and before 16:05: no false alarms (the last trading day is checked)', async () => {
  healthyRun('2026-10-16'); // Friday's run
  for (const now of ['2026-10-17T06:00:00Z', '2026-10-18T15:00:00Z', '2026-10-19T09:00:00Z']) { // Sat, Sun, Mon 14:30 IST
    if (now === '2026-10-18T15:00:00Z') writeFileSync(join(LOGS, 'refit.log'), '2026-10-10 10:14:43 refit\n2026-10-17 10:00:02 refit\n'); // Saturday's refit ran
    const r = await wd.watchdogChecks(opts(now));
    assert.deepEqual(failed(r), [], now);
    assert.equal(r.session, '2026-10-16', now);
  }
  const before = await wd.watchdogChecks(opts('2026-10-19T09:00:00Z'));
  assert.match(before.note, /not due until 16:05/);
  // Tue 20 Oct 2026 is Dussehra (NSE holiday): Monday's run is what counts
  healthyRun('2026-10-19');
  const hol = await wd.watchdogChecks(opts('2026-10-20T12:00:00Z'));
  assert.deepEqual(failed(hol), []);
  assert.equal(hol.session, '2026-10-19');
  assert.match(hol.note, /not a trading day/);
  // …but Wednesday evening with no Wednesday run is a real failure
  assert.ok(failed(await wd.watchdogChecks(opts('2026-10-21T11:30:00Z'))).includes('collect ran'));
});

test('server down (injected fetch rejects) → server check fails with a restart hint', async () => {
  healthyRun('2026-10-16');
  const r = await wd.watchdogChecks(opts('2026-10-16T11:30:00Z', { fetchFn: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }));
  assert.deepEqual(failed(r), ['dashboard server']);
  const c = r.checks.find((x) => x.name === 'dashboard server');
  assert.match(c.detail, /ECONNREFUSED/);
  assert.match(c.fix, /launchctl kickstart/);
});

test('backup too old / failed, storage too big, refit stale, launchd job missing', async () => {
  healthyRun('2026-10-16');
  const now = '2026-10-16T11:30:00Z';
  let r = await wd.watchdogChecks(opts(now, { backupFn: () => ({ at: '2026-10-13T13:15:00Z', bytes: 4e5 }) }));
  assert.deepEqual(failed(r), ['backup']);
  r = await wd.watchdogChecks(opts(now, { backupFn: () => ({ at: '2026-10-15T13:15:00Z', bytes: 4e5, error: { at: '2026-10-16T13:15:00Z', message: 'Corrupt JSON' } }) }));
  assert.match(r.checks.find((x) => x.name === 'backup').detail, /FAILED/);
  r = await wd.watchdogChecks(opts(now, { backupFn: () => null }));
  assert.deepEqual(failed(r), ['backup']);
  r = await wd.watchdogChecks(opts(now, { sizesFn: () => ({ data: 3e9, backups: 1e8 }) }));
  assert.deepEqual(failed(r), ['storage']);
  r = await wd.watchdogChecks(opts('2026-10-19T11:30:00Z')); // Monday: refit 2026-10-10 is 9 days old (Friday's run missing too)
  assert.ok(failed(r).includes('weekly refit'));
  r = await wd.watchdogChecks(opts(now, { listFn: async () => LABELS.split('\n').filter((l) => !l.endsWith('.backup')).join('\n') }));
  assert.deepEqual(failed(r), ['background jobs']);
  assert.match(r.checks.find((x) => x.name === 'background jobs').detail, /not loaded: backup/);
  r = await wd.watchdogChecks(opts(now, { listFn: async () => { throw new Error('launchctl missing'); } }));
  assert.deepEqual(failed(r), ['background jobs']);
});

test('notification: exactly one, and only when something failed', async () => {
  healthyRun('2026-10-16');
  const sent = [];
  const notifyFn = (title, msg) => sent.push({ title, msg });
  await wd.runWatchdog(opts('2026-10-16T11:30:00Z', { notify: true, notifyFn }));
  assert.equal(sent.length, 0, 'healthy → silent');
  await wd.runWatchdog(opts('2026-10-16T11:30:00Z', { notify: false, notifyFn, fetchFn: async () => { throw new Error('down'); } }));
  assert.equal(sent.length, 0, 'without --notify → silent');
  rmSync(join(TMP, 'vwap-paper.json'));
  const r = await wd.runWatchdog(opts('2026-10-16T11:30:00Z', { notify: true, notifyFn, fetchFn: async () => { throw new Error('down'); } }));
  assert.equal(r.ok, false);
  assert.equal(sent.length, 1, 'one notification for several failures');
  assert.match(sent[0].title, /2 system checks failed/);
  assert.match(sent[0].msg, /paper record: YouTube intraday, dashboard server/);
  assert.ok(existsSync(process.env.WATCHDOG_PATH));
});

test('saved result counts as fresh while today’s collect is probably still running (16:05–16:45)', () => {
  const saved = { at: '2026-10-16T05:00:00Z', session: '2026-10-15' }; // saved Friday morning, about Thursday
  assert.equal(wd.watchdogFresh(saved, new Date('2026-10-16T09:00:00Z')), true, '14:30: still about Thursday');
  assert.equal(wd.watchdogFresh(saved, new Date('2026-10-16T10:50:00Z')), true, '16:20: collect still running');
  assert.equal(wd.watchdogFresh(saved, new Date('2026-10-16T11:30:00Z')), false, '17:00: re-check');
  assert.equal(wd.watchdogFresh(null), false);
});

test.after(() => rmSync(TMP, { recursive: true, force: true }));
