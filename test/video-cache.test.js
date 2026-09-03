'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createVideoCache } = require('../store/video-cache');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-vcache-')); }
function writeSrc(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}
function mk(over = {}) {
  const dir = path.join(tmpdir(), 'video-cache');
  const logs = [];
  const cache = createVideoCache(Object.assign({ dir, log: (m) => logs.push(m), freeSpace: async () => 10 * 1024 ** 3 }, over));
  return { cache, dir, logs };
}

test('ensure copies the source into the cache, verifies it, and resolve then returns the local copy', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 5000);
  const { cache, dir } = mk();
  assert.equal(cache.resolve('ev1', src), null, 'nothing cached yet');
  const got = await cache.ensure('ev1', src);
  assert.ok(got && got.startsWith(dir), 'returns a path inside the cache dir');
  assert.ok(got.endsWith('.mp4'), 'keeps the source extension so ffmpeg can detect the format');
  assert.equal(fs.statSync(got).size, 5000, 'full copy');
  assert.equal(cache.resolve('ev1', src), got, 'resolve now finds the verified copy');
  assert.equal(fs.existsSync(got + '.part'), false, 'no temp file left behind');
});

test('resolve never touches the source: it still returns the cached copy after the source is gone (network drive down)', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 1200);
  const { cache } = mk();
  const got = await cache.ensure('ev1', src);
  fs.unlinkSync(src);                       // the drive "disappears"
  assert.equal(cache.resolve('ev1', src), got, 'go-live can still use the local copy');
});

test('a second ensure is a no-op when the cache is valid, and re-copies when the source changed', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 3000);
  const { cache } = mk();
  const a = await cache.ensure('ev1', src);
  const mtimeA = fs.statSync(a).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const b = await cache.ensure('ev1', src);
  assert.equal(b, a);
  assert.equal(fs.statSync(b).mtimeMs, mtimeA, 'not re-copied when nothing changed');
  // source replaced by a different file (different size) → stale → re-copy
  fs.writeFileSync(src, Buffer.alloc(4444, 1));
  const c = await cache.ensure('ev1', src);
  assert.equal(fs.statSync(c).size, 4444, 're-copied the new source');
});

test('concurrent ensure calls for the same key share one copy (no duplicate work)', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 2000);
  const { cache } = mk();
  const [a, b, c] = await Promise.all([cache.ensure('ev1', src), cache.ensure('ev1', src), cache.ensure('ev1', src)]);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(fs.statSync(a).size, 2000);
});

test('release deletes the cached copy (and its metadata); resolve returns null afterwards', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 1000);
  const { cache, dir } = mk();
  await cache.ensure('ev1', src);
  assert.ok(fs.readdirSync(dir).length > 0);
  cache.release('ev1');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('ev1.')), [], 'all ev1.* files gone');
  assert.equal(cache.resolve('ev1', src), null);
});

test('release of a key that shares a prefix with another key only removes its own files', async () => {
  const srcDir = tmpdir();
  const s1 = writeSrc(srcDir, 'a.mp4', 100);
  const s2 = writeSrc(srcDir, 'b.mp4', 100);
  const { cache } = mk();
  await cache.ensure('ev1', s1);
  await cache.ensure('ev10', s2);            // "ev10" starts with "ev1"
  cache.release('ev1');
  assert.equal(cache.resolve('ev1', s1), null);
  assert.ok(cache.resolve('ev10', s2), 'ev10 untouched');
});

test('sweep removes every cached file whose key is not in the keep-set (crash/orphan cleanup)', async () => {
  const srcDir = tmpdir();
  const s1 = writeSrc(srcDir, 'a.mp4', 100);
  const s2 = writeSrc(srcDir, 'b.mp4', 100);
  const { cache, dir } = mk();
  await cache.ensure('keep', s1);
  await cache.ensure('gone', s2);
  fs.writeFileSync(path.join(dir, 'stray.mp4.part'), 'x');   // a crash left a partial
  cache.sweep(new Set(['keep']));
  const left = fs.readdirSync(dir);
  assert.ok(left.every((f) => f.startsWith('keep.')), 'only keep.* remain: ' + left.join(','));
});

test('an unreachable source (stat times out) is skipped — returns null, no exception, nothing left in the cache', async () => {
  const { cache, dir, logs } = mk({ statTimeoutMs: 30, stat: () => new Promise(() => {}) });   // never resolves
  const got = await cache.ensure('ev1', '/some/network/drive/class.mp4');
  assert.equal(got, null);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(logs.some((l) => /unreachable|timed out/i.test(l)));
});

test('insufficient free disk space skips the copy (falls back to the network path) rather than filling the disk', async () => {
  const srcDir = tmpdir();
  const src = writeSrc(srcDir, 'class.mp4', 5000);
  const { cache, dir, logs } = mk({ freeSpace: async () => 100 });   // 100 bytes free
  const got = await cache.ensure('ev1', src);
  assert.equal(got, null);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(logs.some((l) => /disk space/i.test(l)));
});

