const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store-factory');

// Fake safeStorage - simuliert Electrons DPAPI-gestützte Verschlüsselung ohne
// eine echte Electron-Runtime zu benötigen.
function fakeSafeStorage(available = true) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
    };
}

function tempDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-store-test-'));
    return { dataDir: path.join(root, 'data'), jarsDir: path.join(root, 'jars') };
}

test('ensureDirs initialisiert servers/masterservers als leere Arrays', () => {
    const { dataDir, jarsDir } = tempDirs();
    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage() });
    store.ensureDirs();

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'masterservers.json'), 'utf8')), []);
});

test('saveServers/loadServers round-trip verschlüsselt das Passwort auf der Platte', () => {
    const { dataDir, jarsDir } = tempDirs();
    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage() });

    store.saveServers([{ name: 'srv1', masterServerId: 'm1', password: 'secret' }]);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'));
    assert.equal(onDisk[0].password.__enc, true, 'Passwort muss auf der Platte verschlüsselt sein');
    assert.notEqual(onDisk[0].password.data, 'secret');

    const loaded = store.loadServers();
    assert.equal(loaded[0].password, 'secret', 'Passwort muss beim Laden wieder entschlüsselt werden');
});

test('loadServers behandelt das kaputte Alt-Format "{}" als leere Liste und heilt sich selbst', () => {
    const { dataDir, jarsDir } = tempDirs();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'servers.json'), '{}', 'utf8');

    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage() });
    const loaded = store.loadServers();

    assert.deepEqual(loaded, []);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'));
    assert.deepEqual(onDisk, [], 'Datei muss nach dem Laden auf das korrekte Array-Format repariert sein');
});

test('loadMasterServers vergibt fehlende IDs und persistiert sie', async () => {
    const { dataDir, jarsDir } = tempDirs();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
        path.join(dataDir, 'masterservers.json'),
        JSON.stringify([{ name: 'Test', ip: '1.2.3.4', sshPort: 22, username: 'root', password: 'pw' }]),
        'utf8'
    );

    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage() });
    const loaded = await store.loadMasterServers();

    assert.equal(typeof loaded[0].id, 'string');
    assert.ok(loaded[0].id.length > 0);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'masterservers.json'), 'utf8'));
    assert.equal(onDisk[0].id, loaded[0].id, 'vergebene ID muss auch auf der Platte landen');
});

test('loadMasterServers migriert Klartext-Passwörter zu verschlüsseltem Format', async () => {
    const { dataDir, jarsDir } = tempDirs();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
        path.join(dataDir, 'masterservers.json'),
        JSON.stringify([{ id: 'm1', name: 'Test', ip: '1.2.3.4', sshPort: 22, username: 'root', password: 'plaintext' }]),
        'utf8'
    );

    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage() });
    const loaded = await store.loadMasterServers();
    assert.equal(loaded[0].password, 'plaintext');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'masterservers.json'), 'utf8'));
    assert.equal(onDisk[0].password.__enc, true, 'Klartext-Passwort muss nach dem Laden verschlüsselt auf der Platte liegen');
});

test('bootstrapBundledJars kopiert nur, wenn jarsDir leer ist', () => {
    const { dataDir, jarsDir } = tempDirs();
    const bundledJarsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bundled-'));
    fs.writeFileSync(path.join(bundledJarsDir, 'paper.jar'), 'dummy');

    const store = createStore({ dataDir, jarsDir, safeStorage: fakeSafeStorage(), bundledJarsDir });
    store.bootstrapBundledJars();
    assert.deepEqual(fs.readdirSync(jarsDir), ['paper.jar']);

    // Zweiter Aufruf mit bereits vorhandenen (anderen) Jars darf nichts überschreiben.
    fs.writeFileSync(path.join(jarsDir, 'custom.jar'), 'user-uploaded');
    fs.writeFileSync(path.join(bundledJarsDir, 'spigot.jar'), 'dummy2');
    store.bootstrapBundledJars();
    assert.deepEqual(fs.readdirSync(jarsDir).sort(), ['custom.jar', 'paper.jar']);
});
