const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron')
const { execFile } = require('child_process')
app.setName('MDstage')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const yaml = require('js-yaml')
const dgram = require('dgram')
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    PageBreak, BorderStyle, TabStopType, convertMillimetersToTwip,
} = require('docx')

let buildInfo = { commit: 'dev', date: '' }
try {
    buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'version.json'), 'utf8'))
} catch {}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

let scriptMdPath = null

// Script-trust state: frozen per file-open so auto-writes (note assignment, formatting) can't
// retroactively flip an externally-changed file to "trusted" before the user decides.
let trustChecked = false
let scriptTrusted = false

function setScriptPath(p) {
    scriptMdPath = p
    trustChecked = false
    scriptTrusted = false
}

function getLastFilePath() {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'last-file.json'), 'utf8'))
        if (data.path && fs.existsSync(data.path)) return data.path
    } catch {}
    return null
}

function saveLastFilePath(p) {
    try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'last-file.json'), JSON.stringify({ path: p }), 'utf8')
    } catch {}
}

function loadRecentFiles() {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'recent-files.json'), 'utf8'))
        if (Array.isArray(data.files)) return data.files.filter(p => typeof p === 'string')
    } catch {}
    return []
}

function saveRecentFiles(files) {
    try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'recent-files.json'), JSON.stringify({ files }), 'utf8')
    } catch {}
}

function addToRecentFiles(p) {
    const files = loadRecentFiles().filter(f => f !== p)
    files.unshift(p)
    saveRecentFiles(files.slice(0, 5))
    if (Menu.getApplicationMenu()) Menu.setApplicationMenu(buildMenu())
}

async function openFile() {
    const result = await dialog.showOpenDialog(mainWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['openFile'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
        setScriptPath(result.filePaths[0])
        saveLastFilePath(scriptMdPath)
        addToRecentFiles(scriptMdPath)
        mainWindow.reload()
    }
}
const hostname = os.hostname().split('.')[0]

const defaultSettings = {
    mainAudioDevice: null,
    // Virtual channel NAMES (shared, config top-level). The name→physical-output routing is
    // machine-local (userData `virtualChannelOutputs`); unrouted defaults positionally.
    virtualChannels: [{ name: 'L' }, { name: 'R' }],
    midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null,
    x32Protocol: 'x32midi', x32OscHost: '192.168.1.1', x32OscPort: 10023,
    editorApp: null,
    midiGoNote: null, midiBackNote: null, midiLiveDevice: null,
    cueTriggerInput: 'off', cueTriggerMidiDevice: null, cueTriggerOscPort: 8001, cueTriggerOscHost: '127.0.0.1',
    oscEnabled: false, oscHost: '127.0.0.1', oscPort: 8000,
    outputsBlocked: false,
    displayPort: 7590,   // keep in sync with DEFAULT_DISPLAY_PORT
    displayHost: '127.0.0.1',   // bind interface for the display server — local-only by default; opt into 0.0.0.0 for LAN access
    appLanguage: 'de',
    mainTextZoom: 1, liveTextZoom: 1,
}

function encodeOscMessage(address, args = []) {
    function padTo4(buf) {
        const pad = (4 - (buf.length % 4)) % 4
        return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf
    }
    function encodeString(s) { return padTo4(Buffer.from(s + '\0', 'ascii')) }
    function encodeInt(n)    { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b }
    function encodeFloat(f)  { const b = Buffer.alloc(4); b.writeFloatBE(f, 0); return b }

    let typeTags = ','
    for (const a of args) typeTags += (typeof a === 'string' ? 's' : Number.isInteger(a) ? 'i' : 'f')

    const parts = [encodeString(address), encodeString(typeTags)]
    for (const a of args) {
        if (typeof a === 'string')   parts.push(encodeString(a))
        else if (Number.isInteger(a)) parts.push(encodeInt(a))
        else                          parts.push(encodeFloat(a))
    }
    return Buffer.concat(parts)
}

// Reads the OSC address (the leading null-terminated, 4-byte-padded ASCII string)
// from an incoming UDP packet. Returns the address string, or null if it doesn't
// look like an OSC message. Arguments are ignored — cue triggering is path-based.
function decodeOscAddress(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0x2f /* '/' */) return null
    const end = buf.indexOf(0)
    if (end < 1) return null
    const addr = buf.toString('ascii', 0, end)
    return /^\/[\x20-\x7e]*$/.test(addr) ? addr : null
}

// ── Cue-Trigger OSC receiver ──────────────────────────────────────────────────
// Listens on a UDP port for `/cue/<ch>/<note>` messages and forwards the matched
// note to the renderer, which fires the cue whose trigger_note equals {ch, note}.
let cueOscSocket = null

function stopCueOscServer() {
    if (cueOscSocket) {
        try { cueOscSocket.close() } catch {}
        cueOscSocket = null
    }
}

