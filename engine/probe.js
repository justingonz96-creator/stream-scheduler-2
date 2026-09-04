'use strict';
const { execFile } = require('node:child_process');
const { ffprobePath } = require('./ffmpeg');

// "a/b" → number; 0 when unreadable. Used for the frame rate.
function ratio(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s || '').trim());
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : 0;
  const n = Number(s); return Number.isFinite(n) && n > 0 ? n : 0;
}
// Rotation the player is told to apply (display matrix side data, or the older
// tags.rotate). Coded width/height ignore it — a phone-shot portrait video says
// 1920x1080 with rotation -90 and IS portrait (2026-09-04 audit).
function rotationOf(v) {
  const sd = (v.side_data_list || []).find((d) => d && d.rotation != null);
  const r = sd ? Number(sd.rotation) : Number((v.tags && v.tags.rotate) || 0);
  return Number.isFinite(r) ? ((Math.round(r) % 360) + 360) % 360 : 0;
}

function probeFile(filePath, opts = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const run = opts.run || ((a) => new Promise((resolve, reject) => execFile(ffprobePath(), a, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))));
  return new Promise((resolve) => {
    Promise.resolve().then(() => run(args)).then((stdout) => {
      {
        let info; try { info = JSON.parse(stdout); } catch {
          resolve({ ok: false, error: 'This video file could not be read.' }); return;
        }
        const v = (info.streams || []).find(s => s.codec_type === 'video');
        const a = (info.streams || []).find(s => s.codec_type === 'audio');
        if (!v) { resolve({ ok: false, error: 'This file has no video in it.' }); return; }
        // A readable length is required: scheduling and the countdown depend on it,
        // and an unreadable length usually means a damaged/unfinished file.
        const durationSec = parseFloat(info.format?.duration || '0') || 0;
        if (durationSec <= 0) { resolve({ ok: false, error:
          "This video's length could not be read — the file may be damaged or still copying. Try playing it first." }); return; }
        if (!a) { resolve({ ok: false, error:
          'This video has no sound. Broadcasts need a video with an audio track.' }); return; }
        const rot = rotationOf(v);
        const swap = rot === 90 || rot === 270;
        resolve({
          ok: true,
          durationSec,
          width: (swap ? v.height : v.width) || 0, height: (swap ? v.width : v.height) || 0,
          fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate) || 0,
          hasAudio: true,
        });
      }
    }).catch(() => {
      resolve({ ok: false, error:
        'This video file could not be opened. Check that the file plays, and that the network drive is connected.' });
    });
  });
}

module.exports = { probeFile };
