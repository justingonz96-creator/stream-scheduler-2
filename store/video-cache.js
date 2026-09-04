'use strict';
// Local copies of the media a broadcast will read. The class videos (and slate
// picture/music) live on a NETWORK DRIVE; a hiccup on that drive mid-class stalls
// or kills the live encode, and the resume path can't help because it can't read
// the file either. So: copy ahead of time, broadcast from the local copy, delete
// it once the class is confirmed finished.
//
// Laws:
//  - ensure() may touch the network (stat + copy) — it is called ahead of time,
//    and a failure just means "no cache" (never an error upward).
//  - resolve() NEVER touches the source — at go-live the drive may be down; a
//    verified local copy (final file + its metadata sidecar) is trusted as-is.
//  - A copy is only ever trusted once its byte count matches the source size and
//    it came from THIS source path; it is written to a .part file and renamed into
//    place, so a half copy (or a copy of a swapped-out file) can never be played.
//  - ONE network operation at a time, and a source stays "in flight" until its
//    raw fs call actually returns — not merely until our timeout fires. A
//    Promise.race can abandon a promise but not the underlying fs call, which
//    stays parked in a libuv threadpool thread until the OS gives up (a hung SMB
//    share: minutes). Firing one per class every pass would park thread after
//    thread and starve DNS/health/go-live. Serial + raw-settle bounds the damage
//    to a single thread, and a failing source backs off instead of being hammered.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GB = 1024 ** 3;

