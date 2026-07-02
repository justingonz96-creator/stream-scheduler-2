'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');

const FIX = path.join(__dirname, 'fixtures');
const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const short = (over = {}) => ({
  videoPath: path.join(FIX, 'class.mp4'), leadSec: 2, fadeSec: 1,
  slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
  outUrl: path.join(TMP, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.flv`), ...over,
});

test('plays to the end: playing -> ended, file written', async () => {
  const b = new Broadcast(short());
  const events = [];
  b.on('playing', () => events.push('playing'));
  await new Promise((res, rej) => { b.on('ended', res); b.on('failed', e => rej(new Error(e.reason))); b.start(); });
  assert.deepEqual(events, ['playing']);
  assert.ok(fs.statSync(b.opts.outUrl).size > 10000, 'output has real content');
});

test('bad file → failed with plain-English reason, never ended', async () => {
  const b = new Broadcast(short({ videoPath: path.join(FIX, 'missing.mp4') }));
  const r = await new Promise((res) => { b.on('failed', res); b.on('ended', () => res({ reason: 'WRONGLY ENDED' })); b.start(); });
  assert.match(r.reason, /could not start/i);
});

test('stop(): clean kill, no failed event, offset math sane', async () => {
  const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
  let failed = false; b.on('failed', () => { failed = true; });
  await new Promise((res) => { b.on('playing', res); b.start(); });
  await new Promise(r => setTimeout(r, 1500));
  const off = b.videoOffsetSec();
  await b.stop();
  assert.equal(failed, false, 'a deliberate stop is not a failure');
  assert.ok(off > 0.5 && off < 10, `offset ${off}`);
});

test('mid-broadcast crash after playing → failed (resumable), never ended', async () => {
  const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
  let ended = false; b.on('ended', () => { ended = true; });
  const failed = new Promise((res) => b.on('failed', res));
  await new Promise((res) => { b.on('playing', res); b.start(); });
  b._proc.kill('SIGKILL');                      // simulate a mid-broadcast death
  const r = await failed;
  assert.equal(ended, false, 'a crash is never a clean end');
  assert.match(r.reason, /can be resumed/i);
});

test('spawn failure → failed with plain-English reason, no crash', async () => {
  const ffmpeg = require('../engine/ffmpeg');
  const orig = ffmpeg.ffmpegPath;
  ffmpeg.ffmpegPath = () => '/nonexistent/no-such-ffmpeg';
  try {
    const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
    const r = await new Promise((res) => { b.on('failed', res); b.start(); });
    assert.match(r.reason, /failed to launch/i);
  } finally { ffmpeg.ffmpegPath = orig; }
});

test('start() is one-shot — reuse throws instead of spawning a zombie', async () => {
  const b = new Broadcast(short({ videoPath: path.join(FIX, 'missing.mp4'), leadSec: 0, slateImage: null }));
  await new Promise((res) => { b.on('failed', res); b.start(); });
  assert.throws(() => b.start(), /one-shot/i);
});

test('start deadline: a source that never reaches playing fails plainly', async () => {
  // 1ms deadline fires long before ffmpeg's first progress tick — deterministic.
  const b = new Broadcast(short({ leadSec: 0, slateImage: null, startTimeoutMs: 1 }));
  let played = false; b.on('playing', () => { played = true; });
  const r = await new Promise((res) => { b.on('failed', res); b.start(); });
  assert.equal(played, false);
  assert.match(r.reason, /did not start within/i);
});
