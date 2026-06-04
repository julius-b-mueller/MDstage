const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const { exec } = require('child_process')
app.setName('Main Desk')
const path = require('path')
const fs = require('fs')
const os = require('os')
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
    mainAudioDevice: null, mainChannelL: 0, mainChannelR: 1, monitorChannelL: 2, monitorChannelR: 3,
    midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null,
    editorApp: null, editorCustomCmd: '',
    midiGoNote: null, midiBackNote: null, midiLiveDevice: null,
    oscEnabled: false, oscHost: '127.0.0.1', oscPort: 8000,
    monitorEnabled: false,
    appLanguage: 'de',
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

// Keys that are personal/per-user and must not be stored in the shared markdown file
const EDITOR_PREF_KEYS = ['editorApp', 'editorCustomCmd']

function editorPrefsPath() {
    return path.join(app.getPath('userData'), 'editor-prefs.json')
}

function loadEditorPrefs() {
    try { return JSON.parse(fs.readFileSync(editorPrefsPath(), 'utf8')) } catch { return {} }
}

function saveEditorPrefs(settings) {
    const prefs = {}
    for (const k of EDITOR_PREF_KEYS) if (k in settings) prefs[k] = settings[k]
    fs.writeFileSync(editorPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}

// When launched from Applications/Spotlight the shell PATH is minimal — augment with common install locations
const AUGMENTED_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', process.env.PATH || ''].join(':')

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
    if (cmd) exec(cmd, { env: { ...process.env, PATH: AUGMENTED_PATH } })
}

function readConfigBlock() {
    const text = fs.readFileSync(scriptMdPath, 'utf8')
    const m = text.match(/```yaml\n([\s\S]*?)\n```/)
    if (!m) return { text, parsed: null, block: '' }
    return { text, parsed: yaml.load(m[1]), block: m[0] }
}

function loadSettings() {
    let base = { ...defaultSettings }
    try {
        const { parsed } = readConfigBlock()
        const mdSettings = parsed?.config?.settings?.[hostname]
        if (mdSettings != null) {
            // Strip editor keys — never trust them from a shared file
            const safe = { ...mdSettings }
            for (const k of EDITOR_PREF_KEYS) delete safe[k]
            base = { ...base, ...safe }
        }
    } catch (e) {
        console.warn('settings read error:', e.message)
    }
    return { ...base, ...loadEditorPrefs() }
}

function persistSettings(settings) {
    // Always persist editor prefs to userData, independent of the markdown file
    saveEditorPrefs(settings)

    const { text, parsed, block } = readConfigBlock()
    if (!parsed?.config) return

    // Strip editor keys before writing to the shared markdown file
    const mdSettings = { ...settings }
    for (const k of EDITOR_PREF_KEYS) delete mdSettings[k]

    let existing = parsed.config.settings ?? {}
    // Migrate from legacy flat format to hostname-keyed on first save
    if ('mainAudioDevice' in existing) existing = {}
    existing[hostname] = mdSettings
    parsed.config.settings = existing

    const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
    const newBlock = '```yaml\n' + newYaml.trimEnd() + '\n```'
    fs.writeFileSync(scriptMdPath, text.replace(block, newBlock), 'utf8')
}

let mainWindow = null
let settingsWindow = null
let roleEditorWindow = null
let liveWindow = null

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        title: 'Main Desk',
        icon: path.join(__dirname, '../dist/assets/icon.png'),
        acceptFirstMouse: true,
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
        width: 440,
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

function menuT(key) {
    const lang = loadSettings().appLanguage || 'de'
    // Minimal inline lookup — avoids pulling in the browser-side i18n.js
    const M = {
        de: {
            about: 'Über Main Desk…', newfile: 'Neue Datei…', open: 'Datei öffnen…',
            openwin: 'Öffnen…', settings: 'Einstellungen…', roleeditor: 'Rolleneditor…',
            liveview: 'Live-Ansicht…', export: 'Exportieren…', hide: 'Ausblenden',
            hideothers: 'Andere ausblenden', quit: 'Beenden',
            file: 'Datei', exportmenu: 'Exportieren', prefs: 'Einstellungen',
            midi: 'MIDI-Geräte…', help: 'Hilfe', edit: 'Bearbeiten',
            dev: 'Entwickler', devtools: 'DevTools öffnen', devlive: 'DevTools (Live-Fenster)',
            undo: 'Rückgängig', redo: 'Wiederholen', cut: 'Ausschneiden',
            copy: 'Kopieren', paste: 'Einfügen', selectall: 'Alles auswählen',
        },
        en: {
            about: 'About Main Desk…', newfile: 'New File…', open: 'Open File…',
            openwin: 'Open…', settings: 'Settings…', roleeditor: 'Role Editor…',
            liveview: 'Live View…', export: 'Export…', hide: 'Hide',
            hideothers: 'Hide Others', quit: 'Quit',
            file: 'File', exportmenu: 'Export', prefs: 'Settings',
            midi: 'MIDI Devices…', help: 'Help', edit: 'Edit',
            dev: 'Developer', devtools: 'Open DevTools', devlive: 'DevTools (Live window)',
            undo: 'Undo', redo: 'Redo', cut: 'Cut',
            copy: 'Copy', paste: 'Paste', selectall: 'Select All',
        },
    }
    return (M[lang] || M.de)[key] ?? key
}

function buildMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.getName(),
            submenu: [
                {
                    label: menuT('about'),
                    click: () => dialog.showMessageBox(mainWindow ?? null, {
                        type: 'info',
                        title: 'Main Desk',
                        message: 'Main Desk',
                        detail: `Version ${app.getVersion()}${buildInfo.date ? '  ·  ' + buildInfo.date : ''}\nCommit: ${buildInfo.commit}`,
                        buttons: ['OK'],
                    }),
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
            ],
        }, {
            label: menuT('exportmenu'),
            submenu: [{
                label: menuT('export'),
                accelerator: 'Ctrl+E',
                click: () => { if (mainWindow) mainWindow.webContents.executeJavaScript('window.__runExport && window.__runExport()').catch(() => {}) },
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
                    title: 'Main Desk',
                    message: 'Main Desk',
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
                const micStr = (item.micRoles || [item.mic]).join(', ')
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
        creator: 'Main Desk',
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
    scriptMdPath = getLastFilePath()
    if (!scriptMdPath) {
        const result = await dialog.showOpenDialog({
            title: 'Skript öffnen',
            filters: [{ name: 'Markdown', extensions: ['md'] }],
            properties: ['openFile'],
        })
        if (result.canceled || !result.filePaths.length) {
            app.quit()
            return
        }
        scriptMdPath = result.filePaths[0]
        saveLastFilePath(scriptMdPath)
    }

    ipcMain.on('send-osc', (_, { path: oscPath, args = [], host = '127.0.0.1', port = 8000 }) => {
        try {
            const msg = encodeOscMessage(oscPath, args)
            const sock = dgram.createSocket('udp4')
            sock.send(msg, port, host, () => sock.close())
        } catch (e) {
            console.error('OSC send error:', e.message)
        }
    })

    ipcMain.handle('get-settings', () => loadSettings())

    ipcMain.handle('save-settings', (_, settings) => {
        persistSettings(settings)
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('settings-changed', settings)
        })
        Menu.setApplicationMenu(buildMenu())
    })

    ipcMain.handle('get-hostname', () => hostname)

    ipcMain.handle('get-script-md', () => fs.readFileSync(scriptMdPath, 'utf8'))

    ipcMain.handle('write-script-md', (_, content) => {
        fs.writeFileSync(scriptMdPath, content, 'utf8')
    })

    ipcMain.handle('get-script-path', () => scriptMdPath)

    ipcMain.handle('backup-script-md', () => {
        const backupPath = scriptMdPath.replace(/\.md$/, '~unformatted.md')
        fs.copyFileSync(scriptMdPath, backupPath)
        return path.basename(backupPath)
    })

    ipcMain.handle('list-audio-files', () => {
        const audioDir = path.join(path.dirname(scriptMdPath), 'audio')
        try {
            if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir)
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
        fs.writeFileSync(scriptMdPath, text.replace(block, newBlock), 'utf8')
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
    ipcMain.on('live-go', () => {
        if (mainWindow) mainWindow.webContents.executeJavaScript('window.__liveGo && window.__liveGo()').catch(() => {})
    })
    ipcMain.on('live-back', () => {
        if (mainWindow) mainWindow.webContents.executeJavaScript('window.__liveBack && window.__liveBack()').catch(() => {})
    })
    ipcMain.on('live-select-variant', (_, idx) => {
        if (mainWindow) mainWindow.webContents.executeJavaScript(`window.__selectVariant && window.__selectVariant(${parseInt(idx)})`).catch(() => {})
    })
    ipcMain.on('live-stop-audio', (_, cueIdx) => {
        if (mainWindow) mainWindow.webContents.executeJavaScript(`window.__stopAudio && window.__stopAudio(${parseInt(cueIdx)})`).catch(() => {})
    })

    if (process.argv.includes('--test-gapless')) {
        const testWin = new BrowserWindow({
            width: 720, height: 540,
            title: 'Gapless Audio Test',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        })
        testWin.loadFile(path.join(__dirname, '../test-gapless/index.html'))
        testWin.webContents.openDevTools({ mode: 'bottom' })
        return
    }

    Menu.setApplicationMenu(buildMenu())
    createMainWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
