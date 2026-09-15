import { describe, it, expect } from 'vitest';
import { isDue, recentOccurrence, to24h } from '../src/app/scheduler';
import type { ScheduleLike } from '../src/app/scheduler';

const daily = (over: Partial<ScheduleLike> = {}): ScheduleLike => ({
  id: 's1',
  name: 'Morning briefing',
  repeat: 'Daily',
  hour: 9,
  minute: 0,
  ampm: 'AM',
  message: 'brief me',
  ...over,
});

describe('to24h', () => {
  it('maps 12-hour clock to 24-hour', () => {
    expect(to24h(9, 'AM')).toBe(9);
    expect(to24h(12, 'AM')).toBe(0);
    expect(to24h(12, 'PM')).toBe(12);
    expect(to24h(3, 'PM')).toBe(15);
  });
});

describe('recentOccurrence', () => {
  it('daily: uses today when the time has passed', () => {
    const now = new Date('2026-09-10T10:00:00');
    expect(recentOccurrence(daily(), now)).toBe(new Date('2026-09-10T09:00:00').getTime());
  });
  it('daily: uses yesterday when today’s time is not yet reached', () => {
    const now = new Date('2026-09-10T08:00:00');
    expect(recentOccurrence(daily(), now)).toBe(new Date('2026-09-09T09:00:00').getTime());
  });
  it('hourly: uses the top of the current hour', () => {
    const now = new Date('2026-09-10T10:37:00');
    expect(recentOccurrence(daily({ repeat: 'Hourly' }), now)).toBe(new Date('2026-09-10T10:00:00').getTime());
  });
});

describe('isDue', () => {
  const now = new Date('2026-09-10T10:00:00');

  it('never fires on first sight (baseline)', () => {
    expect(isDue(daily(), undefined, now)).toBe(false);
  });
  it('daily fires once the occurrence is newer than last fire', () => {
    const yesterday = new Date('2026-09-09T09:05:00').getTime();
    expect(isDue(daily(), yesterday, now)).toBe(true);
  });
  it('daily does not re-fire the same occurrence', () => {
    const today9 = new Date('2026-09-10T09:00:30').getTime();
    expect(isDue(daily(), today9, now)).toBe(false);
  });
  it('hourly fires on a new hour boundary', () => {
    const lastHour = new Date('2026-09-10T09:59:00').getTime();
    expect(isDue(daily({ repeat: 'Hourly' }), lastHour, now)).toBe(true);
  });
  it('weekly is gated to ~7 days even if the daily time passed', () => {
    const twoDaysAgo = new Date('2026-09-08T09:05:00').getTime();
    expect(isDue(daily({ repeat: 'Weekly' }), twoDaysAgo, now)).toBe(false);
    const eightDaysAgo = new Date('2026-09-02T09:05:00').getTime();
    expect(isDue(daily({ repeat: 'Weekly' }), eightDaysAgo, now)).toBe(true);
  });
});
