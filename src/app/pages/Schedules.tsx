// Schedules: recurring instructions delivered to the assistant on each fire.
// Local state for now; a later pass persists these and wires them to a
// background timer that replays the message through the agent.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import { usePersistentState } from '../store';
import type { Store } from '../store';

type Repeat = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly';
interface Schedule {
  id: string;
  name: string;
  description: string;
  repeat: Repeat;
  hour: number;
  minute: number;
  ampm: 'AM' | 'PM';
  message: string;
}

export function Schedules({ store }: { store: Store }) {
  const [items, setItems] = usePersistentState<Schedule[]>(store, 'schedules', []);
  const [creating, setCreating] = useState(false);

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <h2 style={s.title}>‹ Schedules</h2>
      </div>
      {items.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>🗓</div>
          <h3 style={s.emptyTitle}>No schedules yet</h3>
          <p style={s.emptySub}>Ask your assistant to set one up, or create one yourself.</p>
          <button style={s.primary} onClick={() => setCreating(true)}>Create schedule</button>
        </div>
      ) : (
        <div style={s.list}>
          {items.map((it) => (
            <div key={it.id} style={s.card}>
              <button
                style={s.deleteBtn}
                title="Delete schedule"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
              >
                ✕
              </button>
              <div style={s.cardName}>{it.name}</div>
              <div style={s.cardWhen}>{describe(it)}</div>
              {it.message && <div style={s.cardMsg}>{it.message}</div>}
            </div>
          ))}
          <button style={s.addBtn} onClick={() => setCreating(true)}>+ New schedule</button>
        </div>
      )}
      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreate={(sc) => {
            setItems((prev) => [...prev, sc]);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function describe(sc: Schedule): string {
  if (sc.repeat === 'Hourly') return 'Runs every hour';
  const t = `${sc.hour}:${String(sc.minute).padStart(2, '0')} ${sc.ampm}`;
  if (sc.repeat === 'Daily') return `Runs every day at ${t}`;
  if (sc.repeat === 'Weekly') return `Runs every week at ${t}`;
  return `Runs monthly at ${t}`;
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (s: Schedule) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repeat, setRepeat] = useState<Repeat>('Daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [ampm, setAmpm] = useState<'AM' | 'PM'>('AM');
  const [message, setMessage] = useState('');

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function submit(): void {
    if (!name.trim() || !message.trim()) return;
    onCreate({ id: crypto.randomUUID(), name: name.trim(), description, repeat, hour, minute, ampm, message: message.trim() });
  }

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHead}>
          <div>
            <h3 style={s.modalTitle}>Create schedule</h3>
            <p style={s.modalSub}>Schedule a recurring instruction. The message is delivered to the assistant on each fire.</p>
          </div>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>

        <label style={s.field}>Name
          <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" />
        </label>
        <label style={s.field}>Description
          <textarea style={{ ...s.input, minHeight: 54, resize: 'vertical' }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this schedule for?" />
        </label>

        <div style={s.field}>Repeat
          <div style={s.segment}>
            {(['Hourly', 'Daily', 'Weekly', 'Monthly'] as Repeat[]).map((r) => (
              <button key={r} style={{ ...s.segBtn, ...(repeat === r ? s.segActive : {}) }} onClick={() => setRepeat(r)}>{r}</button>
            ))}
          </div>
        </div>

        {repeat !== 'Hourly' && (
          <div style={s.timeRow}>
            <span style={{ color: theme.color.textDim, fontSize: 13 }}>At time</span>
            <select style={s.select} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span>:</span>
            <select style={s.select} value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
              {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
            </select>
            <div style={s.segment}>
              {(['AM', 'PM'] as const).map((a) => (
                <button key={a} style={{ ...s.segBtn, ...(ampm === a ? s.segActive : {}) }} onClick={() => setAmpm(a)}>{a}</button>
              ))}
            </div>
          </div>
        )}

        <div style={s.hint}>
          🕑 {describe({ id: '', name, description, repeat, hour, minute, ampm, message })}
          <div style={{ color: theme.color.textFaint, fontSize: 12 }}>Times use your timezone — {tz}.</div>
        </div>

        <label style={s.field}>Message
          <textarea style={{ ...s.input, minHeight: 64, resize: 'vertical' }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What should the assistant do on each fire?" />
        </label>

        <div style={s.modalFoot}>
          <button style={s.ghost} onClick={onClose}>Cancel</button>
          <button style={{ ...s.primary, opacity: name.trim() && message.trim() ? 1 : 0.5 }} onClick={submit}>Create schedule</button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20 },
  head: { marginBottom: 8 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 22, margin: 0, color: theme.color.text },
  empty: { margin: 'auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  emptyIcon: { fontSize: 30, opacity: 0.6 },
  emptyTitle: { fontFamily: theme.font.serif, fontWeight: 400, margin: 0, color: theme.color.text },
  emptySub: { color: theme.color.textFaint, fontSize: 14, margin: '0 0 12px' },
  list: { display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' },
  card: { position: 'relative', background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md, padding: 16 },
  deleteBtn: { position: 'absolute', top: 10, right: 12, background: 'transparent', border: 'none', color: theme.color.textFaint, fontSize: 14, cursor: 'pointer' },
  cardName: { fontSize: 15, color: theme.color.text },
  cardWhen: { fontSize: 13, color: theme.color.textFaint, marginTop: 2 },
  cardMsg: { fontSize: 13, color: theme.color.textDim, marginTop: 8 },
  addBtn: {
    alignSelf: 'flex-start', background: 'transparent', border: `1px solid ${theme.color.border}`,
    color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '8px 14px', fontSize: 13, cursor: 'pointer',
  },
  primary: {
    background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.sm,
    padding: '9px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 50,
  },
  modal: {
    width: 460, maxHeight: '86vh', overflowY: 'auto', background: theme.color.panel,
    border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg, padding: 20,
    display: 'flex', flexDirection: 'column', gap: 14, fontFamily: theme.font.sans,
  },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  modalTitle: { margin: 0, fontSize: 18, color: theme.color.text },
  modalSub: { margin: '4px 0 0', fontSize: 12, color: theme.color.textFaint, lineHeight: 1.4 },
  close: { background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 16, cursor: 'pointer' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: theme.color.textDim },
  input: {
    background: theme.color.card, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '9px 11px', color: theme.color.text, fontSize: 14, outline: 'none', fontFamily: theme.font.sans,
  },
  segment: { display: 'flex', gap: 2, background: theme.color.card, borderRadius: theme.radius.sm, padding: 3, border: `1px solid ${theme.color.borderSoft}` },
  segBtn: { flex: 1, background: 'transparent', border: 'none', color: theme.color.textDim, padding: '7px 10px', fontSize: 13, borderRadius: 6, cursor: 'pointer' },
  segActive: { background: theme.color.bg, color: theme.color.text },
  timeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  select: { background: theme.color.card, border: `1px solid ${theme.color.border}`, color: theme.color.text, borderRadius: 6, padding: '6px 8px', fontSize: 13 },
  hint: { background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.sm, padding: '10px 12px', fontSize: 13, color: theme.color.textDim },
  modalFoot: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  ghost: { background: 'transparent', border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '9px 16px', fontSize: 14, cursor: 'pointer' },
};
