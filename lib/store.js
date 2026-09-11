// Persistiert Server-/Masterserver-Listen. Passwörter werden über Electrons
// safeStorage (OS-Schlüsselbund, unter Windows DPAPI) verschlüsselt auf der
// Platte abgelegt statt im Klartext.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const dataDir = path.join(app.getPath('userData'), 'data');
const jarsDir = path.join(app.getPath('userData'), 'jars');
const serversFile = path.join(dataDir, 'servers.json');
const masterServersFile = path.join(dataDir, 'masterservers.json');

let warnedNoEncryption = false;

function ensureDirs() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(jarsDir)) fs.mkdirSync(jarsDir, { recursive: true });
    // WICHTIG: als Array initialisieren, nicht als "{}" - sonst schlägt jedes
    // spätere .push()/.find() auf der geladenen Liste fehl.
    if (!fs.existsSync(serversFile)) fs.writeFileSync(serversFile, '[]', 'utf8');
    if (!fs.existsSync(masterServersFile)) fs.writeFileSync(masterServersFile, '[]', 'utf8');
}

// Entwicklungskomfort: Wenn das userData/jars-Verzeichnis (die einzige von
// create-server tatsächlich genutzte Quelle) leer ist, aber im lokalen
// Projektordner "jars/" bereits .jar-Dateien liegen (nur bei "npm start" aus
// dem Quellcode heraus - gepackte Builds enthalten dort keine Jars),
// einmalig dorthin kopieren. Verhindert, dass hochgeladene und mitgelieferte
// Jars in zwei unterschiedlichen, nie synchronisierten Ordnern landen.
function bootstrapBundledJars() {
    ensureDirs();
    const bundledDir = path.join(__dirname, '..', 'jars');
    let bundled = [];
    try {
        bundled = fs.readdirSync(bundledDir).filter(f => f.endsWith('.jar'));
    } catch {
        return;
    }
    if (bundled.length === 0) return;

    const existing = fs.readdirSync(jarsDir).filter(f => f.endsWith('.jar'));
    if (existing.length > 0) return;

    for (const file of bundled) {
        try {
            fs.copyFileSync(path.join(bundledDir, file), path.join(jarsDir, file));
        } catch (err) {
            console.warn(`Konnte ${file} nicht nach ${jarsDir} kopieren:`, err.message);
        }
    }
}

function encryptSecret(plainText) {
    if (typeof plainText !== 'string' || plainText.length === 0) return plainText;
    if (!safeStorage.isEncryptionAvailable()) {
        if (!warnedNoEncryption) {
            console.warn('safeStorage-Verschlüsselung nicht verfügbar - Passwörter werden im Klartext gespeichert.');
            warnedNoEncryption = true;
        }
        return plainText;
    }
    return { __enc: true, data: safeStorage.encryptString(plainText).toString('base64') };
}

function decryptSecret(value) {
    if (value && typeof value === 'object' && value.__enc) {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Verschlüsselte Zugangsdaten können auf diesem System nicht entschlüsselt werden.');
        }
        return safeStorage.decryptString(Buffer.from(value.data, 'base64'));
    }
    return typeof value === 'string' ? value : '';
}

function loadServers() {
    ensureDirs();
    try {
        const raw = JSON.parse(fs.readFileSync(serversFile, 'utf-8'));
        // Ältere Installationen initialisierten diese Datei fälschlich als "{}"
        // statt "[]" - defensiv als leere Liste behandeln statt abzustürzen.
        const list = Array.isArray(raw) ? raw : [];
        const hadLegacyPlaintext = list.some(s => typeof s.password === 'string' && s.password.length > 0);
        const decoded = list.map(s => ({ ...s, password: decryptSecret(s.password) }));

        // Einmalige Migration: alte Klartext-Passwörter bzw. das kaputte "{}"-
        // Format beim ersten Laden auf das neue, verschlüsselte Format heben.
        if ((hadLegacyPlaintext && safeStorage.isEncryptionAvailable()) || !Array.isArray(raw)) {
            saveServers(decoded);
        }

        return decoded;
    } catch (err) {
        console.error('Fehler beim Laden der Serverliste:', err.message);
        return [];
    }
}

function saveServers(servers) {
    ensureDirs();
    const toWrite = servers.map(s => ({ ...s, password: encryptSecret(s.password) }));
    fs.writeFileSync(serversFile, JSON.stringify(toWrite, null, 2), 'utf-8');
}

async function loadMasterServers() {
    ensureDirs();
    try {
        const raw = JSON.parse(await fsp.readFile(masterServersFile, 'utf-8'));
        const list = Array.isArray(raw) ? raw : [];
        const hadLegacyPlaintext = list.some(ms => typeof ms.password === 'string' && ms.password.length > 0);
        const decoded = list.map(ms => ({ ...ms, password: decryptSecret(ms.password) }));

        if ((hadLegacyPlaintext && safeStorage.isEncryptionAvailable()) || !Array.isArray(raw)) {
            await saveMasterServers(decoded);
        }

        return decoded;
    } catch (err) {
        console.error('Fehler beim Laden der Masterserver:', err.message);
        return [];
    }
}

async function saveMasterServers(masterServers) {
    ensureDirs();
    const toWrite = masterServers.map(ms => ({ ...ms, password: encryptSecret(ms.password) }));
    await fsp.writeFile(masterServersFile, JSON.stringify(toWrite, null, 2), 'utf8');
}

module.exports = {
    dataDir,
    jarsDir,
    ensureDirs,
    bootstrapBundledJars,
    loadServers,
    saveServers,
    loadMasterServers,
    saveMasterServers
};
