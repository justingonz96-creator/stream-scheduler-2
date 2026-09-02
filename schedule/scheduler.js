'use strict';
// The scheduler brain. Ports the DECISIONS of 1.x's engineTick/startBroadcast/
// finishPlayback/renewWeekly/adoptInterrupted, but the engine (Plan 1) now does
// slate→music→fade→video as one encode and reports playing/ended/failed — so no
// media-state polling, scenes, or audio muting live here. Every dependency is
// injected; with fakes this whole file runs offline under node:test.
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly, isSafeToUpdate, resolveSlateImage,
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
  let recovered = false;
  for (const ev of events) {
    if (['starting', 'preshow', 'playing'].includes(ev.status)) {
      ev.status = 'missed';
      ev.outcome = 'Interrupted — the app was closed during the broadcast';
      ev.doneAt = now();
      recovered = true;
      renew(ev);
    }
  }
  // Persist ONLY if recovery actually changed the schedule. A blind boot-time
  // save would rewrite schedule.json on every launch, which is exactly what
  // turned a bad load into permanent data loss — so we never write unless we
  // have something to write. (No emit yet: no listeners at construction.)
  if (recovered) store.save(events);

  function renew(ev) {
    const slot = ev.slotId || ev.id;
    if (events.some((e) => e.status === 'pending' && (e.slotId || e.id) === slot)) return;   // already renewed
    const nv = renewWeekly(ev, now(), genId);
    if (nv) events.push(nv);
  }

  function markMissed(ev, reason) {
    ev.status = 'missed';
    ev.outcome = reason || (ev.needsVideo ? 'Missed — no video was chosen for this week'
                                          : 'Missed — this window was not open at start time');
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

  // The engine's failure reason can embed ffmpeg stderr, which on a connection
  // error prints the full output URL — INCLUDING the stream key. Scrub it before
  // anything reaches a log line or the persisted outcome (key-secrecy law).
  function redactSecrets(text, target) {
    let s = String(text == null ? '' : text);
    if (target) {
      if (target.server && target.key) { const u = joinRtmpUrl(target.server, target.key); if (u) s = s.split(u).join('***'); }
      if (target.key) s = s.split(target.key).join('***');
    }
    return s;
  }

  function spawn(ev, { leadSec, resumeOffsetSec, target, retried, resumeCount }) {
    const s = settings.get();
    // Match the slate to the class shape (the SAME target.vertical the canvas
    // uses), so a vertical class gets the 9:16 slate and never a letterboxed one.
    const slateImage = resolveSlateImage(s, !!target.vertical);
    const useSlate = leadSec > 0 && !!slateImage;
    const bc = engineFactory({
      videoPath: ev.filePath, vertical: !!target.vertical, bitrateKbps: s.videoBitrate, fps: 30,
      leadSec: useSlate ? leadSec : 0,
      fadeSec: (s.fadeMs || 0) / 1000,
      slateImage: useSlate ? slateImage : '', slateMusic: useSlate ? s.slateMusic : '',
      resumeOffsetSec, outUrl: joinRtmpUrl(target.server, target.key),
    });
    active = { eventId: ev.id, broadcast: bc, target, sawPlaying: false, retried, resumeCount };
    bc.on('playing', () => { try { onPlaying(ev.id, bc); } catch (e) { log('playing handler error: ' + ((e && e.message) || e)); } });
    bc.on('ended', () => { onEnded(ev.id, bc).catch((e) => log('ended handler error: ' + ((e && e.message) || e))); });
    bc.on('failed', (info) => { onFailed(ev.id, (info && info.reason) || 'unknown', bc).catch((e) => log('failed handler error: ' + ((e && e.message) || e))); });
    try { bc.start(); }
    catch (e) { onFailed(ev.id, (e && e.message) || 'the video engine could not start', bc).catch(() => {}); }
  }

  function onPlaying(id, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    active.sawPlaying = true;
    const ev = byId(id); if (!ev) return;
    ev.status = now() >= ev.fireAt ? 'playing' : 'preshow';
    persist();
  }

  async function onEnded(id, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    const ev = byId(id); active = null;
    if (!ev) return;
    if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
    else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
    ev.status = 'done'; ev.doneAt = now();
    renew(ev); persist();
  }

  async function onFailed(id, reason, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    const ev = byId(id); if (!ev) { active = null; return; }
    const { sawPlaying, retried, resumeCount, target, broadcast } = active;
    const safeReason = redactSecrets(reason, target);
    if (!sawPlaying) {
      active = null;
      if (!retried) {
        log('start failed, retrying once: ' + safeReason);
        // Mirror goLive: if the class is already late, the retry must seek the
        // video to the elapsed point (no slate) so it still ends at its scheduled
        // end time — NOT restart from 0:00, which would air minutes off-schedule.
        // When not late (e.g. a blip during the pre-roll slate) lateSec is 0, so
        // this is identical to the previous behaviour (slate lead, no seek).
        const lateSec = Math.max(0, (now() - ev.fireAt) / 1000);
        const retryLead = lateSec > 0 ? 0 : computeLeadSec(ev, now());
        spawn(ev, { leadSec: retryLead, resumeOffsetSec: lateSec, target, retried: true, resumeCount });
      } else { fail(ev, safeReason); }
      return;
    }
    const offset = typeof broadcast.videoOffsetSec === 'function' ? broadcast.videoOffsetSec() : 0;
    active = null;
    if (now() >= plannedVideoEndAtMs(ev) - 1500) {
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
    // Resume placement. Mid-video drop (offset>0): pick the video back up where
    // it dropped. Froze during the pre-roll slate (offset 0): normally re-show the
    // slate — BUT the stall watchdog can take ~20s to notice, so by now we may be
    // past fireAt. In that case seek to the elapsed point (no slate), exactly like
    // goLive and the retry path, so the class still ends at its scheduled time
    // instead of restarting the video at 0:00 and ending late.
    let resumeLead, resumeOffset;
    if (offset > 0) {
      resumeLead = 0; resumeOffset = offset;
    } else {
      const lateSec = Math.max(0, (now() - ev.fireAt) / 1000);
      if (lateSec > 0) { resumeLead = 0; resumeOffset = lateSec; }        // past fireAt → seek to the clock
      else { resumeLead = computeLeadSec(ev, now()); resumeOffset = 0; }  // still pre-roll → fresh slate
    }
    log('stream dropped, resuming' + (resumeOffset === 0 ? ' (still pre-roll)' : ' at ' + Math.round(resumeOffset) + 's'));
    spawn(ev, { leadSec: resumeLead, resumeOffsetSec: resumeOffset, target, retried: true, resumeCount: resumeCount + 1 });
  }

  async function takeover(prev) {
    const bc = active && active.broadcast;
    active = null;                                 // unlink FIRST — a late event from the outgoing engine can't resume-spawn
    prev.status = 'done';
    prev.outcome = 'Ended early — the next scheduled video started';
    prev.doneAt = now();
    if (prev.autoStop) await endPortal(prev);      // end-portal-before-stop
    try { if (bc) bc.stop(); } catch {}
    renew(prev); persist();
  }

  async function goLive(ev) {
    ev.status = 'starting'; persist();
    log('starting broadcast: ' + (ev.title || ev.fileName || ev.id));
    let target;
    try { target = await portal.streamTarget({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid }); }
    catch (e) { fail(ev, 'the studio could not be reached: ' + ((e && e.message) || e)); return; }
    if (!target || !target.ok) { fail(ev, (target && target.error) || 'no studio was returned by the portal'); return; }
    // Starting late: no slate (the video should already be under way), and seek
    // in by exactly how late we are — the SAME resumeOffsetSec mechanism already
    // proven for the mid-broadcast-drop recovery path, just triggered by a late
    // start instead of a dropped connection. Because it lands the video at the
    // real elapsed time, the class still finishes at its originally scheduled
    // end time — "ends around" stays honest with no other change needed.
    const lateSec = Math.max(0, (now() - ev.fireAt) / 1000);
    const leadSec = lateSec > 0 ? 0 : computeLeadSec(ev, now());
    spawn(ev, { leadSec, resumeOffsetSec: lateSec, target, retried: false, resumeCount: 0 });
  }

  async function tick() {
    const t = now();
    const sset = settings.get();
    const hasSlate = !!(sset.slateImage || sset.slateImageVertical);
    for (const ev of events) {
      if (ev.status !== 'pending') continue;
      const streamAt = hasSlate ? streamAtOf(ev) : ev.fireAt;
      if (t < streamAt) continue;
      if (ev.needsVideo) {
        if (t - ev.fireAt > GRACE_MS) markMissed(ev);   // no video ever showed up for this slot
        continue;                                        // a weekly slot with no video never goes live
      }
      // A late start seeks the video ahead to match the clock (below) rather than
      // capping at a fixed grace window — so "missed" now means the video itself
      // would already be finished by the time it could start, not just "took a
      // while to notice". durationSec is unknown (0) only defensively (a probed
      // event always has it); fall back to the old fixed cap in that case.
      const lateSec = Math.max(0, (t - ev.fireAt) / 1000);
      if (ev.durationSec > 0) {
        if (lateSec >= ev.durationSec) { markMissed(ev, 'Missed — this class would already be over by the time it could start'); continue; }
      } else if (t - ev.fireAt > GRACE_MS) { markMissed(ev); continue; }
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
    // IPC payloads can never inject lifecycle state: born pending, no slot identity.
    const norm = normalizeEvent({ ...ev, id: ev.id || genId(), status: 'pending', outcome: '', doneAt: 0, slotId: '', needsVideo: false });
    events.push(norm); persist();
    return { ...norm };
  }

  // Editing an upcoming broadcast. Same law as addEvent: a wire payload can only
  // change the fields an operator legitimately owns — never lifecycle state, never
  // the id, and never a weekly slot's identity (that chain must survive an edit).
  const EDITABLE = ['title', 'fileName', 'filePath', 'durationSec', 'vertical', 'stationName',
                    'contentItemGuid', 'scheduleGuid', 'fireAt', 'leadMs', 'autoStop', 'repeatWeekly'];
  function updateEvent(id, patch) {
    if (busy) return { ok: false, error: 'The scheduler is busy — try again in a moment.' };
    if (active && active.eventId === id) return { ok: false, error: 'Stop the live broadcast before changing it.' };
    const ev = byId(id);
    if (!ev) return { ok: false, error: 'That broadcast was not found.' };
    if (ev.status !== 'pending') return { ok: false, error: 'Only upcoming broadcasts can be changed.' };
    const p = patch || {};
    const next = { ...ev };
    for (const k of EDITABLE) if (p[k] !== undefined) next[k] = p[k];
    for (const k of ['fireAt', 'leadMs', 'durationSec']) next[k] = Number(next[k]) || 0;
    const merged = normalizeEvent({ ...next, id: ev.id, slotId: ev.slotId, status: 'pending', outcome: '', doneAt: 0 });
    merged.needsVideo = !merged.filePath;   // no video ⇒ still waiting for one (never goes live)
    Object.assign(ev, merged);
    persist();
    return { ok: true, event: { ...ev } };
  }

  function removeEvent(id) {
    if (busy) return { ok: false, error: 'The scheduler is busy — try again in a moment.' };
    if (active && active.eventId === id) return { ok: false, error: 'Stop the live broadcast before removing it.' };
    const before = events.length;
    events = events.filter((e) => e.id !== id);
    if (events.length === before) return { ok: false, error: 'That broadcast was not found.' };
    persist();
    return { ok: true };
  }

  // Clear the history: drop every finished event (done / failed / missed). Upcoming
  // and live events are untouched, and weekly renewals already live as their own
  // pending events, so nothing future is lost.
  function clearPast() {
    if (busy) return { ok: false, error: 'The scheduler is busy — try again in a moment.' };
    const before = events.length;
    events = events.filter((e) => !['done', 'failed', 'missed'].includes(e.status));
    const removed = before - events.length;
    if (removed) persist();
    return { ok: true, removed };
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
  function start() { if (!timer) timer = setInterval(() => { tick().catch((e) => log('tick error: ' + ((e && e.message) || e))); }, 1000); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // App shutdown: clear the timer AND kill any live encode so no ffmpeg child is
  // orphaned (a background process that keeps running after the window closes).
  // Best-effort and synchronous — the app is quitting, so we don't await a
  // portal end here; we just make sure the child dies with us.
  function shutdown() {
    stop();
    const bc = active && active.broadcast;
    active = null;
    try { if (bc) bc.stop(); } catch {}
  }

  function safeToUpdate() { return isSafeToUpdate(events, now()); }

  return { tick, start, stop, shutdown, getEvents, addEvent, updateEvent, removeEvent, clearPast, stopActive, onChanged, isSafeToUpdate: safeToUpdate };
}

module.exports = { createScheduler };
