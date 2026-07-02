'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appDataDir } = require('../store/appdata');
const { readJson, writeJsonAtomic } = require('../store/jsonstore');

test('appDataDir per platform', () => {
  const env = { HOME: '/Users/kim', APPDATA: 'C:\\Users\\kim\\AppData\\Roaming', XDG_CONFIG_HOME: '' };
  assert.equal(appDataDir('darwin', env), '/Users/kim/Library/Application Support/StreamScheduler2');
  assert.equal(appDataDir('win32', env), path.join('C:\\Users\\kim\\AppData\\Roaming', 'StreamScheduler2'));
  assert.equal(appDataDir('linux', env), path.join('/Users/kim', '.config', 'StreamScheduler2'));
  assert.equal(appDataDir('linux', { HOME: '/h', XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'StreamScheduler2'));
});

test('writeJsonAtomic + readJson round-trip, creating parent dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  const file = path.join(dir, 'deep', 'nested', 'settings.json');
  writeJsonAtomic(file, { a: 1, b: 'two' });
  assert.deepEqual(readJson(file, null), { a: 1, b: 'two' });
  assert.equal(fs.existsSync(file + '.tmp'), false, 'temp file cleaned up by rename');
});

test('readJson falls back on missing and on corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  assert.deepEqual(readJson(path.join(dir, 'nope.json'), { d: true }), { d: true });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(readJson(bad, []), []);
});
