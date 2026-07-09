'use strict';
/* Pacing rehearsal — the guard the dress rehearsal was too coarse to be.
   A percentage over-speed is invisible on a 28 s fixture (±1 s) but costs minutes
   on a 45 min class. This drives the REAL Broadcast slate path (the multi-input
   composition that regressed) on a self-generated broadcast-framerate (29.97 fps)
   clip and asserts the encoder tracks wall-clock within ±2 %.

   Needs mediamtx (`brew install mediamtx`). Exit 0 = paced, 1 = drift, 2 = setup. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { Broadcast } = require(path.join(REPO, 'engine', 'broadcast.js'));
const ffmpeg = require(path.join(REPO, 'engine', 'ffmpeg.js'));
const FIX = path.join(REPO, 'test', 'fixtures');
const SAMPLE_FROM = 20, SAMPLE_TO = 100, TOL = 0.02;

(async () => {
  // 1. a ~110 s clip at 29.97 fps (real classes are 30000/1001) with audio
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-pace-'));
  const clip = path.join(tmp, 'pace-src.mp4');
  const gen = spawnSync(ffmpeg.ffmpegPath(), [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30000/1001:duration=110',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=110',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) { console.error('could not generate the test clip:', gen.stderr); process.exit(2); }

  const mtx = spawn('mediamtx', [path.join(REPO, 'scripts', 'mediamtx-test.yml')], { stdio: 'ignore' });
  mtx.on('error', (e) => { console.error('mediamtx is required (brew install mediamtx):', e.message); process.exit(2); });
  await new Promise((r) => setTimeout(r, 1500));

  const b = new Broadcast({
    videoPath: clip, vertical: false, bitrateKbps: 3000, fps: 30, leadSec: 8, fadeSec: 1,
    slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
    resumeOffsetSec: 0, outUrl: 'rtmp://127.0.0.1:1935/live/pace',
  });

  let wall0 = null; const samples = [];
  b.on('playing', () => { wall0 = Date.now(); });
  b.on('progress', (p) => { if (wall0 != null && p.outTimeSec != null) samples.push({ wall: (Date.now() - wall0) / 1000, out: p.outTimeSec }); });
  b.on('failed', (i) => { console.error('FAIL: broadcast failed —', i.reason); finish(1); });

  function finish(code) {
    try { b.stop(); } catch {} try { mtx.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    setTimeout(() => process.exit(code), 1200);
  }

  setTimeout(() => {
    const u = samples.filter((s) => s.wall >= SAMPLE_FROM && s.wall <= SAMPLE_TO);
    if (u.length < 8) { console.error('FAIL: too few samples (broadcast never got going)'); return finish(1); }
    const a = u[0], z = u[u.length - 1];
    const slope = (z.out - a.out) / (z.wall - a.wall);
    const ok = Math.abs(slope - 1) <= TOL;
    console.log('slate-path pacing slope (encoded s per wall s): ' + slope.toFixed(5) + '  [' + a.wall.toFixed(0) + 's–' + z.wall.toFixed(0) + 's]');
    console.log(ok ? 'PACING REHEARSAL PASSED (within ±' + (TOL * 100) + '%)'
                   : 'PACING REHEARSAL FAILED — off by ' + ((slope - 1) * 100).toFixed(1) + '% (a 45-min class would end ' + Math.round((slope - 1) * 45) + ' min off)');
    finish(ok ? 0 : 1);
  }, (SAMPLE_TO + 8) * 1000);

  b.start();
})();
