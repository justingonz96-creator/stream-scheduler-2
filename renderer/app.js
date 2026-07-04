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
  const form = { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', linkChecked: false };

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

  function recomputeFireAt() {
    form.fireAt = F.parseDateTime($('evDate').value, $('evHour').value, $('evMin').value, $('evAP').value) || 0;
    applyPhase();
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
    $('evPortalStatus').textContent = '✓ ' + (r.picked && r.picked.stationName ? r.picked.stationName + ' · ' : '') + F.orientationLabel(r.vertical);
    $('evPortalStatus').className = 'pickstatus good'; applyPhase();
  }

  async function save() {
    const ph = FS.computeFormPhase({ filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked });
    if (!ph.canSave) { $('formError').textContent = ph.reasons.join('  '); return; }
    $('formError').textContent = '';
    const payload = buildAddPayload({ ...form, leadMin: parseInt($('evLead').value, 10) || 0, autoStop: $('evAutoStop').checked, repeatWeekly: $('evRepeat').checked, title: $('evTitle').value.trim() });
    await api.invoke('schedule:add', payload);
    hideForm();
  }

  function renderList(events) {
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
    const outcomeMeta = (!upcoming && ev.outcome) ? ' <span class="meta">' + escapeHtml(ev.outcome) + '</span>' : '';
    el.innerHTML = '<span class="pill ' + pill.kind + '">' + escapeHtml(pill.label) + '</span> <b>' + escapeHtml(title) + '</b> <span class="meta">' + F.fmtDateTime(ev.fireAt) + '</span>' + (ends ? ' <span class="meta">' + escapeHtml(ends) + '</span>' : '') + outcomeMeta;
    if (upcoming) {
      if (['starting', 'preshow', 'playing'].includes(ev.status)) { const s = btn('Stop', () => api.invoke('schedule:stop', ev.id)); el.appendChild(s); }
      else { const r = btn('Remove', async () => { const res = await api.invoke('schedule:remove', ev.id); if (!res.ok) alert(res.error); }); el.appendChild(r); }
    }
    return el;
  }

  function btn(label, fn) { const b = document.createElement('button'); b.className = 'btn-quiet btn-small'; b.textContent = label; b.onclick = fn; return b; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function showForm() { $('formCard').className = 'card'; resetForm(); }
  function hideForm() { $('formCard').className = 'card hidden'; }
  function resetForm() {
    Object.assign(form, { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', linkChecked: false });
    for (const id of ['evDate', 'evPortalLink', 'evTitle']) $(id).value = '';
    $('evLead').value = '0'; $('evAutoStop').checked = true; $('evRepeat').checked = false;
    $('fileCheck').textContent = ''; $('evPortalStatus').textContent = '';
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
    // update notice (spec §8): silent no-op on any failure — fire-and-forget, so a
    // firewalled network can never stall the button wiring below.
    api.invoke('update:check').then((upd) => {
      // Never clobber a more important engine-failure alert with the update notice.
      if (upd && upd.hasUpdate && $('alertBar').className !== 'alert bad') { $('alertBar').textContent = 'A newer version (v' + upd.latestVersion + ') is available — ask the admin to update this computer.'; $('alertBar').className = 'alert warn'; }
    }).catch(() => {});
    // wire buttons
    $('btnNew').onclick = showForm; $('btnCancel').onclick = hideForm;
    $('btnPickVideo').onclick = pickVideo; $('btnChangeVideo').onclick = () => { form.filePath = ''; form.durationSec = 0; $('fileCheck').textContent = ''; applyPhase(); };
    for (const id of ['evDate', 'evHour', 'evMin', 'evAP']) $(id).addEventListener('change', recomputeFireAt);
    $('btnEvPortalCheck').onclick = checkLink; $('btnSave').onclick = save;
    $('btnGear').onclick = () => { loadSetup(); showView('setup'); }; $('btnSetupDone').onclick = saveSetup;
    $('btnPortalTest').onclick = testLogin;
    $('btnPickSlateImage').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'image' }); if (p) $('setSlateImage').value = p; };
    $('btnPickSlateMusic').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'audio' }); if (p) $('setSlateMusic').value = p; };
    $('setBitratePreset').addEventListener('change', () => { $('setBitrateCustom').style.display = $('setBitratePreset').value === 'custom' ? '' : 'none'; });
    $('btnStopNow').onclick = async () => { const evs = await api.invoke('schedule:list'); const live = evs.find((e) => ['starting', 'preshow', 'playing'].includes(e.status)); if (live) api.invoke('schedule:stop', live.id); };
    $('btnTheme').onclick = () => { const el = document.documentElement; el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); };
    // clock
    setInterval(() => { $('clockNow').textContent = F.fmtClock(Date.now()); }, 1000); $('clockNow').textContent = F.fmtClock(Date.now());
    // schedule
    renderList(await api.invoke('schedule:list'));
    api.onScheduleChanged((events) => renderList(events));
    showView('main');
    resetForm();
  }
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildAddPayload };
