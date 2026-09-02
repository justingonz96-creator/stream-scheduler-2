'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseContentItem, pickOccurrence, matchOccurrence, isVertical } = require('../portal/occurrences');

const item = (schedule, medium) => ({ data: { medium, schedule } });
const occ = (over = {}) => ({
  guid: 'sched-' + (over.n || 1),
  controlStation: { guid: 'station-' + (over.n || 1), name: over.name || null },
  type: 'live',
  available: { start: over.start, end: over.end },
});

test('parseContentItem: wrapped or bare, medium, malformed entries skipped', () => {
  const parsed = parseContentItem(item([occ({ n: 1, start: 100, end: 200 }), 'junk', { guid: 'x' }], 'reflect'));
  assert.equal(parsed.medium, 'reflect');
  assert.equal(parsed.occurrences.length, 2);          // 'junk' (non-object) skipped; {guid:'x'} kept (station missing → filtered later by pick)
  assert.deepEqual(parsed.occurrences[0], {
    scheduleGuid: 'sched-1', stationGuid: 'station-1', stationName: null,
    type: 'live', start: 100, end: 200,
  });
  const bare = parseContentItem({ medium: 'standard', schedule: [] });
  assert.equal(bare.medium, 'standard');
  assert.deepEqual(bare.occurrences, []);
});

test('pickOccurrence: in-window wins, latest start among in-window', () => {
  const NOW = 10000;
  const a = { scheduleGuid: 'a', stationGuid: 'A', start: 4000, end: 20000 };   // in window
  const b = { scheduleGuid: 'b', stationGuid: 'B', start: 8000, end: 20000 };   // in window, later start
  const c = { scheduleGuid: 'c', stationGuid: 'C', start: 500000, end: 600000 }; // far future
  assert.equal(pickOccurrence([a, c, b], NOW).scheduleGuid, 'b');
});

test('pickOccurrence: a future occurrence inside the forward grace is NOT chosen over the one live now', () => {
  // Regression: the 2h forward GRACE admits an occurrence that has not started
  // yet; picking the "latest start" would then choose it over the live one and
  // stream to the wrong studio. The one that has actually started must win.
  const NOW = 10000;
  const live = { scheduleGuid: 'live', stationGuid: 'L', start: 9000, end: 20000 };            // started, live now
  const soon = { scheduleGuid: 'soon', stationGuid: 'S', start: NOW + 3600, end: NOW + 10000 }; // starts in 1h (in-window via grace)
  assert.equal(pickOccurrence([live, soon], NOW).scheduleGuid, 'live', 'never the not-yet-live studio');
  assert.equal(pickOccurrence([soon], NOW).scheduleGuid, 'soon', 'but if none have started, the upcoming one is still valid');
});

test('pickOccurrence: GRACE stretches the window 7200s both sides; missing end defaults start+14400', () => {
  const NOW = 100000;
  const early = { scheduleGuid: 'e', stationGuid: 'E', start: NOW + 7000 };     // starts in 7000s — inside grace
  assert.equal(pickOccurrence([early], NOW).scheduleGuid, 'e');
  const stale = { scheduleGuid: 's', stationGuid: 'S', start: NOW - 14400 - 7200 - 1 };  // window (incl. grace) just expired
  const near = { scheduleGuid: 'n', stationGuid: 'N', start: NOW + 50000 };
  assert.equal(pickOccurrence([stale, near], NOW).scheduleGuid, 's', 'nearest-by-start when none in window');
});

test('pickOccurrence: candidates need BOTH guids; untimed fall back to first candidate', () => {
  const noStation = { scheduleGuid: 'x', stationGuid: null, start: 1 };
  const untimed1 = { scheduleGuid: 'u1', stationGuid: 'U1', start: undefined };
  const untimed2 = { scheduleGuid: 'u2', stationGuid: 'U2', start: undefined };
  assert.equal(pickOccurrence([noStation, untimed1, untimed2], 500).scheduleGuid, 'u1');
  assert.equal(pickOccurrence([noStation], 500), null);
  assert.equal(pickOccurrence([], 500), null);
});

test('matchOccurrence: exact scheduleGuid or null', () => {
  const a = { scheduleGuid: 'aaa', stationGuid: 'A' };
  assert.equal(matchOccurrence([a], 'aaa'), a);
  assert.equal(matchOccurrence([a], 'bbb'), null);
  assert.equal(matchOccurrence([a], ''), null);
});

test('isVertical: reflect (any case) yes; everything else no', () => {
  assert.equal(isVertical('reflect'), true);
  assert.equal(isVertical('  Reflect '), true);
  assert.equal(isVertical('standard'), false);
  assert.equal(isVertical(null), false);
  assert.equal(isVertical(undefined), false);
});

test('parseContentItem: missing available → start/end are null and SURVIVE JSON round-trip', () => {
  const parsed = parseContentItem({ schedule: [{ guid: 'g1', controlStation: { guid: 's1' } }] });
  assert.equal(parsed.occurrences[0].start, null);
  assert.equal(parsed.occurrences[0].end, null);
  const round = JSON.parse(JSON.stringify(parsed.occurrences[0]));
  assert.ok('start' in round && 'end' in round, 'keys must survive serialization (1.x contract)');
});

test('pickOccurrence: end present but 0 falls back to start+14400 (|| semantics are law)', () => {
  // Discriminating construction: with the correct || law, z's end:0 falls back to
  // start+14400, so at NOW=20000 BOTH are in-window and z wins on latest start.
  // If the || were ever "cleaned up" to ??, z's window would end at 0+GRACE=7200,
  // z would drop out, and 'other' would win — flipping this assertion.
  const NOW = 20000;
  const z = { scheduleGuid: 'z', stationGuid: 'Z', start: 10000, end: 0 };
  const other = { scheduleGuid: 'other', stationGuid: 'O', start: 9000, end: 40000 };
  assert.equal(pickOccurrence([z, other], NOW).scheduleGuid, 'z');
});
