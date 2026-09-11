// Reine Persistenzlogik für Server-/Masterserver-Listen, ohne direkte
// Electron-Abhängigkeit - dadurch in Tests mit einem Temp-Verzeichnis und
// einem Fake-safeStorage instanziierbar. lib/store.js verdrahtet das mit den
// echten Electron-Pfaden.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function createStore({ dataDir, jarsDir, safeStorage, bundledJarsDir }) {
    const serversFile = path.join(dataDir, 'servers.json');
    const masterServersFile = path.join(dataDir, 'masterservers.json');
    let warnedNoEncryption = false;

    function ensureDirs() {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(jarsDir)) fs.mkdirSync(jarsDir, { recursive: true });
        // WICHTIG: als Array initialisieren, nicht als "{}" - sonst schlägt
        // jedes spätere .push()/.find() auf der geladenen Liste fehl.
        if (!fs.existsSync(serversFile)) fs.writeFileSync(serversFile, '[]', 'utf8');
        if (!fs.existsSync(masterServersFile)) fs.writeFileSync(masterServersFile, '[]', 'utf8');
    }

    // Entwicklungskomfort: Wenn jarsDir leer ist, aber im mitgelieferten
    // Projektordner bereits .jar-Dateien liegen (nur bei "npm start" aus dem
    // Quellcode heraus - gepackte Builds enthalten dort keine Jars), einmalig
    // dorthin kopieren.
    function bootstrapBundledJars() {
        ensureDirs();
        if (!bundledJarsDir) return;
        let bundled = [];
        try {
            bundled = fs.readdirSync(bundledJarsDir).filter(f => f.endsWith('.jar'));
        } catch {
            return;
        }
        if (bundled.length === 0) return;

        const existing = fs.readdirSync(jarsDir).filter(f => f.endsWith('.jar'));
        if (existing.length > 0) return;

        for (const file of bundled) {
            try {
                fs.copyFileSync(path.join(bundledJarsDir, file), path.join(jarsDir, file));
            } catch (err) {
                console.warn(`Konnte ${file} nicht nach ${jarsDir} kopieren:`, err.message);
            }
        }
    }

    function encryptSecret(plainText) {
        if (typeof plainText !== 'string' || plainText.length === 0) return plainText;
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
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
            if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
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
            // Ältere Installationen initialisierten diese Datei fälschlich als
            // "{}" statt "[]" - defensiv als leere Liste behandeln statt
            // abzustürzen.
            const list = Array.isArray(raw) ? raw : [];
            const hadLegacyPlaintext = list.some(s => typeof s.password === 'string' && s.password.length > 0);
            const decoded = list.map(s => ({ ...s, password: decryptSecret(s.password) }));

            // Einmalige Migration: alte Klartext-Passwörter bzw. das kaputte
            // "{}"-Format beim ersten Laden auf das neue Format heben.
            if ((hadLegacyPlaintext && safeStorage && safeStorage.isEncryptionAvailable()) || !Array.isArray(raw)) {
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
            let missingId = false;
            const decoded = list.map(ms => {
                if (!ms.id) missingId = true;
                return { ...ms, id: ms.id || crypto.randomUUID(), password: decryptSecret(ms.password) };
            });

            const needsPasswordMigration = hadLegacyPlaintext && safeStorage && safeStorage.isEncryptionAvailable();
            if (needsPasswordMigration || missingId || !Array.isArray(raw)) {
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

    return {
        dataDir,
        jarsDir,
        ensureDirs,
        bootstrapBundledJars,
        loadServers,
        saveServers,
        loadMasterServers,
        saveMasterServers
    };
}

module.exports = { createStore };
