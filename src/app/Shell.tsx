// The Luna app frame: left sidebar (assistant pill, New Chat, chat history,
// preferences) + top bar (nav arrows, search, status, notifications) + the
// active page. Routing is local state — no router dep, so it stays offline and
// the PWA shell serves every "route" from one precached document.
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AgentEvent } from '@core/events';
import type { StorageProvider } from '@core/storage';
import { theme } from './theme';
import { createStore, usePersistentState } from './store';
import { useScheduler } from './scheduler';
import { useBridge } from './bridge';
import { useNarrow } from './useNarrow';
import { AUTH_ENABLED } from '../auth/AuthGate';
import { AccountMenu } from '../auth/AccountMenu';
import { PAGE_TITLE } from './nav';
import type { Page } from './nav';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Superpowers } from './pages/Superpowers';
import { Workspace } from './pages/Workspace';
import { Personality } from './pages/Personality';
import { Schedules } from './pages/Schedules';
import { Memory } from './pages/Memory';
import { Library } from './pages/Library';
import { Contacts } from './pages/Contacts';
import { Channels } from './pages/Channels';
import { Messages } from './pages/Messages';
import { Placeholder } from './pages/Placeholder';

export interface ShellProps {
  name?: string;
  send: (text: string) => Promise<void>;
  stop?: () => void;
  draft?: (instruction: string) => Promise<string>;
  registerEmitter: (fn: (e: AgentEvent) => void) => () => void;
  resolveConfirm: (id: string, ok: boolean) => void;
  storageKind: 'fs-access' | 'opfs' | 'fake';
  storage?: StorageProvider;
}

interface ChatSession {
  id: string;
  title: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
  updatedAt: number;
}

