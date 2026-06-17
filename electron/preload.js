const { contextBridge, ipcRenderer, webUtils } = require('electron')

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
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getBuildInfo:  () => ipcRenderer.invoke('get-build-info'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    saveEditorPrefs: (partial) => ipcRenderer.invoke('save-editor-prefs', partial),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    setSuppressVersionBump: (val) => ipcRenderer.invoke('set-suppress-version-bump', val),
    getHostname: () => ipcRenderer.invoke('get-hostname'),
    getScriptMd: () => ipcRenderer.invoke('get-script-md'),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    listAudioFiles: () => ipcRenderer.invoke('list-audio-files'),
    handleAudioDrop: (srcPath) => ipcRenderer.invoke('handle-audio-drop', srcPath),
    getPathForFile:  (file)    => webUtils.getPathForFile(file),
    getScriptPath: () => ipcRenderer.invoke('get-script-path'),
    backupScriptMd: () => ipcRenderer.invoke('backup-script-md'),
    backupScriptMdVersioned: (version) => ipcRenderer.invoke('backup-script-md-versioned', version),
    writeIncompatibilityLog: (data) => ipcRenderer.invoke('write-incompatibility-log', data),
    getRoles: () => ipcRenderer.invoke('get-roles'),
    saveRoles: (data) => ipcRenderer.invoke('save-roles', data),
    newFile: () => ipcRenderer.invoke('new-file'),
    onSettingsChanged: (callback) => {
        const handler = (_, settings) => callback(settings)
        ipcRenderer.on('settings-changed', handler)
        return () => ipcRenderer.removeListener('settings-changed', handler)
    },
    onScriptChanged: (callback) => {
        const handler = () => callback()
        ipcRenderer.on('script-changed', handler)
        return () => ipcRenderer.removeListener('script-changed', handler)
    },
    showEditorContextMenu: (line) => ipcRenderer.invoke('show-editor-context-menu', line),
    sendLiveState: (state) => ipcRenderer.invoke('send-live-state', state),
    sendLiveVolumes: (volumes) => ipcRenderer.send('send-live-volumes', volumes),
    onLiveVolumes: (callback) => {
        const handler = (_, v) => callback(v)
        ipcRenderer.on('live-volumes', handler)
        return () => ipcRenderer.removeListener('live-volumes', handler)
    },
    liveGo: () => ipcRenderer.send('live-go'),
    liveBack: () => ipcRenderer.send('live-back'),
    selectVariant: (idx) => ipcRenderer.send('live-select-variant', idx),
    stopAudio: (cueIdx) => ipcRenderer.send('live-stop-audio', cueIdx),
    onLiveState: (callback) => {
        const handler = (_, state) => callback(state)
        ipcRenderer.on('live-state', handler)
        return () => ipcRenderer.removeListener('live-state', handler)
    },
    onLiveGo: (callback) => {
        const handler = () => callback()
        ipcRenderer.on('live-go', handler)
        return () => ipcRenderer.removeListener('live-go', handler)
    },
    onLiveBack: (callback) => {
        const handler = () => callback()
        ipcRenderer.on('live-back', handler)
        return () => ipcRenderer.removeListener('live-back', handler)
    },
    onLiveWindowState: (callback) => {
        const handler = (_, isOpen) => callback(isOpen)
        ipcRenderer.on('live-window-state', handler)
        return () => ipcRenderer.removeListener('live-window-state', handler)
    },
    openLiveWindow: () => ipcRenderer.send('open-live-window'),
    openRoleEditor: () => ipcRenderer.send('open-role-editor'),
    quitApp: () => ipcRenderer.send('quit-app'),
    openFileWelcome: () => ipcRenderer.invoke('open-file-welcome'),
    onWelcomeDialog: (cb) => ipcRenderer.once('welcome-dialog', cb),
    exportPdf: (data) => ipcRenderer.invoke('export-pdf', data),
    exportDocx: (data) => ipcRenderer.invoke('export-docx', data),
    getEmLightNote: () => ipcRenderer.invoke('get-em-light-note'),
    saveEmLightNote: (note) => ipcRenderer.invoke('save-em-light-note', note),
    sendOsc: (data) => ipcRenderer.send('send-osc', data),
})
