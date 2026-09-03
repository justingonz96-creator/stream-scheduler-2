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
// Fake local-media cache: records calls; `resolved` maps key → local path to
// simulate "a verified copy exists".
function fakeCache(resolved = {}) {
  const c = { ensured: [], released: [], swept: [], resolved };
  c.resolve = (key) => c.resolved[key] || null;
  c.ensure = async (key, src) => { c.ensured.push([key, src]); return c.resolved[key] || null; };
  c.release = (key) => { c.released.push(key); };
  c.sweep = (keep) => { c.swept.push(new Set(keep)); };
  c.keyForPath = (p) => 'slate-' + p;
  return c;
}
function harness({ events = [], target = { ok: true, server: 'rtmps://h/app', key: 'KEY', stationName: 'S', vertical: false }, offset = 5, onEndBroadcast = null, slate = 'slate.png', slateVertical = '', cache = null } = {}) {
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
  const settings = { get: () => ({ slateImage: slate, slateImageVertical: slateVertical, slateMusic: (slate || slateVertical) ? 'm.mp3' : '', fadeMs: 1000, videoBitrate: 6000 }) };
  let clock = 0;
  let idc = 0;
  const store = memStore(events);
  const logs = [];
  const sched = createScheduler({
    store, portal, engineFactory, settings, cache,
    now: () => clock, genId: () => 'gen' + (idc++), log: (m) => logs.push(m),
  });
  return { sched, spawned, ended, order, logs, cache, setClock: (t) => { clock = t; }, getClock: () => clock, failSave: () => store._fail() };
}
const liveEvent = (over = {}) => normalizeEvent(Object.assign({
  id: 'e1', filePath: '/v.mp4', durationSec: 600, contentItemGuid: 'ci', scheduleGuid: 'sg',
  fireAt: 100000, leadMs: 30000, autoStop: true, status: 'pending',
}, over));

test('go-live: a vertical class uses the 9:16 slate, not the 16:9 one', async () => {
  const h = harness({
    events: [liveEvent()],
    target: { ok: true, server: 'rtmps://h/app', key: 'KEY', stationName: 'S', vertical: true },
    slate: 'wide.png', slateVertical: 'tall.png',
  });
  h.setClock(70000);                 // == streamAt (fireAt 100000 − lead 30000)
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].opts.vertical, true);
  assert.equal(h.spawned[0].opts.slateImage, 'tall.png', 'the vertical class must get the 9:16 slate');
});

test('go-live: a vertical class with only a 16:9 slate falls back to it (non-breaking)', async () => {
  const h = harness({
    events: [liveEvent()],
    target: { ok: true, server: 'rtmps://h/app', key: 'KEY', stationName: 'S', vertical: true },
    slate: 'wide.png', slateVertical: '',
  });
  h.setClock(70000);
  await h.sched.tick();
  assert.equal(h.spawned[0].opts.slateImage, 'wide.png', 'no 9:16 slate ⇒ fall back to the 16:9 one');
});

test('clearPast removes finished events (done/failed/missed) and keeps upcoming ones', () => {
  const h = harness({ events: [
    liveEvent({ id: 'p1', status: 'pending', fireAt: 9999999999999 }),
    liveEvent({ id: 'd1', status: 'done', doneAt: 1 }),
    liveEvent({ id: 'f1', status: 'failed', doneAt: 2 }),
    liveEvent({ id: 'm1', status: 'missed', doneAt: 3 }),
  ] });
  const r = h.sched.clearPast();
  assert.equal(r.ok, true);
  assert.equal(r.removed, 3);
  assert.deepEqual(h.sched.getEvents().map((e) => e.id), ['p1']);
});

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

