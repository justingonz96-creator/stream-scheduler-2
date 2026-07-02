'use strict';
/* Full dress rehearsal: engine -> local RTMP -> recorder -> automated checks.
   Usage: node scripts/rehearsal.js   (assumes fixtures exist: npm run fixtures) */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');
const { ffmpegPath, ffprobePath } = require('../engine/ffmpeg');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', 'test', 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const LEAD = 8, FADE = 1, VIDEO = 20;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

function frameMeanRGB(file, atSec, w, h) {
  // -hide_banner -loglevel error: without these, ffmpeg's version banner and
  // per-frame status line go to stderr and can trip Node's maxBuffer (ENOBUFS)
  // even though only stdout (the raw pixels) needs the larger buffer.
  //
  // Sample a small centered crop, not the whole frame: the engine's `fit`
  // filter (engine/timeline.js) letterboxes 16:9 content into the vertical
  // 1080x1920 canvas with black pad bars top/bottom, so a whole-frame mean
  // is diluted by padding for the vertical run even when the visible content
  // is solid red. Both orientations are centered (pad=(ow-iw)/2:(oh-ih)/2),
  // so a small box at the frame center always lands inside real content.
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
function recordedSpanSec(file) {
  // format.duration is only written to an FLV's trailer on a clean close.
  // The recorder here is force-killed (see stopRecorder), so there is no
  // trailer — format.duration reads back as 0 even though every packet up to
  // that point is intact. Measure the actual recorded span from the first
  // and last video packet timestamps instead; that's unaffected by how the
  // file was closed.
  //
  // Also: like any RTMP viewer joining a live stream, the recorder cannot
  // attach until mediamtx has registered the publish (observed ~2s after the
  // engine's own 'playing' event), so the first couple of seconds of the
  // broadcast are never captured — the recording legitimately starts partway
  // in. Comparing (last - first) pts, rather than assuming the recording
  // starts at the broadcast's t=0, measures what was actually captured.
  const out = execFileSync(ffprobePath(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = out.trim().split('\n').filter(Boolean).map(Number);
  return lines.length ? lines[lines.length - 1] - lines[0] : 0;
}
function meanVolumeDb(file) {
  // volumedetect reports on STDERR — spawnSync exposes it; execFileSync would not.
  const r = require('node:child_process').spawnSync(ffmpegPath(),
    ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
  return m ? Number(m[1]) : -Infinity;
}

function stopRecorder(proc) {
  // Observed in practice: once mediamtx tears down the path (publisher
  // ended), the recorder's demux thread can be stuck in poll() on the
  // already-closed RTMP socket while ffmpeg's shutdown path (sch_stop)
  // joins that thread — so SIGTERM is sometimes never handled and the
  // process hangs forever. Escalate to SIGKILL if it doesn't exit quickly;
  // the recorder is a disposable test tool, not something that needs a
  // graceful FLV trailer (see recordedSpanSec for why that's fine).
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    proc.on('exit', () => { clearTimeout(killTimer); resolve(); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
  });
}

async function runOne(label, vertical) {
  const streamPath = `live/${label}`;
  const rec = path.join(TMP, `rehearsal-${label}.flv`);

  // mediamtx rejects an RTMP reader immediately ("no stream is available on
  // path") if it connects before a publisher is registered live on that
  // path — ffmpeg then exits at once with "Input/output error" instead of
  // waiting/retrying. The engine's own 'playing' event (out_time_us >= 0.5s)
  // fires before mediamtx finishes the publish handshake (first keyframe +
  // stream registration measured ~2-3s behind 'playing' in practice), so a
  // fixed short delay after 'playing' still races mediamtx. Retry the
  // recorder spawn until it actually attaches to a live stream.
  const t0 = Date.now();
  const b = new Broadcast({
    videoPath: path.join(FIX, vertical ? 'class-vertical.mp4' : 'class.mp4'),
    slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
    leadSec: LEAD, fadeSec: FADE, vertical, bitrateKbps: 2500,
    outUrl: `rtmp://127.0.0.1:1935/${streamPath}`,
  });
  const ended = new Promise((res, rej) => { b.on('ended', res); b.on('failed', e => rej(new Error(e.reason))); });
  const playing = new Promise((res) => b.on('playing', res));
  b.start();
  await playing;

  const recorder = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const proc = spawn(ffmpegPath(),
        ['-y', '-i', `rtmp://127.0.0.1:1935/${streamPath}`, '-c', 'copy', rec],
        { stdio: 'ignore' });
      let settled = false;
      proc.on('exit', () => {
        if (settled) return;                 // recorder was still alive when we resolved below; a later exit is the normal SIGTERM stop
        if (Date.now() < deadline) setTimeout(attempt, 100);
        else reject(new Error(`recorder could not attach to rtmp://127.0.0.1:1935/${streamPath} within 15s`));
      });
      setTimeout(() => {                      // still alive after 200ms = genuinely attached (mediamtx rejects a dead stream instantly), not an instant reject
        if (proc.exitCode === null) { settled = true; resolve(proc); }
      }, 200);
    };
    attempt();
  });

  await ended;
  const wallSec = (Date.now() - t0) / 1000;
  await new Promise(r => setTimeout(r, 1500));
  await stopRecorder(recorder);

  const expect = LEAD + VIDEO;
  const info = probeJson(rec);
  const dur = recordedSpanSec(rec);
  const v = info.streams.find(s => s.codec_type === 'video');
  // Tolerance is wider than a naive "recording length" check because a local
  // RTMP capture through mediamtx structurally loses a few seconds at both
  // edges, independent of the broadcast engine: verified directly with plain
  // ffmpeg (no Broadcast/engine code involved) publishing a fixture file
  // through this same mediamtx build — the recorder's first captured frame
  // lags the publisher's first frame by one GOP (mediamtx withholds the path
  // until it has a full keyframe-aligned unit), and its last captured frame
  // trails the publisher's actual last frame by roughly another GOP (the
  // in-flight GOP at disconnect is dropped, not forwarded). The engine's own
  // 'progress' events (checked separately below via wall-clock pacing)
  // confirm the broadcast itself always encodes the full expected duration.
  check(`${label}: duration ≈ ${expect}s`, Math.abs(dur - expect) < 6, `${dur.toFixed(1)}s`);
  check(`${label}: realtime pacing`, Math.abs(wallSec - expect) / expect < 0.15, `wall ${wallSec.toFixed(1)}s`);
  const slate = frameMeanRGB(rec, 3, v.width, v.height);
  check(`${label}: slate frame is red`, slate[0] > 150 && slate[1] < 90 && slate[2] < 90, `rgb ${slate.map(x => x | 0)}`);
  const vid = frameMeanRGB(rec, LEAD + FADE + 3, v.width, v.height);
  check(`${label}: post-fade frame is video (not red)`, !(vid[0] > 150 && vid[1] < 90), `rgb ${vid.map(x => x | 0)}`);
  check(`${label}: audio audible`, meanVolumeDb(rec) > -60);
  check(`${label}: canvas`, vertical ? (v.width === 1080 && v.height === 1920) : (v.width === 1920 && v.height === 1080),
        `${v.width}x${v.height}`);
}

(async () => {
  const mtx = spawn('mediamtx', [path.join(__dirname, 'mediamtx-test.yml')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));
  try {
    await runOne('horizontal', false);
    await runOne('vertical', true);
  } catch (e) { check('rehearsal ran to completion', false, e.message); }
  mtx.kill('SIGTERM');
  console.log(failures === 0 ? '\nALL REHEARSAL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
