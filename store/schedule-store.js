'use strict';
// The schedule (list of events/weekly slots) as one atomic JSON file. The stream
// key is NEVER a field here — it is resolved fresh at go-live and held in memory.
const { readJson, writeJsonAtomic } = require('./jsonstore');

function createScheduleStore({ file }) {
  return {
    load() { const v = readJson(file, []); return Array.isArray(v) ? v : []; },
    save(events) { writeJsonAtomic(file, events); },
  };
}

module.exports = { createScheduleStore };
