'use strict';
// A failed class must be re-runnable from the alert, instead of the operator
// having to delete it and build the whole thing again (2026-09-03 request).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');

function fakeEngine() {
  const e = new EventEmitter();
  e.start = () => { e.started = true; };
  e.stop = () => { e.stopped = true; };
  e.videoOffsetSec = () => 0;
  return e;
}
function harness(events, { target = { ok: true, server: 'rtmps://h/app', key: 'K', vertical: false } } = {}) {
  const spawned = [];
  let data = events.map((e) => ({ ...e }));
  let clock = 0;
  const sched = createScheduler({
    store: { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); } },
    portal: { streamTarget: async () => target, endBroadcast: async () => ({ ok: true }) },
    engineFactory: (opts) => { const e = fakeEngine(); e.opts = opts; spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: 's.png', slateMusic: 'm.mp3', fadeMs: 1000, videoBitrate: 6000 }) },
    now: () => clock, genId: () => 'g', log: () => {},
  });
  return { sched, spawned, setClock: (t) => { clock = t; } };
}
const failedEvent = (over = {}) => ({
  id: 'e1', title: 'Nicole 9PM', filePath: '/v/class.mp4', fileName: 'class.mp4',
  fireAt: 1000, durationSec: 3600, status: 'failed',
  outcome: 'Could not start: the stream server refused', doneAt: 1200, ...over,
});

test('retryEvent re-runs a failed class without rebuilding it', async () => {
  const h = harness([failedEvent()]);
  h.setClock(1500);
  const res = await h.sched.retryEvent('e1');
  assert.equal(res.ok, true, res.error);
  assert.equal(h.spawned.length, 1, 'a fresh broadcast was started');
  const ev = h.sched.getEvents().find((e) => e.id === 'e1');
  assert.notEqual(ev.status, 'failed', 'the class is live again, not still failed');
});

test('a retry that is already too late is refused, with a reason', async () => {
  const h = harness([failedEvent({ durationSec: 60 })]);
  h.setClock(1000 + 61 * 1000);          // past the end of the class
  const res = await h.sched.retryEvent('e1');
  assert.equal(res.ok, false);
  assert.match(res.error, /over|late/i);
  assert.equal(h.spawned.length, 0, 'nothing is spawned for a class that is already over');
});

test('a retry seeks to the elapsed point so the class still ends on time', async () => {
  const h = harness([failedEvent()]);
  h.setClock(1000 + 120 * 1000);         // two minutes late
  await h.sched.retryEvent('e1');
  const opts = h.spawned[0].opts;
  assert.ok(opts.resumeOffsetSec >= 119, 'seeks ~120s in, got ' + opts.resumeOffsetSec);
  assert.equal(opts.leadSec, 0, 'no slate lead when starting late');
});

test('retry refuses while another class is on air', async () => {
  const h = harness([failedEvent(), { id: 'e2', filePath: '/v/b.mp4', fileName: 'b.mp4', fireAt: 1000, durationSec: 3600, status: 'pending' }]);
  h.setClock(1500);
  await h.sched.tick();                   // e2 goes live
  const res = await h.sched.retryEvent('e1');
  assert.equal(res.ok, false);
  assert.match(res.error, /already|live|air/i);
});

test('retrying an unknown or non-failed class is refused', async () => {
  const h = harness([failedEvent({ status: 'done' })]);
  h.setClock(1500);
  assert.equal((await h.sched.retryEvent('nope')).ok, false);
  assert.equal((await h.sched.retryEvent('e1')).ok, false, 'a class that played is not retryable');
});
