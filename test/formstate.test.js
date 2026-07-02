'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeFormPhase, pickedSummary } = require('../renderer/formstate');

const S = (o = {}) => Object.assign({ filePath: '', durationSec: 0, fireAt: 0, contentItemGuid: '', linkChecked: false }, o);

test('before a video is picked: step1 spotlight, rest dim, cannot save', () => {
  const p = computeFormPhase(S());
  assert.equal(p.step1, 'spotlight');
  assert.equal(p.rest, 'dim');
  assert.equal(p.canSave, false);
  assert.ok(p.reasons.some((r) => /video/i.test(r)));
});

test('after a video is picked: step1 collapses, rest activates', () => {
  const p = computeFormPhase(S({ filePath: '/v.mp4', durationSec: 1800 }));
  assert.equal(p.step1, 'collapsed');
  assert.equal(p.rest, 'active');
});

test('canSave requires video + time + a resolved class link', () => {
  const base = { filePath: '/v.mp4', durationSec: 1800 };
  assert.equal(computeFormPhase(S({ ...base, fireAt: 0 })).canSave, false);                                   // no time
  assert.equal(computeFormPhase(S({ ...base, fireAt: 123 })).canSave, false);                                 // no link
  assert.ok(computeFormPhase(S({ ...base, fireAt: 123 })).reasons.some((r) => /class link/i.test(r)));
  assert.equal(computeFormPhase(S({ ...base, fireAt: 123, contentItemGuid: 'ci', linkChecked: true })).canSave, true);
});

test('a link typed but not yet checked does not satisfy canSave', () => {
  const p = computeFormPhase(S({ filePath: '/v.mp4', durationSec: 1800, fireAt: 1, contentItemGuid: 'ci', linkChecked: false }));
  assert.equal(p.canSave, false);
});

test('pickedSummary: basename + mm:ss, empty when no video', () => {
  assert.equal(pickedSummary(S()), '');
  assert.equal(pickedSummary(S({ filePath: '/a/b/class-final.mp4', durationSec: 1830 })), 'class-final.mp4 · 30:30');
  assert.equal(pickedSummary(S({ filePath: 'C:\\vids\\x.mp4', durationSec: 5 })), 'x.mp4 · 0:05');
});
