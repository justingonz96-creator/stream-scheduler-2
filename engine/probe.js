'use strict';
const { execFile } = require('node:child_process');
const { ffprobePath } = require('./ffmpeg');

function probeFile(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath(),
      ['-v','error','-print_format','json','-show_format','-show_streams', filePath],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error:
            'This video file could not be opened. Check that the file plays, and that the network drive is connected.' });
          return;
        }
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
        resolve({
          ok: true,
          durationSec,
          width: v.width || 0, height: v.height || 0,
          hasAudio: true,
        });
      });
  });
}

module.exports = { probeFile };
