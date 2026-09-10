// Persistence layer for the Luna UI. Each feature's state is a JSON document
// under `luna/<key>.json` in the agent's storage root (OPFS or the user's
// folder) — so it survives reloads and lives alongside the agent's own files.
// When no storage is attached (shouldn't happen in the real app), load/save
// degrade to no-ops and the UI just runs on in-memory defaults.
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { StorageProvider } from '@core/storage';

export interface Store {
  load<T>(key: string, fallback: T): Promise<T>;
  save<T>(key: string, value: T): Promise<void>;
}

const pathFor = (key: string) => `luna/${key}.json`;

export function createStore(storage?: StorageProvider): Store {
  return {
    async load<T>(key: string, fallback: T): Promise<T> {
      if (!storage) return fallback;
      try {
        if (!(await storage.exists(pathFor(key)))) return fallback;
        return JSON.parse(await storage.readText(pathFor(key))) as T;
      } catch {
        return fallback; // corrupt/unreadable → fall back rather than crash
      }
    },
    async save<T>(key: string, value: T): Promise<void> {
      if (!storage) return;
      try {
        await storage.writeText(pathFor(key), JSON.stringify(value, null, 2));
      } catch {
        // best-effort; a failed write must not break the UI
      }
    },
  };
}

/**
 * Like useState, but hydrated from the store on mount and persisted on every
 * change once hydration completes. `ready` is false until the stored value has
 * loaded, so callers can avoid flashing defaults or saving before the load.
 */
export function usePersistentState<T>(
  store: Store,
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [state, setState] = useState<T>(initial);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store.load(key, initial).then((v) => {
      if (!cancelled) {
        setState(v);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
    // initial is intentionally excluded: we only hydrate once per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);

  useEffect(() => {
    if (ready) void store.save(key, state);
  }, [store, key, ready, state]);

  return [state, setState, ready];
}
