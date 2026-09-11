// Testet lib/ipc-handlers.js End-to-End gegen einen gefakten "electron" und
// einen gefakten "./ssh-service" (via require.cache-Injection, da beide
// Module fest auf ihre echten Gegenstücke require()n). Deckt vor allem
// Validierungs-/Geschäftsregeln und die Command-Injection-Regression ab.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSshService } = require('../lib/ssh-service-factory');
const { FakeClient } = require('./fake-ssh-client');
const { shQuote } = require('../lib/validate');

function injectModuleCache(resolvedPath, exportsObj) {
    require.cache[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports: exportsObj,
        children: [],
        paths: []
    };
}

// Von exec() dynamisch gelesenes, gemeinsames Verhalten - pro Test überschreibbar.
const behavior = { execHandler: null };
const execLog = [];

before(() => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-ipc-test-'));

    const fakeSafeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
    };

    const handlers = new Map();
    const fakeIpcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => handlers.set(channel, fn) // 'stream-log' wird hier nicht getestet
    };

    const fakeElectron = {
        app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test', isPackaged: false, on: () => {} },
        ipcMain: fakeIpcMain,
        dialog: { showSaveDialog: async () => ({ canceled: true }) }, // Downloads hier nicht getestet
        BrowserWindow: { fromWebContents: () => null },
        safeStorage: fakeSafeStorage
    };

    injectModuleCache(require.resolve('electron'), fakeElectron);

    class BehaviorClient extends FakeClient {
        constructor() {
            super({
                execHandler: (cmd) => {
                    execLog.push(cmd);
                    return behavior.execHandler ? behavior.execHandler(cmd) : { stdout: '', code: 0 };
                }
            });
        }
    }
    const fakeSsh = createSshService({ Client: BehaviorClient, idleEvictMs: 5 * 60_000 });
    injectModuleCache(require.resolve('../lib/ssh-service'), fakeSsh);

    // Erst jetzt erstmalig laden - picken die eben injizierten Fakes auf.
    global.__store = require('../lib/store');
    const { registerIpcHandlers } = require('../lib/ipc-handlers');
    registerIpcHandlers();
    global.__handlers = handlers;
});

beforeEach(() => {
    execLog.length = 0;
    behavior.execHandler = null;
});

function fakeEvent() {
    return { sender: { id: 1, send: () => {} } };
}

async function makeMasterServer(overrides = {}) {
    const store = global.__store;
    const masterServers = await store.loadMasterServers();
    const ms = {
        id: overrides.id || 'ms-1',
        name: overrides.name || 'Test-Master',
        ip: overrides.ip || '203.0.113.10',
        sshPort: 22,
        username: 'root',
        password: 'secret',
        ...overrides
    };
    masterServers.push(ms);
    await store.saveMasterServers(masterServers);
    return ms;
}

test('create-server lehnt ungültige Servernamen ab, ohne SSH zu kontaktieren', async () => {
    const handlers = global.__handlers;
    const result = await handlers.get('create-server')(fakeEvent(), {
        name: 'bad name!', masterServerId: 'irrelevant', serverPort: 25565, ramMb: 1024, software: 'paper.jar'
    });
    assert.equal(result.success, false);
    assert.equal(execLog.length, 0, 'darf bei Validierungsfehler keine SSH-Befehle ausführen');
});

test('create-server lehnt unbekannten Masterserver ab', async () => {
    const handlers = global.__handlers;
    const result = await handlers.get('create-server')(fakeEvent(), {
        name: 'survival', masterServerId: 'does-not-exist', serverPort: 25565, ramMb: 1024, software: 'paper.jar'
    });
    assert.equal(result.success, false);
    assert.match(result.message, /Masterserver/);
});

test('sendServerCommand lehnt ungültige Servernamen ab', async () => {
    const handlers = global.__handlers;
    const result = await handlers.get('sendServerCommand')(fakeEvent(), { name: '../bad', masterServerId: 'ms-1' }, 'say hi');
    assert.equal(result.success, false);
});

test('createMasterServer lehnt doppelte Namen ab', async () => {
    const handlers = global.__handlers;
    await makeMasterServer({ id: 'dup-1', name: 'DuplicateName' });
    const result = await handlers.get('createMasterServer')(fakeEvent(), {
        name: 'DuplicateName', ip: '1.2.3.4', sshPort: 22, username: 'root', password: 'x'
    });
    assert.equal(result.success, false);
    assert.match(result.message, /existiert bereits/);
});

test('update-master-server behält bestehendes Passwort bei leerem Passwortfeld', async () => {
    const handlers = global.__handlers;
    const ms = await makeMasterServer({ id: 'keep-pw', name: 'KeepPwTest', password: 'original-secret' });

    const result = await handlers.get('update-master-server')(fakeEvent(), ms.id, {
        name: ms.name, ip: '9.9.9.9', sshPort: 22, username: 'root', password: ''
    });
    assert.equal(result.success, true);

    const all = await global.__store.loadMasterServers();
    const updated = all.find(m => m.id === ms.id);
    assert.equal(updated.password, 'original-secret');
    assert.equal(updated.ip, '9.9.9.9');
});

test('delete-master-server verweigert Löschen, solange Server referenzieren; erlaubt es danach', async () => {
    const handlers = global.__handlers;
    const ms = await makeMasterServer({ id: 'blocked-ms', name: 'BlockedMaster' });

    const servers = global.__store.loadServers();
    servers.push({ name: 'dependent-server', masterServerId: ms.id, serverPort: 25565, ramMb: 1024, software: 'paper.jar' });
    global.__store.saveServers(servers);

    const blocked = await handlers.get('delete-master-server')(fakeEvent(), ms.id);
    assert.equal(blocked.success, false);
    assert.match(blocked.message, /referenzieren/);

    const remaining = global.__store.loadServers().filter(s => s.masterServerId !== ms.id);
    global.__store.saveServers(remaining);

    const allowed = await handlers.get('delete-master-server')(fakeEvent(), ms.id);
    assert.equal(allowed.success, true);
});

test('sendServerCommand: Single Quotes im Befehl werden korrekt escaped (Command-Injection-Regression)', async () => {
    const handlers = global.__handlers;
    const ms = await makeMasterServer({ id: 'inj-ms', name: 'InjectionMaster' });
    const server = { name: 'inj-server', masterServerId: ms.id };

    behavior.execHandler = (cmd) => {
        if (cmd.includes('screen -ls')) return { stdout: '999.inj-server\t(Detached)', code: 0 };
        return { stdout: '', code: 0 };
    };

    const malicious = "say hi'; rm -rf / #";
    const result = await handlers.get('sendServerCommand')(fakeEvent(), server, malicious);
    assert.equal(result.success, true);

    const stuffCmd = execLog.find(c => c.includes('-X stuff'));
    assert.ok(stuffCmd, 'ein "stuff"-Befehl muss ausgeführt worden sein');
    assert.ok(
        stuffCmd.includes(shQuote(malicious + '\n')),
        'der bösartige Befehl muss vollständig innerhalb eines shQuote-Arguments stehen'
    );
});

test('get-server-status meldet online, wenn screen-Session gefunden wird', async () => {
    const handlers = global.__handlers;
    const ms = await makeMasterServer({ id: 'status-ms', name: 'StatusMaster' });
    const server = { name: 'status-server', masterServerId: ms.id };

    behavior.execHandler = () => ({ stdout: '111.status-server\t(Detached)', code: 0 });

    const result = await handlers.get('get-server-status')(fakeEvent(), server);
    assert.equal(result.success, true);
    assert.equal(result.online, true);
});
