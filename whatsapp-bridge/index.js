/**
 * NewsPortal WhatsApp bridge.
 *
 * Runs a single WhatsApp Web session (via whatsapp-web.js / Puppeteer) and
 * exposes a tiny localhost HTTP API the Python backend / UI drives:
 *
 *   GET  /status                      -> { ready, authenticated, connecting, qr }
 *   POST /connect                     -> start the session (emits a QR to scan)
 *   POST /disconnect                  -> tear down the session
 *   GET  /chats                       -> [{ id, name, isGroup, unreadCount, timestamp }]
 *   GET  /messages?chatId=..&limit=.. -> [{ id, chatId, author, authorName, body, timestamp, type, hasMedia }]
 *
 * MANUAL ONLY: the session does NOT start on boot. It connects only when
 * /connect is called (from the UI "Connect" button), and on disconnect it does
 * NOT auto-reconnect. The session is persisted by LocalAuth under
 * ./.wwebjs_auth, so after the first scan a /connect restores it without a QR.
 *
 * Auth: optionally set WA_BRIDGE_TOKEN; if set, every request must send
 * `x-bridge-token: <token>`.
 *
 * ⚠ Unofficial — automates WhatsApp Web and violates WhatsApp's ToS. Use a
 * number you are willing to risk being banned.
 */
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')

const PORT = parseInt(process.env.WA_BRIDGE_PORT || '8765', 10)
const HOST = process.env.WA_BRIDGE_HOST || '127.0.0.1'
const TOKEN = (process.env.WA_BRIDGE_TOKEN || '').trim()

const state = {
  ready: false,
  authenticated: false,
  connecting: false,
  qrDataUrl: null, // PNG data URL while waiting for scan
  lastError: null,
}

let client = null

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  })

  c.on('qr', async (qr) => {
    try {
      state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
      state.authenticated = false
      state.ready = false
      console.log('[wa-bridge] QR generated — scan it from WhatsApp > Linked devices')
    } catch (e) {
      console.error('[wa-bridge] QR encode failed:', e)
    }
  })

  c.on('authenticated', () => {
    state.authenticated = true
    state.qrDataUrl = null
    console.log('[wa-bridge] authenticated')
  })

  c.on('ready', () => {
    state.ready = true
    state.authenticated = true
    state.connecting = false
    state.qrDataUrl = null
    console.log('[wa-bridge] client ready')
  })

  c.on('auth_failure', (m) => {
    state.authenticated = false
    state.ready = false
    state.connecting = false
    state.lastError = String(m)
    console.error('[wa-bridge] auth failure:', m)
  })

  // No auto-reconnect — manual only.
  c.on('disconnected', (reason) => {
    state.ready = false
    state.authenticated = false
    state.connecting = false
    state.qrDataUrl = null
    state.lastError = `disconnected: ${reason}`
    console.warn('[wa-bridge] disconnected:', reason)
    client = null
  })

  return c
}

async function connect() {
  if (client) return
  state.connecting = true
  state.lastError = null
  state.qrDataUrl = null
  client = buildClient()
  try {
    await client.initialize()
  } catch (e) {
    state.connecting = false
    state.lastError = String(e)
    client = null
    console.error('[wa-bridge] initialize failed:', e)
    throw e
  }
}

async function disconnect() {
  const c = client
  client = null
  state.ready = false
  state.authenticated = false
  state.connecting = false
  state.qrDataUrl = null
  if (c) {
    try { await c.destroy() } catch (e) { /* ignore */ }
  }
}

// ── HTTP API ──────────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

app.use((req, res, next) => {
  if (TOKEN && req.headers['x-bridge-token'] !== TOKEN) {
    return res.status(401).json({ error: 'bad bridge token' })
  }
  next()
})

app.get('/status', (req, res) => {
  res.json({
    ready: state.ready,
    authenticated: state.authenticated,
    connecting: state.connecting,
    qr: state.qrDataUrl,
    error: state.lastError,
  })
})

app.post('/connect', async (req, res) => {
  try {
    await connect()
    res.json({ ok: true, connecting: state.connecting, ready: state.ready })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post('/disconnect', async (req, res) => {
  try {
    await disconnect()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/chats', async (req, res) => {
  if (!state.ready || !client) return res.status(409).json({ error: 'client not ready' })
  try {
    const chats = await client.getChats()
    res.json(chats.map((c) => ({
      id: c.id._serialized,
      name: c.name || c.formattedTitle || c.id.user,
      isGroup: !!c.isGroup,
      unreadCount: c.unreadCount || 0,
      timestamp: c.timestamp || null,
    })))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/messages', async (req, res) => {
  if (!state.ready || !client) return res.status(409).json({ error: 'client not ready' })
  const chatId = String(req.query.chatId || '')
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '50', 10) || 50, 500))
  if (!chatId) return res.status(400).json({ error: 'chatId required' })
  try {
    const chat = await client.getChatById(chatId)
    const messages = await chat.fetchMessages({ limit })
    res.json(messages.map((m) => ({
      id: m.id._serialized,
      chatId,
      author: m.author || m.from || null,
      authorName: (m._data && m._data.notifyName) || null,
      body: m.body || '',
      timestamp: m.timestamp || null, // unix seconds
      type: m.type || 'chat',
      hasMedia: !!m.hasMedia,
    })))
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.listen(PORT, HOST, () => {
  console.log(`[wa-bridge] HTTP API on http://${HOST}:${PORT}` + (TOKEN ? ' (token required)' : ''))
  console.log('[wa-bridge] manual mode — POST /connect (or click Connect in the UI) to start the session')
})
