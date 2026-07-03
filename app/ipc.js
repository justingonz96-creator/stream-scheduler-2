'use strict';
// The channel→handler map the Electron main process registers on ipcMain. Pure
// wiring: no Electron import here, so it is unit-tested directly. main.js does the
// ipcMain.handle registration and the push channel (schedule:changed).
const { parsePortalLink } = require('../portal/link');

function createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg, updates }) {
  return {
    'settings:get': async () => settings.get(),
    'settings:save': async (patch) => settings.save(patch || {}),

    'secret:hasPassword': async () => secrets.has('portalPassword'),
    'secret:setPassword': async (pw) => {
      try { secrets.set('portalPassword', String(pw == null ? '' : pw)); return { ok: true }; }
      catch (e) { return { ok: false, error: (e && e.message) || 'The password could not be saved.' }; }
    },

    'portal:testLogin': async (overrides) => portal.testLogin(overrides || {}),
    'portal:checkLink': async (link) => {
      const ids = parsePortalLink(typeof link === 'string' ? link : (link && link.url) || '');
      const res = await portal.checkClassLink(ids);
      return { ...res, contentItemGuid: ids.contentItemGuid, scheduleGuid: ids.scheduleGuid };
    },

    'probe:file': async (filePath) => probe.probeFile(String(filePath || '')),
    'engine:selfCheck': async () => ffmpeg.selfCheck(),

    'schedule:list': async () => scheduler.getEvents(),
    'schedule:add': async (ev) => scheduler.addEvent(ev || {}),
    'schedule:remove': async (id) => scheduler.removeEvent(String(id || '')),
    'schedule:stop': async (id) => scheduler.stopActive(String(id || '')),

    'update:check': async () => updates.check(),
  };
}

module.exports = { createIpcHandlers };
