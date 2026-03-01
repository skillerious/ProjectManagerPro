const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set(['get-app-version-info']);
const SEND_CHANNELS = new Set(['splash-complete']);

contextBridge.exposeInMainWorld('splashAPI', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      throw new Error(`Channel is not allowed: ${channel}`);
    }

    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (!SEND_CHANNELS.has(channel)) {
      throw new Error(`Channel is not allowed: ${channel}`);
    }

    ipcRenderer.send(channel, ...args);
  }
});
