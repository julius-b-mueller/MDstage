const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    writeScriptMd: (content) => ipcRenderer.invoke('write-script-md', content),
    onSettingsChanged: (callback) => {
        ipcRenderer.on('settings-changed', (_, settings) => callback(settings))
    },
})
