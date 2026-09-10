// Luna connectivity bridge. Runs on your machine, connects out to messaging
// channels, and relays them to the offline PWA over a localhost WebSocket.
// The AI never runs here — this process only does channel I/O.
//
//   cd bridge && npm install && npm start
//
// Config: copy config.example.json -> config.json and fill in tokens.
// Protocol (JSON over ws://localhost:8787):
//   server -> client: {type:'status', channels:[{id,connected}]}
//                     {type:'incoming', channel, chatId, from, text, id, ts}
//                     {type:'sent', channel, chatId, ok, text?, error?, ts}
//   client -> server: {type:'send', channel, chatId, text}
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMock } from './channels/mock.mjs';
import { createTelegram } from './channels/telegram.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT) || 8787;

const configPath = join(here, 'config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};

/** Connected WS clients (usually just the one PWA tab). */
const clients = new Set();
/** Recent incoming/sent events, replayed to newly-connected clients so a tab
 * that opens after a message arrived still sees it. Capped to the last 100. */
const history = [];
function record(msg) {
  history.push(msg);
  if (history.length > 100) history.shift();
}
function broadcast(msg) {
  if (msg.type === 'incoming' || msg.type === 'sent') record(msg);
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

/** id -> { connected, send(chatId,text), stop?() } */
const channels = {};
const hooks = {
  onIncoming: (channel, m) => broadcast({ type: 'incoming', channel, ...m }),
  setConnected: (id, connected) => {
    if (channels[id]) channels[id].connected = connected;
    broadcast(statusMsg());
  },
};

// Register channels. Mock is on unless explicitly disabled; real channels turn
// on only when configured, so an empty config still gives a working demo.
if (config.mock?.enabled !== false) channels.mock = createMock(hooks);
if (config.telegram?.token) channels.telegram = createTelegram(config.telegram, hooks);

function statusMsg() {
  return {
    type: 'status',
    channels: Object.entries(channels).map(([id, c]) => ({ id, connected: !!c.connected })),
  };
}

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(statusMsg()));
  for (const m of history) ws.send(JSON.stringify(m)); // replay recent messages
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'send') {
      const ch = channels[msg.channel];
      if (!ch) {
        ws.send(JSON.stringify({ type: 'sent', channel: msg.channel, chatId: msg.chatId, ok: false, error: 'unknown channel' }));
        return;
      }
      try {
        await ch.send(msg.chatId, msg.text);
        broadcast({ type: 'sent', channel: msg.channel, chatId: msg.chatId, ok: true, text: msg.text, ts: Date.now() });
      } catch (e) {
        ws.send(JSON.stringify({ type: 'sent', channel: msg.channel, chatId: msg.chatId, ok: false, error: String(e?.message || e) }));
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

const active = Object.keys(channels);
console.log(`Luna bridge listening on ws://localhost:${PORT}`);
console.log(`Channels: ${active.length ? active.join(', ') : 'none (add tokens to config.json)'}`);
