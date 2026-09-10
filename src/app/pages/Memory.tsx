// Memory: a spatial view of what the assistant has learned. Nodes drift on a
// dark field; new memories land immediately, then "settle" as concepts. Local
// state for now; a later pass reads/writes the workspace memory store.
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import { usePersistentState } from '../store';
import type { Store } from '../store';

interface MemNode {
  id: string;
  text: string;
  status: 'pending' | 'settled';
  x: number; // 0..100 (viewBox %)
  y: number;
  r: number;
}

const SEED: MemNode[] = [
  { id: '1', text: 'Prefers concise, bulleted summaries', status: 'settled', x: 50, y: 24, r: 26 },
  { id: '2', text: 'Timezone: Asia/Calcutta', status: 'settled', x: 68, y: 58, r: 22 },
  { id: '3', text: 'Building the Luna UI on AutoClaw', status: 'pending', x: 33, y: 66, r: 30 },
];

export function Memory({ store }: { store: Store }) {
  const [nodes, setNodes] = usePersistentState<MemNode[]>(store, 'memory', SEED);
  const [zoom, setZoom] = useState(1);
  const [creating, setCreating] = useState(false);
  const [intro, setIntro] = useState(true);
  const [active, setActive] = useState<string | null>(null);

  const activeNode = useMemo(() => nodes.find((n) => n.id === active) ?? null, [nodes, active]);

  function create(text: string): void {
    setNodes((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text, status: 'pending', x: 20 + Math.random() * 60, y: 20 + Math.random() * 60, r: 20 + Math.random() * 12 },
    ]);
    setCreating(false);
  }

  return (
    <div style={s.wrap} onWheel={(e) => setZoom((z) => Math.min(2.4, Math.max(0.5, z - e.deltaY * 0.001)))}>
      <style>{FLOAT_KEYFRAMES}</style>
      <div style={s.toolbar}>
        <button style={s.create} onClick={() => setCreating(true)}>＋ Create memory</button>
      </div>

      {intro && (
        <div style={s.intro}>
          <button style={s.introClose} onClick={() => setIntro(false)}>✕</button>
          <div style={s.introTitle}>✦ This is your assistant’s mind</div>
          <p style={s.introBody}>
            Every idea it learns, and the links it draws between them, show up here. The map grows and
            rearranges itself as you talk — the more you share, the richer it gets.
          </p>
        </div>
      )}

      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" style={{ ...s.canvas, transform: `scale(${zoom})` }}>
        {/* faint links between the first few nodes */}
        {nodes.slice(1).map((n) => (
          <line key={`l-${n.id}`} x1={nodes[0].x} y1={nodes[0].y} x2={n.x} y2={n.y} stroke={theme.color.borderSoft} strokeWidth={0.2} />
        ))}
        {nodes.map((n, i) => (
          <g
            key={n.id}
            style={{ animation: `memfloat ${6 + (i % 4)}s ease-in-out ${i * 0.4}s infinite`, cursor: 'pointer' }}
            onClick={() => setActive(n.id)}
          >
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r / 6}
              fill={n.status === 'pending' ? '#5a4e12' : '#2a2a1c'}
              stroke={n.status === 'pending' ? theme.color.accent : theme.color.border}
              strokeWidth={0.2}
              strokeDasharray={n.status === 'pending' ? '0.6 0.6' : undefined}
            />
          </g>
        ))}
      </svg>

      {activeNode && (
        <div style={s.tooltip} onClick={() => setActive(null)}>
          <span style={{ color: activeNode.status === 'pending' ? theme.color.accent : theme.color.textDim, marginRight: 6 }}>●</span>
          {activeNode.text}
        </div>
      )}

      <div style={s.legend}>
        <span style={s.legendDot} /> Pending
      </div>
      <div style={s.hint}>drag to rotate · scroll to zoom</div>

      {creating && <CreateMemory onClose={() => setCreating(false)} onCreate={create} />}
    </div>
  );
}

function CreateMemory({ onClose, onCreate }: { onClose: () => void; onCreate: (t: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHead}>
          <h3 style={s.modalTitle}>New memory</h3>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>
        <label style={s.field}>What should I remember?
          <textarea style={s.textarea} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer concise, bulleted summaries." autoFocus />
        </label>
        <p style={s.modalHint}>It lands on the map right away, then settles into a concept as it’s filed.</p>
        <div style={s.modalFoot}>
          <button style={s.ghost} onClick={onClose}>Cancel</button>
          <button style={{ ...s.primary, opacity: text.trim() ? 1 : 0.5 }} onClick={() => text.trim() && onCreate(text.trim())}>Create memory</button>
        </div>
      </div>
    </div>
  );
}

const FLOAT_KEYFRAMES = `@keyframes memfloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.4px); } }`;

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', position: 'relative', overflow: 'hidden', background: theme.color.bg },
  toolbar: { position: 'absolute', top: 14, right: 16, zIndex: 3 },
  create: {
    background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.pill,
    padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  intro: {
    position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 3,
    width: 360, background: theme.color.panel, border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.md, padding: '14px 16px',
  },
  introClose: { position: 'absolute', top: 8, right: 10, background: 'transparent', border: 'none', color: theme.color.textFaint, cursor: 'pointer' },
  introTitle: { fontSize: 14, color: theme.color.text, marginBottom: 6 },
  introBody: { fontSize: 13, color: theme.color.textFaint, margin: 0, lineHeight: 1.5 },
  canvas: { width: '100%', height: '100%', display: 'block', transformOrigin: 'center', transition: 'transform 0.1s' },
  tooltip: {
    position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 3,
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '8px 14px', fontSize: 13, color: theme.color.text, maxWidth: 420, cursor: 'pointer',
  },
  legend: { position: 'absolute', bottom: 16, left: 16, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.color.textFaint },
  legendDot: { width: 8, height: 8, borderRadius: '50%', background: theme.color.accent, display: 'inline-block' },
  hint: { position: 'absolute', bottom: 16, right: 16, fontSize: 12, color: theme.color.textFaint },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
  modal: {
    width: 420, background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
    padding: 20, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: theme.font.sans,
  },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, color: theme.color.text },
  close: { background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 16, cursor: 'pointer' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: theme.color.textDim },
  textarea: {
    background: theme.color.card, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '10px 12px', color: theme.color.text, fontSize: 14, outline: 'none', minHeight: 70, resize: 'vertical', fontFamily: theme.font.sans,
  },
  modalHint: { fontSize: 12, color: theme.color.textFaint, margin: 0 },
  modalFoot: { display: 'flex', justifyContent: 'flex-end', gap: 10 },
  ghost: { background: 'transparent', border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '9px 16px', fontSize: 14, cursor: 'pointer' },
  primary: { background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.sm, padding: '9px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
