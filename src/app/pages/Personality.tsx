// Personality: five bipolar dials that shape the assistant's voice. Full-bleed
// accent surface to match the reference. State is local for now; a later pass
// persists it to the agent config and rewrites the system prompt.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import type { Store } from '../store';

const DIALS = [
  { left: 'Companion', right: 'Coworker', value: 0.1 },
  { left: 'Gen Z', right: 'Baby Boomer', value: 0.9 },
  { left: 'Independent', right: 'Collaborative', value: 0.1 },
  { left: 'Playful', right: 'Serious', value: 0.5 },
  { left: 'Polite', right: 'Unfiltered', value: 0.95 },
];
const DEFAULTS = DIALS.map((d) => d.value);

export function Personality({ onBack, store }: { onBack?: () => void; store: Store }) {
  const [values, setValues] = useState<number[]>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  // Slider changes are local (the "slide then hit update" model); the Update
  // button commits the dials to storage.
  useEffect(() => {
    let cancelled = false;
    void store.load<number[]>('personality', DEFAULTS).then((v) => {
      if (!cancelled && Array.isArray(v) && v.length === DEFAULTS.length) setValues(v);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  function set(i: number, v: number): void {
    setValues((prev) => prev.map((x, j) => (j === i ? v : x)));
    setSaved(false);
  }

  function commit(): void {
    void store.save('personality', values);
    setSaved(true);
  }

  return (
    <div style={s.wrap}>
      <button style={s.back} onClick={onBack}>← Back</button>
      <div style={s.inner}>
        <h1 style={s.title}>Shape my personality</h1>
        <p style={s.sub}>Slide the dials, then hit update. I’ll rewrite myself to match.</p>
        <div style={s.dials}>
          {DIALS.map((d, i) => (
            <div key={d.left} style={s.dialRow}>
              <span style={s.labelL}>{d.left}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={values[i]}
                onChange={(e) => set(i, Number(e.target.value))}
                style={s.range}
              />
              <span style={s.labelR}>{d.right}</span>
            </div>
          ))}
        </div>
        <button style={s.update} onClick={commit}>
          ✦ {saved ? 'Personality updated' : 'Update personality'}
        </button>
      </div>
      {/* decorative eyes at the bottom, echoing the mascot */}
      <svg style={s.eyes} viewBox="0 0 400 120" preserveAspectRatio="xMidYMax meet" aria-hidden>
        <polygon points="10,10 180,40 150,110" fill="#fafafa" />
        <circle cx="120" cy="78" r="26" fill="#151206" />
        <polygon points="390,10 220,40 250,110" fill="#fafafa" />
        <circle cx="280" cy="78" r="26" fill="#151206" />
      </svg>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    height: '100%', background: theme.color.accent, color: theme.color.accentText,
    position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column',
  },
  back: {
    position: 'absolute', top: 18, left: 18, zIndex: 2,
    background: 'rgba(0,0,0,0.12)', border: 'none', borderRadius: theme.radius.pill,
    padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: theme.color.accentText,
  },
  inner: { margin: 'auto', width: '100%', maxWidth: 620, padding: 24, textAlign: 'center', zIndex: 2 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 34, margin: 0 },
  sub: { fontSize: 14, opacity: 0.75, margin: '8px 0 32px' },
  dials: { display: 'flex', flexDirection: 'column', gap: 20 },
  dialRow: { display: 'grid', gridTemplateColumns: '110px 1fr 110px', alignItems: 'center', gap: 16 },
  labelL: { textAlign: 'right', fontSize: 15 },
  labelR: { textAlign: 'left', fontSize: 15 },
  range: { width: '100%', accentColor: theme.color.accentText, cursor: 'pointer' },
  update: {
    marginTop: 36, background: theme.color.accentText, color: theme.color.accent,
    border: 'none', borderRadius: theme.radius.sm, padding: '12px 22px', fontSize: 14,
    fontWeight: 600, cursor: 'pointer',
  },
  eyes: { position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)', width: 340, opacity: 0.95 },
};
