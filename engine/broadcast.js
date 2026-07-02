'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const ffmpeg = require('./ffmpeg');
const { buildBroadcastArgs, videoStartsAtSec } = require('./timeline');

const VERIFY_AT_SEC = 0.5;   // out_time must pass this to count as "actually playing"

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
    this._proc.stdout.on('data', (buf) => {          // -progress pipe:1 key=value lines
      this._stdoutBuf += String(buf);
      const lines = this._stdoutBuf.split('\n');
      this._stdoutBuf = lines.pop();                  // keep the trailing partial line for the next chunk
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m) {
          this.outTimeSec = Number(m[1]) / 1e6;
          if (!this._playing && this.outTimeSec >= VERIFY_AT_SEC) {
            this._playing = true;
            clearTimeout(this._startTimer);
            this.emit('playing');
          }
          this.emit('progress', { outTimeSec: this.outTimeSec });
        }
      }
    });
    this._proc.stderr.on('data', (buf) => {
      this._stderrTail = (this._stderrTail + String(buf)).slice(-2000);
    });
    this._proc.on('close', (code) => {
      clearTimeout(this._startTimer);
      if (this._stopping || this._finalized) return;  // deliberate stop, or already failed via 'error'
      if (!this._playing) {
        this._fail('The broadcast could not start — the video (or slate) file could not be played. ' +
          'Check the file and the network drive. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')');
      } else if (code === 0) {
        this._finalized = true;
        this.emit('ended');
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

  videoOffsetSec() {
    const inVideo = Math.max(0, this.outTimeSec - videoStartsAtSec(this.opts));
    return inVideo + (this.opts.resumeOffsetSec || 0);
  }

  stop() {
    clearTimeout(this._startTimer);
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

module.exports = { Broadcast, VERIFY_AT_SEC };
