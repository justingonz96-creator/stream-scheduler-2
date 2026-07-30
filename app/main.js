'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const { appDataDir } = require('../store/appdata');
const { createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');
const { createSecretStore } = require('../store/secrets');
const { createSafeCodec } = require('../store/safe-codec');
const { createTransport } = require('../portal/http');
const { createPortalClient } = require('../portal/client');
const { createScheduler } = require('../schedule/scheduler');
const { createIpcHandlers } = require('./ipc');
const { autoUpdater } = require('electron-updater');
const { createUpdateController } = require('../store/updater');
const ffmpeg = require('../engine/ffmpeg');
const probe = require('../engine/probe');
const { Broadcast } = require('../engine/broadcast');

// Headless self-check: `--selfcheck` proves the packaged app can find and run
// its bundled FFmpeg, with no window and no single-instance lock. Used by the
// packaging gate and by support ("run this and send me the line it prints").
if (process.argv.includes('--selfcheck')) {
  ffmpeg.selfCheck().then((r) => {
    console.log(JSON.stringify(r));
    app.exit(r.ok ? 0 : 1);
  });
} else {
  // Single instance: a second launch focuses the existing window (spec §4).
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  let win = null;
  let scheduler = null;   // hoisted so before-quit can reach it (it owns the live encode)
  function createWindow() {
    win = new BrowserWindow({
      width: 480, height: 940,
      title: 'Stream Scheduler 2',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
    scheduler = createScheduler({
      store: scheduleStore, portal, settings,
      engineFactory: (opts) => new Broadcast(opts),
      genId: () => 'ev' + Date.now() + '-' + (idc++),
      log: (m) => console.log('[sched] ' + m),
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    const updateCtl = createUpdateController({
      autoUpdater, scheduler, shell,
      onChanged: (state) => { if (!win.isDestroyed()) win.webContents.send('update:changed', state); },
      log: (m) => console.log('[update] ' + m),
    });
    const updates = { getState: () => updateCtl.getState(), install: () => updateCtl.install(), showDownload: () => updateCtl.showDownload() };
    const handlers = createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg, updates });
    for (const [channel, fn] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_e, payload) => fn(payload));
    }
    const FILTERS = {
      video: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi'] }],
      image: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
      audio: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav'] }],
    };
    ipcMain.handle('dialog:openFile', async (_e, payload) => {
      const kind = (payload && payload.kind) || 'video';
      const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.video });
      return (res.canceled || !res.filePaths.length) ? '' : res.filePaths[0];
    });
    scheduler.onChanged((events) => { if (!win.isDestroyed()) win.webContents.send('schedule:changed', events); });
    scheduler.start();
    // Skip in dev/test runs: an unpacked app has no app-update.yml and
    // electron-updater's checkForUpdates() only ever errors there.
    if (app.isPackaged) updateCtl.start();
  }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  // Kill the scheduler timer + any live encode on the way out, so no ffmpeg
  // child is left running in the background after the window closes.
  app.on('before-quit', () => { try { if (scheduler) scheduler.shutdown(); } catch {} });
  app.on('window-all-closed', () => app.quit());
}