test('late start (video still has content left) seeks ahead to match the clock, no slate', async () => {
  const h = harness({ events: [liveEvent()] });   // fireAt 100000, durationSec 600, leadMs 30000
  h.setClock(100000 + 300000);                    // 5 minutes late
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].opts.resumeOffsetSec, 300, 'seeks in by exactly how late it is');
  assert.equal(h.spawned[0].opts.leadSec, 0, 'no slate when starting mid-video');
  assert.equal(h.spawned[0].opts.slateImage, '');
  h.spawned[0].emit('playing');
  assert.equal(h.sched.getEvents()[0].status, 'playing', 'goes straight to playing, never preshow');
});

test('retry after a LATE start re-seeks to the elapsed point (never restarts the video at 0:00)', async () => {
  const h = harness({ events: [liveEvent()] });     // fireAt 100000, durationSec 600
  h.setClock(100000 + 300000);                       // 5 minutes late
  await h.sched.tick();
  assert.equal(h.spawned[0].opts.resumeOffsetSec, 300, 'first attempt seeks to 5:00');
  h.spawned[0].emit('failed', { reason: 'RTMP handshake blip' });   // fails BEFORE ever playing
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'exactly one retry');
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 300, 'the retry ALSO seeks to 5:00, not back to 0');
  assert.equal(h.spawned[1].opts.leadSec, 0, 'no slate on a late retry');
});

test('construction does NOT rewrite the store when there is nothing to recover (data-loss guard)', () => {
  let saves = 0;
  const store = { load: () => [liveEvent({ id: 'p1', status: 'pending' })], save: () => { saves++; } };
  createScheduler({ store, portal: {}, engineFactory: () => {}, settings: { get: () => ({}) }, now: () => 0, genId: () => 'g' });
  assert.equal(saves, 0, 'a blind boot-time save is exactly what turned a bad load into data loss');
});

test('construction persists exactly once when it recovers an interrupted broadcast', () => {
  let saves = 0;
  const store = { load: () => [liveEvent({ id: 'L', status: 'playing' })], save: () => { saves++; } };
  createScheduler({ store, portal: {}, engineFactory: () => {}, settings: { get: () => ({}) }, now: () => 0, genId: () => 'g' });
  assert.equal(saves, 1, 'one save after marking the interrupted event missed');
});

test('too late: the class would already be over ⇒ missed, no engine spawned, no portal call', async () => {
  const h = harness({ events: [liveEvent()] });   // durationSec 600
  h.setClock(100000 + 600000 + 1000);             // 601s late — past the video's own length
  await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'missed');
  assert.match(ev.outcome, /already be over/i);
});

