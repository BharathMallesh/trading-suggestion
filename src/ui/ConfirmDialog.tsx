import type { CSSProperties } from 'react';

export interface ConfirmRequest {
  id: string;
  tool: string;
  args: unknown;
  reason: string;
}

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2, 6, 23, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { maxWidth: 480, width: '90%', padding: 24, borderRadius: 12, background: '#1e293b' },
  title: { margin: '0 0 8px', color: '#e2e8f0' },
  reason: { color: '#fbbf24', fontSize: 14 },
  args: {
    margin: '12px 0',
    padding: 8,
    background: '#0f172a',
    borderRadius: 6,
    overflowX: 'auto',
    color: '#cbd5e1',
    fontSize: 13,
  },
  row: { display: 'flex', gap: 12 },
  approve: {
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: '#38bdf8',
    color: '#082f49',
    fontWeight: 600,
    cursor: 'pointer',
  },
  deny: {
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid #475569',
    background: 'transparent',
    color: '#e2e8f0',
    cursor: 'pointer',
  },
};

export function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest;
  onResolve: (ok: boolean) => void;
}) {
  return (
    <div style={styles.overlay} role="dialog" aria-label={`Confirm ${request.tool}`}>
      <div style={styles.card}>
        <h2 style={styles.title}>Allow {request.tool}?</h2>
        <p style={styles.reason}>{request.reason}</p>
        <pre style={styles.args}>{JSON.stringify(request.args, null, 2)}</pre>
        <div style={styles.row}>
          <button style={styles.approve} onClick={() => onResolve(true)}>
            Approve
          </button>
          <button style={styles.deny} onClick={() => onResolve(false)}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
