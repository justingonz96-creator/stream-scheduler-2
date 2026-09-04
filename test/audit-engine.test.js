'use strict';
// 2026-09-04 audit fixes, engine/platform layer. Each test names the finding.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { buildBroadcastArgs } = require('../engine/timeline');
const { spawnOptions } = require('../engine/broadcast');
const { resolveTool } = require('../engine/ffmpeg');
const { logDir } = require('../store/appdata');

const BASE = { videoPath: '/v.mp4', slateImage: '/s.jpg', slateMusic: '/m.mp3', leadSec: 120, fadeSec: 1, bitrateKbps: 4500, fps: 30, outUrl: 'rtmps://h/app/k' };
const filter = (a) => a[a.indexOf('-filter_complex') + 1];

// Finding: the crossfade output inherited the slate JPEG's colour tags (pc range,
// bt470bg matrix) for the WHOLE class, whose content is tv-range bt709.
test('every video chain converts to tv-range bt709 explicitly (scale out_range/out_color_matrix)', () => {
  for (const opts of [BASE, { ...BASE, slateImage: '', leadSec: 0 }, { ...BASE, resumeOffsetSec: 300 }]) {
    const f = filter(buildBroadcastArgs(opts));
    const scales = f.match(/scale=[^,;]+/g) || [];
    assert.ok(scales.length >= 1, f);
    for (const s of scales) {
      assert.match(s, /out_range=tv/, 'range must be limited (tv): ' + s);
      assert.match(s, /out_color_matrix=bt709/, 'matrix must be bt709: ' + s);
    }
    assert.match(f, /setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709/, 'frames must carry primaries+transfer too (x264 writes VUI from frames): ' + f);
  }
});
test('the encoder is told the colour signalling too (VUI), so players read tv/bt709', () => {
  const a = buildBroadcastArgs(BASE).join(' ');
  for (const flag of ['-color_range tv', '-colorspace bt709', '-color_primaries bt709', '-color_trc bt709']) assert.ok(a.includes(flag), flag);
});

// Finding: ffmpeg spawned without windowsHide → a console window on Windows PCs.
test('ffmpeg is spawned hidden on Windows, with the CA-aware environment', () => {
  const o = spawnOptions();
  assert.equal(o.windowsHide, true);
  assert.deepEqual(o.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(o.env && typeof o.env === 'object');
});

// Finding: if the bundled engine is unreadable, the resolver silently used a
// system/Homebrew ffmpeg — unpinned and possibly TLS-broken.
test('packaged app: a missing bundled engine is NOT papered over with a system ffmpeg', () => {
  const calls = [];
  const r = resolveTool('ffmpeg', { resourcesPath: '/App/Contents/Resources', platformDir: 'mac-arm64', exists: (p) => { calls.push(p); return false; }, log: () => {} });
  assert.equal(r, path.join('/App/Contents/Resources', 'ffmpeg', 'mac-arm64', 'ffmpeg'), 'returns the bundled path so the failure is loud and attributable');
  assert.ok(!calls.some((p) => p.includes('homebrew') || p === 'ffmpeg'), 'never probes system locations when packaged: ' + calls.join(','));
});
test('dev checkout: the system fallback still works', () => {
  const r = resolveTool('ffmpeg', { resourcesPath: '', platformDir: 'mac-arm64', exists: (p) => p === '/opt/homebrew/bin/ffmpeg', log: () => {} });
  assert.equal(r, '/opt/homebrew/bin/ffmpeg');
});

// Finding: logs were written into the Windows ROAMING profile.
test('log folder is per-machine (Local), not roaming', () => {
  assert.equal(logDir('win32', { LOCALAPPDATA: 'C:\\Users\\E\\AppData\\Local', APPDATA: 'C:\\Users\\E\\AppData\\Roaming' }), path.join('C:\\Users\\E\\AppData\\Local', 'StreamScheduler2', 'logs'));
  assert.equal(logDir('darwin', { HOME: '/Users/j' }), path.join('/Users/j', 'Library', 'Logs', 'StreamScheduler2'));
});
