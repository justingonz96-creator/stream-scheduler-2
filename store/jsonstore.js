'use strict';
// Atomic JSON files (spec §7): write a sibling temp file, then rename over the
// target — a crash mid-write can never leave a half-written settings/schedule file.
const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

// Like readJson, but it will NOT quietly turn unreadable data into the empty
// fallback. It distinguishes three cases:
//   - file absent            → fallback (a legitimate fresh start)
//   - file present + corrupt  → try the rolling .bak sibling; if THAT is usable,
//                               return it (a single-file corruption self-heals)
//   - corrupt with no good bak → throw a tagged error (code 'ECORRUPT')
// This is what stops a transient read failure of an existing schedule.json from
// being mistaken for "no schedule" and then overwritten with [] (data loss).
function readJsonResilient(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (primaryErr) {
    const bak = filePath + '.bak';
    if (fs.existsSync(bak)) {
      try { return JSON.parse(fs.readFileSync(bak, 'utf8')); } catch { /* bak also bad → fall through */ }
    }
    const e = new Error('Could not read ' + filePath + ' and no usable backup exists: ' + primaryErr.message);
    e.code = 'ECORRUPT';
    e.file = filePath;
    throw e;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // Keep ONE previous generation as a rolling backup before the replace, so a
  // later corruption of the primary can be recovered by readJsonResilient.
  // Best-effort: a failed backup copy must never block the real write.
  try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* ignore */ }
  fs.renameSync(tmp, filePath);
}

module.exports = { readJson, readJsonResilient, writeJsonAtomic };
