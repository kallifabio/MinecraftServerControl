const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSshService } = require('../lib/ssh-service-factory');
const { FakeClient } = require('./fake-ssh-client');

function tempDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msc-ssh-test-'));
}

function clientFactory(behavior) {
    let count = 0;
    const CountingClient = class extends FakeClient {
        constructor() {
            super(behavior);
            count++;
        }
    };
    return { CountingClient, getCount: () => count };
}

test('execCommand liefert stdout bei Exit-Code 0', async () => {
    const ssh = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ execHandler: () => ({ stdout: 'hello\n', code: 0 }) }); }
        }
    });
    const conn = await ssh.connectSSH({ host: 'h', port: 22, username: 'u', password: 'p' });
    const out = await ssh.execCommand(conn, 'echo hello');
    assert.equal(out, 'hello\n');
});

test('execCommand wirft bei Exit-Code != 0 mit stderr als Fehlermeldung', async () => {
    const ssh = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ execHandler: () => ({ stderr: 'boom', code: 1 }) }); }
        }
    });
    const conn = await ssh.connectSSH({ host: 'h', port: 22, username: 'u', password: 'p' });
    await assert.rejects(() => ssh.execCommand(conn, 'false'), /boom/);
});

test('isServerRunning: true wenn screen-Session im Output auftaucht', async () => {
    const ssh = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ execHandler: () => ({ stdout: '12345.survival\t(Detached)\n', code: 0 }) }); }
        }
    });
    const conn = await ssh.connectSSH({ host: 'h', port: 22, username: 'u', password: 'p' });
    assert.equal(await ssh.isServerRunning(conn, 'survival'), true);
});

test('isServerRunning: false wenn grep nichts findet (Exit-Code 1)', async () => {
    const ssh = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ execHandler: () => ({ code: 1 }) }); }
        }
    });
    const conn = await ssh.connectSSH({ host: 'h', port: 22, username: 'u', password: 'p' });
    assert.equal(await ssh.isServerRunning(conn, 'survival'), false);
});

test('connectSSH: erster Connect zu neuem Host wird per TOFU akzeptiert', async () => {
    const dataDir = tempDataDir();
    const ssh = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ hostKeyHex: 'aaaa' }); }
        }
    });
    const conn = await ssh.connectSSH({ host: '1.2.3.4', port: 22, username: 'u', password: 'p' }, { dataDir });
    assert.ok(conn);
});

test('connectSSH: geänderter Host-Key wird mit klarer MITM-Fehlermeldung abgelehnt', async () => {
    const dataDir = tempDataDir();

    const ssh1 = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ hostKeyHex: 'aaaa' }); }
        }
    });
    await ssh1.connectSSH({ host: '1.2.3.4', port: 22, username: 'u', password: 'p' }, { dataDir });

    const ssh2 = createSshService({
        Client: class extends FakeClient {
            constructor() { super({ hostKeyHex: 'bbbb' }); } // anderer Fingerabdruck!
        }
    });
    await assert.rejects(
        () => ssh2.connectSSH({ host: '1.2.3.4', port: 22, username: 'u', password: 'p' }, { dataDir }),
        /Host-Key.*geändert/
    );
});

test('getPooledConnection: wiederholte Aufrufe für denselben Host+User liefern dieselbe Verbindung', async () => {
    const { CountingClient, getCount } = clientFactory({});
    const ssh = createSshService({ Client: CountingClient });
    const config = { host: 'h', port: 22, username: 'u', password: 'p' };

    const conn1 = await ssh.getPooledConnection(config);
    const conn2 = await ssh.getPooledConnection(config);

    assert.equal(conn1, conn2);
    assert.equal(getCount(), 1, 'es darf nur eine echte Verbindung aufgebaut worden sein');
});

test('getPooledConnection: unterschiedliche Hosts bekommen unterschiedliche Verbindungen', async () => {
    const { CountingClient, getCount } = clientFactory({});
    const ssh = createSshService({ Client: CountingClient });

    const connA = await ssh.getPooledConnection({ host: 'a', port: 22, username: 'u', password: 'p' });
    const connB = await ssh.getPooledConnection({ host: 'b', port: 22, username: 'u', password: 'p' });

    assert.notEqual(connA, connB);
    assert.equal(getCount(), 2);
});

test('closeAllPooledConnections beendet alle gepoolten Verbindungen', async () => {
    const { CountingClient } = clientFactory({});
    const ssh = createSshService({ Client: CountingClient });

    const conn = await ssh.getPooledConnection({ host: 'h', port: 22, username: 'u', password: 'p' });
    assert.equal(conn.ended, false);

    ssh.closeAllPooledConnections();
    assert.equal(conn.ended, true);
});

test('getPooledConnection: nach Leerlauf-Timeout wird die Verbindung beendet und eine neue aufgebaut', async () => {
    const { CountingClient, getCount } = clientFactory({});
    const ssh = createSshService({ Client: CountingClient, idleEvictMs: 20 });
    const config = { host: 'h', port: 22, username: 'u', password: 'p' };

    const conn1 = await ssh.getPooledConnection(config);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(conn1.ended, true);

    const conn2 = await ssh.getPooledConnection(config);
    assert.notEqual(conn1, conn2);
    assert.equal(getCount(), 2);
});
