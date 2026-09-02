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

// Advance a timestamp by exactly one week in the STUDIO's local calendar,
// preserving the wall-clock hour/minute. A calendar week that spans a Daylight
// Saving change is 167 or 169 hours — not 168 — so adding a fixed 7×86400000 ms
// would land the class an hour off its slot twice a year. Date.setDate does the
// arithmetic in local time and keeps the clock time, which is what the studio
// actually schedules against.
function addOneWeekLocal(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

function renewWeekly(ev, nowMs, genId) {
  if (!ev.repeatWeekly) return null;
  let next = addOneWeekLocal(ev.fireAt);
  while (next <= nowMs + 60000) next = addOneWeekLocal(next);
  return normalizeEvent({
    id: genId(), slotId: ev.slotId || ev.id, title: ev.title,
    autoStop: ev.autoStop, leadMs: ev.leadMs,
    repeatWeekly: true, needsVideo: true,
    fireAt: next, status: 'pending',
  });
}

// Is it safe for the app to quit-and-relaunch itself right now (a pending
// self-update)? Reuses the SAME "is this class still catchable" arithmetic as
// the late-start feature (schedule/scheduler.js) so the two stay consistent:
// a class that's due, live, or still within its own late-start catch-up window
// blocks the update; a weekly slot with no video yet can never block (it can't
// go live without one); anything already finished never blocks.
function isSafeToUpdate(events, nowMs, bufferMs = 15 * 60 * 1000) {
  const live = events.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
  if (live) return { safe: false, reason: 'a broadcast is live right now' };
  const imminent = events.find((e) => {
    if (e.status !== 'pending' || e.needsVideo) return false;
    if (e.fireAt - nowMs > bufferMs) return false;                 // not due soon enough to matter
    return e.durationSec > 0 ? (nowMs - e.fireAt) < e.durationSec * 1000 : (nowMs - e.fireAt) <= GRACE_MS;
  });
  if (imminent) return { safe: false, reason: 'a broadcast is scheduled to start soon' };
  return { safe: true, reason: '' };
}

// Which slate picture to show for a class of the given orientation. Prefers the
// slate that matches the class shape, but falls back to the other one when only
// one is configured — so setting a single slate keeps behaving exactly as before
// (non-breaking), and adding the second slate is purely additive.
function resolveSlateImage(settings, vertical) {
  const s = settings || {};
  return vertical
    ? (s.slateImageVertical || s.slateImage || '')
    : (s.slateImage || s.slateImageVertical || '');
}

module.exports = {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly, isSafeToUpdate, resolveSlateImage,
};
