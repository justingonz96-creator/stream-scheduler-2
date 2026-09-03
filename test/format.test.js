'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../renderer/format');

test('recentFailures: failed + real missed AFTER the boundary; skips needsVideo, done, pre-boundary, dismissed', () => {
  const open = 1_700_000_000_000;   // when the app opened this session
  const events = [
    { id: 'a', status: 'failed', doneAt: open + 1000 },                     // in — failed during this session
    { id: 'b', status: 'missed', needsVideo: false, doneAt: open + 2000 },  // in — missed but had a video
    { id: 'c', status: 'missed', needsVideo: true, doneAt: open + 1000 },   // out — weekly slot with no video (expected)
    { id: 'd', status: 'done', doneAt: open + 1000 },                       // out — it aired
    { id: 'e', status: 'failed', doneAt: open - 1000 },                     // out — before this session opened (no re-nag)
    { id: 'f', status: 'failed', doneAt: open + 500 },                      // out — dismissed
    { id: 'g', status: 'pending', doneAt: 0 },                              // out — hasn't run
  ];
  const ids = F.recentFailures(events, open, new Set(['f'])).map((e) => e.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
});

test('recentFailures: empty/undefined inputs are safe', () => {
  assert.deepEqual(F.recentFailures(undefined, 1, new Set()), []);
  assert.deepEqual(F.recentFailures([], 1), []);
});

test('statusPill maps every scheduler status', () => {
  assert.equal(F.statusPill({ status: 'playing' }).kind, 'live');
  assert.equal(F.statusPill({ status: 'playing' }).label, 'On air');
  assert.equal(F.statusPill({ status: 'preshow' }).label, 'Slate up');
  assert.equal(F.statusPill({ status: 'starting' }).label, 'Starting…');
  assert.equal(F.statusPill({ status: 'pending' }).label, 'Scheduled');
  assert.equal(F.statusPill({ status: 'done', outcome: 'Played ✓ and the stream ended' }).label, 'Played ✓', 'past-event pills stay short; the outcome renders as row meta');
  assert.equal(F.statusPill({ status: 'failed', outcome: '' }).label, 'Failed');
  assert.equal(F.statusPill({ status: 'missed', outcome: '' }).kind, 'missed');
});

test('endsAround only when a duration is known; notes auto-stop', () => {
  assert.equal(F.endsAround({ fireAt: 0, durationSec: 0 }), '');
  const s = F.endsAround({ fireAt: 0, durationSec: 3600, autoStop: true });
  assert.match(s, /^ends around /);
  assert.match(s, /stream ends by itself/);
  assert.ok(!F.endsAround({ fireAt: 0, durationSec: 3600, autoStop: false }).includes('by itself'));
});

test('buildTimeOptions shape', () => {
  const { hours, minutes } = F.buildTimeOptions();
  assert.deepEqual(hours[0], '1'); assert.equal(hours.length, 12);
  assert.deepEqual(minutes, ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
});

test('parseDateTime combines parts or returns null', () => {
  assert.equal(F.parseDateTime('', '7', '05', 'PM'), null);
  const ms = F.parseDateTime('2026-07-04', '7', '05', 'PM');
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 6); assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 19); assert.equal(d.getMinutes(), 5);
  assert.equal(F.parseDateTime('2026-07-04', '12', '00', 'AM'), new Date(2026, 6, 4, 0, 0, 0, 0).getTime());   // midnight
  assert.equal(new Date(F.parseDateTime('2026-07-04', '12', '00', 'PM')).getHours(), 12);                       // noon
});

test('orientationLabel', () => {
  assert.match(F.orientationLabel(true), /9:16/);
  assert.match(F.orientationLabel(false), /16:9/);
});

test('fmtCountdown: due, minutes, hours, days', () => {
  assert.equal(F.fmtCountdown(0), '0:00');
  assert.equal(F.fmtCountdown(-5000), '0:00');
  assert.equal(F.fmtCountdown(45 * 1000), '0:45');
  assert.equal(F.fmtCountdown((14 * 60 + 32) * 1000), '14:32');
  assert.equal(F.fmtCountdown(((2 * 3600) + (14 * 60) + 9) * 1000), '2:14:09');
  assert.equal(F.fmtCountdown(((5 * 86400) + (3 * 3600)) * 1000), '5d 3h');
});

test('splitDateTime: inverse of parseDateTime (round-trips through the pickers)', () => {
  const ms = F.parseDateTime('2026-07-04', '7', '30', 'PM');
  assert.deepEqual(F.splitDateTime(ms), { date: '2026-07-04', hour: '7', min: '30', ap: 'PM' });
  const midnight = F.parseDateTime('2026-01-09', '12', '05', 'AM');
  assert.deepEqual(F.splitDateTime(midnight), { date: '2026-01-09', hour: '12', min: '05', ap: 'AM' });
  const noon = F.parseDateTime('2026-12-25', '12', '00', 'PM');
  assert.deepEqual(F.splitDateTime(noon), { date: '2026-12-25', hour: '12', min: '00', ap: 'PM' });
  // and the full round trip back to the same instant
  const s = F.splitDateTime(ms);
  assert.equal(F.parseDateTime(s.date, s.hour, s.min, s.ap), ms);
});

test('fileName: just the file name, for either slash style; empty stays empty', () => {
  // Setup screen shows the chosen slate by name — a full path in a small box was
  // unreadable and made the three boxes look alike (Justin, 2026-09-03).
  assert.strictEqual(F.fileName('/Users/j/Pictures/slate-wide.png'), 'slate-wide.png');
  assert.strictEqual(F.fileName('C:\\Slates\\vertical.jpg'), 'vertical.jpg');
  assert.strictEqual(F.fileName('waiting.mp3'), 'waiting.mp3');
  assert.strictEqual(F.fileName(''), '');
  assert.strictEqual(F.fileName(null), '');
});
