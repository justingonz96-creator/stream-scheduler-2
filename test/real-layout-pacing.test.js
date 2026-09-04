'use strict';
// REAL-INPUT regression guard for the 2026-09-04 pacing fault.
//
// The studio's export tool writes class files in ~1/3 s chunks of video then
// audio. With per-input -re pacing, such a file throttled the whole broadcast
// to ~0.70x (20 fps at the platform) — and NO synthetic fixture caught it,
// because ffmpeg writes tightly interleaved files. class-chunked.mp4 reproduces
// the real packet layout (fragmented MP4, 1/3 s fragments — verified identical
// to a real export), and DID reproduce the fault against the old pipeline
// (22 s wall for 15 s of media, 3 resets). This test runs the app's real
// pipeline on it and requires real-time pacing with zero pacing resets.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBroadcastArgs } = require('../engine/timeline');
const ffmpeg = require('../engine/ffmpeg');

const FIX = path.join(__dirname, 'fixtures');
const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const CHUNKED = path.join(FIX, 'class-chunked.mp4');

function ensureFixture() {
  if (fs.existsSync(CHUNKED)) return;
  fs.mkdirSync(FIX, { recursive: true });
  spawnSync(ffmpeg.ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '5000k', '-c:a', 'aac', '-b:a', '253k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov', '-frag_duration', '333333', '-shortest', CHUNKED], { stdio: 'ignore' });
}

test('the fixture really has the chunked layout (runs of video packets, then audio)', () => {
  ensureFixture();
  const r = spawnSync(ffmpeg.ffprobePath(), ['-v', 'error', '-show_entries', 'packet=stream_index', '-of', 'csv=p=0', '-read_intervals', '%+2', CHUNKED], { encoding: 'utf8' });
  const seq = r.stdout.trim().split('\n').map((l) => (l.trim() === '0' ? 'V' : 'A')).join('');
  assert.match(seq, /V{6,}A{6,}V{6,}/, 'expected chunked runs, got: ' + seq.slice(0, 60));
});

test('the app pipeline paces a chunk-interleaved class at real time with no pacing resets', () => {
  ensureFixture();
  const a = buildBroadcastArgs({ videoPath: CHUNKED, slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
    leadSec: 3, fadeSec: 1, bitrateKbps: 4500, fps: 30, outUrl: path.join(TMP, 'chunked-pacing.flv') });
  a.splice(a.indexOf('-loglevel'), 2); a.splice(a.indexOf('-progress'), 2);   // keep warnings visible: the resets are logged at warning level
  a.splice(a.indexOf('-f'), 0, '-t', '15', '-y');
  const t0 = Date.now();
  const r = spawnSync(ffmpeg.ffmpegPath(), a, { encoding: 'utf8', env: ffmpeg.ffmpegEnv() });
  const wall = (Date.now() - t0) / 1000;
  const resets = (r.stderr.match(/time discontinuity/g) || []).length;
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(resets, 0, 'pacing resets seen: ' + resets);
  assert.ok(wall >= 14 && wall <= 15 * 1.15, '15 s of media took ' + wall.toFixed(1) + ' s (must be ~real time; the old -re pipeline took 22 s here)');
});
