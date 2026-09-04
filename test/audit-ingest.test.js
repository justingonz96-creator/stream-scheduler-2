'use strict';
// 2026-09-04 audit: "Connections OK" never touched a studio's stream server, so
// the 2.4.7 fault (the engine could not verify any TLS certificate) stayed
// invisible. The health check now probes each upcoming class's ingest server
// with the SAME bundled engine that will stream to it.
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyProbe, probeTargetFor } = require('../engine/ffmpeg');
const { createHealthController } = require('../store/health');

// Real stderr captured from the bundled ffmpeg 9.0.1 on 2026-09-04:
const HEALTHY_TLS = '[tls @ 0x1] IO error: Operation timed out\n[in#0 @ 0x1] Error opening input: Operation timed out\nError opening input file tls://global-live.mux.com:443.\nError opening input files: Operation timed out';
const NO_CA = '[tls @ 0x1] error:0A000086:SSL routines::certificate verify failed\n[in#0 @ 0x1] Error opening input: Input/output error\nError opening input files: Input/output error';
const REFUSED = '[tcp @ 0x1] Connection to tcp://127.0.0.1:1 failed: Connection refused\n[in#0 @ 0x1] Error opening input: Connection refused';
const NO_DNS = '[tcp @ 0x1] Failed to resolve hostname no-such-host.invalid: nodename nor servname provided, or not known\n[in#0 @ 0x1] Error opening input: Input/output error';
const CONNECT_TIMEOUT = '[tcp @ 0x1] Connection to tcp://10.0.0.1:443 failed: Operation timed out\n[in#0 @ 0x1] Error opening input: Operation timed out';
const HEALTHY_TCP = '[in#0 @ 0x1] Error opening input: Operation timed out\nError opening input file tcp://global-live.mux.com:5222?timeout=4000000.';

test('a handshake that then times out waiting for data = reachable and secure', () => {
  assert.deepEqual(classifyProbe(HEALTHY_TLS), { ok: true, detail: 'reachable (secure)' });
  assert.equal(classifyProbe(HEALTHY_TCP).ok, true);
});
test('the certificate fault is named as such (the 2.4.7 class of failure)', () => {
  const r = classifyProbe(NO_CA);
  assert.equal(r.ok, false); assert.match(r.detail, /certificate/i);
});
test('refused, unresolvable, and connect-timeout are all "cannot be reached", with the reason', () => {
  assert.equal(classifyProbe(REFUSED).ok, false); assert.match(classifyProbe(REFUSED).detail, /refused/i);
  assert.equal(classifyProbe(NO_DNS).ok, false); assert.match(classifyProbe(NO_DNS).detail, /resolve|name/i);
  assert.equal(classifyProbe(CONNECT_TIMEOUT).ok, false); assert.match(classifyProbe(CONNECT_TIMEOUT).detail, /timed out/i);
});
test('probe targets: rtmps → tls on 443 by default, rtmp → tcp on 1935; explicit ports kept; the key never appears', () => {
  assert.equal(probeTargetFor('rtmps://global-live.mux.com/app'), 'tls://global-live.mux.com:443');
  assert.equal(probeTargetFor('rtmps://global-live.mux.com:443/app/SECRETKEY'), 'tls://global-live.mux.com:443');
  assert.equal(probeTargetFor('rtmp://global-live.mux.com:5222/app'), 'tcp://global-live.mux.com:5222');
  assert.equal(probeTargetFor('rtmp://h/app'), 'tcp://h:1935');
  assert.equal(probeTargetFor('garbage'), '');
});

// The health check wires it in as its own line item.
const okEngine = { selfCheck: async () => ({ ok: true, version: 'x' }) };
const okPortal = { testLogin: async () => ({ ok: true, stations: [{}] }) };
const settings = { get: () => ({ portalEmail: 'a@b' }) };
test('health: every upcoming class’s studio server is probed; a certificate failure turns the check red and names the studio', async () => {
  const probed = [];
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings,
    getStreamServers: async () => [{ label: 'Miami', server: 'rtmps://a.example/app' }, { label: 'Dallas', server: 'rtmps://b.example/app' }],
    probeServer: async (server) => { probed.push(server); return server.includes('b.example') ? { ok: false, detail: 'secure connection failed (certificate could not be verified)' } : { ok: true, detail: 'reachable (secure)' }; } });
  const s = await h.check();
  assert.deepEqual(probed.sort(), ['rtmps://a.example/app', 'rtmps://b.example/app']);
  const c = s.checks.find((x) => x.id === 'studios');
  assert.equal(c.ok, false); assert.match(c.detail, /Dallas/); assert.match(c.detail, /certificate/i);
  assert.equal(s.ok, false);
});
test('health: all studios reachable → green with a count; no upcoming classes → neutral', async () => {
  const h = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings,
    getStreamServers: async () => [{ label: 'Miami', server: 'rtmps://a.example/app' }, { label: 'Miami again', server: 'rtmps://a.example/app' }],
    probeServer: async () => ({ ok: true, detail: 'reachable (secure)' }) });
  const s = await h.check();
  const c = s.checks.find((x) => x.id === 'studios');
  assert.equal(c.ok, true); assert.match(c.detail, /1 studio/);
  const h2 = createHealthController({ portal: okPortal, ffmpeg: okEngine, settings, getStreamServers: async () => [], probeServer: async () => ({ ok: true }) });
  assert.equal((await h2.check()).checks.find((x) => x.id === 'studios').ok, true);
});
