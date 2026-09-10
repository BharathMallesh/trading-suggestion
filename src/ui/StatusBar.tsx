import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

const dotStyle = (online: boolean): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: online ? '#4ade80' : '#f87171',
});

const styles: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '8px 16px',
    background: '#1e293b',
    color: '#94a3b8',
    fontSize: 13,
    borderBottom: '1px solid #334155',
  },
  select: {
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: 6,
    padding: '2px 6px',
  },
};

export interface StatusBarProps {
  storageKind: 'fs-access' | 'opfs' | 'fake';
  /** null when no adapter contexts are registered */
  contexts: string[];
  activeContext: string | null;
  onSwitchContext: (context: string) => void;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

export function StatusBar({
  storageKind,
  contexts,
  activeContext,
  onSwitchContext,
}: StatusBarProps) {
  const online = useOnline();
  return (
    <div style={styles.bar}>
      <span style={dotStyle(online)} title={online ? 'online' : 'offline'} />
      <span>{online ? 'Online' : 'Offline'}</span>
      <span>Storage: {storageKind}</span>
      {contexts.length > 0 && (
        <label>
          Context:{' '}
          <select
            style={styles.select}
            value={activeContext ?? ''}
            onChange={(e) => onSwitchContext(e.target.value)}
          >
            {activeContext == null && <option value="">base model</option>}
            {contexts.map((ctx) => (
              <option key={ctx} value={ctx}>
                {ctx}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
