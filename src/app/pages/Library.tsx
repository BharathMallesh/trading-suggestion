// Library: apps, docs and artifacts the assistant has built. Empty state for
// now; later it lists artifacts written to the workspace (e.g. library/).
import type { CSSProperties } from 'react';
import { theme } from '../theme';

export function Library({ onNewChat }: { onNewChat?: () => void }) {
  return (
    <div style={s.wrap}>
      <div style={s.top}>
        <button style={s.import}>⤓ Import</button>
      </div>
      <div style={s.center}>
        <div style={s.icon}>▦</div>
        <h3 style={s.title}>Your library is empty</h3>
        <p style={s.sub}>Ask your assistant to build something</p>
        <button style={s.primary} onClick={onNewChat}>New Conversation</button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20, position: 'relative' },
  top: { display: 'flex', justifyContent: 'flex-end' },
  import: {
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, color: theme.color.textDim,
    borderRadius: theme.radius.sm, padding: '7px 14px', fontSize: 13, cursor: 'pointer',
  },
  center: { margin: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' },
  icon: {
    width: 54, height: 54, borderRadius: theme.radius.md, background: theme.color.panel,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: theme.color.textDim,
  },
  title: { fontFamily: theme.font.serif, fontWeight: 400, margin: '8px 0 0', color: theme.color.text },
  sub: { color: theme.color.textFaint, fontSize: 14, margin: 0 },
  primary: {
    marginTop: 8, background: theme.color.text, color: theme.color.bg, border: 'none',
    borderRadius: theme.radius.sm, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
};
