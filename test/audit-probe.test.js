'use strict';
// 2026-09-04 audit: probe.js reported coded (pre-rotation) width/height, so a
// rotation-tagged phone video was classified landscape; and it did not report
// the frame rate, so every class was forced to 30 fps (29.97 sources dup a frame).
const { test } = require('node:test');
const assert = require('node:assert');
const { probeFile } = require('../engine/probe');

const ffprobeJson = (over = {}) => JSON.stringify({
  format: { duration: '1210.04' },
  streams: [
    { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', ...over.video },
    { codec_type: 'audio' },
  ],
});
const run = (json) => async () => json;

test('a display-matrix rotation of 90/270 swaps width and height (portrait phone video)', async () => {
  const r = await probeFile('/v.mp4', { run: run(ffprobeJson({ video: { side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] } })) });
  assert.equal(r.ok, true); assert.equal(r.width, 1080); assert.equal(r.height, 1920);
});
test('the older tags.rotate=90 form is honoured too; 180 keeps the orientation', async () => {
  const a = await probeFile('/v.mp4', { run: run(ffprobeJson({ video: { tags: { rotate: '90' } } })) });
  assert.equal(a.width, 1080);
  const b = await probeFile('/v.mp4', { run: run(ffprobeJson({ video: { tags: { rotate: '180' } } })) });
  assert.equal(b.width, 1920);
});
test('the frame rate is reported as a number (29.97 for 30000/1001)', async () => {
  const r = await probeFile('/v.mp4', { run: run(ffprobeJson()) });
  assert.ok(Math.abs(r.fps - 29.97) < 0.01, String(r.fps));
});
test('a missing or odd frame rate yields 0, never NaN', async () => {
  const r = await probeFile('/v.mp4', { run: run(ffprobeJson({ video: { r_frame_rate: '0/0', avg_frame_rate: undefined } })) });
  assert.equal(r.fps, 0);
});
