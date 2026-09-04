'use strict';
// Guard: every element the renderer reaches for must exist in the markup.
// A missing id is invisible until the moment that code path runs — during the
// 2026-09-04 audit fixes, two new controls were wired in app.js while the HTML
// edit silently failed, which would have thrown the first time Setup opened.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('every $("id") in app.js exists in index.html', () => {
  const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 20, 'sanity: found ' + ids.length + ' ids');
  const missing = ids.filter((id) => !html.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], 'ids referenced by the renderer but absent from the markup');
});

test('every id in the markup is unique', () => {
  const seen = new Map();
  for (const m of html.matchAll(/id="([A-Za-z0-9_]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, []);
});
