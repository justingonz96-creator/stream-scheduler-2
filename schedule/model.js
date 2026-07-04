'use strict';
// Pure helpers for the scheduler: the event shape and the timing math. No I/O,
// no clock of its own (callers pass nowMs), no id source of its own (callers pass
// genId) — so every function is deterministic and trivially testable.

const GRACE_MS = 2 * 60 * 1000;   // start up to 2 min late, otherwise "missed"
const MAX_RESUMES = 3;            // cap reconnect-and-resume attempts per broadcast

function normalizeEvent(e) {
  return Object.assign({
    id: '', slotId: '', title: '',
    fileName: '', filePath: '', durationSec: 0, vertical: false,
    stationName: '',   // display-only: the studio picked at schedule time (go-live re-resolves fresh)
    contentItemGuid: '', scheduleGuid: '',
    fireAt: 0, leadMs: 0, autoStop: true, repeatWeekly: false, needsVideo: false,
    status: 'pending', outcome: '', doneAt: 0,
  }, e);
}

function streamAtOf(ev) { return ev.fireAt - (ev.leadMs || 0); }

function computeLeadSec(ev, nowMs) { return Math.max(0, Math.round((ev.fireAt - nowMs) / 1000)); }

function plannedVideoEndAtMs(ev) { return ev.fireAt + (ev.durationSec || 0) * 1000; }

function joinRtmpUrl(server, key) { return String(server).replace(/\/+$/, '') + '/' + key; }

function renewWeekly(ev, nowMs, genId) {
  if (!ev.repeatWeekly) return null;
  const WEEK = 7 * 86400000;
  let next = ev.fireAt;
  do { next += WEEK; } while (next <= nowMs + 60000);
  return normalizeEvent({
    id: genId(), slotId: ev.slotId || ev.id, title: ev.title,
    autoStop: ev.autoStop, leadMs: ev.leadMs,
    repeatWeekly: true, needsVideo: true,
    fireAt: next, status: 'pending',
  });
}

module.exports = {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
};
