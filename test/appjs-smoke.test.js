'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// app.js guards all DOM/window use behind DOMContentLoaded + typeof checks, so it
// loads cleanly under Node and exposes buildAddPayload for testing.
const { buildAddPayload } = require('../renderer/app.js');

test('buildAddPayload produces a well-formed schedule:add payload', () => {
  const p = buildAddPayload({
    filePath: '/vids/ride.mp4', fileName: 'ride.mp4', durationSec: 1800, vertical: false,
    fireAt: 1893000000000, leadMin: 5, autoStop: true, repeatWeekly: true,
    contentItemGuid: 'ci', scheduleGuid: 'sg', title: 'Evening Ride',
  });
  assert.equal(p.leadMs, 5 * 60000);
  assert.equal(p.fireAt, 1893000000000);
  assert.equal(p.durationSec, 1800);
  assert.equal(p.autoStop, true); assert.equal(p.repeatWeekly, true);
  assert.equal(p.contentItemGuid, 'ci'); assert.equal(p.scheduleGuid, 'sg');
  assert.equal(p.filePath, '/vids/ride.mp4'); assert.equal(p.title, 'Evening Ride');
  assert.equal('status' in p, false, 'renderer never sets status — the brain defaults it');
  assert.equal(typeof p.fireAt, 'number'); assert.equal(typeof p.leadMs, 'number'); assert.equal(typeof p.durationSec, 'number');
});

test('buildAddPayload coerces/guards missing optionals', () => {
  const p = buildAddPayload({ filePath: '/v.mp4', fileName: 'v.mp4', durationSec: 10, fireAt: 1, leadMin: 0 });
  assert.equal(p.leadMs, 0); assert.equal(p.autoStop, true);           // default on
  assert.equal(p.repeatWeekly, false); assert.equal(p.title, '');
  assert.equal(p.vertical, false); assert.equal(p.contentItemGuid, '');
});
