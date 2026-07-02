'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePortalLink } = require('../portal/link');
const { createIpcHandlers } = require('../app/ipc');

test('parsePortalLink: broadcast link → both guids', () => {
  const r = parsePortalLink('https://content.echelonfit.com/broadcast/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222');
  assert.deepEqual(r, { contentItemGuid: '11111111-1111-1111-1111-111111111111', scheduleGuid: '22222222-2222-2222-2222-222222222222' });
});
test('parsePortalLink: class link → contentItemGuid only', () => {
  const r = parsePortalLink('https://content.echelonfit.com/classes/33333333-3333-3333-3333-333333333333');
  assert.deepEqual(r, { contentItemGuid: '33333333-3333-3333-3333-333333333333', scheduleGuid: '' });
});
test('parsePortalLink: junk → empty', () => {
  assert.deepEqual(parsePortalLink('nope'), { contentItemGuid: '', scheduleGuid: '' });
  assert.deepEqual(parsePortalLink(null), { contentItemGuid: '', scheduleGuid: '' });
});

function handlers(over = {}) {
  const calls = { save: [], setPw: [], add: [], remove: [], stop: [], check: [] };
  const base = {
    settings: { get: () => ({ videoBitrate: 6000 }), save: (p) => { calls.save.push(p); return { videoBitrate: 6000, ...p }; } },
    secrets: { has: () => true, set: (k, v) => { calls.setPw.push([k, v]); } },
    portal: {
      testLogin: async (o) => ({ ok: true, stations: [], _o: o }),
      checkClassLink: async (a) => { calls.check.push(a); return { ok: true, count: 1, vertical: false, ...a }; },
    },
    scheduler: {
      getEvents: () => [{ id: 'e1' }],
      addEvent: (e) => { calls.add.push(e); return { id: 'new', ...e }; },
      removeEvent: (id) => { calls.remove.push(id); return { ok: true }; },
      stopActive: async (id) => { calls.stop.push(id); return { ok: true }; },
    },
    probe: { probeFile: async (p) => ({ ok: true, durationSec: 10, width: 1920, height: 1080, _p: p }) },
    ffmpeg: { selfCheck: async () => ({ ok: true, version: 'x' }) },
  };
  return { h: createIpcHandlers({ ...base, ...over }), calls };
}

test('handler map covers exactly the expected channels', () => {
  const { h } = handlers();
  assert.deepEqual(Object.keys(h).sort(), [
    'engine:selfCheck', 'portal:checkLink', 'portal:testLogin', 'probe:file',
    'schedule:add', 'schedule:list', 'schedule:remove', 'schedule:stop',
    'secret:hasPassword', 'secret:setPassword', 'settings:get', 'settings:save',
  ].sort());
});

test('settings:save strips nothing but is passed through; settings:get returns store data', async () => {
  const { h, calls } = handlers();
  assert.deepEqual(await h['settings:get'](), { videoBitrate: 6000 });
  await h['settings:save']({ portalEmail: 'e@x.com' });
  assert.deepEqual(calls.save[0], { portalEmail: 'e@x.com' });
});

test('secret:setPassword returns {ok:true} on success and {ok:false,error} when the codec throws', async () => {
  const good = handlers();
  assert.deepEqual(await good.h['secret:setPassword']('pw'), { ok: true });
  assert.deepEqual(good.calls.setPw[0], ['portalPassword', 'pw']);
  const bad = handlers({ secrets: { has: () => false, set: () => { throw new Error('no keychain'); } } });
  const r = await bad.h['secret:setPassword']('pw');
  assert.equal(r.ok, false);
  assert.match(r.error, /no keychain/);
});

test('portal:checkLink parses the pasted string, resolves, and returns the guids for storage', async () => {
  const { h } = handlers();
  const r = await h['portal:checkLink']('https://x/classes/44444444-4444-4444-4444-444444444444');
  assert.equal(r.ok, true);
  assert.equal(r.contentItemGuid, '44444444-4444-4444-4444-444444444444');
  assert.equal(r.scheduleGuid, '');
});

test('schedule + probe + selfCheck handlers delegate correctly', async () => {
  const { h, calls } = handlers();
  assert.deepEqual(await h['schedule:list'](), [{ id: 'e1' }]);
  await h['schedule:add']({ title: 'T' }); assert.equal(calls.add[0].title, 'T');
  await h['schedule:remove']('e1'); assert.equal(calls.remove[0], 'e1');
  await h['schedule:stop']('e1'); assert.equal(calls.stop[0], 'e1');
  assert.equal((await h['probe:file']('/v.mp4')).durationSec, 10);
  assert.equal((await h['engine:selfCheck']()).ok, true);
});
