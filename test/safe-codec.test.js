'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createSafeCodec } = require('../store/safe-codec');

// Fake Electron safeStorage: reversible, availability-toggleable.
function fakeSafe(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('SS:' + s, 'utf8'),
    decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith('SS:')) throw new Error('bad'); return t.slice(3); },
  };
}

test('round-trips through the fake safeStorage', () => {
  const codec = createSafeCodec(fakeSafe(true));
  const blob = codec.encrypt('hunter2');
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(codec.decrypt(blob), 'hunter2');
});

test('encrypt throws plain-English when encryption is unavailable', () => {
  const codec = createSafeCodec(fakeSafe(false));
  assert.throws(() => codec.encrypt('x'), /secure storage is not available/i);
});

test('composes with the secret store as its injected codec', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { createSecretStore } = require('../store/secrets');
  const codec = createSafeCodec(fakeSafe(true));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-codec-')), 'secrets.json');
  const store = createSecretStore({ file, ...codec });
  store.set('portalPassword', 's3cret');
  assert.equal(store.get('portalPassword'), 's3cret');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('s3cret'), 'plaintext must not hit disk');
});
