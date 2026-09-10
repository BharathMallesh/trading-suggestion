// The Luna app frame: left sidebar (assistant pill, New Chat, chat history,
// preferences) + top bar (nav arrows, search, status, notifications) + the
// active page. Routing is local state — no router dep, so it stays offline and
// the PWA shell serves every "route" from one precached document.
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentEvent } from '@core/events';
import type { StorageProvider } from '@core/storage';
import { theme } from './theme';
import { createStore } from './store';
import { useScheduler } from './scheduler';
import { useBridge } from './bridge';
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
  registerEmitter: (fn: (e: AgentEvent) => void) => () => void;
  resolveConfirm: (id: string, ok: boolean) => void;
  storageKind: 'fs-access' | 'opfs' | 'fake';
  storage?: StorageProvider;
}

const RECENT_CHATS = ['Flagging Inbox Replies', 'Mixed Scope Discussion'];

export function Shell({ name = 'Luna', send, stop, registerEmitter, resolveConfirm, storageKind, storage }: ShellProps) {
  const [page, setPage] = useState<Page>('home');
  const [history, setHistory] = useState<Page[]>(['home']);
  const online = useOnline();
  const store = useMemo(() => createStore(storage), [storage]);
  const bridge = useBridge();
  const [toast, setToast] = useState<string | null>(null);

  function nav(next: Page): void {
    setPage(next);
    setHistory((h) => [...h, next]);
  }

  // Fire due schedules: surface a toast, jump to chat, and replay the message
  // through the agent so the run streams where the user can see it.
  useScheduler(store, async (sc) => {
    setToast(`⏰ Running schedule “${sc.name}”…`);
    setTimeout(() => setToast(null), 6000);
    setPage('chat');
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

  const body = useMemo(() => {
    switch (page) {
      case 'home':
        return <Home nav={nav} name={name} store={store} storage={storage} />;
      case 'chat':
        return <Chat send={send} stop={stop} registerEmitter={registerEmitter} resolveConfirm={resolveConfirm} />;
      case 'messages':
        return <Messages bridge={bridge} />;
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
        return <Channels name={name} store={store} bridge={bridge} onOpenMessages={() => nav('messages')} />;
      default:
        return <Placeholder page={page} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, name, send, stop, registerEmitter, resolveConfirm, storage, store, bridge]);

  return (
    <div style={s.root}>
      {toast && <div style={s.toast}>{toast}</div>}
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <button
          style={s.assistantPill}
          onClick={() => nav('home')}
          title="Home"
        >
          <span style={s.pillDot}>●●</span> {name}
        </button>
        <button style={s.newChat} onClick={() => nav('chat')}>
          + New Chat
        </button>
        <button style={s.messagesBtn} onClick={() => nav('messages')}>
          <span style={s.statusDot(bridge.connected)} /> Messages
        </button>
        <div style={s.chatsHead}>▾ Chats</div>
        <div style={s.chatList}>
          {RECENT_CHATS.map((c) => (
            <button key={c} style={s.chatItem} onClick={() => nav('chat')}>
              {c}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button style={s.prefs}>⚙ Preferences ▴</button>
      </aside>

      {/* Main column */}
      <div style={s.main}>
        <header style={s.topbar}>
          <div style={s.topLeft}>
            <IconBtn label="Toggle sidebar">▥</IconBtn>
            <IconBtn label="Search">⌕</IconBtn>
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
            <IconBtn label="Notifications">◔</IconBtn>
          </div>
        </header>
        <main style={s.content}>{body}</main>
      </div>
    </div>
  );
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
  } as CSSProperties,
  prefs: {
    background: 'transparent',
    border: `1px solid ${theme.color.borderSoft}`,
    color: theme.color.textDim,
    borderRadius: theme.radius.pill,
    padding: '7px 12px',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
  } as CSSProperties,
  main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } as CSSProperties,
  topbar: {
    height: 46,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    gap: 12,
    borderBottom: `1px solid ${theme.color.borderSoft}`,
  } as CSSProperties,
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
