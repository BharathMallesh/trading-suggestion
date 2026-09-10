import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentEvent } from '@core/events';
import type { StorageProvider } from '@core/storage';
import { restoreStorage } from '../storage';
import { FileSystemAccessStorage } from '../storage/fs-access';
import { requestPermission } from '../storage/handle-store';
import { BASE_MODEL } from '../setup/manifest';
import SetupWizard from '../setup/SetupWizard';
import { AdapterManager } from '../adapters/manager';
import { ChatView } from './ChatView';
import { StatusBar } from './StatusBar';
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
  | { name: 'error'; message: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'restoring' });
  const [contexts, setContexts] = useState<string[]>([]);
  const [activeContext, setActiveContext] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ChatView instances register here; the host's sink fans out to all of them.
  const emittersRef = useRef<Array<(e: AgentEvent) => void>>([]);
  const registerEmitter = useCallback((fn: (e: AgentEvent) => void) => {
    emittersRef.current.push(fn);
  }, []);
  const workerRef = useRef<Worker | null>(null);

  const startWithStorage = useCallback(async (storage: StorageProvider) => {
    const manager = new AdapterManager(storage);
    const artifact = await manager.activeArtifact();
    const modelPath = artifact?.path ?? BASE_MODEL.path;
    setActiveContext(artifact?.context ?? null);
    if (!(await storage.exists(modelPath))) {
      setPhase({ name: 'setup' });
      return;
    }
    setPhase({ name: 'loading', path: modelPath, loaded: 0, total: 0 });
    try {
      // wllama 3.6.1 has no runtime unload; swap models by respawning the worker.
      workerRef.current?.terminate();
      const worker = await bootWorker(storage, modelPath, (loaded, total) =>
        setPhase({ name: 'loading', path: modelPath, loaded, total }),
      );
      workerRef.current = worker;
      const host = createAgentHost(storage, worker, modelPath, (e) => {
        for (const fn of emittersRef.current) fn(e);
      });
      setContexts(await manager.listContexts());
      setPhase({ name: 'ready', host, storage, modelPath });
    } catch (err) {
      workerRef.current = null;
      setPhase({ name: 'error', message: err instanceof Error ? err.message : String(err) });
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
    try {
      const manager = new AdapterManager(phase.storage);
      await manager.activate(context);
      await startWithStorage(phase.storage);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
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
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Something went wrong</h1>
          <p style={styles.error}>{phase.message}</p>
          <button style={styles.button} onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <StatusBar
        storageKind={phase.storage.kind}
        contexts={contexts}
        activeContext={activeContext}
        onSwitchContext={(ctx) => void switchContext(ctx)}
        onRegrant={null}
      />
      {notice && <p style={{ ...styles.error, padding: '0 16px' }}>{notice}</p>}
      <ChatView
        send={async (text) => {
          await phase.host.agent.chat(text);
        }}
        registerEmitter={registerEmitter}
        resolveConfirm={phase.host.resolveConfirm}
      />
    </div>
  );
}
