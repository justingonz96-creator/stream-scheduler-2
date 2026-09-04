'use strict';
// 2026-09-04 audit, encode-correctness items in the command builder.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBroadcastArgs } = require('../engine/timeline');
const BASE = { videoPath: '/v.mp4', slateImage: '/s.png', slateMusic: '/m.mp3', leadSec: 120, fadeSec: 1, bitrateKbps: 4500, fps: 30, outUrl: 'x' };
const filter = (a) => a[a.indexOf('-filter_complex') + 1];
const chain = (a, out) => filter(a).split(';').find((c) => c.endsWith('[' + out + ']'));

// (33) a PNG slate with transparency leaked whatever colour sat under the alpha
test('the slate is flattened onto black before use (transparent PNG areas become black, not garbage)', () => {
  const f = filter(buildBroadcastArgs(BASE));
  assert.match(f, /color=c=black:s=1920x1080:r=30\[slbg\]/, 'a black canvas source exists');
  assert.match(f, /\[slbg\]\[slraw\]overlay=[^;]*shortest=1/, 'the slate is overlaid onto it');
  assert.match(chain(buildBroadcastArgs(BASE), 'slv'), /format=yuv420p\[slv\]$/);
});
// (24) black / silent detection is in the graph, printed to stderr for the engine to parse
test('black and silence detectors are in the class chains and print to stderr (metadata=print)', () => {
  const a = buildBroadcastArgs(BASE); const f = filter(a);
  assert.match(f, /blackdetect=d=[\d.]+:pix_th=[\d.]+,metadata=print:file='pipe\\:2'/);
  assert.match(f, /silencedetect=n=-\d+dB:d=[\d.]+,ametadata=print:file='pipe\\:2'/);
  const plain = filter(buildBroadcastArgs({ ...BASE, slateImage: '', leadSec: 0 }));
  assert.match(plain, /blackdetect/); assert.match(plain, /silencedetect/);
});
// (54) every broadcast was forced to 30 fps; real exports are 29.97
test('the source frame rate is used when it is a sane broadcast rate; otherwise 30', () => {
  const a = buildBroadcastArgs({ ...BASE, fps: 29.97 });
  assert.match(filter(a), /fps=30000\/1001/, 'fps filter uses the exact 29.97 ratio');
  assert.equal(a[a.indexOf('-g') + 1], '60');
  const b = buildBroadcastArgs({ ...BASE, fps: 25 });
  assert.match(filter(b), /fps=25,/); assert.equal(b[b.indexOf('-g') + 1], '50');
  for (const bad of [0, NaN, 7, 121, undefined]) assert.match(filter(buildBroadcastArgs({ ...BASE, fps: bad })), /fps=30,/, 'bad fps ' + bad + ' → 30');
  assert.match(filter(buildBroadcastArgs({ ...BASE, fps: 60 })), /fps=30,/, '60 fps sources are delivered at 30 (bandwidth, platform expectations)');
});
// (45) a negative custom bitrate was accepted and misdiagnosed as a network problem
test('the bitrate is clamped to a sane range (500–20000 kbps), never negative or zero', () => {
  for (const [given, want] of [[-5, '500k'], [0, '6000k'], [NaN, '6000k'], [100, '500k'], [4500, '4500k'], [99999, '20000k'], ['4500', '4500k']]) {
    const a = buildBroadcastArgs({ ...BASE, bitrateKbps: given });
    assert.equal(a[a.indexOf('-b:v') + 1], want, 'bitrate ' + given);
  }
});

// stdin is a pipe (for the graceful 'q'), so ffmpeg must never PROMPT about an
// existing output file — it would wait forever and the class would never start.
test('the output is always overwritten without asking (-y), on every path', () => {
  for (const o of [BASE, { ...BASE, slateImage: '', leadSec: 0 }, { ...BASE, resumeOffsetSec: 300 }]) {
    const a = buildBroadcastArgs(o);
    assert.ok(a.includes('-y'), 'no -y: ffmpeg would prompt on an existing output');
    assert.ok(a.indexOf('-y') < a.indexOf('-i'), '-y belongs before the inputs');
  }
});
