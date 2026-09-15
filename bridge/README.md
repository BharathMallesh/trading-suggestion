# Luna Bridge

A small **local** server that connects Luna to real messaging channels. It runs
on your machine, holds your channel tokens, connects out to Telegram/Slack/etc.,
and relays messages to the offline PWA over a `localhost` WebSocket.

**The AI never runs here.** The model stays on-device in the browser; this
process only does network I/O for channels.

## Run

```bash
cd bridge
npm install
cp config.example.json config.json   # then edit config.json
npm start
```

It listens on `ws://localhost:8787`. The PWA connects automatically and shows a
green dot when the bridge is up.

## Channels

A channel turns on only when it's configured, so an empty config still gives you
the working mock demo. `config.json` is git-ignored — tokens never get committed.

### mock
No credentials. Sends a fake incoming message and echoes your replies. On by
default. `{ "mock": { "enabled": true } }`

### telegram
Get a bot token from [@BotFather](https://t.me/BotFather). Message your bot; it
appears in Luna, and your replies go back through it.
```json
{ "telegram": { "token": "123456:ABC-..." } }
```

### slack (Socket Mode)
Create a Slack app, enable **Socket Mode**, add an **app-level token** (`xapp-…`,
scope `connections:write`) and a **bot token** (`xoxb-…`, scope `chat:write`),
and subscribe to the `message.channels` / `message.im` events. No public URL
needed. Invite the bot to a channel or DM it.
```json
{ "slack": { "appToken": "xapp-...", "botToken": "xoxb-..." } }
```

### email (IMAP + SMTP)
Use an **app password** (Gmail/Outlook require one — not your login password).
Incoming mail is polled every 30s; replies are sent over SMTP as `Re: …`.
```json
{ "email": {
    "imap": { "host": "imap.gmail.com", "port": 993, "secure": true,
              "user": "you@gmail.com", "pass": "app-password" },
    "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true,
              "user": "you@gmail.com", "pass": "app-password" },
    "from": "You <you@gmail.com>"
} }
```

## Protocol (JSON over WebSocket)

- server → client: `{type:'status', channels:[{id,connected}]}`,
  `{type:'incoming', channel, chatId, from, text, id, ts}`,
  `{type:'sent', channel, chatId, ok, text?, error?, ts}`
- client → server: `{type:'send', channel, chatId, text}`

## Security notes

- Tokens live only in your local `config.json`.
- The bridge listens on localhost only. Don't expose the port publicly.
- In a production (https) deploy the browser blocks `ws://` (mixed content) —
  you'd front the bridge with `wss://`. For local use `ws://localhost` is fine.
