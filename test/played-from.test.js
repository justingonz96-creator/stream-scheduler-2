'use strict';
// The class history must say where the video was read from and how fast the
// encoder ran, and the live view must warn while a class is falling behind.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');

function fakeEngine(stats) {
  const e = new EventEmitter();
  e.start = () => {}; e.stop = () => {}; e.videoOffsetSec = () => 0;
  e.speedStats = () => stats;
  return e;
}
function fakeCache(resolved = {}) {
  const c = { cancelled: [], resolved };
  c.resolve = (key) => c.resolved[key] || null;
  c.ensure = async () => null; c.release = () => {}; c.sweep = () => {}; c.keyForPath = (p) => 'k-' + p;
  c.cancel = (key) => c.cancelled.push(key);
  return c;
}
function harness({ cache, stats = { last: 1, min: 1, avg: 1, samples: 5 } }) {
  const spawned = [];
  let data = [{ id: 'e1', filePath: '/drive/class.mp4', fileName: 'class.mp4', fireAt: 1000, durationSec: 60, status: 'pending', autoStop: true }];
  let clock = 1500;
  const sched = createScheduler({
    store: { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); } },
    portal: { streamTarget: async () => ({ ok: true, server: 'rtmps://h/app', key: 'K' }), endBroadcast: async () => ({ ok: true }) },
    engineFactory: (opts) => { const e = fakeEngine(stats); e.opts = opts; spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: '', slateMusic: '', fadeMs: 0, videoBitrate: 4500 }) },
    cache, now: () => clock, genId: () => 'g', log: () => {},
  });
  return { sched, spawned, cache, setClock: (t) => { clock = t; }, ev: () => sched.getEvents().find((e) => e.id === 'e1') };
}
const settle = () => new Promise((r) => setImmediate(r));

test('going live from the DRIVE cancels that class\'s own in-flight copy; from the local copy it does not', async () => {
  const a = harness({ cache: fakeCache({}) });
  await a.sched.tick();
  assert.deepEqual(a.cache.cancelled, ['e1'], 'copy of the live class cancelled');
  assert.equal(a.ev().playedFrom, 'drive');
  const b = harness({ cache: fakeCache({ e1: '/local/e1.mp4' }) });
  await b.sched.tick();
  assert.deepEqual(b.cache.cancelled, [], 'nothing to cancel — it played from the copy');
  assert.equal(b.ev().playedFrom, 'local copy');
  assert.equal(b.spawned[0].opts.videoPath, '/local/e1.mp4');
});

test('the finished outcome records where it played from and the encoder speed', async () => {
  const h = harness({ cache: fakeCache({}), stats: { last: 0.67, min: 0.62, avg: 0.67, samples: 100 } });
  await h.sched.tick();
  h.spawned[0].emit('playing'); h.spawned[0].emit('ended'); await settle();
  const ev = h.ev();
  assert.equal(ev.status, 'done');
  assert.match(ev.outcome, /drive/i);
  assert.match(ev.outcome, /0\.67/);
  assert.match(ev.outcome, /0\.62/);
});

test("'slow' from the engine is persisted on the event (and cleared on 'speedok') so the live view can warn", async () => {
  const h = harness({ cache: fakeCache({}) });
  await h.sched.tick();
  h.spawned[0].emit('playing');
  h.spawned[0].emit('slow', { speed: 0.67 });
  assert.ok(h.ev().slow && Math.abs(h.ev().slow.speed - 0.67) < 1e-9, 'slow flag stored');
  h.spawned[0].emit('speedok');
  assert.equal(h.ev().slow, null);
});

test('a healthy class says so, plainly, without speed noise', async () => {
  const h = harness({ cache: fakeCache({ e1: '/local/e1.mp4' }), stats: { last: 1.0, min: 0.99, avg: 1.0, samples: 100 } });
  await h.sched.tick();
  h.spawned[0].emit('playing'); h.spawned[0].emit('ended'); await settle();
  assert.match(h.ev().outcome, /local copy/i);
  assert.doesNotMatch(h.ev().outcome, /min/i, 'no speed detail when the encoder kept up');
});
