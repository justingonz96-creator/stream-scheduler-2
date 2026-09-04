'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = ['settings:get', 'settings:save', 'secret:hasPassword', 'secret:setPassword', 'secret:hasApiKey', 'secret:setApiKey', 'portal:testLogin', 'portal:checkLink', 'probe:file', 'engine:selfCheck', 'schedule:list', 'schedule:add', 'schedule:update', 'schedule:remove', 'schedule:clearPast', 'schedule:stop', 'schedule:retry', 'schedule:skip', 'dialog:openFile', 'update:getState', 'update:install', 'update:showDownload', 'health:get', 'health:check'];

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => {
    if (!ALLOWED.includes(channel)) return Promise.reject(new Error('Unknown channel: ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  onScheduleChanged: (cb) => {
    const listener = (_e, events) => cb(events);
    ipcRenderer.on('schedule:changed', listener);
    return () => ipcRenderer.removeListener('schedule:changed', listener);
  },
  onUpdateChanged: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:changed', listener);
    return () => ipcRenderer.removeListener('update:changed', listener);
  },
  onHealthChanged: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('health:changed', listener);
    return () => ipcRenderer.removeListener('health:changed', listener);
  },
});
