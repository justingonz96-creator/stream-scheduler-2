'use strict';
// The scheduler brain. Ports the DECISIONS of 1.x's engineTick/startBroadcast/
// finishPlayback/renewWeekly/adoptInterrupted, but the engine (Plan 1) now does
// slate→music→fade→video as one encode and reports playing/ended/failed — so no
// media-state polling, scenes, or audio muting live here. Every dependency is
// injected; with fakes this whole file runs offline under node:test.
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
} = require('./model');

function createScheduler({ store, portal, engineFactory, settings, now = () => Date.now(), genId, log = () => {} }) {
  let events = store.load().map(normalizeEvent);
  let active = null;      // { eventId, broadcast, target, sawPlaying, retried, resumeCount }
  let busy = false;       // one go-live / takeover / stop orchestration at a time
  let timer = null;
  const listeners = new Set();

  const emit = () => { const snap = getEvents(); for (const fn of listeners) { try { fn(snap); } catch {} } };
  const persist = () => { store.save(events); emit(); };
  const byId = (id) => events.find((e) => e.id === id) || null;
  function getEvents() { return events.map((e) => ({ ...e })); }

  // ----- crash recovery: a live ffmpeg cannot survive an app restart -----
  for (const ev of events) {
    if (['starting', 'preshow', 'playing'].includes(ev.status)) {
      ev.status = 'missed';
      ev.outcome = 'Interrupted — the app was closed during the broadcast';
      ev.doneAt = now();
      renew(ev);
    }
  }
  store.save(events);   // no emit yet (no listeners at construction)

  function renew(ev) {
    const slot = ev.slotId || ev.id;
    if (events.some((e) => e.status === 'pending' && (e.slotId || e.id) === slot)) return;   // already renewed
    const nv = renewWeekly(ev, now(), genId);
    if (nv) events.push(nv);
  }

  function markMissed(ev) {
    ev.status = 'missed';
    ev.outcome = ev.needsVideo ? 'Missed — no video was chosen for this week'
                               : 'Missed — this window was not open at start time';
    ev.doneAt = now();
    renew(ev);
    persist();
  }

  function fail(ev, reason) {
    ev.status = 'failed';
    ev.outcome = 'Could not start: ' + reason;
    ev.doneAt = now();
    renew(ev);
    persist();
  }

  async function endPortal(ev) {
    if (!ev || (!ev.contentItemGuid && !ev.scheduleGuid)) return;   // no class link → nothing to end
    try {
      const r = await portal.endBroadcast({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid });
      log('portal end -> ' + (r && r.ok ? 'ok' : ('not confirmed: ' + ((r && (r.error || r.status)) || '?'))));
    } catch (e) { log('portal end error: ' + (e && e.message)); }
  }

  function spawn(ev, { leadSec, resumeOffsetSec, target, retried, resumeCount }) {
    const s = settings.get();
    const useSlate = leadSec > 0;
    const bc = engineFactory({
      videoPath: ev.filePath,
      vertical: !!target.vertical,
      bitrateKbps: s.videoBitrate,
      fps: 30,
      leadSec,
      fadeSec: (s.fadeMs || 0) / 1000,
      slateImage: useSlate ? s.slateImage : '',
      slateMusic: useSlate ? s.slateMusic : '',
      resumeOffsetSec,
      outUrl: joinRtmpUrl(target.server, target.key),
    });
    active = { eventId: ev.id, broadcast: bc, target, sawPlaying: false, retried, resumeCount };
    bc.on('playing', () => onPlaying(ev.id));
    bc.on('ended', () => { onEnded(ev.id); });
    bc.on('failed', (info) => { onFailed(ev.id, (info && info.reason) || 'unknown'); });
    try { bc.start(); }
    catch (e) { onFailed(ev.id, (e && e.message) || 'the video engine could not start'); }
  }

  function onPlaying(id) {
    if (!active || active.eventId !== id) return;
    active.sawPlaying = true;
    const ev = byId(id); if (!ev) return;
    ev.status = now() >= ev.fireAt ? 'playing' : 'preshow';
    persist();
  }

  async function onEnded(id) {
    if (!active || active.eventId !== id) return;
    const ev = byId(id); const target = active.target; active = null;
    if (!ev) return;
    if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
    else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
    ev.status = 'done'; ev.doneAt = now();
    renew(ev); persist();
    void target;
  }

  async function onFailed(id, reason) {
    if (!active || active.eventId !== id) return;
    const ev = byId(id); if (!ev) { active = null; return; }
    const { sawPlaying, retried, resumeCount, target, broadcast } = active;

    if (!sawPlaying) {
      // never went live → retry exactly once
      active = null;
      if (!retried) {
        log('start failed, retrying once: ' + reason);
        spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: true, resumeCount });
      } else {
        fail(ev, reason);
      }
      return;
    }

    // was live → resume at offset, unless we're basically done or out of tries
    const offset = typeof broadcast.videoOffsetSec === 'function' ? broadcast.videoOffsetSec() : 0;
    active = null;
    if (now() >= plannedVideoEndAtMs(ev) - 1500) {
      // effectively finished — treat as a clean play
      if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
      else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
      ev.status = 'done'; ev.doneAt = now(); renew(ev); persist();
      return;
    }
    if (resumeCount >= MAX_RESUMES) {
      await endPortal(ev);
      ev.status = 'failed'; ev.outcome = 'The stream kept dropping and could not be recovered';
      ev.doneAt = now(); renew(ev); persist();
      return;
    }
    log('stream dropped, resuming at ' + offset + 's');
    spawn(ev, { leadSec: 0, resumeOffsetSec: offset, target, retried: true, resumeCount: resumeCount + 1 });
  }

  async function takeover(prev) {
    prev.status = 'done';
    prev.outcome = 'Ended early — the next scheduled video started';
    prev.doneAt = now();
    const bc = active && active.broadcast;
    if (prev.autoStop) await endPortal(prev);
    active = null;
    try { if (bc) bc.stop(); } catch {}
    renew(prev);
    persist();
  }

  async function goLive(ev) {
    ev.status = 'starting'; persist();
    log('starting broadcast: ' + (ev.title || ev.fileName || ev.id));
    const target = await portal.streamTarget({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid });
    if (!target || !target.ok) { fail(ev, (target && target.error) || 'no studio was returned by the portal'); return; }
    spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: false, resumeCount: 0 });
  }

  async function tick() {
    const t = now();
    for (const ev of events) {
      if (ev.status !== 'pending') continue;
      if (t < streamAtOf(ev)) continue;
      if (t - ev.fireAt > GRACE_MS) { markMissed(ev); continue; }
      if (ev.needsVideo) continue;             // a weekly slot with no video never goes live
      if (busy) continue;
      if (active) {
        const cur = byId(active.eventId);
        if (cur && cur.id !== ev.id && ['starting', 'preshow', 'playing'].includes(cur.status)) {
          busy = true;
          try { await takeover(cur); await goLive(ev); } finally { busy = false; }
        }
        continue;
      }
      busy = true;
      try { await goLive(ev); } finally { busy = false; }
    }
    // slate→video label flip (the engine already faded on its own at fireAt)
    if (active) {
      const cur = byId(active.eventId);
      if (cur && cur.status === 'preshow' && t >= cur.fireAt) { cur.status = 'playing'; persist(); }
    }
  }

  function addEvent(ev) {
    const norm = normalizeEvent({ ...ev, id: ev.id || genId() });
    events.push(norm); persist();
    return { ...norm };
  }

  function removeEvent(id) {
    if (active && active.eventId === id) return { ok: false, error: 'Stop the live broadcast before removing it.' };
    const before = events.length;
    events = events.filter((e) => e.id !== id);
    if (events.length === before) return { ok: false, error: 'That broadcast was not found.' };
    persist();
    return { ok: true };
  }

  async function stopActive(id) {
    if (!active || active.eventId !== id) return { ok: false, error: 'That broadcast is not currently live.' };
    if (busy) return { ok: false, error: 'The scheduler is busy — try again in a moment.' };
    busy = true;
    try {
      const ev = byId(id); const bc = active.broadcast; active = null;
      await endPortal(ev);                 // end-portal-before-stop
      try { bc.stop(); } catch {}
      if (ev) { ev.status = 'done'; ev.outcome = 'Stopped by the operator'; ev.doneAt = now(); renew(ev); }
      persist();
      return { ok: true };
    } finally { busy = false; }
  }

  function onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function start() { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, 1000); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop, getEvents, addEvent, removeEvent, stopActive, onChanged };
}

module.exports = { createScheduler };
