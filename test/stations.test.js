'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStations, stationIngest, stationSummaries } = require('../portal/stations');

const S = {
  guid: 'g1', name: 'Connect',
  mux: { streamKey: 'sekret-key-value', streamId: 'id' },
  rtmpUrl: { standard: 'rtmp://global-live.mux.com:5222/app', secure: 'rtmps://global-live.mux.com:443/app' },
};

test('parseStations accepts bare array, {data}, {items}', () => {
  assert.equal(parseStations([S]).length, 1);
  assert.equal(parseStations({ data: [S] }).length, 1);
  assert.equal(parseStations({ items: [S] }).length, 1);
  assert.deepEqual(parseStations({ nope: 1 }), []);
});

test('stationIngest: secure preferred, key extracted', () => {
  const r = stationIngest([S], 'g1');
  assert.equal(r.ok, true);
  assert.equal(r.server, 'rtmps://global-live.mux.com:443/app');
  assert.equal(r.key, 'sekret-key-value');
  assert.equal(r.stationName, 'Connect');
});

test('stationIngest: standard fallback when no secure', () => {
  const s2 = { ...S, rtmpUrl: { standard: 'rtmp://global-live.mux.com:5222/app' } };
  assert.equal(stationIngest([s2], 'g1').server, 'rtmp://global-live.mux.com:5222/app');
});

test('stationIngest errors are plain-English and never contain the key', () => {
  const missing = stationIngest([S], 'other-guid');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /studio for this class was not found/i);
  const noKey = stationIngest([{ ...S, mux: {} }], 'g1');
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /no stream ingest set up/i);
  assert.ok(!JSON.stringify([missing, noKey]).includes('sekret-key-value'));
});

test('stationSummaries: name+guid pairs only', () => {
  assert.deepEqual(stationSummaries([S, { guid: 'x' }, { name: 'y' }]), [{ name: 'Connect', guid: 'g1' }]);
});
