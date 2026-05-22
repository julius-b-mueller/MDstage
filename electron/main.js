const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const yaml = require('js-yaml')

const scriptMdPath = path.join(__dirname, '../dist/script.md')
const hostname = os.hostname()

const defaultSettings = {
    mainAudioDevice: null, monitorAudioDevice: null, monitorOffsetMs: 0,
    midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null,
}

function readConfigBlock() {
    const text = fs.readFileSync(scriptMdPath, 'utf8')
    const m = text.match(/```yaml\n([\s\S]*?)\n```/)
    if (!m) return { text, parsed: null, block: '' }
    return { text, parsed: yaml.load(m[1]), block: m[0] }
}

function loadSettings() {
    try {
        const { parsed } = readConfigBlock()
        const s = parsed?.config?.settings
        if (s != null) {
            // New format: keyed by hostname
            if (s[hostname] != null) return { ...defaultSettings, ...s[hostname] }
            // Legacy flat format (single-PC, no hostname key) — still readable
            if ('mainAudioDevice' in s) return { ...defaultSettings, ...s }
        }
    } catch (e) {
        console.warn('settings read error:', e.message)
    }
    // Legacy fallback: settings.json
    try {
        const legacyPath = path.join(app.getPath('userData'), 'settings.json')
        return { ...defaultSettings, ...JSON.parse(fs.readFileSync(legacyPath, 'utf8')) }
    } catch {}
    return { ...defaultSettings }
}

function persistSettings(settings) {
    const { text, parsed, block } = readConfigBlock()
    if (!parsed?.config) return

    let existing = parsed.config.settings ?? {}
    // Migrate from legacy flat format to hostname-keyed on first save
    if ('mainAudioDevice' in existing) existing = {}
    existing[hostname] = settings
    parsed.config.settings = existing

    const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
    const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
    fs.writeFileSync(scriptMdPath, text.replace(block, newBlock), 'utf8')
}

let mainWindow = null
let settingsWindow = null

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })

    mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(true)
    })
    mainWindow.webContents.session.setPermissionCheckHandler(() => true)

    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    mainWindow.on('closed', () => { mainWindow = null })
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus()
        return
    }
    settingsWindow = new BrowserWindow({
        width: 440,
        height: 520,
        title: 'Einstellungen',
        resizable: false,
        minimizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    settingsWindow.loadFile(path.join(__dirname, '../dist/settings.html'))
    settingsWindow.on('closed', () => { settingsWindow = null })
}

function buildMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.getName(),
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                {
                    label: 'Einstellungen…',
                    accelerator: 'Cmd+,',
                    click: createSettingsWindow,
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : [{
            label: 'Einstellungen',
            submenu: [{
                label: 'MIDI-Geräte…',
                accelerator: 'Ctrl+,',
                click: createSettingsWindow,
            }],
        }]),
        {
            label: 'Bearbeiten',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'Entwickler',
            submenu: [
                {
                    label: 'DevTools öffnen',
                    accelerator: process.platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
                    click: () => { if (mainWindow) mainWindow.webContents.openDevTools() },
                },
                { role: 'reload' },
            ],
        },
    ]
    return Menu.buildFromTemplate(template)
}

app.whenReady().then(() => {
    ipcMain.handle('get-settings', () => loadSettings())

    ipcMain.handle('save-settings', (_, settings) => {
        persistSettings(settings)
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('settings-changed', settings)
        })
    })

    ipcMain.handle('get-hostname', () => hostname)

    ipcMain.handle('get-script-md', () => fs.readFileSync(scriptMdPath, 'utf8'))

    ipcMain.handle('write-script-md', (_, content) => {
        fs.writeFileSync(scriptMdPath, content, 'utf8')
    })

    ipcMain.handle('list-audio-files', () => {
        const audioDir = path.join(__dirname, '../dist/audio')
        try {
            return fs.readdirSync(audioDir).filter(f => /\.(mp3|wav)$/i.test(f)).sort()
        } catch {
            return []
        }
    })

    Menu.setApplicationMenu(buildMenu())
    createMainWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
