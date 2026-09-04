'use strict';
// A class that goes live BEFORE its local copy finished plays from the drive —
// while the half-done copy keeps pulling the same file over the same drive at
// full speed. Two readers of one file = the broadcast gets a fraction of the
// drive (2026-09-04: steady 20 fps / two-thirds bitrate on a wired i9 PC).
// cancel(key) must stop that copy at once, and must NOT count as a failure.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createVideoCache } = require('../store/video-cache');

function slowSource(chunks = 1000, delayMs = 5) {
  // a read stream that trickles 1KB chunks forever-ish (like a slow network drive)
  let sent = 0; let destroyed = false;
  const rs = new Readable({ read() { if (destroyed) return; setTimeout(() => { if (destroyed) return; if (sent++ < chunks) this.push(Buffer.alloc(1024, 1)); else this.push(null); }, delayMs); } });
  const origDestroy = rs.destroy.bind(rs);
  rs.destroy = (e) => { destroyed = true; return origDestroy(e); };
  return rs;
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-cancel-'));
  const opens = [];
  const cache = createVideoCache({
    dir, log: () => {},
    stat: async () => ({ isFile: () => true, size: 1000 * 1024, mtimeMs: 1 }),
    openRead: (p) => { const rs = slowSource(); opens.push({ p, rs }); return rs; },
    freeSpace: async () => ({ free: 1e12, total: 1e12 }),
    statTimeoutMs: 50,
  });
  return { dir, cache, opens };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('cancel(key) stops an in-flight copy: read stream destroyed, .part removed, no final file', async () => {
  const h = harness();
  h.cache.ensure('e1', '/drive/class.mp4');
  await tick(60);                                     // copy under way
  assert.equal(h.opens.length, 1, 'copy started');
  assert.ok(fs.readdirSync(h.dir).some((n) => n.endsWith('.part')), 'a .part exists mid-copy');
  h.cache.cancel('e1');
  await tick(80);
  assert.ok(h.opens[0].rs.destroyed, 'the read from the drive was stopped');
  assert.ok(!fs.readdirSync(h.dir).some((n) => n.endsWith('.part')), '.part cleaned up');
  assert.equal(h.cache.resolve('e1', '/drive/class.mp4'), null, 'no half file is ever offered as a copy');
});

test('a cancelled copy is not a failure: ensure() starts again immediately (no backoff)', async () => {
  const h = harness();
  h.cache.ensure('e1', '/drive/class.mp4');
  await tick(60);
  h.cache.cancel('e1');
  await tick(80);
  h.cache.ensure('e1', '/drive/class.mp4');
  await tick(60);
  assert.equal(h.opens.length, 2, 'a fresh copy began right away');
  h.cache.cancel('e1'); await tick(50);
});

test('cancel on a key with nothing in flight is a harmless no-op', () => {
  const h = harness();
  assert.doesNotThrow(() => h.cache.cancel('nothing'));
});
