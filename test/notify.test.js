'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { notificationsFor } = require('../store/notify');

const ev = (o) => ({ id: 'e1', title: 'Monday Ride', status: 'pending', ...o });

test('a class turning failed raises one notification, once', () => {
  const n = notificationsFor([ev()], [ev({ status: 'failed', outcome: 'Could not start: x' })]);
  assert.equal(n.length, 1); assert.equal(n[0].kind, 'failed'); assert.match(n[0].body, /Monday Ride/); assert.match(n[0].body, /Could not start/);
  assert.equal(notificationsFor([ev({ status: 'failed' })], [ev({ status: 'failed' })]).length, 0, 'not repeated on every snapshot');
});
test('a class turning missed raises one', () => {
  assert.equal(notificationsFor([ev()], [ev({ status: 'missed', outcome: 'Missed' })])[0].kind, 'missed');
});
test('a slow flag appearing raises one; staying slow does not', () => {
  const a = notificationsFor([ev({ status: 'playing' })], [ev({ status: 'playing', slow: { speed: 0.67 } })]);
  assert.equal(a.length, 1); assert.match(a[0].body, /0\.67/);
  assert.equal(notificationsFor([ev({ status: 'playing', slow: { speed: 0.67 } })], [ev({ status: 'playing', slow: { speed: 0.6 } })]).length, 0);
});
test('first snapshot after launch: existing history is NOT re-announced, but a new failure is', () => {
  assert.equal(notificationsFor(null, [ev({ status: 'failed' }), ev({ id: 'e2', status: 'done' })]).length, 1, 'no prev = announce failures present now (the app just found them)');
});
test('nothing for normal transitions', () => {
  assert.equal(notificationsFor([ev()], [ev({ status: 'playing' })]).length, 0);
  assert.equal(notificationsFor([ev({ status: 'playing' })], [ev({ status: 'done' })]).length, 0);
});
