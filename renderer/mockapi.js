'use strict';
// A stand-in for the Electron preload's window.api, used ONLY when the renderer
// runs in a plain browser (preview/verification). Same channels and result
// shapes as the Plan 3 brain, backed by in-memory state. Never installed when a
// real window.api exists.
function createMockApi(seed = {}) {
  const settings = Object.assign({
    slateImage: '', slateMusic: '', fadeMs: 1000, videoBitrate: 6000,
    portalEmail: '', portalApiKey: '', portalApiBase: '',
  }, seed.settings || {});
  let events = (seed.events || []).slice();
  let hasPw = !!seed.hasPassword;
  let n = 0;
  const listeners = new Set();
  const emit = () => { for (const f of listeners) { try { f(events.slice()); } catch {} } };
  const firstGuid = (s) => (String(s).match(/[0-9a-fA-F-]{36}/) || [''])[0];

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
      case 'schedule:remove': { events = events.filter((e) => e.id !== payload); emit(); return { ok: true }; }
      case 'schedule:stop': return { ok: true };
      case 'update:check': return { hasUpdate: false };
      default: return { ok: false, error: 'unknown channel: ' + channel };
    }
  }
  return { invoke, onScheduleChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, _emitChange: emit };
}

function installMockApi(global) {
  if (global && !global.api) global.api = createMockApi();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMockApi, installMockApi };
if (typeof window !== 'undefined') { window.MockApi = { createMockApi, installMockApi }; installMockApi(window); }
