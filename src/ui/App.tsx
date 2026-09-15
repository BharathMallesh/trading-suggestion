import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentEvent } from '@core/events';
import type { StorageProvider } from '@core/storage';
import { restoreStorage } from '../storage';
import { FileSystemAccessStorage } from '../storage/fs-access';
import { requestPermission } from '../storage/handle-store';
import { BASE_MODEL } from '../setup/manifest';
import SetupWizard, { syncMissingBuiltinSkills } from '../setup/SetupWizard';
import { AdapterManager } from '../adapters/manager';
import { Shell } from '../app/Shell';
import { bootWorker, createAgentHost } from './agent-host';
import type { AgentHost } from './agent-host';

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f172a',
    color: '#e2e8f0',
    fontFamily: 'system-ui, sans-serif',
  },
  card: { maxWidth: 520, padding: 32, borderRadius: 12, background: '#1e293b' },
  title: { margin: '0 0 8px' },
  muted: { color: '#94a3b8', fontSize: 14 },
  progressTrack: { marginTop: 16, height: 8, borderRadius: 4, background: '#334155', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#38bdf8', transition: 'width 0.2s' },
  button: {
    padding: '12px 16px',
    borderRadius: 8,
    border: 'none',
    background: '#38bdf8',
    color: '#082f49',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: { marginTop: 16, color: '#f87171', fontSize: 14 },
};

type Phase =
  | { name: 'restoring' }
  | { name: 'setup' }
  | { name: 'needs-permission'; handle: FileSystemDirectoryHandle }
  | { name: 'loading'; path: string; loaded: number; total: number }
  | { name: 'ready'; host: AgentHost; storage: StorageProvider; modelPath: string }
  | { name: 'error'; message: string; storage: StorageProvider | null };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'restoring' });
  const [contexts, setContexts] = useState<string[]>([]);
  const [activeContext, setActiveContext] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ChatView instances register here; the host's sink fans out to all of them.
  const emittersRef = useRef<Array<(e: AgentEvent) => void>>([]);
  const registerEmitter = useCallback((fn: (e: AgentEvent) => void) => {
    emittersRef.current.push(fn);
    return () => {
      const i = emittersRef.current.indexOf(fn);
      if (i >= 0) emittersRef.current.splice(i, 1);
    };
  }, []);
  const workerRef = useRef<Worker | null>(null);
  // Bumped on unmount and at every boot start: a boot whose generation is
  // stale by the time it resolves must terminate its worker (unmounted or
  // superseded) instead of leaking it.
  const bootGenRef = useRef(0);

  /** Boot a session; true when a phase was entered, false on boot failure. */
  const startWithStorage = useCallback(async (storage: StorageProvider): Promise<boolean> => {
    const gen = ++bootGenRef.current;
    // Back-fill any builtin skills added since this user's setup (e.g. the
    // email assistant), so discovery/superpowers see them without a re-setup.
    await syncMissingBuiltinSkills(storage);
    const manager = new AdapterManager(storage);
    const artifact = await manager.activeArtifact();
    const modelPath = artifact?.path ?? BASE_MODEL.path;
    setActiveContext(artifact?.context ?? null);
    if (!(await storage.exists(modelPath))) {
      setPhase({ name: 'setup' });
      return true;
    }
    setPhase({ name: 'loading', path: modelPath, loaded: 0, total: 0 });
    try {
      // wllama 3.6.1 has no runtime unload; swap models by respawning the worker.
      workerRef.current?.terminate();
      const worker = await bootWorker(storage, modelPath, (loaded, total) =>
        setPhase({ name: 'loading', path: modelPath, loaded, total }),
      );
      if (gen !== bootGenRef.current) {
        // superseded by a newer boot or unmounted: drop the worker
        worker.terminate();
        return true;
      }
      workerRef.current = worker;
      const host = createAgentHost(storage, worker, modelPath, (e) => {
        for (const fn of emittersRef.current) fn(e);
      });
      setContexts(await manager.listContexts());
      setPhase({ name: 'ready', host, storage, modelPath });
      return true;
    } catch (err) {
      if (gen !== bootGenRef.current) return true; // unmounted/superseded: silent
      workerRef.current = null;
      setPhase({
        name: 'error',
        message: err instanceof Error ? err.message : String(err),
        storage,
      });
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await restoreStorage();
      if (cancelled) return;
      if (restored.status === 'needs-permission') {
        setPhase({ name: 'needs-permission', handle: restored.handle });
      } else if (restored.status === 'no-handle') {
        setPhase({ name: 'setup' });
      } else {
        await startWithStorage(restored.storage);
      }
    })();
    return () => {
      cancelled = true;
      bootGenRef.current++; // invalidate any in-flight boot
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [startWithStorage]);

  async function regrant(handle: FileSystemDirectoryHandle): Promise<void> {
    if (await requestPermission(handle)) {
      await startWithStorage(FileSystemAccessStorage.fromHandle(handle));
    }
  }

  async function switchContext(context: string): Promise<void> {
    if (phase.name !== 'ready') return;
    const storage = phase.storage;
    const manager = new AdapterManager(storage);
    try {
      await manager.activate(context);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    const ok = await startWithStorage(storage);
    if (ok) return;
    // Boot failed with the new artifact selected: clear the selection so a
    // reload boots the base model instead of re-failing, then try to recover
    // in place straight away.
    setNotice(null);
    try {
      await manager.clearActive();
    } catch {
      // rollback is best-effort; the error screen offers the same escape hatch
    }
    const recovered = await startWithStorage(storage);
    if (!recovered) setNotice('Falling back to the base model failed too — see below.');
  }

  async function switchToBaseModel(storage: StorageProvider): Promise<void> {
    try {
      await new AdapterManager(storage).clearActive();
    } catch {
      // ignore: removing a missing selection is a no-op anyway
    }
    await startWithStorage(storage);
  }

  if (phase.name === 'restoring') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>AutoClaw</h1>
          <p style={styles.muted}>Restoring your workspace…</p>
        </div>
      </div>
    );
  }

  if (phase.name === 'setup') {
    return <SetupWizard onDone={(storage) => void startWithStorage(storage)} />;
  }

  if (phase.name === 'needs-permission') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Folder access needed</h1>
          <p style={styles.muted}>
            The browser needs your permission again to open the folder you picked during setup.
          </p>
          <button style={styles.button} onClick={() => void regrant(phase.handle)}>
            Re-grant folder access
          </button>
        </div>
      </div>
    );
  }

  if (phase.name === 'loading') {
    const pct = phase.total > 0 ? Math.min(100, Math.round((phase.loaded / phase.total) * 100)) : null;
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Loading model</h1>
          <p style={styles.muted}>{phase.path}</p>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: pct == null ? '100%' : `${pct}%` }} />
          </div>
          <p style={styles.muted}>
            {phase.loaded.toLocaleString()} /{' '}
            {phase.total > 0 ? phase.total.toLocaleString() : 'unknown'} bytes
            {pct == null ? '' : ` (${pct}%)`}
          </p>
        </div>
      </div>
    );
  }

  if (phase.name === 'error') {
    const storage = phase.storage;
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Something went wrong</h1>
          <p style={styles.error}>{phase.message}</p>
          {storage && (
            <button style={styles.button} onClick={() => void switchToBaseModel(storage)}>
              Switch to base model
            </button>
          )}
          <button style={styles.button} onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {notice && <p style={{ ...styles.error, padding: '4px 16px', margin: 0 }}>{notice}</p>}
      <Shell
        storageKind={phase.storage.kind}
        storage={phase.storage}
        send={async (text) => {
          await phase.host.agent.chat(text);
        }}
        stop={() => phase.host.agent.stop()}
        draft={(instruction) => phase.host.agent.draftText(instruction)}
        registerEmitter={registerEmitter}
        resolveConfirm={phase.host.resolveConfirm}
      />
    </>
  );
}
