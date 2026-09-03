'use strict';
// The channel→handler map the Electron main process registers on ipcMain. Pure
// wiring: no Electron import here, so it is unit-tested directly. main.js does the
// ipcMain.handle registration and the push channel (schedule:changed).
const { parsePortalLink } = require('../portal/link');

function createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg, updates, health }) {
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
    'schedule:update': async (p) => scheduler.updateEvent(String((p && p.id) || ''), (p && p.patch) || {}),
    'schedule:remove': async (id) => scheduler.removeEvent(String(id || '')),
    'schedule:clearPast': async () => scheduler.clearPast(),
    'schedule:stop': async (id) => scheduler.stopActive(String(id || '')),
    // Operator-driven re-run of a class that did not air (the alert's "Try again").
    'schedule:retry': async (id) => scheduler.retryEvent(String(id || '')),

    // getState is synchronous main-process state (electron-updater's own event
    // state + a fresh scheduler.isSafeToUpdate() check) — install re-validates
    // safety itself server-side rather than trusting whatever the renderer cached.
    'update:getState': async () => updates.getState(),
    'update:install': async () => updates.install(),
    'update:showDownload': async () => updates.showDownload(),

    // Connection health: getState is the last periodic result; check runs one now
    // (the "Check now" button). main.js pushes results via the health:changed channel.
    'health:get': async () => health.getState(),
    'health:check': async () => health.check(),
  };
}

module.exports = { createIpcHandlers };
