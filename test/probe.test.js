'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { probeFile } = require('../engine/probe');
const FIX = path.join(__dirname, 'fixtures');

test('probes a good file', async () => {
  const r = await probeFile(path.join(FIX, 'class.mp4'));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.durationSec - 20) < 0.5, `duration ${r.durationSec}`);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 720);
  assert.equal(r.hasAudio, true);
});

test('missing file → plain-English error', async () => {
  const r = await probeFile(path.join(FIX, 'nope.mp4'));
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be opened/i);
});

test('audio-less file → rejected with clear reason', async () => {
  // generate on the fly next to the other fixtures
  const { execFileSync } = require('node:child_process');
  const { ffmpegPath } = require('../engine/ffmpeg');
  const silent = path.join(FIX, 'silent.mp4');
  execFileSync(ffmpegPath(), ['-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=2',
    '-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p', silent]);
  const r = await probeFile(silent);
  assert.equal(r.ok, false);
  assert.match(r.error, /no sound/i);
});
