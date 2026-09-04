'use strict';
// Resolve FFmpeg/ffprobe: bundled resources first, then common system spots.
// Engine modules call these; nothing else may spawn ffmpeg directly.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PLATFORM_DIR = process.platform === 'win32' ? 'win-x64'
                   : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const EXT = process.platform === 'win32' ? '.exe' : '';

const canExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

function resolveTool(tool, opts = {}) {
  const resourcesPath = opts.resourcesPath === undefined ? process.resourcesPath : opts.resourcesPath;
  const platformDir = opts.platformDir || PLATFORM_DIR;
  const exists = opts.exists || canExec;
  const log = opts.log || ((m) => console.log('[engine] ' + m));
  // Packaged app: electron-builder's extraResources puts the binaries at
  // <resourcesPath>/ffmpeg/<platform>/ — OUTSIDE the asar, so they can execute.
  // There is deliberately NO fallback here: a system/Homebrew ffmpeg is unpinned
  // and (on macOS) may not verify TLS, so silently using one would turn a clear
  // "engine missing" failure into a mysterious broadcast failure (2026-09-04 audit).
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'ffmpeg', platformDir, tool + EXT);
    if (!exists(bundled)) log('bundled ' + tool + ' is missing or not executable: ' + bundled);
    return bundled;
  }
  const cands = [
    path.join(__dirname, '..', 'resources', 'ffmpeg', platformDir, tool + EXT),   // dev checkout
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    tool, // PATH fallback (dev only)
  ];
  for (const c of cands) {
    if (c === tool) return c;
    if (exists(c)) return c;
  }
  return tool;
}

function ffmpegPath() { return resolveTool('ffmpeg'); }
function ffprobePath() { return resolveTool('ffprobe'); }

/* Certificate authorities for FFmpeg's TLS.

   The macOS FFmpeg we bundle is built --enable-openssl, and OpenSSL does NOT read
   the macOS keychain — it needs a CA bundle file on disk. Without one it rejects
   every certificate ("certificate verify failed"), which ffmpeg surfaces as the
   maddeningly vague "Error opening output files: Input/output error". That made
   every rtmps:// studio unreachable and cost a live class on 2026-09-03.

   So: find the OS's CA bundle and hand it to ffmpeg through SSL_CERT_FILE, which
   covers every TLS connection it makes (rtmps output, https input) rather than
   just the one place we remembered to pass a flag. Verification stays ON — the
   fix is to supply the certificates, never to skip the check. Nothing found means
   we change nothing, so this can only ever help. */
const CA_CANDIDATES = [
  '/etc/ssl/cert.pem',                       // macOS (and BSD)
  '/etc/ssl/certs/ca-certificates.crt',      // Debian/Ubuntu
  '/etc/pki/tls/certs/ca-bundle.crt',        // RHEL/Fedora
];

function caFile(opts = {}) {
  const exists = opts.exists || ((p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } });
  const cands = opts.candidates || CA_CANDIDATES;
  for (const c of cands) { if (exists(c)) return c; }
  return '';
}

// The environment ffmpeg is spawned with. An SSL_CERT_FILE the operator set
// themselves always wins.
function ffmpegEnv(opts = {}) {
  const base = opts.base || process.env;
  const ca = opts.ca === undefined ? caFile() : opts.ca;
  if (!ca || base.SSL_CERT_FILE) return base;
  return { ...base, SSL_CERT_FILE: ca };
}

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

module.exports = { ffmpegPath, ffprobePath, selfCheck, caFile, ffmpegEnv, resolveTool };
