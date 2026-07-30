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
    const r = await api.invoke('portal:checkLink', $('evPortalLink').value.trim());
    if (!r.ok) { $('evPortalStatus').textContent = '✗ ' + r.error; $('evPortalStatus').className = 'pickstatus bad'; form.linkChecked = false; applyPhase(); return; }
    form.contentItemGuid = r.contentItemGuid; form.scheduleGuid = r.scheduleGuid || ''; form.vertical = r.vertical; form.linkChecked = true;
    form.stationName = (r.picked && r.picked.stationName) || '';
    $('evPortalStatus').textContent = '✓ ' + (r.picked && r.picked.stationName ? r.picked.stationName + ' · ' : '') + F.orientationLabel(r.vertical);
    $('evPortalStatus').className = 'pickstatus good'; applyPhase();
  }

  async function save() {
    // "now" is resolved at the moment of saving, not when the option was picked.
    if (form.startNow) form.fireAt = Date.now() + effectiveLeadMin() * 60000;
    const ph = FS.computeFormPhase({ filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked });
    if (!ph.canSave) { $('formError').textContent = ph.reasons.join('  '); return; }
    $('formError').textContent = '';
    const payload = buildAddPayload({ ...form, leadMin: effectiveLeadMin(), autoStop: $('evAutoStop').checked, repeatWeekly: $('evRepeat').checked, title: $('evTitle').value.trim() });
    if (form.editingId) {
      const r = await api.invoke('schedule:update', { id: form.editingId, patch: payload });
      if (!r || !r.ok) { $('formError').textContent = (r && r.error) || 'That broadcast could not be changed.'; return; }
    } else {
      await api.invoke('schedule:add', payload);
    }
    hideForm();
  }

  let lastEvents = [];

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
      const ends = F.endsAround(next);
      hero.className = 'card has-next';
      const nextEye = 'Next up' + (next.stationName ? ' · ' + next.stationName : '');
      const slate = next.leadMs > 0 ? 'slate from ' + F.fmtClock(next.fireAt - next.leadMs) : '';
      hero.innerHTML = '<span class="fc-eye">● ' + escapeHtml(nextEye) + '</span><div class="fc-title">' + title + '</div><div class="fc-count">' + F.fmtCountdown(next.fireAt - now) + '</div><div class="fc-meta">' + escapeHtml(F.fmtDateTime(next.fireAt) + (slate ? ' · ' + slate : '') + (ends ? ' · ' + ends : '')) + '</div>' + warn;
      return;
    }
    hero.className = 'card';
    hero.innerHTML = '<div class="fc-idle">Nothing scheduled yet — press <b>+ Schedule a video</b> to put a class on the calendar.</div>';
  }

  // Silent through checking/downloading/error — only surfaced once there's an
  // actual decision for the operator to make (install now, or see why not).
  function renderUpdate(state) {
    const bar = $('updateBar');
    if (!state) { bar.className = 'hidden'; return; }
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
      return;
    }
    if (state.phase !== 'downloaded') { bar.className = 'hidden'; return; }
    const version = state.version ? 'v' + state.version : 'A new version';
    const btn = $('btnUpdateNow'); btn.dataset.action = 'install'; btn.textContent = 'Restart & Update';
    if (state.safe) {
      bar.className = '';
      $('updateText').textContent = version + ' is ready — restart to finish updating.';
      btn.disabled = false; btn.title = '';
    } else {
      bar.className = 'blocked';
      $('updateText').textContent = version + ' is ready, but not yet — ' + state.reason + '.';
      btn.disabled = true; btn.title = state.reason;
    }
  }

  function renderList(events) {
    lastEvents = events.slice();
    renderHero();
    const up = events.filter((e) => ['pending', 'starting', 'preshow', 'playing'].includes(e.status));
    const past = events.filter((e) => ['done', 'failed', 'missed'].includes(e.status));
    const live = up.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
    $('liveBar').className = live ? '' : 'hidden';
    $('upcomingList').innerHTML = '';
    for (const ev of up.sort((a, b) => a.fireAt - b.fireAt)) $('upcomingList').appendChild(row(ev, true));
    $('historyList').innerHTML = '';
    for (const ev of past.sort((a, b) => b.doneAt - a.doneAt)) $('historyList').appendChild(row(ev, false));
  }

  function row(ev, upcoming) {
    const el = document.createElement('div'); el.className = 'schedrow';
    const pill = F.statusPill(ev);
    const title = ev.title || ev.fileName || '(video)';
    const ends = (ev.status === 'failed' || ev.status === 'missed') ? '' : F.endsAround(ev);   // "ends around…" is misleading on events that never played
    const station = (upcoming && ev.stationName) ? ' <span class="meta">→ ' + escapeHtml(ev.stationName) + '</span>' : '';
    const slate = (upcoming && ev.status === 'pending' && ev.leadMs > 0) ? ' <span class="meta">' + escapeHtml('slate from ' + F.fmtClock(ev.fireAt - ev.leadMs)) + '</span>' : '';
    const outcomeMeta = (!upcoming && ev.outcome) ? ' <span class="meta">' + escapeHtml(ev.outcome) + '</span>' : '';
    el.innerHTML = '<span class="pill ' + pill.kind + '">' + escapeHtml(pill.label) + '</span> <b>' + escapeHtml(title) + '</b>' + station + ' <span class="meta">' + F.fmtDateTime(ev.fireAt) + '</span>' + slate + (ends ? ' <span class="meta">' + escapeHtml(ends) + '</span>' : '') + outcomeMeta;
    if (upcoming) {
      if (['starting', 'preshow', 'playing'].includes(ev.status)) { const s = btn('Stop', () => api.invoke('schedule:stop', ev.id)); el.appendChild(s); }
      else {
        el.appendChild(btn('Edit', () => openEdit(ev)));
        el.appendChild(btn('Remove', async () => { const res = await api.invoke('schedule:remove', ev.id); if (!res.ok) alert(res.error); }));
      }
    }
    return el;
  }

  function btn(label, fn) { const b = document.createElement('button'); b.className = 'btn-quiet btn-small'; b.textContent = label; b.onclick = fn; return b; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function showForm() { $('formCard').className = 'card'; resetForm(); }
  function hideForm() { $('formCard').className = 'card hidden'; }
  function resetForm() {
    Object.assign(form, { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', stationName: '', linkChecked: false, editingId: null, startNow: false });
    for (const id of ['evDate', 'evPortalLink', 'evTitle']) $(id).value = '';
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

  async function loadSetup() {
    const s = await api.invoke('settings:get');
    $('setSlateImage').value = s.slateImage || ''; $('setSlateMusic').value = s.slateMusic || '';
    $('setFade').value = String(s.fadeMs || 1000);
    const presets = ['2500', '4500', '6000'];
    if (presets.includes(String(s.videoBitrate))) { $('setBitratePreset').value = String(s.videoBitrate); $('setBitrateCustom').style.display = 'none'; }
    else { $('setBitratePreset').value = 'custom'; $('setBitrateCustom').style.display = ''; $('setBitrateCustom').value = s.videoBitrate; }
    $('setPortalEmail').value = s.portalEmail || ''; $('setPortalApiKey').value = s.portalApiKey || '';
  }
  function chosenBitrate() { const p = $('setBitratePreset').value; return p === 'custom' ? (parseInt($('setBitrateCustom').value, 10) || 6000) : parseInt(p, 10); }
  async function saveSetup() {
    await api.invoke('settings:save', { slateImage: $('setSlateImage').value, slateMusic: $('setSlateMusic').value, fadeMs: parseInt($('setFade').value, 10), videoBitrate: chosenBitrate(), portalEmail: $('setPortalEmail').value.trim(), portalApiKey: $('setPortalApiKey').value.trim() });
    const pw = $('setPortalPassword').value; if (pw) { await api.invoke('secret:setPassword', pw); $('setPortalPassword').value = ''; }
    hasSlateConfigured = !!$('setSlateImage').value;
    showView('main');
  }
  async function testLogin() {
    $('portalTestResult').textContent = 'Testing…';
    const r = await api.invoke('portal:testLogin', { email: $('setPortalEmail').value.trim(), password: $('setPortalPassword').value, apiKey: $('setPortalApiKey').value.trim() });
    if (!r.ok) { $('portalTestResult').textContent = '✗ ' + (r.error || 'Login failed'); $('portalTestResult').className = 'pickstatus bad'; return; }
    $('portalTestResult').textContent = '✓ Signed in — ' + (r.stations ? r.stations.length : 0) + ' studios found'; $('portalTestResult').className = 'pickstatus good';
  }

  function showView(which) { $('viewMain').className = which === 'main' ? '' : 'hidden'; $('viewSetup').className = which === 'setup' ? '' : 'hidden'; }

  async function init() {
    // time-picker options
    const { hours, minutes } = F.buildTimeOptions();
    for (const h of hours) $('evHour').add(new Option(h, h));
    for (const m of minutes) $('evMin').add(new Option(m, m));
    // engine status
    const chk = await api.invoke('engine:selfCheck');
    if (!chk.ok) { $('alertBar').textContent = '⚠ The video engine isn\'t ready: ' + (chk.error || '') ; $('alertBar').className = 'alert bad'; }
    $('engineStatus').textContent = chk.ok ? ('Video engine ready — ' + (chk.version || 'bundled FFmpeg')) : ('Video engine problem: ' + (chk.error || ''));
    $('engineStatus').className = chk.ok ? 'setup-sub' : 'setup-sub bad';
    // self-update: reflect whatever main already knows, then stay live via the
    // push channel plus the clock tick (below) for the safety gate's own drift.
    renderUpdate(await api.invoke('update:getState'));
    api.onUpdateChanged((state) => renderUpdate(state));
    $('btnUpdateNow').onclick = async () => {
      if ($('btnUpdateNow').dataset.action === 'reveal') { await api.invoke('update:showDownload'); return; }
      const r = await api.invoke('update:install');
      if (!r || !r.ok) renderUpdate(await api.invoke('update:getState'));
    };
    // wire buttons
    $('btnNew').onclick = showForm; $('btnCancel').onclick = hideForm;
    $('btnPickVideo').onclick = pickVideo; $('btnChangeVideo').onclick = () => { form.filePath = ''; form.durationSec = 0; $('fileCheck').textContent = ''; applyPhase(); };
    for (const id of ['evDate', 'evHour', 'evMin', 'evAP']) $(id).addEventListener('change', recomputeFireAt);
    $('evWhen').addEventListener('change', () => { form.startNow = $('evWhen').value === 'now'; recomputeFireAt(); });
    $('evLead').addEventListener('change', recomputeFireAt);
    $('btnEvPortalCheck').onclick = checkLink; $('btnSave').onclick = save;
    $('btnGear').onclick = () => { loadSetup(); showView('setup'); }; $('btnSetupDone').onclick = saveSetup;
    $('btnPortalTest').onclick = testLogin;
    $('btnPickSlateImage').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'image' }); if (p) $('setSlateImage').value = p; };
    $('btnPickSlateMusic').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'audio' }); if (p) $('setSlateMusic').value = p; };
    $('setBitratePreset').addEventListener('change', () => { $('setBitrateCustom').style.display = $('setBitratePreset').value === 'custom' ? '' : 'none'; });
    $('btnStopNow').onclick = async () => { const evs = await api.invoke('schedule:list'); const live = evs.find((e) => ['starting', 'preshow', 'playing'].includes(e.status)); if (live) api.invoke('schedule:stop', live.id); };
    $('btnTheme').onclick = () => { const el = document.documentElement; el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); };
    // clock
    try { const s0 = await api.invoke('settings:get'); hasSlateConfigured = !!(s0 && s0.slateImage); } catch {}
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
