'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { ffmpegPath } = require('./ffmpeg');
const { buildBroadcastArgs, videoStartsAtSec } = require('./timeline');

const VERIFY_AT_SEC = 0.5;   // out_time must pass this to count as "actually playing"

class Broadcast extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.outTimeSec = 0;
    this._proc = null;
    this._playing = false;
    this._stopping = false;
    this._stderrTail = '';
  }

  start() {
    const args = buildBroadcastArgs(this.opts);
    this._proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._proc.stdout.on('data', (buf) => {          // -progress pipe:1 key=value lines
      for (const line of String(buf).split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m) {
          this.outTimeSec = Number(m[1]) / 1e6;
          if (!this._playing && this.outTimeSec >= VERIFY_AT_SEC) {
            this._playing = true;
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
      if (this._stopping) return;                     // deliberate stop: caller handles state
      if (!this._playing) {
        this.emit('failed', { reason:
          'The broadcast could not start — the video (or slate) file could not be played. ' +
          'Check the file and the network drive. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')' });
      } else if (code === 0) {
        this.emit('ended');
      } else {
        this.emit('failed', { reason:
          'The broadcast stopped unexpectedly (connection or file problem). ' +
          'It can be resumed. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')' });
      }
    });
  }

  videoOffsetSec() {
    const inVideo = Math.max(0, this.outTimeSec - videoStartsAtSec(this.opts));
    return inVideo + (this.opts.resumeOffsetSec || 0);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.exitCode !== null) { resolve(); return; }
      this._stopping = true;
      const killTimer = setTimeout(() => { try { this._proc.kill('SIGKILL'); } catch {} }, 3000);
      this._proc.on('close', () => { clearTimeout(killTimer); resolve(); });
      try { this._proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
    });
  }
}

module.exports = { Broadcast, VERIFY_AT_SEC };
