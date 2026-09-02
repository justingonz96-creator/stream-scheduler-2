'use strict';
// Pin the timezone BEFORE anything reads a Date, so the DST arithmetic is
// deterministic. `node --test` runs each test file in its own process, so this
// only affects this file. America/New_York observes US Daylight Saving.
process.env.TZ = 'America/New_York';

const { test } = require('node:test');
const assert = require('node:assert');
const { renewWeekly, normalizeEvent } = require('../schedule/model');

test('weekly renewal preserves the wall-clock start time across the spring-forward DST change', () => {
  // Mon Mar 3 2025 6:00am ET. The following week spans spring-forward (Sun Mar 9
  // 2:00am → 3:00am), so it is only 167 hours long. A fixed 7×86400000 ms add
  // would land the class at 7:00am; the calendar-correct renewal keeps it at
  // 6:00am on Mon Mar 10.
  const fireAt = new Date(2025, 2, 3, 6, 0, 0).getTime();   // month 2 = March
  // Sanity: this test only proves anything in a DST-observing zone. If the TZ pin
  // did not take effect (e.g. a UTC runner), the naive add lands at 6:00, this
  // fails loudly, and we know the test is not exercising the DST path.
  assert.equal(new Date(fireAt + 7 * 86400000).getHours(), 7, 'naive +168h lands at 7am (spring-forward week is 167h)');

  const ev = normalizeEvent({ id: 'wk', fireAt, repeatWeekly: true });
  const nv = renewWeekly(ev, fireAt + 1000, () => 'NEW');
  const d = new Date(nv.fireAt);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 10, 'seven calendar days later');
  assert.equal(d.getHours(), 6, 'still 6am wall-clock, not shifted by the DST hour');
  assert.equal(d.getMinutes(), 0);
});

test('weekly renewal keeps the same weekday and time on a normal (non-DST) week', () => {
  const fireAt = new Date(2025, 5, 2, 18, 30, 0).getTime();   // Mon Jun 2 2025 6:30pm ET
  const ev = normalizeEvent({ id: 'wk', fireAt, repeatWeekly: true });
  const nv = renewWeekly(ev, fireAt + 1000, () => 'NEW');
  const d = new Date(nv.fireAt);
  assert.equal(d.getDate(), 9, 'a normal week is a clean +7 days');
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 30);
});
