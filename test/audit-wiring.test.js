'use strict';
// 2026-09-04 audit, final batch: the new signals must reach the operator.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');
const { notificationsFor } = require('../store/notify');
const { createHealthController } = require('../store/health');

function fakeEngine() { const e = new EventEmitter(); e.start = () => {}; e.stop = async () => {}; e.videoOffsetSec = () => 0; e.speedStats = () => ({ samples: 0 }); return e; }
function harness(events) {
  const spawned = []; let data = events.map((e) => ({ ...e })); let t = 1500;
  const sched = createScheduler({
    store: { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); } },
    portal: { streamTarget: async () => ({ ok: true, server: 'rtmps://h/app', key: 'K' }), endBroadcast: async () => ({ ok: true }) },
    engineFactory: () => { const e = fakeEngine(); spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: '', slateMusic: '', fadeMs: 0, videoBitrate: 4500 }) },
    now: () => t, genId: () => 'g', log: () => {},
  });
  return { sched, spawned, ev: () => sched.getEvents()[0] };
}
const cls = { id: 'e1', filePath: '/v.mp4', fileName: 'v.mp4', fireAt: 1000, durationSec: 1200, status: 'pending', autoStop: true, contentItemGuid: 'c1' };

test("a black or silent picture during the class is recorded on the event and cleared when it recovers", async () => {
  const h = harness([cls]);
  await h.sched.tick(); h.spawned[0].emit('playing');
  h.spawned[0].emit('blank', { kind: 'black', at: 130 });
  assert.equal(h.ev().blank.kind, 'black');
  h.spawned[0].emit('blank', { kind: 'black', ended: true, at: 140 });
  assert.equal(h.ev().blank, null);
});
test('a class that went black is noted in its history entry', async () => {
  const h = harness([cls]);
  await h.sched.tick(); h.spawned[0].emit('playing');
  h.spawned[0].emit('blank', { kind: 'silent', at: 200 });
  h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));
  assert.match(h.ev().outcome, /silent|no sound/i);
});
test('the notification list covers a blank picture and a mild slowdown, each once', () => {
  const base = { id: 'e1', title: 'Ride', status: 'playing' };
  const a = notificationsFor([base], [{ ...base, blank: { kind: 'black' } }]);
  assert.equal(a.length, 1); assert.match(a[0].body, /black/i);
  assert.equal(notificationsFor([{ ...base, blank: { kind: 'black' } }], [{ ...base, blank: { kind: 'black' } }]).length, 0);
  const m = notificationsFor([base], [{ ...base, slow: { speed: 0.95, mild: true } }]);
  assert.equal(m.length, 1); assert.match(m[0].body, /0\.95/);
});
test('the slate health check accepts a locally cached slate when the drive is down', async () => {
  const probed = [];
  const h = createHealthController({
    portal: { testLogin: async () => ({ ok: true, stations: [] }) }, ffmpeg: { selfCheck: async () => ({ ok: true, version: 'x' }) },
    settings: { get: () => ({ portalEmail: 'a@b', slateImage: '/net/slate.png', slateMusic: '' }) },
    fileOk: async (p) => { probed.push(p); return p.startsWith('/local'); },
    getSlatePaths: () => ['/local/slate.png'],
  });
  const s = await h.check();
  assert.equal(s.checks.find((c) => c.id === 'slate').ok, true, 'a cached slate is healthy: probed ' + probed.join(','));
});
