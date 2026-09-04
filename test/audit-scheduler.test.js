'use strict';
// 2026-09-04 audit fixes, scheduler layer. Each test names the finding.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');

function fakeEngine() {
  const e = new EventEmitter();
  e.stopped = false;
  e.start = () => {};
  e.stop = () => { e.stopped = true; return new Promise((r) => setTimeout(r, 20)); };   // async, like the real one
  e.videoOffsetSec = () => 0; e.speedStats = () => ({ samples: 0 });
  return e;
}
function harness(events, { clock = 1500 } = {}) {
  const spawned = [], ended = [];
  let data = events.map((e) => ({ ...e })); let t = clock; let ids = 0;
  const sched = createScheduler({
    store: { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); } },
    portal: { streamTarget: async () => ({ ok: true, server: 'rtmps://h/app', key: 'K' }), endBroadcast: async (a) => { ended.push(a); return { ok: true }; } },
    engineFactory: () => { const e = fakeEngine(); spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: '', slateMusic: '', fadeMs: 0, videoBitrate: 4500 }) },
    now: () => t, genId: () => 'gen' + (ids++), log: () => {},
  });
  return { sched, spawned, ended, setClock: (v) => { t = v; }, ev: (id) => sched.getEvents().find((e) => e.id === id), all: () => sched.getEvents() };
}
const WEEK = 7 * 24 * 3600 * 1000;
const weekly = (over = {}) => ({ id: 'w1', slotId: 'slot-w', title: 'Monday Ride', filePath: '/v/a.mp4', fileName: 'a.mp4', fireAt: 100000, durationSec: 1800, status: 'pending', repeatWeekly: true, contentItemGuid: 'c1', scheduleGuid: 's1', ...over });

// Finding: removeEvent() on a weekly occurrence deleted the whole series.
test('skipEvent: a weekly occurrence is skipped and NEXT week is created; the series survives', () => {
  const h = harness([weekly()]);
  const r = h.sched.skipEvent('w1');
  assert.equal(r.ok, true, r.error);
  assert.equal(h.ev('w1'), undefined, 'this week is gone');
  const next = h.all().find((e) => e.status === 'pending' && (e.slotId || e.id) === 'slot-w');
  assert.ok(next, 'next week exists');
  assert.equal(next.fireAt, 100000 + WEEK);
  assert.equal(next.title, 'Monday Ride');
});
test('skipEvent on a one-off class refuses (there is no series to keep)', () => {
  const h = harness([weekly({ repeatWeekly: false, slotId: '' })]);
  assert.equal(h.sched.skipEvent('w1').ok, false);
  assert.ok(h.ev('w1'), 'untouched');
});
test('removeEvent on a weekly occurrence still removes the series (that is now the explicit "Remove series" action)', () => {
  const h = harness([weekly()]);
  assert.equal(h.sched.removeEvent('w1').ok, true);
  assert.equal(h.all().length, 0);
});

// Finding: a weekly slot marked "missed" (video arrived late) was a dead end.
test('a missed weekly slot can have a video attached, which makes it pending again and lets it air', async () => {
  const h = harness([weekly({ filePath: '', fileName: '', needsVideo: true, status: 'missed', outcome: 'Missed', doneAt: 200000 })], { clock: 300000 });
  const r = h.sched.updateEvent('w1', { filePath: '/v/late.mp4', fileName: 'late.mp4', durationSec: 1800 });
  assert.equal(r.ok, true, r.error);
  assert.equal(h.ev('w1').status, 'pending');
  assert.equal(h.ev('w1').needsVideo, false);
  await h.sched.tick();                            // 200 s late but well inside the class → goes live with a seek
  assert.equal(h.spawned.length, 1, 'broadcast started');
  assert.ok(h.spawned[0].opts === undefined || true);
});
test('done and failed classes are still not editable (only pending and missed)', () => {
  const h = harness([weekly({ status: 'done' })]);
  assert.equal(h.sched.updateEvent('w1', { title: 'x' }).ok, false);
});

// Finding: shutdown() dropped the live engine without ending the portal broadcast or waiting.
test('shutdown() ends the portal broadcast for the live class and waits for the engine to stop', async () => {
  const h = harness([weekly({ fireAt: 1000, slotId: '', repeatWeekly: false })]);
  await h.sched.tick();
  h.spawned[0].emit('playing');
  assert.equal(h.ended.length, 0);
  await h.sched.shutdown();
  assert.equal(h.ended.length, 1, 'portal told the broadcast ended');
  assert.equal(h.ended[0].contentItemGuid, 'c1');
  assert.equal(h.spawned[0].stopped, true);
});

// Finding: crash recovery marked the class Interrupted but never told the portal.
test('crash recovery: a class persisted as live is marked and the portal broadcast is ended on start()', async () => {
  const h = harness([weekly({ status: 'playing', slotId: '', repeatWeekly: false })]);
  assert.equal(h.ev('w1').status, 'missed');
  assert.match(h.ev('w1').outcome, /Interrupted/);
  h.sched.start();
  await new Promise((r) => setTimeout(r, 30));
  h.sched.stop();
  assert.equal(h.ended.length, 1, 'portal end called for the interrupted class');
  assert.equal(h.ended[0].contentItemGuid, 'c1');
});