test('unknown duration (defensive: durationSec 0) falls back to the old 2-minute grace cap', async () => {
  const h = harness({ events: [liveEvent({ durationSec: 0, leadMs: 0 })] });
  h.setClock(100000 + 120000 + 1);                // just past the old GRACE_MS
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

test('shutdown() clears the timer and stops a live encode (no orphaned ffmpeg on quit)', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  assert.equal(h.spawned[0].stopped, false);
  h.sched.shutdown();
  assert.equal(h.spawned[0].stopped, true, 'the live broadcast child is stopped on shutdown');
  h.setClock(80000); await h.sched.tick();
  assert.equal(h.spawned.length, 1, 'shutdown leaves no active broadcast to act on');
});

test('updateEvent: edits an upcoming broadcast and persists', () => {
  const h = harness({ events: [liveEvent({ id: 'u1', title: 'Old', fireAt: 500000, leadMs: 0 })] });
  const r = h.sched.updateEvent('u1', { title: 'New Title', fireAt: 900000, leadMs: 300000, autoStop: false });
  assert.equal(r.ok, true);
  const ev = h.sched.getEvents().find((e) => e.id === 'u1');
  assert.equal(ev.title, 'New Title');
  assert.equal(ev.fireAt, 900000);
  assert.equal(ev.leadMs, 300000);
  assert.equal(ev.autoStop, false);
  assert.equal(ev.status, 'pending');
});

test('updateEvent: refuses the live broadcast, non-pending events, and unknown ids', async () => {
  const h = harness({ events: [liveEvent({ id: 'L' }), liveEvent({ id: 'D', status: 'done', fireAt: 1 }), liveEvent({ id: 'M', status: 'missed', fireAt: 2 })] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  const live = h.sched.updateEvent('L', { title: 'nope' });
  assert.equal(live.ok, false); assert.match(live.error, /stop the live broadcast/i);
  const done = h.sched.updateEvent('D', { title: 'nope' });
  assert.equal(done.ok, false); assert.match(done.error, /only upcoming/i);
  assert.equal(h.sched.updateEvent('M', { title: 'nope' }).ok, false);
  const gone = h.sched.updateEvent('nosuch', { title: 'nope' });
  assert.equal(gone.ok, false); assert.match(gone.error, /not found/i);
});

test('updateEvent: a wire payload cannot inject lifecycle state or steal slot identity', () => {
  const h = harness({ events: [liveEvent({ id: 'u2', slotId: 'weekly-slot', fireAt: 500000 })] });
  h.sched.updateEvent('u2', { title: 'ok', id: 'hijack', slotId: 'stolen', status: 'playing', outcome: 'fake', doneAt: 123 });
  const ev = h.sched.getEvents().find((e) => e.id === 'u2');
  assert.equal(ev.id, 'u2'); assert.equal(ev.slotId, 'weekly-slot');
  assert.equal(ev.status, 'pending'); assert.equal(ev.outcome, ''); assert.equal(ev.doneAt, 0);
  assert.equal(ev.title, 'ok');
});

test('updateEvent: giving an empty weekly slot a video clears needsVideo (and removing it restores)', () => {
  const h = harness({ events: [liveEvent({ id: 'w1', slotId: 's', needsVideo: true, filePath: '', fileName: '', durationSec: 0, fireAt: 500000 })] });
  h.sched.updateEvent('w1', { filePath: '/this-week.mp4', fileName: 'this-week.mp4', durationSec: 1800 });
  let ev = h.sched.getEvents().find((e) => e.id === 'w1');
  assert.equal(ev.needsVideo, false, 'a slot with a video no longer needs one');
  assert.equal(ev.filePath, '/this-week.mp4');
  h.sched.updateEvent('w1', { filePath: '', fileName: '', durationSec: 0 });
  ev = h.sched.getEvents().find((e) => e.id === 'w1');
  assert.equal(ev.needsVideo, true, 'clearing the video makes it wait again');
});

test('updateEvent: refused while the scheduler is busy going live', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ events: [liveEvent({ id: 'b1' })], target: async () => { await gate; return { ok: true, server: 'rtmps://h/app', key: 'KEY', vertical: false }; } });
  h.setClock(70000);
  const ticking = h.sched.tick();
  await new Promise((r) => setImmediate(r));
  const r = h.sched.updateEvent('b1', { title: 'nope' });
  assert.equal(r.ok, false); assert.match(r.error, /busy/i);
  release({ ok: true, server: 'rtmps://h/app', key: 'KEY', vertical: false });
  await ticking;
});

test('addEvent sanitizes lifecycle fields from wire payloads', () => {
  const h = harness({ events: [] });
  const ev = h.sched.addEvent({ title: 'X', filePath: '/v.mp4', durationSec: 1, fireAt: 99, status: 'playing', outcome: 'fake', doneAt: 123, slotId: 'stolen', needsVideo: true });
  assert.equal(ev.status, 'pending'); assert.equal(ev.outcome, ''); assert.equal(ev.doneAt, 0);
  assert.equal(ev.slotId, ''); assert.equal(ev.needsVideo, false);
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

test('removeEvent is refused while the scheduler is busy going live (no ghost engine)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ events: [liveEvent()], target: async () => { await gate; return { ok: true, server: 'rtmps://h/app', key: 'KEY', vertical: false }; } });
  h.setClock(70000);
  const ticking = h.sched.tick();                     // enters goLive, awaits streamTarget (busy=true, active still null)
  await new Promise((r) => setImmediate(r));
  const r = h.sched.removeEvent('e1');
  assert.equal(r.ok, false); assert.match(r.error, /busy/i);
  release({ ok: true, server: 'rtmps://h/app', key: 'KEY', vertical: false });
  await ticking; await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 1, 'exactly one engine, no ghost');
  assert.ok(h.sched.getEvents().find((e) => e.id === 'e1'), 'event still present (remove was refused)');
});

