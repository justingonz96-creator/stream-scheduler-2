'use strict';
// Periodic CONNECTION HEALTH CHECK. Verifies the things a broadcast depends on that
// can silently break between classes: the content-portal sign-in (auth + reachability
// + that studios can be enumerated) and the bundled video engine. Runs on a timer,
// at startup, and on demand — so the operator is warned BEFORE a class fails, instead
// of discovering a silent failure in the history afterwards. Every dependency is
// injected, so the whole thing runs offline under node:test.
// Run fn over items with at most `limit` in flight — a health check must never
// flood Node's small fs thread pool (it would starve the cache copy's own I/O).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function createHealthController({ portal, ffmpeg, settings, fileOk = async () => true, getVideoPaths = () => [], getStreamServers = async () => [], probeServer = null, isLive = () => false, checkTimeoutMs = 60000, intervalMs = 3 * 60 * 60 * 1000, now = () => Date.now(), onChanged = () => {}, log = () => {} }) {
  let state = { at: 0, ok: null, checking: false, checks: [] };   // ok:null = never checked yet
  let timer = null;

  const snapshot = () => ({ ...state, checks: state.checks.map((c) => ({ ...c })) });
  const publish = () => { try { onChanged(snapshot()); } catch {} };

  // Run one named check; a thrown error becomes a failed check rather than aborting the rest.
  async function runOne(id, label, fn) {
    // Bounded: a hung dependency (portal, drive) must not leave the check stuck
    // in "checking…" forever (2026-09-04 audit).
    let timer = null;
    const cutoff = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out — no answer after ' + Math.round(checkTimeoutMs / 1000) + ' s')), checkTimeoutMs); });
    try { return { id, label, ...(await Promise.race([fn(), cutoff])) }; }
    catch (e) { return { id, label, ok: false, detail: (e && e.message) || String(e) }; }
    finally { clearTimeout(timer); }
  }

  async function check() {
    if (state.checking) return snapshot();          // never overlap checks
    state = { ...state, checking: true }; publish();

    const engine = await runOne('engine', 'Video engine', async () => {
      const r = await ffmpeg.selfCheck();
      return (r && r.ok) ? { ok: true, detail: r.version || 'ready' }
                         : { ok: false, detail: (r && r.error) || 'not responding' };
    });

    const portalCheck = await runOne('portal', 'Content portal sign-in', async () => {
      if (!settings.get().portalEmail) return { ok: false, detail: 'Not set up — add your portal login in Setup' };
      const r = await portal.testLogin({});
      return (r && r.ok) ? { ok: true, detail: (r.stations ? r.stations.length : 0) + ' studios found' }
                         : { ok: false, detail: (r && r.error) || 'sign-in failed' };
    });

    // Slate images + music live on disk (often a network drive) — if the drive
    // drops, they vanish and a class's slate fails. Check the configured ones.
    const slate = await runOne('slate', 'Slate files', async () => {
      const s = settings.get();
      const entries = [['widescreen slate', s.slateImage], ['vertical slate', s.slateImageVertical], ['slate music', s.slateMusic]].filter(([, p]) => p);
      if (!entries.length) return { ok: true, detail: 'none set' };
      if (isLive()) return { ok: true, detail: 'not probed — a class is on air' };
      const results = await mapLimit(entries, 2, async ([label, p]) => [label, await fileOk(p)]);
      const missing = results.filter(([, ok]) => !ok).map(([label]) => label);
      return missing.length ? { ok: false, detail: 'can’t reach ' + missing.join(', ') + ' — is the network drive connected?' }
                            : { ok: true, detail: entries.length + (entries.length > 1 ? ' files OK' : ' file OK') };
    });

    // The scheduled class videos live on the same drive — a missing one means the
    // class can't air. Check every upcoming video that has a chosen file.
    const videos = await runOne('videos', 'Scheduled videos', async () => {
      const paths = (getVideoPaths() || []).filter(Boolean);
      if (!paths.length) return { ok: true, detail: 'none scheduled' };
      if (isLive()) return { ok: true, detail: 'not probed — a class is on air' };
      const results = await mapLimit(paths, 2, (p) => fileOk(p));
      const missing = results.filter((ok) => !ok).length;
      return missing ? { ok: false, detail: missing + (missing > 1 ? ' scheduled videos are missing' : ' scheduled video is missing') + ' — check the file(s) / network drive' }
                     : { ok: true, detail: paths.length + (paths.length > 1 ? ' videos OK' : ' video OK') };
    });

    // The studios' stream servers themselves — probed with the streaming engine,
    // so a broken secure connection (2.4.7) is caught here, not at air time.
    const studios = await runOne('studios', 'Studio stream servers', async () => {
      const list = (await getStreamServers()) || [];
      const byServer = new Map();
      for (const it of list) if (it && it.server && !byServer.has(it.server)) byServer.set(it.server, it.label || it.server);
      if (!byServer.size) return { ok: true, detail: 'no upcoming classes to check' };
      if (!probeServer) return { ok: true, detail: byServer.size + ' studio(s) — probe unavailable' };
      const results = await Promise.all([...byServer].map(async ([server, label]) => [label, await probeServer(server)]));
      const bad = results.filter(([, r]) => !(r && r.ok));
      if (bad.length) return { ok: false, detail: bad.map(([label, r]) => label + ': ' + ((r && r.detail) || 'cannot be reached')).join(' · ') };
      return { ok: true, detail: results.length + (results.length > 1 ? ' studios reachable' : ' studio reachable') + (results.every(([, r]) => /secure/.test(r.detail || '')) ? ' (secure)' : '') };
    });

    const checks = [engine, portalCheck, slate, videos, studios];
    state = { at: now(), ok: checks.every((c) => c.ok), checking: false, checks };
    publish();
    return snapshot();
  }

  function getState() { return snapshot(); }
  function start() {
    if (timer) return;
    check().catch((e) => log('health check error: ' + ((e && e.message) || e)));
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { getState, check, start, stop };
}
module.exports = { createHealthController };
