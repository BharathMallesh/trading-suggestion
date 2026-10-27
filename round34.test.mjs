// Tests for the live-first paper record: trades seen live are kept (rebuilt from the
// live entry / stop / target if Yahoo revises the candles), revised-only signals are left out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'trading-r34-'));
process.env.VWAP_SEEN_PATH = join(TMP, 'seen.json');
process.env.VWAP_PAPER_PATH = join(TMP, 'paper.json');
process.env.NSE_HOLIDAYS_PATH = join(TMP, 'nse-holidays.json');
after(() => rmSync(TMP, { recursive: true, force: true }));

const v = await import('./paper-bot/vwap-pullback.mjs');
const bar = (date, hm, o, h, l, c) => ({ date: `${date} ${hm}`, open: o, high: h, low: l, close: c });

test('snapshots keep the trade details the first time a trade is seen', () => {
  const sig = { live: true, date: '2026-10-23', variants: { video: { trades: [{ symbol: 'BAJAJFINSV.NS', side: 'short', time: '09:40', entry: 1671.1, stop: 1681.87, target: 1649.56, qty: 92 }] } } };
  v.noteLiveSeen(sig, new Date('2026-10-23T04:10:00Z'));
  v.noteLiveSeen({ ...sig, variants: { video: { trades: [{ ...sig.variants.video.trades[0], entry: 9999 }] } } }, new Date('2026-10-23T04:15:00Z'));
  const s = JSON.parse(readFileSync(process.env.VWAP_SEEN_PATH, 'utf8'));
  const k = s.keys['2026-10-23|video|BAJAJFINSV.NS|short'];
  assert.equal(k.trade.entry, 1671.1, 'first sighting kept');
  assert.equal(k.trade.qty, 92);
  assert.equal(s.days['2026-10-23'], 2);
});

test('rebuild from live: replays the candles from the entry — target, stop first, 15:00', () => {
  const d = '2026-10-23';
  const detail = { symbol: 'X.NS', side: 'short', time: '09:40', entry: 100, stop: 101, target: 98 };
  const rows = [bar(d, '09:35', 100, 100.5, 99.8, 100), bar(d, '09:40', 100, 100.4, 99.5, 99.6), bar(d, '09:45', 99.6, 99.7, 97.9, 98.1)];
  const t = v.rebuildFromLive(detail, rows, d);
  assert.equal(t.reason, 'target');
  assert.equal(t.qty, 1000, '₹1,000 risk / ₹1 a share');
  assert.equal(t.rebuiltFromLive, true);
  assert.ok(t.net > 0 && t.net < 2000);
  const both = v.rebuildFromLive(detail, [bar(d, '09:40', 100, 101.2, 97.5, 99)], d);
  assert.equal(both.reason, 'stop', 'stop assumed first when both are inside one candle');
  const late = v.rebuildFromLive({ ...detail, stop: 105, target: 90 }, [bar(d, '09:40', 100, 100.5, 99.5, 100), bar(d, '15:00', 99, 99.5, 98.5, 99)], d);
  assert.equal(late.reason, '15:00');
});

test('live-first day: seen trades kept (rebuilt if gone), revised-only signals left out, daily limit', () => {
  const d = '2026-10-23';
  const seen = { days: { [d]: 70 }, keys: {
    [`${d}|video|BAJAJFINSV.NS|short`]: { time: '09:40', trade: { symbol: 'BAJAJFINSV.NS', side: 'short', time: '09:40', entry: 100, stop: 101, target: 98 } },
    [`${d}|video|MARUTI.NS|short`]: { time: '09:45' },
  } };
  const recomputed = [
    { symbol: 'MARUTI.NS', side: 'short', date: d, time: '09:45', net: -1166 },
    { symbol: 'TITAN.NS', side: 'short', date: d, time: '11:15', net: -698 },
  ];
  const rows = new Map([['BAJAJFINSV.NS', [bar(d, '09:40', 100, 100.2, 97.9, 98)]]]);
  const r = v.liveFirstDay({ date: d, variant: 'video', recomputed, seen, rowsBySymbol: rows });
  assert.deepEqual(r.trades.map((t) => t.symbol), ['BAJAJFINSV.NS', 'MARUTI.NS']);
  assert.equal(r.trades[0].reason, 'target');
  assert.equal(r.trades[1].net, -1166, 'the after-close version is used when it still exists');
  assert.deepEqual(r.revisedOnly.map((t) => t.symbol), ['TITAN.NS']);
  // a live trade already recorded is kept when it is in neither the revised list nor rebuildable
  const kept = v.liveFirstDay({ date: d, variant: 'video', recomputed: [], recorded: [{ symbol: 'MARUTI.NS', side: 'short', date: d, time: '09:45', net: -1166 }], seen, rowsBySymbol: new Map() });
  assert.deepEqual(kept.trades.map((t) => [t.symbol, t.net]), [['MARUTI.NS', -1166]]);
  const stable = v.liveFirstDay({ date: d, variant: 'video', recomputed: [{ symbol: 'MARUTI.NS', side: 'short', date: d, time: '09:45', net: -900 }], recorded: [{ symbol: 'MARUTI.NS', side: 'short', date: d, time: '09:45', net: -1166 }], seen, rowsBySymbol: new Map() });
  assert.equal(stable.trades.find((t) => t.symbol === 'MARUTI.NS').net, -1166, 'a recorded trade is not re-valued');
  // a day without live snapshots keeps the after-close list
  const none = v.liveFirstDay({ date: '2026-10-12', variant: 'video', recomputed, seen, rowsBySymbol: rows });
  assert.equal(none.trades.length, 2);
  assert.equal(none.revisedOnly.length, 0);
});
