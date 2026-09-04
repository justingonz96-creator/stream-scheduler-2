'use strict';
// 2026-09-04 audit: a transient rename failure (Windows antivirus/indexer holding
// the freshly written file) discarded a whole multi-GB copy. Retry briefly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createVideoCache } = require('../store/video-cache');

function harness(renameFailures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-rename-'));
  const logs = []; let fails = renameFailures; const renames = [];
  const cache = createVideoCache({
    dir, log: (m) => logs.push(m),
    stat: async () => ({ isFile: () => true, size: 3, mtimeMs: 1 }),
    openRead: () => Readable.from([Buffer.from('abc')]),
    freeSpace: async () => ({ free: 1e12, total: 1e12 }),
    rename: (a, b) => { renames.push(1); if (fails-- > 0) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; } fs.renameSync(a, b); },
    sleep: async () => {},
  });
  return { dir, cache, logs, renames };
}

test('a rename that fails twice (file briefly locked) is retried and the copy is kept', async () => {
  const h = harness(2);
  const r = await h.cache.ensure('e1', '/drive/a.mp4');
  assert.ok(r, 'copy succeeded: ' + h.logs.join(' | '));
  assert.equal(h.renames.length, 3);
  assert.ok(h.logs.some((l) => /retry/i.test(l)), 'the retry is logged');
  assert.equal(h.cache.resolve('e1', '/drive/a.mp4'), r);
});
test('a rename that keeps failing gives up (bounded) and the copy is discarded cleanly', async () => {
  const h = harness(99);
  const r = await h.cache.ensure('e1', '/drive/a.mp4');
  assert.equal(r, null);
  assert.ok(h.renames.length >= 3 && h.renames.length <= 8, 'bounded retries: ' + h.renames.length);
  assert.ok(!fs.readdirSync(h.dir).some((n) => n.endsWith('.part')), 'no .part left behind');
});
