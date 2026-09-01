'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createHealthController } = require('../store/health');

const okEngine = { selfCheck: async () => ({ ok: true, version: 'ffmpeg 8.1' }) };
const badEngine = { selfCheck: async () => ({ ok: false, error: 'ffmpeg not found' }) };
const okPortal = { testLogin: async () => ({ ok: true, stations: [{}, {}, {}] }) };
const badPortal = { testLogin: async () => ({ ok: false, error: 'the portal login failed' }) };
const setupSettings = (over = {}) => ({ get: () => ({ portalEmail: 'you@echelonfit.com', ...over }) });
const noPortalSettings = { get: () => ({ portalEmail: '' }) };

test('all good → ok:true with both checks passing', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings: setupSettings() });
  const s = await h.check();
  assert.equal(s.ok, true);
  assert.equal(s.checks.find((c) => c.id === 'engine').ok, true);
  const p = s.checks.find((c) => c.id === 'portal');
  assert.equal(p.ok, true);
  assert.match(p.detail, /3 studios/);
});

test('engine down → ok:false and the engine check reports why', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: badEngine, settings: setupSettings() });
  const s = await h.check();
  assert.equal(s.ok, false);
  const e = s.checks.find((c) => c.id === 'engine');
  assert.equal(e.ok, false); assert.match(e.detail, /not found/);
});

test('portal sign-in failing → ok:false with the portal error', async () => {
  const h = createHealthController({ portal: badPortal, ffmpeg: okEngine, settings: setupSettings() });
  const s = await h.check();
  assert.equal(s.ok, false);
  const p = s.checks.find((c) => c.id === 'portal');
  assert.equal(p.ok, false); assert.match(p.detail, /login failed/);
});

test('portal not configured → flagged as a real problem, without calling the portal', async () => {
  let called = false;
  const spyPortal = { testLogin: async () => { called = true; return { ok: true }; } };
  const h = createHealthController({ portal: spyPortal, ffmpeg: okEngine, settings: noPortalSettings });
  const s = await h.check();
  assert.equal(s.ok, false);
  assert.match(s.checks.find((c) => c.id === 'portal').detail, /Not set up/);
  assert.equal(called, false, 'must not hit the network when nothing is configured');
});

test('a thrown check becomes a failed check, not a crash', async () => {
  const throwingPortal = { testLogin: async () => { throw new Error('network down'); } };
  const h = createHealthController({ portal: throwingPortal, ffmpeg: okEngine, settings: setupSettings() });
  const s = await h.check();
  assert.equal(s.ok, false);
  assert.match(s.checks.find((c) => c.id === 'portal').detail, /network down/);
});

test('stamps the check time from the injected clock', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings: setupSettings(), now: () => 123456 });
  const s = await h.check();
  assert.equal(s.at, 123456);
});

test('slate files unreachable (network drive down) → ok:false, names the missing ones', async () => {
  const settings = { get: () => ({ portalEmail: 'x@y.com', slateImage: '/net/wide.png', slateImageVertical: '', slateMusic: '/net/music.mp3' }) };
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings, fileOk: async () => false });
  const s = await h.check();
  assert.equal(s.ok, false);
  const slate = s.checks.find((c) => c.id === 'slate');
  assert.equal(slate.ok, false);
  assert.match(slate.detail, /widescreen slate/);
  assert.match(slate.detail, /slate music/);
  assert.match(slate.detail, /network drive/);
});

test('only the configured slate files are checked, and all-reachable passes', async () => {
  const checked = [];
  const settings = { get: () => ({ portalEmail: 'x@y.com', slateImage: '/net/wide.png', slateMusic: '/net/music.mp3' }) };  // no vertical
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings, fileOk: async (p) => { checked.push(p); return true; } });
  const s = await h.check();
  assert.equal(s.checks.find((c) => c.id === 'slate').ok, true);
  assert.deepEqual(checked.sort(), ['/net/music.mp3', '/net/wide.png']);   // vertical (unset) not probed
});

test('a scheduled video missing from the drive → ok:false', async () => {
  const present = new Set(['/net/a.mp4']);
  const h = createHealthController({
    portal: okPortal, ffmpeg: okEngine, settings: setupSettings(),
    getVideoPaths: () => ['/net/a.mp4', '/net/gone.mp4'], fileOk: async (p) => present.has(p),
  });
  const s = await h.check();
  assert.equal(s.ok, false);
  const v = s.checks.find((c) => c.id === 'videos');
  assert.equal(v.ok, false);
  assert.match(v.detail, /1 scheduled video is missing/);
});

test('nothing configured for slate/videos → those checks pass quietly', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings: setupSettings() });
  const s = await h.check();
  assert.equal(s.checks.find((c) => c.id === 'slate').detail, 'none set');
  assert.equal(s.checks.find((c) => c.id === 'videos').detail, 'none scheduled');
  assert.equal(s.ok, true);
});

test('start() runs an immediate check and publishes; getState reflects it', async () => {
  const seen = [];
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings: setupSettings(), intervalMs: 3600000, onChanged: (s) => seen.push(s) });
  h.start();
  await new Promise((r) => setTimeout(r, 20));   // let the immediate check resolve
  assert.equal(h.getState().ok, true);
  assert.ok(seen.length >= 1);
  h.stop();
});

test('getState returns a copy — callers cannot mutate internal state', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings: setupSettings() });
  await h.check();
  const s = h.getState();
  s.checks[0].ok = 'tampered';
  assert.notEqual(h.getState().checks[0].ok, 'tampered');
});
