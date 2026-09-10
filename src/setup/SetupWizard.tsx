import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { StorageProvider } from '@core/storage';
import { FileSystemAccessStorage } from '../storage/fs-access';
import { OpfsStorage } from '../storage/opfs';
import { fsAccessSupported } from '../storage/index';
import { downloadAsset } from './download';
import { resolveAssetSpecs } from './manifest';

/**
 * Bundled builtin skills, mirrored from public/skills-builtin/ at setup time.
 * The service worker precaches these (see vite.config.ts globPatterns), so
 * seeding works offline after the first page load.
 */
export const BUILTIN_SKILL_FILES: string[] = [
  'code2media/SKILL.md',
  'code2media/references/syntax-guide.md',
  'code2media/templates/metrics-card.html',
  'code2media/templates/certificate.html',
  'code2media/templates/badge.html',
  'code2media/templates/weekly-report.html',
  'code2media/templates/animation.html',
  'invoice-maker/SKILL.md',
  'invoice-maker/references/syntax-guide.md',
  'invoice-maker/templates/quote.html',
  'invoice-maker/templates/invoice.html',
  'poster-maker/SKILL.md',
  'poster-maker/references/syntax-guide.md',
  'poster-maker/references/scenario-playbook.md',
  'poster-maker/templates/og-card.html',
  'poster-maker/templates/cover.html',
  'poster-maker/templates/social-post.html',
  'email-assistant/SKILL.md',
];

async function seedBuiltinSkills(storage: StorageProvider): Promise<void> {
  for (const rel of BUILTIN_SKILL_FILES) {
    const res = await fetch(`/skills-builtin/${rel}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching /skills-builtin/${rel}`);
    await storage.writeText(`skills-builtin/${rel}`, await res.text());
  }
}

/**
 * Back-fill builtin skills added after a user's initial setup: on boot, write
 * any bundled skill file that isn't already in storage. Best-effort and
 * idempotent — never overwrites, so it won't clobber anything, and a failed
 * fetch (offline, file not yet cached) is skipped rather than thrown.
 */
export async function syncMissingBuiltinSkills(storage: StorageProvider): Promise<void> {
  for (const rel of BUILTIN_SKILL_FILES) {
    const path = `skills-builtin/${rel}`;
    try {
      if (await storage.exists(path)) continue;
      const res = await fetch(`/skills-builtin/${rel}`);
      if (!res.ok) continue;
      await storage.writeText(path, await res.text());
    } catch {
      /* offline / uncached — skip; it will seed on a later load */
    }
  }
  // Note: models/, adapters/, skills/, workspace/, cache/ are not created
  // here — StorageProvider has no mkdir; directories materialize lazily
  // via writes, and empty dirs are not representable in any backend.
}

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
  buttonRow: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 },
  button: {
    padding: '12px 16px',
    borderRadius: 8,
    border: 'none',
    background: '#38bdf8',
    color: '#082f49',
    fontWeight: 600,
    cursor: 'pointer',
  },
  buttonSecondary: {
    padding: '12px 16px',
    borderRadius: 8,
    border: '1px solid #475569',
    background: 'transparent',
    color: '#e2e8f0',
    cursor: 'pointer',
  },
  error: { marginTop: 16, color: '#f87171', fontSize: 14 },
  progressTrack: {
    marginTop: 16,
    height: 8,
    borderRadius: 4,
    background: '#334155',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', background: '#38bdf8', transition: 'width 0.2s' },
};

export interface SetupWizardProps {
  onDone: (storage: StorageProvider) => void;
}

export default function SetupWizard({ onDone }: SetupWizardProps) {
  const [screen, setScreen] = useState<'pick' | 'download'>('pick');
  const [storage, setStorage] = useState<StorageProvider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ path: string; loaded: number; total: number }>({
    path: '',
    loaded: 0,
    total: 0,
  });

  async function runDownloads(storage: StorageProvider): Promise<void> {
    setError(null);
    setBusy('Downloading assets…');
    try {
      const specs = resolveAssetSpecs();
      for (const spec of specs) {
        setProgress({ path: spec.path, loaded: 0, total: spec.size ?? 0 });
        await downloadAsset(spec, storage, (p) => setProgress({ path: spec.path, ...p }));
      }
      await storage.writeText(
        'cache/setup-done.json',
        JSON.stringify({ doneAt: new Date().toISOString(), assets: specs.map((s) => s.path) }),
      );
      onDone(storage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startWith(make: () => Promise<StorageProvider>): Promise<void> {
    setError(null);
    setBusy('Preparing your folder…');
    try {
      const storage = await make();
      await seedBuiltinSkills(storage);
      setStorage(storage);
      setScreen('download');
      await runDownloads(storage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (screen === 'download') {
    const pct =
      progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Downloading assets</h1>
          <p style={styles.muted}>{progress.path}</p>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: pct == null ? '100%' : `${pct}%` }} />
          </div>
          <p style={styles.muted}>
            {progress.loaded.toLocaleString()} /{' '}
            {progress.total > 0 ? progress.total.toLocaleString() : 'unknown'} bytes
            {pct == null ? '' : ` (${pct}%)`}
          </p>
          {error && storage && (
            <div>
              <p style={styles.error}>Download failed: {error}</p>
              <button
                style={busy != null ? { ...styles.button, opacity: 0.5 } : styles.button}
                disabled={busy != null}
                onClick={() => void runDownloads(storage)}
              >
                {busy != null ? busy : 'Retry'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const folderSupported = fsAccessSupported();
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome to AutoClaw</h1>
        <p style={styles.muted}>
          AutoClaw needs a folder to keep your model, skills, and workspace. Everything is stored
          locally; after setup the app runs fully offline.
        </p>
        <div style={styles.buttonRow}>
          <button
            style={folderSupported ? styles.button : { ...styles.buttonSecondary, opacity: 0.5 }}
            disabled={!folderSupported || busy != null}
            onClick={() => void startWith(() => FileSystemAccessStorage.pickAndCreate())}
          >
            Choose a folder on this device
          </button>
          <button
            style={styles.buttonSecondary}
            disabled={busy != null}
            onClick={() => void startWith(() => OpfsStorage.create())}
          >
            Use built-in browser storage instead
          </button>
        </div>
        <p style={styles.muted}>
          <strong>Folder:</strong> you pick where files live and can inspect them outside the app;
          the browser will ask for permission again after a restart.
          <br />
          <strong>Built-in:</strong> no picker, works in every browser, but files live in an
          invisible sandbox.
          {!folderSupported && (
            <>
              <br />
              This browser does not support folder access, so built-in storage is the only option.
            </>
          )}
        </p>
        {busy && <p style={styles.muted}>{busy}</p>}
        {error && <p style={styles.error}>Setup failed: {error}</p>}
      </div>
    </div>
  );
}
