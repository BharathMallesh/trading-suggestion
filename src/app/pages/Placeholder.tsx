// Temporary destination for screens not yet built. Keeps the app fully
// navigable while we implement each surface in its own pass.
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import { PAGE_TITLE } from '../nav';
import type { Page } from '../nav';

export function Placeholder({ page }: { page: Page }) {
  return (
    <div style={s.wrap}>
      <div style={s.icon}>🚧</div>
      <h2 style={s.title}>{PAGE_TITLE[page]}</h2>
      <p style={s.sub}>This screen is next up. The offline engine and shell are ready to hang it on.</p>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    color: theme.color.text,
  },
  icon: { fontSize: 32, opacity: 0.7 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, margin: 0 },
  sub: { color: theme.color.textFaint, fontSize: 14, maxWidth: 360, textAlign: 'center' },
};
