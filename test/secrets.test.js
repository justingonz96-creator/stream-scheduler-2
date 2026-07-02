'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSecretStore } = require('../store/secrets');

// Reversible fake codec (stands in for Electron safeStorage in Plan 3).
const codec = {
  encrypt: (s) => Buffer.from('X' + s, 'utf8'),
  decrypt: (b) => { const t = b.toString('utf8'); if (!t.startsWith('X')) throw new Error('bad blob'); return t.slice(1); },
};

function freshFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-sec-')), 'secrets.json');
}

test('set/get/has round-trip; plaintext never on disk', () => {
  const file = freshFile();
  const s = createSecretStore({ file, ...codec });
  s.set('portalPassword', 'hunter2-secret');
  assert.equal(s.get('portalPassword'), 'hunter2-secret');
  assert.equal(s.has('portalPassword'), true);
  assert.equal(s.get('nope'), null);
  assert.equal(s.has('nope'), false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('hunter2-secret'), 'plaintext must not be stored');
});

test('corrupt blob → get returns null, never throws', () => {
  const file = freshFile();
  const s = createSecretStore({ file, ...codec });
  s.set('k', 'v');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.k = Buffer.from('garbage').toString('base64');   // not X-prefixed → decrypt throws
  fs.writeFileSync(file, JSON.stringify(onDisk));
  assert.equal(s.get('k'), null);
});

test('persists across store instances (same file)', () => {
  const file = freshFile();
  createSecretStore({ file, ...codec }).set('a', 'b');
  assert.equal(createSecretStore({ file, ...codec }).get('a'), 'b');
});
