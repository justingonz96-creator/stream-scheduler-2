'use strict';
// The schedule (list of events/weekly slots) as one atomic JSON file. The stream
// key is NEVER a field here — it is resolved fresh at go-live and held in memory.
const { readJsonResilient, writeJsonAtomic } = require('./jsonstore');

function createScheduleStore({ file }) {
  return {
    load() {
      const v = readJsonResilient(file, []);   // absent → []; corrupt-with-no-backup → throws ECORRUPT
      if (Array.isArray(v)) return v;
      // Parsed, but not a list of events — treat like corruption rather than
      // silently resetting to [] (which the caller would then persist over the
      // real file). The app's boot handler moves this file aside and alerts.
      const e = new Error(file + ' is not a list of scheduled events');
      e.code = 'ECORRUPT';
      e.file = file;
      throw e;
    },
    save(events) { writeJsonAtomic(file, events); },
  };
}

module.exports = { createScheduleStore };
