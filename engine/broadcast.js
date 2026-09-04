'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ffmpeg = require('./ffmpeg');
const { buildBroadcastArgs, videoStartsAtSec } = require('./timeline');

const VERIFY_AT_SEC = 0.5;      // out_time must pass this to count as "actually playing"
const STALL_TIMEOUT_MS = 20000; // once playing, this long with NO new video = a frozen encode
const SLOW_SPEED = 0.9;         // ffmpeg speed= below this = falling behind the clock
const SLOW_WINDOW_MS = 30000;   // …for this long continuously before we say so
const MILD_SPEED = 0.985;       // a gentler drift (0.90–0.985x) — a class ends minutes late with no other sign…
const MILD_WINDOW_MS = 300000;  // …so call it out after 5 minutes of it (2026-09-04 audit)

/* One broadcast attempt = one Broadcast instance. start() may be called once; to
   retry a failed start or resume after a crash, create a NEW Broadcast (passing
   resumeOffsetSec from the old instance's videoOffsetSec()). The rehearsal
   harnesses model this pattern. */
/* What actually went wrong, read from ffmpeg's own stderr.

   This matters more than it looks: ffmpeg says "input files" when it cannot READ
   the video/slate, and "output files" when it cannot open the STREAM DESTINATION.
   Both surface as "Input/output error", so a single generic message sends the
   operator to the wrong end of the pipeline — that cost a real class and hours of
   drive-hunting on 2026-09-03. Classify, then say the true thing. Anything we do
   not recognise stays 'unknown' and blames nothing. */
const OUTPUT_SIGNS = [
  /error opening output/i, /could not write header/i, /rtmp/i,
  /connection refused/i, /connection timed out/i, /operation timed out/i,
  /network is unreachable/i, /no route to host/i, /broken pipe/i,
  /cannot open connection/i, /server error/i, /handshake/i,
  /connection to .* failed/i, /end of file/i,
];
const INPUT_SIGNS = [
  /error opening input/i, /no such file or directory/i, /invalid data found/i,
  /permission denied/i, /error during demuxing/i, /does not contain any stream/i,
  /invalid argument/i,
];

const OUT_MSG = 'The broadcast could not start — the app could not connect to the streaming destination ' +
  '(the studio stream server). The video file itself is fine. Check that the studio is set up to receive ' +
  'the stream, and that this computer is allowed to reach it.';
const IN_MSG = 'The broadcast could not start — the video (or slate) file could not be played. ' +
  'Check the file and the network drive.';
const UNKNOWN_MSG = 'The broadcast could not start. The details below are from the video engine.';

function describeFailure(stderrTail) {
  const raw = String(stderrTail == null ? '' : stderrTail);
  // Keep the lines that carry meaning; ffmpeg's banner/progress noise only
  // crowds out the one line that explains the failure.
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(ffmpeg version|built with|configuration:|\s*lib[a-z]+\s)/i.test(l));
  const detail = lines.slice(-6).join(' | ');
  // An explicit output/input marker wins over the generic signs, because
  // "Error opening output files: Input/output error" contains both.
  const explicitOut = /error opening output/i.test(raw);
  const explicitIn = /error opening input/i.test(raw);
  let kind = 'unknown';
  if (explicitOut && !explicitIn) kind = 'output';
  else if (explicitIn && !explicitOut) kind = 'input';
  else if (INPUT_SIGNS.some((re) => re.test(raw))) kind = 'input';
  else if (OUTPUT_SIGNS.some((re) => re.test(raw))) kind = 'output';
  const message = kind === 'output' ? OUT_MSG : kind === 'input' ? IN_MSG : UNKNOWN_MSG;
  return { kind, message, detail };
}

// How ffmpeg is spawned. windowsHide: without it a black console window pops up
// on Windows for every class, and closing it kills the stream (2026-09-04 audit).
// env carries SSL_CERT_FILE so OpenSSL can verify an rtmps:// studio certificate.
function spawnOptions() {
  return { stdio: ['pipe', 'pipe', 'pipe'], env: ffmpeg.ffmpegEnv(), windowsHide: true };   // stdin: ffmpeg's own 'q' = graceful stop
}

