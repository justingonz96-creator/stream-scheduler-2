'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ff = require('../engine/ffmpeg');

test('resolves runnable ffmpeg + ffprobe', async () => {
  const chk = await ff.selfCheck();
  assert.equal(chk.ok, true, chk.error || '');
  assert.match(chk.version, /^\d/);            // e.g. "8.0"
  assert.ok(ff.ffmpegPath().length > 0);
  assert.ok(ff.ffprobePath().length > 0);
});
