const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keygenApi', {
  generate: (count, tier) => ipcRenderer.invoke('keygen:generate', count, tier),
  copy: (text) => ipcRenderer.invoke('keygen:copy', text),
  minimize: () => ipcRenderer.invoke('keygen:minimize'),
  close: () => ipcRenderer.invoke('keygen:close'),
  getSystemInfo: () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} (${process.arch})`
  })
});
