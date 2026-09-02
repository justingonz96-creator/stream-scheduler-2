'use strict';
// Pure logic ported from 1.x portal-helper.py: a class (content item) embeds its
// broadcast occurrences, each carrying its own scheduleGuid + control-station.
// From the durable class link we can discover what to stream and what to end.

const VERTICAL_MEDIUMS = new Set(['reflect']);   // Echelon Reflect (the mirror) is portrait 9:16

function isVertical(medium) {
  return VERTICAL_MEDIUMS.has(String(medium || '').trim().toLowerCase());
}

function parseContentItem(data) {
  const item = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : (data || {});
  const medium = item.medium == null ? null : item.medium;
  const occurrences = [];
  for (const s of (Array.isArray(item.schedule) ? item.schedule : [])) {
    if (!s || typeof s !== 'object') continue;
    const cs = s.controlStation || {};
    const av = s.available || {};
    occurrences.push({
      scheduleGuid: s.guid ?? null,
      stationGuid: cs.guid ?? null,
      stationName: cs.name ?? null,
      type: s.type ?? null,
      start: av.start ?? null,   // null (not undefined): the 1.x contract — undefined keys
      end: av.end ?? null,       // vanish under JSON.stringify (schedule.json, logs, IPC)
    });
  }
  return { occurrences, medium };
}

const GRACE = 2 * 3600;            // treat "now" as inside a window even a couple hours either side
const DEFAULT_SPAN = 4 * 3600;     // occurrences without an end get a 4-hour window

function pickOccurrence(occurrences, nowSec) {
  const cands = occurrences.filter(o => o.scheduleGuid && o.stationGuid);
  if (cands.length === 0) return null;
  const timed = cands.filter(o => typeof o.start === 'number' && Number.isFinite(o.start));
  const inWindow = timed.filter(o =>
    (o.start - GRACE) <= nowSec && nowSec <= ((o.end || (o.start + DEFAULT_SPAN)) + GRACE));
  if (inWindow.length > 0) {
    // The window's forward GRACE also admits occurrences that have NOT started
    // yet (up to 2h out). Among the in-window candidates, prefer the latest one
    // that has ACTUALLY started (start <= now) — an occurrence still in the
    // future must never be chosen over the one live now (which would stream to
    // the wrong studio). Only if none have started do we fall back to the
    // soonest upcoming one.
    const started = inWindow.filter((o) => o.start <= nowSec);
    const pool = started.length > 0 ? started : inWindow;
    return pool.slice().sort((a, b) => a.start - b.start)[pool.length - 1];  // latest start in the chosen pool
  }
  if (timed.length > 0) {
    return timed.reduce((best, o) => Math.abs(o.start - nowSec) < Math.abs(best.start - nowSec) ? o : best);
  }
  return cands[0];
}

function matchOccurrence(occurrences, scheduleGuid) {
  if (!scheduleGuid) return null;
  return occurrences.find(o => o.scheduleGuid === scheduleGuid) || null;
}

module.exports = { parseContentItem, pickOccurrence, matchOccurrence, isVertical, VERTICAL_MEDIUMS, GRACE };