function setupCueOscServer(settings) {
    stopCueOscServer()
    if (settings.cueTriggerInput !== 'osc') return
    const port = parseInt(settings.cueTriggerOscPort, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    // Bind address: '127.0.0.1' (local only, default) or '0.0.0.0' (whole network).
    // Restrict to the two known-safe values to avoid binding anywhere unexpected.
    const host = settings.cueTriggerOscHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'

    const sock = dgram.createSocket('udp4')
    sock.on('error', (e) => { console.error('Cue-OSC server error:', e.message); stopCueOscServer() })
    sock.on('message', (msg) => {
        const addr = decodeOscAddress(msg)
        if (!addr) return
        const m = /^\/cue\/(\d+)\/(\d+)$/.exec(addr)
        if (!m) return
        const ch   = parseInt(m[1], 10)
        const note = parseInt(m[2], 10)
        if (ch < 1 || ch > 16 || note < 0 || note > 127) return
        if (mainWindow)
            mainWindow.webContents.executeJavaScript(`window.__cueTrigger && window.__cueTrigger(${ch}, ${note})`).catch(() => {})
    })
    try {
        sock.bind(port, host)
        cueOscSocket = sock
    } catch (e) {
        console.error('Cue-OSC bind failed:', e.message)
    }
}

// ── Display web server ────────────────────────────────────────────────────────
// Serves per-cue markdown (rendered to HTML by the renderer) over HTTP so external
// browsers (stage monitors, tablets, subtitle screens) can show it at
// http://<host-ip>:<port>/<slug>. Live updates are pushed via Server-Sent Events.
const DEFAULT_DISPLAY_PORT = 7590
let displayServer = null
let displayServerPort = null
let displayServerHost = null
const displayState   = new Map()   // slug -> { html, style, scrollSec }
const displayClients = new Map()   // slug -> Set<ServerResponse> (open SSE streams, per slug)
let   displayDevices = []          // [{slug, name}] — full current roster, rebuilt on every push; drives the index page
// Presence tracking: every browser client that connected since program start is remembered
// (keyed by a per-tab clientId), so the live view can show green/red dots even after a
// client disconnects. Multiple clients can share one configured display device (slug).
const displayClientMeta = new Map()  // clientId -> { slug, name, voice, connected }
const displayClientConns = new Map() // clientId -> Set<ServerResponse> (active connections)
// Bounds so unauthenticated LAN clients can't grow the roster without limit (memory DoS):
// name/voice strings are capped, and disconnected entries are pruned oldest-first once the
// roster exceeds MAX_DISPLAY_CLIENTS. Currently-connected clients are never pruned.
const MAX_DISPLAY_CLIENTS = 200
const MAX_CLIENT_FIELD_LEN = 80
function clampClientField(v) { return String(v || '').slice(0, MAX_CLIENT_FIELD_LEN) }
// Drop the oldest disconnected roster entries when we're over the cap. Map iteration order is
// insertion order, so the first disconnected entries found are the oldest.
function pruneDisplayClientMeta() {
    let over = displayClientMeta.size - MAX_DISPLAY_CLIENTS
    if (over <= 0) return
    for (const [clientId, m] of displayClientMeta) {
        if (over <= 0) break
        if (!m.connected) { displayClientMeta.delete(clientId); displayClientConns.delete(clientId); over-- }
    }
}

// Notify the editor renderer whenever the client roster changes, so it can fold the
// presence info into the live-view state.
function displayClientList() {
    return Array.from(displayClientMeta, ([clientId, m]) =>
        ({ clientId, slug: m.slug, name: m.name || '', voice: m.voice || '', connected: !!m.connected }))
}
function notifyDisplayClients() {
    if (mainWindow) mainWindow.webContents.send('display-clients', displayClientList())
}

// Built-in stylesheets selectable per display device (no custom CSS needed).
const DISPLAY_STYLES = {
    dark: `html,body{margin:0;height:100%;background:#1e222a;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
#content{padding:4vh 5vw;font-size:5vh;line-height:1.4;box-sizing:border-box;}
#content h1{font-size:1.6em;}#content h2{font-size:1.3em;}
#content img{max-width:100%;}#content a{color:#61afef;}`,
    light: `html,body{margin:0;height:100%;background:#ffffff;color:#111111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
#content{padding:4vh 5vw;font-size:5vh;line-height:1.4;box-sizing:border-box;}
#content h1{font-size:1.6em;}#content h2{font-size:1.3em;}
#content img{max-width:100%;}#content a{color:#1a5fb4;}`,
    subtitle: `html,body{margin:0;height:100%;background:#000000;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
#content{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4vh 5vw;font-size:7vh;line-height:1.35;box-sizing:border-box;font-weight:600;}
#content img{max-width:100%;}`,
}

function getDisplayPort() {
    const p = parseInt(loadEditorPrefs().displayPort, 10)
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p
    return DEFAULT_DISPLAY_PORT
}

// os.networkInterfaces() reports `family` as the string 'IPv4' on some Node/Electron builds
// and as the number 4 on others — accept both so adapters (incl. Wi-Fi) aren't dropped.
function _isIPv4(a) { return a && (a.family === 'IPv4' || a.family === 4) }

// IPv4 addresses of all network adapters (incl. loopback) — used to validate the display
// bind host and to build address previews in settings.
function listIPv4Interfaces() {
    const out = []
    try {
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
            for (const a of addrs || []) {
                if (_isIPv4(a)) out.push({ name, address: a.address, internal: !!a.internal })
            }
        }
    } catch {}
    return out
}

// Bind interface for the display server: 0.0.0.0 (all), 127.0.0.1 (local), or a specific
// adapter IPv4 that actually exists on this machine. Falls back to 127.0.0.1 (local-only),
// so an unset/invalid value never silently exposes the server to the whole network.
function getDisplayHost() {
    const h = loadEditorPrefs().displayHost
    if (h === '0.0.0.0' || h === '127.0.0.1') return h
    if (typeof h === 'string' && listIPv4Interfaces().some(i => i.address === h)) return h
    return '127.0.0.1'
}

function stopDisplayServer() {
    for (const set of displayClients.values()) {
        for (const res of set) { try { res.end() } catch {} }
    }
    displayClients.clear()
    displayClientConns.clear()
    // Keep the roster but mark everything disconnected; clients reconnect after a restart.
    let changed = false
    for (const m of displayClientMeta.values()) { if (m.connected) { m.connected = false; changed = true } }
    if (changed) notifyDisplayClients()
    if (displayServer) {
        try { displayServer.close() } catch {}
        displayServer = null
        displayServerPort = null
        displayServerHost = null
    }
}

// Push new per-display content and stream it to any connected browsers. Entries whose
// html is null (outputs blocked) keep their previous content on the wire.
function pushDisplays(payload) {
    if (!Array.isArray(payload)) return
    // The renderer always sends the complete current set of display devices, so rebuild the
    // roster (slug + human name) that the index page lists from this payload.
    const roster = []
    for (const item of payload) {
        if (!item || typeof item.slug !== 'string') continue
        const slug = item.slug
        roster.push({ slug, name: typeof item.name === 'string' && item.name ? item.name : slug })
        const prev = displayState.get(slug) || {}
        const next = {
            html:      item.html == null ? (prev.html ?? '') : String(item.html),
            style:     typeof item.style === 'string' ? item.style : (prev.style || 'dark'),
            scrollSec: Number(item.scrollSec) >= 0 ? Number(item.scrollSec) : (prev.scrollSec || 0),
            lang:      typeof item.lang === 'string' ? item.lang : (prev.lang || ''),
        }
        // Skip SSE churn when nothing actually changed.
        if (prev.html === next.html && prev.style === next.style && prev.scrollSec === next.scrollSec && prev.lang === next.lang) continue
        displayState.set(slug, next)
        const set = displayClients.get(slug)
        if (set) {
            const line = 'data: ' + JSON.stringify({ type: 'content', ...next }) + '\n\n'
            for (const res of set) { try { res.write(line) } catch {} }
        }
    }
    displayDevices = roster
}

// Push a text-to-speech announcement to all clients of a display device (slug). Fired only
// on an actual cue trigger (Go / auto), never on Back or state recompute.
function pushAnnounce(payload) {
    if (!Array.isArray(payload)) return
    for (const item of payload) {
        if (!item || typeof item.slug !== 'string' || !item.text) continue
        const set = displayClients.get(item.slug)
        if (!set) continue
        const msg = { type: 'announce', text: String(item.text) }
        if (item.repeat) { msg.repeat = true; msg.repeatPhrase = String(item.repeatPhrase || '') }
        const line = 'data: ' + JSON.stringify(msg) + '\n\n'
        for (const res of set) { try { res.write(line) } catch {} }
    }
}

function safeReadFile(p, fallback) {
    try { return fs.readFileSync(p, 'utf8') } catch { return fallback }
}

