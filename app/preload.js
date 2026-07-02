'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onScheduleChanged: (cb) => {
    const listener = (_e, events) => cb(events);
    ipcRenderer.on('schedule:changed', listener);
    return () => ipcRenderer.removeListener('schedule:changed', listener);
  },
});
