// Fires persisted schedules by replaying their message through the agent.
// A schedule is due when its most-recent scheduled occurrence is newer than
// the last time we fired it. Fire-state lives in its own file (luna/schedule-
// fires.json) so it never races the Schedules editor writing luna/schedules.json.
//
// Weekly/Monthly are approximated with an elapsed-time gate (the UI doesn't
// capture a weekday / day-of-month yet), so they fire at the configured time
// no more than ~weekly / ~monthly.
import { useEffect, useRef } from 'react';
import type { Store } from './store';

// Module-level so it is shared across effect instances — dev StrictMode mounts
// the scheduler effect twice, and overlapping ticks could otherwise fire the
// same occurrence more than once. Keyed by schedule id + occurrence epoch.
const firedKeys = new Set<string>();

export type Repeat = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly';
export interface ScheduleLike {
  id: string;
  name: string;
  repeat: Repeat;
  hour: number; // 1..12
  minute: number; // 0..59
  ampm: 'AM' | 'PM';
  message: string;
}

const DAY = 86_400_000;

export function to24h(hour12: number, ampm: 'AM' | 'PM'): number {
  const h = hour12 % 12; // 12 -> 0
  return ampm === 'PM' ? h + 12 : h;
}

/** Epoch ms of the most recent scheduled occurrence at or before `now`. */
export function recentOccurrence(sc: ScheduleLike, now: Date): number {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (sc.repeat === 'Hourly') {
    d.setMinutes(0);
    return d.getTime();
  }
  d.setHours(to24h(sc.hour, sc.ampm), sc.minute, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1); // today's time not reached → yesterday's
  return d.getTime();
}

/** True when the schedule should fire now given when it last fired. */
export function isDue(sc: ScheduleLike, lastFired: number | undefined, now: Date): boolean {
  if (lastFired == null) return false; // first sight: baseline only, never fire immediately
  const occ = recentOccurrence(sc, now);
  if (lastFired >= occ) return false; // already fired this occurrence
  const since = now.getTime() - lastFired;
  if (sc.repeat === 'Weekly' && since < 7 * DAY) return false;
  if (sc.repeat === 'Monthly' && since < 28 * DAY) return false;
  return true;
}

/**
 * Poll schedules on an interval and fire the due ones. `onFire` runs the
 * message (e.g. through the agent) and receives the schedule. A single fire
 * lock prevents overlapping runs from one tick.
 */
export function useScheduler(
  store: Store,
  onFire: (sc: ScheduleLike) => void | Promise<void>,
  intervalMs = 30_000,
): void {
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  useEffect(() => {
    let stopped = false;
    let firing = false;

    async function tick(): Promise<void> {
      if (stopped || firing) return;
      const schedules = await store.load<ScheduleLike[]>('schedules', []);
      if (!schedules.length) return;
      const fires = await store.load<Record<string, number>>('schedule-fires', {});
      const now = new Date();
      let changed = false;

      for (const sc of schedules) {
        if (fires[sc.id] == null) {
          fires[sc.id] = now.getTime(); // baseline so we only fire on the NEXT occurrence
          changed = true;
          continue;
        }
        if (isDue(sc, fires[sc.id], now)) {
          // Dedupe this exact occurrence across effect instances / overlapping
          // ticks before any await, so it fires at most once.
          const key = `${sc.id}@${recentOccurrence(sc, now)}`;
          if (firedKeys.has(key)) continue;
          firedKeys.add(key);
          fires[sc.id] = now.getTime();
          changed = true;
          firing = true;
          try {
            await onFireRef.current(sc);
          } catch {
            /* a failed fire must not wedge the scheduler */
          } finally {
            firing = false;
          }
        }
      }

      // prune fire-state for schedules that no longer exist
      const ids = new Set(schedules.map((s) => s.id));
      for (const id of Object.keys(fires)) {
        if (!ids.has(id)) {
          delete fires[id];
          changed = true;
        }
      }
      if (changed && !stopped) await store.save('schedule-fires', fires);
    }

    const iv = setInterval(() => void tick(), intervalMs);
    void tick(); // baseline immediately on mount
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [store, intervalMs]);
}