function _htmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Landing page at http://<host>:<port>/ — lists the configured display devices, each linking
// to its own display page. Rebuilt live from the current roster the renderer pushes; a light
// meta-refresh picks up devices that get (un)configured while the page is open.
function renderDisplayIndex() {
    const rows = displayDevices.map(d => {
        const href = '/' + encodeURIComponent(d.slug)
        return `<li><a href="${_htmlEscape(href)}"><span class="nm">${_htmlEscape(d.name || d.slug)}</span><span class="sl">${_htmlEscape('/' + d.slug)}</span></a></li>`
    }).join('')
    const list = rows
        ? `<ul class="devs">${rows}</ul>`
        : `<p class="empty">Noch keine Display-Geräte konfiguriert. Lege in den Einstellungen ein Ausgabegerät vom Typ „Display" an.</p>`
    return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>MDstage Displays</title>
<style>
  html,body{margin:0;height:100%;background:#1e222a;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
  .wrap{max-width:44rem;margin:0 auto;padding:8vh 6vw;box-sizing:border-box;}
  h1{font-size:1.9rem;font-weight:600;margin:0 0 0.3rem;}
  .sub{color:#9aa0aa;margin:0 0 2rem;font-size:0.95rem;}
  ul.devs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.6rem;}
  ul.devs a{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;
    text-decoration:none;background:#272c35;border:1px solid #3a3f4a;border-radius:10px;
    padding:0.9rem 1.1rem;color:#e6e6e6;transition:background 0.15s,border-color 0.15s;}
  ul.devs a:hover{background:#2f3540;border-color:#61afef;}
  ul.devs .nm{font-size:1.15rem;font-weight:500;}
  ul.devs .sl{color:#7f8794;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9rem;}
  .empty{color:#9aa0aa;background:#272c35;border:1px solid #3a3f4a;border-radius:10px;padding:1.2rem;}
</style></head><body>
<div class="wrap">
  <h1>MDstage Displays</h1>
  <p class="sub">Verfügbare Anzeigegeräte — zum Öffnen antippen.</p>
  ${list}
</div>
</body></html>`
}

function handleDisplayRequest(req, res) {
    let url, pathname
    // Both the URL parse and the decode can throw on a malformed request path (e.g. "/%").
    // Catch both so a single bad request can never bubble up as an uncaughtException.
    try {
        url = new URL(req.url, 'http://localhost')
        pathname = decodeURIComponent(url.pathname)
    } catch { res.writeHead(400); return res.end() }

    // Static client assets
    if (pathname === '/__display/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        return res.end(safeReadFile(path.join(__dirname, '..', 'dist', 'display', 'app.js'), ''))
    }

    // Stylesheets: built-in name or custom file from the css/ folder next to the .md
    const styleMatch = /^\/__display\/style\/([\w.-]+)$/.exec(pathname)
    if (styleMatch) {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' })
        const name = styleMatch[1]
        if (Object.prototype.hasOwnProperty.call(DISPLAY_STYLES, name)) return res.end(DISPLAY_STYLES[name])
        if (/^[\w.-]+\.css$/.test(name) && scriptMdPath) {
            const cssDir = path.join(path.dirname(scriptMdPath), 'css')
            const filePath = path.join(cssDir, name)
            if (path.resolve(filePath).startsWith(path.resolve(cssDir) + path.sep)) {
                return res.end(safeReadFile(filePath, ''))
            }
        }
        return res.end(DISPLAY_STYLES.dark)
    }

    // Client metadata update (name / voice) without touching the SSE connection. Upserts so
    // it works even if it arrives before the SSE stream registers the client.
    if (pathname === '/__display/meta') {
        const clientId = url.searchParams.get('clientId')
        if (clientId) {
            const m = displayClientMeta.get(clientId) || { slug: '', name: '', voice: '', connected: false }
            if (url.searchParams.has('name'))  m.name  = clampClientField(url.searchParams.get('name'))
            if (url.searchParams.has('voice')) m.voice = clampClientField(url.searchParams.get('voice'))
            if (url.searchParams.has('slug'))  m.slug  = clampClientField(url.searchParams.get('slug')) || m.slug
            displayClientMeta.set(clientId, m)
            pruneDisplayClientMeta()
            notifyDisplayClients()
        }
        res.writeHead(204); return res.end()
    }

    // SSE event stream for one slug
    const evMatch = /^\/__display\/events\/(.+)$/.exec(pathname)
    if (evMatch) {
        const slug = evMatch[1]
        const clientId = url.searchParams.get('clientId') || ('anon-' + Math.random().toString(36).slice(2))
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })
        if (!displayClients.has(slug)) displayClients.set(slug, new Set())
        displayClients.get(slug).add(res)

        // Register / update presence for this client. Name/voice come exclusively via the
        // /__display/meta endpoint so an automatic SSE reconnect never reverts a rename.
        const prevMeta = displayClientMeta.get(clientId) || {}
        displayClientMeta.set(clientId, {
            slug,
            name:  prevMeta.name  || '',
            voice: prevMeta.voice || '',
            connected: true,
        })
        if (!displayClientConns.has(clientId)) displayClientConns.set(clientId, new Set())
        displayClientConns.get(clientId).add(res)
        pruneDisplayClientMeta()
        notifyDisplayClients()

        // Send current state immediately (or an empty page if none yet).
        const cur = displayState.get(slug) || { html: '', style: 'dark', scrollSec: 0, lang: '' }
        res.write('data: ' + JSON.stringify({ type: 'content', ...cur }) + '\n\n')
        const ka = setInterval(() => { try { res.write(': keep-alive\n\n') } catch {} }, 20000)
        req.on('close', () => {
            clearInterval(ka)
            displayClients.get(slug)?.delete(res)
            const conns = displayClientConns.get(clientId)
            if (conns) {
                conns.delete(res)
                if (conns.size === 0) {
                    const m = displayClientMeta.get(clientId)
                    if (m) { m.connected = false; notifyDisplayClients() }
                }
            }
        })
        return
    }

    // Any other path is treated as a display slug → serve the display page.
    const slug = pathname.replace(/^\//, '')
    if (!slug) {
        // Root path → landing page listing the available display devices.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        return res.end(renderDisplayIndex())
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(safeReadFile(path.join(__dirname, '..', 'dist', 'display', 'index.html'), '<!doctype html><title>Display</title>'))
}

function setupDisplayServer() {
    const http = require('http')
    const port = getDisplayPort()
    const host = getDisplayHost()
    if (displayServer && displayServerPort === port && displayServerHost === host) return   // already listening as configured
    stopDisplayServer()
    // Wrap the handler so an unexpected throw becomes a 500 instead of an uncaughtException
    // that would take down the whole (live-show) main process.
    const srv = http.createServer((req, res) => {
        try { handleDisplayRequest(req, res) }
        catch (e) {
            console.error('Display request error:', e.message)
            try { if (!res.headersSent) res.writeHead(500); res.end() } catch {}
        }
    })
    srv.on('error', (e) => { console.error('Display server error:', e.message); if (displayServer === srv) { displayServer = null; displayServerPort = null; displayServerHost = null } })
    try {
        srv.listen(port, host, () => { displayServer = srv; displayServerPort = port; displayServerHost = host })
    } catch (e) {
        console.error('Display server listen failed:', e.message)
    }
}

// Show-level settings live at config top-level in the shared .md and travel with the file:
// the virtual-channel NAMES and the output-device DECLARATIONS (name/type/colour). Everything
// else — output-device addresses, mixer connection, audio device, MIDI/OSC bindings, emergency-
// light wiring, language and view prefs, and the HTTP trust state — is machine/rig-local and
// lives in userData (editor-prefs.json). A shared show file therefore carries no venue config.
const SHARED_CONFIG_KEYS = ['outputDevices', 'virtualChannels']

let suppressVersionBump = false

function editorPrefsPath() {
    return path.join(app.getPath('userData'), 'editor-prefs.json')
}

function loadEditorPrefs() {
    try { return JSON.parse(fs.readFileSync(editorPrefsPath(), 'utf8')) } catch { return {} }
}

// Merge a patch into editor-prefs.json. Untouched keys (e.g. the internally-managed
// scriptTrustHashes) are preserved.
function saveEditorPrefs(patch) {
    const existing = loadEditorPrefs()
    fs.writeFileSync(editorPrefsPath(), JSON.stringify({ ...existing, ...patch }, null, 2), 'utf8')
}

function hashContent(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

// Record the current on-disk script hash as "last written by this machine" so the trust
// warning is skipped next time — unless the file is later changed on another machine.
function recordScriptHash() {
    if (!scriptMdPath) return
    try {
        const prefs = loadEditorPrefs()
        prefs.scriptTrustHashes = { ...(prefs.scriptTrustHashes || {}), [scriptMdPath]: hashContent(fs.readFileSync(scriptMdPath, 'utf8')) }
        fs.writeFileSync(editorPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
    } catch (e) { console.warn('recordScriptHash:', e.message) }
}

// Freeze, once per file-open, whether the incoming file matches the hash this machine last
// stored for it. Done before any auto-write so reformatting can't auto-trust a foreign file.
function evaluateScriptTrust(content) {
    trustChecked = true
    const known = loadEditorPrefs().scriptTrustHashes?.[scriptMdPath]
    scriptTrusted = !!known && known === hashContent(content)
}

// When launched from Applications/Spotlight the shell PATH is minimal — augment with common install locations
const AUGMENTED_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', process.env.PATH || ''].join(':')

function openLineInEditor(settings, line) {
    const safeLine = Math.max(1, parseInt(line, 10) || 1)
    const env = { ...process.env, PATH: AUGMENTED_PATH }
    if (settings.editorApp === 'vscode') {
        execFile('code', ['--goto', `${scriptMdPath}:${safeLine}`], { env })
    } else if (settings.editorApp === 'zed') {
        execFile('zed', [`${scriptMdPath}:${safeLine}`], { env })
    }
}

function readConfigBlock() {
    if (!scriptMdPath) return { text: '', parsed: null, block: '' }
    const text = fs.readFileSync(scriptMdPath, 'utf8')
    const re = /```yaml\n([\s\S]*?)\n```/g
    let m
    while ((m = re.exec(text)) !== null) {
        try {
            const parsed = yaml.load(m[1])
            if (parsed?.config) return { text, parsed, block: m[0] }
        } catch {}
    }
    return { text, parsed: null, block: '' }
}

function loadSettings() {
    // Machine-local prefs are the base; show-level keys from the shared .md override them.
    let base = { ...defaultSettings, ...loadEditorPrefs() }
    try {
        const { parsed } = readConfigBlock()
        for (const k of SHARED_CONFIG_KEYS) {
            const v = parsed?.config?.[k]
            if (v !== undefined) base[k] = v
        }
    } catch (e) {
        console.warn('settings read error:', e.message)
    }
    return base
}

function persistSettings(settings) {
    // Machine-local: everything except the shared show-level keys → userData
    const localPrefs = { ...settings }
    for (const k of SHARED_CONFIG_KEYS) delete localPrefs[k]
    saveEditorPrefs(localPrefs)

    const { text, parsed, block } = readConfigBlock()
    if (!parsed?.config) return

    // Show-level keys → config top-level (shared, travels with the file)
    if (Array.isArray(settings.outputDevices)) parsed.config.outputDevices = settings.outputDevices
    if (Array.isArray(settings.virtualChannels))
        parsed.config.virtualChannels = settings.virtualChannels.map(v => ({ name: v.name }))

    // The per-hostname settings map is obsolete — machine config now lives entirely in userData.
    delete parsed.config.settings
    if (!suppressVersionBump) parsed.config.app_version = app.getVersion()

    const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
    const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
    fs.writeFileSync(scriptMdPath, text.replace(block, () => newBlock), 'utf8')
    recordScriptHash()   // this machine just wrote the file → trusted
}

let mainWindow = null
let settingsWindow = null
let roleEditorWindow = null
let liveWindow = null
let aboutWindow = null

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        title: 'MDstage',
        icon: path.join(__dirname, '../dist/assets/icon.png'),
        acceptFirstMouse: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })

    const ALLOWED_PERMISSIONS = new Set(['midi', 'midiSysex', 'media'])
    mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission))
    })
    mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })

    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    mainWindow.webContents.on('did-finish-load', () => {
        if (liveWindow) mainWindow.webContents.send('live-window-state', true)
    })
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'l' && input.meta && !input.shift && !input.control) {
            createLiveWindow()
            event.preventDefault()
        }
    })
    mainWindow.on('closed', () => { mainWindow = null })
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus()
        return
    }
    settingsWindow = new BrowserWindow({
        width: 460,
        height: 780,
        title: 'Einstellungen',
        resizable: false,
        minimizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    settingsWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })
    settingsWindow.loadFile(path.join(__dirname, '../dist/settings.html'))
    settingsWindow.on('closed', () => { settingsWindow = null })
}

function createRoleEditorWindow() {
    if (roleEditorWindow) { roleEditorWindow.focus(); return }
    roleEditorWindow = new BrowserWindow({
        width: 600,
        height: 500,
        title: 'Rolleneditor',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    roleEditorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    roleEditorWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })
    roleEditorWindow.loadFile(path.join(__dirname, '../dist/role-editor.html'))
    roleEditorWindow.on('closed', () => { roleEditorWindow = null })
}

function createLiveWindow() {
    if (liveWindow) { liveWindow.focus(); return }
    liveWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: 'Live-Ansicht',
        acceptFirstMouse: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    liveWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    liveWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })
    liveWindow.loadFile(path.join(__dirname, '../dist/live.html'))
    liveWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'l' && input.meta && !input.shift && !input.control) {
            liveWindow.focus()
            event.preventDefault()
        }
    })
    liveWindow.on('closed', () => {
        liveWindow = null
        if (mainWindow) mainWindow.webContents.send('live-window-state', false)
    })
    if (mainWindow) mainWindow.webContents.send('live-window-state', true)
}

function createAboutWindow() {
    if (aboutWindow) { aboutWindow.focus(); return }
    aboutWindow = new BrowserWindow({
        width: 520,
        height: 700,
        title: 'Über MDstage',
        resizable: false,
        minimizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    aboutWindow.setMenu(null)
    aboutWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    aboutWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault()
    })
    aboutWindow.loadFile(path.join(__dirname, '../dist/about.html'))
    aboutWindow.on('closed', () => { aboutWindow = null })
}

async function createNewFile() {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: 'skript.md',
    })
    if (!result.canceled && result.filePath) {
        const name = path.basename(result.filePath, '.md')
        const template = `# ${name}\n\n\`\`\`yaml\nconfig:\n    app_version: "${app.getVersion()}"\n    roles: {}\n\`\`\`\n`
        fs.writeFileSync(result.filePath, template, 'utf8')
        setScriptPath(result.filePath)
        recordScriptHash()   // brand-new file authored on this machine → trusted
        saveLastFilePath(scriptMdPath)
        addToRecentFiles(scriptMdPath)
        mainWindow.reload()
    }
}

function menuT(key) {
    const lang = loadSettings().appLanguage || 'de'
    // Minimal inline lookup — avoids pulling in the browser-side i18n.js
    const M = {
        de: {
            about: 'Über MDstage…', newfile: 'Neue Datei…', open: 'Datei öffnen…',
            openwin: 'Öffnen…', settings: 'Einstellungen…', roleeditor: 'Rolleneditor…',
            liveview: 'Live-Ansicht…', export: 'Exportieren…', hide: 'Ausblenden',
            hideothers: 'Andere ausblenden', quit: 'Beenden',
            file: 'Datei', exportmenu: 'Exportieren', prefs: 'Einstellungen',
            midi: 'MIDI-Geräte…', help: 'Hilfe', edit: 'Bearbeiten',
            dev: 'Entwickler', devtools: 'DevTools öffnen', devlive: 'DevTools (Live-Fenster)',
            undo: 'Rückgängig', redo: 'Wiederholen', cut: 'Ausschneiden',
            copy: 'Kopieren', paste: 'Einfügen', selectall: 'Alles auswählen',
            recent: 'Zuletzt geöffnet', 'recent.none': '— Keine —', 'recent.clear': 'Verlauf löschen',
            cleanup: 'YAML aufräumen…',
        },
        en: {
            about: 'About MDstage…', newfile: 'New File…', open: 'Open File…',
            openwin: 'Open…', settings: 'Settings…', roleeditor: 'Role Editor…',
            liveview: 'Live View…', export: 'Export…', hide: 'Hide',
            hideothers: 'Hide Others', quit: 'Quit',
            file: 'File', exportmenu: 'Export', prefs: 'Settings',
            midi: 'MIDI Devices…', help: 'Help', edit: 'Edit',
            dev: 'Developer', devtools: 'Open DevTools', devlive: 'DevTools (Live window)',
            undo: 'Undo', redo: 'Redo', cut: 'Cut',
            copy: 'Copy', paste: 'Paste', selectall: 'Select All',
            recent: 'Open Recent', 'recent.none': '— None —', 'recent.clear': 'Clear Recent Files',
            cleanup: 'Clean up YAML…',
        },
    }
    return (M[lang] || M.de)[key] ?? key
}

function buildMenu() {
    const recentFiles = loadRecentFiles()
    const recentSubmenu = recentFiles.length === 0
        ? [{ label: menuT('recent.none'), enabled: false }]
        : [
            ...recentFiles.map(filePath => ({
                label: path.basename(filePath),
                click: () => {
                    setScriptPath(filePath)
                    saveLastFilePath(scriptMdPath)
                    addToRecentFiles(filePath)
                    if (mainWindow) mainWindow.reload()
                },
            })),
            { type: 'separator' },
            { label: menuT('recent.clear'), click: () => { saveRecentFiles([]); Menu.setApplicationMenu(buildMenu()) } },
          ]
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.getName(),
            submenu: [
                {
                    label: menuT('about'),
                    click: createAboutWindow,
                },
                { type: 'separator' },
                {
                    label: menuT('newfile'),
                    accelerator: 'Cmd+N',
                    click: createNewFile,
                },
                {
                    label: menuT('open'),
                    accelerator: 'Cmd+O',
                    click: openFile,
                },
                { label: menuT('recent'), submenu: recentSubmenu },
                { type: 'separator' },
                {
                    label: menuT('settings'),
                    accelerator: 'Cmd+,',
                    click: createSettingsWindow,
                },
                {
                    label: menuT('roleeditor'),
                    click: createRoleEditorWindow,
                },
                {
                    label: menuT('liveview'),
                    accelerator: 'Cmd+L',
                    click: createLiveWindow,
                },
                { type: 'separator' },
                {
                    label: menuT('export'),
                    accelerator: 'Cmd+E',
                    click: () => { if (mainWindow) mainWindow.webContents.executeJavaScript('window.__runExport && window.__runExport()').catch(() => {}) },
                },
                {
                    label: menuT('cleanup'),
                    click: () => { if (mainWindow) mainWindow.webContents.executeJavaScript('window.__runYamlCleanup && window.__runYamlCleanup()').catch(() => {}) },
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : [{
            label: menuT('file'),
            submenu: [
                {
                    label: menuT('newfile'),
                    accelerator: 'Ctrl+N',
                    click: createNewFile,
                },
                {
                    label: menuT('openwin'),
                    accelerator: 'Ctrl+O',
                    click: openFile,
                },
                { label: menuT('recent'), submenu: recentSubmenu },
            ],
        }, {
            label: menuT('exportmenu'),
            submenu: [{
                label: menuT('export'),
                accelerator: 'Ctrl+E',
                click: () => { if (mainWindow) mainWindow.webContents.executeJavaScript('window.__runExport && window.__runExport()').catch(() => {}) },
            }, {
                label: menuT('cleanup'),
                click: () => { if (mainWindow) mainWindow.webContents.executeJavaScript('window.__runYamlCleanup && window.__runYamlCleanup()').catch(() => {}) },
            }],
        }, {
            label: menuT('prefs'),
            submenu: [{
                label: menuT('midi'),
                accelerator: 'Ctrl+,',
                click: createSettingsWindow,
            }, {
                label: menuT('roleeditor'),
                click: createRoleEditorWindow,
            }, {
                label: menuT('liveview'),
                accelerator: 'Ctrl+L',
                click: createLiveWindow,
            }],
        }, {
            label: menuT('help'),
            submenu: [{
                label: menuT('about'),
                click: () => dialog.showMessageBox(mainWindow ?? null, {
                    type: 'info',
                    title: 'MDstage',
                    message: 'MDstage',
                    detail: `Version ${app.getVersion()}${buildInfo.date ? '  ·  ' + buildInfo.date : ''}\nCommit: ${buildInfo.commit}`,
                    buttons: ['OK'],
                }),
            }],
        }]),
        {
            label: menuT('edit'),
            submenu: [
                { role: 'undo', label: menuT('undo') },
                { role: 'redo', label: menuT('redo') },
                { type: 'separator' },
                { role: 'cut',       label: menuT('cut') },
                { role: 'copy',      label: menuT('copy') },
                { role: 'paste',     label: menuT('paste') },
                { role: 'selectAll', label: menuT('selectall') },
            ],
        },
        ...(!app.isPackaged ? [{
            label: menuT('dev'),
            submenu: [
                {
                    label: menuT('devtools'),
                    accelerator: process.platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
                    click: () => { if (mainWindow) mainWindow.webContents.openDevTools() },
                },
                {
                    label: menuT('devlive'),
                    click: () => { if (liveWindow) liveWindow.webContents.openDevTools() },
                },
                { role: 'reload' },
            ],
        }] : []),
    ]
    return Menu.buildFromTemplate(template)
}

// ── Export helpers ────────────────────────────────────────────────────────────

async function exportToPdf(win, html, title) {
    const result = await dialog.showSaveDialog(win, {
        title: 'PDF speichern',
        defaultPath: title.replace(/[/\\:*?"<>|]/g, '_') + '.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) return

    const tempPath = path.join(app.getPath('temp'), 'evb-export-' + Date.now() + '.html')
    fs.writeFileSync(tempPath, html, 'utf8')

    const pdfWin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    pdfWin.webContents.on('will-navigate', (e) => e.preventDefault())
    await pdfWin.loadFile(tempPath)
    const pdfBuffer = await pdfWin.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="font-size:11px;font-family:serif;width:100%;box-sizing:border-box;padding-right:2.5cm;padding-bottom:2.5cm;text-align:right;color:#555"><span class="pageNumber"></span></div>',
    })
    pdfWin.destroy()
    fs.unlinkSync(tempPath)
    fs.writeFileSync(result.filePath, pdfBuffer)
}

function hexColor(hex) {
    return (hex || '').replace('#', '') || '000000'
}

function buildDocx(data) {
    const { title, date, items, roleColors } = data
    const children = []

    // Title page
    children.push(
        new Paragraph({
            children: [new TextRun({ text: title, bold: true, size: 52, font: 'Times New Roman' })],
            alignment: AlignmentType.CENTER,
            spacing: { before: convertMillimetersToTwip(60), after: convertMillimetersToTwip(8) },
        }),
        new Paragraph({
            children: [new TextRun({ text: `Regiebuch — ${date}`, size: 24, color: '444444', font: 'Times New Roman' })],
            alignment: AlignmentType.CENTER,
            spacing: { after: convertMillimetersToTwip(4) },
        }),
        new Paragraph({ children: [new PageBreak()] }),
    )

    // Table of contents — manual list (avoids TOC field numbering artifacts)
    children.push(
        new Paragraph({
            children: [new TextRun({ text: 'Inhaltsverzeichnis', bold: true, size: 28, font: 'Times New Roman' })],
            spacing: { before: 0, after: convertMillimetersToTwip(6) },
        }),
        ...items
            .filter(it => it.type === 'heading' && it.level >= 1)
            .map(it => new Paragraph({
                children: [new TextRun({
                    text: (it.level === 2 ? '    ' : it.level >= 3 ? '        ' : '') + it.text,
                    font: 'Times New Roman',
                    bold: it.level === 1,
                    size: it.level === 1 ? 24 : it.level === 2 ? 22 : 20,
                })],
                spacing: { before: it.level === 1 ? 80 : 40, after: 40 },
            })),
        new Paragraph({ children: [new PageBreak()] }),
    )

    // Content

    for (const item of items) {
        if (item.type === 'heading') {
            const level = item.level === 1 ? HeadingLevel.HEADING_1 : item.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
            children.push(new Paragraph({ text: item.text, heading: level }))
        } else if (item.type === 'stage') {
            children.push(new Paragraph({
                children: [new TextRun({ text: item.text, italics: true, color: '666666', font: 'Times New Roman', size: 20 })],
                indent: { left: convertMillimetersToTwip(10) },
                spacing: { before: 60, after: 60 },
            }))
        } else if (item.type === 'role') {
            const runs = []
            item.names.forEach((name, i) => {
                if (i > 0) runs.push(new TextRun({ text: '  ', font: 'Times New Roman', size: 22 }))
                runs.push(new TextRun({ text: name, bold: true, color: hexColor(roleColors[name]), font: 'Times New Roman', size: 22 }))
            })
            if (item.dialogue) {
                runs.push(new TextRun({ text: '    ', font: 'Times New Roman', size: 22 }))
                // Split by line breaks to handle song lyrics etc.
                const lines = item.dialogue.split('\n')
                lines.forEach((line, i) => {
                    if (i > 0) runs.push(new TextRun({ text: '', break: 1 }))
                    // Render inline stage directions *(text)* as italic
                    const parts = line.split(/(\*\([^)]*\)\*)/g)
                    for (const part of parts) {
                        const sm = part.match(/^\*\(([^)]*)\)\*$/)
                        if (sm) {
                            runs.push(new TextRun({ text: `(${sm[1]})`, italics: true, color: '666666', font: 'Times New Roman', size: 22 }))
                        } else if (part) {
                            runs.push(new TextRun({ text: part, font: 'Times New Roman', size: 22 }))
                        }
                    }
                })
            }
            children.push(new Paragraph({ children: runs, spacing: { before: 40, after: 40 } }))
        } else if (item.type === 'cue') {
            // Collect info rows first so we know total count for border logic
            const cueInfoRows = []
            if (item.mic) {
                let micStr
                if (item.mic === 'muteall') {
                    micStr = 'alle aus'
                } else if (item.micItems) {
                    const parts = []
                    for (const mi of item.micItems) {
                        if (mi.isGroup) parts.push(`${mi.name} ${(mi.members || []).map(m => m.name).join(' ')}`)
                        else parts.push(mi.name)
                    }
                    micStr = parts.join(' ')
                } else {
                    micStr = ''
                }
                cueInfoRows.push({ label: 'Mic', value: micStr })
            }
            if (item.music) {
                const m = item.music
                let ms = m.file || ''
                const det = []
                if (m.volume  !== undefined) det.push(`Vol ${Math.round(m.volume * 100)}%`)
                if (m.start   !== undefined) det.push(`Start ${m.start}s`)
                if (m.end     !== undefined) det.push(`Ende ${m.end}s`)
                if (m.fadein)               det.push(`Fade-in ${m.fadein}s`)
                if (m.fadeout)              det.push(`Fade-out ${m.fadeout}s`)
                if (m.loop)                 det.push('Loop')
                if (det.length) ms += ` (${det.join(', ')})`
                if (m.adjust) {
                    const ref = m.adjust.trigger ? `Cue ${m.adjust.trigger}` : '?'
                    if (m.adjust.fadeout)                   ms += ` → ${ref} ausfaden`
                    else if (m.adjust.volume !== undefined) ms += ` → ${ref} auf ${Math.round(m.adjust.volume * 100)}%`
                }
                cueInfoRows.push({ label: '♬', value: ms })
            }
            if (item.light)      cueInfoRows.push({ label: 'Licht',  value: item.light })
            if (item.qlcplus)    cueInfoRows.push({ label: 'QLC+',   value: item.qlcplus })
            if (item.projection) cueInfoRows.push({ label: 'Proj.',  value: item.projection })
            if (item.note)       cueInfoRows.push({ label: 'Notiz',  value: item.note })
            if (item.start_tc)   cueInfoRows.push({ label: 'TC',     value: item.start_tc })
            if (item.timestamp)  cueInfoRows.push({ label: 'Zeit',   value: item.timestamp })
            if (item.auto_trigger) {
                const at = item.auto_trigger
                const ref = at.trigger ? `Cue ${at.trigger}` : '?'
                cueInfoRows.push({ label: 'Auto', value: `bei ${at.at}s in ${ref}` })
            }

            const bSide  = { style: BorderStyle.SINGLE, size: 4, color: '888888' }
            const bNone  = { style: BorderStyle.NONE,   size: 0, color: 'ffffff' }
            const indent = { left: convertMillimetersToTwip(3) }

            const leftParts = []
            if (item.sibling)  leftParts.push('[Variante]')
            if (item.slf)      leftParts.push(`${item.slf.role} ${item.slf.detail}`)
            const hdrLeft  = leftParts.join('  ')
            const hdrRight = item.trigger || ''
            children.push(new Paragraph({
                children: [
                    new TextRun({ text: hdrLeft || ' ' }),
                    new TextRun({ text: '\t' }),
                    new TextRun({ text: hdrRight, color: '666666' }),
                ],
                tabStops: [{ type: TabStopType.RIGHT, position: convertMillimetersToTwip(154) }],
                border: {
                    top: bSide, left: bSide, right: bSide,
                    bottom: cueInfoRows.length === 0 ? bSide : bNone,
                },
                indent,
                spacing: { before: 100, after: 0 },
            }))
            cueInfoRows.forEach((row, i) => {
                const isLast = i === cueInfoRows.length - 1
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: `${row.label}: `, bold: true, color: '666666' }),
                        new TextRun({ text: row.value }),
                    ],
                    border: {
                        top: bNone, left: bSide, right: bSide,
                        bottom: isLast ? bSide : bNone,
                    },
                    indent,
                    spacing: { before: 0, after: isLast ? 100 : 0 },
                }))
            })
        } else if (item.type === 'text') {
            children.push(new Paragraph({
                children: [new TextRun({ text: item.text, font: 'Times New Roman', size: 22 })],
                spacing: { before: 60, after: 60 },
            }))
        }
    }

    return new Document({
        creator: 'MDstage',
        title: title,
        features: { updateFields: true },
        sections: [{
            properties: {
                page: {
                    size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
                    margin: {
                        top: convertMillimetersToTwip(25),
                        bottom: convertMillimetersToTwip(25),
                        left: convertMillimetersToTwip(25),
                        right: convertMillimetersToTwip(25),
                    },
                },
            },
            children,
        }],
    })
}

