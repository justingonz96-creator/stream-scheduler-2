'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Broadcast, STALL_TIMEOUT_MS } = require('../engine/broadcast');
const ffmpeg = require('../engine/ffmpeg');

const FIX = path.join(__dirname, 'fixtures');
const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const short = (over = {}) => ({
  videoPath: path.join(FIX, 'class.mp4'), leadSec: 2, fadeSec: 1,
  slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
  outUrl: path.join(TMP, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.flv`), ...over,
});

test('plays to the end: playing -> ended, file written', async () => {
  const b = new Broadcast(short());
  const events = [];
  b.on('playing', () => events.push('playing'));
  await new Promise((res, rej) => { b.on('ended', res); b.on('failed', e => rej(new Error(e.reason))); b.start(); });
  assert.deepEqual(events, ['playing']);
  assert.ok(fs.statSync(b.opts.outUrl).size > 10000, 'output has real content');
});

test('bad file → failed with plain-English reason, never ended', async () => {
  const b = new Broadcast(short({ videoPath: path.join(FIX, 'missing.mp4') }));
  const r = await new Promise((res) => { b.on('failed', res); b.on('ended', () => res({ reason: 'WRONGLY ENDED' })); b.start(); });
  assert.match(r.reason, /could not start/i);
});

test('stop(): clean kill, no failed event, offset math sane', async () => {
  const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
  let failed = false; b.on('failed', () => { failed = true; });
  await new Promise((res) => { b.on('playing', res); b.start(); });
  await new Promise(r => setTimeout(r, 1500));
  const off = b.videoOffsetSec();
  await b.stop();
  assert.equal(failed, false, 'a deliberate stop is not a failure');
  assert.ok(off > 0.5 && off < 10, `offset ${off}`);
});

test('mid-broadcast crash after playing → failed (resumable), never ended', async () => {
  const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
  let ended = false; b.on('ended', () => { ended = true; });
  const failed = new Promise((res) => b.on('failed', res));
  await new Promise((res) => { b.on('playing', res); b.start(); });
  b._proc.kill('SIGKILL');                      // simulate a mid-broadcast death
  const r = await failed;
  assert.equal(ended, false, 'a crash is never a clean end');
  assert.match(r.reason, /can be resumed/i);
});

test('spawn failure → failed with plain-English reason, no crash', async () => {
  const ffmpeg = require('../engine/ffmpeg');
  const orig = ffmpeg.ffmpegPath;
  ffmpeg.ffmpegPath = () => '/nonexistent/no-such-ffmpeg';
  try {
    const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
    const r = await new Promise((res) => { b.on('failed', res); b.start(); });
    assert.match(r.reason, /failed to launch/i);
  } finally { ffmpeg.ffmpegPath = orig; }
});

test('start() is one-shot — reuse throws instead of spawning a zombie', async () => {
  const b = new Broadcast(short({ videoPath: path.join(FIX, 'missing.mp4'), leadSec: 0, slateImage: null }));
  await new Promise((res) => { b.on('failed', res); b.start(); });
  assert.throws(() => b.start(), /one-shot/i);
});

test('a clip shorter than the 0.5s start-verify mark still reports ended, not failed', async () => {
  // A source that plays to completion in under VERIFY_AT_SEC (0.5s) exits code 0
  // but never latches "playing"; a clean exit must still count as ended.
  const clip = path.join(TMP, `tiny-${Date.now()}.mp4`);
  execFileSync(ffmpeg.ffmpegPath(), [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=0.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    clip,
  ]);
  const b = new Broadcast(short({ videoPath: clip, leadSec: 0, slateImage: null, slateMusic: null }));
  let played = false; b.on('playing', () => { played = true; });
  const outcome = await new Promise((res) => {
    b.on('ended', () => res('ended'));
    b.on('failed', (e) => res('failed: ' + e.reason));
    b.start();
  });
  assert.equal(played, false, 'too short to ever cross the 0.5s verify mark');
  assert.equal(outcome, 'ended', 'a clean exit is a finished broadcast, not a start failure');
});

test('stall watchdog default is 20s and is exported', () => {
  assert.equal(STALL_TIMEOUT_MS, 20000);
});

test('stall watchdog uses a MONOTONIC default clock, not the wall clock (Date.now)', () => {
  // If _now were Date.now, a forward NTP/clock step could manufacture a phantom
  // freeze and SIGKILL a healthy live stream. performance.now() (ms since origin)
  // is far below epoch time, so this cleanly proves the default is not the wall clock.
  const b = new Broadcast(short());   // no injected now → the real default
  const t1 = b._now();
  const t2 = b._now();
  assert.ok(t2 >= t1, 'monotonic: never goes backwards');
  assert.ok(t1 < 1e12, 'not epoch wall-clock time — a clock step cannot manufacture a stall');
});

test('stall watchdog (_checkStall): trips only after the full stall window, and fails RESUMABLY', () => {
  let T = 100000;
  const b = new Broadcast(short({ stallTimeoutMs: 1000, now: () => T }));
  b._playing = true; b._lastAdvanceAt = 100000;
  let failed = null; b.on('failed', (e) => { failed = e; });
  T = 100000 + 999; b._checkStall();
  assert.equal(failed, null, 'within the window: no trip');
  T = 100000 + 1000; b._checkStall();
  assert.ok(failed && /froze/i.test(failed.reason), 'at the window: fails');
  assert.match(failed.reason, /resumed/i, 'marked resumable so the scheduler reconnects');
  // (cleanup-on-trip is proven in the wiring test below, against a real armed timer)
});

test('stall watchdog (_checkStall): fresh advance resets the clock, so it does not trip', () => {
  let T = 100000;
  const b = new Broadcast(short({ stallTimeoutMs: 1000, now: () => T }));
  b._playing = true; b._lastAdvanceAt = 100000;
  let failed = false; b.on('failed', () => { failed = true; });
  T = 100000 + 800; b._lastAdvanceAt = T;    // out_time advanced 800ms in (as the progress handler would record)
  T = 100000 + 1500; b._checkStall();         // 1500ms total, but only 700ms since the advance
  assert.equal(failed, false, 'recent advance keeps it alive');
});

test('stall watchdog (_checkStall): never trips when not playing / stopping / already finalized', () => {
  // A spy _proc isolates _checkStall's OWN guard from _fail's separate
  // short-circuit: if a guard were removed, _checkStall would still reach the
  // SIGKILL even for the stopping/finalized cases where _fail emits nothing. So
  // we assert the process is never killed, not merely that no 'failed' fired.
  const mk = () => {
    const b = new Broadcast(short({ stallTimeoutMs: 1000, now: () => 999999 }));   // huge gap from _lastAdvanceAt 0
    let killed = false; b._proc = { kill: () => { killed = true; } };
    let failed = false; b.on('failed', () => { failed = true; });
    return { b, k: () => killed, f: () => failed };
  };
  for (const setup of [
    (x) => { x._playing = false; },
    (x) => { x._playing = true; x._stopping = true; },
    (x) => { x._playing = true; x._finalized = true; },
  ]) {
    const t = mk(); setup(t.b); t.b._checkStall();
    assert.equal(t.f(), false, 'no failure emitted');
    assert.equal(t.k(), false, 'the encode is never killed');
  }
});

test('stall watchdog wiring: an armed watch fires a resumable failure when out_time stays frozen', async () => {
  const b = new Broadcast(short({ stallTimeoutMs: 40, stallCheckMs: 10 }));
  b._playing = true;
  b._lastAdvanceAt = b._now() - 1000;      // already long frozen, on the SAME (monotonic) clock the watch reads
  b._armStallWatch();
  assert.ok(b._stallTimer, 'positive control: the watch is really armed');
  const r = await new Promise((res) => { b.on('failed', res); });
  assert.match(r.reason, /froze/i);
  assert.match(r.reason, /resumed/i);
  assert.equal(b._stallTimer, null, 'the armed timer is cleared once it trips');
});

test('stall watchdog wiring: stallTimeoutMs:0 disables the watch (no timer armed)', () => {
  const b = new Broadcast(short({ stallTimeoutMs: 0 }));
  b._playing = true;
  b._armStallWatch();
  assert.equal(b._stallTimer, null, 'disabled → nothing armed');
});

test('progress parsing: the stall clock resets only when out_time TRULY advances', () => {
  // The watchdog's linchpin is the `>` in the progress handler: a frozen encode
  // that keeps re-emitting the SAME out_time must NOT refresh the freeze timer.
  // Drive the parser directly (watchdog disabled so no real interval is armed).
  let T = 500;
  const b = new Broadcast(short({ now: () => T, stallTimeoutMs: 0 }));
  T = 1000; b._onProgressData(Buffer.from('out_time_us=1000000\n'));   // 1.0s — advances
  assert.equal(b._lastSeenOut, 1);
  assert.equal(b._lastAdvanceAt, 1000, 'a real advance stamps the clock');
  T = 2000; b._onProgressData(Buffer.from('out_time_us=1000000\n'));   // same value → frozen
  assert.equal(b._lastAdvanceAt, 1000, 'a repeated out_time does NOT reset the freeze timer');
  T = 3000; b._onProgressData(Buffer.from('out_time_us=2000000\n'));   // 2.0s — advances again
  assert.equal(b._lastAdvanceAt, 3000, 'a further real advance refreshes it');
});

test('start deadline: a source that never reaches playing fails plainly', async () => {
  // 1ms deadline fires long before ffmpeg's first progress tick — deterministic.
  const b = new Broadcast(short({ leadSec: 0, slateImage: null, startTimeoutMs: 1 }));
  let played = false; b.on('playing', () => { played = true; });
  const r = await new Promise((res) => { b.on('failed', res); b.start(); });
  assert.equal(played, false);
  assert.match(r.reason, /did not start within/i);
});
