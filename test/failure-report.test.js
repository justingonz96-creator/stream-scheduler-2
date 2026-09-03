'use strict';
// The failure text an operator reads must name the RIGHT half of the pipeline.
// A real incident (2026-09-03) was misdiagnosed for hours because a streaming
// failure was reported as "the video file could not be played" — ffmpeg had
// actually said "Error opening OUTPUT files", i.e. the stream destination.
const { test } = require('node:test');
const assert = require('node:assert');
const { describeFailure } = require('../engine/broadcast');

test('output-open failure blames the stream destination, not the video file', () => {
  const r = describeFailure('[flv @ 0x7f] Cannot open connection tcp://live.example.com:1935\n' +
    'Error opening output files: Input/output error');
  assert.equal(r.kind, 'output');
  assert.match(r.message, /stream/i);
  assert.doesNotMatch(r.message, /video \(or slate\) file could not be played/i,
    'must not blame the video file for a streaming failure');
});

test('RTMP handshake/refusal is an output failure too', () => {
  for (const tail of [
    'rtmp://x: Connection refused',
    '[rtmp @ 0x1] Server error: Authentication Failed',
    'Connection to tcp://a.b:1935 failed: Operation timed out',
  ]) assert.equal(describeFailure(tail).kind, 'output', tail);
});

test('a missing/unreadable source is still reported as a file problem', () => {
  const r = describeFailure("missing.mp4: No such file or directory\nError opening input files: No such file or directory");
  assert.equal(r.kind, 'input');
  assert.match(r.message, /file/i);
});

test('input/output error on the INPUT side stays an input failure', () => {
  const r = describeFailure('[in#0 @ 0x1] Error during demuxing: Input/output error\n' +
    'Error opening input file /Volumes/drive/class.mp4.');
  assert.equal(r.kind, 'input');
});

test('an unrecognised tail is neutral — it never invents a cause', () => {
  const r = describeFailure('something entirely unexpected happened');
  assert.equal(r.kind, 'unknown');
  assert.doesNotMatch(r.message, /video \(or slate\) file could not be played/i);
});

test('the detail keeps more than two lines of ffmpeg output', () => {
  const tail = ['line one', 'line two', 'line three', 'Error opening output files: Input/output error'].join('\n');
  assert.match(describeFailure(tail).detail, /line two/,
    'operators need enough context to diagnose, not just the last line');
});
