'use strict';
// 2026-09-04 audit: network failures were reported as "check your password",
// and a 2xx with no session token counted as a login.
const { test } = require('node:test');
const assert = require('node:assert');
const { createPortalClient } = require('../portal/client');

function client(transport) {
  return createPortalClient({ getConfig: () => ({ email: 'a@b', password: 'pw', apiKey: '' }), transport });
}
test('a network/transport failure (status 0) is reported as unreachable, not as bad credentials', async () => {
  const c = client(async () => ({ status: 0, text: '', error: 'ECONNRESET' }));
  const r = await c.testLogin({});
  assert.equal(r.ok, false); assert.match(r.error, /could not be reached|network/i); assert.doesNotMatch(r.error, /password/i);
});
test('a 401/403 is a credentials problem', async () => {
  const c = client(async () => ({ status: 401, text: '{}' }));
  const r = await c.testLogin({});
  assert.equal(r.ok, false); assert.match(r.error, /email and password/i);
});
test('a 2xx with no session token is NOT a login', async () => {
  const c = client(async (m, url) => url.endsWith('/auth') ? ({ status: 200, text: '<html>login page</html>' }) : ({ status: 200, text: '[]' }));
  const r = await c.testLogin({});
  assert.equal(r.ok, false); assert.match(r.error, /session|token|sign-in did not complete/i);
});
