'use strict';
// The bundled macOS FFmpeg is built with OpenSSL (--enable-openssl). Unlike
// macOS's own TLS stack, OpenSSL does NOT read the system keychain: without a CA
// bundle it rejects EVERY certificate with "certificate verify failed", which
// ffmpeg reports as "Error opening output files: Input/output error" — the exact
// error that killed a class on 2026-09-03. Any rtmps:// studio is unreachable
// until ffmpeg is told where the certificates are.
const { test } = require('node:test');
const assert = require('node:assert');
const { caFile, ffmpegEnv } = require('../engine/ffmpeg');

test('caFile picks the first candidate that exists', () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p === '/etc/ssl/cert.pem'; };
  assert.equal(caFile({ exists, candidates: ['/nope/a.pem', '/etc/ssl/cert.pem', '/etc/other.pem'] }), '/etc/ssl/cert.pem');
  assert.deepEqual(seen, ['/nope/a.pem', '/etc/ssl/cert.pem'], 'stops at the first hit');
});

test('caFile returns empty when nothing is found — never invents a path', () => {
  assert.equal(caFile({ exists: () => false, candidates: ['/a', '/b'] }), '');
});

test('ffmpegEnv points OpenSSL at the bundle it found', () => {
  const env = ffmpegEnv({ base: { PATH: '/usr/bin' }, ca: '/etc/ssl/cert.pem' });
  assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is preserved');
});

test('an SSL_CERT_FILE the operator already set is never overwritten', () => {
  const env = ffmpegEnv({ base: { SSL_CERT_FILE: '/custom/mine.pem' }, ca: '/etc/ssl/cert.pem' });
  assert.equal(env.SSL_CERT_FILE, '/custom/mine.pem');
});

test('no bundle found → the environment is left exactly as it was', () => {
  const base = { PATH: '/usr/bin' };
  assert.deepEqual(ffmpegEnv({ base, ca: '' }), base);
});

test('the real machine resolves a CA bundle (so TLS can verify at all)', () => {
  if (process.platform !== 'darwin') return;   // the OpenSSL build is the macOS one
  assert.ok(caFile(), 'macOS must resolve a CA bundle, or every rtmps:// studio fails');
});
