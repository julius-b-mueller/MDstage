const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getHostname: () => ipcRenderer.invoke('get-hostname'),
    getScriptMd: () => ipcRenderer.invoke('get-script-md'),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    listAudioFiles: () => ipcRenderer.invoke('list-audio-files'),
    getScriptPath: () => ipcRenderer.invoke('get-script-path'),
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
})
