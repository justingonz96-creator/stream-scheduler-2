'use strict';
/* Kill a live broadcast mid-video, resume at the captured offset, verify the
   remainder's length. Segment 2 is recorded separately (a real Mux ingest would
   splice within its reconnect window; length math is what we can assert locally).

   Adapted from scripts/rehearsal.js (Task 7) — same rig, same proven fixes for
   the recorder-attach race and the FLV-trailer-on-force-kill problem. See the
   per-function comments below for exactly what was reused and why. */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');
const { ffmpegPath, ffprobePath } = require('../engine/ffmpeg');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', 'test', 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const LEAD = 4, FADE = 1, VIDEO = 20, KILL_AFTER = 10; // kill ~5-6s into the video
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${n}${d ? ' — ' + d : ''}`); if (!ok) failures++; };

// Deviation from brief: format.duration is only written to an FLV's trailer on
// a clean close. Segment 1 is ended by a SIGKILL of the *broadcast* itself
// (simulating a network death), which races the recorder's own shutdown, and
// segment 2's recorder is force-escalated to SIGKILL by stopRecorder() below
// (same reasoning as Task 7). Neither recording reliably gets a trailer, so
// format.duration reads back as 0 for both — verified empirically on this rig
// (see task-8-report.md). Measure the actual recorded span from the first and
// last video-packet timestamps instead (Task 7's recordedSpanSec pattern).
function recordedSpanSec(file) {
  const out = execFileSync(ffprobePath(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = out.trim().split('\n').filter(Boolean).map(Number);
  return lines.length ? lines[lines.length - 1] - lines[0] : 0;
}

// Reused verbatim from scripts/rehearsal.js (Task 7) — samples a small
// centered crop (not the whole frame) since the engine's `fit` filter can
// letterbox source content into the recording canvas.
function frameMeanRGB(file, atSec, w, h) {
  const cw = Math.min(100, w), ch = Math.min(100, h);
  const crop = `crop=${cw}:${ch}:(in_w-${cw})/2:(in_h-${ch})/2`;
  const raw = execFileSync(ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file,
     '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: cw * ch * 3 + 1024 });
  let r = 0, g = 0, b = 0; const n = Math.floor(raw.length / 3);
  for (let i = 0; i < n * 3; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return [r / n, g / n, b / n];
}
function probeJson(file) {
  return JSON.parse(execFileSync(ffprobePath(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
}

// Deviation from brief: force-killing the *recorder* on SIGTERM alone can hang
// forever once mediamtx has torn down the path (Task 7's observed poll()/join
// deadlock). Escalate to SIGKILL if it doesn't exit quickly. The recorder is a
// disposable test tool; recordedSpanSec (above) doesn't need a clean trailer.
function stopRecorder(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    proc.on('exit', () => { clearTimeout(killTimer); resolve(); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
  });
}

// Deviation from brief: the brief's record() spawns the recorder immediately
// with no gate. Task 7 found mediamtx rejects an RTMP reader that connects
// before a publisher is registered live on that path ("no stream is available
// on path") — the recorder then exits at once instead of waiting. Gate the
// spawn on the engine's own 'playing' event and retry with a bounded deadline,
// exactly like Task 7's runOne().
function startRecorder(streamPath, to) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const proc = spawn(ffmpegPath(),
        ['-y', '-i', `rtmp://127.0.0.1:1935/${streamPath}`, '-c', 'copy', to],
        { stdio: 'ignore' });
      let settled = false;
      proc.on('exit', () => {
        if (settled) return;
        if (Date.now() < deadline) setTimeout(attempt, 100);
        else reject(new Error(`recorder could not attach to rtmp://127.0.0.1:1935/${streamPath} within 15s`));
      });
      setTimeout(() => {
        if (proc.exitCode === null) { settled = true; resolve(proc); }
      }, 200);
    };
    attempt();
  });
}

// In-harness fixture (not part of scripts/make-fixtures.sh, same pattern as
// test/probe.test.js's silent.mp4): a 10s-green/10s-blue video. Duration alone
// can't tell a correct resume-at-offset apart from a from-zero restart (see
// task-8-report.md), so the rehearsal needs content that visibly differs
// depending on where playback actually started.
function makeTwoColorFixture() {
  const twoColor = path.join(FIX, 'twocolor.mp4');
  execFileSync(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:size=1280x720:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'color=c=blue:size=1280x720:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', twoColor]);
  return twoColor;
}

