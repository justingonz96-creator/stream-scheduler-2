'use strict';
// Real-time pacing lives at the OUTPUT (realtime on video, arealtime on audio),
// never on the inputs (-re).
//
// Why (2026-09-04, proven with a real class export + the app's own pipeline):
// per-input -re paces each input by its packets' timestamps. The studio's export
// tool (Mainconcept) writes files in CHUNKS — ~⅓ s of video, then ~⅓ s of audio —
// and once an input has been held back (the class waits behind the slate), -re
// on such a file throttles the whole encode to ~0.70x of real time: 20 fps and
// ⅔ bitrate at the platform, the class ends late, and the `realtime` filter logs
// "time discontinuity … resetting" every few seconds. Even the plain no-slate
// path ran at 0.54x writing FLV. Removing -re and pacing the finished output
// instead ran at 0.999x with zero resets on every path, on a Mac AND on the
// studio PC's numbers. Do not re-add -re.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBroadcastArgs } = require('../engine/timeline');

const BASE = { videoPath: '/v.mp4', slateImage: '/s.jpg', slateMusic: '/m.mp3', leadSec: 120, fadeSec: 1, bitrateKbps: 4500, fps: 30, outUrl: 'rtmps://h/app/k' };
const PATHS = {
  'slate + music': BASE,
  'slate, silent': { ...BASE, slateMusic: '' },
  'plain (no slate)': { ...BASE, slateImage: '', leadSec: 0 },
  'resume mid-class': { ...BASE, resumeOffsetSec: 300 },
};
const filter = (a) => a[a.indexOf('-filter_complex') + 1];
const chain = (a, out) => filter(a).split(';').find((c) => c.endsWith('[' + out + ']'));

for (const [name, opts] of Object.entries(PATHS)) {
  test(`${name}: no -re on any input`, () => {
    assert.ok(!buildBroadcastArgs(opts).includes('-re'), 'input pacing (-re) must be gone');
  });
  test(`${name}: video is paced at the output (realtime), then pinned to 4:2:0`, () => {
    assert.match(chain(buildBroadcastArgs(opts), 'vout'), /,realtime,format=yuv420p\[vout\]$/);
  });
  test(`${name}: audio is paced at the output too (arealtime), so A/V stay together`, () => {
    assert.match(chain(buildBroadcastArgs(opts), 'aout'), /,arealtime\[aout\]$/);
  });
}

test('pacing happens exactly once per stream — no doubled pacing anywhere', () => {
  for (const opts of Object.values(PATHS)) {
    const f = filter(buildBroadcastArgs(opts));
    assert.equal((f.match(/(?<!a)realtime/g) || []).length, 1, 'one realtime: ' + f);
    assert.equal((f.match(/arealtime/g) || []).length, 1, 'one arealtime: ' + f);
  }
});

test('the slate inputs still stop at the crossfade (-t), so the looped slate cannot run on', () => {
  const a = buildBroadcastArgs(BASE);
  const ts = a.map((x, i) => (x === '-t' ? a[i + 1] : null)).filter(Boolean);
  assert.deepEqual(ts, ['121', '121'], 'slate image and slate music both limited to lead+fade');
});
