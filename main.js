const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const path = require('path');

const store = require('./lib/store');
const { registerIpcHandlers } = require('./lib/ipc-handlers');

function createWindow() {
    const win = new BrowserWindow({
        width: 1080,
        height: 720,
        icon: 'renderer/images/logo.png',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    win.loadFile('renderer/index.html');

    globalShortcut.register('F5', () => win.reload());
    globalShortcut.register('CmdOrCtrl+R', () => win.reload());

    // DevTools nur im Entwicklungsbetrieb zulassen, nicht im gepackten Build.
    if (!app.isPackaged) {
        globalShortcut.register('Ctrl+D', () => win.webContents.openDevTools());
    }
}

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.whenReady().then(() => {
    store.ensureDirs();
    store.bootstrapBundledJars();
    registerIpcHandlers();

    createWindow();
    Menu.setApplicationMenu(null);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
