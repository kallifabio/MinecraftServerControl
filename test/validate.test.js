const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../lib/validate');

test('isValidServerName akzeptiert sichere Namen', () => {
    assert.equal(isValidServerName('survival-1'), true);
    assert.equal(isValidServerName('My_Server_02'), true);
});

test('isValidServerName lehnt gefährliche Namen ab', () => {
    for (const bad of ['', 'a'.repeat(33), '../etc', 'name; rm -rf /', 'a b', 'a$(whoami)', 'a`id`']) {
        assert.equal(isValidServerName(bad), false, `sollte "${bad}" ablehnen`);
    }
});

test('assertValidServerName wirft bei ungültigem Namen', () => {
    assert.throws(() => assertValidServerName('bad name'));
    assert.equal(assertValidServerName('ok-name'), 'ok-name');
});

test('Port-Validierung', () => {
    assert.equal(isValidPort(22), true);
    assert.equal(isValidPort(65535), true);
    assert.equal(isValidPort(0), false);
    assert.equal(isValidPort(65536), false);
    assert.equal(isValidPort('22'), true); // Number('22') ist gültig
    assert.equal(isValidPort('abc'), false);
    assert.throws(() => assertValidPort(-1));
    assert.equal(assertValidPort('25565'), 25565);
});

test('RAM-Validierung', () => {
    assert.equal(isValidRam(2048), true);
    assert.equal(isValidRam(255), false);
    assert.equal(isValidRam(131073), false);
    assert.throws(() => assertValidRam(1));
});

test('sanitizeFileName entfernt Pfadanteile (Path Traversal)', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('sub/dir/file.jar'), 'file.jar');
    assert.equal(sanitizeFileName('plain.txt'), 'plain.txt');
    assert.throws(() => sanitizeFileName('..'));
    assert.throws(() => sanitizeFileName(''));
});

test('assertValidJarFileName verlangt .jar-Endung', () => {
    assert.equal(assertValidJarFileName('paper.jar'), 'paper.jar');
    assert.throws(() => assertValidJarFileName('paper.exe'));
});

test('assertValidJarFileName entschärft Path Traversal auf den reinen Dateinamen', () => {
    // sanitizeFileName() reduziert per path.basename() auf den Dateinamen -
    // das Ergebnis landet als "sicherer" Name, wirft also kein Error mehr,
    // sondern verhindert Traversal dadurch, dass der Pfadanteil verschwindet.
    assert.equal(assertValidJarFileName('../../evil.jar'), 'evil.jar');
});

test('sanitizeRelativePath blockiert Path Traversal', () => {
    assert.equal(sanitizeRelativePath(''), '');
    assert.equal(sanitizeRelativePath('world/region'), 'world/region');
    assert.throws(() => sanitizeRelativePath('../secret'));
    assert.throws(() => sanitizeRelativePath('world/../../etc'));
});

test('shQuote macht beliebigen Text als einzelnes Shell-Argument sicher', () => {
    assert.equal(shQuote('hello'), "'hello'");
    assert.equal(shQuote("it's"), "'it'\\''s'");
    // Simuliert Command Injection: das Ergebnis darf die Single-Quote-Umschliessung
    // nicht verlassen können.
    const malicious = "name'; rm -rf / #";
    const quoted = shQuote(malicious);
    assert.equal(quoted.startsWith("'"), true);
    assert.equal(quoted.endsWith("'"), true);
});
