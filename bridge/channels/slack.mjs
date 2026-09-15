// Slack via Socket Mode — no public webhook needed. Opens a WebSocket to Slack
// with an app-level token, receives message events, and sends with the bot
// token via chat.postMessage. Uses the bundled `ws` client + fetch, no SDK.
//
// config.json: { "slack": { "appToken": "xapp-...", "botToken": "xoxb-..." } }
// The app needs Socket Mode enabled and the message.* event + chat:write scope.
import WebSocket from 'ws';

export function createSlack({ appToken, botToken }, { onIncoming, setConnected }) {
  let alive = true;
  let ws = null;
  let botUserId = null;

  const web = (method, body) =>
    fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  async function openSocket() {
    if (!alive) return;
    try {
      const auth = await web('auth.test', {});
      botUserId = auth.user_id || null;

      const conn = await fetch('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      }).then((r) => r.json());
      if (!conn.ok) {
        console.error('[slack] apps.connections.open failed:', conn.error);
        setConnected('slack', false);
        return retry();
      }

      ws = new WebSocket(conn.url);
      ws.on('open', () => {
        setConnected('slack', true);
        console.log('[slack] socket connected');
      });
      ws.on('message', (raw) => handleEnvelope(raw));
      ws.on('close', () => {
        setConnected('slack', false);
        retry();
      });
      ws.on('error', () => ws?.close());
    } catch (e) {
      console.error('[slack] connect error:', e.message);
      setConnected('slack', false);
      retry();
    }
  }

  function retry() {
    if (alive) setTimeout(openSocket, 3000);
  }

  function handleEnvelope(raw) {
    let env;
    try {
      env = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Ack every envelope that carries an id, immediately.
    if (env.envelope_id) ws?.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === 'disconnect') return ws?.close(); // Slack asks us to reconnect
    if (env.type !== 'events_api') return;

    const event = env.payload?.event;
    if (!event || event.type !== 'message') return;
    // Ignore edits/deletes/joins and anything the bot itself said (avoid loops).
    if (event.subtype || event.bot_id || (botUserId && event.user === botUserId)) return;
    if (!event.text) return;

    onIncoming('slack', {
      chatId: event.channel,
      from: event.user ? `Slack user ${event.user}` : 'Slack',
      text: event.text,
      id: event.ts,
      ts: Math.round(Number(event.ts) * 1000) || Date.now(),
    });
  }

  openSocket();

  return {
    connected: false,
    stop() {
      alive = false;
      ws?.close();
    },
    async send(chatId, text) {
      const r = await web('chat.postMessage', { channel: chatId, text });
      if (!r.ok) throw new Error(r.error || 'chat.postMessage failed');
    },
  };
}
