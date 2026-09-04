'use strict';
// 2026-09-04 audit: a class typed into the DST spring-forward gap silently shifted an hour.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDateTime, dstGapWarning } = require('../renderer/format');

test('dstGapWarning names a local time that does not exist on that day', () => {
  // Find a spring-forward day in this timezone within a year; skip cleanly if the zone has no DST.
  let gapDay = null;
  const start = new Date(); start.setHours(12, 0, 0, 0);
  for (let d = 0; d < 400 && !gapDay; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    const probe = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 2, 30, 0, 0);
    if (probe.getHours() !== 2) gapDay = day;
  }
  if (!gapDay) return;   // no DST here
  const ds = gapDay.getFullYear() + '-' + String(gapDay.getMonth() + 1).padStart(2, '0') + '-' + String(gapDay.getDate()).padStart(2, '0');
  assert.match(dstGapWarning(ds, '2', '30', 'AM') || '', /clocks|does not exist|skip/i);
  assert.equal(dstGapWarning(ds, '9', '30', 'AM'), '', 'a normal time on the same day is fine');
  assert.ok(parseDateTime(ds, '9', '30', 'AM') > 0);
});
