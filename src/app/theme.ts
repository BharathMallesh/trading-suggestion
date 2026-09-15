// Design tokens for the Buddy assistant UI. Dark, near-black surfaces with a
// fresh, friendly teal accent for the active assistant.
export const theme = {
  color: {
    bg: '#0d0d0f',
    panel: '#161618',
    panelHover: '#1d1d20',
    card: '#141416',
    border: '#262629',
    borderSoft: '#1f1f22',
    text: '#ededed',
    textDim: '#a0a0a6',
    textFaint: '#6d6d73',
    accent: '#2dd4bf',
    accentSoft: '#123430',
    accentText: '#05231f',
    danger: '#e5533c',
    online: '#4ade80',
    offline: '#f87171',
  },
  font: {
    sans: "'Inter', system-ui, -apple-system, sans-serif",
    serif: "'Newsreader', Georgia, 'Times New Roman', serif",
  },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
} as const;

export type Theme = typeof theme;
