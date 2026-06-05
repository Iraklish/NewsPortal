# NewsPortal WhatsApp bridge

A small Node.js sidecar that runs **one** WhatsApp Web session (via
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js)) and exposes a
localhost HTTP API the Python backend polls for chat/group messages.

> ⚠ **Unofficial & against WhatsApp's Terms of Service.** It automates WhatsApp
> Web with a headless browser. WhatsApp can ban the number. Use a number you are
> willing to risk. This is not affiliated with or endorsed by WhatsApp/Meta.

## Run

```bash
cd whatsapp-bridge
npm install          # installs whatsapp-web.js + a bundled Chromium (first run is slow)
npm start            # starts the bridge on http://127.0.0.1:8765
```

First start prints a QR (also served as an image at `/status`). In WhatsApp on
your phone: **Settings → Linked devices → Link a device**, then scan it. The
session is saved under `.wwebjs_auth/`, so you only scan once.

In the NewsPortal app, open the **WhatsApp** page to scan the QR, pick which
chats/groups to track, and fetch their messages (stored as articles under the
`whatsapp` category).

## Config (env vars)

| Var | Default | Purpose |
|---|---|---|
| `WA_BRIDGE_PORT` | `8765` | Port the bridge listens on |
| `WA_BRIDGE_HOST` | `127.0.0.1` | Bind address (keep localhost) |
| `WA_BRIDGE_TOKEN` | _(unset)_ | If set, callers must send `x-bridge-token` |

The backend finds the bridge via `WHATSAPP_BRIDGE_URL` (default
`http://127.0.0.1:8765`) and `WHATSAPP_BRIDGE_TOKEN` (must match `WA_BRIDGE_TOKEN`).

## API

- `GET /status` → `{ ready, authenticated, qr, error }`
- `GET /chats` → `[{ id, name, isGroup, unreadCount, timestamp }]`
- `GET /messages?chatId=<id>&limit=<n>` → recent messages
- `POST /logout`
