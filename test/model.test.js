'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly, isSafeToUpdate, resolveSlateImage,
} = require('../schedule/model');

test('constants', () => { assert.equal(GRACE_MS, 120000); assert.equal(MAX_RESUMES, 3); });

test('resolveSlateImage: each orientation prefers its own slate', () => {
  const s = { slateImage: '/wide.png', slateImageVertical: '/tall.png' };
  assert.equal(resolveSlateImage(s, false), '/wide.png');
  assert.equal(resolveSlateImage(s, true), '/tall.png');
});

test('resolveSlateImage: falls back to the other slate when only one is set', () => {
  assert.equal(resolveSlateImage({ slateImage: '/wide.png' }, true), '/wide.png', 'vertical falls back to the 16:9 slate');
  assert.equal(resolveSlateImage({ slateImageVertical: '/tall.png' }, false), '/tall.png', 'landscape falls back to the 9:16 slate');
});

test('resolveSlateImage: no slate configured ⇒ empty string, tolerates missing settings', () => {
  assert.equal(resolveSlateImage({}, true), '');
  assert.equal(resolveSlateImage({}, false), '');
  assert.equal(resolveSlateImage(undefined, true), '');
});

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

test('isSafeToUpdate: unsafe while a broadcast is live/starting/preshow', () => {
  const live = normalizeEvent({ id: 'l', status: 'playing', fireAt: 0, durationSec: 600 });
  const r = isSafeToUpdate([live], 500000);
  assert.equal(r.safe, false);
  assert.match(r.reason, /live right now/i);
  for (const status of ['starting', 'preshow']) {
    const r2 = isSafeToUpdate([normalizeEvent({ id: 'x', status, fireAt: 0, durationSec: 600 })], 500000);
    assert.equal(r2.safe, false, status + ' must block an update');
  }
});

test('isSafeToUpdate: unsafe when a real (has-video) broadcast is due within the buffer', () => {
  const soon = normalizeEvent({ id: 's', status: 'pending', fireAt: 1_000_000, filePath: '/v.mp4', durationSec: 600 });
  // due in 10 minutes, default 15-minute buffer ⇒ unsafe
  const r = isSafeToUpdate([soon], 1_000_000 - 10 * 60000);
  assert.equal(r.safe, false);
  assert.match(r.reason, /start soon/i);
});

test('isSafeToUpdate: safe when nothing is due for hours', () => {
  const later = normalizeEvent({ id: 'f', status: 'pending', fireAt: 1_000_000, filePath: '/v.mp4', durationSec: 600 });
  const r = isSafeToUpdate([later], 1_000_000 - 3 * 3600000);   // 3 hours out
  assert.equal(r.safe, true);
});

test('isSafeToUpdate: a class already under way (late-start territory) still counts as unsafe until it would genuinely be over', () => {
  const ev = normalizeEvent({ id: 'u', status: 'pending', fireAt: 1_000_000, filePath: '/v.mp4', durationSec: 600 });
  // 5 minutes past fireAt, video still has 5 min of real content left ⇒ unsafe (it's about to catch-up and go live)
  const r1 = isSafeToUpdate([ev], 1_000_000 + 5 * 60000);
  assert.equal(r1.safe, false);
  // 11 minutes past fireAt with only a 10-minute video ⇒ it would be marked missed, not started ⇒ safe
  const r2 = isSafeToUpdate([ev], 1_000_000 + 11 * 60000);
  assert.equal(r2.safe, true);
});

test('isSafeToUpdate: a weekly slot with no video yet can never block (it never goes live without one)', () => {
  const empty = normalizeEvent({ id: 'w', status: 'pending', fireAt: 1_000_000, needsVideo: true, filePath: '', durationSec: 0 });
  const r = isSafeToUpdate([empty], 1_000_000 - 60000);   // due in 1 minute, well inside the buffer
  assert.equal(r.safe, true);
});

test('isSafeToUpdate: done/failed/missed events never block', () => {
  const done = normalizeEvent({ id: 'd', status: 'done', fireAt: 1_000_000, durationSec: 600 });
  const r = isSafeToUpdate([done], 1_000_000 + 1000);
  assert.equal(r.safe, true);
});

test('isSafeToUpdate: an empty schedule is always safe', () => {
  assert.equal(isSafeToUpdate([], Date.now()).safe, true);
});

test('isSafeToUpdate: the lookahead buffer is configurable', () => {
  const ev = normalizeEvent({ id: 'b', status: 'pending', fireAt: 1_000_000, filePath: '/v.mp4', durationSec: 600 });
  const now = 1_000_000 - 20 * 60000;   // 20 minutes out
  assert.equal(isSafeToUpdate([ev], now).safe, true, 'default 15-min buffer: 20 min out is safe');
  assert.equal(isSafeToUpdate([ev], now, 30 * 60000).safe, false, 'a wider 30-min buffer catches it');
});
