// Trust-on-first-use SSH-Host-Key-Pinning. Verhindert stille
// Man-in-the-Middle-Angriffe: der Host-Key jedes Ziels wird beim ersten
// Connect gespeichert und bei jedem weiteren Connect verglichen.

const fs = require('fs');
const path = require('path');

function knownHostsFilePath(dataDir) {
    return path.join(dataDir, 'known_hosts.json');
}

function loadKnownHosts(dataDir) {
    try {
        const file = knownHostsFilePath(dataDir);
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function saveKnownHosts(dataDir, map) {
    fs.writeFileSync(knownHostsFilePath(dataDir), JSON.stringify(map, null, 2), 'utf8');
}

function hostKey(host, port) {
    return `${host}:${port}`;
}

// Prüft/merkt sich den SHA256-Fingerabdruck eines Host-Keys.
// Rückgabe: { trusted, isNew }.
function verifyAndTrustHostKey(dataDir, host, port, hashedKeyHex) {
    const key = hostKey(host, port);
    const known = loadKnownHosts(dataDir);
    if (!known[key]) {
        known[key] = hashedKeyHex;
        saveKnownHosts(dataDir, known);
        return { trusted: true, isNew: true };
    }
    if (known[key] === hashedKeyHex) {
        return { trusted: true, isNew: false };
    }
    return { trusted: false, isNew: false };
}

// Nur explizit über die UI auslösbar - z.B. nachdem ein Server bewusst neu
// aufgesetzt wurde und sich sein Host-Key dadurch legitim geändert hat.
function forgetHostKey(dataDir, host, port) {
    const key = hostKey(host, port);
    const known = loadKnownHosts(dataDir);
    if (!known[key]) return false;
    delete known[key];
    saveKnownHosts(dataDir, known);
    return true;
}

module.exports = { verifyAndTrustHostKey, forgetHostKey };
