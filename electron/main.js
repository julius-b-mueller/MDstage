const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const settingsPath = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
        return { midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null }
    }
}

function persistSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
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
        width: 420,
        height: 330,
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

    ipcMain.handle('write-script-md', (_, content) => {
        const scriptPath = path.join(__dirname, '../dist/script.md')
        fs.writeFileSync(scriptPath, content, 'utf8')
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
