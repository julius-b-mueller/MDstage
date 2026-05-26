const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getHostname: () => ipcRenderer.invoke('get-hostname'),
    getScriptMd: () => ipcRenderer.invoke('get-script-md'),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    listAudioFiles: () => ipcRenderer.invoke('list-audio-files'),
    getScriptPath: () => ipcRenderer.invoke('get-script-path'),
    onSettingsChanged: (callback) => {
        ipcRenderer.on('settings-changed', (_, settings) => callback(settings))
    },
})
