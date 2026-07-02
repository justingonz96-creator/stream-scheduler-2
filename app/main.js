'use strict';
const { app, BrowserWindow } = require('electron');

// Single instance: a second launch focuses the existing window (spec §4).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 940,
    title: 'Stream Scheduler 2.0',
    webPreferences: { contextIsolation: true },
  });
  win.loadFile('app/index.html');
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
