'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../store/updater');

function fakeScheduler(safe = { safe: true, reason: '' }) {
  const listeners = new Set();
  return {
    isSafeToUpdate: () => safe,
    onChanged: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    shutdown: () => {},
    start: () => {},
    _fire: () => { for (const f of listeners) f([]); },
    _setSafe: (v) => { safe = v; },
  };
}

test('tracks autoUpdater lifecycle events into phase/version/error', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const sched = fakeScheduler();
  const seen = [];
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched, onChanged: (s) => seen.push(s) });

  au.emit('checking-for-update');
  assert.equal(ctl.getState().phase, 'checking');
  au.emit('update-available', { version: '9.9.9' });
  assert.equal(ctl.getState().phase, 'available');
  assert.equal(ctl.getState().version, '9.9.9');
  au.emit('download-progress', { percent: 50 });
  assert.equal(ctl.getState().phase, 'downloading');
  au.emit('update-downloaded', { version: '9.9.9' });
  assert.equal(ctl.getState().phase, 'downloaded');
  assert.ok(seen.length >= 4);
});

test('error event carries a message', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler() });
  au.emit('error', new Error('network down'));
  assert.equal(ctl.getState().phase, 'error');
  assert.equal(ctl.getState().error, 'network down');
});

test('getState reflects the scheduler safety gate live', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const sched = fakeScheduler({ safe: false, reason: 'a broadcast is live right now' });
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched });
  const s = ctl.getState();
  assert.equal(s.safe, false);
  assert.equal(s.reason, 'a broadcast is live right now');
});

test('scheduler onChanged pushes a fresh state without a new updater event', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const sched = fakeScheduler();
  let pushes = 0;
  createUpdateController({ autoUpdater: au, scheduler: sched, onChanged: () => { pushes++; } });
  sched._fire();
  assert.equal(pushes, 1);
});

test('install refuses when unsafe, without touching the scheduler or autoUpdater', () => {
  let shutdownCalled = false, quitCalled = false;
  const au = new EventEmitter();
  au.quitAndInstall = () => { quitCalled = true; };
  au.checkForUpdates = async () => {};
  const sched = fakeScheduler({ safe: false, reason: 'a broadcast is scheduled to start soon' });
  sched.shutdown = () => { shutdownCalled = true; };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched });
  au.emit('update-downloaded', { version: '1.2.3' });
  const res = ctl.install();
  assert.deepEqual(res, { ok: false, error: 'a broadcast is scheduled to start soon' });
  assert.equal(shutdownCalled, false);
  assert.equal(quitCalled, false);
});

test('install refuses when safe but nothing has been downloaded yet', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler() });
  const res = ctl.install();
  assert.equal(res.ok, false);
  assert.match(res.error, /no update/i);
});

test('install shuts the scheduler down then quits+installs when safe and downloaded', () => {
  let shutdownCalled = false, quitArgs = null;
  const au = new EventEmitter();
  au.quitAndInstall = (silent, force) => { quitArgs = [silent, force]; };
  au.checkForUpdates = async () => {};
  const sched = fakeScheduler({ safe: true, reason: '' });
  sched.shutdown = () => { shutdownCalled = true; };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched });
  au.emit('update-downloaded', { version: '1.2.3' });
  const res = ctl.install();
  assert.equal(res.ok, true);
  assert.equal(shutdownCalled, true);
  assert.deepEqual(quitArgs, [true, true]);
});

test('a failed install resumes the scheduler and flags the error as after-install', () => {
  let startCalled = false;
  const au = new EventEmitter();
  au.quitAndInstall = () => { au.emit('error', new Error('Code signature did not pass validation')); };
  au.checkForUpdates = async () => {};
  const sched = fakeScheduler();
  sched.start = () => { startCalled = true; };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched });
  au.emit('update-downloaded', { version: '2.2.1' });
  const res = ctl.install();
  assert.equal(res.ok, true);
  assert.equal(startCalled, true);
  const s = ctl.getState();
  assert.equal(s.phase, 'error');
  assert.equal(s.afterInstall, true);
  assert.match(s.error, /signature/i);
});

test('an error before any install attempt is not flagged as after-install, and never touches the scheduler', () => {
  let startCalled = false;
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const sched = fakeScheduler();
  sched.start = () => { startCalled = true; };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: sched });
  au.emit('error', new Error('offline'));
  assert.equal(startCalled, false);
  assert.equal(ctl.getState().afterInstall, false);
});

test('update-downloaded captures the cached file path, and it survives into a later failed-install error', () => {
  const au = new EventEmitter();
  au.quitAndInstall = () => { au.emit('error', new Error('Code signature did not pass validation')); };
  au.checkForUpdates = async () => {};
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler() });
  au.emit('update-downloaded', { version: '2.2.1', downloadedFile: '/Users/x/Library/Caches/stream-scheduler-2-updater/pending/app.zip' });
  assert.equal(ctl.getState().downloadedFile, '/Users/x/Library/Caches/stream-scheduler-2-updater/pending/app.zip');
  ctl.install();
  assert.equal(ctl.getState().downloadedFile, '/Users/x/Library/Caches/stream-scheduler-2-updater/pending/app.zip');
});

test('showDownload reveals the cached file in Finder when one has been downloaded', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  let revealedPath = null;
  const shell = { showItemInFolder: (p) => { revealedPath = p; } };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler(), shell });
  au.emit('update-downloaded', { version: '2.2.1', downloadedFile: '/tmp/app.zip' });
  const res = ctl.showDownload();
  assert.equal(res.ok, true);
  assert.equal(revealedPath, '/tmp/app.zip');
});

test('showDownload refuses when nothing has been downloaded yet', () => {
  const au = new EventEmitter(); au.quitAndInstall = () => {}; au.checkForUpdates = async () => {};
  const shell = { showItemInFolder: () => { throw new Error('should not be called'); } };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler(), shell });
  const res = ctl.showDownload();
  assert.equal(res.ok, false);
  assert.match(res.error, /nothing/i);
});

test('start() calls checkForUpdates and surfaces a rejected promise as an error state', async () => {
  const au = new EventEmitter();
  au.quitAndInstall = () => {};
  let called = false;
  au.checkForUpdates = async () => { called = true; throw new Error('offline'); };
  const ctl = createUpdateController({ autoUpdater: au, scheduler: fakeScheduler() });
  ctl.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(called, true);
  assert.equal(ctl.getState().phase, 'error');
  assert.equal(ctl.getState().error, 'offline');
});