export function Shell({ name = 'Luna', send, stop, draft, registerEmitter, resolveConfirm, storageKind, storage }: ShellProps) {
  const [page, setPage] = useState<Page>('home');
  const [history, setHistory] = useState<Page[]>(['home']);
  const online = useOnline();
  const store = useMemo(() => createStore(storage), [storage]);
  const bridge = useBridge();
  const [toast, setToast] = useState<string | null>(null);
  const narrow = useNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  // Collapse the sidebar into an overlay drawer when the viewport gets narrow,
  // and expand it back when there's room.
  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow]);

  function nav(next: Page): void {
    setPage(next);
    setHistory((h) => [...h, next]);
    if (narrow) setSidebarOpen(false); // close the drawer after navigating
  }

  // Persisted chat sessions for the sidebar history.
  const [chats, setChats] = usePersistentState<ChatSession[]>(store, 'chats', []);
  const [currentChatId, setCurrentChatId] = useState(() => crypto.randomUUID());
  function newChat(): void {
    setCurrentChatId(crypto.randomUUID());
    nav('chat');
  }
  function openChat(id: string): void {
    setCurrentChatId(id);
    nav('chat');
  }
  function persistChat(messages: { role: 'user' | 'assistant'; text: string }[]): void {
    if (!messages.length) return;
    setChats((prev) => {
      const title = messages.find((m) => m.role === 'user')?.text.slice(0, 42) || 'New chat';
      const others = prev.filter((c) => c.id !== currentChatId);
      return [{ id: currentChatId, title, messages, updatedAt: Date.now() }, ...others].slice(0, 30);
    });
  }
  const currentMessages = chats.find((c) => c.id === currentChatId)?.messages ?? [];
  const [assistantName, setAssistantName] = usePersistentState<string>(store, 'assistant-name', name);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // Top-bar popovers + a lightweight notifications feed.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notifications, setNotifications] = useState<{ id: string; text: string; ts: number }[]>([]);
  const [unread, setUnread] = useState(0);
  function notify(text: string): void {
    setNotifications((prev) => [{ id: crypto.randomUUID(), text, ts: Date.now() }, ...prev].slice(0, 40));
    setUnread((n) => n + 1);
  }
  // Notify on newly-arrived incoming messages (baseline the first pass so we
  // don't announce the whole cached backlog).
  const seenRef = useRef<Set<string>>(new Set());
  const seenInitRef = useRef(false);
  useEffect(() => {
    const firstPass = !seenInitRef.current;
    for (const c of bridge.conversations) {
      const last = c.messages[c.messages.length - 1];
      if (!last || last.dir !== 'in') continue;
      if (!seenRef.current.has(last.id)) {
        seenRef.current.add(last.id);
        if (!firstPass) notify(`New ${c.channel} message from ${c.from}`);
      }
    }
    seenInitRef.current = true;
  }, [bridge.conversations]);

  // Fire due schedules: surface a toast, jump to chat, and replay the message
  // through the agent so the run streams where the user can see it.
  useScheduler(store, async (sc) => {
    setToast(`⏰ Running schedule “${sc.name}”…`);
    setTimeout(() => setToast(null), 6000);
    notify(`Schedule “${sc.name}” ran`);
    // Open a fresh chat seeded with the schedule's message as the user turn, so
    // the run reads like a normal conversation (bubble + streamed reply).
    const id = crypto.randomUUID();
    setCurrentChatId(id);
    setChats((prev) =>
      [{ id, title: sc.name, messages: [{ role: 'user' as const, text: sc.message }], updatedAt: Date.now() }, ...prev].slice(0, 30),
    );
    setPage('chat');
    if (narrow) setSidebarOpen(false);
    try {
      await send(sc.message);
    } catch {
      /* surfaced via chat status */
    }
  });
  function back(): void {
    setHistory((h) => {
      if (h.length < 2) return h;
      const copy = h.slice(0, -1);
      setPage(copy[copy.length - 1]);
      return copy;
    });
  }

  const q = query.trim().toLowerCase();
  const chatsMatching = (
    q ? chats.filter((c) => (c.title + ' ' + c.messages.map((m) => m.text).join(' ')).toLowerCase().includes(q)) : chats
  ).slice(0, 12);

  const body = useMemo(() => {
    switch (page) {
      case 'home':
        return (
          <Home
            nav={nav}
            name={assistantName}
            store={store}
            storage={storage}
            onEditName={() => {
              setSidebarOpen(true);
              setPrefsOpen(true);
            }}
          />
        );
      case 'chat':
        return (
          <Chat
            key={currentChatId}
            send={send}
            stop={stop}
            registerEmitter={registerEmitter}
            resolveConfirm={resolveConfirm}
            initialMessages={currentMessages}
            onPersist={persistChat}
          />
        );
      case 'messages':
        return <Messages bridge={bridge} draft={draft} />;
      case 'superpowers':
        return <Superpowers storage={storage} />;
      case 'workspace':
        return <Workspace storage={storage} />;
      case 'personality':
        return <Personality onBack={back} store={store} />;
      case 'schedules':
        return <Schedules store={store} />;
      case 'memory':
        return <Memory store={store} />;
      case 'library':
        return <Library onNewChat={() => nav('chat')} />;
      case 'contacts':
        return <Contacts store={store} />;
      case 'channels':
        return <Channels name={assistantName} store={store} bridge={bridge} onOpenMessages={() => nav('messages')} />;
      default:
        return <Placeholder page={page} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, assistantName, send, stop, draft, registerEmitter, resolveConfirm, storage, store, bridge, currentChatId, currentMessages]);

  return (
    <div style={s.root}>
      {toast && <div style={s.toast}>{toast}</div>}
      {/* Backdrop behind the drawer on narrow screens */}
      {narrow && sidebarOpen && <div style={s.backdrop} onClick={() => setSidebarOpen(false)} />}
      {/* Sidebar (static on wide, overlay drawer on narrow) */}
      <aside
        style={{
          ...s.sidebar,
          ...(narrow ? s.sidebarDrawer : {}),
          ...(sidebarOpen ? {} : narrow ? s.sidebarHidden : s.sidebarCollapsed),
        }}
      >
        <button
          style={s.assistantPill}
          onClick={() => nav('home')}
          title="Home"
        >
          <span style={s.pillDot}>●●</span> {assistantName}
        </button>
        <button style={s.newChat} onClick={newChat}>
          + New Chat
        </button>
        <button style={s.messagesBtn} onClick={() => nav('messages')}>
          <span style={s.statusDot(bridge.connected)} /> Messages
        </button>
        <div style={s.chatsHead}>▾ Chats</div>
        <div style={s.chatList}>
          {chats.length === 0 && <div style={s.chatEmpty}>No chats yet</div>}
          {chats.map((c) => (
            <button
              key={c.id}
              style={{ ...s.chatItem, ...(page === 'chat' && c.id === currentChatId ? s.chatItemActive : {}) }}
              onClick={() => openChat(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          {prefsOpen && (
            <div style={s.prefsPopover}>
              <div style={s.prefsTitle}>Assistant name</div>
              <input
                style={s.prefsInput}
                value={assistantName}
                onChange={(e) => setAssistantName(e.target.value || 'Luna')}
                onKeyDown={(e) => e.key === 'Enter' && setPrefsOpen(false)}
                autoFocus
              />
              <div style={s.prefsRow}>
                <span style={s.statusDot(online)} /> {online ? 'Online' : 'Offline'} · {storageKind}
              </div>
              <button style={s.prefsAction} onClick={() => { nav('personality'); setPrefsOpen(false); }}>
                Adjust personality →
              </button>
            </div>
          )}
          <button style={s.prefs} onClick={() => setPrefsOpen((o) => !o)}>⚙ Preferences ▴</button>
        </div>
      </aside>

      {/* Main column */}
      <div style={s.main}>
        <header style={s.topbar}>
          <div style={s.topLeft}>
            <IconBtn label="Toggle sidebar" onClick={() => setSidebarOpen((o) => !o)}>▥</IconBtn>
            <IconBtn label="Search" onClick={() => setSearchOpen((o) => !o)}>⌕</IconBtn>
            <IconBtn label="Back" onClick={back} disabled={history.length < 2}>
              ‹
            </IconBtn>
            <IconBtn label="Forward" disabled>
              ›
            </IconBtn>
          </div>
          <div style={s.topTitle}>{page !== 'home' ? PAGE_TITLE[page] : ''}</div>
          <div style={s.topRight}>
            <span style={s.statusDot(online)} title={online ? 'online' : 'offline'} />
            <span style={s.statusText}>{storageKind}</span>
            <div style={{ position: 'relative' }}>
              <IconBtn label="Notifications" onClick={() => { setNotifsOpen((o) => !o); setUnread(0); }}>◔</IconBtn>
              {unread > 0 && <span style={s.badge}>{unread > 9 ? '9+' : unread}</span>}
            </div>
            <IconBtn label="Account" onClick={() => setAccountOpen((o) => !o)}>◍</IconBtn>
          </div>

          {searchOpen && (
            <Popover onClose={() => setSearchOpen(false)} style={{ left: 52, right: 'auto', width: 300 }}>
              <input style={s.searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats…" autoFocus />
              <div style={s.popList}>
                {chatsMatching.length === 0 && <div style={s.popEmpty}>No matching chats</div>}
                {chatsMatching.map((c) => (
                  <button key={c.id} style={s.popItem} onClick={() => { openChat(c.id); setSearchOpen(false); setQuery(''); }}>
                    {c.title}
                  </button>
                ))}
              </div>
            </Popover>
          )}
          {notifsOpen && (
            <Popover onClose={() => setNotifsOpen(false)} style={{ right: 46, left: 'auto', width: 280 }}>
              <div style={s.popTitle}>Notifications</div>
              <div style={s.popList}>
                {notifications.length === 0 && <div style={s.popEmpty}>Nothing new</div>}
                {notifications.map((n) => (
                  <div key={n.id} style={s.notifItem}>
                    <div>{n.text}</div>
                    <div style={s.notifTime}>{relTime(n.ts)}</div>
                  </div>
                ))}
              </div>
            </Popover>
          )}
          {accountOpen && (
            <Popover onClose={() => setAccountOpen(false)} style={{ right: 8, left: 'auto', width: 220 }}>
              {AUTH_ENABLED ? (
                <SafeBoundary
                  fallback={
                    <div style={{ fontSize: 13, color: theme.color.textDim, lineHeight: 1.5 }}>
                      Signed in. (Account controls load in the full app.)
                    </div>
                  }
                >
                  <AccountMenu />
                </SafeBoundary>
              ) : (
                <div style={{ fontSize: 13, color: theme.color.textDim, lineHeight: 1.5 }}>
                  Sign-in isn’t configured. Your data is stored locally on this device.
                </div>
              )}
            </Popover>
          )}
        </header>
        <main style={s.content}>{body}</main>
      </div>
    </div>
  );
}

// A top-bar popover with a click-away backdrop.
function Popover({ children, onClose, style }: { children: React.ReactNode; onClose: () => void; style?: CSSProperties }) {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={onClose} />
      <div style={{ ...popoverBase, ...style }}>{children}</div>
    </>
  );
}

const popoverBase: CSSProperties = {
  position: 'absolute',
  top: 46,
  zIndex: 60,
  background: theme.color.panel,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  padding: 10,
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

// Catches the case where AccountMenu's Clerk hooks run without a provider
// (e.g. the dev preview harness), showing a fallback instead of crashing.
class SafeBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function relTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      style={{ ...s.iconBtn, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer' }}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const s = {
  root: {
    display: 'flex',
    height: '100vh',
    background: theme.color.bg,
    color: theme.color.text,
    fontFamily: theme.font.sans,
  } as CSSProperties,
  sidebar: {
    width: 232,
    flexShrink: 0,
    background: theme.color.bg,
    borderRight: `1px solid ${theme.color.borderSoft}`,
    display: 'flex',
    flexDirection: 'column',
    padding: 14,
    gap: 10,
  } as CSSProperties,
  sidebarDrawer: {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    zIndex: 50,
    boxShadow: '2px 0 24px rgba(0,0,0,0.5)',
  } as CSSProperties,
  sidebarHidden: { display: 'none' } as CSSProperties,
  sidebarCollapsed: { display: 'none' } as CSSProperties,
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 45 } as CSSProperties,
  assistantPill: {
    alignSelf: 'flex-start',
    background: theme.color.accent,
    color: theme.color.accentText,
    border: 'none',
    borderRadius: theme.radius.pill,
    padding: '6px 14px',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  } as CSSProperties,
  pillDot: { fontSize: 9, letterSpacing: -2 } as CSSProperties,
  newChat: {
    alignSelf: 'flex-start',
    background: theme.color.accentSoft,
    color: theme.color.accent,
    border: 'none',
    borderRadius: theme.radius.pill,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  } as CSSProperties,
  messagesBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    background: 'transparent',
    border: 'none',
    color: theme.color.textDim,
    padding: '6px 6px',
    fontSize: 13,
    cursor: 'pointer',
  } as CSSProperties,
  chatsHead: { color: theme.color.textFaint, fontSize: 12, marginTop: 8, padding: '0 4px' } as CSSProperties,
  chatList: { display: 'flex', flexDirection: 'column' } as CSSProperties,
  chatItem: {
    background: 'transparent',
    border: 'none',
    color: theme.color.textDim,
    textAlign: 'left',
    padding: '7px 6px',
    fontSize: 13,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as CSSProperties,
  chatItemActive: { background: theme.color.panel, color: theme.color.text } as CSSProperties,
  chatEmpty: { color: theme.color.textFaint, fontSize: 12, padding: '4px 6px' } as CSSProperties,
  prefs: {
    width: '100%',
    background: 'transparent',
    border: `1px solid ${theme.color.borderSoft}`,
    color: theme.color.textDim,
    borderRadius: theme.radius.pill,
    padding: '7px 12px',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
  } as CSSProperties,
  prefsPopover: {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    left: 0,
    right: 0,
    background: theme.color.panel,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    zIndex: 60,
  } as CSSProperties,
  prefsTitle: { fontSize: 12, color: theme.color.textFaint } as CSSProperties,
  prefsInput: {
    background: theme.color.card,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.sm,
    padding: '8px 10px',
    color: theme.color.text,
    fontSize: 14,
    outline: 'none',
  } as CSSProperties,
  prefsRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.color.textFaint } as CSSProperties,
  prefsAction: {
    background: 'transparent',
    border: `1px solid ${theme.color.borderSoft}`,
    color: theme.color.textDim,
    borderRadius: theme.radius.sm,
    padding: '7px 10px',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
  } as CSSProperties,
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } as CSSProperties,
  topbar: {
    position: 'relative',
    height: 46,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    gap: 12,
    borderBottom: `1px solid ${theme.color.borderSoft}`,
  } as CSSProperties,
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 15,
    height: 15,
    padding: '0 3px',
    borderRadius: 8,
    background: theme.color.accent,
    color: theme.color.accentText,
    fontSize: 10,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  } as CSSProperties,
  searchInput: {
    background: theme.color.card,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.sm,
    padding: '8px 10px',
    color: theme.color.text,
    fontSize: 14,
    outline: 'none',
  } as CSSProperties,
  popList: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' } as CSSProperties,
  popEmpty: { fontSize: 13, color: theme.color.textFaint, padding: '8px 6px' } as CSSProperties,
  popItem: {
    background: 'transparent',
    border: 'none',
    color: theme.color.textDim,
    textAlign: 'left',
    padding: '8px 8px',
    fontSize: 13,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as CSSProperties,
  popTitle: { fontSize: 12, color: theme.color.textFaint, padding: '0 4px' } as CSSProperties,
  notifItem: { padding: '8px 6px', fontSize: 13, color: theme.color.text, borderTop: `1px solid ${theme.color.borderSoft}` } as CSSProperties,
  notifTime: { fontSize: 11, color: theme.color.textFaint, marginTop: 2 } as CSSProperties,
  topLeft: { display: 'flex', alignItems: 'center', gap: 4 } as CSSProperties,
  topTitle: { flex: 1, textAlign: 'center', fontSize: 14, color: theme.color.textDim } as CSSProperties,
  topRight: { display: 'flex', alignItems: 'center', gap: 10 } as CSSProperties,
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: theme.color.textDim,
    fontSize: 16,
    width: 28,
    height: 28,
    borderRadius: 6,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as CSSProperties,
  statusDot: (online: boolean): CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: online ? theme.color.online : theme.color.offline,
  }),
  statusText: { fontSize: 12, color: theme.color.textFaint } as CSSProperties,
  content: { flex: 1, minHeight: 0, overflow: 'hidden' } as CSSProperties,
  toast: {
    position: 'fixed',
    top: 14,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 100,
    background: theme.color.accent,
    color: theme.color.accentText,
    borderRadius: theme.radius.pill,
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: 600,
    boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
  } as CSSProperties,
};
