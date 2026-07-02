'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createPortalClient } = require('../portal/client');

// A scriptable fake transport: routes[method + ' ' + pathStart] -> {status, json}
function fakeTransport(routes, calls = []) {
  return async (method, url, opts = {}) => {
    calls.push({ method, url, opts });
    for (const [key, resp] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (method === m && url.includes(p)) {
        return { status: resp.status ?? 200, text: JSON.stringify(resp.json ?? {}) };
      }
    }
    return { status: 404, text: '{"error":"not found"}' };
  };
}

const CFG = { email: 'e@x.com', password: 'pw', apiKey: 'K', apiBase: 'https://portal.test' };
const getConfig = () => ({ ...CFG });
const AUTH_OK = { 'POST /auth': { status: 201, json: { token: 'tok-abcdefghijklmnopqrstuvwxyz' } } };
const ITEM = (medium, scheds) => ({ data: { medium, schedule: scheds } });
const SCHED = (n, start) => ({ guid: 'sg-' + n, controlStation: { guid: 'st-' + n, name: 'Studio ' + n }, type: 'live', available: { start, end: start + 3600 } });
const STATIONS = { data: [
  { guid: 'st-1', name: 'Studio 1', mux: { streamKey: 'KEY-ONE' }, rtmpUrl: { secure: 'rtmps://a/app', standard: 'rtmp://a/app' } },
  { guid: 'st-2', name: 'Studio 2', mux: { streamKey: 'KEY-TWO' }, rtmpUrl: { secure: 'rtmps://b/app', standard: 'rtmp://b/app' } },
] };
const NOW = 1000000;

test('testLogin: ok + station summaries; bad login → plain-English error', async () => {
  const c = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /control-stations': { json: STATIONS } }), now: () => NOW });
  const r = await c.testLogin();
  assert.equal(r.ok, true);
  assert.deepEqual(r.stations, [{ name: 'Studio 1', guid: 'st-1' }, { name: 'Studio 2', guid: 'st-2' }]);
  const bad = createPortalClient({ getConfig, transport: fakeTransport({ 'POST /auth': { status: 401, json: {} } }), now: () => NOW });
  const rb = await bad.testLogin();
  assert.equal(rb.ok, false);
  assert.match(rb.error, /login failed/i);
});

test('auth sends X-Api-Key and Bearer on the follow-up request', async () => {
  const calls = [];
  const c = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /control-stations': { json: STATIONS } }, calls), now: () => NOW });
  await c.testLogin();
  const authCall = calls.find(x => x.url.includes('/auth'));
  const listCall = calls.find(x => x.url.includes('/control-stations'));
  assert.equal(authCall.opts.headers['X-Api-Key'], 'K');
  assert.equal(listCall.opts.headers['Authorization'], 'Bearer tok-abcdefghijklmnopqrstuvwxyz');
  assert.equal(listCall.opts.headers['X-Api-Key'], 'K');
});

test('checkClassLink: picks by time; exact scheduleGuid overrides', async () => {
  const routes = { ...AUTH_OK, 'GET /content/items/': { json: ITEM('reflect', [SCHED(1, NOW - 600), SCHED(2, NOW + 90000)]) } };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), now: () => NOW });
  const picked = await c.checkClassLink({ contentItemGuid: 'ci-1' });
  assert.equal(picked.ok, true);
  assert.equal(picked.count, 2);
  assert.equal(picked.picked.scheduleGuid, 'sg-1');       // in-window beats far-future
  assert.equal(picked.vertical, true);
  const exact = await c.checkClassLink({ contentItemGuid: 'ci-1', scheduleGuid: 'sg-2' });
  assert.equal(exact.picked.scheduleGuid, 'sg-2');
});

test('streamTarget: right station ingest + vertical; the key NEVER hits the log', async () => {
  const logs = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(2, NOW - 60)]) },
    'GET /control-stations': { json: STATIONS },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), log: (m) => logs.push(m), now: () => NOW });
  const r = await c.streamTarget({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, true);
  assert.equal(r.server, 'rtmps://b/app');
  assert.equal(r.key, 'KEY-TWO');
  assert.equal(r.stationName, 'Studio 2');
  assert.equal(r.vertical, false);
  assert.match(logs.join('\n'), /streamtarget class=ci-1/);
  assert.match(logs.join('\n'), /16:9/);
  assert.ok(!logs.join('\n').includes('KEY-TWO'), 'stream key must never be logged');
});

test('streamTarget: no resolvable studio → plain-English error', async () => {
  const routes = { ...AUTH_OK, 'GET /content/items/': { json: ITEM('standard', []) } };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), now: () => NOW });
  const r = await c.streamTarget({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no studio found for this class/i);
});

test('endBroadcast: discovers schedule+station from the class; posts stream/close', async () => {
  const calls = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(1, NOW - 60)]) },
    'POST /control-stations/st-1/stream/close': { status: 204, json: {} },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes, calls), now: () => NOW });
  const r = await c.endBroadcast({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, true);
  const close = calls.find(x => x.url.includes('/stream/close'));
  assert.deepEqual(close.opts.body, { scheduleGuid: 'sg-1' });
});

test('endBroadcast: pasted scheduleGuid pins the exact occurrence; nothing found → clear error', async () => {
  const calls = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(1, NOW - 60), SCHED(2, NOW - 30)]) },
    'POST /control-stations/st-1/stream/close': { status: 200, json: { ok: true } },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes, calls), now: () => NOW });
  const r = await c.endBroadcast({ contentItemGuid: 'ci-1', scheduleGuid: 'sg-1' });
  assert.equal(r.ok, true);
  assert.match(calls.find(x => x.url.includes('/stream/close')).url, /st-1/);

  const empty = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /content/items/': { json: ITEM('standard', []) } }), now: () => NOW });
  const re = await empty.endBroadcast({ contentItemGuid: 'ci-1' });
  assert.equal(re.ok, false);
  assert.match(re.error, /no live broadcast was found to end/i);
});

test('no-argument calls degrade to {ok:false}, never throw (never-throws law)', async () => {
  const c = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK }), now: () => NOW });
  const a = await c.checkClassLink();
  assert.equal(a.ok, false); assert.match(a.error, /no class link/i);
  const b = await c.streamTarget();
  assert.equal(b.ok, false); assert.match(b.error, /no class link/i);
  const d = await c.endBroadcast();
  assert.equal(d.ok, false); assert.match(d.error, /no live broadcast was found to end/i);
});

test('failure paths never leak the key either (station missing from the list)', async () => {
  const logs = [];
  // The class resolves to station st-9 (absent), while the station list still
  // carries other stations WITH keys — a leak here would surface them.
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [{ guid: 'sg-9', controlStation: { guid: 'st-9', name: 'Ghost' }, type: 'live', available: { start: NOW - 60, end: NOW + 3600 } }]) },
    'GET /control-stations': { json: STATIONS },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), log: (m) => logs.push(m), now: () => NOW });
  const r = await c.streamTarget({ contentItemGuid: 'ci-9' });
  assert.equal(r.ok, false);
  assert.match(r.error, /studio for this class was not found/i);
  const everything = logs.join('\n') + JSON.stringify(r);
  assert.ok(!everything.includes('KEY-ONE') && !everything.includes('KEY-TWO'), 'no key may leak on failure paths');
});
