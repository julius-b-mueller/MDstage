const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const { exec } = require('child_process')
app.setName('Main Desk')
const path = require('path')
const fs = require('fs')
const os = require('os')
const yaml = require('js-yaml')

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

let scriptMdPath = path.join(__dirname, '../dist/script.md')

function getLastFilePath() {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'last-file.json'), 'utf8'))
        if (data.path && fs.existsSync(data.path)) return data.path
    } catch {}
    return path.join(__dirname, '../dist/script.md')
}

function saveLastFilePath(p) {
    try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'last-file.json'), JSON.stringify({ path: p }), 'utf8')
    } catch {}
}

async function openFile() {
    const result = await dialog.showOpenDialog(mainWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['openFile'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
        scriptMdPath = result.filePaths[0]
        saveLastFilePath(scriptMdPath)
        mainWindow.reload()
    }
}
const hostname = os.hostname().split('.')[0]

const defaultSettings = {
    mainAudioDevice: null, monitorAudioDevice: null, monitorOffsetMs: 0,
    midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null,
    editorApp: null, editorCustomCmd: '',
}

function openLineInEditor(settings, line) {
    const p = scriptMdPath.replace(/"/g, '\\"')
    let cmd
    if (settings.editorApp === 'vscode') {
        cmd = `code --goto "${p}:${line}"`
    } else if (settings.editorApp === 'zed') {
        cmd = `zed "${p}:${line}"`
    } else if (settings.editorApp === 'custom' && settings.editorCustomCmd) {
        cmd = settings.editorCustomCmd
            .replace('{file}', `"${p}"`)
            .replace('{line}', String(line))
    }
    if (cmd) exec(cmd)
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
let roleEditorWindow = null

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        title: 'Main Desk',
        icon: path.join(__dirname, '../dist/assets/icon.png'),
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
        height: 640,
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
    roleEditorWindow.loadFile(path.join(__dirname, '../dist/role-editor.html'))
    roleEditorWindow.on('closed', () => { roleEditorWindow = null })
}

async function createNewFile() {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: 'skript.md',
    })
    if (!result.canceled && result.filePath) {
        const template = '```yaml\nconfig:\n    roles: {}\n```\n'
        fs.writeFileSync(result.filePath, template, 'utf8')
        scriptMdPath = result.filePath
        saveLastFilePath(scriptMdPath)
        mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(createRoleEditorWindow, 400)
        })
        mainWindow.reload()
    }
}

function buildMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.getName(),
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                {
                    label: 'Neue Datei…',
                    accelerator: 'Cmd+N',
                    click: createNewFile,
                },
                {
                    label: 'Datei öffnen…',
                    accelerator: 'Cmd+O',
                    click: openFile,
                },
                { type: 'separator' },
                {
                    label: 'Einstellungen…',
                    accelerator: 'Cmd+,',
                    click: createSettingsWindow,
                },
                {
                    label: 'Rolleneditor…',
                    click: createRoleEditorWindow,
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : [{
            label: 'Datei',
            submenu: [
                {
                    label: 'Neue Datei…',
                    accelerator: 'Ctrl+N',
                    click: createNewFile,
                },
                {
                    label: 'Öffnen…',
                    accelerator: 'Ctrl+O',
                    click: openFile,
                },
            ],
        }, {
            label: 'Einstellungen',
            submenu: [{
                label: 'MIDI-Geräte…',
                accelerator: 'Ctrl+,',
                click: createSettingsWindow,
            }, {
                label: 'Rolleneditor…',
                click: createRoleEditorWindow,
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
    if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, '../dist/assets/icon.png'))
    }
    scriptMdPath = getLastFilePath()

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

    ipcMain.handle('get-script-path', () => scriptMdPath)

    ipcMain.handle('list-audio-files', () => {
        const audioDir = path.join(__dirname, '../dist/audio')
        try {
            return fs.readdirSync(audioDir).filter(f => /\.(mp3|wav)$/i.test(f)).sort()
        } catch {
            return []
        }
    })

    ipcMain.handle('get-roles', () => {
        try {
            const { parsed } = readConfigBlock()
            return parsed?.config?.roles || {}
        } catch { return {} }
    })

    ipcMain.handle('save-roles', (_, { roles, renames }) => {
        let text = fs.readFileSync(scriptMdPath, 'utf8')
        for (const { from, to } of (renames || [])) {
            if (!from || !to || from === to) continue
            const re = new RegExp(`\\*\\*${escapeRegex(from)}\\*\\*`, 'g')
            text = text.replace(re, `**${to}**`)
        }
        const m = text.match(/```yaml\n([\s\S]*?)\n```/)
        if (m) {
            try {
                const parsed = yaml.load(m[1])
                if (parsed?.config) {
                    parsed.config.roles = roles
                    const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
                    const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
                    text = text.replace(m[0], newBlock)
                }
            } catch (e) {
                console.warn('save-roles YAML error:', e.message)
            }
        }
        fs.writeFileSync(scriptMdPath, text, 'utf8')
        BrowserWindow.getAllWindows().forEach(win => win.webContents.send('script-changed'))
    })

    ipcMain.handle('new-file', () => createNewFile())

    ipcMain.handle('show-editor-context-menu', (event, line) => {
        const settings = loadSettings()
        if (!settings.editorApp) return
        const menu = Menu.buildFromTemplate([{
            label: 'In Editor öffnen',
            click: () => openLineInEditor(settings, line),
        }])
        menu.popup({ window: BrowserWindow.fromWebContents(event.sender) })
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
