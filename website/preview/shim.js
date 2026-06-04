// Preview shim — provides browser-compatible electronAPI and disables MIDI/OSC.
// Loaded before bundle.js in preview-main.html, and before the inline script in preview-live.html.

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

// ── electronAPI shim ──────────────────────────────────────────────────────────

const _settings = {
    mainAudioDevice: null,
    mainChannelL: 0, mainChannelR: 1,
    monitorChannelL: 0, monitorChannelR: 1,
    midiX32Device: null, midiTriggerDevice: null, midiTCDevice: null,
    editorApp: null, editorCustomCmd: '',
    midiGoNote: null, midiBackNote: null, midiLiveDevice: null,
    oscEnabled: false, oscHost: '127.0.0.1', oscPort: 8000,
    monitorEnabled: false,
    appLanguage: 'de',
}

let _scriptCache = null
const _liveStateListeners  = []
const _liveVolumeListeners = []

window.electronAPI = {
    getAppVersion: () => Promise.resolve('0.0.0'),
    getBuildInfo:  () => Promise.resolve({ commit: 'preview', date: '' }),
    getSettings:       () => Promise.resolve({ ..._settings }),
    saveSettings:      () => Promise.resolve(),
    getHostname:       () => Promise.resolve('preview'),

    getScriptMd: () => {
        if (_scriptCache !== null) return Promise.resolve(_scriptCache)
        return fetch('script.md')
            .then(r => { if (!r.ok) throw new Error('script.md not found'); return r.text() })
            .then(t  => { _scriptCache = t; return t })
            .catch(() => { const t = '```yaml\nconfig:\n    roles: {}\n```\n'; _scriptCache = t; return t })
    },
    writeScriptMd:  (t) => { _scriptCache = t; return Promise.resolve() },
    listAudioFiles: () => Promise.resolve([]),
    getScriptPath:  () => Promise.resolve('preview/script.md'),
    backupScriptMd: () => Promise.resolve(''),
    getRoles:       () => Promise.resolve({}),
    saveRoles:      () => Promise.resolve(),
    newFile:        () => Promise.resolve(),

    onSettingsChanged:     () => {},
    onScriptChanged:       () => {},
    showEditorContextMenu: () => {},

    // Main → Live (broadcast live state through wrapper page)
    sendLiveState:  (state)   => { window.parent.postMessage({ type: 'live-state',   state   }, '*'); return Promise.resolve() },
    sendLiveVolumes:(volumes) => { window.parent.postMessage({ type: 'live-volumes', volumes }, '*') },

    // Live window: register callbacks that receive messages from wrapper
    onLiveState:   (cb) => { _liveStateListeners.push(cb)  },
    onLiveVolumes: (cb) => { _liveVolumeListeners.push(cb) },

    // Live → Main commands (sent up to wrapper, then forwarded to main iframe)
    liveGo:       ()      => { window.parent.postMessage({ type: 'live-go'        }, '*') },
    liveBack:     ()      => { window.parent.postMessage({ type: 'live-back'       }, '*') },
    selectVariant:(idx)   => { window.parent.postMessage({ type: 'select-variant', idx     }, '*') },
    stopAudio:    (cueIdx)=> { window.parent.postMessage({ type: 'stop-audio',     cueIdx  }, '*') },

    onLiveGo:         () => {},
    onLiveBack:       () => {},
    // Live window is always "open" in the side-by-side preview
    onLiveWindowState:(cb) => { setTimeout(() => cb(true), 0) },
    openLiveWindow:   () => {},

    exportPdf:       () => Promise.resolve(),
    exportDocx:      () => Promise.resolve(),
    getEmLightNote:  () => Promise.resolve(null),
    saveEmLightNote: () => Promise.resolve(),
    sendOsc:         () => {},
}

// Route messages from the wrapper page to registered callbacks / live-action handlers
window.addEventListener('message', (e) => {
    if (!e.data?.type) return
    const { type } = e.data
    if (type === 'live-state')      _liveStateListeners.forEach(cb => cb(e.data.state))
    if (type === 'live-volumes')    _liveVolumeListeners.forEach(cb => cb(e.data.volumes))
    // Mirror the Electron preload's DOM-event dispatch so main.js listeners fire
    if (type === 'live-go')         window.dispatchEvent(new CustomEvent('__live-go__'))
    if (type === 'live-back')       window.dispatchEvent(new CustomEvent('__live-back__'))
    if (type === 'select-variant')  window.__selectVariant?.(e.data.idx)
    if (type === 'stop-audio')      window.__stopAudio?.(e.data.cueIdx)
})