(async () => {
  const mtx = spawn('mediamtx', [path.join(__dirname, 'mediamtx-test.yml')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));
  const twoColor = makeTwoColorFixture();
  const opts = {
    videoPath: twoColor, slateImage: path.join(FIX, 'slate.png'),
    slateMusic: path.join(FIX, 'music.mp3'), leadSec: LEAD, fadeSec: FADE,
    bitrateKbps: 2500, outUrl: 'rtmp://127.0.0.1:1935/live/resume',
  };
  try {
    // --- Segment 1: live broadcast, killed mid-video (simulated network death) ---
    const b1 = new Broadcast(opts);
    const playing1 = new Promise((res) => b1.on('playing', res));
    const died = new Promise(res => b1.on('failed', res));       // a mid-run kill = 'failed' (resumable)
    b1.start();
    await playing1;
    const rec1 = await startRecorder('live/resume', path.join(TMP, 'resume-seg1.flv'));

    let offset = 0;
    setTimeout(() => { offset = b1.videoOffsetSec(); b1._proc.kill('SIGKILL'); }, KILL_AFTER * 1000);
    await died;
    await stopRecorder(rec1);
    check('offset captured mid-video', offset > 3 && offset < 9, `${offset.toFixed(1)}s`);

    // --- Segment 2: resume at the captured offset ---
    const b2 = new Broadcast({ ...opts, resumeOffsetSec: offset });
    const playing2 = new Promise((res) => b2.on('playing', res));
    const ended = new Promise((res, rej) => { b2.on('ended', res); b2.on('failed', e => rej(new Error(e.reason))); });
    b2.start();
    await playing2;
    const rec2 = await startRecorder('live/resume', path.join(TMP, 'resume-seg2.flv'));

    await ended;
    await new Promise(r => setTimeout(r, 1500));
    await stopRecorder(rec2);

    const remain = VIDEO - offset;
    const d2 = recordedSpanSec(path.join(TMP, 'resume-seg2.flv'));
    // Deviation from brief: tolerance widened from the brief's <2s to <5s, with
    // hard evidence (3 consecutive runs, same rig): recorded span was
    // consistently ~4.1-4.3s short of `remain` (e.g. 7.4s vs 11.7s; 7.5s vs
    // 11.6s; 7.5s vs 11.6s). Root cause, same mechanism Task 7 documented for
    // this mediamtx build: the recorder cannot attach until mediamtx registers
    // the publisher (~1.4s after the engine's own 'playing', measured
    // directly — see task-8-report.md), losing the front GOP (-g is fps*2 =
    // 2s here); and the in-flight GOP at disconnect is dropped rather than
    // forwarded, losing another ~2s at the back. Unlike Task 7's runs (which
    // always have an 8s slate cushion before the content that's measured),
    // segment 2 here has NO lead-in — resumeOffsetSec>0 skips the slate
    // entirely (engine/timeline.js hasSlatePhase) — so this structural loss
    // lands directly on the measured content instead of being absorbed by a
    // cushion. The loss is a near-fixed ~4s (bounded by 2 GOPs), not
    // proportional to segment length, so <5s keeps meaningful headroom
    // without being loose enough to hide a real regression (a broken resume
    // would be off by seconds of *video content*, e.g. wrong seek point,
    // which this tolerance would still catch).
    check('resumed segment ≈ remaining video', Math.abs(d2 - remain) < 5, `${d2.toFixed(1)}s vs ${remain.toFixed(1)}s`);

    // Check 3 (the discriminating one): duration alone can't tell a correct
    // resume apart from a from-zero restart (see task-8-report.md — a restart
    // ignoring resumeOffsetSec plausibly lands within the <5s band above too).
    // The proof a from-zero restart CANNOT pass: a correct resume (offset ≈5s
    // into a 10s-green/10s-blue video) reaches BLUE within ~2s of the resumed
    // recording's start (transition at (10 − offset) − attachGap ≈ ≤2s in); a
    // from-zero restart is still GREEN there until ~5-6.5s. Sample at t=3s:
    // blue = resumed, green = restarted.
    const seg2Path = path.join(TMP, 'resume-seg2.flv');
    const v2 = probeJson(seg2Path).streams.find(s => s.codec_type === 'video');
    const rgb = frameMeanRGB(seg2Path, 3, v2.width, v2.height);
    check('resumed at the right spot (frame at 3s is blue, not green)',
          rgb[2] > 150 && rgb[1] < 90, `rgb ${rgb.map(x => x | 0)}`);
  } catch (e) {
    check('resume rehearsal ran to completion', false, e.message);
  }
  mtx.kill('SIGTERM');
  console.log(failures === 0 ? '\nRESUME REHEARSAL PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
