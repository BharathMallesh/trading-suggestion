// Home dashboard: the "Hi, I'm Luna" hub — personality snapshot, schedules,
// the mascot, and the row of destination cards. Static snapshot data for now;
// each card navigates to its (future) screen.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StorageProvider } from '@core/storage';
import { discoverSkills } from '@core/skills';
import { theme } from '../theme';
import { Mascot } from '../Mascot';
import { useNarrow } from '../useNarrow';
import type { Page } from '../nav';
import type { Store } from '../store';

// Five personality dials, 0..1 (left label at 0, right label at 1). The values
// here are defaults; Home hydrates the live values from the persisted store.
const DIALS = [
  { left: 'Companion', right: 'Coworker', value: 0.12 },
  { left: 'Gen Z', right: 'Baby Boomer', value: 0.9 },
  { left: 'Independent', right: 'Collaborative', value: 0.12 },
  { left: 'Playful', right: 'Serious', value: 0.5 },
  { left: 'Polite', right: 'Unfiltered', value: 0.95 },
];
const DIAL_DEFAULTS = DIALS.map((d) => d.value);

const SCHEDULES = [
  { name: 'Morning briefing', when: 'Every weekday at 8:00' },
  { name: 'Inbox triage', when: 'Every 2 hours' },
];

interface Counts {
  skills: number;
  memory: number;
  library: number;
  workspace: number;
  contacts: number;
  channels: number;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function cardSub(page: Page, c: Counts | null): string {
  if (!c) return '…';
  switch (page) {
    case 'superpowers':
      return `${plural(c.skills, 'skill')} & plugins`;
    case 'memory':
      return plural(c.memory, 'memory', 'memories');
    case 'library':
      return `${plural(c.library, 'app')} & docs`;
    case 'workspace':
      return plural(c.workspace, 'item');
    case 'contacts':
      return plural(c.contacts, 'person', 'people');
    case 'channels':
      return `${c.channels} configured`;
    default:
      return '';
  }
}

const CARDS: { page: Page; label: string; icon: string }[] = [
  { page: 'superpowers', label: 'Superpowers', icon: '⚡' },
  { page: 'memory', label: 'Memory', icon: '🧠' },
  { page: 'library', label: 'Library', icon: '▦' },
  { page: 'workspace', label: 'Workspace', icon: '🗂' },
  { page: 'contacts', label: 'Contacts', icon: '👥' },
  { page: 'channels', label: 'Channels', icon: '📡' },
];

export function Home({
  nav,
  name = 'Buddy',
  store,
  storage,
  onEditName,
}: {
  nav: (p: Page) => void;
  name?: string;
  store: Store;
  storage?: StorageProvider;
  onEditName?: () => void;
}) {
  const narrow = useNarrow();
  const [values, setValues] = useState<number[]>(DIAL_DEFAULTS);
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;
    void store.load<number[]>('personality', DIAL_DEFAULTS).then((v) => {
      if (!cancelled && Array.isArray(v) && v.length === DIAL_DEFAULTS.length) setValues(v);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [memory, contacts, channels, library] = await Promise.all([
        store.load<unknown[]>('memory', []),
        store.load<unknown[]>('contacts', []),
        store.load<Record<string, unknown>>('channels', {}),
        store.load<unknown[]>('library', []),
      ]);
      let skills = 0;
      let workspace = 0;
      if (storage) {
        try {
          const res = await discoverSkills(storage, [
            { dir: 'skills-builtin', source: 'builtin' },
            { dir: 'skills', source: 'user' },
          ]);
          skills = res.skills.length;
        } catch {
          /* leave 0 */
        }
        try {
          workspace = (await storage.list('')).length;
        } catch {
          /* leave 0 */
        }
      }
      if (!cancelled) {
        setCounts({
          skills,
          workspace,
          memory: Array.isArray(memory) ? memory.length : 0,
          contacts: Array.isArray(contacts) ? contacts.length : 0,
          channels: channels && typeof channels === 'object' ? Object.keys(channels).length : 0,
          library: Array.isArray(library) ? library.length : 0,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, storage]);

  const dials = DIALS.map((d, i) => ({ ...d, value: values[i] }));
  return (
    <div style={narrow ? { ...s.page, overflowY: 'auto' } : s.page}>
      <div style={narrow ? { ...s.grid, gridTemplateColumns: '1fr', flex: 'none' } : s.grid}>
        {/* Personality */}
        <button style={{ ...s.card, ...s.personality }} onClick={() => nav('personality')}>
          <div style={s.cardHead}>
            <span style={s.cardHeadIcon}>✦</span> Personality
          </div>
          <div style={s.dialTop}>
            {dials.map((d) => (
              <span key={d.right} style={{ ...s.dialLabel, opacity: d.value > 0.5 ? 1 : 0.4 }}>
                {d.right}
              </span>
            ))}
          </div>
          <div style={s.bars}>
            {dials.map((d) => {
              const up = d.value > 0.5;
              const mag = Math.abs(d.value - 0.5) * 2; // 0..1
              return (
                <div key={d.left} style={s.barCol}>
                  <div style={s.barTop}>
                    {up && <div style={{ ...s.bar, height: 20 + mag * 44 }} />}
                  </div>
                  <div style={s.barMid} />
                  <div style={s.barBot}>
                    {!up && <div style={{ ...s.bar, height: 20 + mag * 44 }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={s.dialBot}>
            {dials.map((d) => (
              <span key={d.left} style={{ ...s.dialLabel, opacity: d.value < 0.5 ? 1 : 0.4 }}>
                {d.left}
              </span>
            ))}
          </div>
        </button>

        {/* Greeting + mascot (spans center) */}
        <div style={s.center}>
          <h1 style={s.greeting}>
            Hi, I’m {name}
            {onEditName && (
              <button style={s.editName} onClick={onEditName} title="Rename assistant" aria-label="Rename assistant">✎</button>
            )}
          </h1>
          <div style={s.mascotWrap}>
            <Mascot size={300} />
          </div>
        </div>

        {/* Schedules */}
        <button style={{ ...s.card, ...s.schedules }} onClick={() => nav('schedules')}>
          <div style={s.cardHead}>
            <span style={s.cardHeadIcon}>🗓</span> Schedules
          </div>
          <div style={{ marginTop: 12 }}>
            {SCHEDULES.map((sc) => (
              <div key={sc.name} style={s.schedRow}>
                <div style={s.schedName}>{sc.name}</div>
                <div style={s.schedWhen}>{sc.when}</div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <div style={s.schedFoot}>
            <span style={{ color: theme.color.textFaint }}>Set one up →</span>
          </div>
        </button>
      </div>

      {/* Destination cards */}
      <div style={narrow ? { ...s.dock, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } : s.dock}>
        {CARDS.map((c) => (
          <button key={c.page} style={s.navCard} onClick={() => nav(c.page)}>
            <span style={s.navIcon}>{c.icon}</span>
            <span style={s.navLabel}>{c.label}</span>
            <span style={s.navSub}>{cardSub(c.page, counts)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', height: '100%', padding: 20, gap: 16 },
  grid: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.6fr) minmax(280px, 1fr)',
    gap: 16,
    minHeight: 0,
  },
  card: {
    background: theme.color.card,
    border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.lg,
    padding: 20,
    textAlign: 'left',
    color: theme.color.text,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: theme.font.sans,
  },
  personality: { background: theme.color.accentSoft },
  schedules: {},
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, color: theme.color.textDim, fontSize: 14, fontWeight: 500 },
  cardHeadIcon: { fontSize: 13 },
  dialTop: { display: 'flex', justifyContent: 'space-between', marginTop: 16, gap: 4 },
  dialBot: { display: 'flex', justifyContent: 'space-between', gap: 4 },
  dialLabel: { flex: 1, textAlign: 'center', fontSize: 11, color: theme.color.text, lineHeight: 1.2 },
  bars: { display: 'flex', justifyContent: 'space-between', gap: 4, margin: '6px 0' },
  barCol: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' },
  barTop: { height: 64, display: 'flex', alignItems: 'flex-end' },
  barMid: { width: '80%', height: 1, background: `${theme.color.accent}55` },
  barBot: { height: 64, display: 'flex', alignItems: 'flex-start' },
  bar: { width: 8, borderRadius: 6, background: theme.color.accent },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', minHeight: 0 },
  greeting: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 34, margin: '24px 0 0', color: theme.color.text },
  editName: { marginLeft: 10, background: 'transparent', border: 'none', color: theme.color.textFaint, fontSize: 18, cursor: 'pointer', verticalAlign: 'middle' },
  mascotWrap: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 },
  schedRow: { marginBottom: 14 },
  schedName: { fontSize: 14, color: theme.color.text },
  schedWhen: { fontSize: 12, color: theme.color.textFaint, marginTop: 2 },
  schedFoot: { borderTop: `1px solid ${theme.color.borderSoft}`, paddingTop: 10, fontSize: 13 },
  dock: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 },
  navCard: {
    background: theme.color.card,
    border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.md,
    padding: '16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    textAlign: 'left',
    color: theme.color.text,
    cursor: 'pointer',
    fontFamily: theme.font.sans,
  },
  navIcon: { fontSize: 18 },
  navLabel: { fontSize: 14, fontWeight: 500, marginTop: 6 },
  navSub: { fontSize: 12, color: theme.color.textFaint },
};
