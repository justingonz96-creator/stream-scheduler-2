'use strict';
/* READ-ONLY live probe of the real Echelon portal (dev machine only).
   Usage: node scripts/portal-live-check.js <class link or contentItemGuid>
   Credentials: 1.x helper's ~/Library/Application Support/StreamScheduler/portal.conf
   if present, else PORTAL_EMAIL / PORTAL_PASSWORD / PORTAL_API_KEY env vars.
   Prints NO secrets: not the password, not the stream key. Ends nothing. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPortalClient } = require('../portal/client');
const { createTransport } = require('../portal/http');

function loadCreds() {
  const conf1x = path.join(os.homedir(), 'Library', 'Application Support', 'StreamScheduler', 'portal.conf');
  try {
    const c = JSON.parse(fs.readFileSync(conf1x, 'utf8'));
    if (c.email && c.password) return { email: c.email, password: c.password, apiKey: c.apiKey || '', apiBase: c.apiBase || '' };
  } catch {}
  const { PORTAL_EMAIL, PORTAL_PASSWORD, PORTAL_API_KEY } = process.env;
  if (PORTAL_EMAIL && PORTAL_PASSWORD) return { email: PORTAL_EMAIL, password: PORTAL_PASSWORD, apiKey: PORTAL_API_KEY || '', apiBase: '' };
  return null;
}

function parseClassArg(arg) {
  const s = String(arg || '');
  let m = /\/broadcast\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})/.exec(s);
  if (m) return { contentItemGuid: m[1], scheduleGuid: m[2] };
  m = /([0-9a-fA-F-]{36})/.exec(s);
  if (m) return { contentItemGuid: m[1], scheduleGuid: '' };
  return null;
}

(async () => {
  const creds = loadCreds();
  if (!creds) { console.error('No credentials: need 1.x portal.conf or PORTAL_EMAIL/PORTAL_PASSWORD env.'); process.exit(2); }
  const link = parseClassArg(process.argv[2]);
  if (!link) { console.error('Usage: node scripts/portal-live-check.js <class link or guid>'); process.exit(2); }

  const client = createPortalClient({
    getConfig: () => ({ email: creds.email, password: creds.password, apiKey: creds.apiKey, ...(creds.apiBase ? { apiBase: creds.apiBase } : {}) }),
    transport: createTransport(),
    log: (m) => console.log('  [log] ' + m),
  });

  let failures = 0;
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

  const t = await client.testLogin();
  check('login + station list', t.ok, t.ok ? `${t.stations.length} stations` : t.error);

  const c = await client.checkClassLink(link);
  check('class link resolves', c.ok, c.ok ? `count=${c.count} schedule=${(c.picked || {}).scheduleGuid} station=${(c.picked || {}).stationGuid} ${c.vertical ? '9:16' : '16:9'} (medium=${c.medium})` : c.error);

  const s = await client.streamTarget(link);
  check('stream target', s.ok, s.ok ? `station "${s.stationName}" server=${s.server} key: present (${s.key.length} chars) ${s.vertical ? '9:16' : '16:9'}` : s.error);

  console.log(failures === 0 ? '\nLIVE CHECK PASSED (read-only — nothing was ended or started)' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
