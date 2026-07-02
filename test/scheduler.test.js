'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');
const { normalizeEvent } = require('../schedule/model');

// ---- fakes ----
function memStore(initial = []) {
  let data = initial.map((e) => ({ ...e })); let willFail = false;
  return { load: () => data.map((e) => ({ ...e })), save: (evs) => { if (willFail) throw new Error('disk full'); data = evs.map((e) => ({ ...e })); }, _fail: () => { willFail = true; } };
}
function fakeEngine(offset = 5) {
  const e = new EventEmitter();
  e.started = false; e.stopped = false;
  e.start = () => { e.started = true; };
  e.stop = () => { e.stopped = true; };
  e.videoOffsetSec = () => offset;
  return e;
}
function harness({ events = [], target = { ok: true, server: 'rtmps://h/app', key: 'KEY', stationName: 'S', vertical: false }, offset = 5, onEndBroadcast = null } = {}) {
  const spawned = [];
  const ended = [];
  const order = [];   // records 'end' (portal) and 'stop' (engine) call ordering
  const engineFactory = (opts) => {
    const e = fakeEngine(offset); e.opts = opts;
    const origStop = e.stop; e.stop = () => { order.push('stop'); origStop(); };
    spawned.push(e); return e;
  };
  const portal = {
    streamTarget: async () => (typeof target === 'function' ? target() : target),
    endBroadcast: async (a) => { ended.push(a); order.push('end'); if (onEndBroadcast) onEndBroadcast(); return { ok: true }; },
  };
  const settings = { get: () => ({ slateImage: 'slate.png', slateMusic: 'm.mp3', fadeMs: 1000, videoBitrate: 6000 }) };
  let clock = 0;
  let idc = 0;
  const store = memStore(events);
  const logs = [];
  const sched = createScheduler({
    store, portal, engineFactory, settings,
    now: () => clock, genId: () => 'gen' + (idc++), log: (m) => logs.push(m),
  });
  return { sched, spawned, ended, order, logs, setClock: (t) => { clock = t; }, getClock: () => clock, failSave: () => store._fail() };
}
const liveEvent = (over = {}) => normalizeEvent(Object.assign({
  id: 'e1', filePath: '/v.mp4', durationSec: 600, contentItemGuid: 'ci', scheduleGuid: 'sg',
  fireAt: 100000, leadMs: 30000, autoStop: true, status: 'pending',
}, over));

test('go-live: resolves target, spawns one engine with the right options; verified-start gates status', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000);                 // == streamAt (fireAt 100000 − lead 30000)
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
  const opts = h.spawned[0].opts;
  assert.equal(opts.videoPath, '/v.mp4');
  assert.equal(opts.leadSec, 30);            // full lead
  assert.equal(opts.fadeSec, 1);
  assert.equal(opts.slateImage, 'slate.png');
  assert.equal(opts.outUrl, 'rtmps://h/app/KEY');
  assert.equal(h.sched.getEvents()[0].status, 'starting');   // not yet 'playing' — engine hasn't confirmed
  h.spawned[0].emit('playing');
  assert.equal(h.sched.getEvents()[0].status, 'preshow');    // playing before fireAt ⇒ slate is up
  h.setClock(100000); await h.sched.tick();
  assert.equal(h.sched.getEvents()[0].status, 'playing');    // fireAt reached ⇒ video label
});

test('abort-if-no-target: streamTarget fails ⇒ event failed, NO engine spawned', async () => {
  const h = harness({ events: [liveEvent()], target: { ok: false, error: 'No studio found for this class — check the class link.' } });
  h.setClock(70000);
  await h.sched.tick();
  assert.equal(h.spawned.length, 0, 'must not spawn an engine without a target');
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.outcome, /No studio found/);
});

test('no-slate path when starting at/after fireAt: leadSec 0 and slate fields blank', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(100000);               // exactly fireAt — late enough that lead is gone
  await h.sched.tick();
  assert.equal(h.spawned[0].opts.leadSec, 0);
  assert.equal(h.spawned[0].opts.slateImage, '');
  assert.equal(h.spawned[0].opts.slateMusic, '');
});

