// Client for the local connectivity bridge (bridge/server.mjs). Connects to
// ws://localhost:8787, tracks channel status, and groups messages into
// conversations keyed by channel + chatId. Auto-reconnects so starting the
// bridge after the PWA just works.
import { useCallback, useEffect, useRef, useState } from 'react';

export const BRIDGE_URL = 'ws://localhost:8787';

// Conversations are cached locally so they survive a page refresh even when the
// bridge's in-memory replay buffer is empty (e.g. after a bridge restart).
const CACHE_KEY = 'luna-bridge-convos';
const MAX_CONVOS = 50;
const MAX_MSGS = 200;

function loadConvos(): Map<string, Conversation> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return new Map();
    const list = JSON.parse(raw) as Conversation[];
    return new Map(list.map((c) => [c.key, c]));
  } catch {
    return new Map();
  }
}

function saveConvos(convos: Map<string, Conversation>): void {
  try {
    const list = [...convos.values()]
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, MAX_CONVOS)
      .map((c) => (c.messages.length > MAX_MSGS ? { ...c, messages: c.messages.slice(-MAX_MSGS) } : c));
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    /* over quota / unavailable — cache is best-effort */
  }
}

export interface ChannelStatus {
  id: string;
  connected: boolean;
}
export interface BridgeMessage {
  id: string;
  dir: 'in' | 'out';
  from: string;
  text: string;
  subject?: string; // email only
  ts: number;
}
export interface Conversation {
  key: string; // `${channel}:${chatId}`
  channel: string;
  chatId: string;
  from: string; // most recent counterpart name
  messages: BridgeMessage[];
  lastTs: number;
}

export interface Bridge {
  connected: boolean; // WS to the bridge is open
  channels: ChannelStatus[];
  conversations: Conversation[];
  send: (channel: string, chatId: string, text: string, subject?: string) => void;
}

export function useBridge(url: string = BRIDGE_URL): Bridge {
  const [connected, setConnected] = useState(false);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [convos, setConvos] = useState<Map<string, Conversation>>(() => loadConvos());
  const wsRef = useRef<WebSocket | null>(null);

  // Persist whenever conversations change, so a refresh restores them.
  useEffect(() => {
    saveConvos(convos);
  }, [convos]);

  const upsert = useCallback((channel: string, chatId: string, msg: BridgeMessage) => {
    const key = `${channel}:${chatId}`;
    setConvos((prev) => {
      const existing = prev.get(key);
      // Dedupe: a replayed history message we already have is a no-op (keeps the
      // same state reference so React skips a re-render).
      if (existing && existing.messages.some((m) => m.id === msg.id)) return prev;
      const next = new Map(prev);
      const conv: Conversation = existing
        ? { ...existing, messages: [...existing.messages, msg], lastTs: msg.ts, from: msg.dir === 'in' ? msg.from : existing.from }
        : { key, channel, chatId, from: msg.dir === 'in' ? msg.from : 'You', messages: [msg], lastTs: msg.ts };
      next.set(key, conv);
      return next;
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (stopped) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        retry = setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setChannels([]);
        if (!stopped) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        let msg: any;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'status') {
          setChannels(msg.channels ?? []);
        } else if (msg.type === 'incoming') {
          upsert(msg.channel, msg.chatId, { id: msg.id, dir: 'in', from: msg.from, text: msg.text, subject: msg.subject, ts: msg.ts });
        } else if (msg.type === 'sent' && msg.ok) {
          upsert(msg.channel, msg.chatId, { id: 'out-' + msg.ts, dir: 'out', from: 'You', text: msg.text, ts: msg.ts });
        }
      };
    }

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [url, upsert]);

  const send = useCallback((channel: string, chatId: string, text: string, subject?: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'send', channel, chatId, text, subject }));
    }
  }, []);

  const conversations = [...convos.values()].sort((a, b) => b.lastTs - a.lastTs);
  return { connected, channels, conversations, send };
}
