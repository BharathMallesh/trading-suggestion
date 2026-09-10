// Email via IMAP (receive) + SMTP (send). Non-intrusive: it NEVER marks your
// mail as read and never touches flags. It relays only messages that arrive
// after the bridge first connects, tracked by IMAP UID and persisted to
// bridge/.email-state.json so restarts pick up where they left off.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.email-state.json');
function loadLastUid() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')).lastUid ?? null;
  } catch {
    return null;
  }
}
function saveLastUid(lastUid) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastUid }));
  } catch {
    /* state is best-effort */
  }
}

export function createEmail({ imap, smtp, from }, { onIncoming, setConnected }) {
  let alive = true;
  let client = null;
  let lastUid = loadLastUid(); // null until we baseline on first connect
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
      // First ever run: baseline to the current top of the mailbox so we only
      // relay NEW mail from here on — never the existing backlog.
      if (lastUid == null) {
        lastUid = Math.max(0, (c.mailbox?.uidNext ?? 1) - 1);
        saveLastUid(lastUid);
        console.log('[email] baselined at uid', lastUid, '— will relay only new mail');
        return;
      }
      // Fetch anything newer than lastUid. Note the IMAP quirk: a range like
      // "N:*" returns the highest UID even when it's below N, so we re-check.
      for await (const msg of c.fetch({ uid: `${lastUid + 1}:*` }, { source: true, uid: true })) {
        if (msg.uid <= lastUid) continue;
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
        } catch (e) {
          console.error('[email] parse error:', e.message);
        }
        lastUid = Math.max(lastUid, msg.uid);
        saveLastUid(lastUid);
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