class Broadcast extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.outTimeSec = 0;
    this._proc = null;
    this._playing = false;
    this._stopping = false;
    this._stderrTail = '';
    this._stdoutBuf = '';
    this._finalized = false;
    this._startTimer = null;
    // Stall watchdog: after 'playing', a frozen encode (out_time stops advancing)
    // must be caught so the scheduler's resume path can reconnect. The clock is a
    // MONOTONIC source (performance.now), never the wall clock — an NTP/manual
    // clock step must not manufacture a phantom freeze and kill a healthy stream.
    // Injectable so tests can drive it deterministically.
    this._now = (opts && opts.now) || (() => performance.now());
    this._lastSeenOut = 0;      // highest out_time observed so far
    this._lastAdvanceAt = 0;    // monotonic time (via _now) of the last real advance
    this._stallTimer = null;
    // Encoder speed, from ffmpeg's own speed= lines. Below 1x the stream is
    // falling behind real time (viewers stutter, the class ends late). A
    // sustained dip emits 'slow' once; recovery emits 'speedok' and re-arms.
    this._speed = { last: null, min: null, sum: 0, samples: 0 };
    this._slowSince = null;
    this._slowReported = false;
    this._mildSince = null;
    this._mildReported = false;
    this._stderrLine = '';
  }

  // Detection lines that the filter graph prints to stderr (metadata=print →
  // pipe:2): lavfi.black_start/_end and lavfi.silence_start/_end. A dark or
  // silent SLATE is not news, so nothing is reported until the class itself is
  // under way (a few seconds past the lead-in).
  _onStderr(chunk) {
    this._stderrLine += String(chunk);
    const lines = this._stderrLine.split('\n'); this._stderrLine = lines.pop();
    for (const line of lines) {
      const m = /lavfi\.(black|silence)_(start|end)=([\d.]+)/.exec(line);
      if (!m) continue;
      const kind = m[1] === 'black' ? 'black' : 'silent';
      const inClass = this.outTimeSec > videoStartsAtSec(this.opts) + 5;
      if (!inClass && m[2] === 'start') continue;
      if (m[2] === 'start') { this._blank = this._blank || {}; this._blank[kind] = true; this.emit('blank', { kind, at: Number(m[3]) }); }
      else if (this._blank && this._blank[kind]) { this._blank[kind] = false; this.emit('blank', { kind, ended: true, at: Number(m[3]) }); }
    }
  }

  speedStats() {
    const s = this._speed;
    return { last: s.last, min: s.min, avg: s.samples ? s.sum / s.samples : null, samples: s.samples };
  }

  _onSpeed(v) {
    const s = this._speed;
    s.last = v; s.min = s.min == null ? v : Math.min(s.min, v); s.sum += v; s.samples++;
    if (!this._playing) return;
    const windowMs = this.opts.slowWindowMs == null ? SLOW_WINDOW_MS : this.opts.slowWindowMs;
    const t = this._now();
    if (v < SLOW_SPEED) {
      if (this._slowSince == null) this._slowSince = t;
      if (!this._slowReported && t - this._slowSince >= windowMs) { this._slowReported = true; this.emit('slow', { speed: v }); }
    } else {
      this._slowSince = null;
      if (this._slowReported) { this._slowReported = false; this.emit('speedok', { speed: v }); }
    }
    // The gentle drift: never bad enough for the sharp signal, but a class at
    // 0.95x for an hour ends three minutes late. Report it after 5 minutes.
    if (v < MILD_SPEED) {
      if (this._mildSince == null) this._mildSince = t;
      if (!this._mildReported && !this._slowReported && t - this._mildSince >= MILD_WINDOW_MS) { this._mildReported = true; this.emit('slow', { speed: v, mild: true }); }
    } else {
      this._mildSince = null;
      if (this._mildReported) { this._mildReported = false; this.emit('speedok', { speed: v }); }
    }
  }

  _fail(reason) {
    if (this._finalized || this._stopping) return;
    this._finalized = true;
    this.emit('failed', { reason });
  }

  start() {
    if (this._proc) throw new Error('Broadcast is one-shot: create a new Broadcast to retry or resume.');

    const args = buildBroadcastArgs(this.opts);
    this._proc = spawn(ffmpeg.ffmpegPath(), args, spawnOptions());

    this._proc.on('error', (err) => {
      this._fail('The broadcast could not start — the built-in video engine failed to launch. ' +
        'Reinstall Stream Scheduler, or contact the admin. (' + err.message + ')');
    });
    this._proc.stdout.on('data', (buf) => this._onProgressData(buf));   // -progress pipe:1 key=value lines
    this._proc.stderr.on('data', (buf) => {
      this._stderrTail = (this._stderrTail + String(buf)).slice(-2000);
      this._onStderr(buf);
    });
    this._proc.on('close', (code) => {
      clearTimeout(this._startTimer);
      clearInterval(this._stallTimer);
      if (this._stopping || this._finalized) return;  // deliberate stop, or already failed via 'error'
      if (code === 0) {
        // A clean exit means ffmpeg ran the source to completion — that is a
        // finished broadcast, even for a clip so short it never crossed the
        // half-second start-verification mark (so '_playing' was never latched).
        this._finalized = true;
        this.emit('ended');
      } else if (!this._playing) {
        const d = describeFailure(this._stderrTail);
        this._fail(d.message + (d.detail ? ' (' + d.detail + ')' : ''));
      } else {
        const d = describeFailure(this._stderrTail);
        const why = d.kind === 'output' ? 'the connection to the studio stream server was lost'
          : d.kind === 'input' ? 'the video file could not be read'
          : 'connection or file problem';
        this._fail('The broadcast stopped unexpectedly (' + why + '). It can be resumed.' +
          (d.detail ? ' (' + d.detail + ')' : ''));
      }
    });

    // Start deadline: a source that hangs without exiting (stalled network read,
    // unresponsive ingest) must still report. If media time hasn't been confirmed
    // advancing within the deadline, fail plainly and kill the encode.
    const deadlineMs = this.opts.startTimeoutMs == null ? 30000 : this.opts.startTimeoutMs;
    this._startTimer = setTimeout(() => {
      if (this._playing || this._finalized || this._stopping) return;
      this._fail('The broadcast did not start within ' + Math.round(deadlineMs / 1000) +
        ' seconds — check the video file and the network drive.');
      try { this._proc.kill('SIGKILL'); } catch {}
    }, deadlineMs);
  }

  // Parse a chunk of ffmpeg's -progress output. Extracted so the stall clock's
  // linchpin — "only a real forward jump in out_time resets the freeze timer" —
  // can be driven directly by tests without spawning ffmpeg.
  _onProgressData(buf) {
    this._stdoutBuf += String(buf);
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop();                  // keep the trailing partial line for the next chunk
    for (const line of lines) {
      const sp = /^speed=\s*([0-9.]+)x/.exec(line.trim());
      if (sp) { this._onSpeed(Number(sp[1])); continue; }
      const m = /^out_time_us=(\d+)/.exec(line.trim());
      if (m) {
        this.outTimeSec = Number(m[1]) / 1e6;
        if (this.outTimeSec > this._lastSeenOut) {   // real forward progress → reset the stall clock
          this._lastSeenOut = this.outTimeSec;
          this._lastAdvanceAt = this._now();
        }
        if (!this._playing && this.outTimeSec >= VERIFY_AT_SEC) {
          this._playing = true;
          clearTimeout(this._startTimer);
          this._armStallWatch();
          this.emit('playing');
        }
        this.emit('progress', { outTimeSec: this.outTimeSec });
      }
    }
  }

  // Arm the stall watchdog once the encode is confirmed playing. Every stallMs/4
  // it checks whether out_time has advanced; if it has been frozen for the full
  // window, the encode is stuck (wedged ingest / half-open socket) so we kill it
  // and fail RESUMABLY — the scheduler then reconnects from the frozen point via
  // the same drop-recovery path as any other mid-broadcast failure. A stallMs of
  // 0 disables the watchdog (used by tests that don't want it).
  _armStallWatch() {
    const stallMs = this.opts.stallTimeoutMs == null ? STALL_TIMEOUT_MS : this.opts.stallTimeoutMs;
    if (stallMs <= 0) return;
    const checkMs = this.opts.stallCheckMs == null ? Math.max(1, Math.min(5000, Math.floor(stallMs / 4))) : this.opts.stallCheckMs;
    clearInterval(this._stallTimer);
    this._stallTimer = setInterval(() => this._checkStall(), checkMs);
    // (not unref'd, matching _startTimer: it is always cleared on close/stop/quit)
  }

  _checkStall() {
    if (this._finalized || this._stopping || !this._playing) return;
    const stallMs = this.opts.stallTimeoutMs == null ? STALL_TIMEOUT_MS : this.opts.stallTimeoutMs;
    const frozenMs = this._now() - this._lastAdvanceAt;
    if (frozenMs < stallMs) return;   // still advancing recently → fine
    clearInterval(this._stallTimer); this._stallTimer = null;
    this._fail('The broadcast froze — no new video was sent for ' + Math.round(frozenMs / 1000) +
      ' seconds. It can be resumed.');
    try { if (this._proc) this._proc.kill('SIGKILL'); } catch { /* already gone */ }
  }

  videoOffsetSec() {
    const inVideo = Math.max(0, this.outTimeSec - videoStartsAtSec(this.opts));
    return inVideo + (this.opts.resumeOffsetSec || 0);
  }

  stop() {
    clearTimeout(this._startTimer);
    clearInterval(this._stallTimer);
    return new Promise((resolve) => {
      if (this._stopping) { resolve(); return; }
      if (!this._proc || this._proc.exitCode !== null) { resolve(); return; }
      this._stopping = true;
      // Graceful first: ffmpeg's own 'q' finishes the file/stream properly and
      // exits 0 on every platform (a Windows SIGTERM is just TerminateProcess,
      // which cannot flush). MEASURED 2026-09-04 with this arg set: q → exit 0
      // in ~6 s (the output pacing filter drains its buffer at real time),
      // SIGINT → exit 255 in ~3 s, SIGTERM → exit 255 in ~5 s. So allow the
      // graceful path real time before escalating, or it never gets to finish.
      const graceMs = this.opts.stopGraceMs == null ? 9000 : this.opts.stopGraceMs;
      const intTimer = setTimeout(() => { try { this._proc.kill('SIGINT'); } catch {} }, graceMs);
      const killTimer = setTimeout(() => { try { this._proc.kill('SIGKILL'); } catch {} }, graceMs + 4000);
      this._proc.on('close', () => { clearTimeout(intTimer); clearTimeout(killTimer); resolve(); });
      try { this._proc.stdin.write('q\n'); }
      catch { try { this._proc.kill('SIGINT'); } catch { clearTimeout(intTimer); clearTimeout(killTimer); resolve(); } }
    });
  }
}

module.exports = { Broadcast, describeFailure, spawnOptions, VERIFY_AT_SEC, STALL_TIMEOUT_MS };
