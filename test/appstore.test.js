'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULT_SETTINGS, createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');

function tmp(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-app-')), name); }

test('settings: get returns defaults, save merges and persists', () => {
  const file = tmp('settings.json');
  const s = createSettingsStore({ file });
  assert.deepEqual(s.get(), DEFAULT_SETTINGS);
  const merged = s.save({ videoBitrate: 4500, portalEmail: 'e@x.com' });
  assert.equal(merged.videoBitrate, 4500);
  assert.equal(merged.portalEmail, 'e@x.com');
  assert.equal(merged.fadeMs, DEFAULT_SETTINGS.fadeMs);          // untouched default preserved
  assert.equal(createSettingsStore({ file }).get().videoBitrate, 4500);   // persisted across instances
});

test('settings: save never writes a password into settings.json', () => {
  const file = tmp('settings.json');
  const s = createSettingsStore({ file });
  s.save({ portalEmail: 'e@x.com', password: 'nope', portalPassword: 'also-nope' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('nope'), 'no password may reach settings.json');
  assert.equal(s.get().password, undefined);
  assert.equal(s.get().portalPassword, undefined);
});

test('buildPortalConfig: total, maps settings + secret, blank apiBase allowed', () => {
  const settings = { portalEmail: 'e@x.com', portalApiKey: 'K', portalApiBase: '' };
  const secrets = { get: (k) => (k === 'portalPassword' ? 'pw' : null) };
  assert.deepEqual(buildPortalConfig(settings, secrets), { email: 'e@x.com', password: 'pw', apiKey: 'K', apiBase: '' });
  // missing everything → all empty strings, never throws
  assert.deepEqual(buildPortalConfig({}, { get: () => null }), { email: '', password: '', apiKey: '', apiBase: '' });
});

test('schedule store: load [] when absent, round-trips events', () => {
  const file = tmp('schedule.json');
  const st = createScheduleStore({ file });
  assert.deepEqual(st.load(), []);
  st.save([{ id: 'a', title: 'x' }]);
  assert.deepEqual(createScheduleStore({ file }).load(), [{ id: 'a', title: 'x' }]);
});
