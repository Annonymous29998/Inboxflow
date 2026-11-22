const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inboxflowDesktop', {
  isDesktop: true,
  platform: process.platform,
  openBrowser: () => ipcRenderer.send('inboxflow:open-browser'),
  saveBoundIp: (ip) => ipcRenderer.send('inboxflow:save-bound-ip', ip),
  bindBlocked: () => ipcRenderer.send('inboxflow:bind-blocked'),
  quitApp: () => ipcRenderer.send('inboxflow:quit'),
  onSplash: (cb) => {
    ipcRenderer.on('inboxflow:splash', (_evt, payload) => {
      try {
        cb(payload);
      } catch {
        /* ignore */
      }
    });
  },
});
