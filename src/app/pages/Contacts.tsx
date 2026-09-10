// Contacts: people the assistant knows, and the channels each is verified on
// (so an incoming message can be attributed to the right person). Local state;
// verification/identity wiring lands with the channels connector pass.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import { usePersistentState } from '../store';
import type { Store } from '../store';
import { useNarrow } from '../useNarrow';

type Role = 'Guardian' | 'Assistant' | 'Contact';
interface Contact {
  id: string;
  name: string;
  handle: string;
  role: Role;
  notes: string;
  interactions: number;
}

const SEED: Contact[] = [
  { id: 'you', name: '', handle: 'you', role: 'Guardian', notes: '', interactions: 0 },
  { id: 'luna', name: 'Luna', handle: 'assistant', role: 'Assistant', notes: '', interactions: 0 },
];

const VERIFY_CHANNELS = [
  { id: 'slack', name: 'Slack', icon: '#' },
  { id: 'telegram', name: 'Telegram', icon: '➤' },
  { id: 'discord', name: 'Discord', icon: '🎮' },
  { id: 'phone', name: 'Phone Calling', icon: '📞' },
];

const roleColor: Record<Role, string> = {
  Guardian: '#3a5a2a',
  Assistant: '#5a3a1a',
  Contact: theme.color.panel,
};

