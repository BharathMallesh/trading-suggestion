// Chat screen: the empty "New Chat" state with suggestions, plus a live
// transcript streaming tokens from AutoClaw's offline agent. Reuses the agent
// event contract (run_start / token / tool_* / confirm_request / run_end).
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { AgentEvent } from '@core/events';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import type { ConfirmRequest } from '../../ui/ConfirmDialog';
import { ToolTrace } from '../../ui/ToolTrace';
import type { ToolTraceEntry } from '../../ui/ToolTrace';
import { theme } from '../theme';

export interface ChatProps {
  send: (text: string) => Promise<void>;
  stop?: () => void;
  registerEmitter: (fn: (e: AgentEvent) => void) => () => void;
  resolveConfirm: (id: string, ok: boolean) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

const SUGGESTIONS = [
  'Sort out my day',
  "Check today's weather",
  'Triage my inbox',
  'Set a midweek reset reminder',
];

export function Chat({ send, stop, registerEmitter, resolveConfirm }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [trace, setTrace] = useState<ToolTraceEntry[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const confirmQueueRef = useRef<ConfirmRequest[]>([]);
  const confirmOpenRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef('');

  const handlerRef = useRef((e: AgentEvent) => {
    switch (e.event) {
      case 'run_start':
        streamRef.current = '';
        setStreamText('');
        setTrace([]);
        setStatus('thinking…');
        break;
      case 'token':
        streamRef.current += e.text;
        setStreamText(streamRef.current);
        break;
      case 'tool_call':
        setTrace((t) => [...t, { step: e.step, tool: e.tool, args: e.args }]);
        break;
      case 'tool_result':
        setTrace((t) => {
          const idx = t.map((x) => x.bytes != null).lastIndexOf(false);
          if (idx < 0) return t;
          const next = t.slice();
          next[idx] = {
            ...next[idx],
            truncated: e.truncated,
            bytes: e.bytes,
            ...(e.output_file ? { outputFile: e.output_file } : {}),
          };
          return next;
        });
        break;
      case 'confirm_request': {
        const req = { id: e.id, tool: e.tool, args: e.args, reason: e.reason };
        if (confirmOpenRef.current) confirmQueueRef.current.push(req);
        else {
          confirmOpenRef.current = true;
          setConfirm(req);
        }
        break;
      }
      case 'run_end': {
        if (streamRef.current) {
          const text = streamRef.current;
          streamRef.current = '';
          setStreamText('');
          setMessages((m) => [...m, { role: 'assistant', text }]);
        }
        setStatus(null);
        break;
      }
      default:
        break;
    }
  });

  useEffect(() => registerEmitter(handlerRef.current), [registerEmitter]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamText, status]);

  async function onSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: trimmed }]);
    setBusy(true);
    try {
      await send(trimmed);
    } catch (err) {
      setStatus(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSend(input);
    }
  }

  const empty = messages.length === 0 && !streamText && !status;

  return (
    <div style={s.wrap}>
      {empty ? (
        <div style={s.hero}>
          <h1 style={s.heroTitle}>Hey. What are we getting into today?</h1>
          <div style={{ margin: '18px 0 26px' }}>
            <Composer
              input={input}
              setInput={setInput}
              onKeyDown={onKeyDown}
              onSend={() => void onSend(input)}
              onStop={stop}
              busy={busy}
              canStop={!!stop}
            />
          </div>
          <p style={s.suggestLabel}>Try some suggestions:</p>
          <div style={s.suggestGrid}>
            {SUGGESTIONS.map((sug) => (
              <button key={sug} style={s.suggestBtn} onClick={() => void onSend(sug)}>
                {sug}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} style={s.transcript}>
            <div style={s.thread}>
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} style={s.userRow}>
                    <div style={s.userBubble}>{m.text}</div>
                  </div>
                ) : (
                  <div key={i} style={s.assistant}>
                    {m.text}
                  </div>
                ),
              )}
              {streamText && <div style={s.assistant}>{streamText}</div>}
              <ToolTrace entries={trace} />
              {status && <p style={s.status}>{status}</p>}
            </div>
          </div>
          <div style={s.composerDock}>
            <Composer
              input={input}
              setInput={setInput}
              onKeyDown={onKeyDown}
              onSend={() => void onSend(input)}
              onStop={stop}
              busy={busy}
              canStop={!!stop}
            />
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          request={confirm}
          onResolve={(ok) => {
            resolveConfirm(confirm.id, ok);
            const next = confirmQueueRef.current.shift();
            if (next) setConfirm(next);
            else {
              confirmOpenRef.current = false;
              setConfirm(null);
            }
          }}
        />
      )}
    </div>
  );
}

function Composer({
  input,
  setInput,
  onKeyDown,
  onSend,
  onStop,
  busy,
  canStop,
}: {
  input: string;
  setInput: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  canStop: boolean;
}) {
  const showStop = busy && canStop;
  return (
    <div style={s.composer}>
      <textarea
        style={s.input}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Say the word…"
        rows={1}
        autoFocus
      />
      <div style={s.composerBar}>
        <span style={s.pillDim}>◍ Relaxed</span>
        <div style={{ flex: 1 }} />
        <span style={s.pillDim}>✦ Balanced</span>
        {showStop ? (
          <button style={{ ...s.sendBtn, background: theme.color.danger, color: '#fff' }} onClick={onStop} aria-label="Stop">
            ■
          </button>
        ) : (
          <button
            style={{ ...s.sendBtn, opacity: busy || !input.trim() ? 0.5 : 1 }}
            disabled={busy || !input.trim()}
            onClick={onSend}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' },
  hero: {
    margin: 'auto',
    maxWidth: 640,
    width: '100%',
    padding: 24,
    textAlign: 'center',
  },
  heroTitle: { fontFamily: theme.font.serif, fontSize: 30, fontWeight: 400, color: theme.color.text, margin: 0 },
  suggestLabel: { color: theme.color.textFaint, fontSize: 13, margin: '0 0 12px' },
  suggestGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  suggestBtn: {
    padding: '14px 16px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.color.borderSoft}`,
    background: theme.color.panel,
    color: theme.color.textDim,
    fontSize: 14,
    cursor: 'pointer',
  },
  transcript: { flex: 1, overflowY: 'auto', padding: '24px 16px 8px' },
  thread: { maxWidth: 720, width: '100%', margin: '0 auto' },
  userRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 18 },
  userBubble: {
    background: theme.color.panel,
    borderRadius: 14,
    padding: '10px 14px',
    maxWidth: '80%',
    whiteSpace: 'pre-wrap',
    color: theme.color.text,
  },
  assistant: {
    whiteSpace: 'pre-wrap',
    lineHeight: 1.6,
    color: theme.color.text,
    marginBottom: 18,
  },
  status: { color: theme.color.textFaint, fontSize: 13 },
  composerDock: { padding: 16, maxWidth: 720, width: '100%', margin: '0 auto' },
  composer: {
    background: theme.color.panel,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.lg,
    padding: 10,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: theme.color.text,
    fontSize: 15,
    resize: 'none',
    fontFamily: theme.font.sans,
    padding: '6px 8px',
    minHeight: 24,
  },
  composerBar: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 0' },
  pillDim: { color: theme.color.textFaint, fontSize: 13 },
  sendBtn: {
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: theme.color.text,
    color: theme.color.bg,
    fontSize: 15,
    cursor: 'pointer',
  },
};
