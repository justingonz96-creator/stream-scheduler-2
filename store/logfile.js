'use strict';
// A small rolling log file for the main process. Everything that used to go
// only to console.log — which a packaged app sends nowhere — lands here too, so
// "why didn't the copy happen?" is answerable after the fact. Never throws.
const fs = require('node:fs');
const path = require('node:path');

function createLogFile({ file, maxBytes = 2 * 1024 * 1024, now = () => new Date() }) {
  let size = -1;   // unknown until first write
  function write(line) {
    try {
      if (size < 0) {
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* exists */ }
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      const rec = now().toISOString() + ' ' + String(line) + '\n';
      if (size + rec.length > maxBytes) {
        try { fs.renameSync(file, file + '.1'); } catch { /* first roll or gone */ }
        size = 0;
      }
      fs.appendFileSync(file, rec);
      size += rec.length;
    } catch { /* logging must never take the app down */ }
  }
  return { write, path: file };
}

module.exports = { createLogFile };