test('a lead with NO slate image does not start the video early (starts at fireAt, leadSec 0)', async () => {
  const h = harness({ events: [liveEvent()], slate: '' });   // leadMs 30000 but no slate image
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned.length, 0, 'must NOT go live 30 min early with no slate');
  h.setClock(100000); await h.sched.tick();
  assert.equal(h.spawned.length, 1, 'goes live at fireAt');
  assert.equal(h.spawned[0].opts.leadSec, 0);
  assert.equal(h.spawned[0].opts.slateImage, '');
});

test('a drop DURING the slate (offset 0) resumes with the slate/lead, not straight into the video', async () => {
  const h = harness({ events: [liveEvent()], offset: 0 });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');                 // verified during slate (before fireAt)
  h.setClock(85000);                            // still before fireAt (100000)
  h.spawned[0].emit('failed', { reason: 'blip during slate' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  assert.ok(h.spawned[1].opts.leadSec > 0, 'resume keeps the remaining lead (video still rolls at fireAt)');
  assert.equal(h.spawned[1].opts.slateImage, 'slate.png', 'slate shown again on the resume');
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 0);
});

test('a slate-phase freeze noticed AFTER fireAt seeks to the elapsed point, not 0:00 (ends on time)', async () => {
  // The stall watchdog can take ~20s to notice a frozen slate, so the resume can
  // land past fireAt. It must seek to the elapsed point (like goLive), not restart
  // the video at 0:00 and end the class late.
  const h = harness({ events: [liveEvent()], offset: 0 });   // fireAt 100000, dur 600, lead 30000
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');                              // verified during the slate
  h.setClock(100000 + 20000);                                // watchdog trips ~20s past fireAt
  h.spawned[0].emit('failed', { reason: 'The broadcast froze — it can be resumed.' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 20, 'seeks to 20s in, not back to 0');
  assert.equal(h.spawned[1].opts.leadSec, 0, 'no slate — the video should already be airing');
  assert.equal(h.spawned[1].opts.slateImage, '');
});

test('scheduler.isSafeToUpdate delegates to the model (live event blocks)', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  const r = h.sched.isSafeToUpdate();
  assert.equal(r.safe, false);
  assert.match(r.reason, /live right now/i);
});

test('scheduler.isSafeToUpdate: safe with an empty/idle schedule', () => {
  const h = harness({ events: [] });
  assert.equal(h.sched.isSafeToUpdate().safe, true);
});

// ---------- local media cache (broadcast from a local copy, not the network drive) ----------

test('go-live uses the locally cached video and slate/music when available, else the original paths', async () => {
  const cached = fakeCache({ e1: '/cache/e1.mp4', 'slate-slate.png': '/cache/slate.png', 'slate-m.mp3': '/cache/m.mp3' });
  const h = harness({ events: [liveEvent()], cache: cached });
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned[0].opts.videoPath, '/cache/e1.mp4', 'plays the local copy');
  assert.equal(h.spawned[0].opts.slateImage, '/cache/slate.png', 'slate from the local copy');
  assert.equal(h.spawned[0].opts.slateMusic, '/cache/m.mp3', 'music from the local copy');

  const none = harness({ events: [liveEvent()], cache: fakeCache({}) });   // nothing cached
  none.setClock(70000); await none.sched.tick();
  assert.equal(none.spawned[0].opts.videoPath, '/v.mp4', 'falls back to the original video path');
  assert.equal(none.spawned[0].opts.slateImage, 'slate.png', 'falls back to the original slate');
});