test('clean end with autoStop: ends portal, marks Played ✓ done', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));    // let the async end handler run
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'done');
  assert.match(ev.outcome, /Played ✓/);
  assert.deepEqual(h.ended[0], { contentItemGuid: 'ci', scheduleGuid: 'sg' });   // event's OWN pair
});

test('clean end with autoStop OFF: video done but portal left open, not ended', async () => {
  const h = harness({ events: [liveEvent({ autoStop: false })] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sched.getEvents()[0].status, 'done');
  assert.equal(h.ended.length, 0, 'portal broadcast is NOT auto-ended when autoStop is off');
});

test('retry-once: a start failure spawns exactly one fresh engine; a second failure fails the event', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'ffmpeg exited' });   // never saw 'playing'
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'one automatic retry');
  assert.equal(h.sched.getEvents()[0].status, 'starting');
  h.spawned[1].emit('failed', { reason: 'again' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'no second retry');
  assert.equal(h.sched.getEvents()[0].status, 'failed');
});

test('resume-at-offset: a drop after playing respawns with resumeOffsetSec and no slate', async () => {
  const h = harness({ events: [liveEvent()], offset: 42 });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.setClock(150000);                              // mid-video, well before planned end (700000)
  h.spawned[0].emit('failed', { reason: 'network blip' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 42);
  assert.equal(h.spawned[1].opts.leadSec, 0);
  assert.equal(h.spawned[1].opts.slateImage, '');
});

test('resume respects MAX_RESUMES then fails cleanly', async () => {
  const h = harness({ events: [liveEvent()], offset: 10 });
  h.setClock(70000); await h.sched.tick();
  h.setClock(150000);
  // 1 initial + 3 resumes = 4 engines, then the 4th failure gives up
  for (let i = 0; i < 4; i++) { h.spawned[i].emit('playing'); h.spawned[i].emit('failed', { reason: 'drop' }); await new Promise((r) => setImmediate(r)); }
  assert.equal(h.spawned.length, 4, '1 original + MAX_RESUMES(3)');
  assert.equal(h.sched.getEvents()[0].status, 'failed');
});

test('missed: past the grace window ⇒ missed (never spawns)', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(100000 + 120000 + 1);       // fireAt + GRACE + 1ms
  await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.sched.getEvents()[0].status, 'missed');
});

test('needsVideo weekly slot never goes live', async () => {
  const h = harness({ events: [liveEvent({ needsVideo: true, filePath: '' })] });
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.sched.getEvents()[0].status, 'pending');   // still waiting; not missed yet
});

