'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appDataDir } = require('../store/appdata');
const { readJson, readJsonResilient, writeJsonAtomic } = require('../store/jsonstore');

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

test('readJsonResilient: missing → fallback; corrupt+bak → bak; corrupt+no bak → throws ECORRUPT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  // missing → fallback (a legitimate fresh start)
  assert.deepEqual(readJsonResilient(path.join(dir, 'nope.json'), ['fb']), ['fb']);
  // corrupt primary but a good rolling .bak → recover the prior generation
  const f = path.join(dir, 'x.json');
  writeJsonAtomic(f, { v: 1 });
  writeJsonAtomic(f, { v: 2 });          // now .bak holds { v: 1 }
  fs.writeFileSync(f, '{bad');           // clobber the primary
  assert.deepEqual(readJsonResilient(f, null), { v: 1 }, 'recovered previous good generation from .bak');
  // corrupt with no usable backup → throw, never the empty fallback
  const g = path.join(dir, 'g.json');
  fs.writeFileSync(g, '{bad and alone');
  assert.throws(() => readJsonResilient(g, null), (e) => e && e.code === 'ECORRUPT');
});

test('writeJsonAtomic keeps a rolling .bak of the previous generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  const f = path.join(dir, 's.json');
  writeJsonAtomic(f, { v: 1 });
  assert.equal(fs.existsSync(f + '.bak'), false, 'no .bak on the very first write');
  writeJsonAtomic(f, { v: 2 });
  assert.deepEqual(readJson(f + '.bak', null), { v: 1 }, 'bak holds the prior version');
  assert.deepEqual(readJson(f, null), { v: 2 });
});
