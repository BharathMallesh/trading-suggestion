import type { CSSProperties } from 'react';

export interface ToolTraceEntry {
  step: number;
  tool: string;
  args: unknown;
  truncated?: boolean;
  bytes?: number;
  outputFile?: string;
}

const styles: Record<string, CSSProperties> = {
  panel: { marginTop: 8, fontSize: 13 },
  entry: { marginBottom: 4 },
  summary: { cursor: 'pointer', color: '#94a3b8' },
  args: {
    margin: '4px 0 0',
    padding: 8,
    background: '#0f172a',
    borderRadius: 6,
    overflowX: 'auto',
    color: '#cbd5e1',
  },
  meta: { color: '#64748b' },
};

export function ToolTrace({ entries }: { entries: ToolTraceEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={styles.panel}>
      {entries.map((entry, i) => (
        <details key={i} style={styles.entry}>
          <summary style={styles.summary}>
            #{entry.step} {entry.tool}
            {entry.bytes != null && (
              <span style={styles.meta}>
                {' '}
                — {entry.bytes.toLocaleString()} bytes{entry.truncated ? ' (truncated)' : ''}
                {entry.outputFile ? ` → ${entry.outputFile}` : ''}
              </span>
            )}
          </summary>
          <pre style={styles.args}>{JSON.stringify(entry.args, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