test('the cache pass copies videos for classes starting within the look-ahead window, and not beyond it', () => {
  const H = 3600000;
  const c = fakeCache();
  const h = harness({ cache: c, events: [
    liveEvent({ id: 'soon', fireAt: 1 * H }),                       // within 24h
    liveEvent({ id: 'far',  fireAt: 48 * H }),                      // beyond 24h
    liveEvent({ id: 'slot', fireAt: 1 * H, filePath: '', needsVideo: true }),   // no video yet
  ] });
  h.setClock(0);
  c.ensured.length = 0;                                             // ignore construction-time pass
  h.sched.cachePass();
  const keys = c.ensured.map(([k]) => k);
  assert.ok(keys.includes('soon'), 'soon is cached');
  assert.ok(!keys.includes('far'), 'far is not cached yet');
  assert.ok(!keys.includes('slot'), 'a slot with no video has nothing to cache');
});

test('the cache pass also keeps the slate picture/music cached', () => {
  const c = fakeCache();
  const h = harness({ cache: c, events: [] });
  h.sched.cachePass();
  const keys = c.ensured.map(([k]) => k);
  assert.ok(keys.includes('slate-slate.png') && keys.includes('slate-m.mp3'));
});

test('finished classes (done/failed/missed) drop out of the keep-set so their local copies are swept', () => {
  const c = fakeCache();
  const h = harness({ cache: c, events: [
    liveEvent({ id: 'P', fireAt: 999999999 }),
    liveEvent({ id: 'D', status: 'done',   doneAt: 1 }),
    liveEvent({ id: 'F', status: 'failed', doneAt: 2 }),
    liveEvent({ id: 'M', status: 'missed', doneAt: 3 }),
  ] });
  h.sched.cachePass();
  const keep = c.swept[c.swept.length - 1];
  assert.ok(keep.has('P'), 'upcoming class kept');
  for (const k of ['D', 'F', 'M']) assert.ok(!keep.has(k), k + ' released');
});

test('a LIVE class keeps its local copy (a mid-class resume must still find the file)', async () => {
  const c = fakeCache();
  const h = harness({ cache: c, events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.sched.cachePass();
  assert.ok(c.swept[c.swept.length - 1].has('e1'));
});

test('removing an upcoming class releases its local copy immediately; scheduling one starts caching it', () => {
  const c = fakeCache();
  const h = harness({ cache: c, events: [] });
  h.setClock(0);
  const ev = h.sched.addEvent({ title: 'New', fireAt: 3600000, filePath: '/x.mp4', durationSec: 1, contentItemGuid: 'ci', scheduleGuid: 'sg' });
  assert.ok(c.ensured.some(([k, s]) => k === ev.id && s === '/x.mp4'), 'caching starts on schedule');
  h.sched.removeEvent(ev.id);
  assert.ok(c.released.includes(ev.id), 'released on remove');
});

test('construction sweeps the cache, keeping only upcoming/live classes', () => {
  const c = fakeCache();
  harness({ cache: c, events: [liveEvent({ id: 'P', fireAt: 999999999 }), liveEvent({ id: 'D', status: 'done', doneAt: 1 })] });
  assert.ok(c.swept.length >= 1, 'swept at construction');
  assert.ok(c.swept[0].has('P') && !c.swept[0].has('D'));
});

test('no cache injected → behaviour is unchanged (original paths, no errors)', async () => {
  const h = harness({ events: [liveEvent()] });   // cache: null
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned[0].opts.videoPath, '/v.mp4');
  assert.doesNotThrow(() => h.sched.cachePass());
});

test('editing a class: changing only its time keeps the local copy; changing its video releases the old copy and caches the new one', () => {
  const c = fakeCache();
  const h = harness({ cache: c, events: [] });
  h.setClock(0);
  const ev = h.sched.addEvent({ title: 'T', fireAt: 3600000, filePath: '/a.mp4', durationSec: 1, contentItemGuid: 'ci', scheduleGuid: 'sg' });
  c.released.length = 0; c.ensured.length = 0;
  h.sched.updateEvent(ev.id, { fireAt: 7200000 });
  assert.deepEqual(c.released, [], 'a time-only edit does not throw away a valid copy');
  h.sched.updateEvent(ev.id, { filePath: '/b.mp4' });
  assert.ok(c.released.includes(ev.id), 'old copy released');
  assert.ok(c.ensured.some(([k, s]) => k === ev.id && s === '/b.mp4'), 'new video cached');
});

test('start() runs the cache pass on its interval; stop() halts it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const c = fakeCache();
  const h = harness({ cache: c, events: [] });
  h.sched.start();
  const before = c.swept.length;
  t.mock.timers.tick(60000);
  assert.ok(c.swept.length > before, 'a pass ran on the interval');
  h.sched.stop();
  const after = c.swept.length;
  t.mock.timers.tick(120000);
  assert.equal(c.swept.length, after, 'no passes after stop');
});

