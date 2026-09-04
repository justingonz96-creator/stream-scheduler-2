'use strict';
// 2026-09-04 audit: a multi-hundred-MB update download was unthrottled and
// ungated — it could compete with a live class's bandwidth, hidden from the
// operator. Now: the download only starts when it is SAFE (no class live or
// imminent), is retried when the schedule changes, and updates are re-checked
// periodically so an always-on machine does not sit on a broken version.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../store/updater');

function fakeUpdater() {
  const u = new EventEmitter();
  u.downloads = 0; u.checks = 0; u.autoDownload = true;
  u.downloadUpdate = async () => { u.downloads++; };
  u.checkForUpdates = async () => { u.checks++; return null; };
  u.quitAndInstall = () => {};
  return u;
}
function fakeScheduler(safe) {
  const listeners = [];
  return {
    safe, isSafeToUpdate() { return this.safe ? { safe: true } : { safe: false, reason: 'A class is on air.' }; },
    onChanged: (fn) => listeners.push(fn), fire: () => listeners.forEach((fn) => fn([])),
    start() {}, shutdown() {},
  };
}

test('an available update is NOT downloaded while a class is live or imminent', () => {
  const au = fakeUpdater(); const sch = fakeScheduler(false);
  createUpdateController({ autoUpdater: au, scheduler: sch });
  au.emit('update-available', { version: '9.9.9' });
  assert.equal(au.downloads, 0);
  assert.equal(au.autoDownload, false, 'the controller must switch electron-updater to manual downloads');
});
test('…and the download starts by itself once the schedule becomes safe (exactly once)', () => {
  const au = fakeUpdater(); const sch = fakeScheduler(false);
  createUpdateController({ autoUpdater: au, scheduler: sch });
  au.emit('update-available', { version: '9.9.9' });
  sch.safe = true; sch.fire(); sch.fire();
  assert.equal(au.downloads, 1);
});
test('when it is already safe, the download starts immediately', () => {
  const au = fakeUpdater(); const sch = fakeScheduler(true);
  createUpdateController({ autoUpdater: au, scheduler: sch });
  au.emit('update-available', { version: '9.9.9' });
  assert.equal(au.downloads, 1);
});
test('the operator can see it is waiting: state says available + why it is not downloading yet', () => {
  const au = fakeUpdater(); const sch = fakeScheduler(false);
  let last = null;
  const c = createUpdateController({ autoUpdater: au, scheduler: sch, onChanged: (s) => { last = s; } });
  au.emit('update-available', { version: '9.9.9' });
  assert.equal(last.phase, 'available');
  assert.match(last.reason, /on air/i);
  assert.equal(c.getState().version, '9.9.9');
});
test('updates are re-checked on a timer (injectable), not only at launch', () => {
  const au = fakeUpdater(); const sch = fakeScheduler(true);
  const timers = [];
  const c = createUpdateController({ autoUpdater: au, scheduler: sch, setInterval: (fn, ms) => { timers.push({ fn, ms }); return 1; } });
  c.start();
  assert.equal(au.checks, 1, 'checked at launch');
  assert.equal(timers.length, 1, 'a periodic re-check is armed');
  assert.ok(timers[0].ms >= 3600000 && timers[0].ms <= 24 * 3600000, 'hours, not minutes: ' + timers[0].ms);
  timers[0].fn();
  assert.equal(au.checks, 2);
});
