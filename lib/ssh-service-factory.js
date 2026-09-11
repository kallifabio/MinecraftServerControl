// Reine SSH/SFTP-Interaktionslogik, parametrisiert über eine injizierte
// ssh2-kompatible `Client`-Klasse - dadurch in Tests mit einem Fake-Client
// (ohne echte Netzwerkverbindung) instanziierbar. lib/ssh-service.js
// verdrahtet das mit dem echten ssh2-Modul.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { shQuote } = require('./validate');
const knownHosts = require('./known-hosts');

function hostKeyChangedError(host, port) {
    return new Error(
        `SSH-Host-Key für ${host}:${port} hat sich geändert! ` +
        `Das kann ein Man-in-the-Middle-Angriff sein oder der Server wurde neu ` +
        `aufgesetzt. Verbindung abgebrochen - bei berechtigtem Verdacht auf einen ` +
        `Neuaufbau kann der gespeicherte Host-Key über "Host-Key zurücksetzen" ` +
        `entfernt werden.`
    );
}

function createSshService({ Client, idleEvictMs = 60_000 }) {
    // Baut die ssh2-Connect-Optionen inkl. Trust-on-first-use-Host-Key-Prüfung.
    // `onMismatch` wird synchron aufgerufen, falls der Host-Key vom
    // gespeicherten Fingerabdruck abweicht (potenzieller MITM).
    function buildConnectOptions(config, { dataDir, onMismatch } = {}) {
        const connectOptions = { readyTimeout: 15000, ...config };
        if (dataDir) {
            connectOptions.hostHash = 'sha256';
            connectOptions.hostVerifier = (hashedKeyHex) => {
                const result = knownHosts.verifyAndTrustHostKey(dataDir, config.host, config.port, hashedKeyHex);
                if (!result.trusted && onMismatch) onMismatch();
                return result.trusted;
            };
        }
        return connectOptions;
    }

    // Baut eine SSH-Verbindung auf. Wenn `dataDir` übergeben wird, wird der
    // Host-Key per Trust-on-first-use gegen die gespeicherten Fingerabdrücke
    // geprüft (Schutz vor stillen Man-in-the-Middle-Angriffen).
    function connectSSH(config, { dataDir } = {}) {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            let hostKeyMismatch = false;

            conn.on('ready', () => resolve(conn));
            conn.on('error', (err) => {
                reject(hostKeyMismatch ? hostKeyChangedError(config.host, config.port) : err);
            });

            conn.connect(buildConnectOptions(config, { dataDir, onMismatch: () => { hostKeyMismatch = true; } }));
        });
    }

    // --- Verbindungs-Pool ---------------------------------------------
    // Statt für jede einzelne Aktion (Start, Datei auflisten, Befehl senden,
    // …) eine neue TCP-/SSH-Handshake-Runde aufzubauen, wird pro Host+
    // Benutzer eine Verbindung kurz warmgehalten und wiederverwendet. Bei
    // Leerlauf, Fehler oder Verbindungsabbruch fliegt der Eintrag automatisch
    // aus dem Pool. Nicht geeignet für langlebige Streams (z.B.
    // Log-Tailing) - die nutzen weiterhin eine dedizierte, eigene Verbindung.
    const pool = new Map(); // "user@host:port" -> { conn, evictTimer }

    function poolKeyFor(config) {
        return `${config.username}@${config.host}:${config.port}`;
    }

    function scheduleEviction(key) {
        const timer = setTimeout(() => {
            const entry = pool.get(key);
            if (!entry) return;
            pool.delete(key);
            entry.conn.end();
        }, idleEvictMs);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
    }

    async function getPooledConnection(config, opts = {}) {
        const key = poolKeyFor(config);
        const existing = pool.get(key);
        if (existing) {
            clearTimeout(existing.evictTimer);
            existing.evictTimer = scheduleEviction(key);
            return existing.conn;
        }

        const conn = await connectSSH(config, opts);
        const entry = { conn, evictTimer: scheduleEviction(key) };
        pool.set(key, entry);

        const evict = () => {
            if (pool.get(key) !== entry) return;
            clearTimeout(entry.evictTimer);
            pool.delete(key);
        };
        conn.on('error', evict);
        conn.on('close', evict);

        return conn;
    }

    function closeAllPooledConnections() {
        for (const entry of pool.values()) {
            clearTimeout(entry.evictTimer);
            entry.conn.end();
        }
        pool.clear();
    }

    // Führt einen Befehl per SSH aus und liefert stdout zurück.
    // Wirft bei nicht-Null Exit-Code oder Verbindungsfehler.
    function execCommand(conn, cmd) {
        return new Promise((resolve, reject) => {
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let stdout = '';
                let stderr = '';
                stream.on('close', (code) => {
                    if (code !== 0) return reject(new Error(stderr || `Exit code ${code}`));
                    resolve(stdout);
                });
                stream.on('data', chunk => (stdout += chunk));
                stream.stderr.on('data', chunk => (stderr += chunk));
            });
        });
    }

    // Lädt eine lokale Datei per SFTP auf den Remote-Host hoch. `onProgress`
    // (optional) wird als (transferredBytes, totalBytes) aufgerufen.
    function uploadFile(conn, localPath, remotePath, onProgress) {
        return new Promise((resolve, reject) => {
            conn.sftp((err, sftp) => {
                if (err) return reject(err);
                const opts = onProgress ? { step: (total, _chunk, fsize) => onProgress(total, fsize) } : {};
                sftp.fastPut(localPath, remotePath, opts, err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    }

    // Lädt eine Remote-Datei per SFTP auf die lokale Platte herunter.
    // `onProgress` (optional) wird als (transferredBytes, totalBytes) aufgerufen.
    function downloadFile(conn, remotePath, localPath, onProgress) {
        return new Promise((resolve, reject) => {
            conn.sftp((err, sftp) => {
                if (err) return reject(err);
                const opts = onProgress ? { step: (total, _chunk, fsize) => onProgress(total, fsize) } : {};
                sftp.fastGet(remotePath, localPath, opts, err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    }

    // Schreibt Textinhalt als Datei auf den Remote-Host - über eine lokale
    // Temp-Datei und SFTP, statt fragiles Shell-Escaping (echo "...") zu
    // verwenden.
    async function writeRemoteFile(conn, content, remotePath) {
        const tmpPath = path.join(os.tmpdir(), `msc-${crypto.randomUUID()}`);
        await fsp.writeFile(tmpPath, content, 'utf8');
        try {
            await uploadFile(conn, tmpPath, remotePath);
        } finally {
            await fsp.unlink(tmpPath).catch(() => {});
        }
    }

    // Prüft, ob eine screen-Session mit dem gegebenen (bereits validierten)
    // Namen läuft.
    async function isServerRunning(conn, screenName) {
        try {
            const output = await execCommand(conn, `screen -ls | grep ${shQuote(screenName)}`);
            return output.includes(screenName);
        } catch {
            // screen -ls | grep liefert Exit-Code 1, wenn nichts gefunden
            // wurde - kein echter Fehler.
            return false;
        }
    }

    return {
        Client,
        connectSSH,
        getPooledConnection,
        closeAllPooledConnections,
        buildConnectOptions,
        hostKeyChangedError,
        execCommand,
        uploadFile,
        downloadFile,
        writeRemoteFile,
        isServerRunning
    };
}

module.exports = { createSshService, hostKeyChangedError };
