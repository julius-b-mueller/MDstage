// Preview shim — provides browser-compatible electronAPI and disables MIDI/OSC.
// Communication between main view and live view uses BroadcastChannel so both
// iframes and standalone windows work without a routing wrapper.

window.__webPreview = true

// Silence MIDI permission request (no browser dialog, empty access object)
navigator.requestMIDIAccess = () => Promise.resolve({
    inputs:  { values: () => [][Symbol.iterator](), forEach: () => {}, size: 0 },
    outputs: { values: () => [][Symbol.iterator](), forEach: () => {}, size: 0 },
    sysexEnabled: false,
    onstatechange: null,
    addEventListener:    () => {},
    removeEventListener: () => {},
    dispatchEvent:       () => false,
})

// ── BroadcastChannel (replaces postMessage routing through wrapper) ────────────
// Works across iframes AND separate windows as long as they share the same origin.
const _ch = new BroadcastChannel('maindesk-preview')

let _liveWindowStateListeners = []
let _livePopupWin = null

const _liveStateListeners  = []
const _liveVolumeListeners = []

_ch.onmessage = ({ data }) => {
    if (!data?.type) return
    const { type } = data
    if (type === 'live-state')        _liveStateListeners.forEach(cb => cb(data.state))
    if (type === 'live-volumes')      _liveVolumeListeners.forEach(cb => cb(data.volumes))
    if (type === 'live-go')           window.dispatchEvent(new CustomEvent('__live-go__'))
    if (type === 'live-back')         window.dispatchEvent(new CustomEvent('__live-back__'))
    if (type === 'select-variant')    window.__selectVariant?.(data.idx)
    if (type === 'stop-audio')        window.__stopAudio?.(data.cueIdx)
    if (type === 'settings-changed')  _settingsChangedListeners.forEach(cb => cb(data.settings))
    if (type === 'roles-saved')       window.__handleRolesSaved?.({ roles: data.roles, renames: data.renames, groups: data.groups })
}

// ── electronAPI shim ──────────────────────────────────────────────────────────

const _settings = {
    mainAudioDevice: null,
    mainChannelL: 0, mainChannelR: 1,
    monitorChannelL: 0, monitorChannelR: 1,
    outputDevices: [],
    midiTCDevice: null,
    editorApp: null, editorCustomCmd: '',
    midiGoNote: null, midiBackNote: null, midiLiveDevice: null,
    monitorEnabled: false,
    appLanguage: 'de',
}

let _scriptCache = null
const _settingsChangedListeners = []
const _scriptChangedListeners  = []

// Sprache wechseln und App-interne onSettingsChanged-Callbacks aufrufen
window.__previewSetLanguage = (lang) => {
    _settings.appLanguage = lang
    try { sessionStorage.setItem('preview-lang', lang) } catch {}
    // Statische data-i18n-Elemente sofort aktualisieren
    window.applyI18n?.(lang)
    // Dynamisch gebaute Trigger-Buttons etc. neu rendern
    window.__rerender?.()
    // Interne appLanguage-Variable + Live-Ansicht via nächsten broadcastLiveState
    _settingsChangedListeners.forEach(cb => cb({ ..._settings }))
    document.querySelectorAll('.plang-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.lang === lang)
    )
}

// Gespeicherte Sprachpräferenz beim Laden wiederherstellen
try {
    const saved = sessionStorage.getItem('preview-lang')
    if (saved) _settings.appLanguage = saved
} catch {}

const _versionInfo = fetch('../app/version.json').then(r => r.ok ? r.json() : {}).catch(() => ({}))

