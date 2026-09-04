'use strict';
// 2026-09-04 audit, scheduler/portal batch 2.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');
const { recentFailures } = require('../renderer/format');

function fakeEngine() { const e = new EventEmitter(); e.start = () => {}; e.stop = async () => {}; e.videoOffsetSec = () => 0; e.speedStats = () => ({ samples: 0 }); return e; }
function fakeCache(resolved = {}) {
  const c = { ensured: [], released: [], resolved };
  c.resolve = (key) => c.resolved[key] || null; c.ensure = async (key, src) => { c.ensured.push(key); return c.resolved[key] || null; };
  c.release = (key) => c.released.push(key); c.sweep = () => {}; c.cancel = () => {}; c.keyForPath = (p) => 'path-' + p;
  return c;
}
function harness(events, { probe, cache = null, endResult = { ok: true }, target } = {}) {
  const spawned = []; const logs = [];
  let data = events.map((e) => ({ ...e })); let t = 1500;
  const sched = createScheduler({
    store: { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); } },
    portal: { streamTarget: async () => target || { ok: true, server: 'rtmps://h/app', key: 'K', secure: true }, endBroadcast: async () => endResult },
    engineFactory: (opts) => { const e = fakeEngine(); e.opts = opts; spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: '', slateMusic: '', fadeMs: 0, videoBitrate: 4500 }) },
    cache, probeFile: probe, now: () => t, genId: () => 'g', log: (m) => logs.push(m),
  });
  return { sched, spawned, logs, cache, setClock: (v) => { t = v; }, ev: (id) => sched.getEvents().find((e) => e.id === id) };
}
const cls = (over = {}) => ({ id: 'e1', filePath: '/drive/a.mp4', fileName: 'a.mp4', fireAt: 1000, durationSec: 1200, status: 'pending', autoStop: true, contentItemGuid: 'c1', ...over });
const settle = () => new Promise((r) => setImmediate(r));

// (9) a re-exported file was never re-validated before air
test('goLive re-probes the video: a file that is now unreadable/silent fails with the probe reason, never reaching the engine', async () => {
  const h = harness([cls()], { probe: async () => ({ ok: false, error: 'This video has no sound.' }) });
  await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.ev('e1').status, 'failed'); assert.match(h.ev('e1').outcome, /no sound/);
});
test('goLive re-probe refreshes duration and frame rate and hands the frame rate to the engine', async () => {
  const h = harness([cls({ durationSec: 1200 })], { probe: async () => ({ ok: true, durationSec: 1230, width: 1920, height: 1080, fps: 29.97, hasAudio: true }) });
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.ev('e1').durationSec, 1230);
  assert.ok(Math.abs(h.spawned[0].opts.fps - 29.97) < 0.01, 'fps passed: ' + h.spawned[0].opts.fps);
});
test('a probe that cannot run (throws) does not block the class — it airs with what it knows', async () => {
  const h = harness([cls()], { probe: async () => { throw new Error('ffprobe missing'); } });
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
});

// (29) the outcome said "the stream ended" even when the portal never confirmed it
test('the outcome says when the portal did NOT confirm the end', async () => {
  const h = harness([cls()], { probe: async () => ({ ok: true, durationSec: 1200, fps: 30, hasAudio: true }), endResult: { ok: false, status: 500 } });
  await h.sched.tick(); h.spawned[0].emit('playing'); h.spawned[0].emit('ended'); await settle();
  assert.match(h.ev('e1').outcome, /portal (did not|could not) confirm/i);
});

// (20) a station with only a plain rtmp address streamed the key unencrypted, silently
test('an unencrypted (plain rtmp) studio address is logged and noted on the class', async () => {
  const h = harness([cls()], { probe: async () => ({ ok: true, durationSec: 1200, fps: 30, hasAudio: true }), target: { ok: true, server: 'rtmp://h:1935/app', key: 'K' } });
  await h.sched.tick();
  assert.ok(h.logs.some((l) => /unencrypted/i.test(l)), h.logs.join('|'));
  assert.equal(h.ev('e1').unencrypted, true);
});

// (36) copies were keyed per scheduled event, so the same file scheduled twice was copied twice
test('the cache is keyed by the video file, so two classes with the same file share one copy', async () => {
  const cache = fakeCache();
  const h = harness([cls({ id: 'a', fireAt: 5000 }), cls({ id: 'b', fireAt: 9000 })], { cache });
  await settle();
  assert.deepEqual([...new Set(cache.ensured)], ['path-/drive/a.mp4']);
});
test('removing one of two classes sharing a file does NOT release the shared copy; removing the last one does', async () => {
  const cache = fakeCache();
  const h = harness([cls({ id: 'a', fireAt: 5000 }), cls({ id: 'b', fireAt: 9000 })], { cache });
  h.sched.removeEvent('a');
  assert.deepEqual(cache.released, [], 'still needed by b');
  h.sched.removeEvent('b');
  assert.deepEqual(cache.released, ['path-/drive/a.mp4']);
});
test('the live broadcast resolves its file by the path key', async () => {
  const cache = fakeCache({ 'path-/drive/a.mp4': '/local/a.mp4' });
  const h = harness([cls()], { cache, probe: async () => ({ ok: true, durationSec: 1200, fps: 30, hasAudio: true }) });
  await h.sched.tick();
  assert.equal(h.spawned[0].opts.videoPath, '/local/a.mp4');
  assert.equal(h.ev('e1').playedFrom, 'local copy');
});

// (35) the operator could not tell before air whether a class would depend on the drive
test('upcoming classes carry a cacheStatus the UI can show (ready / not yet)', async () => {
  const cache = fakeCache({ 'path-/drive/a.mp4': '/local/a.mp4' });
  const h = harness([cls({ id: 'a', fireAt: 5000 }), cls({ id: 'b', fireAt: 9000, filePath: '/drive/b.mp4' })], { cache });
  await settle();
  assert.equal(h.ev('a').cacheStatus, 'ready');
  assert.equal(h.ev('b').cacheStatus, 'pending');
});

// (32) a crash-recovered "Interrupted" class was invisible to the alert (a timing race)
test('recentFailures surfaces a fresh Interrupted class even if it happened before the window opened', () => {
  const sessionStart = 100000;
  const fails = recentFailures([{ id: 'x', status: 'missed', outcome: 'Interrupted — the app was closed during the broadcast', doneAt: sessionStart - 5000 }], sessionStart, new Set());
  assert.equal(fails.length, 1);
  const old = recentFailures([{ id: 'y', status: 'missed', outcome: 'Interrupted — the app was closed during the broadcast', doneAt: sessionStart - 2 * 24 * 3600 * 1000 }], sessionStart, new Set());
  assert.equal(old.length, 0, 'but not one from days ago');
});