test('a copy that stalls (no bytes for the idle window) is abandoned and its partial file removed', { timeout: 2000 }, async () => {
  const { Readable } = require('node:stream');
  const { cache, dir } = mk({
    copyIdleTimeoutMs: 40,
    stat: async () => ({ size: 999999, mtimeMs: 1, isFile: () => true }),
    openRead: () => new Readable({ read() { /* never pushes → stalls */ } }),
  });
  const got = await cache.ensure('ev1', '/net/class.mp4');
  assert.equal(got, null);
  assert.deepEqual(fs.readdirSync(dir), [], 'partial cleaned up');
});

test('a copy whose byte count does not match the source size is rejected (never trust a short copy)', async () => {
  const { Readable } = require('node:stream');
  const { cache, dir } = mk({
    stat: async () => ({ size: 1000, mtimeMs: 1, isFile: () => true }),
    openRead: () => Readable.from([Buffer.alloc(300)]),   // only 300 of the promised 1000 bytes
  });
  const got = await cache.ensure('ev1', '/net/class.mp4');
  assert.equal(got, null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('keyForPath is stable and filesystem-safe (used for slate files)', () => {
  const { cache } = mk();
  const k1 = cache.keyForPath('G:\\MIA Videos\\slate.png');
  const k2 = cache.keyForPath('G:\\MIA Videos\\slate.png');
  const k3 = cache.keyForPath('G:\\MIA Videos\\other.png');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^[A-Za-z0-9_-]+$/);
});

// ---------- review-driven proofs ----------

test('resolve() never consults the source (a hung drive must not block go-live)', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 500);
  let stats = 0;
  const { cache } = mk({ stat: (p) => { stats++; return fs.promises.stat(p); } });
  const got = await cache.ensure('ev1', src);
  const after = stats;
  assert.equal(cache.resolve('ev1', src), got);
  assert.equal(cache.resolve('ev1', '/dead/drive/c.mp4'), null, 'a copy is only trusted for the exact source it came from');
  assert.equal(stats, after, 'resolve issued zero stat calls');
});

test('a copy missing its metadata sidecar (crash between rename and meta write) is refused, then re-copied', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 700);
  const { cache, dir } = mk();
  fs.writeFileSync(path.join(dir, 'ev1.mp4'), Buffer.alloc(700));   // orphan final, no .meta.json
  assert.equal(cache.resolve('ev1', src), null);
  const got = await cache.ensure('ev1', src);
  assert.ok(got && fs.existsSync(got + '.meta.json'), 're-copied with its sidecar');
});

test('staleness: a changed mtime alone (same size) and a changed size alone (mtime pinned) each trigger a re-copy', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 3000);
  let opens = 0;
  const { cache } = mk({ openRead: (p) => { opens++; return fs.createReadStream(p); } });
  const f = await cache.ensure('ev1', src); assert.equal(opens, 1);
  await cache.ensure('ev1', src); assert.equal(opens, 1, 'unchanged source → exactly one open, no re-copy');
  const meta = () => JSON.parse(fs.readFileSync(f + '.meta.json', 'utf8'));
  // same size, new content, mtime forced forward
  fs.writeFileSync(src, Buffer.alloc(3000, 2));
  fs.utimesSync(src, new Date(), new Date(meta().mtimeMs + 5000));
  await cache.ensure('ev1', src);
  assert.equal(opens, 2, 'mtime change alone re-copies');
  assert.equal(fs.readFileSync(f)[0], 2, 'cached content is the new version');
  // different size, mtime pinned back to the recorded value
  const m = meta();
  fs.writeFileSync(src, Buffer.alloc(4000, 3));
  fs.utimesSync(src, new Date(), new Date(m.mtimeMs));
  await cache.ensure('ev1', src);
  assert.equal(opens, 3, 'size change alone re-copies');
});

test('a slow-but-alive copy (bytes keep trickling) is NOT abandoned — the idle timer resets on data', { timeout: 5000 }, async () => {
  const { Readable } = require('node:stream');
  const SIZE = 10 * 64;
  const { cache } = mk({
    copyIdleTimeoutMs: 40,
    stat: async () => ({ size: SIZE, mtimeMs: 1, isFile: () => true }),
    openRead: () => { let sent = 0; return new Readable({ read() {
      if (this._busy) return;
      if (sent >= SIZE) { this.push(null); return; }
      this._busy = true;
      setTimeout(() => { this._busy = false; sent += 64; this.push(Buffer.alloc(64, 1)); }, 15);   // 15ms gaps < 40ms idle
    } }); },
  });
  const got = await cache.ensure('ev1', '/net/c.mp4');
  assert.ok(got, 'completed despite each chunk arriving slowly');
  assert.equal(fs.statSync(got).size, SIZE);
});