async function exportToDocx(win, data) {
    const result = await dialog.showSaveDialog(win, {
        title: 'DOCX speichern',
        defaultPath: data.title.replace(/[/\\:*?"<>|]/g, '_') + '.docx',
        filters: [{ name: 'Word-Dokument', extensions: ['docx'] }],
    })
    if (result.canceled || !result.filePath) return
    const doc = buildDocx(data)
    const buffer = await Packer.toBuffer(doc)
    fs.writeFileSync(result.filePath, buffer)
}

app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, '../dist/assets/icon.png'))
    }
    setScriptPath(getLastFilePath())
    if (scriptMdPath && !fs.existsSync(scriptMdPath)) scriptMdPath = null
    const showWelcome = !scriptMdPath
    // Ensure the startup file appears in recent files (migration from last-file.json)
    if (scriptMdPath) {
        const rf = loadRecentFiles()
        if (!rf.includes(scriptMdPath)) {
            saveRecentFiles([scriptMdPath, ...rf].slice(0, 5))
        }
    }

    ipcMain.handle('send-http', async (_, { url, method = 'GET', path = '', body = null, contentType = null } = {}) => {
        try {
            // Defense in depth: enforce the output gate here, not only in the renderer. A show
            // file can drive arbitrary HTTP on the LAN, so refuse when outputs are blocked or the
            // script isn't trusted — even if a renderer bug routed around the in-page guard.
            if (loadEditorPrefs().outputsBlocked) return { ok: false, error: 'outputs blocked' }
            if (!scriptTrusted) return { ok: false, error: 'untrusted script' }
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' }
            const full = url.replace(/\/+$/, '') + (path ? (path.startsWith('/') ? path : '/' + path) : '')
            const target = new URL(full)
            const lib = target.protocol === 'https:' ? require('https') : require('http')
            const m = String(method || 'GET').toUpperCase()
            const headers = {}
            let payload = null
            if (body != null && body !== '' && m !== 'GET' && m !== 'HEAD') {
                payload = Buffer.from(String(body), 'utf8')
                headers['Content-Type'] = contentType || 'text/plain'
                headers['Content-Length'] = payload.length
            }
            return await new Promise((resolve) => {
                const req = lib.request(target, { method: m, headers, timeout: 5000 }, (res) => {
                    res.resume()   // drain
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode })
                })
                req.on('error', (e) => resolve({ ok: false, error: e.message }))
                req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
                if (payload) req.write(payload)
                req.end()
            })
        } catch (e) {
            return { ok: false, error: e.message }
        }
    })

    ipcMain.on('send-osc', (_, { path: oscPath, args = [], host = '127.0.0.1', port = 8000 }) => {
        const safePort = parseInt(port, 10)
        if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) return
        if (typeof host !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.split('.').some(o => +o > 255)) return
        if (typeof oscPath !== 'string' || !/^\/[\x20-\x7e]*$/.test(oscPath)) return
        try {
            const msg = encodeOscMessage(oscPath, args)
            const sock = dgram.createSocket('udp4')
            sock.send(msg, safePort, host, () => sock.close())
        } catch (e) {
            console.error('OSC send error:', e.message)
        }
    })

    ipcMain.handle('get-app-version', () => app.getVersion())
    ipcMain.handle('get-build-info',  () => buildInfo)
    ipcMain.handle('get-settings', () => loadSettings())
    ipcMain.handle('open-external-url', (_, url) => {
        if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) shell.openExternal(url)
    })
    ipcMain.handle('set-suppress-version-bump', (_, val) => { suppressVersionBump = !!val })

    ipcMain.handle('save-settings', (_, settings) => {
        persistSettings(settings)
        setupCueOscServer(settings)
        setupDisplayServer()   // pick up a changed display port
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('settings-changed', settings)
        })
        Menu.setApplicationMenu(buildMenu())
    })

    // Lightweight device-local pref save — writes only editor-prefs.json, never the markdown
    // file. Used for zoom so it doesn't trigger a script rewrite/rerender.
    ipcMain.handle('save-editor-prefs', (_, partial) => {
        if (partial && typeof partial === 'object') saveEditorPrefs(partial)
        if (partial && (Object.prototype.hasOwnProperty.call(partial, 'displayPort') || Object.prototype.hasOwnProperty.call(partial, 'displayHost'))) setupDisplayServer()
    })

    ipcMain.handle('get-hostname', () => hostname)

    ipcMain.handle('get-script-md', () => {
        if (!scriptMdPath) return '```yaml\nconfig:\n    roles: {}\n```\n'
        const content = fs.readFileSync(scriptMdPath, 'utf8')
        // First read after a file-open: freeze the trust decision before any auto-write.
        if (!trustChecked) evaluateScriptTrust(content)
        return content
    })

    ipcMain.handle('write-script-md', (_, content) => {
        if (!scriptMdPath) throw new Error('No file open')
        if (typeof content !== 'string') throw new Error('Invalid content')
        if (content.length > 10 * 1024 * 1024) throw new Error('File too large')
        if (!/```yaml[\s\S]*?config:[\s\S]*?```/.test(content)) throw new Error('Invalid content: missing config block')
        let toWrite = content
        if (!suppressVersionBump) {
            const m = content.match(/```yaml\n([\s\S]*?)\n```/)
            if (m) {
                try {
                    const parsed = yaml.load(m[1])
                    if (parsed?.config) {
                        parsed.config.app_version = app.getVersion()
                        const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
                        toWrite = content.replace(m[0], () => '```yaml\n' + newYaml.trimEnd() + '\n```')
                    }
                } catch (e) { /* ignore yaml parse error, write as-is */ }
            }
        }
        fs.writeFileSync(scriptMdPath, toWrite, 'utf8')
        recordScriptHash()
    })

    ipcMain.handle('get-script-path', () => scriptMdPath ?? '')

    // Script trust: renderer asks whether the just-opened file is trusted (last change was on
    // this machine); ack records the current content as trusted after the user allows it.
    ipcMain.handle('get-script-trusted', () => scriptTrusted)
    ipcMain.handle('ack-script-trust', () => {
        recordScriptHash()
        scriptTrusted = true
        trustChecked = true
        return true
    })
    ipcMain.handle('open-file-welcome', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            filters: [{ name: 'Markdown', extensions: ['md'] }],
            properties: ['openFile'],
        })
        if (!result.canceled && result.filePaths.length > 0) {
            setScriptPath(result.filePaths[0])
            saveLastFilePath(scriptMdPath)
            addToRecentFiles(scriptMdPath)
            mainWindow.reload()
        }
    })

    ipcMain.handle('backup-script-md', () => {
        if (!scriptMdPath) throw new Error('No file open')
        const backupPath = scriptMdPath.replace(/\.md$/, '~unformatted.md')
        fs.copyFileSync(scriptMdPath, backupPath)
        return path.basename(backupPath)
    })

    ipcMain.handle('backup-script-md-versioned', (_, version) => {
        if (!scriptMdPath) throw new Error('No file open')
        const safe = String(version).replace(/[^0-9a-zA-Z.\-]/g, '_')
        const backupPath = scriptMdPath.replace(/\.md$/, `~v${safe}.md`)
        fs.copyFileSync(scriptMdPath, backupPath)
        return path.basename(backupPath)
    })

    ipcMain.handle('backup-script-md-uncleaned', () => {
        if (!scriptMdPath) throw new Error('No file open')
        const backupPath = scriptMdPath.replace(/\.md$/, '~uncleaned.md')
        fs.copyFileSync(scriptMdPath, backupPath)
        return path.basename(backupPath)
    })

    ipcMain.handle('write-incompatibility-log', (_, { entries, fromVersion, toVersion }) => {
        if (!scriptMdPath) throw new Error('No file open')
        const version = app.getVersion()
        const logPath = scriptMdPath.replace(/\.md$/, `-incompatibility-log-v${version}.txt`)
        const lines = [
            `MDstage Incompatibility Log`,
            `Script:   ${path.basename(scriptMdPath)}`,
            `Upgraded: v${fromVersion} → v${toVersion}`,
            `Date:     ${new Date().toLocaleString()}`,
            '',
            'The following YAML keys were not part of the current spec and were removed:',
            '',
            ...entries.map(e => `  alt Zeile ${e.oldLine}, neu Zeile ${e.newLine}:  ${e.key}  =  ${JSON.stringify(e.value)}`),
        ]
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8')
        return path.basename(logPath)
    })

    ipcMain.handle('list-audio-files', () => {
        const audioDir = path.join(path.dirname(scriptMdPath), 'audio')
        try {
            if (!fs.existsSync(audioDir)) return []
            return fs.readdirSync(audioDir).filter(f => /\.(mp3|wav|aiff|flac|ogg|aac|m4a)$/i.test(f)).sort()
        } catch {
            return []
        }
    })

    // Custom stylesheets for display devices — read from a css/ folder next to the .md.
    ipcMain.handle('list-css-files', () => {
        if (!scriptMdPath) return []
        const cssDir = path.join(path.dirname(scriptMdPath), 'css')
        try {
            if (!fs.existsSync(cssDir)) return []
            return fs.readdirSync(cssDir).filter(f => /^[\w.-]+\.css$/i.test(f)).sort()
        } catch {
            return []
        }
    })

    // First non-internal IPv4 LAN address, for the display URL preview in settings.
    ipcMain.handle('get-lan-ip', () => {
        const iface = listIPv4Interfaces().find(i => !i.internal)
        return iface ? iface.address : '127.0.0.1'
    })

    // All IPv4 network adapters (for the display bind-interface dropdown in settings).
    ipcMain.handle('get-network-interfaces', () => listIPv4Interfaces())

    // Renderer pushes current per-display markdown (rendered HTML) → stream to browsers.
    ipcMain.on('update-displays', (_, payload) => pushDisplays(payload))

    // Renderer pushes TTS announcements on cue trigger → stream to browsers of that slug.
    ipcMain.on('announce-displays', (_, payload) => pushAnnounce(payload))

    // Current display-client roster (presence) — requested by the renderer on init.
    ipcMain.handle('get-display-clients', () => displayClientList())

    ipcMain.handle('handle-audio-drop', (_, srcPath) => {
        if (typeof srcPath !== 'string') return null
        if (!/\.(mp3|wav|aiff|flac|ogg|aac|m4a)$/i.test(srcPath)) return null
        const audioDir = path.join(path.dirname(scriptMdPath), 'audio')
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true })
        const fileName = path.basename(srcPath)
        const destPath = path.join(audioDir, fileName)
        const srcResolved  = path.resolve(srcPath)
        const audioDirResolved = path.resolve(audioDir)
        const alreadyInDir = srcResolved.startsWith(audioDirResolved + path.sep)
                          || srcResolved === destPath
        if (!alreadyInDir && !fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath)
        }
        return fileName
    })

    ipcMain.handle('get-roles', () => {
        try {
            const { parsed } = readConfigBlock()
            return {
                roles:  parsed?.config?.roles  || {},
                groups: parsed?.config?.groups || {},
            }
        } catch { return { roles: {}, groups: {} } }
    })

    ipcMain.handle('save-roles', (_, { roles, renames, groups }) => {
        let text = fs.readFileSync(scriptMdPath, 'utf8')
        for (const { from, to } of (renames || [])) {
            if (!from || !to || from === to) continue
            const re = new RegExp(`\\*\\*${escapeRegex(from)}\\*\\*`, 'g')
            text = text.replace(re, `**${to}**`)
            // Update group memberships for renamed roles
            for (const grp of Object.values(groups || {})) {
                if (Array.isArray(grp.roles)) {
                    const idx = grp.roles.indexOf(from)
                    if (idx !== -1) grp.roles[idx] = to
                }
            }
        }
        const m = text.match(/```yaml\n([\s\S]*?)\n```/)
        if (m) {
            try {
                const parsed = yaml.load(m[1])
                if (parsed?.config) {
                    parsed.config.roles = roles
                    if (groups && Object.keys(groups).length > 0) {
                        parsed.config.groups = groups
                    } else {
                        delete parsed.config.groups
                    }
                    const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
                    const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
                    text = text.replace(m[0], () => newBlock)
                }
            } catch (e) {
                console.warn('save-roles YAML error:', e.message)
            }
        }
        fs.writeFileSync(scriptMdPath, text, 'utf8')
        recordScriptHash()
        BrowserWindow.getAllWindows().forEach(win => win.webContents.send('script-changed'))
    })

    ipcMain.handle('new-file', () => createNewFile())

    ipcMain.handle('get-em-light-note', () => {
        try {
            const { parsed } = readConfigBlock()
            return parsed?.config?.emLightNote ?? null
        } catch { return null }
    })

    ipcMain.handle('save-em-light-note', (_, note) => {
        const { text, parsed, block } = readConfigBlock()
        if (!parsed?.config) return
        if (note) parsed.config.emLightNote = note
        else delete parsed.config.emLightNote
        const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
        const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
        fs.writeFileSync(scriptMdPath, text.replace(block, () => newBlock), 'utf8')
        recordScriptHash()
        BrowserWindow.getAllWindows().forEach(win => win.webContents.send('script-changed'))
    })

    ipcMain.handle('export-pdf', (event, { html, title }) => exportToPdf(BrowserWindow.fromWebContents(event.sender), html, title))
    ipcMain.handle('export-docx', (event, data) => exportToDocx(BrowserWindow.fromWebContents(event.sender), data))

    ipcMain.handle('show-editor-context-menu', (event, line) => {
        const settings = loadSettings()
        if (!settings.editorApp) return
        const menu = Menu.buildFromTemplate([{
            label: 'In Editor öffnen',
            click: () => openLineInEditor(settings, line),
        }])
        menu.popup({ window: BrowserWindow.fromWebContents(event.sender) })
    })

    ipcMain.handle('send-live-state', (_, state) => {
        if (liveWindow) liveWindow.webContents.send('live-state', state)
    })
    ipcMain.on('send-live-volumes', (_, volumes) => {
        if (liveWindow) liveWindow.webContents.send('live-volumes', volumes)
    })

    ipcMain.on('open-live-window', createLiveWindow)
    ipcMain.on('open-role-editor', createRoleEditorWindow)
    ipcMain.on('quit-app', () => app.quit())
    ipcMain.on('live-go', () => {
        if (mainWindow) mainWindow.webContents.executeJavaScript('window.__liveGo && window.__liveGo()').catch(() => {})
    })
    ipcMain.on('live-back', () => {
        if (mainWindow) mainWindow.webContents.executeJavaScript('window.__liveBack && window.__liveBack()').catch(() => {})
    })
    ipcMain.on('live-select-variant', (_, idx) => {
        const n = parseInt(idx)
        if (!Number.isFinite(n)) return
        if (mainWindow) mainWindow.webContents.executeJavaScript(`window.__selectVariant && window.__selectVariant(${n})`).catch(() => {})
    })
    ipcMain.on('live-stop-audio', (_, cueIdx) => {
        const n = parseInt(cueIdx)
        if (!Number.isFinite(n)) return
        if (mainWindow) mainWindow.webContents.executeJavaScript(`window.__stopAudio && window.__stopAudio(${n})`).catch(() => {})
    })

    Menu.setApplicationMenu(buildMenu())
    createMainWindow()
    setupCueOscServer(loadSettings())
    setupDisplayServer()

    if (showWelcome) {
        mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('welcome-dialog')
        })
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
