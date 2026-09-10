// Superpowers: the skills catalogue. Reads real SKILL.md packages via the
// agent-core discovery over the live StorageProvider, grouped by category with
// search. This is AutoClaw's genuine offline capability surface.
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StorageProvider } from '@core/storage';
import { discoverSkills } from '@core/skills';
import type { SkillMeta } from '@core/skills';
import { theme } from '../theme';

const ICONS: Record<string, string> = {
  Browsing: '🌐', Calendar: '🗓', Commerce: '🛒', Content: '📄', Development: '⟨⟩',
  Email: '✉️', Health: '❤', Integrations: '🔗', Messaging: '💬', Productivity: '⚡',
  System: '⚙', Voice: '🎙', Uncategorized: '✦',
};

// Skills may be authored bilingually (Chinese display_name + English
// display_name_en). Prefer English for this UI: the explicit English label,
// else a non-CJK display_name, else the latin id.
const hasCJK = (s?: string) => !!s && /[　-鿿＀-￯]/.test(s);
function label(sk: SkillMeta): string {
  if (sk.displayNameEn) return sk.displayNameEn;
  if (sk.displayName && !hasCJK(sk.displayName)) return sk.displayName;
  return sk.name;
}
function desc(sk: SkillMeta): string {
  return sk.descriptionEn ?? sk.description ?? '';
}

export function Superpowers({ storage }: { storage?: StorageProvider }) {
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState('All');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!storage) {
      setSkills([]);
      return;
    }
    void (async () => {
      try {
        const { skills } = await discoverSkills(storage, [
          { dir: 'skills-builtin', source: 'builtin' },
          { dir: 'skills', source: 'user' },
        ]);
        if (!cancelled) setSkills(skills);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sk of skills ?? []) {
      const c = sk.category || 'Uncategorized';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? []).filter((sk) => {
      const cat = sk.category || 'Uncategorized';
      if (active !== 'All' && cat !== active) return false;
      if (q && !(`${label(sk)} ${desc(sk)}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [skills, active, query]);

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <h2 style={s.title}>‹ My Superpowers</h2>
      </div>
      <div style={s.banner}>
        ✦ Create a new custom skill by describing what you want in chat, or install plugins to extend your assistant.
      </div>
      <input
        style={s.search}
        placeholder="Search superpowers"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div style={s.body}>
        <div style={s.catCol}>
          <CatRow label="All" count={skills?.length ?? 0} icon="▦" active={active === 'All'} onClick={() => setActive('All')} />
          {categories.map(([cat, n]) => (
            <CatRow key={cat} label={cat} count={n} icon={ICONS[cat] ?? '•'} active={active === cat} onClick={() => setActive(cat)} />
          ))}
        </div>
        <div style={s.list}>
          {err && <div style={s.empty}>Couldn’t load skills: {err}</div>}
          {!err && skills == null && <div style={s.empty}>Loading skills…</div>}
          {!err && skills != null && filtered.length === 0 && (
            <div style={s.empty}>No skills{query ? ' match your search' : ' installed yet'}.</div>
          )}
          {filtered.map((sk) => (
            <div key={sk.dir} style={s.skill}>
              <span style={s.skillIcon}>{ICONS[sk.category || 'Uncategorized'] ?? '✦'}</span>
              <div style={{ minWidth: 0 }}>
                <div style={s.skillTop}>
                  <span style={s.skillName}>{label(sk)}</span>
                  <span style={s.badge}>{sk.source}</span>
                  {sk.version && <span style={s.ver}>v{sk.version}</span>}
                </div>
                <div style={s.skillDesc}>{desc(sk) || 'No description.'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CatRow({ label, count, icon, active, onClick }: { label: string; count: number; icon: string; active: boolean; onClick: () => void }) {
  return (
    <button style={{ ...s.catRow, ...(active ? s.catRowActive : {}) }} onClick={onClick}>
      <span style={s.catIcon}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      <span style={s.catCount}>{count}</span>
    </button>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20, gap: 12, overflow: 'hidden' },
  head: { display: 'flex', alignItems: 'center' },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 22, margin: 0, color: theme.color.text },
  banner: {
    background: theme.color.panel, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md,
    padding: '10px 14px', color: theme.color.textDim, fontSize: 13,
  },
  search: {
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md,
    padding: '10px 14px', color: theme.color.text, fontSize: 14, outline: 'none', fontFamily: theme.font.sans,
  },
  body: { flex: 1, display: 'flex', gap: 16, minHeight: 0 },
  catCol: { width: 190, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' },
  catRow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: theme.radius.sm,
    background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 13, cursor: 'pointer',
  },
  catRowActive: { background: theme.color.panel, color: theme.color.text },
  catIcon: { width: 16, textAlign: 'center' },
  catCount: { color: theme.color.textFaint, fontSize: 12 },
  list: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 },
  empty: { color: theme.color.textFaint, fontSize: 14, padding: 20, textAlign: 'center' },
  skill: {
    display: 'flex', gap: 14, alignItems: 'flex-start', padding: '14px 16px',
    background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md,
  },
  skillIcon: { fontSize: 18, width: 22, textAlign: 'center', flexShrink: 0 },
  skillTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  skillName: { fontSize: 14, fontWeight: 600, color: theme.color.text },
  badge: {
    fontSize: 11, color: theme.color.textDim, background: theme.color.panel,
    border: `1px solid ${theme.color.borderSoft}`, borderRadius: 5, padding: '1px 6px',
  },
  ver: { fontSize: 11, color: theme.color.textFaint },
  skillDesc: { fontSize: 13, color: theme.color.textFaint, marginTop: 4, lineHeight: 1.4 },
};