test('mediaPathsForHealth: pending classes resolve to their local copy when cached, else the original; finished classes excluded', () => {
  const c = fakeCache({ e1: '/cache/e1.mp4' });
  const h = harness({ cache: c, events: [
    liveEvent({ id: 'e1', fireAt: 999999999 }),
    liveEvent({ id: 'e2', fireAt: 999999999, filePath: '/net/e2.mp4' }),
    liveEvent({ id: 'd1', status: 'done', doneAt: 1 }),
  ] });
  assert.deepEqual(h.sched.mediaPathsForHealth().sort(), ['/cache/e1.mp4', '/net/e2.mp4']);
});

test('while a class is live FROM THE NETWORK (its copy was not ready), the cache pass does not pull other files off the drive', async () => {
  const H = 3600000;
  const c = fakeCache({});   // nothing cached → goes live from the network path
  const h = harness({ cache: c, events: [liveEvent(), liveEvent({ id: 'later', fireAt: 100000 + 2 * H })] });
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned[0].opts.videoPath, '/v.mp4');
  c.ensured.length = 0;
  h.sched.cachePass();
  assert.ok(!c.ensured.some(([k]) => k === 'later'), 'no competing copies during a network-fed broadcast');
  assert.ok(c.swept.length > 0, 'sweeping still runs');
});

test('while a class is live FROM ITS LOCAL COPY, other classes keep caching', async () => {
  const H = 3600000;
  const c = fakeCache({ e1: '/cache/e1.mp4' });
  const h = harness({ cache: c, events: [liveEvent(), liveEvent({ id: 'later', fireAt: 100000 + 2 * H })] });
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned[0].opts.videoPath, '/cache/e1.mp4');
  c.ensured.length = 0;
  h.sched.cachePass();
  assert.ok(c.ensured.some(([k]) => k === 'later'));
});

// The richer ffmpeg detail added for accurate failure reporting repeats the full
// output URL several times. Redaction must scrub EVERY occurrence, not just the first.
test('key redaction: scrubs the key everywhere in a long multi-line ffmpeg detail', async () => {
  const h = harness({ events: [liveEvent()] });      // target.key === 'KEY', server 'rtmps://h/app'
  const noisy = 'Connection to rtmps://h/app/KEY failed | Cannot open connection rtmps://h/app/KEY | ' +
    'Error opening output rtmps://h/app/KEY: Connection refused | Error opening output files: Connection refused';
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: noisy });
  await new Promise((r) => setImmediate(r));
  h.spawned[1].emit('failed', { reason: noisy });
  await new Promise((r) => setImmediate(r));
  const ev = h.sched.getEvents()[0];
  assert.ok(!ev.outcome.includes('KEY'), 'no key anywhere in the persisted outcome');
  assert.ok(!h.logs.join('\n').includes('KEY'), 'no key anywhere in the logs');
});
