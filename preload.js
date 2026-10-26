const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  cut: (opts) => ipcRenderer.invoke('cut', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, v) => cb(v)),
});
