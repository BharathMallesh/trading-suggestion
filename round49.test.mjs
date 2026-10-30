// Tests for the Option strike guide (ITM / ATM / OTM weekly buys).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r49-'));
process.env.OPTION_STRIKES_PATH = join(TMP, 'os.json');
process.env.FO_BHAV_DIR = join(TMP, 'fo-bhav');
after(() => rmSync(TMP, { recursive: true, force: true }));
const os = await import('./paper-bot/option-strikes.mjs');

test('inverse normal and delta strikes: 0.7 is about +0.52, ITM calls below spot, OTM calls above, puts mirrored', () => {
  assert.ok(Math.abs(os.invNorm(0.7) - 0.5244) < 0.002);
  assert.ok(Math.abs(os.invNorm(0.3) + 0.5244) < 0.002);
  assert.equal(os.invNorm(0.5), 0);
  assert.ok(os.strikeFor(20000, 0.02, 0.7, 'CE') < 20000 && os.strikeFor(20000, 0.02, 0.3, 'CE') > 20000);
  assert.ok(os.strikeFor(20000, 0.02, 0.7, 'PE') > 20000 && os.strikeFor(20000, 0.02, 0.3, 'PE') < 20000);
});

test('leg return: expiring worthless loses the premium plus charges; deep in the money pays STT on exercise', () => {
  const lost = os.legReturn({ strike: 20500, prem: 50 }, 'CE', 20000, '2025-01-02');
  assert.ok(lost < -1 && lost > -1.05);
  const won = os.legReturn({ strike: 19800, prem: 250 }, 'CE', 20300, '2025-01-02');
  assert.ok(won > 0.95 && won < 1, `500 intrinsic on 250 premium, less charges: ${won}`);
});

test("a weekly cycle picks three strikes each side from one day's chain", () => {
  const chain = {};
  for (let k = 19000; k <= 21000; k += 50) chain[k] = { CE: Math.max(20000 - k, 0) + 120 * Math.exp(-(((k - 20000) / 300) ** 2)), PE: Math.max(k - 20000, 0) + 120 * Math.exp(-(((k - 20000) / 300) ** 2)), ceVol: 1, peVol: 1 };
  const c = os.cycleFrom('2025-01-02', { underlying: 20000, expiries: { '2025-01-09': chain } });
  assert.equal(c.legs['ATM-CE'].strike, 20000);
  assert.ok(c.legs['ITM-CE'].strike < 20000 && c.legs['OTM-CE'].strike > 20000);
  assert.ok(c.legs['ITM-PE'].strike > 20000 && c.legs['OTM-PE'].strike < 20000);
  assert.ok(c.legs['ITM-CE'].prem > c.legs['ATM-CE'].prem && c.legs['ATM-CE'].prem > c.legs['OTM-CE'].prem);
});

test('the full test runs on cached files: hindsight buckets and the three real ways of choosing a side', async () => {
  const dir = process.env.FO_BHAV_DIR;
  mkdirSync(dir, { recursive: true });
  const days = ['2025-01-02', '2025-01-10', '2025-01-17'];
  const chain = (s) => Object.fromEntries(Array.from({ length: 41 }, (_, i) => s - 1000 + i * 50).map((k) => [k, { CE: Math.max(s - k, 0) + 100 * Math.exp(-(((k - s) / 300) ** 2)), PE: Math.max(k - s, 0) + 100 * Math.exp(-(((k - s) / 300) ** 2)), ceVol: 1, peVol: 1 }]));
  writeFileSync(join(dir, `${days[0]}.json`), JSON.stringify({ underlying: 20000, expiries: { '2025-01-09': chain(20000) } }));
  writeFileSync(join(dir, `${days[1]}.json`), JSON.stringify({ underlying: 20300, expiries: { '2025-01-16': chain(20300) } }));
  const closes = [];
  for (let t = Date.UTC(2024, 10, 1); t <= Date.UTC(2025, 0, 20); t += 86400000) if (new Date(t).getUTCDay() % 6) closes.push({ date: new Date(t).toISOString().slice(0, 10), close: 20000 });
  const set = (d, v) => (closes.find((x) => x.date === d).close = v);
  set('2025-01-09', 20300);
  set('2025-01-10', 20300);
  set('2025-01-16', 20000);
  const r = await os.optionStrikesTest({ loadCandles: async () => closes });
  assert.equal(r.weeks, 2);
  assert.equal(r.hindsight.find((b) => b.label === '1–2%').weeks, 2); // +1.5% then −1.5%
  assert.ok(r.hindsight.find((b) => b.label === '1–2%').ITM.avg > 0);
  assert.deepEqual(Object.keys(r.real), ['call', 'put', 'trend']);
});
