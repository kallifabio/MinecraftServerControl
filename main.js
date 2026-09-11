const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const store = require('./lib/store');
const ssh = require('./lib/ssh-service');
const { registerIpcHandlers } = require('./lib/ipc-handlers');

// Auto-Update: prüft beim Start still auf eine neuere, signierte Version und
// installiert sie beim nächsten Neustart der App. Wirkt nur, wenn unter
// build.publish (package.json) ein echtes Release-Ziel (z.B. GitHub Releases)
// konfiguriert und dort tatsächlich ein Release veröffentlicht ist - ohne das
// bleibt der Check ein no-op (loggt lediglich einen Fehler).
function checkForUpdates() {
    if (!app.isPackaged) return; // im Entwicklungsbetrieb sinnlos/würde fehlschlagen
    autoUpdater.autoDownload = true;
    autoUpdater.on('error', (err) => console.error('Auto-Update-Fehler:', err.message));
    autoUpdater.checkForUpdatesAndNotify().catch(err => console.error('Auto-Update-Check fehlgeschlagen:', err.message));
}

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
    ssh.closeAllPooledConnections();
});

app.whenReady().then(() => {
    store.ensureDirs();
    store.bootstrapBundledJars();
    registerIpcHandlers();

    createWindow();
    Menu.setApplicationMenu(null);
    checkForUpdates();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
