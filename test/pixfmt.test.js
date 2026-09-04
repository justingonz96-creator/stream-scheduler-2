'use strict';
// A slate JPEG saved as 4:4:4 (Photoshop's default for high-quality JPEG) made
// the WHOLE broadcast encode as H.264 High 4:4:4 Predictive — the slate and the
// class share one output stream, and the format is re-negotiated after the
// crossfade, where 4:4:4 wins. Streaming platforms expect 4:2:0 and many
// decoders cannot play 4:4:4 at all. Proven live on a studio PC 2026-09-04.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBroadcastArgs } = require('../engine/timeline');

const withSlate = (over = {}) => buildBroadcastArgs({
  videoPath: '/v.mp4', slateImage: '/s.jpg', slateMusic: '/m.mp3',
  leadSec: 120, fadeSec: 1, bitrateKbps: 4500, fps: 30, outUrl: 'rtmps://h/app/k', ...over,
});
const filter = (args) => args[args.indexOf('-filter_complex') + 1];

test('the composed video output is pinned to 4:2:0, after the crossfade', () => {
  const f = filter(withSlate());
  const vout = f.split(';').find((c) => c.includes('[vout]'));
  assert.match(vout, /format=yuv420p\[vout\]$/, 'the LAST thing before [vout] must force 4:2:0: ' + vout);
});

test('the no-slate path is pinned too (a 4:4:4 class file must not leak either)', () => {
  const f = filter(withSlate({ slateImage: '', leadSec: 0 }));
  const vout = f.split(';').find((c) => c.includes('[vout]'));
  assert.match(vout, /format=yuv420p\[vout\]$/, vout);
});

test('a resumed broadcast is pinned as well', () => {
  const f = filter(withSlate({ resumeOffsetSec: 300 }));
  assert.match(f.split(';').find((c) => c.includes('[vout]')), /format=yuv420p\[vout\]$/);
});

test('pinning is belt-and-braces: the encoder is told 4:2:0 explicitly too', () => {
  const a = withSlate();
  const i = a.indexOf('-pix_fmt');
  assert.ok(i > 0 && a[i + 1] === 'yuv420p', '-pix_fmt yuv420p must be on the output');
  assert.ok(i > a.indexOf('-filter_complex'), '-pix_fmt belongs with the output options');
});

test('real-time pacing still comes before the format pin (pacing must not move)', () => {
  const f = filter(withSlate());
  assert.match(f, /realtime,format=yuv420p\[vout\]/);
});
