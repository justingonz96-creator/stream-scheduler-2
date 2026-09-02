'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ffmpeg = require('./ffmpeg');
const { buildBroadcastArgs, videoStartsAtSec } = require('./timeline');

const VERIFY_AT_SEC = 0.5;      // out_time must pass this to count as "actually playing"
const STALL_TIMEOUT_MS = 20000; // once playing, this long with NO new video = a frozen encode

/* One broadcast attempt = one Broadcast instance. start() may be called once; to
   retry a failed start or resume after a crash, create a NEW Broadcast (passing
   resumeOffsetSec from the old instance's videoOffsetSec()). The rehearsal
   harnesses model this pattern. */
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
  }

  _fail(reason) {
    if (this._finalized || this._stopping) return;
    this._finalized = true;
    this.emit('failed', { reason });
  }

  start() {
    if (this._proc) throw new Error('Broadcast is one-shot: create a new Broadcast to retry or resume.');

    const args = buildBroadcastArgs(this.opts);
    this._proc = spawn(ffmpeg.ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._proc.on('error', (err) => {
      this._fail('The broadcast could not start — the built-in video engine failed to launch. ' +
        'Reinstall Stream Scheduler, or contact the admin. (' + err.message + ')');
    });
    this._proc.stdout.on('data', (buf) => this._onProgressData(buf));   // -progress pipe:1 key=value lines
    this._proc.stderr.on('data', (buf) => {
      this._stderrTail = (this._stderrTail + String(buf)).slice(-2000);
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
        this._fail('The broadcast could not start — the video (or slate) file could not be played. ' +
          'Check the file and the network drive. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')');
      } else {
        this._fail('The broadcast stopped unexpectedly (connection or file problem). ' +
          'It can be resumed. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')');
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
    if (this._now() - this._lastAdvanceAt < stallMs) return;   // still advancing recently → fine
    clearInterval(this._stallTimer); this._stallTimer = null;
    this._fail('The broadcast froze — no new video was sent for about ' + Math.round(stallMs / 1000) +
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
      const killTimer = setTimeout(() => { try { this._proc.kill('SIGKILL'); } catch {} }, 3000);
      this._proc.on('close', () => { clearTimeout(killTimer); resolve(); });
      try { this._proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
    });
  }
}

module.exports = { Broadcast, VERIFY_AT_SEC, STALL_TIMEOUT_MS };
