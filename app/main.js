'use strict';
const path = require('node:path');
const fsp = require('node:fs').promises;

// Is a file reachable and readable right now? Wrapped in a timeout so a
// DISCONNECTED network drive (where fs calls can hang for many seconds) resolves
// to "not reachable" quickly instead of freezing the health check / the app.
function fileReachable(p, timeoutMs = 4000) {
  if (!p) return Promise.resolve(false);
  return Promise.race([
    fsp.stat(p).then((st) => st.isFile()).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), timeoutMs)),
  ]);
}
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu } = require('electron');
const { appDataDir, cacheDir } = require('../store/appdata');
const { createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');
const { createVideoCache } = require('../store/video-cache');
const { createSecretStore } = require('../store/secrets');
const { createSafeCodec } = require('../store/safe-codec');
const { createTransport } = require('../portal/http');
const { createPortalClient } = require('../portal/client');
const { createScheduler } = require('../schedule/scheduler');
const { createIpcHandlers } = require('./ipc');
const { autoUpdater } = require('electron-updater');
const { createUpdateController } = require('../store/updater');
const { createHealthController } = require('../store/health');
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
  let health = null;      // hoisted so before-quit can stop its periodic timer
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
    // Local copies of upcoming classes' videos + the slate files, so a live
    // broadcast never depends on the network drive once it starts.
    // The cache is optional by design: if its folder can't be created (odd
    // permissions), the app must still launch and simply play from the originals.
    let cache = null;
    try { cache = createVideoCache({ dir: path.join(cacheDir(), 'video-cache'), log: (m) => console.log('[cache] ' + m) }); }
    catch (e) { console.log('[cache] disabled — could not create the cache folder: ' + ((e && e.message) || e)); }
    let idc = 0;
    const buildScheduler = () => createScheduler({
      store: scheduleStore, portal, settings, cache,
      engineFactory: (opts) => new Broadcast(opts),
      genId: () => 'ev' + Date.now() + '-' + (idc++),
      log: (m) => console.log('[sched] ' + m),
    });
    try {
      scheduler = buildScheduler();
    } catch (err) {
      // The saved schedule was present but unreadable AND had no usable backup.
      // Never overwrite it blindly: set the bad file aside for possible manual
      // recovery, tell the operator plainly, then start with an empty schedule so
      // the app still opens.
      if (err && err.code === 'ECORRUPT') {
        const aside = err.file + '.corrupt-' + Date.now();
        try { require('node:fs').renameSync(err.file, aside); } catch { /* ignore */ }
        try {
          dialog.showErrorBox('Your saved schedule could not be read',
            'Stream Scheduler could not read your saved schedule, so it started with an empty one.\n\n' +
            'The unreadable file was kept (not deleted) here in case it can be recovered:\n' + aside + '\n\n' +
            'Please re-add today\'s classes, and let your admin know.');
        } catch { /* dialog unavailable → still continue */ }
        scheduler = buildScheduler();   // the bad file is gone now → clean start
      } else { throw err; }
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    const updateCtl = createUpdateController({
      autoUpdater, scheduler, shell,
      onChanged: (state) => { if (!win.isDestroyed()) win.webContents.send('update:changed', state); },
      log: (m) => console.log('[update] ' + m),
    });
    const updates = { getState: () => updateCtl.getState(), install: () => updateCtl.install(), showDownload: () => updateCtl.showDownload() };
    health = createHealthController({
      portal, ffmpeg, settings,
      fileOk: (p) => fileReachable(p),
      getVideoPaths: () => scheduler.mediaPathsForHealth(),   // local copy counts as healthy even if the drive is down
      onChanged: (state) => { if (!win.isDestroyed()) win.webContents.send('health:changed', state); },
      log: (m) => console.log('[health] ' + m),
    });
    const handlers = createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg, updates, health });
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
    // Right-click menu for text fields: paste a path or a stream key copied from
    // somewhere else, and copy an error message out to send to support. Electron
    // gives a window none of this by default.
    win.webContents.on('context-menu', (_e, params) => {
      const items = [];
      if (params.isEditable) {
        items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut', enabled: !!params.selectionText },
          { role: 'copy', enabled: !!params.selectionText },
          { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
      } else if (params.selectionText && params.selectionText.trim()) {
        items.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
    });
    scheduler.onChanged((events) => { if (!win.isDestroyed()) win.webContents.send('schedule:changed', events); });
    scheduler.start();
    // Skip in dev/test runs: an unpacked app has no app-update.yml and
    // electron-updater's checkForUpdates() only ever errors there.
    if (app.isPackaged) updateCtl.start();
    health.start();   // periodic connection check (portal sign-in + engine), + at startup
  }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  // Kill the scheduler timer + any live encode on the way out, so no ffmpeg
  // child is left running in the background after the window closes.
  app.on('before-quit', () => { try { if (scheduler) scheduler.shutdown(); } catch {} try { if (health) health.stop(); } catch {} });
  app.on('window-all-closed', () => app.quit());
}
