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

ipcRenderer.on('file-transfer-progress', (_, data) => {
  window.dispatchEvent(new CustomEvent('fileTransferProgress', { detail: data }));
});

contextBridge.exposeInMainWorld('electronAPI', {
  listJarFiles: () => ipcRenderer.invoke('listJarFiles'),
  createServer: (data) => ipcRenderer.invoke('create-server', data),
  updateServer: (serverData, changes) => ipcRenderer.invoke('update-server', serverData, changes),
  deleteServer: (serverData, options) => ipcRenderer.invoke('delete-server', serverData, options),
  createMasterServer: (masterServerData) => ipcRenderer.invoke('createMasterServer', masterServerData),
  updateMasterServer: (id, data) => ipcRenderer.invoke('update-master-server', id, data),
  deleteMasterServer: (id) => ipcRenderer.invoke('delete-master-server', id),
  loadMasterServers: () => ipcRenderer.invoke('loadMasterServers'),
  forgetHostKey: (target) => ipcRenderer.invoke('forget-host-key', target),
  getServerStatus: (serverData) => ipcRenderer.invoke('get-server-status', serverData),
  listServerFiles: (serverData, path) => ipcRenderer.invoke('list-server-files', serverData, path),
  deleteServerFile: (serverData, filePath) => ipcRenderer.invoke('delete-server-file', serverData, filePath),
  renameServerFile: (serverData, filePath, newName) => ipcRenderer.invoke('rename-server-file', serverData, filePath, newName),
  downloadServerFile: (serverData, filePath) => ipcRenderer.invoke('download-server-file', serverData, filePath),
  loadServers: () => ipcRenderer.invoke('load-servers'),
  startServer: (serverData) => ipcRenderer.invoke('start-server', serverData),
  stopServer: (serverData) => ipcRenderer.invoke('stop-server', serverData),
  loadLatestLog: (serverData) => ipcRenderer.invoke('load-latest-log', serverData),
  getLatestLog: (serverData) => ipcRenderer.invoke('get-latest-log', serverData),
  startLogStream: (serverData) => ipcRenderer.send('stream-log', serverData),
  stopLogStream: (serverData) => ipcRenderer.invoke('stop-log-stream', serverData),
  sendServerCommand: (serverData, command) => ipcRenderer.invoke('sendServerCommand', serverData, command),
  uploadFilesToServer: (server) => ipcRenderer.invoke('upload-files-to-server', server),
  uploadServerSoftware: (name, data) => ipcRenderer.invoke('upload-server-software', name, data),
  createBackup: (serverData) => ipcRenderer.invoke('create-backup', serverData),
  listBackups: (serverData) => ipcRenderer.invoke('list-backups', serverData),
  downloadBackup: (serverData, fileName) => ipcRenderer.invoke('download-backup', serverData, fileName),
  deleteBackup: (serverData, fileName) => ipcRenderer.invoke('delete-backup', serverData, fileName),
  reloadWindow: () => ipcRenderer.invoke('reload-window'),
  getVersion: () => ipcRenderer.invoke('app-version')
});
