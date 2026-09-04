'use strict';
// 2026-09-04 audit, engine lifecycle + detection items.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast, STALL_TIMEOUT_MS } = require('../engine/broadcast');
const { buildBroadcastArgs } = require('../engine/timeline');

function engine(over = {}) {
  let t = 0;
  const b = new Broadcast({ videoPath: 'x', outUrl: 'y', stallTimeoutMs: 0, now: () => t, leadSec: 0, ...over });
  b._playing = true;
  const feed = (sec, speed) => { t = sec * 1000; b._onProgressData(`out_time_us=${sec * 1e6}\nspeed=${speed}x\nprogress=continue\n`); };
  return { b, feed, setT: (sec) => { t = sec * 1000; } };
}

// (43) a class that runs at 0.95x for an hour ended 3 min late with no warning
test("'slow' also fires for a MILD sustained slowdown (under 0.985x for 5 minutes), flagged mild", () => {
  const { b, feed } = engine();
  const slow = []; b.on('slow', (e) => slow.push(e));
  feed(1, '1.00'); feed(60, '0.97'); feed(200, '0.97'); feed(300, '0.97');
  assert.equal(slow.length, 0, 'not before the 5-minute window');
  feed(365, '0.97');
  assert.equal(slow.length, 1); assert.equal(slow[0].mild, true); assert.ok(Math.abs(slow[0].speed - 0.97) < 1e-9);
});
test('the sharp signal (0.9x for 30 s) is unchanged and is not mild', () => {
  const { b, feed } = engine();
  const slow = []; b.on('slow', (e) => slow.push(e));
  feed(1, '0.67'); feed(35, '0.67');
  assert.equal(slow.length, 1); assert.equal(!!slow[0].mild, false);
});

// (47) the stall message named the configured timeout, not the real dead time
test('the stall failure reports how long the picture was actually frozen', () => {
  const { b, feed, setT } = engine({ stallTimeoutMs: 20000 });
  let reason = ''; b.on('failed', (e) => { reason = e.reason; });
  feed(1, '1.0');
  setT(1 + 47);            // 47 s with no progress
  b._proc = { kill() {} };
  b._checkStall();
  assert.match(reason, /47 seconds/, reason);
});

// (24) nothing detected a broadcast that was live but black or silent
test("a black-picture detection line from the engine emits 'blank' once the class is under way", () => {
  const { b, feed } = engine({ leadSec: 120 });
  const ev = []; b.on('blank', (e) => ev.push(e));
  feed(1, '1.0');
  b._onStderr('[Parsed_metadata_5 @ 0x1] lavfi.black_start=3.5\n');
  assert.equal(ev.length, 0, 'during the slate lead-in a dark picture is not the class');
  feed(130, '1.0');
  b._onStderr('[Parsed_metadata_5 @ 0x1] lavfi.black_start=128.2\n');
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'black');
  b._onStderr('[Parsed_metadata_5 @ 0x1] lavfi.black_end=140.0\n');
  assert.equal(ev.length, 2); assert.equal(ev[1].kind, 'black'); assert.equal(ev[1].ended, true);
});
test("silence is reported the same way", () => {
  const { b, feed } = engine({ leadSec: 0 });
  const ev = []; b.on('blank', (e) => ev.push(e));
  feed(30, '1.0');
  b._onStderr('[Parsed_ametadata_9 @ 0x1] lavfi.silence_start=25.0\n');
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'silent');
});

// (6) stop() hard-killed ffmpeg: send the engine its own quit command first
test('stop() ends a real encode GRACEFULLY: the engine finishes the file itself and exits 0, unsignalled', async () => {
  // The pacing filter drains its buffer at real time, so a clean stop takes a
  // few seconds — that is the point: killing it early truncates the stream.
  const FIX = path.join(__dirname, 'fixtures'); const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, 'graceful.flv');
  const b = new Broadcast({ videoPath: path.join(FIX, 'class.mp4'), leadSec: 0, slateImage: '', slateMusic: '', outUrl: out });
  await new Promise((res, rej) => { b.on('playing', res); b.on('failed', (e) => rej(new Error(e.reason))); b.start(); });
  const t0 = Date.now();
  await b.stop();
  const secs = (Date.now() - t0) / 1000;
  assert.equal(b._proc.signalCode, null, 'no signal was needed (signal=' + b._proc.signalCode + ', ' + secs.toFixed(1) + 's)');
  assert.equal(b._proc.exitCode, 0, 'clean exit');
  assert.ok(secs < 12, 'and it did not hang: ' + secs.toFixed(1) + 's');
  assert.ok(fs.statSync(out).size > 10000, 'the partial recording was properly finished');
});
test('the engine keeps stdin open for the quit command (no -nostdin)', () => {
  assert.ok(!buildBroadcastArgs({ videoPath: '/v.mp4', outUrl: 'x' }).includes('-nostdin'));
});
