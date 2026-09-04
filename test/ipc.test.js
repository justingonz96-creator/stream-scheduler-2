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
  const calls = { save: [], setPw: [], add: [], update: [], remove: [], stop: [], retry: [], skip: [], check: [] };
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
      updateEvent: (id, patch) => { calls.update.push([id, patch]); return { ok: true, event: { id, ...patch } }; },
      removeEvent: (id) => { calls.remove.push(id); return { ok: true }; },
      clearPast: () => { calls.clearPast = (calls.clearPast || 0) + 1; return { ok: true, removed: 3 }; },
      stopActive: async (id) => { calls.stop.push(id); return { ok: true }; },
      retryEvent: async (id) => { calls.retry.push(id); return { ok: true }; },
      skipEvent: async (id) => { calls.skip.push(id); return { ok: true }; },
    },
    probe: { probeFile: async (p) => ({ ok: true, durationSec: 10, width: 1920, height: 1080, _p: p }) },
    ffmpeg: { selfCheck: async () => ({ ok: true, version: 'x' }) },
    updates: { getState: () => ({ phase: 'idle', version: '', error: '', safe: true, reason: '' }), install: async () => ({ ok: true }), showDownload: async () => ({ ok: true }) },
    health: { getState: () => ({ ok: true, at: 0, checking: false, checks: [] }), check: async () => ({ ok: true, at: 1, checking: false, checks: [] }) },
  };
  return { h: createIpcHandlers({ ...base, ...over }), calls };
}

test('handler map covers exactly the expected channels', () => {
  const { h } = handlers();
  assert.deepEqual(Object.keys(h).sort(), [
    'engine:selfCheck', 'portal:checkLink', 'portal:testLogin', 'probe:file',
    'schedule:add', 'schedule:list', 'schedule:remove', 'schedule:clearPast', 'schedule:stop', 'schedule:retry', 'schedule:skip', 'schedule:update',
    'secret:hasPassword', 'secret:setPassword', 'secret:hasApiKey', 'secret:setApiKey', 'settings:get', 'settings:save',
    'update:getState', 'update:install', 'update:showDownload',
    'health:get', 'health:check',
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
  await h['schedule:update']({ id: 'e1', patch: { title: 'T2' } });
  assert.deepEqual(calls.update[0], ['e1', { title: 'T2' }]);
  await h['schedule:remove']('e1'); assert.equal(calls.remove[0], 'e1');
  assert.deepEqual(await h['schedule:clearPast'](), { ok: true, removed: 3 }); assert.equal(calls.clearPast, 1);
  await h['schedule:stop']('e1'); assert.equal(calls.stop[0], 'e1');
  assert.deepEqual(await h['schedule:retry']('e1'), { ok: true });
  assert.deepEqual(await h['schedule:skip']('e1'), { ok: true }); assert.equal(calls.skip[0], 'e1');
  assert.equal(calls.retry[0], 'e1');
  assert.equal((await h['probe:file']('/v.mp4')).durationSec, 10);
  assert.equal((await h['engine:selfCheck']()).ok, true);
});

test('update:getState/install delegate to the injected updates object (main.js owns the real logic)', async () => {
  const install = { called: false };
  const { h } = handlers({ updates: {
    getState: () => ({ phase: 'downloaded', version: '9.9.9', error: '', safe: false, reason: 'a broadcast is scheduled to start soon' }),
    install: async () => { install.called = true; return { ok: false, error: 'a broadcast is scheduled to start soon' }; },
  } });
  const state = await h['update:getState']();
  assert.equal(state.phase, 'downloaded'); assert.equal(state.version, '9.9.9'); assert.equal(state.safe, false);
  const r = await h['update:install']();
  assert.equal(install.called, true);
  assert.equal(r.ok, false); assert.match(r.error, /start soon/i);
});

test('health:get/check delegate to the injected health object', async () => {
  let checked = false;
  const { h } = handlers({ health: {
    getState: () => ({ ok: false, at: 5, checking: false, checks: [{ id: 'portal', ok: false, detail: 'sign-in failed' }] }),
    check: async () => { checked = true; return { ok: true, at: 6, checking: false, checks: [] }; },
  } });
  const st = await h['health:get']();
  assert.equal(st.ok, false); assert.equal(st.checks[0].detail, 'sign-in failed');
  const r = await h['health:check']();
  assert.equal(checked, true); assert.equal(r.ok, true);
});

test('update:showDownload delegates to the injected updates object', async () => {
  const calls = [];
  const { h } = handlers({ updates: {
    getState: () => ({}), install: async () => ({ ok: true }),
    showDownload: async () => { calls.push(1); return { ok: true }; },
  } });
  const r = await h['update:showDownload']();
  assert.equal(calls.length, 1);
  assert.equal(r.ok, true);
});

// 2026-09-04 audit: the confirmed occurrence's scheduleGuid was discarded when
// the pasted link carried none, so the app could re-pick a different studio at
// air time.
test('portal:checkLink returns the PICKED occurrence scheduleGuid when the link has none', async () => {
  const { h } = handlers({ portal: { testLogin: async () => ({ ok: true }), checkClassLink: async () => ({ ok: true, picked: { scheduleGuid: 'sched-picked', stationName: 'Studio 2' }, vertical: false }) } });
  const r = await h['portal:checkLink']('https://content.echelonfit.com/classes/11111111-1111-1111-1111-111111111111');
  assert.equal(r.scheduleGuid, 'sched-picked');
});
test('portal:checkLink keeps the scheduleGuid from the link when it has one', async () => {
  const { h } = handlers({ portal: { testLogin: async () => ({ ok: true }), checkClassLink: async () => ({ ok: true, picked: { scheduleGuid: 'other' }, vertical: false }) } });
  const r = await h['portal:checkLink']('https://content.echelonfit.com/classes/11111111-1111-1111-1111-111111111111?scheduleGuid=22222222-2222-2222-2222-222222222222');
  assert.equal(r.scheduleGuid, '22222222-2222-2222-2222-222222222222');
});

test('secret:setApiKey stores/clears the key in the secret store; secret:hasApiKey reports it', async () => {
  const store = {}; const secrets = { has: (k) => !!store[k], set: (k, v) => { store[k] = v; }, get: (k) => store[k] || '' };
  const { h } = handlers({ secrets });
  assert.equal(await h['secret:hasApiKey'](), false);
  assert.deepEqual(await h['secret:setApiKey']('K1'), { ok: true });
  assert.equal(store.portalApiKey, 'K1');
  assert.equal(await h['secret:hasApiKey'](), true);
  await h['secret:setApiKey']('');
  assert.equal(await h['secret:hasApiKey'](), false, 'blank clears it');
});
