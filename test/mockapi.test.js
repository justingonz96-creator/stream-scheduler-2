'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockApi, installMockApi } = require('../renderer/mockapi');

test('every renderer channel returns a plausibly-shaped result', async () => {
  const api = createMockApi();
  assert.equal((await api.invoke('settings:get')).videoBitrate !== undefined, true);
  assert.equal((await api.invoke('engine:selfCheck')).ok, true);
  assert.equal((await api.invoke('secret:hasPassword')) !== undefined, true);
  const login = await api.invoke('portal:testLogin', {});
  assert.equal(login.ok, true); assert.ok(Array.isArray(login.stations));
  const link = await api.invoke('portal:checkLink', 'https://x/classes/11111111-1111-1111-1111-111111111111');
  assert.equal(link.ok, true); assert.equal(link.contentItemGuid, '11111111-1111-1111-1111-111111111111');
  const probe = await api.invoke('probe:file', '/v.mp4');
  assert.equal(probe.ok, true); assert.ok(probe.durationSec > 0);
  assert.equal(typeof (await api.invoke('dialog:openFile', {})), 'string');
});

test('schedule add/list/remove round-trips in memory', async () => {
  const api = createMockApi();
  assert.deepEqual(await api.invoke('schedule:list'), []);
  const ev = await api.invoke('schedule:add', { title: 'T', fireAt: 5, filePath: '/v.mp4', durationSec: 10 });
  assert.ok(ev.id);
  assert.equal((await api.invoke('schedule:list')).length, 1);
  assert.deepEqual(await api.invoke('schedule:remove', ev.id), { ok: true });
  assert.equal((await api.invoke('schedule:list')).length, 0);
});

test('onScheduleChanged fires on _emitChange and unsubscribes', async () => {
  const api = createMockApi();
  let calls = 0;
  const off = api.onScheduleChanged(() => { calls++; });
  api._emitChange(); assert.equal(calls, 1);
  off(); api._emitChange(); assert.equal(calls, 1);
});

test('installMockApi only fills an absent api', () => {
  const g1 = {}; installMockApi(g1); assert.equal(typeof g1.api.invoke, 'function');
  const real = { invoke() {}, onScheduleChanged() {} }; const g2 = { api: real };
  installMockApi(g2); assert.equal(g2.api, real, 'must not overwrite a real bridge');
});