export function Contacts({ store }: { store: Store }) {
  const [contacts, setContacts] = usePersistentState<Contact[]>(store, 'contacts', SEED);
  const [selectedId, setSelectedId] = useState('you');
  const selected = contacts.find((c) => c.id === selectedId) ?? contacts[0];
  const narrow = useNarrow();

  function update(patch: Partial<Contact>): void {
    setContacts((prev) => prev.map((c) => (c.id === selectedId ? { ...c, ...patch } : c)));
  }
  function add(): void {
    const id = crypto.randomUUID();
    setContacts((prev) => [...prev, { id, name: '', handle: 'new', role: 'Contact', notes: '', interactions: 0 }]);
    setSelectedId(id);
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <h2 style={s.title}>‹ Contacts</h2>
      </div>
      <div style={narrow ? { ...s.body, flexDirection: 'column', overflowY: 'auto' } : s.body}>
        {/* Entries */}
        <div style={narrow ? { ...s.entries, width: '100%', flexShrink: 0 } : s.entries}>
          <div style={s.entriesHead}>
            <span>Entries</span>
            <button style={s.addSmall} onClick={add}>＋</button>
          </div>
          {contacts.map((c) => {
            const fixed = c.id === 'you' || c.id === 'luna';
            return (
              <div
                key={c.id}
                style={{ ...s.entry, ...(selectedId === c.id ? s.entryActive : {}), cursor: 'pointer' }}
                onClick={() => setSelectedId(c.id)}
              >
                <div>
                  <div style={s.entryName}>{c.id === 'you' ? 'You' : c.name || 'Unnamed'}</div>
                  <div style={s.entryHandle}>{c.handle}</div>
                </div>
                <span style={{ ...s.badge, background: roleColor[c.role] }}>{c.role}</span>
                {!fixed && (
                  <button
                    style={s.entryDelete}
                    title="Delete contact"
                    onClick={(e) => {
                      e.stopPropagation();
                      setContacts((prev) => prev.filter((x) => x.id !== c.id));
                      if (selectedId === c.id) setSelectedId('you');
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
          <button style={s.addContact} onClick={add}>👥 Add Contact</button>
        </div>

        {/* Detail + channels */}
        <div style={s.detailCol}>
          <div style={s.card}>
            <div style={s.detailHead}>
              <div>
                <div style={s.detailName}>{selected.id === 'you' ? 'You' : selected.name || 'Unnamed'}</div>
                <div style={s.detailSub}>{selected.interactions} interactions</div>
              </div>
              <span style={{ ...s.badge, background: roleColor[selected.role] }}>{selected.role}</span>
            </div>
            <label style={s.field}>Name
              <input style={s.input} value={selected.name} onChange={(e) => update({ name: e.target.value })} placeholder="Your name" />
            </label>
            <label style={s.field}>Notes
              <textarea style={{ ...s.input, minHeight: 44, resize: 'vertical' }} value={selected.notes} onChange={(e) => update({ notes: e.target.value })} placeholder="Notes about this person which AI will take into account" />
            </label>
            <div style={s.actions}>
              <button style={s.ghost}>Save</button>
              <button style={s.ghost}>Merge…</button>
            </div>
          </div>

          <div style={s.card}>
            <div style={s.channelsTitle}>Channels</div>
            <p style={s.channelsSub}>Once verified, your assistant will recognize you when you message from these channels.</p>
            {VERIFY_CHANNELS.map((ch) => (
              <div key={ch.id} style={s.verifyRow}>
                <span style={s.verifyIcon}>{ch.icon}</span>
                <span style={{ flex: 1 }}>{ch.name}</span>
                <button style={s.verify}>Verify me</button>
              </div>
            ))}
            <div style={s.verifyRow}>
              <span style={s.verifyIcon}>◎</span>
              <span style={{ flex: 1 }}>Vellum <span style={s.mono}>local-principal-{selected.id.slice(0, 8)}</span></span>
              <span style={s.verified}>✓ Verified</span>
              <button style={s.revoke}>Revoke</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20 },
  head: { marginBottom: 10 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 22, margin: 0, color: theme.color.text },
  body: { flex: 1, display: 'flex', gap: 16, minHeight: 0 },
  entries: {
    width: 240, flexShrink: 0, background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.md, padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
  },
  entriesHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: theme.color.textDim, fontSize: 14, padding: '2px 4px 6px' },
  addSmall: { background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 16, cursor: 'pointer' },
  entry: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 10px',
    borderRadius: theme.radius.sm, background: 'transparent', border: '1px solid transparent', color: theme.color.text, cursor: 'pointer',
  },
  entryActive: { background: theme.color.panel, borderColor: theme.color.borderSoft },
  entryName: { fontSize: 14 },
  entryHandle: { fontSize: 12, color: theme.color.textFaint, marginTop: 1 },
  badge: { fontSize: 11, color: theme.color.text, borderRadius: 5, padding: '2px 8px' },
  entryDelete: { background: 'transparent', border: 'none', color: theme.color.textFaint, fontSize: 12, cursor: 'pointer', padding: '0 2px' },
  addContact: {
    marginTop: 6, background: 'transparent', border: `1px solid ${theme.color.borderSoft}`, color: theme.color.textDim,
    borderRadius: theme.radius.sm, padding: '8px 10px', fontSize: 13, cursor: 'pointer',
  },
  detailCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' },
  card: { background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 },
  detailHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  detailName: { fontSize: 18, color: theme.color.text },
  detailSub: { fontSize: 12, color: theme.color.textFaint, marginTop: 2 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: theme.color.textDim },
  input: {
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '10px 12px', color: theme.color.text, fontSize: 14, outline: 'none', fontFamily: theme.font.sans,
  },
  actions: { display: 'flex', gap: 10 },
  ghost: { background: theme.color.panel, border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '8px 16px', fontSize: 13, cursor: 'pointer' },
  channelsTitle: { fontSize: 16, color: theme.color.text },
  channelsSub: { fontSize: 13, color: theme.color.textFaint, margin: 0 },
  verifyRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${theme.color.borderSoft}`, fontSize: 14, color: theme.color.text },
  verifyIcon: { width: 18, textAlign: 'center', color: theme.color.textDim },
  verify: { background: 'transparent', border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: theme.color.textFaint },
  verified: { fontSize: 12, color: theme.color.online, background: theme.color.panel, borderRadius: 5, padding: '3px 8px' },
  revoke: { background: theme.color.danger, border: 'none', color: '#fff', borderRadius: theme.radius.sm, padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
};
