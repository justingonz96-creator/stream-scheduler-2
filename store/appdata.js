'use strict';
// Where this app keeps its files, per OS (spec §7). Distinct from 1.x's
// "StreamScheduler" dir so both apps can coexist on one machine.
const path = require('node:path');

function appDataDir(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'StreamScheduler2');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'StreamScheduler2');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'StreamScheduler2');
}

// Where BULK, disposable data lives (the local video cache). Deliberately NOT
// appDataDir: on Windows %APPDATA% is the ROAMING profile, synced at logon on a
// domain-joined studio PC — tens of GB of video must not ride along. On macOS
// ~/Library/Caches is skipped by Time Machine, which is what we want for copies
// that can always be re-made from the drive.
function cacheDir(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'StreamScheduler2');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'StreamScheduler2');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'StreamScheduler2');
}

module.exports = { appDataDir, cacheDir };
