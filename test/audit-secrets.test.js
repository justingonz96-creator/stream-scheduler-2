'use strict';
// 2026-09-04 audit: the portal API key (sent on every portal request) was
// persisted in plaintext settings.json and echoed into a visible text field,
// unlike the password. It now lives in the secret store like the password.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore, buildPortalConfig, DEFAULT_SETTINGS } = require('../store/settings');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-set-')), 'settings.json');
const secretsOf = (obj) => ({ get: (k) => obj[k] || '', has: (k) => !!obj[k], set: (k, v) => { obj[k] = v; } });

test('settings.save never persists the API key (like the password)', () => {
  const f = tmpFile(); const st = createSettingsStore({ file: f });
  st.save({ portalEmail: 'a@b', portalApiKey: 'SECRET' });
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(!('portalApiKey' in onDisk) || !onDisk.portalApiKey, 'no key on disk: ' + JSON.stringify(onDisk));
  assert.ok(!('portalApiKey' in DEFAULT_SETTINGS), 'not a settings field any more');
});
test('a key left in an old settings.json is scrubbed on the next save', () => {
  const f = tmpFile(); fs.writeFileSync(f, JSON.stringify({ portalEmail: 'a@b', portalApiKey: 'OLD' }));
  const st = createSettingsStore({ file: f });
  st.save({ fadeMs: 500 });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).portalApiKey, undefined);
});
test('buildPortalConfig takes the key from the secret store, falling back to a not-yet-migrated settings value', () => {
  assert.equal(buildPortalConfig({ portalEmail: 'a@b' }, secretsOf({ portalApiKey: 'FROM-SECRETS', portalPassword: 'pw' })).apiKey, 'FROM-SECRETS');
  assert.equal(buildPortalConfig({ portalEmail: 'a@b', portalApiKey: 'LEGACY' }, secretsOf({})).apiKey, 'LEGACY');
});