test('weekly renewal: a completed repeating event seeds next week exactly once', async () => {
  const h = harness({ events: [liveEvent({ repeatWeekly: true })] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing'); h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));
  const evs = h.sched.getEvents();
  const pend = evs.filter((e) => e.status === 'pending');
  assert.equal(pend.length, 1, 'exactly one renewed slot');
  assert.equal(pend[0].needsVideo, true);
  assert.equal(pend[0].fireAt, 100000 + 7 * 86400000);
});

test('operator stop: ends portal BEFORE stopping the engine, marks stopped', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  const res = await h.sched.stopActive('e1');
  assert.equal(res.ok, true);
  assert.deepEqual(h.order, ['end', 'stop'], 'portal end must precede engine stop (end-portal-before-stop law)');
  assert.equal(h.spawned[0].stopped, true, 'engine stopped');
  assert.equal(h.sched.getEvents()[0].status, 'done');
  assert.match(h.sched.getEvents()[0].outcome, /Stopped by the operator/);
});

test('takeover: a new event at its time ends the previous one early', async () => {
  const a = liveEvent({ id: 'A', fireAt: 100000, leadMs: 30000 });
  const b = liveEvent({ id: 'B', fireAt: 160000, leadMs: 0, contentItemGuid: 'ci2', scheduleGuid: 'sg2' });
  const h = harness({ events: [a, b] });
  h.setClock(70000); await h.sched.tick();          // A goes live
  h.spawned[0].emit('playing');
  h.setClock(160000); await h.sched.tick();          // B's moment — takeover
  await new Promise((r) => setImmediate(r));
  const evA = h.sched.getEvents().find((e) => e.id === 'A');
  assert.equal(evA.status, 'done');
  assert.match(evA.outcome, /Ended early/);
  assert.equal(h.spawned[0].stopped, true);
  assert.equal(h.spawned.length, 2, 'B spawned its own engine');
});

test('crash recovery: an event left mid-broadcast on load becomes missed (+renew)', () => {
  const h = harness({ events: [liveEvent({ status: 'playing', repeatWeekly: true })] });
  const evs = h.sched.getEvents();
  const orig = evs.find((e) => e.id === 'e1');
  assert.equal(orig.status, 'missed');
  assert.match(orig.outcome, /Interrupted/);
  assert.equal(evs.filter((e) => e.status === 'pending').length, 1, 'renewed once');
});

test('addEvent normalizes + persists; removeEvent refuses the live event', async () => {
  const h = harness({ events: [] });
  const ev = h.sched.addEvent({ title: 'New', fireAt: 5, filePath: '/x.mp4', durationSec: 1, contentItemGuid: 'ci', scheduleGuid: 'sg' });
  assert.equal(ev.status, 'pending'); assert.ok(ev.id);
  h.setClock(5); await h.sched.tick();
  h.spawned[0].emit('playing');
  const r = h.sched.removeEvent(ev.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /Stop the live broadcast/i);
});

test('instance guard: a late "playing" from a dead engine does not flip status', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'start fail' });      // retry → spawned[1]
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  h.spawned[0].emit('playing');                                // dead instance emits late
  assert.equal(h.sched.getEvents()[0].status, 'starting', 'dead engine playing must be ignored');
});

test('takeover: a failure DURING the portal-end await cannot orphan a resume engine', async () => {
  let h;
  const a = liveEvent({ id: 'A', fireAt: 100000, leadMs: 30000 });
  const b = liveEvent({ id: 'B', fireAt: 160000, leadMs: 0, contentItemGuid: 'ci2', scheduleGuid: 'sg2' });
  h = harness({ events: [a, b], offset: 42, onEndBroadcast: () => { if (h.spawned[0]) h.spawned[0].emit('failed', { reason: 'drop during end' }); } });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');                 // A live
  h.setClock(160000); await h.sched.tick();      // takeover A (failure injected mid-await), then go live B
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'no orphaned resume engine for the taken-over event');
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 0, 'the 2nd engine is B fresh, not an A-resume (which would carry offset 42)');
  assert.equal(h.sched.getEvents().find((e) => e.id === 'A').status, 'done');
});

test('key redaction: a stream key in a failure reason never reaches outcome or logs', async () => {
  const h = harness({ events: [liveEvent()] });      // target.key === 'KEY', server 'rtmps://h/app'
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'rtmps://h/app/KEY: Input/output error' });
  await new Promise((r) => setImmediate(r));          // retry
  h.spawned[1].emit('failed', { reason: 'rtmps://h/app/KEY: Input/output error' });
  await new Promise((r) => setImmediate(r));          // fail
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'failed');
  assert.ok(!ev.outcome.includes('KEY'), 'key must not be in the persisted outcome');
  assert.ok(!h.logs.join('\n').includes('KEY'), 'key must not be in logs');
});

test('a store.save failure inside the async ended handler does not throw or reject unhandled', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.failSave();
  assert.doesNotThrow(() => h.spawned[0].emit('ended'));
  await new Promise((r) => setImmediate(r));           // rejection, if any, is swallowed by the handler's .catch
});

test('a store.save failure inside the sync playing handler does not throw', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.failSave();
  assert.doesNotThrow(() => h.spawned[0].emit('playing'));
});