test('swapping a class to a different video while the old copy is in flight never plays the old file', { timeout: 5000 }, async () => {
  const { Readable } = require('node:stream');
  const srcDir = tmpdir();
  const A = path.join(srcDir, 'A.mp4'); fs.writeFileSync(A, Buffer.alloc(640, 0x41));
  const B = path.join(srcDir, 'B.mp4'); fs.writeFileSync(B, Buffer.alloc(640, 0x42));
  const slow = () => { let sent = 0; return new Readable({ read() {
    if (this._b) return; if (sent >= 640) { this.push(null); return; }
    this._b = true; setTimeout(() => { this._b = false; sent += 64; this.push(Buffer.alloc(64, 0x41)); }, 10);
  } }); };
  const { cache } = mk({ openRead: (p) => (p.endsWith('A.mp4') ? slow() : fs.createReadStream(p)) });
  const pA = cache.ensure('ev', A);          // slow copy of A in flight
  cache.release('ev');                       // operator swaps the class's video
  const pB = cache.ensure('ev', B);          // queued behind A (they'd share the .part file)
  const gotB = await pB;
  assert.ok(gotB, 'B is cached');
  assert.equal(fs.readFileSync(gotB)[0], 0x42, 'the local copy is B, never A');
  assert.equal(cache.resolve('ev', A), null, 'A can no longer be resolved under this key');
  await pA;
});

test('network operations run ONE at a time (a hung source can park at most one worker thread)', async () => {
  let concurrent = 0, peak = 0;
  const srcDir = tmpdir();
  const files = ['a', 'b', 'c'].map((n) => writeSrc(srcDir, n + '.mp4', 200));
  const { cache } = mk({ stat: async (p) => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 20)); concurrent--; return fs.promises.stat(p); } });
  await Promise.all(files.map((f, i) => cache.ensure('k' + i, f)));
  assert.equal(peak, 1, 'never more than one stat in flight');
});

test('a hung source: ensure() answers promptly, the source stays in flight until the raw call returns (no duplicate call), then backs off — and retries once the backoff expires', { timeout: 5000 }, async () => {
  let T = 1000;
  let stats = 0; let reject;
  const hung = new Promise((_, rej) => { reject = rej; });
  const { cache, logs } = mk({ now: () => T, statTimeoutMs: 30, backoffBaseMs: 60000, stat: () => { stats++; return stats === 1 ? hung : Promise.reject(new Error('still down')); } });
  const t0 = Date.now();
  assert.equal(await cache.ensure('ev1', '/net/c.mp4'), null);
  assert.ok(Date.now() - t0 < 1000, 'the caller is not blocked by the hung call');
  assert.ok(logs.some((l) => /timed out/i.test(l)));
  assert.equal(await cache.ensure('ev1', '/net/c.mp4'), null);
  assert.equal(stats, 1, 'while parked, the same source is NOT called again');
  reject(new Error('ENOENT'));                       // the OS finally gives up
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await cache.ensure('ev1', '/net/c.mp4'), null);
  assert.equal(stats, 1, 'now in backoff: still no new call');
  T += 61000;                                         // backoff expired
  assert.equal(await cache.ensure('ev1', '/net/c.mp4'), null);
  assert.equal(stats, 2, 'retried once the backoff expired');
});

test('construction purges crash-leftover .part files', () => {
  const d = path.join(tmpdir(), 'video-cache'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'ev9.mp4.part'), 'x');
  createVideoCache({ dir: d });
  assert.deepEqual(fs.readdirSync(d), []);
});

test('a source re-exported to the same path whose refresh FAILS is never served stale — the old copy is discarded so go-live falls back to the current file', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 1000);
  let free = 10 * 1024 ** 3;
  const { cache, logs } = mk({ freeSpace: async () => free });
  const f = await cache.ensure('ev1', src);
  assert.equal(cache.resolve('ev1', src), f);
  fs.writeFileSync(src, Buffer.alloc(2000, 9));       // re-exported: new size
  free = 100;                                          // ...and the refresh cannot complete
  assert.equal(await cache.ensure('ev1', src), null);
  assert.equal(cache.resolve('ev1', src), null, 'stale copy discarded — go-live uses the network path (the current video)');
  assert.ok(logs.some((l) => /old copy discarded/i.test(l)));
});

test('but when the source is UNREACHABLE the existing copy is kept (stale beats nothing)', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 1000);
  let down = false;
  const { cache } = mk({ stat: (p) => (down ? Promise.reject(new Error('EHOSTDOWN')) : fs.promises.stat(p)) });
  const f = await cache.ensure('ev1', src);
  down = true;
  assert.equal(await cache.ensure('ev1', src), null);
  assert.equal(cache.resolve('ev1', src), f, 'copy kept while the drive is down');
});

test('a source still being written to the drive (it changes during the copy) is rejected, never cached truncated', async () => {
  const srcDir = tmpdir(); const src = writeSrc(srcDir, 'c.mp4', 1000);
  let calls = 0;
  const { cache, dir } = mk({ stat: (p) => { calls++; if (calls === 2) fs.writeFileSync(src, Buffer.alloc(1500, 1)); return fs.promises.stat(p); } });   // grows between the pre- and post-copy checks
  assert.equal(await cache.ensure('ev1', src), null);
  assert.equal(cache.resolve('ev1', src), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});
