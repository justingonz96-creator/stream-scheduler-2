'use strict';
// End-to-end (minus ffmpeg): a REAL cache + a REAL scheduler. The class video is
// copied ahead of time; then the source "drive" disappears; go-live must still
// spawn the engine on the verified local copy.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');
const { createVideoCache } = require('../store/video-cache');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-cint-')); }

test('go-live plays from the local copy after the source file has vanished (network drive down)', async () => {
  const srcDir = tmp();
  const src = path.join(srcDir, 'class.mp4');
  fs.writeFileSync(src, Buffer.alloc(64 * 1024, 3));
  const slate = path.join(srcDir, 'slate.png'); fs.writeFileSync(slate, Buffer.alloc(2048, 9));
  const music = path.join(srcDir, 'music.mp3'); fs.writeFileSync(music, Buffer.alloc(4096, 5));

  const cache = createVideoCache({ dir: path.join(tmp(), 'video-cache'), freeSpace: async () => 1e12 });
  const spawned = [];
  let clock = 0;
  const sched = createScheduler({
    store: { load: () => [], save: () => {} },
    portal: { streamTarget: async () => ({ ok: true, server: 'rtmps://h/app', key: 'K', vertical: false }), endBroadcast: async () => ({ ok: true }) },
    engineFactory: (opts) => { const e = new EventEmitter(); e.opts = opts; e.start = () => {}; e.stop = () => {}; e.videoOffsetSec = () => 0; spawned.push(e); return e; },
    settings: { get: () => ({ slateImage: slate, slateImageVertical: '', slateMusic: music, fadeMs: 1000, videoBitrate: 6000 }) },
    cache, now: () => clock, genId: () => 'ev1',
  });

  const ev = sched.addEvent({ title: 'T', fireAt: 3600000, leadMs: 300000, filePath: src, durationSec: 60, contentItemGuid: 'ci', scheduleGuid: 'sg' });
  // addEvent kicked off the copies; wait for them to land.
  const cachedVideo = await cache.ensure(cache.keyForPath(src), src);   // copies are keyed by FILE (shared between classes)
  await cache.ensure(cache.keyForPath(slate), slate);
  await cache.ensure(cache.keyForPath(music), music);
  assert.ok(cachedVideo && fs.existsSync(cachedVideo), 'video copied locally');
  assert.equal(fs.statSync(cachedVideo).size, 64 * 1024);

  // The drive goes away.
  fs.rmSync(srcDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(src), false);

  clock = 3600000 - 300000;   // streamAt (fireAt − lead)
  await sched.tick();
  assert.equal(spawned.length, 1, 'went live');
  const o = spawned[0].opts;
  assert.equal(o.videoPath, cachedVideo, 'engine reads the LOCAL copy, not the vanished source');
  assert.ok(o.slateImage.startsWith(cache.dir) && fs.existsSync(o.slateImage), 'slate from the local copy');
  assert.ok(o.slateMusic.startsWith(cache.dir) && fs.existsSync(o.slateMusic), 'music from the local copy');

  // A cache pass while LIVE must not touch the copy.
  sched.cachePass();
  assert.ok(fs.existsSync(cachedVideo), 'the live copy survives a cache pass');

  // A mid-class drop resumes from the LOCAL copy too.
  spawned[0].emit('playing');
  spawned[0].emit('failed', { reason: 'blip' });
  await new Promise((r) => setImmediate(r));
  assert.equal(spawned.length, 2, 'resumed');
  assert.equal(spawned[1].opts.videoPath, cachedVideo, 'the resume reads the local copy');

  // Finish the class → the next cache pass sweeps the copy.
  spawned[1].emit('playing'); spawned[1].emit('ended');
  await new Promise((r) => setImmediate(r));
  assert.equal(sched.getEvents()[0].status, 'done');
  sched.cachePass();
  assert.equal(fs.existsSync(cachedVideo), false, 'local copy released once the class is confirmed done');
  assert.ok(fs.existsSync(o.slateImage), 'slate files are kept (they are reused by every class)');
});
