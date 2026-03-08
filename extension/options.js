import { deriveRelayToken } from './background-utils.js'
import { classifyRelayCheckException, classifyRelayCheckResponse } from './options-validation.js'

const DEFAULT_PORT = 18792
const DEFAULT_GATEWAY_URL = 'https://magister-gateway.fly.dev'

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://127.0.0.1:${port}/`
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

function setGatewayStatus(kind, message) {
  const status = document.getElementById('gateway-connect-status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

function createBadge(connected) {
  const span = document.createElement('span')
  span.className = connected ? 'connected-badge ok' : 'connected-badge off'

  const dot = document.createElement('span')
  dot.className = connected ? 'dot green' : 'dot gray'
  span.appendChild(dot)

  span.appendChild(document.createTextNode(connected ? 'Connected to Magister' : 'Not connected'))
  return span
}

function showGatewayConnectionState(connected) {
  const statusEl = document.getElementById('gateway-status')
  const connectSection = document.getElementById('connect-section')
  const connectedSection = document.getElementById('connected-section')

  statusEl.textContent = ''
  statusEl.appendChild(createBadge(connected))

  if (connected) {
    connectSection.style.display = 'none'
    connectedSection.style.display = 'block'
  } else {
    connectSection.style.display = 'block'
    connectedSection.style.display = 'none'
  }
}

async function checkRelayReachable(port, token) {
  const url = `http://127.0.0.1:${port}/json/version`
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Gateway token required. Save your gateway token to connect.')
    return
  }
  try {
    const relayToken = await deriveRelayToken(trimmedToken, port)
    const res = await chrome.runtime.sendMessage({
      type: 'relayCheck',
      url,
      token: relayToken,
    })
    const result = classifyRelayCheckResponse(res, port)
    if (result.action === 'throw') throw new Error(result.error)
    setStatus(result.kind, result.message)
  } catch (err) {
    const result = classifyRelayCheckException(err, port)
    setStatus(result.kind, result.message)
  }
}

async function handleConnect() {
  const tokenInput = document.getElementById('connection-token')
  const token = String(tokenInput.value || '').trim()
  if (!token) {
    setGatewayStatus('error', 'Please paste a connection token.')
    return
  }

  const connectBtn = document.getElementById('connect-btn')
  connectBtn.disabled = true
  connectBtn.textContent = 'Connecting...'
  setGatewayStatus('', 'Exchanging token...')

  try {
    const stored = await chrome.storage.local.get(['gatewayUrl'])
    const gatewayUrl = stored.gatewayUrl || DEFAULT_GATEWAY_URL

    const res = await fetch(`${gatewayUrl}/api/browser/token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Token exchange failed (${res.status})`)
    }

    const data = await res.json()
    await chrome.storage.local.set({
      gatewayJwt: data.jwt,
      gatewayUrl: gatewayUrl,
    })

    tokenInput.value = ''
    showGatewayConnectionState(true)
    setGatewayStatus('ok', 'Connected! Click the toolbar button on a tab to start.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setGatewayStatus('error', `Connection failed: ${message}`)
  } finally {
    connectBtn.disabled = false
    connectBtn.textContent = 'Connect'
  }
}

async function handleDisconnect() {
  await chrome.storage.local.remove(['gatewayJwt', 'gatewayUrl'])
  showGatewayConnectionState(false)
  setGatewayStatus('', 'Disconnected.')
}

async function load() {
  // Check if already connected to gateway
  const stored = await chrome.storage.local.get(['relayPort', 'gatewayToken', 'gatewayJwt', 'gatewayUrl'])

  // Gateway mode status
  if (stored.gatewayJwt && stored.gatewayUrl) {
    showGatewayConnectionState(true)
  } else {
    showGatewayConnectionState(false)
  }

  // Local mode fields
  const port = clampPort(stored.relayPort)
  const token = String(stored.gatewayToken || '').trim()
  document.getElementById('port').value = String(port)
  document.getElementById('token').value = token
  updateRelayUrl(port)

  // Only check local relay if not in gateway mode
  if (!stored.gatewayJwt) {
    await checkRelayReachable(port, token)
  }
}

async function save() {
  const portInput = document.getElementById('port')
  const tokenInput = document.getElementById('token')
  const port = clampPort(portInput.value)
  const token = String(tokenInput.value || '').trim()

  // When saving local mode, clear gateway mode
  await chrome.storage.local.remove(['gatewayJwt', 'gatewayUrl'])
  await chrome.storage.local.set({ relayPort: port, gatewayToken: token })
  showGatewayConnectionState(false)

  portInput.value = String(port)
  tokenInput.value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

document.getElementById('save').addEventListener('click', () => void save())
document.getElementById('connect-btn').addEventListener('click', () => void handleConnect())
document.getElementById('disconnect-btn').addEventListener('click', () => void handleDisconnect())
void load()
