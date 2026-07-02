'use strict';
// Secrets (the portal password) live in their own JSON file, each value run
// through an injected encrypt/decrypt codec. In the app that codec is Electron's
// safeStorage (OS keychain-backed, wired in Plan 3); in tests it's a fake.
// This module never sees Electron — it just applies the codec.
const fs = require('node:fs');
const { readJson, writeJsonAtomic } = require('./jsonstore');

function createSecretStore({ file, encrypt, decrypt }) {
  function load() { return readJson(file, {}); }
  return {
    set(name, value) {
      const all = load();
      all[name] = encrypt(String(value)).toString('base64');
      writeJsonAtomic(file, all);
      try { fs.chmodSync(file, 0o600); } catch {}   // best-effort (no-op on Windows)
    },
    get(name) {
      const b64 = load()[name];
      if (typeof b64 !== 'string') return null;
      try { return decrypt(Buffer.from(b64, 'base64')); }
      catch { return null; }                        // corrupt/foreign blob — treat as unset
    },
    has(name) { return this.get(name) !== null; },
  };
}

module.exports = { createSecretStore };
