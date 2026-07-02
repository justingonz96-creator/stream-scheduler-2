'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBroadcastArgs, videoStartsAtSec } = require('../engine/timeline');

const BASE = {
  videoPath: '/media/class.mp4', outUrl: 'rtmp://127.0.0.1:1935/live/test',
  leadSec: 300, fadeSec: 1, slateImage: '/media/slate.png', slateMusic: '/media/music.mp3',
};

test('full slate broadcast: inputs, xfade at lead, acrossfade, encode, flv out', () => {
  const a = buildBroadcastArgs({ ...BASE });
  const s = a.join(' ');
  assert.ok(s.includes('-loop 1'), 'slate image looped');
  assert.ok(s.includes('-stream_loop -1'), 'mp3 loops');
  assert.ok(s.includes('-t 301'), 'slate span = lead + fade');
  assert.ok(s.includes('xfade=transition=fade:duration=1:offset=300'), 'fade lands at the scheduled second');
  assert.ok(s.includes('acrossfade=d=1'), 'audio crossfade');
  assert.ok(s.includes('scale=1920:1080'), 'default 16:9 canvas');
  assert.ok(s.includes('-b:v 6000k'), 'default bitrate');
  assert.ok(s.includes('-g 60'), '2s keyframes @30fps');
  assert.ok(s.endsWith('-f flv rtmp://127.0.0.1:1935/live/test'), 'flv to ingest');
});

test('vertical → 1080x1920 canvas', () => {
  const s = buildBroadcastArgs({ ...BASE, vertical: true }).join(' ');
  assert.ok(s.includes('scale=1080:1920'));
  assert.ok(!s.includes('scale=1920:1080'));
});

test('no music → silent slate audio, acrossfade still used (one audio path)', () => {
  const s = buildBroadcastArgs({ ...BASE, slateMusic: null }).join(' ');
  assert.ok(s.includes('anullsrc'), 'silence stands in for music');
  assert.ok(s.includes('acrossfade=d=1'));
});

test('no lead-in → no slate inputs, video only', () => {
  const s = buildBroadcastArgs({ ...BASE, leadSec: 0 }).join(' ');
  assert.ok(!s.includes('xfade'), 'no fade without a slate phase');
  assert.ok(!s.includes('/media/slate.png'));
  assert.ok(s.includes('/media/class.mp4'));
});

test('resume → -ss before the video input, no slate', () => {
  const a = buildBroadcastArgs({ ...BASE, resumeOffsetSec: 372 });
  const s = a.join(' ');
  assert.ok(!s.includes('xfade'));
  const ss = a.indexOf('-ss');
  assert.ok(ss >= 0 && a[ss + 1] === '372');
  assert.ok(ss < a.indexOf('/media/class.mp4'), '-ss placed before -i (fast seek)');
});

test('videoStartsAtSec: lead with slate, 0 otherwise', () => {
  assert.equal(videoStartsAtSec({ ...BASE }), 300);
  assert.equal(videoStartsAtSec({ ...BASE, leadSec: 0 }), 0);
  assert.equal(videoStartsAtSec({ ...BASE, resumeOffsetSec: 5 }), 0);
});
