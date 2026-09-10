// Telegram channel via the Bot API. Long-polls getUpdates for incoming
// messages and sends via sendMessage. Get a bot token from @BotFather and put
// it in bridge/config.json as { "telegram": { "token": "..." } }.
export function createTelegram({ token }, { onIncoming, setConnected }) {
  const api = (method, params) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    }).then((r) => r.json());

  let offset = 0;
  let alive = true;

  (async () => {
    try {
      const me = await api('getMe', {});
      setConnected('telegram', !!me.ok);
      if (me.ok) console.log(`[telegram] connected as @${me.result.username}`);
      else console.error('[telegram] getMe failed:', me.description);
    } catch (e) {
      setConnected('telegram', false);
      console.error('[telegram] connect error:', e.message);
    }
    // long-poll loop
    while (alive) {
      try {
        const r = await api('getUpdates', { offset, timeout: 30 });
        if (r.ok) {
          for (const u of r.result) {
            offset = u.update_id + 1;
            const m = u.message;
            if (m?.text) {
              onIncoming('telegram', {
                chatId: String(m.chat.id),
                from: m.from?.first_name || m.chat.title || 'Telegram',
                text: m.text,
                id: String(m.message_id),
                ts: (m.date || 0) * 1000 || Date.now(),
              });
            }
          }
        } else {
          await sleep(3000);
        }
      } catch {
        await sleep(3000); // network blip → back off and retry
      }
    }
  })();

  return {
    connected: false,
    stop() {
      alive = false;
    },
    async send(chatId, text) {
      const r = await api('sendMessage', { chat_id: chatId, text });
      if (!r.ok) throw new Error(r.description || 'sendMessage failed');
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
