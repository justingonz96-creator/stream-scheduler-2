'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = ['settings:get', 'settings:save', 'secret:hasPassword', 'secret:setPassword', 'portal:testLogin', 'portal:checkLink', 'probe:file', 'engine:selfCheck', 'schedule:list', 'schedule:add', 'schedule:update', 'schedule:remove', 'schedule:stop', 'dialog:openFile', 'update:check'];

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
});
