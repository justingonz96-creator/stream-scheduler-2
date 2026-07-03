'use strict';
// Resolve FFmpeg/ffprobe: bundled resources first, then common system spots.
// Engine modules call these; nothing else may spawn ffmpeg directly.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PLATFORM_DIR = process.platform === 'win32' ? 'win-x64'
                   : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const EXT = process.platform === 'win32' ? '.exe' : '';

function resolveTool(tool) {
  const cands = [
    // Packaged app: electron-builder's extraResources puts the binaries at
    // <resourcesPath>/ffmpeg/<platform>/ — OUTSIDE the asar, so they can execute.
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'ffmpeg', PLATFORM_DIR, tool + EXT)] : []),
    path.join(__dirname, '..', 'resources', 'ffmpeg', PLATFORM_DIR, tool + EXT),   // dev checkout
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    tool, // PATH fallback
  ];
  for (const c of cands) {
    if (c === tool) return c;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return tool;
}

function ffmpegPath() { return resolveTool('ffmpeg'); }
function ffprobePath() { return resolveTool('ffprobe'); }

function selfCheck() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, version: '', error:
          'The built-in video engine (FFmpeg) is missing or cannot run on this computer. ' +
          'Reinstall Stream Scheduler, or contact the admin.' });
        return;
      }
      const m = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve({ ok: true, version: m ? m[1] : 'unknown' });
    });
  });
}

module.exports = { ffmpegPath, ffprobePath, selfCheck };
