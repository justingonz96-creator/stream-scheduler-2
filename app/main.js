'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { appDataDir } = require('../store/appdata');
const { createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');
const { createSecretStore } = require('../store/secrets');
const { createSafeCodec } = require('../store/safe-codec');
const { createTransport } = require('../portal/http');
const { createPortalClient } = require('../portal/client');
const { createScheduler } = require('../schedule/scheduler');
const { createIpcHandlers } = require('./ipc');
const ffmpeg = require('../engine/ffmpeg');
const probe = require('../engine/probe');
const { Broadcast } = require('../engine/broadcast');

// Single instance: a second launch focuses the existing window (spec §4).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 940,
    title: 'Stream Scheduler 2.0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile('app/index.html');

  const dir = appDataDir();
  const settings = createSettingsStore({ file: path.join(dir, 'settings.json') });
  const scheduleStore = createScheduleStore({ file: path.join(dir, 'schedule.json') });
  const secrets = createSecretStore({ file: path.join(dir, 'secrets.json'), ...createSafeCodec(safeStorage) });
  const portal = createPortalClient({
    getConfig: () => buildPortalConfig(settings.get(), secrets),
    transport: createTransport(),
    log: (m) => console.log('[portal] ' + m),
  });
  let idc = 0;
  const scheduler = createScheduler({
    store: scheduleStore, portal, settings,
    engineFactory: (opts) => new Broadcast(opts),
    genId: () => 'ev' + Date.now() + '-' + (idc++),
    log: (m) => console.log('[sched] ' + m),
  });
  const handlers = createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, payload) => fn(payload));
  }
  scheduler.onChanged((events) => { if (!win.isDestroyed()) win.webContents.send('schedule:changed', events); });
  scheduler.start();
  ffmpeg.selfCheck().then((r) => { if (!win.isDestroyed()) win.webContents.send('engine:selfCheck', r); });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
