const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getScriptMd: () => ipcRenderer.invoke('get-script-md'),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    listAudioFiles: () => ipcRenderer.invoke('list-audio-files'),
    onSettingsChanged: (callback) => {
        ipcRenderer.on('settings-changed', (_, settings) => callback(settings))
    },
})
