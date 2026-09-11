// Verdrahtet die reine Persistenzlogik (store-factory.js) mit den echten
// Electron-Pfaden/-APIs. Passwörter werden über Electrons safeStorage
// (unter Windows: DPAPI) verschlüsselt auf der Platte abgelegt.

const { app, safeStorage } = require('electron');
const path = require('path');
const { createStore } = require('./store-factory');

const dataDir = path.join(app.getPath('userData'), 'data');
const jarsDir = path.join(app.getPath('userData'), 'jars');

module.exports = createStore({
    dataDir,
    jarsDir,
    safeStorage,
    bundledJarsDir: path.join(__dirname, '..', 'jars')
});
