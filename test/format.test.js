'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../renderer/format');

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
