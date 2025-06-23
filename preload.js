const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('log-stream-data', (_, data) => {
  window.dispatchEvent(new CustomEvent('logStreamData', { detail: data }));
});

ipcRenderer.on('log-stream-error', (_, error) => {
  window.dispatchEvent(new CustomEvent('logStreamError', { detail: error }));
});

ipcRenderer.on('log-stream-end', () => {
  window.dispatchEvent(new CustomEvent('logStreamEnd'));
});

contextBridge.exposeInMainWorld('electronAPI', {
    listJarFiles: () => ipcRenderer.invoke('listJarFiles'),
    createServer: (data) => ipcRenderer.invoke('create-server', data),
    createMasterServer: (masterServerData) => ipcRenderer.invoke('createMasterServer', masterServerData),
    loadMasterServers: () => ipcRenderer.invoke('loadMasterServers'),
    listServerFiles: (serverData, path) => ipcRenderer.invoke('list-server-files', serverData, path),
    loadServers: () => ipcRenderer.invoke('load-servers'),
    startServer: (serverData) => ipcRenderer.invoke('start-server', serverData),
    stopServer: (serverData) => ipcRenderer.invoke('stop-server', serverData),
    loadLatestLog: (serverData) => ipcRenderer.invoke('load-latest-log', serverData),
    getLatestLog: (serverData) => ipcRenderer.invoke('get-latest-log', serverData),
    startLogStream: (serverData) => ipcRenderer.send('stream-log', serverData),
    stopLogStream: (serverData) => ipcRenderer.invoke('stop-log-stream', serverData),
    sendServerCommand: (serverData, command) => ipcRenderer.invoke('sendServerCommand', serverData, command),
    uploadFilesToServer: (server) => ipcRenderer.invoke('upload-files-to-server', server)
});
