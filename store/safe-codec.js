'use strict';
// Bridges Electron's safeStorage (OS keychain / DPAPI) to the {encrypt, decrypt}
// codec Plan 2's secret store accepts. safeStorage is injected so this file stays
// Electron-free and testable; app/main.js passes the real module.
function createSafeCodec(safeStorage) {
  return {
    encrypt(plaintext) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('This computer\'s secure storage is not available, so the password can\'t be saved safely.');
      }
      return safeStorage.encryptString(String(plaintext));   // Buffer
    },
    decrypt(blob) {
      return safeStorage.decryptString(blob);                // string; secret store catches any throw → null
    },
  };
}

module.exports = { createSafeCodec };
