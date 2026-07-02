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

module.exports = { appDataDir };
