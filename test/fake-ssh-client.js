// Minimaler Fake für ssh2's Client, der genug vom Event-/Callback-Interface
// nachbildet, um lib/ssh-service-factory.js ohne echte Netzwerkverbindung zu
// testen.

const { EventEmitter } = require('events');

class FakeStream extends EventEmitter {
    constructor() {
        super();
        this.stderr = new EventEmitter();
    }
}

class FakeSftp {
    constructor(behavior) {
        this.behavior = behavior || {};
    }
    fastPut(local, remote, optsOrCb, maybeCb) {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
        if (opts.step) opts.step(100, 100, 100);
        queueMicrotask(() => cb(this.behavior.uploadError || null));
    }
    fastGet(remote, local, optsOrCb, maybeCb) {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
        if (opts.step) opts.step(100, 100, 100);
        queueMicrotask(() => cb(this.behavior.downloadError || null));
    }
}

// `behavior` steuert, wie sich die simulierte Verbindung verhält:
// - hostKeyHex: an hostVerifier() übergebener Fingerabdruck
// - connectError: falls gesetzt, wird statt 'ready' ein 'error' emittiert
// - execHandler(cmd): { stdout, stderr, code } pro exec()-Aufruf
// - sftpBehavior: an FakeSftp durchgereicht
class FakeClient extends EventEmitter {
    constructor(behavior = {}) {
        super();
        this.behavior = behavior;
        this.ended = false;
        this.execCalls = [];
    }

    connect(opts) {
        this.lastConnectOpts = opts;
        queueMicrotask(() => {
            if (opts.hostVerifier) {
                const permitted = opts.hostVerifier(this.behavior.hostKeyHex || 'deadbeef');
                if (!permitted) {
                    this.emit('error', new Error('Host denied (verification failed)'));
                    return;
                }
            }
            if (this.behavior.connectError) {
                this.emit('error', this.behavior.connectError);
            } else {
                this.emit('ready');
            }
        });
    }

    exec(cmd, cb) {
        this.execCalls.push(cmd);
        const stream = new FakeStream();
        cb(null, stream);
        const result = this.behavior.execHandler
            ? this.behavior.execHandler(cmd)
            : { stdout: '', stderr: '', code: 0 };
        queueMicrotask(() => {
            if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
            if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
            stream.emit('close', result.code ?? 0);
        });
    }

    sftp(cb) {
        cb(null, new FakeSftp(this.behavior.sftpBehavior));
    }

    end() {
        this.ended = true;
        this.emit('close');
    }
}

module.exports = { FakeClient };
