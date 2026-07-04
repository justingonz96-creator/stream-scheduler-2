'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
} = require('../schedule/model');

test('constants', () => { assert.equal(GRACE_MS, 120000); assert.equal(MAX_RESUMES, 3); });

test('normalizeEvent fills the full default shape and keeps given fields', () => {
  const ev = normalizeEvent({ id: 'x', fireAt: 1000, title: 'Yoga' });
  assert.equal(ev.id, 'x'); assert.equal(ev.fireAt, 1000); assert.equal(ev.title, 'Yoga');
  assert.equal(ev.status, 'pending'); assert.equal(ev.autoStop, true);
  assert.equal(ev.leadMs, 0); assert.equal(ev.durationSec, 0); assert.equal(ev.vertical, false);
  assert.equal(ev.needsVideo, false); assert.equal(ev.repeatWeekly, false);
  assert.equal(ev.contentItemGuid, ''); assert.equal(ev.scheduleGuid, '');
  assert.equal(ev.stationName, '');
  assert.ok(!('streamKey' in ev), 'the stream key is never a persisted field');
});

test('streamAtOf / computeLeadSec / plannedVideoEndAtMs', () => {
  const ev = normalizeEvent({ fireAt: 100000, leadMs: 30000, durationSec: 600 });
  assert.equal(streamAtOf(ev), 70000);
  assert.equal(computeLeadSec(ev, 70000), 30);          // full lead when on time
  assert.equal(computeLeadSec(ev, 95000), 5);           // shortened when late-ish
  assert.equal(computeLeadSec(ev, 100000), 0);          // at/after fireAt ⇒ no slate
  assert.equal(computeLeadSec(ev, 200000), 0);
  assert.equal(plannedVideoEndAtMs(ev), 100000 + 600000);
});

test('joinRtmpUrl trims trailing slashes then appends the key', () => {
  assert.equal(joinRtmpUrl('rtmps://global-live.mux.com:443/app', 'KEY'), 'rtmps://global-live.mux.com:443/app/KEY');
  assert.equal(joinRtmpUrl('rtmps://h/app/', 'KEY'), 'rtmps://h/app/KEY');
});

test('renewWeekly: null unless repeatWeekly; else fresh empty slot 7d+ out', () => {
  assert.equal(renewWeekly(normalizeEvent({ repeatWeekly: false, fireAt: 1000 }), 2000, () => 'id'), null);
  const base = normalizeEvent({ id: 'orig', fireAt: 1_000_000, leadMs: 30000, title: 'Ride', repeatWeekly: true, autoStop: true });
  const nv = renewWeekly(base, 1_000_000, () => 'NEW');
  assert.equal(nv.id, 'NEW'); assert.equal(nv.slotId, 'orig'); assert.equal(nv.title, 'Ride');
  assert.equal(nv.repeatWeekly, true); assert.equal(nv.needsVideo, true); assert.equal(nv.status, 'pending');
  assert.equal(nv.leadMs, 30000); assert.equal(nv.fileName, ''); assert.equal(nv.filePath, '');
  assert.equal(nv.fireAt, 1_000_000 + 7 * 86400000);
});

test('renewWeekly skips weeks already in the past relative to now', () => {
  const base = normalizeEvent({ id: 'o', slotId: 'slot', fireAt: 1000, repeatWeekly: true });
  const nowMs = 1000 + 3 * 7 * 86400000;   // 3 weeks later
  const nv = renewWeekly(base, nowMs, () => 'N');
  assert.ok(nv.fireAt > nowMs + 60000, 'next occurrence is safely in the future');
  assert.equal((nv.fireAt - 1000) % (7 * 86400000), 0, 'still aligned to the weekly cadence');
});
