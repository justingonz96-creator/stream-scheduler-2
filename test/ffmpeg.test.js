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

test('packaged app: process.resourcesPath candidate wins when present', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-res-'));
  const platDir = process.platform === 'win32' ? 'win-x64' : (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64');
  const dir = path.join(fake, 'ffmpeg', platDir);
  fs.mkdirSync(dir, { recursive: true });
  const tool = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(tool, '#!/bin/sh\n'); fs.chmodSync(tool, 0o755);
  const orig = process.resourcesPath;
  try {
    process.resourcesPath = fake;                       // simulate the packaged app
    delete require.cache[require.resolve('../engine/ffmpeg')];
    const ff = require('../engine/ffmpeg');
    assert.equal(ff.ffmpegPath(), tool, 'the packaged location must win');
  } finally {
    if (orig === undefined) delete process.resourcesPath; else process.resourcesPath = orig;
    delete require.cache[require.resolve('../engine/ffmpeg')];
  }
});

test('dev mode: without resourcesPath the repo/system resolution still works', () => {
  delete require.cache[require.resolve('../engine/ffmpeg')];
  const ff = require('../engine/ffmpeg');
  assert.ok(ff.ffmpegPath().length > 0);                // same guarantee as before
});
