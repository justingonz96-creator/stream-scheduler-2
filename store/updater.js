'use strict';
// Wraps electron-updater's autoUpdater with our own state machine + the
// scheduler's safety gate. Kept separate from app/main.js (which just wires
// the real autoUpdater/scheduler in) so the state transitions are
// unit-testable with a fake autoUpdater and a fake scheduler.
// The GitHub provider gives releaseNotes as [{version, note}] where `note` is the
// release body rendered to HTML; other providers may give a plain string. Turn
// either into SAFE PLAIN TEXT (tags stripped) for the update banner — the notes
// are fetched over the network, so we never inject them as markup.
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h\d|ul|ol|li|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function formatReleaseNotes(rn) {
  if (!rn) return '';
  if (typeof rn === 'string') return stripHtml(rn);
  if (Array.isArray(rn)) return rn.map((r) => stripHtml(r && r.note)).filter(Boolean).join('\n\n');
  return '';
}

function createUpdateController({ autoUpdater, scheduler, shell, onChanged = () => {}, log = () => {} }) {
  let state = { phase: 'idle', version: '', error: '', downloadedFile: '', releaseNotes: '' };
  // Set only between install()'s shutdown() and quitAndInstall() actually
  // exiting the process. If quitAndInstall fails instead (it can — e.g. an
  // unsigned build fails macOS's Squirrel signature check), the process
  // survives with its scheduler already stopped; without resuming it here the
  // app would sit there looking normal while never airing another broadcast.
  let installAttempted = false;

  function withGate() {
    const gate = scheduler.isSafeToUpdate();
    return { ...state, safe: gate.safe, reason: gate.safe ? '' : gate.reason };
  }
  function publish() { onChanged(withGate()); }

  autoUpdater.on('checking-for-update', () => { state = { phase: 'checking', version: '', error: '', downloadedFile: '', releaseNotes: '' }; publish(); });
  autoUpdater.on('update-available', (info) => { state = { phase: 'available', version: (info && info.version) || '', error: '', downloadedFile: '', releaseNotes: formatReleaseNotes(info && info.releaseNotes) }; publish(); });
  autoUpdater.on('update-not-available', () => { state = { phase: 'idle', version: '', error: '', downloadedFile: '', releaseNotes: '' }; publish(); });
  autoUpdater.on('download-progress', () => { state = { ...state, phase: 'downloading' }; publish(); });
  // downloadedFile is electron-updater's own cache copy of the installer — it
  // already sits on this computer's disk, signature check notwithstanding, so
  // a failed install can still point the operator straight at it instead of
  // sending them back to GitHub for a multi-hundred-MB re-download.
  autoUpdater.on('update-downloaded', (info) => { state = { phase: 'downloaded', version: (info && info.version) || state.version, error: '', downloadedFile: (info && info.downloadedFile) || '', releaseNotes: formatReleaseNotes(info && info.releaseNotes) || state.releaseNotes }; publish(); });
  autoUpdater.on('error', (err) => {
    const afterInstall = installAttempted;
    if (installAttempted) {
      installAttempted = false;
      try { scheduler.start(); } catch (e) { log('resuming scheduler after a failed install failed: ' + ((e && e.message) || e)); }
    }
    state = { phase: 'error', version: state.version, error: (err && err.message) || String(err), afterInstall, downloadedFile: state.downloadedFile, releaseNotes: state.releaseNotes };
    publish();
  });

  scheduler.onChanged(() => publish());

  function getState() { return withGate(); }

  function install() {
    const gate = scheduler.isSafeToUpdate();
    if (!gate.safe) return { ok: false, error: gate.reason };
    if (state.phase !== 'downloaded') return { ok: false, error: 'No update is ready to install yet.' };
    try { scheduler.shutdown(); } catch (e) { log('shutdown before update failed: ' + ((e && e.message) || e)); }
    installAttempted = true;
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  }

  function showDownload() {
    if (!state.downloadedFile) return { ok: false, error: 'Nothing has been downloaded yet.' };
    try { shell.showItemInFolder(state.downloadedFile); return { ok: true }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  function start() {
    autoUpdater.checkForUpdates().catch((e) => {
      state = { phase: 'error', version: state.version, error: (e && e.message) || String(e), downloadedFile: state.downloadedFile, releaseNotes: state.releaseNotes };
      publish();
    });
  }

  return { getState, install, showDownload, start };
}
module.exports = { createUpdateController, formatReleaseNotes };
