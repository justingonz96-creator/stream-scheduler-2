'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createTransport } = require('../portal/http');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('POST json body, default headers, status+text back', async () => {
  const seen = {};
  const { srv, base } = await serve((req, res) => {
    seen.method = req.method; seen.ct = req.headers['content-type'];
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { seen.body = b; res.writeHead(201); res.end('{"token":"abcdefghijklmnopqrstuvwxyz"}'); });
  });
  const t = createTransport();
  const r = await t('POST', base + '/auth', { body: { email: 'e', password: 'p' } });
  srv.close();
  assert.equal(r.status, 201);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.ct, 'application/json');
  assert.deepEqual(JSON.parse(seen.body), { email: 'e', password: 'p' });
  assert.match(r.text, /token/);
});

test('cookie jar: Set-Cookie is replayed on the next request', async () => {
  const seen = { cookies: [] };
  const { srv, base } = await serve((req, res) => {
    seen.cookies.push(req.headers.cookie || '');
    res.setHeader('Set-Cookie', 'sid=s3cr3t; Path=/; HttpOnly');
    res.writeHead(200); res.end('{}');
  });
  const t = createTransport();
  await t('GET', base + '/a', {});
  await t('GET', base + '/b', {});
  srv.close();
  assert.equal(seen.cookies[0], '');
  assert.match(seen.cookies[1], /sid=s3cr3t/);
});

test('unreachable host → status 0, never throws', async () => {
  const t = createTransport({ timeoutMs: 2000 });
  const r = await t('GET', 'http://127.0.0.1:1/nope', {});
  assert.equal(r.status, 0);
  assert.ok(r.text.length > 0);
});
