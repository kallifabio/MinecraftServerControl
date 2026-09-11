const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyAndTrustHostKey, forgetHostKey } = require('../lib/known-hosts');

function tempDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msc-known-hosts-test-'));
}

test('erster Connect zu einem Host wird per Trust-on-first-use akzeptiert und gemerkt', () => {
    const dataDir = tempDataDir();
    const result = verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    assert.equal(result.trusted, true);
    assert.equal(result.isNew, true);
});

test('gleicher Host-Key bei wiederholtem Connect wird weiterhin akzeptiert', () => {
    const dataDir = tempDataDir();
    verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    const result = verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    assert.equal(result.trusted, true);
    assert.equal(result.isNew, false);
});

test('geänderter Host-Key wird abgelehnt (potenzieller MITM)', () => {
    const dataDir = tempDataDir();
    verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    const result = verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'ffeedd');
    assert.equal(result.trusted, false);
});

test('unterschiedliche Host:Port-Kombinationen werden unabhängig verwaltet', () => {
    const dataDir = tempDataDir();
    verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    const result = verifyAndTrustHostKey(dataDir, '1.2.3.4', 2222, 'ffeedd');
    assert.equal(result.trusted, true);
    assert.equal(result.isNew, true);
});

test('forgetHostKey entfernt einen gespeicherten Fingerabdruck, danach wieder TOFU', () => {
    const dataDir = tempDataDir();
    verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'aabbcc');
    assert.equal(forgetHostKey(dataDir, '1.2.3.4', 22), true);
    assert.equal(forgetHostKey(dataDir, '1.2.3.4', 22), false, 'zweites Vergessen findet nichts mehr');

    const result = verifyAndTrustHostKey(dataDir, '1.2.3.4', 22, 'ffeedd');
    assert.equal(result.trusted, true);
    assert.equal(result.isNew, true);
});
