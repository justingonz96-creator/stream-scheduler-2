'use strict';
// Every internal message ([cache] copy failed, [sched] start failed…) went to
// console.log, which a packaged app sends nowhere — three separate incidents
// were reverse-engineered blind (2026-09-03/04). A small rolling file fixes that.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogFile } = require('../store/logfile');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-log-'));

test('lines are appended with a timestamp, creating the folder if needed', () => {
  const dir = path.join(tmp(), 'nested', 'logs');
  const lf = createLogFile({ file: path.join(dir, 'app.log'), now: () => new Date('2026-09-04T12:00:00Z') });
  lf.write('[cache] copy failed for class.mp4: EIO');
  lf.write('[sched] start failed, retrying once');
  const lines = fs.readFileSync(lf.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^2026-09-04T12:00:00.000Z \[cache\] copy failed/);
});

test('rolls over when it outgrows the cap, keeping one previous file', () => {
  const dir = tmp();
  const lf = createLogFile({ file: path.join(dir, 'app.log'), maxBytes: 300 });
  for (let i = 0; i < 40; i++) lf.write('line ' + i + ' ' + 'x'.repeat(20));
  const cur = fs.statSync(lf.path).size;
  assert.ok(cur <= 300 + 80, 'current file stays near the cap, was ' + cur);
  assert.ok(fs.existsSync(lf.path + '.1'), 'previous file kept');
  assert.match(fs.readFileSync(lf.path, 'utf8'), /line 39/, 'newest line is in the current file');
});

test('a write failure never throws into the app', () => {
  const lf = createLogFile({ file: '/dev/null/impossible/app.log' });
  assert.doesNotThrow(() => lf.write('hello'));
});
