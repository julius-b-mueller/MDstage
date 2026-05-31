const { contextBridge, ipcRenderer } = require('electron')

// Dispatch DOM events so the renderer can listen without crossing the contextBridge
// callback boundary (which is unreliable for renderer→preload function references).
ipcRenderer.on('live-go',   () => {
    console.log('[preload] live-go received, dispatching event')
    window.dispatchEvent(new CustomEvent('__live-go__'))
})
ipcRenderer.on('live-back', () => {
    console.log('[preload] live-back received, dispatching event')
    window.dispatchEvent(new CustomEvent('__live-back__'))
})

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getHostname: () => ipcRenderer.invoke('get-hostname'),
    getScriptMd: () => ipcRenderer.invoke('get-script-md'),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    listAudioFiles: () => ipcRenderer.invoke('list-audio-files'),
    getScriptPath: () => ipcRenderer.invoke('get-script-path'),
    backupScriptMd: () => ipcRenderer.invoke('backup-script-md'),
    getRoles: () => ipcRenderer.invoke('get-roles'),
    saveRoles: (data) => ipcRenderer.invoke('save-roles', data),
    newFile: () => ipcRenderer.invoke('new-file'),
    onSettingsChanged: (callback) => {
        ipcRenderer.on('settings-changed', (_, settings) => callback(settings))
    },
    onScriptChanged: (callback) => {
        ipcRenderer.on('script-changed', () => callback())
    },
    showEditorContextMenu: (line) => ipcRenderer.invoke('show-editor-context-menu', line),
    sendLiveState: (state) => ipcRenderer.invoke('send-live-state', state),
    sendLiveVolumes: (volumes) => ipcRenderer.send('send-live-volumes', volumes),
    onLiveVolumes: (callback) => { ipcRenderer.on('live-volumes', (_, v) => callback(v)) },
    liveGo: () => ipcRenderer.send('live-go'),
    liveBack: () => ipcRenderer.send('live-back'),
    selectVariant: (idx) => ipcRenderer.send('live-select-variant', idx),
    stopAudio: (cueIdx) => ipcRenderer.send('live-stop-audio', cueIdx),
    onLiveState: (callback) => {
        ipcRenderer.on('live-state', (_, state) => callback(state))
    },
    onLiveGo: (callback) => {
        ipcRenderer.on('live-go', () => callback())
    },
    onLiveBack: (callback) => {
        ipcRenderer.on('live-back', () => callback())
    },
    onLiveWindowState: (callback) => {
        ipcRenderer.on('live-window-state', (_, isOpen) => callback(isOpen))
    },
    exportPdf: (data) => ipcRenderer.invoke('export-pdf', data),
    exportDocx: (data) => ipcRenderer.invoke('export-docx', data),
})
