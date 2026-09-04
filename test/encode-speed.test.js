'use strict';
// ffmpeg reports its own speed on the -progress pipe ("speed=0.67x"). Below 1x
// the stream is falling behind the clock: viewers see stutter, and the class
// ends late. The engine must expose that so the operator is warned LIVE and the
// class history records what actually happened, instead of the platform graph
// being the only evidence (2026-09-04).
const { test } = require('node:test');
const assert = require('node:assert');
const { Broadcast } = require('../engine/broadcast');

function engine(over = {}) {
  let t = 0;
  const b = new Broadcast({ videoPath: 'x', outUrl: 'y', stallTimeoutMs: 0, now: () => t, slowWindowMs: 30000, ...over });
  b._playing = true;                       // skip the real spawn: drive the parser directly
  const feed = (sec, speed) => { t = sec * 1000; b._onProgressData(`out_time_us=${sec * 1e6}\nspeed=${speed}x\nprogress=continue\n`); };
  return { b, feed };
}

test('speed lines are parsed and summarised (last / min / avg)', () => {
  const { b, feed } = engine();
  feed(1, '1.00'); feed(2, '0.80'); feed(3, '0.60');
  const s = b.speedStats();
  assert.equal(s.last, 0.6); assert.equal(s.min, 0.6);
  assert.ok(Math.abs(s.avg - 0.8) < 1e-9, 'avg ' + s.avg);
  assert.equal(s.samples, 3);
});

test("'slow' fires once after speed stays under 0.9x for the whole window — not on a blip", () => {
  const { b, feed } = engine();
  const slow = []; b.on('slow', (e) => slow.push(e));
  feed(1, '1.00');
  feed(2, '0.67'); feed(10, '0.67'); feed(20, '0.67');
  assert.equal(slow.length, 0, 'not yet — under the window');
  feed(33, '0.67');
  assert.equal(slow.length, 1, 'fired after 30s continuously slow');
  assert.ok(Math.abs(slow[0].speed - 0.67) < 1e-9);
  feed(40, '0.67'); feed(70, '0.67');
  assert.equal(slow.length, 1, 'does not nag every tick');
});

test('a momentary dip that recovers never fires', () => {
  const { b, feed } = engine();
  let fired = 0; b.on('slow', () => fired++);
  feed(1, '1.00'); feed(5, '0.50'); feed(10, '1.00'); feed(45, '1.00');
  assert.equal(fired, 0);
});

test("recovery emits 'speedok' and re-arms so a second slowdown is reported again", () => {
  const { b, feed } = engine();
  const ev = []; b.on('slow', () => ev.push('slow')); b.on('speedok', () => ev.push('ok'));
  feed(1, '0.6'); feed(35, '0.6');           // slow
  feed(40, '1.0');                           // recovered
  feed(50, '0.6'); feed(85, '0.6');          // slow again
  assert.deepEqual(ev, ['slow', 'ok', 'slow']);
});

test('no speed lines → stats are empty, nothing fires', () => {
  const { b } = engine();
  let fired = 0; b.on('slow', () => fired++);
  b._onProgressData('out_time_us=1000000\nprogress=continue\n');
  assert.equal(b.speedStats().samples, 0); assert.equal(fired, 0);
});

// Real ffmpeg, real fixture: the speed= lines on the -progress pipe must be
// parsed from the genuine format, not just the lines the tests above typed.
const fs = require('node:fs');
const path = require('node:path');
test('real ffmpeg run yields speed samples', async () => {
  const FIX = path.join(__dirname, 'fixtures'); const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
  const b = new Broadcast({ videoPath: path.join(FIX, 'class.mp4'), leadSec: 0, fadeSec: 0, slateImage: '', slateMusic: '',
    outUrl: path.join(TMP, `speed-${Date.now()}.flv`) });
  await new Promise((res, rej) => { b.on('ended', res); b.on('failed', (e) => rej(new Error(e.reason))); b.start(); });
  const s = b.speedStats();
  assert.ok(s.samples > 0, 'no speed samples parsed from a real run');
  assert.ok(s.last > 0 && s.min > 0, JSON.stringify(s));
});
