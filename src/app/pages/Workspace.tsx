// Workspace: a live browser over the agent's storage root. Folders lazy-load
// their children via storage.list(); files open in a viewer via readText().
// This is the actual on-device workspace the offline agent reads and writes.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StorageProvider } from '@core/storage';
import { theme } from '../theme';

interface OpenFile {
  path: string;
  text: string | null;
  size: number;
  error?: string;
}

// A directory node knows its children once expanded; files are leaves.
function TreeDir({
  storage,
  dir,
  name,
  depth,
  onOpen,
  selected,
}: {
  storage: StorageProvider;
  dir: string;
  name: string;
  depth: number;
  onOpen: (path: string) => void;
  selected: string | null;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [entries, setEntries] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open || entries) return;
    let cancelled = false;
    void storage.list(dir).then((e) => {
      if (!cancelled) setEntries(e);
    });
    return () => {
      cancelled = true;
    };
  }, [open, entries, storage, dir]);

  return (
    <div>
      {depth > 0 && (
        <button style={{ ...row(depth), color: theme.color.text }} onClick={() => setOpen((o) => !o)}>
          <span style={s.caret}>{open ? '▾' : '▸'}</span>
          <span style={s.folder}>📁</span> {name}
        </button>
      )}
      {open &&
        (entries ?? []).map((entry) => {
          const path = dir ? `${dir}/${entry}` : entry;
          // Heuristic: entries with a dot in the last segment are treated as
          // files; everything else is probed as a directory (lazy list).
          const isFile = /\.[a-z0-9]+$/i.test(entry);
          return isFile ? (
            <button
              key={path}
              style={{ ...row(depth + 1), ...(selected === path ? s.rowSelected : {}), color: theme.color.textDim }}
              onClick={() => onOpen(path)}
            >
              <span style={s.caret} />
              <span style={s.file}>📄</span> {entry}
            </button>
          ) : (
            <TreeDir
              key={path}
              storage={storage}
              dir={path}
              name={entry}
              depth={depth + 1}
              onOpen={onOpen}
              selected={selected}
            />
          );
        })}
    </div>
  );
}

export function Workspace({ storage }: { storage?: StorageProvider }) {
  const [file, setFile] = useState<OpenFile | null>(null);

  async function openFile(path: string): Promise<void> {
    if (!storage) return;
    setFile({ path, text: null, size: 0 });
    try {
      const stat = await storage.stat(path);
      if (stat.size > 512 * 1024) {
        setFile({ path, text: null, size: stat.size, error: 'File too large to preview.' });
        return;
      }
      const text = await storage.readText(path);
      setFile({ path, text, size: stat.size });
    } catch (e) {
      setFile({ path, text: null, size: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <div style={s.panelHead}>Files</div>
        <div style={s.tree}>
          {storage ? (
            <TreeDir storage={storage} dir="" name="" depth={0} onOpen={(p) => void openFile(p)} selected={file?.path ?? null} />
          ) : (
            <div style={s.empty}>No storage attached.</div>
          )}
        </div>
      </div>
      <div style={s.viewer}>
        {!file ? (
          <div style={s.viewerEmpty}>Select a file to view</div>
        ) : (
          <>
            <div style={s.viewerHead}>
              <span style={s.viewerPath}>{file.path}</span>
              {file.size > 0 && <span style={s.viewerSize}>{formatSize(file.size)}</span>}
            </div>
            <div style={s.viewerBody}>
              {file.error ? (
                <span style={{ color: theme.color.danger }}>{file.error}</span>
              ) : file.text == null ? (
                <span style={{ color: theme.color.textFaint }}>Loading…</span>
              ) : (
                <pre style={s.pre}>{file.text}</pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function row(depth: number): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: '100%',
    padding: '5px 8px',
    paddingLeft: 8 + depth * 14,
    background: 'transparent',
    border: 'none',
    fontSize: 13,
    fontFamily: theme.font.sans,
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 6,
  };
}

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', display: 'flex', gap: 12, padding: 16, minHeight: 0 },
  panel: {
    width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column',
    background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md, minHeight: 0,
  },
  panelHead: { padding: '12px 14px', fontSize: 13, color: theme.color.textDim, borderBottom: `1px solid ${theme.color.borderSoft}` },
  tree: { flex: 1, overflowY: 'auto', padding: 6 },
  caret: { width: 12, display: 'inline-block', color: theme.color.textFaint, fontSize: 10 },
  folder: { fontSize: 12 },
  file: { fontSize: 12 },
  rowSelected: { background: theme.color.panel },
  empty: { color: theme.color.textFaint, fontSize: 13, padding: 14 },
  viewer: {
    flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0,
    background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md,
  },
  viewerEmpty: { margin: 'auto', color: theme.color.textFaint, fontSize: 14 },
  viewerHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', borderBottom: `1px solid ${theme.color.borderSoft}`,
  },
  viewerPath: { fontSize: 13, color: theme.color.text, fontFamily: 'ui-monospace, monospace' },
  viewerSize: { fontSize: 12, color: theme.color.textFaint },
  viewerBody: { flex: 1, overflow: 'auto', padding: 16, minHeight: 0 },
  pre: {
    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, color: theme.color.textDim, lineHeight: 1.5,
  },
};
