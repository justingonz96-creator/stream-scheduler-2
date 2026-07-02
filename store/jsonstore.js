'use strict';
// Atomic JSON files (spec §7): write a sibling temp file, then rename over the
// target — a crash mid-write can never leave a half-written settings/schedule file.
const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { readJson, writeJsonAtomic };
