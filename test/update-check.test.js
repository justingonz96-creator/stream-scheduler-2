'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkForUpdate } = require('../store/update-check');

const fake = (status, body) => async () => ({ status, ok: status === 200, json: async () => body, text: async () => JSON.stringify(body) });

test('newer release → hasUpdate with version and url', async () => {
  const r = await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'v2.1.0', html_url: 'https://x/rel' }) });
  assert.deepEqual(r, { hasUpdate: true, latestVersion: '2.1.0', url: 'https://x/rel' });
});
test('same or older release → no update', async () => {
  assert.equal((await checkForUpdate({ currentVersion: '2.1.0', fetchImpl: fake(200, { tag_name: 'v2.1.0', html_url: 'u' }) })).hasUpdate, false);
  assert.equal((await checkForUpdate({ currentVersion: '2.1.0', fetchImpl: fake(200, { tag_name: 'v2.0.9', html_url: 'u' }) })).hasUpdate, false);
  assert.equal((await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'v2.0.10', html_url: 'u' }) })).hasUpdate, true, 'numeric not lexicographic (10 > 9)');
});
test('failures are silent no-ops: 404, garbage tag, thrown fetch', async () => {
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(404, {}) }), { hasUpdate: false });
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'not-a-version' }) }), { hasUpdate: false });
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: async () => { throw new Error('offline'); } }), { hasUpdate: false });
});