window.electronAPI = {
    getAppVersion: () => _versionInfo.then(v => v.version || '—'),
    getBuildInfo:  () => _versionInfo.then(v => ({ commit: v.commit || 'preview', date: v.date || '' })),
    getSettings:       () => Promise.resolve({ ..._settings }),
    saveSettings:      (s) => { Object.assign(_settings, s); _ch.postMessage({ type: 'settings-changed', settings: { ..._settings } }); return Promise.resolve() },
    getHostname:       () => Promise.resolve('preview'),
    getEmLightNote:    () => Promise.resolve(_settings.emLightNote || null),
    saveEmLightNote:   (v) => { _settings.emLightNote = v; return Promise.resolve() },

    getScriptMd: () => {
        if (_scriptCache !== null) return Promise.resolve(_scriptCache)
        return fetch('script.md')
            .then(r => { if (!r.ok) throw new Error('script.md not found'); return r.text() })
            .then(t  => { _scriptCache = t; return t })
            .catch(() => { const t = '```yaml\nconfig:\n    roles: {}\n```\n'; _scriptCache = t; return t })
    },
    writeScriptMd:  (t) => { _scriptCache = t; _scriptChangedListeners.forEach(cb => cb()); return Promise.resolve() },
    listAudioFiles: () => fetch('audio/files.json').then(r => r.ok ? r.json() : []).catch(() => []),
    getScriptPath:  () => Promise.resolve('preview/script.md'),
    backupScriptMd: () => Promise.resolve(''),
    getRoles: () => {
        try {
            const s = localStorage.getItem('preview-roles')
            if (s) return Promise.resolve(JSON.parse(s))
        } catch {}
        return Promise.resolve({ roles: {}, groups: {} })
    },
    saveRoles: ({ roles, renames, groups }) => {
        try { localStorage.setItem('preview-roles', JSON.stringify({ roles, groups })) } catch {}
        _ch.postMessage({ type: 'roles-saved', roles, renames, groups })
        return Promise.resolve()
    },
    newFile:        () => Promise.resolve(),

    onSettingsChanged: (cb) => _settingsChangedListeners.push(cb),
    onScriptChanged:   (cb) => _scriptChangedListeners.push(cb),
    showEditorContextMenu: () => {},

    // Main → broadcasts live state to all listeners (iframes + separate windows)
    sendLiveState:  (state)   => { _ch.postMessage({ type: 'live-state',   state   }); return Promise.resolve() },
    sendLiveVolumes:(volumes) => { _ch.postMessage({ type: 'live-volumes', volumes }) },

    // Live → receives state updates
    onLiveState:   (cb) => _liveStateListeners.push(cb),
    onLiveVolumes: (cb) => _liveVolumeListeners.push(cb),

    // Live → sends commands back to main
    liveGo:       ()       => _ch.postMessage({ type: 'live-go' }),
    liveBack:     ()       => _ch.postMessage({ type: 'live-back' }),
    selectVariant:(idx)    => _ch.postMessage({ type: 'select-variant', idx }),
    stopAudio:    (cueIdx) => _ch.postMessage({ type: 'stop-audio',     cueIdx }),

    onLiveGo:  () => {},
    onLiveBack: () => {},
    onLiveWindowState: (cb) => { _liveWindowStateListeners.push(cb) },

    openRoleEditor: () => {
        window.open('preview-role-editor.html', 'maindesk-roles', 'width=560,height=700,menubar=no,toolbar=no,location=no,status=no')
    },

    // Opens the live view in a separate browser window
    openLiveWindow: () => {
        if (_livePopupWin && !_livePopupWin.closed) { _livePopupWin.focus(); return }
        _livePopupWin = window.open(
            'preview-live.html',
            'maindesk-live',
            'width=960,height=720,menubar=no,toolbar=no,location=no,status=no'
        )
        if (!_livePopupWin) return
        _liveWindowStateListeners.forEach(cb => cb(true))
        const poll = setInterval(() => {
            if (_livePopupWin?.closed) {
                clearInterval(poll)
                _livePopupWin = null
                _liveWindowStateListeners.forEach(cb => cb(false))
            }
        }, 500)
    },

    exportPdf:       () => Promise.resolve(),
    exportDocx:      () => Promise.resolve(),
    getEmLightNote:  () => Promise.resolve(null),
    saveEmLightNote: () => Promise.resolve(),
    sendOsc:         () => {},
}
