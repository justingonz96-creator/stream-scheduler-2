'use strict';
// The renderer's DOM controller. All brain access goes through window.api
// (real preload bridge in Electron, or the mock in a browser). Pure helpers are
// dual-exported for tests; everything DOM runs only after DOMContentLoaded.

function buildAddPayload(f) {
  return {
    title: f.title || '',
    fileName: f.fileName || '', filePath: f.filePath || '', durationSec: Number(f.durationSec) || 0,
    vertical: !!f.vertical,
    contentItemGuid: f.contentItemGuid || '', scheduleGuid: f.scheduleGuid || '',
    stationName: f.stationName || '',
    fireAt: Number(f.fireAt) || 0, leadMs: (Number(f.leadMin) || 0) * 60000,
    autoStop: f.autoStop === undefined ? true : !!f.autoStop,
    repeatWeekly: !!f.repeatWeekly,
  };
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  if (!api) {
    document.body.innerHTML = '<div style="padding:24px;font:16px system-ui;color:#fff;background:#7f1d1d;">Stream Scheduler could not start its internal connection (the preload bridge is missing). Reinstall the app or contact the admin — nothing here would work.</div>';
    throw new Error('window.api missing');
  }
  const F = window.Fmt, FS = window.FormState;

  // form working state
  const form = { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', stationName: '', linkChecked: false, editingId: null, startNow: false };
  let hasSlateConfigured = false;   // a lead-in only means something when a slate picture is set up

  function applyPhase() {
    const state = { filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked };
    const ph = FS.computeFormPhase(state);
    $('step1').className = 'field ' + ph.step1;
    $('restOfForm').className = ph.rest === 'dim' ? 'form-dim' : '';
    $('pickedSummary').textContent = ph.step1 === 'collapsed' ? '✓ ' + FS.pickedSummary(state) : '';
    $('btnSave').disabled = !ph.canSave;
    $('btnSave').title = ph.canSave ? '' : ph.reasons.join('  •  ');
    $('saveHint').textContent = ph.canSave ? '' : ph.reasons.join('   ');   // visible, not tooltip-only
  }

  function leadMinRaw() { return parseInt($('evLead').value, 10) || 0; }
  // "Start now" means the STREAM goes up now; the lead-in decides whether a slate
  // plays first. With no slate picture set up a lead would just stall silently, so
  // honour the intent instead and roll the video immediately.
  function effectiveLeadMin() { return (form.startNow && !hasSlateConfigured) ? 0 : leadMinRaw(); }

  function recomputeFireAt() {
    form.fireAt = form.startNow
      ? Date.now() + effectiveLeadMin() * 60000
      : (F.parseDateTime($('evDate').value, $('evHour').value, $('evMin').value, $('evAP').value) || 0);
    updateWhenUI();
    applyPhase();
  }

  function updateWhenUI() {
    $('whenLater').className = form.startNow ? 'hidden' : '';
    const hint = $('whenNowHint');
    if (!form.startNow) { hint.textContent = ''; hint.className = 'pickstatus'; return; }
    const lead = effectiveLeadMin();
    const notes = [];
    if (leadMinRaw() > 0 && !hasSlateConfigured) notes.push('your lead-in needs a slate picture — set one up in Setup to use it');
    const live = lastEvents.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
    if (live) notes.push('a broadcast is on air now — starting this one will end it early');
    hint.textContent = '▶ ' + (lead > 0
      ? 'Stream goes live now · slate up for ' + lead + ' min · video starts about ' + F.fmtClock(Date.now() + lead * 60000)
      : 'Stream goes live now · the video starts right away')
      + (notes.length ? ' · ' + notes.join(' · ') : '');
    hint.className = live ? 'pickstatus bad' : 'pickstatus good';
  }

  async function pickVideo() {
    const path = await api.invoke('dialog:openFile', { kind: 'video' });
    if (!path) return;
    const pr = await api.invoke('probe:file', path);
    if (!pr.ok) { $('fileCheck').textContent = '✗ ' + pr.error; $('fileCheck').className = 'pickstatus bad'; return; }
    form.filePath = path; form.fileName = path.split(/[\\/]/).pop(); form.durationSec = pr.durationSec; form.vertical = pr.height > pr.width;
    $('fileCheck').textContent = '✓ ' + F.orientationLabel(form.vertical); $('fileCheck').className = 'pickstatus good';
    applyPhase();
  }

  async function checkLink() {
    // Acknowledge the wait (neutral, no leftover green/red) and block re-presses.
    $('btnEvPortalCheck').disabled = true;
    $('evPortalStatus').textContent = 'Checking…'; $('evPortalStatus').className = 'pickstatus';
    try {
      const r = await api.invoke('portal:checkLink', $('evPortalLink').value.trim());
      if (!r.ok) { $('evPortalStatus').textContent = '✗ ' + r.error; $('evPortalStatus').className = 'pickstatus bad'; form.linkChecked = false; applyPhase(); return; }
      form.contentItemGuid = r.contentItemGuid; form.scheduleGuid = r.scheduleGuid || ''; form.vertical = r.vertical; form.linkChecked = true;
      form.stationName = (r.picked && r.picked.stationName) || '';
      $('evPortalStatus').textContent = '✓ ' + (r.picked && r.picked.stationName ? r.picked.stationName + ' · ' : '') + F.orientationLabel(r.vertical);
      $('evPortalStatus').className = 'pickstatus good'; applyPhase();
    } finally { $('btnEvPortalCheck').disabled = false; }
  }

  async function save() {
    // "now" is resolved at the moment of saving, not when the option was picked.
    if (form.startNow) form.fireAt = Date.now() + effectiveLeadMin() * 60000;
    const ph = FS.computeFormPhase({ filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked });
    if (!ph.canSave) { $('formError').textContent = ph.reasons.join('  '); return; }
    $('formError').textContent = '';
    const payload = buildAddPayload({ ...form, leadMin: effectiveLeadMin(), autoStop: $('evAutoStop').checked, repeatWeekly: $('evRepeat').checked, title: $('evTitle').value.trim() });
    // Disable during the save so a second click can't create a duplicate, and —
    // critically — check the result so a FAILED save doesn't close the form as if
    // it worked (a class would silently never air). Mirrors the edit branch.
    $('btnSave').disabled = true;
    try {
      if (form.editingId) {
        const r = await api.invoke('schedule:update', { id: form.editingId, patch: payload });
        if (!r || !r.ok) { $('formError').textContent = (r && r.error) || 'That broadcast could not be changed. Please try again.'; return; }
      } else {
        const r = await api.invoke('schedule:add', payload);
        if (!r || !r.id) { $('formError').textContent = (r && r.error) || 'That broadcast could not be scheduled. Please try again.'; return; }
      }
      hideForm();
    } catch (e) {
      $('formError').textContent = 'That broadcast could not be saved: ' + ((e && e.message) || e);
    } finally {
      $('btnSave').disabled = false;
    }
  }

  let lastEvents = [];
  // Which upcoming row (if any) is currently showing its two-step "Remove?"
  // confirm. A schedule:changed push rebuilds the whole list, so we remember the
  // id and re-apply the confirm after a rebuild instead of silently dropping it.
  let pendingRemoveId = null;

  // The hero card: the app's one glanceable instrument. ON AIR (remaining time +
  // progress track) / SLATE UP (countdown to the video) / NEXT UP (ticking
  // countdown) / an invitation when nothing is scheduled. Restored from 1.x —
  // its styling (#heroCard/.fc-*) shipped with the theme port.
  function renderHero() {
    const hero = $('heroCard');
    if (!hero) return;
    const now = Date.now();
    const live = lastEvents.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
    if (live) {
      const eye = live.status === 'playing' ? 'On air' : (live.status === 'preshow' ? 'Slate up' : 'Starting…');
      const title = escapeHtml(live.title || live.fileName || '(video)');
      let count, track = '', meta;
      if (live.status !== 'playing') {
        count = F.fmtCountdown(live.fireAt - now);
        meta = 'video starts at ' + F.fmtClock(live.fireAt);
      } else if (live.durationSec > 0) {
        const endMs = live.fireAt + live.durationSec * 1000;
        count = F.fmtCountdown(endMs - now);
        const pct = Math.max(0, Math.min(100, ((now - live.fireAt) / (live.durationSec * 1000)) * 100));
        track = '<div class="fc-track"><div class="fc-bar"><i style="width:' + pct + '%"></i><b style="left:' + pct + '%"></b></div>'
              + '<div class="fc-marks"><span class="s0">started ' + F.fmtClock(live.fireAt) + '</span><span class="s1">ends ' + F.fmtClock(endMs) + '</span></div></div>';
        meta = live.autoStop ? 'the stream ends by itself when the video finishes' : 'the broadcast stays open until someone ends it';
      } else {
        count = F.fmtCountdown(now - live.fireAt);
        meta = 'started ' + F.fmtClock(live.fireAt);
      }
      hero.className = 'card is-live';
      const liveEye = eye + (live.stationName ? ' · ' + live.stationName : '');
      hero.innerHTML = '<span class="fc-eye">● ' + escapeHtml(liveEye) + '</span><div class="fc-title">' + title + '</div><div class="fc-count">' + count + '</div>' + track + '<div class="fc-meta">' + escapeHtml(meta) + '</div>';
      return;
    }
    const pending = lastEvents.filter((e) => e.status === 'pending').sort((a, b) => a.fireAt - b.fireAt);
    const next = pending[0];
    if (next) {
      const title = escapeHtml(next.title || next.fileName || '(video)');
      const warn = next.needsVideo ? '<div class="fc-warn">This weekly slot still needs this week\'s video.</div>' : '';
      hero.className = 'card has-next';
      const nextEye = 'Next up' + (next.stationName ? ' · ' + next.stationName : '');
      // Two tiers so the hero isn't five equal facts: date+time is the primary line;
      // slate/ends sit quieter below. (The row still carries the full auto-stop note.)
      const endMs = next.durationSec > 0 ? next.fireAt + next.durationSec * 1000 : 0;
      const sub2 = [];
      if (next.leadMs > 0) sub2.push('slate from ' + F.fmtClock(next.fireAt - next.leadMs));
      if (endMs) sub2.push('ends around ' + F.fmtClock(endMs));
      hero.innerHTML = '<span class="fc-eye">● ' + escapeHtml(nextEye) + '</span><div class="fc-title">' + title + '</div><div class="fc-count">' + F.fmtCountdown(next.fireAt - now) + '</div>'
        + '<div class="fc-meta">' + escapeHtml(F.fmtDateTime(next.fireAt)) + '</div>'
        + (sub2.length ? '<div class="fc-meta-2">' + escapeHtml(sub2.join(' · ')) + '</div>' : '')
        + warn;
      return;
    }
    hero.className = 'card';
    hero.innerHTML = '<div class="fc-idle">Nothing scheduled yet — press <b>+ Schedule a video</b> to put a class on the calendar.</div>';
  }

  let lastUpdate = null;       // remembered so the "What's new" toggle can re-read it
  let notesExpanded = false;   // survives 1s re-renders so an open panel doesn't snap shut
  function hideNotes() { $('btnUpdateNotes').className = 'hidden'; $('updateNotes').className = 'hidden'; notesExpanded = false; }
  function applyNotes(state) {
    if (!state || state.phase !== 'downloaded' || !state.releaseNotes) { hideNotes(); return; }
    $('btnUpdateNotes').className = '';
    $('btnUpdateNotes').textContent = notesExpanded ? 'Hide notes' : "What's new";
    $('btnUpdateNotes').setAttribute('aria-expanded', String(notesExpanded));
    $('updateNotes').textContent = state.releaseNotes;
    $('updateNotes').className = notesExpanded ? '' : 'hidden';
  }

  // Silent through checking/downloading/error — only surfaced once there's an
  // actual decision for the operator to make (install now, or see why not).
  function renderUpdate(state) {
    const bar = $('updateBar');
    lastUpdate = state;
    if (!state) { bar.className = 'hidden'; hideNotes(); return; }
    // A failed install (e.g. this computer's copy can't verify itself) still
    // leaves the scheduler running — say so, don't just go quiet. The file is
    // already downloaded, though, so offer to reveal it instead of a dead end.
    if (state.phase === 'error' && state.afterInstall) {
      bar.className = 'blocked';
      const btn = $('btnUpdateNow'); btn.dataset.action = 'reveal';
      if (state.downloadedFile) {
        $('updateText').textContent = 'The update could not be installed automatically (' + (state.error || 'unknown error') + '). The schedule is still running. The download is already on this computer — open it and drag it into Applications yourself.';
        btn.disabled = false; btn.textContent = 'Show the downloaded file'; btn.title = '';
      } else {
        $('updateText').textContent = 'The update could not be installed (' + (state.error || 'unknown error') + '). The schedule is still running — try again later, or update this computer by hand.';
        btn.disabled = true; btn.textContent = 'Show the downloaded file'; btn.title = '';
      }
      hideNotes();
      return;
    }
    if (state.phase !== 'downloaded') { bar.className = 'hidden'; hideNotes(); return; }
    const version = state.version ? 'v' + state.version : 'A new version';
    const btn = $('btnUpdateNow'); btn.dataset.action = 'install'; btn.textContent = 'Restart & update';
    if (state.safe) {
      bar.className = '';
      $('updateText').textContent = version + ' is ready — restart to finish updating.';
      btn.disabled = false; btn.title = '';
    } else {
      bar.className = 'blocked';
      $('updateText').textContent = version + ' is ready, but not yet — ' + state.reason + '.';
      btn.disabled = true; btn.title = state.reason;
    }
    applyNotes(state);
  }

  // Connection health: a quiet green indicator when good, a loud specific banner
  // when a broadcast dependency (portal sign-in / engine) is down — so a problem
  // is caught BEFORE a class fails silently. main pushes this every few hours.
  function renderHealth(state) {
    if (!state) return;
    const conn = $('connStatus');
    const dot = '<span class="dotled"></span> ';
    if (state.checking || state.ok === null) {
      conn.className = 'sb-item conn'; conn.innerHTML = dot + 'Checking connections…'; conn.title = '';
    } else if (state.ok) {
      conn.className = 'sb-item conn ok'; conn.innerHTML = dot + 'Connections OK';
      conn.title = 'Checked ' + F.fmtClock(state.at) + ' · ' + (state.checks || []).map((c) => c.label + ': ' + c.detail).join(' · ');
    } else {
      const bad = (state.checks || []).filter((c) => !c.ok);
      conn.className = 'sb-item conn bad';
      conn.innerHTML = dot + escapeHtml('⚠ ' + (bad[0] ? bad[0].label + ' problem' : 'Connection problem'));
      conn.title = bad.map((c) => c.label + ': ' + c.detail).join(' · ');
    }
    // The prominent alert bar is health-owned: loud and specific when something is wrong.
    if (state.ok === false) {
      const bad = (state.checks || []).filter((c) => !c.ok);
      $('alertBar').textContent = '⚠ ' + bad.map((c) => c.label + ' — ' + c.detail).join('   ') + '.  Upcoming classes may not air until this is fixed.';
      $('alertBar').className = 'alert bad';
    } else if (state.ok === true) {
      $('alertBar').textContent = ''; $('alertBar').className = '';
    }
  }

  // A broadcast that ended in failure (or a real miss) shouldn't just slip into the
  // history — surface it until the operator acknowledges it.
  const sessionStart = Date.now();   // app-open time — only alert on failures that happen after this
  const dismissedFails = new Set();
  function renderFailures(events) {
    const fails = F.recentFailures(events, sessionStart, dismissedFails);
    const el = $('failAlert');
    if (!fails.length) { el.className = ''; return; }
    const retryBtn = $('btnFailRetry');
    if (fails.length === 1) {
      const f = fails[0];
      $('failText').textContent = '⚠ A class didn’t air — “' + (f.title || f.fileName || 'video') + '”: ' + (f.outcome || 'it failed to broadcast') + '.';
      // Offer a re-run only while the class could still meaningfully air, so the
      // button is never a dead end: same window the scheduler itself enforces.
      const lateSec = Math.max(0, (Date.now() - f.fireAt) / 1000);
      const retryable = !!f.filePath && !f.needsVideo && (!(f.durationSec > 0) || lateSec < f.durationSec);
      retryBtn.className = retryable ? '' : 'hidden';
      retryBtn.dataset.id = retryable ? f.id : '';
    } else {
      $('failText').textContent = '⚠ ' + fails.length + ' classes didn’t air recently — open “Past events” to see which.';
      retryBtn.className = 'hidden';
      retryBtn.dataset.id = '';
    }
    el.className = 'show';
  }

  function renderList(events) {
    lastEvents = events.slice();
    renderHero();
    renderFailures(events);
    const up = events.filter((e) => ['pending', 'starting', 'preshow', 'playing'].includes(e.status));
    const past = events.filter((e) => ['done', 'failed', 'missed'].includes(e.status));
    const live = up.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
    $('liveBar').className = live ? '' : 'hidden';
    if (live) {
      const from = live.playedFrom ? 'Playing from the ' + live.playedFrom + '.' : '';
      const slow = live.slow && live.slow.speed != null
        ? ' ⚠ Falling behind — running at ' + Number(live.slow.speed).toFixed(2) + '× real time. Viewers will see stutter and the class will end late. ' +
          (live.playedFrom === 'drive' ? 'The video is being read from the network drive; that drive is likely too slow.' : 'This computer is not keeping up with the encode.')
        : '';
      $('liveSub').textContent = (from + slow).trim();
      $('liveBar').classList.toggle('slow', !!slow);
    }
    $('upcomingList').innerHTML = '';
    if (up.length === 0) $('upcomingList').innerHTML = '<div class="sched-empty">Upcoming classes will appear here.</div>';
    else for (const ev of up.sort((a, b) => a.fireAt - b.fireAt)) $('upcomingList').appendChild(row(ev, true));
    $('historyList').innerHTML = '';
    if (past.length === 0) { $('historyList').innerHTML = '<div class="empty-note">No past events yet.</div>'; }
    else {
      const bar = document.createElement('div'); bar.className = 'hist-clearbar';
      bar.appendChild(btn('Clear all past events', async () => {
        if (confirm('Remove all ' + past.length + ' past events from the list? This only clears the history — upcoming classes are untouched.')) await api.invoke('schedule:clearPast');
      }));
      $('historyList').appendChild(bar);
      for (const ev of past.sort((a, b) => b.doneAt - a.doneAt)) $('historyList').appendChild(row(ev, false));
    }
  }

  function row(ev, upcoming) {
    const el = document.createElement('div'); el.className = 'schedrow';
    const pill = F.statusPill(ev);
    const title = ev.title || ev.fileName || '(video)';
    const ends = (ev.status === 'failed' || ev.status === 'missed') ? '' : F.endsAround(ev);   // "ends around…" is misleading on events that never played
    const station = (upcoming && ev.stationName) ? ' → ' + ev.stationName : '';
    const slate = (upcoming && ev.status === 'pending' && ev.leadMs > 0) ? ' · slate from ' + F.fmtClock(ev.fireAt - ev.leadMs) : '';
    const sub = [F.fmtDateTime(ev.fireAt) + slate, ends, (!upcoming && ev.outcome) ? ev.outcome : '']
      .filter(Boolean).join(' · ');
    // Stable two-part row: a min-width:0 content column (so long names wrap instead
    // of overflowing) + a fixed action group that never gets shoved off-screen.
    const main = document.createElement('div'); main.className = 'smain';
    main.innerHTML = '<div class="stitle"><span class="pill ' + pill.kind + '">' + escapeHtml(pill.label) + '</span> <b>' + escapeHtml(title + station) + '</b></div>'
      + '<div class="ssub">' + escapeHtml(sub) + '</div>';
    el.appendChild(main);
    if (upcoming) {
      const acts = document.createElement('div'); acts.className = 'sacts';
      if (['starting', 'preshow', 'playing'].includes(ev.status)) {
        acts.appendChild(btn('End stream now', () => api.invoke('schedule:stop', ev.id), 'btn-danger'));
      } else {
        acts.appendChild(btn('Edit', () => openEdit(ev)));
        if (ev.repeatWeekly) {
          // A weekly class: skipping one week must not end the series (it used to).
          acts.appendChild(btn('Skip this week', async () => { const res = await api.invoke('schedule:skip', ev.id); if (!res || !res.ok) alert((res && res.error) || 'That week could not be skipped.'); }));
          acts.appendChild(btn('Remove series', () => confirmRemove(ev, acts), 'btn-danger'));
        } else {
          acts.appendChild(btn('Remove', () => confirmRemove(ev, acts), 'btn-danger'));
        }
        // Survive a re-render: if this row was mid-"Remove?" before the rebuild,
        // put it straight back into the confirm state.
        if (ev.id === pendingRemoveId) confirmRemove(ev, acts);
      }
      el.appendChild(acts);
    } else {
      // Past events: a quiet Remove to clear a single history entry (low-stakes —
      // it already happened, so no confirm step).
      const acts = document.createElement('div'); acts.className = 'sacts';
      // A MISSED class is not a dead end any more: attach the (late) video or fix
      // the time, and it goes back on the schedule and starts as soon as it can.
      if (ev.status === 'missed') acts.appendChild(btn(ev.needsVideo ? 'Attach video' : 'Edit', () => openEdit(ev)));
      acts.appendChild(btn('Remove', async () => { const res = await api.invoke('schedule:remove', ev.id); if (!res || !res.ok) alert((res && res.error) || 'That broadcast could not be removed.'); }));
      el.appendChild(acts);
    }
    return el;
  }

  // Two-step delete: the first Remove click swaps the row's actions for an explicit
  // "Remove?" confirm, so a scheduled class can't be erased on a single stray click.
  function confirmRemove(ev, acts) {
    pendingRemoveId = ev.id;   // remember, so a re-render restores this confirm
    acts.innerHTML = '';
    const prompt = document.createElement('span'); prompt.className = 'ev-confirm';
    prompt.appendChild(document.createTextNode(ev.repeatWeekly ? 'Remove the whole weekly series?' : 'Remove?'));
    prompt.appendChild(btn('Remove', async () => {
      pendingRemoveId = null;
      const res = await api.invoke('schedule:remove', ev.id);
      if (!res || !res.ok) alert((res && res.error) || 'That broadcast could not be removed.');
      // on success the schedule:changed push re-renders the list
    }, 'btn-danger'));
    prompt.appendChild(btn('Cancel', () => { pendingRemoveId = null; renderList(lastEvents); }, 'btn-quiet'));
    acts.appendChild(prompt);
  }

  function btn(label, fn, variant) { const b = document.createElement('button'); b.className = (variant || 'btn-quiet') + ' btn-small'; b.textContent = label; b.onclick = fn; return b; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Hide the big "+ Schedule a video" trigger while its form is open, so there
  // aren't two identical primary buttons stacked and a stray re-click can't wipe
  // the half-filled form.
  function showForm() { $('newRow').className = 'hidden'; $('formCard').className = 'card'; resetForm(); }
  function hideForm() { $('formCard').className = 'card hidden'; $('newRow').className = ''; }
  function resetForm() {
    Object.assign(form, { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', stationName: '', linkChecked: false, editingId: null, startNow: false });
    // Clear the time selects too (evHour/evMin/evAP) — otherwise a new broadcast
    // silently inherits the previous class's time, and setting just the date is
    // enough to schedule at that leftover time by mistake.
    for (const id of ['evDate', 'evPortalLink', 'evTitle', 'evHour', 'evMin', 'evAP']) $(id).value = '';
    $('evLead').value = '0'; $('evAutoStop').checked = true; $('evRepeat').checked = false;
    $('evWhen').value = 'later';
    $('fileCheck').textContent = ''; $('evPortalStatus').textContent = '';
    $('formHeading').textContent = 'Schedule a video';
    $('btnSave').textContent = '✓ Schedule it';
    updateWhenUI();
    applyPhase();
  }

  function ensureOption(sel, value) {
    if (!Array.prototype.some.call(sel.options, (o) => o.value === value)) sel.add(new Option(value, value));
  }

  // Load an existing upcoming broadcast into the form. The class link box is
  // rebuilt from the stored class id so it reads back the way it was pasted.
  function openEdit(ev) {
    $('newRow').className = 'hidden';
    $('formCard').className = 'card';
    resetForm();
    Object.assign(form, {
      editingId: ev.id, filePath: ev.filePath || '', fileName: ev.fileName || '',
      durationSec: ev.durationSec || 0, vertical: !!ev.vertical,
      contentItemGuid: ev.contentItemGuid || '', scheduleGuid: ev.scheduleGuid || '',
      stationName: ev.stationName || '', linkChecked: !!ev.contentItemGuid,
      fireAt: ev.fireAt, startNow: false,
    });
    if (form.filePath) { $('fileCheck').textContent = '✓ ' + F.orientationLabel(form.vertical); $('fileCheck').className = 'pickstatus good'; }
    if (ev.contentItemGuid) {
      $('evPortalLink').value = 'https://content.echelonfit.com/classes/' + ev.contentItemGuid;
      $('evPortalStatus').textContent = '✓ ' + (ev.stationName ? ev.stationName + ' · ' : '') + F.orientationLabel(!!ev.vertical);
      $('evPortalStatus').className = 'pickstatus good';
    }
    const s = F.splitDateTime(ev.fireAt);
    $('evDate').value = s.date;
    ensureOption($('evHour'), s.hour); $('evHour').value = s.hour;
    ensureOption($('evMin'), s.min); $('evMin').value = s.min;
    $('evAP').value = s.ap;
    const leadMin = String(Math.round((ev.leadMs || 0) / 60000));
    ensureOption($('evLead'), leadMin); $('evLead').value = leadMin;
    $('evAutoStop').checked = ev.autoStop !== false;
    $('evRepeat').checked = !!ev.repeatWeekly;
    $('evTitle').value = ev.title || '';
    $('formHeading').textContent = 'Edit broadcast';
    $('btnSave').textContent = '✓ Save changes';
    updateWhenUI();
    applyPhase();
  }

  // Slate boxes show the chosen file by NAME (a full path in a small box was
  // unreadable); the real path rides on the element and is what gets saved.
  function setSlatePath(id, path) {
    const el = $(id); const p = path || '';
    el.dataset.path = p; el.value = p ? F.fileName(p) : ''; el.title = p;
    const clear = $(id.replace('set', 'btnClear')); if (clear) clear.hidden = !p;
  }
  function slatePath(id) { return $(id).dataset.path || ''; }
  async function loadSetup() {
    const s = await api.invoke('settings:get');
    setSlatePath('setSlateImage', s.slateImage); setSlatePath('setSlateImageVertical', s.slateImageVertical); setSlatePath('setSlateMusic', s.slateMusic);
    $('setFade').value = String(s.fadeMs || 1000);
    const presets = ['2500', '4500', '6000'];
    if (presets.includes(String(s.videoBitrate))) { $('setBitratePreset').value = String(s.videoBitrate); $('setBitrateCustom').style.display = 'none'; }
    else { $('setBitratePreset').value = 'custom'; $('setBitrateCustom').style.display = ''; $('setBitrateCustom').value = s.videoBitrate; }
    $('setPortalEmail').value = s.portalEmail || '';
    // Secrets are never echoed back. Show that one is saved; blank = keep it.
    $('setPortalApiKey').value = ''; $('setPortalPassword').value = '';
    const [hasPw, hasKey] = await Promise.all([api.invoke('secret:hasPassword'), api.invoke('secret:hasApiKey')]);
    $('setPortalPassword').placeholder = hasPw ? '•••••••• saved — leave blank to keep' : 'your content portal password';
    $('setPortalApiKey').placeholder = hasKey ? '•••••••• saved — leave blank to keep' : 'leave blank to start';
    $('setLaunchAtLogin').checked = !!s.launchAtLogin;
  }
  function chosenBitrate() { const p = $('setBitratePreset').value; return p === 'custom' ? (parseInt($('setBitrateCustom').value, 10) || 6000) : parseInt(p, 10); }
  async function saveSetup() {
    await api.invoke('settings:save', { slateImage: slatePath('setSlateImage'), slateImageVertical: slatePath('setSlateImageVertical'), slateMusic: slatePath('setSlateMusic'), fadeMs: parseInt($('setFade').value, 10), videoBitrate: chosenBitrate(), portalEmail: $('setPortalEmail').value.trim(), launchAtLogin: $('setLaunchAtLogin').checked });
    const key = $('setPortalApiKey').value.trim();
    if (key) { const r = await api.invoke('secret:setApiKey', key); if (!r || !r.ok) alert((r && r.error) || 'The API key could not be saved.'); $('setPortalApiKey').value = ''; }
    const pw = $('setPortalPassword').value; if (pw) { await api.invoke('secret:setPassword', pw); $('setPortalPassword').value = ''; }
    hasSlateConfigured = !!(slatePath('setSlateImage') || slatePath('setSlateImageVertical'));
    showView('main');
  }
  async function testLogin() {
    // Reset to a NEUTRAL class so "Testing…" never inherits the prior try's green/red
    // (which read as a stale result), and block re-presses during the request.
    $('btnPortalTest').disabled = true;
    $('portalTestResult').textContent = 'Testing…'; $('portalTestResult').className = 'pickstatus';
    try {
      const r = await api.invoke('portal:testLogin', { email: $('setPortalEmail').value.trim(), password: $('setPortalPassword').value, apiKey: $('setPortalApiKey').value.trim() });
      if (!r.ok) { $('portalTestResult').textContent = '✗ ' + (r.error || 'Login failed'); $('portalTestResult').className = 'pickstatus bad'; return; }
      $('portalTestResult').textContent = '✓ Signed in — ' + (r.stations ? r.stations.length : 0) + ' studios found'; $('portalTestResult').className = 'pickstatus good';
    } finally { $('btnPortalTest').disabled = false; }
  }

  function showView(which) { $('viewMain').className = which === 'main' ? '' : 'hidden'; $('viewSetup').className = which === 'setup' ? '' : 'hidden'; }

  async function init() {
    // time-picker options
    const { hours, minutes } = F.buildTimeOptions();
    for (const h of hours) $('evHour').add(new Option(h, h));
    for (const m of minutes) $('evMin').add(new Option(m, m));
    // engine status line (Setup). The prominent alert bar is driven by the health
    // check below, which covers the engine too — so no separate engine alert here.
    const chk = await api.invoke('engine:selfCheck');
    $('engineStatus').textContent = chk.ok ? ('Video engine ready — ' + (chk.version || 'bundled FFmpeg')) : ('Video engine problem: ' + (chk.error || ''));
    $('engineStatus').className = chk.ok ? 'setup-sub' : 'setup-sub bad';
    // connection health: reflect the last check, stay live via the push channel, and
    // let the operator force a check with "Check now".
    renderHealth(await api.invoke('health:get'));
    api.onHealthChanged((state) => renderHealth(state));
    $('btnHealthCheck').onclick = async () => { renderHealth(await api.invoke('health:check')); };
    $('btnFailRetry').onclick = async () => {
      const btn = $('btnFailRetry');
      const id = btn.dataset.id;
      if (!id) return;
      btn.disabled = true; btn.textContent = 'Starting…';
      try {
        const res = await api.invoke('schedule:retry', id);
        if (res && res.ok) { dismissedFails.add(id); renderFailures(lastEvents); }
        else { $('failText').textContent = '⚠ Could not retry: ' + ((res && res.error) || 'unknown problem') + '.'; }
      } finally { btn.disabled = false; btn.textContent = 'Try again'; }
    };
    $('btnFailDismiss').onclick = () => { for (const f of F.recentFailures(lastEvents, sessionStart, dismissedFails)) dismissedFails.add(f.id); renderFailures(lastEvents); };
    // self-update: reflect whatever main already knows, then stay live via the
    // push channel plus the clock tick (below) for the safety gate's own drift.
    renderUpdate(await api.invoke('update:getState'));
    api.onUpdateChanged((state) => renderUpdate(state));
    $('btnUpdateNow').onclick = async () => {
      if ($('btnUpdateNow').dataset.action === 'reveal') { await api.invoke('update:showDownload'); return; }
      const r = await api.invoke('update:install');
      if (!r || !r.ok) renderUpdate(await api.invoke('update:getState'));
    };
    $('btnUpdateNotes').onclick = () => { notesExpanded = !notesExpanded; applyNotes(lastUpdate); };
    // wire buttons
    $('btnNew').onclick = showForm; $('btnCancel').onclick = hideForm;
    $('btnPickVideo').onclick = pickVideo; $('btnChangeVideo').onclick = () => { form.filePath = ''; form.durationSec = 0; $('fileCheck').textContent = ''; applyPhase(); };
    for (const id of ['evDate', 'evHour', 'evMin', 'evAP']) $(id).addEventListener('change', recomputeFireAt);
    $('evWhen').addEventListener('change', () => { form.startNow = $('evWhen').value === 'now'; recomputeFireAt(); });
    $('evLead').addEventListener('change', recomputeFireAt);
    $('btnEvPortalCheck').onclick = checkLink; $('btnSave').onclick = save;
    $('btnGear').onclick = () => { loadSetup(); showView('setup'); }; $('btnSetupDone').onclick = saveSetup;
    $('btnPortalTest').onclick = testLogin;
    $('btnPickSlateImage').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'image' }); if (p) setSlatePath('setSlateImage', p); };
    $('btnPickSlateImageVertical').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'image' }); if (p) setSlatePath('setSlateImageVertical', p); };
    $('btnPickSlateMusic').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'audio' }); if (p) setSlatePath('setSlateMusic', p); };
    $('btnClearSlateImage').onclick = () => setSlatePath('setSlateImage', '');
    $('btnClearSlateImageVertical').onclick = () => setSlatePath('setSlateImageVertical', '');
    $('btnClearSlateMusic').onclick = () => setSlatePath('setSlateMusic', '');
    $('setBitratePreset').addEventListener('change', () => { $('setBitrateCustom').style.display = $('setBitratePreset').value === 'custom' ? '' : 'none'; });
    $('btnStopNow').onclick = async () => { const evs = await api.invoke('schedule:list'); const live = evs.find((e) => ['starting', 'preshow', 'playing'].includes(e.status)); if (live) api.invoke('schedule:stop', live.id); };
    $('btnTheme').onclick = () => { const el = document.documentElement; el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); };
    // clock
    try { const s0 = await api.invoke('settings:get'); hasSlateConfigured = !!(s0 && (s0.slateImage || s0.slateImageVertical)); } catch {}
    setInterval(() => {
      $('clockNow').textContent = F.fmtClock(Date.now()); renderHero();
      if (form.startNow && !$('formCard').className.includes('hidden')) updateWhenUI();   // keep "video starts about …" honest
      // the safety gate depends on wall-clock time, not just schedule content —
      // re-check it each tick so a blocked reason clears itself once it passes.
      if ($('updateBar').className !== 'hidden') api.invoke('update:getState').then(renderUpdate);
    }, 1000); $('clockNow').textContent = F.fmtClock(Date.now());
    // schedule
    renderList(await api.invoke('schedule:list'));
    api.onScheduleChanged((events) => renderList(events));
    showView('main');
    resetForm();
  }
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildAddPayload };
