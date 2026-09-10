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

- **mock** — no credentials. Sends a fake incoming message and echoes your
  replies. On by default so you can test the whole loop immediately.
- **telegram** — put a bot token from [@BotFather](https://t.me/BotFather) in
  `config.json` as `{ "telegram": { "token": "..." } }`. Message your bot; it
  appears in Luna. Replies you send go back through the bot.

`config.json` is git-ignored — your tokens never get committed.

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
