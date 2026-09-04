'use strict';
// A stand-in for the Electron preload's window.api, used ONLY when the renderer
// runs in a plain browser (preview/verification). Same channels and result
// shapes as the Plan 3 brain, backed by in-memory state. Never installed when a
// real window.api exists.
function createMockApi(seed = {}) {
  const settings = Object.assign({
    slateImage: '', slateImageVertical: '', slateMusic: '', fadeMs: 1000, videoBitrate: 6000,
    portalEmail: '', portalApiKey: '', portalApiBase: '',
  }, seed.settings || {});
  let events = (seed.events || []).slice();
  let hasPw = !!seed.hasPassword;
  let n = 0;
  const listeners = new Set();
  const emit = () => { for (const f of listeners) { try { f(events.slice()); } catch {} } };
  const firstGuid = (s) => (String(s).match(/[0-9a-fA-F-]{36}/) || [''])[0];

  // Self-update preview state — real main.js drives this from electron-updater
  // events + scheduler.isSafeToUpdate(); the mock lets the UI be exercised
  // through every phase without a real download.
  let updateState = Object.assign({ phase: 'idle', version: '', error: '', safe: true, reason: '', afterInstall: false, downloadedFile: '', releaseNotes: '' }, seed.updateState || {});
  const updateListeners = new Set();
  const emitUpdate = () => { for (const f of updateListeners) { try { f({ ...updateState }); } catch {} } };

  // Connection-health preview state — real main.js drives this from the periodic
  // health controller; the mock lets the status bar + alert be exercised.
  let healthState = Object.assign({
    at: Date.now(), ok: true, checking: false,
    checks: [{ id: 'engine', label: 'Video engine', ok: true, detail: 'ffmpeg 6.1 (bundled)' },
             { id: 'portal', label: 'Content portal sign-in', ok: true, detail: '2 studios found' },
             { id: 'slate', label: 'Slate files', ok: true, detail: '3 files OK' },
             { id: 'videos', label: 'Scheduled videos', ok: true, detail: 'none scheduled' }],
  }, seed.healthState || {});
  const healthListeners = new Set();
  const emitHealth = () => { for (const f of healthListeners) { try { f({ ...healthState }); } catch {} } };

  async function invoke(channel, payload) {
    switch (channel) {
      case 'settings:get': return { ...settings };
      case 'settings:save': { Object.assign(settings, payload || {}); delete settings.password; delete settings.portalPassword; return { ...settings }; }
      case 'secret:hasPassword': return hasPw;
      case 'secret:setPassword': { hasPw = !!payload; return { ok: true }; }
      case 'portal:testLogin': return { ok: true, stations: [{ name: 'Connect', guid: 'g1' }, { name: 'Reflect', guid: 'g2' }] };
      case 'portal:checkLink': {
        const cig = firstGuid(payload);
        return { ok: true, count: 1, picked: { scheduleGuid: '', stationGuid: 'g1', stationName: 'Connect' }, vertical: false, medium: 'standard', contentItemGuid: cig, scheduleGuid: '' };
      }
      case 'probe:file': return { ok: true, durationSec: 1800, width: 1920, height: 1080, hasAudio: true };
      case 'engine:selfCheck': return { ok: true, version: 'ffmpeg 6.1 (bundled)' };
      case 'dialog:openFile': return '/Users/you/Videos/class.mp4';
      case 'schedule:list': return events.slice();
      case 'schedule:add': { const ev = Object.assign({ id: 'mock' + (n++), status: 'pending', outcome: '', doneAt: 0 }, payload); events.push(ev); emit(); return { ...ev }; }
      case 'schedule:update': { const ev = events.find((e) => e.id === (payload && payload.id)); if (!ev) return { ok: false, error: 'That broadcast was not found.' }; Object.assign(ev, (payload && payload.patch) || {}); emit(); return { ok: true, event: { ...ev } }; }
      case 'schedule:remove': { events = events.filter((e) => e.id !== payload); emit(); return { ok: true }; }
      case 'schedule:clearPast': { const b = events.length; events = events.filter((e) => !['done', 'failed', 'missed'].includes(e.status)); emit(); return { ok: true, removed: b - events.length }; }
      case 'schedule:stop': return { ok: true };
      case 'schedule:retry': return { ok: true };
      case 'schedule:skip': return { ok: true };
      case 'update:getState': return { ...updateState };
      case 'update:install': {
        if (!updateState.safe) return { ok: false, error: updateState.reason };
        updateState = { phase: 'idle', version: '', error: '', safe: true, reason: '', afterInstall: false, downloadedFile: '', releaseNotes: '' };
        emitUpdate();
        return { ok: true };
      }
      case 'update:showDownload': {
        if (!updateState.downloadedFile) return { ok: false, error: 'Nothing has been downloaded yet.' };
        return { ok: true };
      }
      case 'health:get': return { ...healthState };
      case 'health:check': { healthState = { ...healthState, at: Date.now() }; emitHealth(); return { ...healthState }; }
      default: return { ok: false, error: 'unknown channel: ' + channel };
    }
  }
  return {
    invoke,
    onScheduleChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onUpdateChanged: (cb) => { updateListeners.add(cb); return () => updateListeners.delete(cb); },
    onHealthChanged: (cb) => { healthListeners.add(cb); return () => healthListeners.delete(cb); },
    _emitChange: emit,
    _setUpdateState: (patch) => { updateState = { ...updateState, ...patch }; emitUpdate(); },
    _setHealthState: (patch) => { healthState = { ...healthState, ...patch }; emitHealth(); },
  };
}

function installMockApi(global) {
  if (global && !global.api) global.api = createMockApi();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMockApi, installMockApi };
if (typeof window !== 'undefined') { window.MockApi = { createMockApi, installMockApi }; installMockApi(window); }
