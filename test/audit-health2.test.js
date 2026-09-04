'use strict';
// 2026-09-04 audit, health-check robustness items.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHealthController } = require('../store/health');

const okEngine = { selfCheck: async () => ({ ok: true, version: 'x' }) };
const okPortal = { testLogin: async () => ({ ok: true, stations: [{}] }) };
const settings = { get: () => ({ portalEmail: 'a@b', slateImage: '/s1', slateImageVertical: '/s2', slateMusic: '/m' }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (18) file probes all fired at once and could exhaust Node's fs thread pool
test('file probes run with bounded concurrency (never more than 2 in flight)', async () => {
  let inFlight = 0, peak = 0;
  const fileOk = async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(15); inFlight--; return true; };
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings, fileOk, getVideoPaths: () => ['/v1', '/v2', '/v3', '/v4', '/v5', '/v6'] });
  await h.check();
  assert.ok(peak <= 2, 'peak in-flight probes: ' + peak);
});

// (57) a hung dependency left the check stuck in "checking" forever
test('a check that hangs is cut off by a timeout and reported, and the run still completes', async () => {
  const portal = { testLogin: () => new Promise(() => {}) };   // never resolves
  const h = createHealthController({ portal, ffmpeg: okEngine, settings, checkTimeoutMs: 50 });
  const s = await h.check();
  assert.equal(s.checking, false);
  const p = s.checks.find((c) => c.id === 'portal');
  assert.equal(p.ok, false); assert.match(p.detail, /timed out|no answer/i);
});

// (51) health checks ran their drive probes during a live class
test('while a class is on air, the drive probes are skipped (reported as such), other checks still run', async () => {
  let probes = 0;
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings, fileOk: async () => { probes++; return true; }, getVideoPaths: () => ['/v1'], isLive: () => true });
  const s = await h.check();
  assert.equal(probes, 0);
  assert.match(s.checks.find((c) => c.id === 'videos').detail, /class is on air/i);
  assert.equal(s.checks.find((c) => c.id === 'engine').ok, true);
  assert.equal(s.ok, true, 'skipped probes do not turn the bar red');
});
