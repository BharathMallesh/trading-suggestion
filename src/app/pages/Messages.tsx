// Messages: conversations relayed by the local bridge. Pick a conversation and
// reply — the reply is sent back out through its channel (Telegram, mock, …).
// If the bridge isn't running, shows how to start it.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { theme } from '../theme';
import type { Bridge, Conversation } from '../bridge';

const CHANNEL_ICON: Record<string, string> = {
  mock: '🧪', telegram: '➤', slack: '#', discord: '🎮', email: '✉', teams: '👥',
};

export function Messages({ bridge }: { bridge: Bridge }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const convos = bridge.conversations;
  const active = convos.find((c) => c.key === selected) ?? convos[0] ?? null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.messages.length]);

  function sendReply(): void {
    const text = draft.trim();
    if (!text || !active) return;
    bridge.send(active.channel, active.chatId, text);
    setDraft('');
  }

  function startNew(channel: string, to: string, text: string): void {
    bridge.send(channel, to, text);
    setSelected(`${channel}:${to}`); // the 'sent' echo will create/fill this conversation
    setComposing(false);
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <h2 style={s.title}>‹ Messages</h2>
        <div style={s.status}>
          <span style={s.dot(bridge.connected)} />
          {bridge.connected ? (
            <>Bridge connected{bridge.channels.length ? ` · ${bridge.channels.map((c) => c.id).join(', ')}` : ''}</>
          ) : (
            'Bridge offline'
          )}
        </div>
      </div>

      {!bridge.connected && convos.length === 0 ? (
        <BridgeHelp />
      ) : (
        <div style={s.body}>
          <div style={s.list}>
            <button style={s.newBtn} onClick={() => setComposing(true)}>＋ New message</button>
            {convos.length === 0 && <div style={s.empty}>No conversations yet.</div>}
            {convos.map((c) => (
              <ConvoRow key={c.key} c={c} active={active?.key === c.key} onClick={() => setSelected(c.key)} />
            ))}
          </div>
          <div style={s.thread}>
            {!active ? (
              <div style={s.empty}>Select a conversation</div>
            ) : (
              <>
                <div style={s.threadHead}>
                  <span style={s.badge}>{CHANNEL_ICON[active.channel] ?? '•'} {active.channel}</span>
                  <span style={s.threadName}>{active.from}</span>
                  <span style={s.threadId}>· {active.chatId}</span>
                </div>
                <div ref={scrollRef} style={s.msgs}>
                  {active.messages.map((m) => (
                    <div key={m.id} style={{ ...s.row, justifyContent: m.dir === 'out' ? 'flex-end' : 'flex-start' }}>
                      <div style={{ ...s.bubble, ...(m.dir === 'out' ? s.out : s.in) }}>{m.text}</div>
                    </div>
                  ))}
                </div>
                <div style={s.composer}>
                  <textarea
                    style={s.input}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={`Reply to ${active.from}…`}
                    rows={1}
                  />
                  <button
                    style={{ ...s.send, opacity: draft.trim() ? 1 : 0.5 }}
                    disabled={!draft.trim()}
                    onClick={sendReply}
                  >
                    Send ↑
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {composing && (
        <ComposeModal
          channels={bridge.channels.filter((c) => c.connected).map((c) => c.id)}
          onClose={() => setComposing(false)}
          onSend={startNew}
        />
      )}
    </div>
  );
}

function ComposeModal({
  channels,
  onClose,
  onSend,
}: {
  channels: string[];
  onClose: () => void;
  onSend: (channel: string, to: string, text: string) => void;
}) {
  const [channel, setChannel] = useState(channels[0] ?? '');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const placeholder =
    channel === 'email' ? 'name@example.com' : channel === 'telegram' ? 'chat id (numeric)' : channel === 'slack' ? 'channel or user id' : 'recipient id';

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHead}>
          <h3 style={s.modalTitle}>New message</h3>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>
        {channels.length === 0 ? (
          <p style={s.helpSub}>No channels are connected. Start the bridge and configure a channel first.</p>
        ) : (
          <>
            <label style={s.field}>Channel
              <select style={s.select} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channels.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label style={s.field}>To
              <input style={s.modalInput} value={to} onChange={(e) => setTo(e.target.value)} placeholder={placeholder} />
            </label>
            <label style={s.field}>Message
              <textarea style={{ ...s.modalInput, minHeight: 70, resize: 'vertical' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say hi…" />
            </label>
            <div style={s.modalFoot}>
              <button style={s.ghost} onClick={onClose}>Cancel</button>
              <button
                style={{ ...s.primary, opacity: to.trim() && text.trim() ? 1 : 0.5 }}
                disabled={!to.trim() || !text.trim()}
                onClick={() => onSend(channel, to.trim(), text.trim())}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConvoRow({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  const last = c.messages[c.messages.length - 1];
  return (
    <button style={{ ...s.convo, ...(active ? s.convoActive : {}) }} onClick={onClick}>
      <div style={s.convoTop}>
        <span style={s.badgeSm}>{CHANNEL_ICON[c.channel] ?? '•'}</span>
        <span style={s.convoName}>{c.from}</span>
      </div>
      <div style={s.convoPreview}>
        {last?.dir === 'out' ? 'You: ' : ''}
        {last?.text ?? ''}
      </div>
    </button>
  );
}

function BridgeHelp() {
  return (
    <div style={s.help}>
      <div style={s.helpIcon}>📡</div>
      <h3 style={s.helpTitle}>Start the bridge to connect channels</h3>
      <p style={s.helpSub}>
        The bridge is a small local server that connects Luna to Telegram, Slack, email and more.
        The AI stays on your device — the bridge only does channel I/O.
      </p>
      <pre style={s.code}>cd bridge{'\n'}npm install{'\n'}cp config.example.json config.json{'\n'}npm start</pre>
      <p style={s.helpSub}>It runs the mock channel by default so you can test the round-trip immediately.</p>
    </div>
  );
}

const s: Record<string, CSSProperties> & { dot: (c: boolean) => CSSProperties } = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20, minHeight: 0 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 22, margin: 0, color: theme.color.text },
  status: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.color.textDim },
  dot: (c: boolean) => ({ width: 8, height: 8, borderRadius: '50%', background: c ? theme.color.online : theme.color.offline }),
  body: { flex: 1, display: 'flex', gap: 12, minHeight: 0 },
  list: { width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' },
  convo: {
    textAlign: 'left', background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.md, padding: '10px 12px', cursor: 'pointer', color: theme.color.text,
  },
  convoActive: { borderColor: theme.color.border, background: theme.color.panel },
  convoTop: { display: 'flex', alignItems: 'center', gap: 8 },
  badgeSm: { fontSize: 12, width: 16, textAlign: 'center' },
  convoName: { fontSize: 14, fontWeight: 500 },
  convoPreview: { fontSize: 12, color: theme.color.textFaint, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  thread: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
    background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, borderRadius: theme.radius.md,
  },
  threadHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${theme.color.borderSoft}` },
  badge: { fontSize: 12, color: theme.color.textDim, background: theme.color.panel, border: `1px solid ${theme.color.borderSoft}`, borderRadius: 5, padding: '2px 8px' },
  threadName: { fontSize: 14, color: theme.color.text },
  threadId: { fontSize: 12, color: theme.color.textFaint },
  msgs: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
  row: { display: 'flex' },
  bubble: { maxWidth: '75%', padding: '8px 12px', borderRadius: 12, fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.4 },
  in: { background: theme.color.panel, color: theme.color.text },
  out: { background: theme.color.accent, color: theme.color.accentText },
  composer: { display: 'flex', gap: 8, padding: 12, borderTop: `1px solid ${theme.color.borderSoft}` },
  input: {
    flex: 1, background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '9px 12px', color: theme.color.text, fontSize: 14, outline: 'none', resize: 'none', fontFamily: theme.font.sans,
  },
  send: { background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.sm, padding: '0 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  empty: { margin: 'auto', color: theme.color.textFaint, fontSize: 14 },
  help: { margin: 'auto', maxWidth: 460, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 },
  helpIcon: { fontSize: 30 },
  helpTitle: { fontFamily: theme.font.serif, fontWeight: 400, margin: 0, color: theme.color.text },
  helpSub: { fontSize: 14, color: theme.color.textFaint, margin: 0, lineHeight: 1.5 },
  code: {
    textAlign: 'left', background: theme.color.bg, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '12px 14px', fontSize: 13, color: theme.color.textDim, fontFamily: 'ui-monospace, monospace', width: '100%', boxSizing: 'border-box',
  },
  newBtn: {
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, color: theme.color.text,
    borderRadius: theme.radius.sm, padding: '9px 12px', fontSize: 13, cursor: 'pointer', marginBottom: 4,
  },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
  modal: {
    width: 420, background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
    padding: 20, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: theme.font.sans,
  },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, color: theme.color.text },
  close: { background: 'transparent', border: 'none', color: theme.color.textDim, fontSize: 16, cursor: 'pointer' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: theme.color.textDim },
  select: { background: theme.color.card, border: `1px solid ${theme.color.border}`, color: theme.color.text, borderRadius: theme.radius.sm, padding: '9px 11px', fontSize: 14 },
  modalInput: {
    background: theme.color.card, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '9px 11px', color: theme.color.text, fontSize: 14, outline: 'none', fontFamily: theme.font.sans,
  },
  modalFoot: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  ghost: { background: 'transparent', border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '9px 16px', fontSize: 14, cursor: 'pointer' },
  primary: { background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.sm, padding: '9px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
