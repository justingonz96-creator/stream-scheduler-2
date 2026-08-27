'use strict';
// App settings (spec §7): everything the operator configures EXCEPT the portal
// password, which lives in the OS keychain via the secret store. 1.x's OBS-only
// fields (port, OBS password, muteRoomAudio) are gone — 2.0 has no OBS.
const { readJson, writeJsonAtomic } = require('./jsonstore');

const DEFAULT_SETTINGS = {
  slateImage: '',        // path to the 16:9 slate picture shown during the lead-in
  slateImageVertical: '', // path to the 9:16 slate, used when the class is vertical
  slateMusic: '',        // path to the looping MP3 played under the slate
  fadeMs: 1000,          // slate→video crossfade length (ms)
  videoBitrate: 6000,    // kbps
  portalEmail: '',
  portalApiKey: '',
  portalApiBase: '',     // blank ⇒ client uses its built-in default
};

function createSettingsStore({ file }) {
  return {
    get() { return { ...DEFAULT_SETTINGS, ...readJson(file, {}) }; },
    save(patch) {
      const clean = { ...patch };
      delete clean.password; delete clean.portalPassword;   // never persist a password here
      const merged = { ...DEFAULT_SETTINGS, ...readJson(file, {}), ...clean };
      writeJsonAtomic(file, merged);
      return merged;
    },
  };
}

// Total, never-throws (Plan-2 getConfig contract): the portal client restores
// the default when apiBase is blank.
function buildPortalConfig(settings, secrets) {
  return {
    email: settings.portalEmail || '',
    password: secrets.get('portalPassword') || '',
    apiKey: settings.portalApiKey || '',
    apiBase: settings.portalApiBase || '',
  };
}

module.exports = { DEFAULT_SETTINGS, createSettingsStore, buildPortalConfig };