function createVideoCache({
  dir, log = () => {}, now = () => Date.now(),
  stat = (p) => fs.promises.stat(p),
  openRead = (p) => fs.createReadStream(p),
  freeSpace = defaultFreeSpace,        // → { free, total } bytes (a bare number = free)
  statTimeoutMs = 4000,                // how long ensure() makes a CALLER wait before answering "not ready" (the raw op keeps going)
  copyIdleTimeoutMs = 60000,           // no bytes for this long mid-copy = stalled drive
  minFreeMarginBytes = 2 * GB,         // keep at least this much free (or 10% of the volume, whichever is larger)
  maxCacheBytes = 30 * GB,             // total size the cache may grow to
  backoffBaseMs = 60000, backoffMaxMs = 15 * 60000,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // Nothing is in flight at construction: any .part is a crash leftover.
  for (const n of safeReaddir(dir)) if (n.endsWith('.part')) rm(path.join(dir, n));

  let queue = Promise.resolve();       // the serial network lane
  const inflight = new Map();          // key → { src, raw, bounded }  (raw = settles when the fs work truly ends)
  const cancelers = new Map();         // key → () => abort the copy in progress (see cancel)
  const backoff = new Map();           // key → { src, fails, nextAt }

  const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_-]/g, '_');
  const finalPath = (key, src) => path.join(dir, safeKey(key) + (path.extname(src) || '.dat'));
  const metaPath = (f) => f + '.meta.json';
  const partPath = (f) => f + '.part';
  const readMeta = (f) => { try { return JSON.parse(fs.readFileSync(metaPath(f), 'utf8')); } catch { return null; } };

  function keyForPath(p) { return 'slate-' + crypto.createHash('md5').update(String(p)).digest('hex').slice(0, 16); }

  // Go-live lookup. Trusts a verified copy of THIS source without consulting the
  // (possibly unreachable) source. Staleness is handled by ensure(), ahead of time.
  function resolve(key, src) {
    const f = finalPath(key, src);
    if (!fs.existsSync(f)) return null;
    const meta = readMeta(f);
    return (meta && meta.src === src) ? f : null;   // a copy of a DIFFERENT file under this key is never played
  }

  function copyWithIdleTimeout(src, dest, key) {
    return new Promise((res, rej) => {
      const rs = openRead(src);
      const ws = fs.createWriteStream(dest);
      let timer = null;
      const fail = (e) => { clearTimeout(timer); cancelers.delete(key); try { rs.destroy(); } catch {} try { ws.destroy(); } catch {} rej(e); };
      cancelers.set(key, () => fail(Object.assign(new Error('cancelled'), { cancelled: true })));
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('copy stalled — no data for ' + Math.round(copyIdleTimeoutMs / 1000) + 's')), copyIdleTimeoutMs); };
      rs.on('data', arm);
      rs.on('error', fail);
      ws.on('error', fail);
      // Settle on 'close' (handle released), not 'finish': on Windows an
      // antivirus/indexer can still hold the fresh file at 'finish' and make the
      // rename fail — wasting a multi-GB copy.
      ws.on('close', () => { clearTimeout(timer); cancelers.delete(key); if (ws.writableFinished) res(); else rej(new Error('write stream closed before finishing')); });
      arm();
      rs.pipe(ws);
    });
  }

  function cacheBytes() {
    let total = 0;
    for (const n of safeReaddir(dir)) {
      if (n.endsWith('.meta.json')) continue;
      try { total += fs.statSync(path.join(dir, n)).size; } catch { /* vanished */ }
    }
    return total;
  }

  // The raw work for one (key, src). Awaits the REAL stat — no artificial timeout
  // here, on purpose: this runs on the serial lane, so a hung source blocks only
  // this one lane (one thread) rather than parking a fresh thread every pass.
  const CANCELLED = Symbol('cancelled');   // a stopped copy is not a failure: no backoff, retry freely
  async function doEnsure(key, src) {
    const f = finalPath(key, src);
    let st;
    try { st = await stat(src); }
    catch (e) { log('cache: source unreachable (' + ((e && e.message) || e) + '): ' + src); return null; }
    if (!st || (typeof st.isFile === 'function' && !st.isFile())) { log('cache: not a file: ' + src); return null; }

    const meta = resolve(key, src) ? readMeta(f) : null;
    if (meta && meta.src === src && meta.size === st.size && meta.mtimeMs === st.mtimeMs) return f;   // already have THIS version

    // The source is REACHABLE and whatever sits under this key is not a copy of
    // it (re-exported to the same path, a swapped file, or an orphan). Discard it
    // NOW: if the refresh below can't complete, the class must fall back to the
    // network path — which holds the CURRENT video — rather than play a stale
    // copy. (When the source is unreachable we never get here and an existing
    // copy is kept: stale beats nothing.)
    if (fs.existsSync(f)) {
      rm(f); rm(metaPath(f));
      if (meta) log('cache: ' + path.basename(src) + ' changed on the drive — old copy discarded');
    }

    let free = Infinity, total = 0;
    try { const r = await freeSpace(dir); if (typeof r === 'number') free = r; else if (r) { free = r.free; total = r.total || 0; } } catch { /* unknown → don't block */ }
    const margin = Math.max(minFreeMarginBytes, Math.floor(total * 0.10));
    if (free < st.size + margin) {
      log('cache: not enough free disk space for ' + path.basename(src) + ' (need ' + st.size + ' + ' + margin + ' margin, free ' + free + ') — will play from the original location');
      return null;
    }
    if (cacheBytes() + st.size > maxCacheBytes) {
      log('cache: cache is full (cap ' + maxCacheBytes + ' bytes) — ' + path.basename(src) + ' will play from the original location');
      return null;
    }

    const part = partPath(f);
    rm(part);
    try {
      await copyWithIdleTimeout(src, part, key);
      const got = fs.statSync(part).size;
      if (got !== st.size) throw new Error('short copy: got ' + got + ' of ' + st.size + ' bytes');
      // The source may have been mid-write on the share (the content team still
      // copying it in): confirm it did not change underneath us. If it vanished
      // after the copy, keep what we verified byte-for-byte.
      let after = null;
      try { after = await stat(src); } catch { /* gone → keep the verified copy */ }
      if (after && (after.size !== st.size || after.mtimeMs !== st.mtimeMs)) throw new Error('source changed during the copy (still being written?)');
      fs.renameSync(part, f);
      fs.writeFileSync(metaPath(f), JSON.stringify({ src, size: st.size, mtimeMs: st.mtimeMs, cachedAt: Date.now() }));
      log('cache: ready ' + path.basename(src) + ' (' + st.size + ' bytes)');
      return f;
    } catch (e) {
      rm(part);
      if (e && e.cancelled) { log('cache: copy of ' + path.basename(src) + ' stopped — the class is playing from the drive now'); return CANCELLED; }
      log('cache: copy failed for ' + path.basename(src) + ': ' + ((e && e.message) || e));
      return null;
    }
  }

  function recordFailure(key, src) {
    const prev = backoff.get(key);
    const fails = (prev && prev.src === src) ? prev.fails + 1 : 1;
    const wait = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (fails - 1));
    backoff.set(key, { src, fails, nextAt: now() + wait });
  }

  // Idempotent + de-duplicated; serial; caller never waits longer than statTimeoutMs.
  //  - same key & source already in flight → share it
  //  - a DIFFERENT source under the same key (video swapped mid-copy) → queue
  //    behind the old copy (they'd write the same .part); the old copy is then
  //    rejected by the meta.src check and re-copied from the new source
  //  - a recently failed source is skipped until its backoff expires
  function ensure(key, src) {
    if (!src) return Promise.resolve(null);
    const b = backoff.get(key);
    if (b && b.src === src && now() < b.nextAt) return Promise.resolve(null);
    const cur = inflight.get(key);
    if (cur && cur.src === src) return cur.bounded;

    const entry = { src, raw: null, bounded: null, cancelled: false };
    const raw = queue.then(() => doEnsure(key, src)).then((r) => { if (r === CANCELLED) { entry.cancelled = true; return null; } return r; }, (e) => { log('cache: unexpected error: ' + ((e && e.message) || e)); return null; });
    queue = raw.then(() => {}, () => {});
    let timer = null;
    const bounded = Promise.race([
      raw.then((r) => { clearTimeout(timer); return r; }),
      new Promise((res) => { timer = setTimeout(() => { log('cache: ' + path.basename(src) + ' is not ready yet — timed out waiting for the source (slow or not responding); a class starting now would play from the original location'); res(null); }, statTimeoutMs); }),
    ]);
    entry.raw = raw; entry.bounded = bounded;
    inflight.set(key, entry);
    raw.then((res) => {
      if (res) backoff.delete(key); else if (!entry.cancelled) recordFailure(key, src);
      if (inflight.get(key) === entry) inflight.delete(key);
    });
    return bounded;
  }

  function filesForKey(key) {
    const prefix = safeKey(key) + '.';
    return safeReaddir(dir).filter((n) => n.startsWith(prefix)).map((n) => path.join(dir, n));
  }

  // Stop a copy in progress for this key (the class just went live from the
  // drive; a competing full-speed read of the same file would starve it). The
  // .part is removed by the copy's own cleanup. No-op when nothing is copying.
  function cancel(key) { const c = cancelers.get(key); if (c) c(); }

  function release(key) { cancel(key); for (const p of filesForKey(key)) rm(p); backoff.delete(key); }

  // Orphan cleanup: anything not belonging to a kept key goes. (A kept key's
  // .part is left alone — it may be a copy in progress.)
  function sweep(keepKeys) {
    const keep = new Set([...keepKeys].map(safeKey));
    for (const n of safeReaddir(dir)) {
      const key = n.split('.')[0];
      if (!keep.has(key)) rm(path.join(dir, n));
    }
  }

  return { ensure, resolve, release, cancel, sweep, keyForPath, dir };
}

function rm(p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

async function defaultFreeSpace(dir) {
  if (typeof fs.promises.statfs !== 'function') return { free: Infinity, total: 0 };   // older Node: don't block caching
  const s = await fs.promises.statfs(dir);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

module.exports = { createVideoCache };
