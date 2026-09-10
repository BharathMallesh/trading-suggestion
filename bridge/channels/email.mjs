// Email via IMAP (receive) + SMTP (send). Polls the inbox for unseen mail and
// relays each as an incoming message keyed by the sender's address; replies go
// back out over SMTP. Use an app password (Gmail/Outlook require one).
//
// config.json:
// { "email": {
//     "imap": { "host": "imap.gmail.com", "port": 993, "secure": true,
//               "user": "you@gmail.com", "pass": "app-password" },
//     "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true,
//               "user": "you@gmail.com", "pass": "app-password" },
//     "from": "You <you@gmail.com>"
// } }
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

export function createEmail({ imap, smtp, from }, { onIncoming, setConnected }) {
  let alive = true;
  let client = null;
  const subjects = new Map(); // sender address -> last subject (for Re:)

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure ?? smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  async function ensureClient() {
    if (client?.usable) return client;
    client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure ?? true,
      auth: { user: imap.user, pass: imap.pass },
      logger: false,
    });
    await client.connect();
    setConnected('email', true);
    console.log('[email] IMAP connected as', imap.user);
    return client;
  }

  async function poll() {
    if (!alive) return;
    let c;
    try {
      c = await ensureClient();
    } catch (e) {
      setConnected('email', false);
      console.error('[email] connect failed:', e.message);
      client = null;
      return;
    }
    const lock = await c.getMailboxLock('INBOX');
    try {
      for await (const msg of c.fetch({ seen: false }, { source: true, uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const addr = parsed.from?.value?.[0]?.address || 'unknown@unknown';
          const name = parsed.from?.value?.[0]?.name || addr;
          const subject = parsed.subject || '(no subject)';
          const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '').trim();
          subjects.set(addr, subject);
          onIncoming('email', {
            chatId: addr,
            from: name,
            text: `Subject: ${subject}\n\n${body}`,
            id: String(msg.uid),
            ts: parsed.date?.getTime?.() || Date.now(),
          });
          await c.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('[email] parse error:', e.message);
        }
      }
    } catch (e) {
      console.error('[email] poll error:', e.message);
      setConnected('email', false);
      try {
        await client?.logout();
      } catch {
        /* ignore */
      }
      client = null;
    } finally {
      lock.release();
    }
  }

  const iv = setInterval(poll, 30_000);
  poll();

  return {
    connected: false,
    stop() {
      alive = false;
      clearInterval(iv);
      client?.logout().catch(() => {});
    },
    async send(chatId, text) {
      const last = subjects.get(chatId);
      const subject = last ? (/^re:/i.test(last) ? last : `Re: ${last}`) : 'Message from Luna';
      await transport.sendMail({ from: from || smtp.user, to: chatId, subject, text });
    },
  };
}
