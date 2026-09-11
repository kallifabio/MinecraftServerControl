// Validierung & sicheres Escaping für alles, was in Remote-Shell-Befehle einfliesst.

const path = require('path');

// Servernamen werden zu Verzeichnisnamen (/root/<name>) und screen-Session-Namen.
// Deshalb hart auf ein sicheres Zeichenset beschraenken statt zu escapen.
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function isValidServerName(name) {
    return typeof name === 'string' && SERVER_NAME_RE.test(name);
}

function assertValidServerName(name) {
    if (!isValidServerName(name)) {
        throw new Error(
            `Ungueltiger Servername "${name}". Erlaubt sind nur Buchstaben, Ziffern, "_" und "-" (max. 32 Zeichen).`
        );
    }
    return name;
}

function isValidPort(port) {
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && n <= 65535;
}

function assertValidPort(port, label = 'Port') {
    if (!isValidPort(port)) {
        throw new Error(`Ungueltiger ${label}: "${port}".`);
    }
    return Number(port);
}

function isValidRam(ramMb) {
    const n = Number(ramMb);
    return Number.isInteger(n) && n >= 256 && n <= 131072;
}

function assertValidRam(ramMb) {
    if (!isValidRam(ramMb)) {
        throw new Error(`Ungueltiger RAM-Wert: "${ramMb}" (erlaubt: 256-131072 MB).`);
    }
    return Number(ramMb);
}

// Reine Dateinamen ohne Pfadanteile - verhindert Path Traversal bei Uploads.
function sanitizeFileName(name) {
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('Ungueltiger Dateiname.');
    }
    const base = path.basename(name.replace(/\\/g, '/'));
    const hasControlChars = Array.from(base).some(ch => ch.charCodeAt(0) < 0x20);
    if (!base || base === '.' || base === '..' || hasControlChars) {
        throw new Error(`Ungueltiger Dateiname: "${name}".`);
    }
    return base;
}

function assertValidJarFileName(name) {
    const base = sanitizeFileName(name);
    if (!/^[\w.-]+\.jar$/i.test(base)) {
        throw new Error(`Ungueltige Jar-Datei: "${name}".`);
    }
    return base;
}

// Relativer Ordnerpfad fuer die Dateibrowser-Navigation - keine ".." und keine Absolutpfade.
function sanitizeRelativePath(folderPath) {
    if (!folderPath) return '';
    const normalized = String(folderPath).replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    for (const seg of segments) {
        if (seg === '..' || seg === '.') {
            throw new Error(`Ungueltiger Pfad: "${folderPath}".`);
        }
    }
    return segments.join('/');
}

// Einzelnes Shell-Quoting (POSIX sh/bash) - macht beliebigen Text als ein
// einzelnes Argument sicher, unabhaengig von enthaltenen Sonderzeichen.
function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
    isValidServerName,
    assertValidServerName,
    isValidPort,
    assertValidPort,
    isValidRam,
    assertValidRam,
    sanitizeFileName,
    assertValidJarFileName,
    sanitizeRelativePath,
    shQuote
};
