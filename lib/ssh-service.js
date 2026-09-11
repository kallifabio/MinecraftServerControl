// Kapselt sämtliche SSH/SFTP-Interaktion mit den Remote-Servern.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
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

// Baut die ssh2-Connect-Optionen inkl. Trust-on-first-use-Host-Key-Prüfung.
// `onMismatch` wird synchron aufgerufen, falls der Host-Key vom gespeicherten
// Fingerabdruck abweicht (potenzieller MITM).
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

// Lädt eine lokale Datei per SFTP auf den Remote-Host hoch.
function uploadFile(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastPut(localPath, remotePath, err => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

// Lädt eine Remote-Datei per SFTP auf die lokale Platte herunter.
function downloadFile(conn, remotePath, localPath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastGet(remotePath, localPath, err => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

// Schreibt Textinhalt als Datei auf den Remote-Host - über eine lokale Temp-Datei
// und SFTP, statt fragiles Shell-Escaping (echo "...") zu verwenden.
async function writeRemoteFile(conn, content, remotePath) {
    const tmpPath = path.join(os.tmpdir(), `msc-${crypto.randomUUID()}`);
    await fsp.writeFile(tmpPath, content, 'utf8');
    try {
        await uploadFile(conn, tmpPath, remotePath);
    } finally {
        await fsp.unlink(tmpPath).catch(() => {});
    }
}

// Prüft, ob eine screen-Session mit dem gegebenen (bereits validierten) Namen läuft.
async function isServerRunning(conn, screenName) {
    try {
        const output = await execCommand(conn, `screen -ls | grep ${shQuote(screenName)}`);
        return output.includes(screenName);
    } catch {
        // screen -ls | grep liefert Exit-Code 1, wenn nichts gefunden wurde - kein echter Fehler.
        return false;
    }
}

module.exports = {
    Client,
    connectSSH,
    buildConnectOptions,
    hostKeyChangedError,
    execCommand,
    uploadFile,
    downloadFile,
    writeRemoteFile,
    isServerRunning
};
