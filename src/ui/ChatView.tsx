import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { AgentEvent } from '@core/events';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmRequest } from './ConfirmDialog';
import { ToolTrace } from './ToolTrace';
import type { ToolTraceEntry } from './ToolTrace';

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0f172a',
    color: '#e2e8f0',
    fontFamily: 'system-ui, sans-serif',
  },
  transcript: { flex: 1, overflowY: 'auto', padding: 16, maxWidth: 760, width: '100%', margin: '0 auto' },
  message: { marginBottom: 16 },
  userBubble: {
    background: '#1e293b',
    borderRadius: 12,
    padding: '10px 14px',
    whiteSpace: 'pre-wrap',
  },
  assistant: { whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  status: { color: '#64748b', fontSize: 13 },
  composer: {
    display: 'flex',
    gap: 8,
    padding: 12,
    maxWidth: 760,
    width: '100%',
    margin: '0 auto',
  },
  input: {
    flex: 1,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    resize: 'vertical' as const,
    minHeight: 44,
  },
  send: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#38bdf8',
    color: '#082f49',
    fontWeight: 600,
    cursor: 'pointer',
  },
};

export interface ChatViewProps {
  send: (text: string) => Promise<void>;
  /** Subscribe to agent events; must return a cleanup that unregisters fn. */
  registerEmitter: (fn: (e: AgentEvent) => void) => () => void;
  resolveConfirm: (id: string, ok: boolean) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export function ChatView({ send, registerEmitter, resolveConfirm }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [trace, setTrace] = useState<ToolTraceEntry[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Concurrent confirm_requests queue: the agent awaits each _confirm promise,
  // so dropping one would hang the run. Served FIFO one dialog at a time.
  // confirmOpenRef mirrors the state so event handling never side-effects
  // inside state updaters (React may re-run updaters in StrictMode).
  const confirmQueueRef = useRef<ConfirmRequest[]>([]);
  const confirmOpenRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Stable handler identity: registered once, reads/writes state via updaters.
  // streamRef mirrors streamText so run_end can finalize without side effects
  // inside state updaters (React may re-run updaters).
  const streamRef = useRef('');
  const handlerRef = useRef((e: AgentEvent) => {
    switch (e.event) {
      case 'run_start':
        streamRef.current = '';
        setStreamText('');
        setTrace([]);
        setStatus('running…');
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
        if (confirmOpenRef.current) {
          confirmQueueRef.current.push(req);
        } else {
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
        setStatus(`run ${e.status} · ${e.steps} step${e.steps === 1 ? '' : 's'}`);
        break;
      }
      default:
        break; // usage
    }
  });

  useEffect(() => {
    return registerEmitter(handlerRef.current);
  }, [registerEmitter]);

  async function onSend(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      await send(text);
    } catch (err) {
      setStatus(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.transcript}>
        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <div key={i} style={styles.message}>
              <div style={styles.userBubble}>{msg.text}</div>
            </div>
          ) : (
            <div key={i} className="assistant-message" style={{ ...styles.message, ...styles.assistant }}>
              {msg.text}
            </div>
          ),
        )}
        {streamText && (
          <div className="assistant-message" style={{ ...styles.message, ...styles.assistant }}>
            {streamText}
          </div>
        )}
        <ToolTrace entries={trace} />
        {status && <p style={styles.status}>{status}</p>}
      </div>
      <div style={styles.composer}>
        <textarea
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button
          style={busy ? { ...styles.send, opacity: 0.5 } : styles.send}
          disabled={busy}
          onClick={() => void onSend()}
        >
          Send
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          request={confirm}
          onResolve={(ok) => {
            resolveConfirm(confirm.id, ok);
            const next = confirmQueueRef.current.shift();
            if (next) {
              setConfirm(next);
            } else {
              confirmOpenRef.current = false;
              setConfirm(null);
            }
          }}
        />
      )}
    </div>
  );
}
