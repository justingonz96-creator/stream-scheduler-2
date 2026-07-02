# Stream Scheduler 2.0 — Plan 2: Portal Client + Store

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 1.x Python portal helper into pure-Node modules — login, class-link resolution, occurrence picking, station ingest (RTMP + stream key), vertical detection, end-broadcast — plus the JSON store and an injectable secret store.

**Architecture:** `portal/` = a stateless pure-logic core (occurrences, stations) + a stateful transport (cookie jar, timeouts) + a client facade that composes them; every network-touching function takes an injected transport so tests run offline against fakes or a local `node:http` server. `store/` = per-OS app-data path resolution, atomic JSON files, and a secret store with an injected encrypt/decrypt codec (Electron `safeStorage` gets wired in Plan 3 — these modules stay Electron-free).

**Tech Stack:** Node 26 built-ins only (`node:test`, global `fetch`, `node:http` for tests, `node:fs`/`path`/`os`). Zero npm dependencies.

**Reference implementation (canonical semantics):** `/Users/eleonard/Documents/Cluade/stream-scheduler/portal-helper.py` — the field-tested 1.x helper. Port its behavior faithfully; where this plan's code differs from an implementer's reading of the Python, this plan governs.

**Spec:** `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md` (§6 portal, §7 storage).

## Global Constraints

- Engine/portal/store modules run **without Electron**: `node:*` built-ins only, zero npm runtime deps.
- Plain-English error strings — non-technical operators read them.
- **The stream key is a credential: it must NEVER appear in any log line, error message, thrown Error, or console output.** Tests assert this.
- API base default: `https://nestapi.echelonfit.com`. All portal requests send `Content-Type: application/json`, `Accept: application/json, text/plain, */*`, plus `X-Api-Key` when configured and `Authorization: Bearer <token>` when logged in. Request timeout 25 s.
- Vertical detection: a class is 9:16 iff its content-item `medium`, lowercased/trimmed, is in `VERTICAL_MEDIUMS = {'reflect'}`.
- Occurrence picking (1.x law): candidates need both `scheduleGuid` and `stationGuid`; GRACE = 7200 s; an occurrence is "in window" when `start − GRACE ≤ now ≤ (end || start + 14400) + GRACE`; pick the in-window one with the LATEST start; else the timed one with start nearest `now`; else the first candidate. An explicitly supplied `scheduleGuid` (full broadcast link) overrides picking with an exact match — for BOTH stream-target and end.
- Station ingest: `server = rtmpUrl.secure || rtmpUrl.standard`, `key = mux.streamKey`; both required.
- Storage (spec §7): app-data dir `StreamScheduler2` (mac `~/Library/Application Support/`, win `%APPDATA%\`, else `$XDG_CONFIG_HOME`/`~/.config/`); JSON written atomically (temp file + rename).
- `npm test` = `node --test` (self-discovery). Suite currently 18/18 — must stay green.
- Tests must not hit the real portal. Live verification happens once, via the Task 7 dev script, controller-run.

---

### Task 1: `store/appdata.js` + `store/jsonstore.js` — app-data path + atomic JSON

**Files:**
- Create: `store/appdata.js`, `store/jsonstore.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces: `appDataDir(platform = process.platform, env = process.env): string` — absolute dir path (NOT created by this call). `readJson(filePath, fallback): any` (fallback on missing/corrupt). `writeJsonAtomic(filePath, obj): void` (mkdir -p the parent, write `<file>.tmp`, rename over).

- [ ] **Step 1: Write the failing tests**

`test/store.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appDataDir } = require('../store/appdata');
const { readJson, writeJsonAtomic } = require('../store/jsonstore');

test('appDataDir per platform', () => {
  const env = { HOME: '/Users/kim', APPDATA: 'C:\\Users\\kim\\AppData\\Roaming', XDG_CONFIG_HOME: '' };
  assert.equal(appDataDir('darwin', env), '/Users/kim/Library/Application Support/StreamScheduler2');
  assert.equal(appDataDir('win32', env), path.join('C:\\Users\\kim\\AppData\\Roaming', 'StreamScheduler2'));
  assert.equal(appDataDir('linux', env), path.join('/Users/kim', '.config', 'StreamScheduler2'));
  assert.equal(appDataDir('linux', { HOME: '/h', XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'StreamScheduler2'));
});

test('writeJsonAtomic + readJson round-trip, creating parent dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  const file = path.join(dir, 'deep', 'nested', 'settings.json');
  writeJsonAtomic(file, { a: 1, b: 'two' });
  assert.deepEqual(readJson(file, null), { a: 1, b: 'two' });
  assert.equal(fs.existsSync(file + '.tmp'), false, 'temp file cleaned up by rename');
});

test('readJson falls back on missing and on corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-store-'));
  assert.deepEqual(readJson(path.join(dir, 'nope.json'), { d: true }), { d: true });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(readJson(bad, []), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../store/appdata'`.

- [ ] **Step 3: Implement**

`store/appdata.js`:
```js
'use strict';
// Where this app keeps its files, per OS (spec §7). Distinct from 1.x's
// "StreamScheduler" dir so both apps can coexist on one machine.
const path = require('node:path');

function appDataDir(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'StreamScheduler2');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'StreamScheduler2');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'StreamScheduler2');
}

module.exports = { appDataDir };
```

`store/jsonstore.js`:
```js
'use strict';
// Atomic JSON files (spec §7): write a sibling temp file, then rename over the
// target — a crash mid-write can never leave a half-written settings/schedule file.
const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { readJson, writeJsonAtomic };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/store.test.js` — expected: 3 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 21 tests, 0 fail.
```bash
git add store/appdata.js store/jsonstore.js test/store.test.js
git commit -m "feat: app-data path resolution and atomic JSON store"
```

---

### Task 2: `store/secrets.js` — secret store with injectable codec

**Files:**
- Create: `store/secrets.js`
- Test: `test/secrets.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJsonAtomic` (Task 1).
- Produces: `createSecretStore({ file, encrypt, decrypt })` → `{ set(name, value): void, get(name): string|null, has(name): boolean }`. `encrypt(plaintext: string): Buffer`, `decrypt(blob: Buffer): string` are injected — Plan 3 wires Electron `safeStorage`; tests use a reversible fake. Values are stored base64-encoded in a JSON file; after writing, the file is chmod 0600 (best-effort, skipped errors). `get` returns `null` for missing names AND when `decrypt` throws (corrupt/foreign blob — never propagates).

- [ ] **Step 1: Write the failing tests**

`test/secrets.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSecretStore } = require('../store/secrets');

// Reversible fake codec (stands in for Electron safeStorage in Plan 3).
const codec = {
  encrypt: (s) => Buffer.from('X' + s, 'utf8'),
  decrypt: (b) => { const t = b.toString('utf8'); if (!t.startsWith('X')) throw new Error('bad blob'); return t.slice(1); },
};

function freshFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-sec-')), 'secrets.json');
}

test('set/get/has round-trip; plaintext never on disk', () => {
  const file = freshFile();
  const s = createSecretStore({ file, ...codec });
  s.set('portalPassword', 'hunter2-secret');
  assert.equal(s.get('portalPassword'), 'hunter2-secret');
  assert.equal(s.has('portalPassword'), true);
  assert.equal(s.get('nope'), null);
  assert.equal(s.has('nope'), false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('hunter2-secret'), 'plaintext must not be stored');
});

test('corrupt blob → get returns null, never throws', () => {
  const file = freshFile();
  const s = createSecretStore({ file, ...codec });
  s.set('k', 'v');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.k = Buffer.from('garbage').toString('base64');   // not X-prefixed → decrypt throws
  fs.writeFileSync(file, JSON.stringify(onDisk));
  assert.equal(s.get('k'), null);
});

test('persists across store instances (same file)', () => {
  const file = freshFile();
  createSecretStore({ file, ...codec }).set('a', 'b');
  assert.equal(createSecretStore({ file, ...codec }).get('a'), 'b');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/secrets.test.js`
Expected: FAIL — `Cannot find module '../store/secrets'`.

- [ ] **Step 3: Implement `store/secrets.js`**

```js
'use strict';
// Secrets (the portal password) live in their own JSON file, each value run
// through an injected encrypt/decrypt codec. In the app that codec is Electron's
// safeStorage (OS keychain-backed, wired in Plan 3); in tests it's a fake.
// This module never sees Electron — it just applies the codec.
const fs = require('node:fs');
const { readJson, writeJsonAtomic } = require('./jsonstore');

function createSecretStore({ file, encrypt, decrypt }) {
  function load() { return readJson(file, {}); }
  return {
    set(name, value) {
      const all = load();
      all[name] = encrypt(String(value)).toString('base64');
      writeJsonAtomic(file, all);
      try { fs.chmodSync(file, 0o600); } catch {}   // best-effort (no-op on Windows)
    },
    get(name) {
      const b64 = load()[name];
      if (typeof b64 !== 'string') return null;
      try { return decrypt(Buffer.from(b64, 'base64')); }
      catch { return null; }                        // corrupt/foreign blob — treat as unset
    },
    has(name) { return this.get(name) !== null; },
  };
}

module.exports = { createSecretStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/secrets.test.js` — expected: 3 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 24 tests, 0 fail.
```bash
git add store/secrets.js test/secrets.test.js
git commit -m "feat: secret store with injectable codec (safeStorage wired in Plan 3)"
```

---

### Task 3: `portal/http.js` — transport with cookie jar + timeout

**Files:**
- Create: `portal/http.js`
- Test: `test/http.test.js` (uses a real local `node:http` server — no mocks)

**Interfaces:**
- Produces: `createTransport({ timeoutMs = 25000 } = {})` → `async transport(method, url, { headers = {}, body = undefined })` → `{ status: number, text: string }`. Behavior: JSON default headers (`Content-Type: application/json`, `Accept: application/json, text/plain, */*`) merged under caller headers; `body` (when given) is an object, JSON-stringified; captures `Set-Cookie` response headers into a per-transport jar keyed by cookie name and sends them back as a `Cookie` header on subsequent requests (the 1.x helper's cookie-session behavior); AbortController timeout; network-level failure returns `{ status: 0, text: <error message> }` — it NEVER throws (ports the Python `except → (0, str(e))`).

- [ ] **Step 1: Write the failing tests**

`test/http.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createTransport } = require('../portal/http');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('POST json body, default headers, status+text back', async () => {
  const seen = {};
  const { srv, base } = await serve((req, res) => {
    seen.method = req.method; seen.ct = req.headers['content-type'];
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { seen.body = b; res.writeHead(201); res.end('{"token":"abcdefghijklmnopqrstuvwxyz"}'); });
  });
  const t = createTransport();
  const r = await t('POST', base + '/auth', { body: { email: 'e', password: 'p' } });
  srv.close();
  assert.equal(r.status, 201);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.ct, 'application/json');
  assert.deepEqual(JSON.parse(seen.body), { email: 'e', password: 'p' });
  assert.match(r.text, /token/);
});

test('cookie jar: Set-Cookie is replayed on the next request', async () => {
  const seen = { cookies: [] };
  const { srv, base } = await serve((req, res) => {
    seen.cookies.push(req.headers.cookie || '');
    res.setHeader('Set-Cookie', 'sid=s3cr3t; Path=/; HttpOnly');
    res.writeHead(200); res.end('{}');
  });
  const t = createTransport();
  await t('GET', base + '/a', {});
  await t('GET', base + '/b', {});
  srv.close();
  assert.equal(seen.cookies[0], '');
  assert.match(seen.cookies[1], /sid=s3cr3t/);
});

test('unreachable host → status 0, never throws', async () => {
  const t = createTransport({ timeoutMs: 2000 });
  const r = await t('GET', 'http://127.0.0.1:1/nope', {});
  assert.equal(r.status, 0);
  assert.ok(r.text.length > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/http.test.js`
Expected: FAIL — `Cannot find module '../portal/http'`.

- [ ] **Step 3: Implement `portal/http.js`**

```js
'use strict';
// The portal transport: JSON in/out, a minimal per-transport cookie jar (the
// portal may carry the session in a cookie rather than the body token), a
// bounded timeout, and NO throwing — network failure is {status: 0, text}.
// Everything above this (auth, client) treats status 0 / >=400 as failure.

function createTransport({ timeoutMs = 25000 } = {}) {
  const jar = new Map();   // cookie name -> value

  return async function transport(method, url, { headers = {}, body = undefined } = {}) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      ...headers,
    };
    if (jar.size > 0) {
      h['Cookie'] = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method, headers: h, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const sc of res.headers.getSetCookie?.() || []) {
        const m = /^([^=;]+)=([^;]*)/.exec(sc);
        if (m) jar.set(m[1].trim(), m[2]);
      }
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: String(e && e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createTransport };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/http.test.js` — expected: 3 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 27 tests, 0 fail.
```bash
git add portal/http.js test/http.test.js
git commit -m "feat: portal transport with cookie jar, timeout, no-throw contract"
```

---

### Task 4: `portal/occurrences.js` — content-item parsing + occurrence picking (pure logic)

**Files:**
- Create: `portal/occurrences.js`
- Test: `test/occurrences.test.js`

**Interfaces:**
- Produces (pure functions, no I/O):
  - `parseContentItem(data): { occurrences: Occ[], medium: string|null }` where `Occ = {scheduleGuid, stationGuid, stationName, type, start, end}` — accepts `{data:{…}}` or the bare item; missing schedule → `[]`.
  - `pickOccurrence(occ: Occ[], nowSec: number): Occ|null` — the 1.x law (see Global Constraints).
  - `matchOccurrence(occ: Occ[], scheduleGuid: string): Occ|null` — exact match.
  - `isVertical(medium): boolean`; `VERTICAL_MEDIUMS` exported.

- [ ] **Step 1: Write the failing tests**

`test/occurrences.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseContentItem, pickOccurrence, matchOccurrence, isVertical } = require('../portal/occurrences');

const item = (schedule, medium) => ({ data: { medium, schedule } });
const occ = (over = {}) => ({
  guid: 'sched-' + (over.n || 1),
  controlStation: { guid: 'station-' + (over.n || 1), name: over.name || null },
  type: 'live',
  available: { start: over.start, end: over.end },
});

test('parseContentItem: wrapped or bare, medium, malformed entries skipped', () => {
  const parsed = parseContentItem(item([occ({ n: 1, start: 100, end: 200 }), 'junk', { guid: 'x' }], 'reflect'));
  assert.equal(parsed.medium, 'reflect');
  assert.equal(parsed.occurrences.length, 2);          // 'junk' (non-object) skipped; {guid:'x'} kept (station missing → filtered later by pick)
  assert.deepEqual(parsed.occurrences[0], {
    scheduleGuid: 'sched-1', stationGuid: 'station-1', stationName: null,
    type: 'live', start: 100, end: 200,
  });
  const bare = parseContentItem({ medium: 'standard', schedule: [] });
  assert.equal(bare.medium, 'standard');
  assert.deepEqual(bare.occurrences, []);
});

test('pickOccurrence: in-window wins, latest start among in-window', () => {
  const NOW = 10000;
  const a = { scheduleGuid: 'a', stationGuid: 'A', start: 4000, end: 20000 };   // in window
  const b = { scheduleGuid: 'b', stationGuid: 'B', start: 8000, end: 20000 };   // in window, later start
  const c = { scheduleGuid: 'c', stationGuid: 'C', start: 500000, end: 600000 }; // far future
  assert.equal(pickOccurrence([a, c, b], NOW).scheduleGuid, 'b');
});

test('pickOccurrence: GRACE stretches the window 7200s both sides; missing end defaults start+14400', () => {
  const NOW = 100000;
  const early = { scheduleGuid: 'e', stationGuid: 'E', start: NOW + 7000 };     // starts in 7000s — inside grace
  assert.equal(pickOccurrence([early], NOW).scheduleGuid, 'e');
  const stale = { scheduleGuid: 's', stationGuid: 'S', start: NOW - 14400 - 7200 - 1 };  // window (incl. grace) just expired
  const near = { scheduleGuid: 'n', stationGuid: 'N', start: NOW + 50000 };
  assert.equal(pickOccurrence([stale, near], NOW).scheduleGuid, 's', 'nearest-by-start when none in window');
});

test('pickOccurrence: candidates need BOTH guids; untimed fall back to first candidate', () => {
  const noStation = { scheduleGuid: 'x', stationGuid: null, start: 1 };
  const untimed1 = { scheduleGuid: 'u1', stationGuid: 'U1', start: undefined };
  const untimed2 = { scheduleGuid: 'u2', stationGuid: 'U2', start: undefined };
  assert.equal(pickOccurrence([noStation, untimed1, untimed2], 500).scheduleGuid, 'u1');
  assert.equal(pickOccurrence([noStation], 500), null);
  assert.equal(pickOccurrence([], 500), null);
});

test('matchOccurrence: exact scheduleGuid or null', () => {
  const a = { scheduleGuid: 'aaa', stationGuid: 'A' };
  assert.equal(matchOccurrence([a], 'aaa'), a);
  assert.equal(matchOccurrence([a], 'bbb'), null);
  assert.equal(matchOccurrence([a], ''), null);
});

test('isVertical: reflect (any case) yes; everything else no', () => {
  assert.equal(isVertical('reflect'), true);
  assert.equal(isVertical('  Reflect '), true);
  assert.equal(isVertical('standard'), false);
  assert.equal(isVertical(null), false);
  assert.equal(isVertical(undefined), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/occurrences.test.js`
Expected: FAIL — `Cannot find module '../portal/occurrences'`.

- [ ] **Step 3: Implement `portal/occurrences.js`**

```js
'use strict';
// Pure logic ported from 1.x portal-helper.py: a class (content item) embeds its
// broadcast occurrences, each carrying its own scheduleGuid + control-station.
// From the durable class link we can discover what to stream and what to end.

const VERTICAL_MEDIUMS = new Set(['reflect']);   // Echelon Reflect (the mirror) is portrait 9:16

function isVertical(medium) {
  return VERTICAL_MEDIUMS.has(String(medium || '').trim().toLowerCase());
}

function parseContentItem(data) {
  const item = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : (data || {});
  const medium = item.medium == null ? null : item.medium;
  const occurrences = [];
  for (const s of (Array.isArray(item.schedule) ? item.schedule : [])) {
    if (!s || typeof s !== 'object') continue;
    const cs = s.controlStation || {};
    const av = s.available || {};
    occurrences.push({
      scheduleGuid: s.guid ?? null,
      stationGuid: cs.guid ?? null,
      stationName: cs.name ?? null,
      type: s.type ?? null,
      start: av.start ?? null,   // null (not undefined): the 1.x contract — undefined keys
      end: av.end ?? null,       // vanish under JSON.stringify (schedule.json, logs, IPC)
    });
  }
  return { occurrences, medium };
}

const GRACE = 2 * 3600;            // treat "now" as inside a window even a couple hours either side
const DEFAULT_SPAN = 4 * 3600;     // occurrences without an end get a 4-hour window

function pickOccurrence(occurrences, nowSec) {
  const cands = occurrences.filter(o => o.scheduleGuid && o.stationGuid);
  if (cands.length === 0) return null;
  const timed = cands.filter(o => typeof o.start === 'number' && Number.isFinite(o.start));
  const inWindow = timed.filter(o =>
    (o.start - GRACE) <= nowSec && nowSec <= ((o.end || (o.start + DEFAULT_SPAN)) + GRACE));
  if (inWindow.length > 0) {
    return inWindow.slice().sort((a, b) => a.start - b.start)[inWindow.length - 1];  // latest start
  }
  if (timed.length > 0) {
    return timed.reduce((best, o) => Math.abs(o.start - nowSec) < Math.abs(best.start - nowSec) ? o : best);
  }
  return cands[0];
}

function matchOccurrence(occurrences, scheduleGuid) {
  if (!scheduleGuid) return null;
  return occurrences.find(o => o.scheduleGuid === scheduleGuid) || null;
}

module.exports = { parseContentItem, pickOccurrence, matchOccurrence, isVertical, VERTICAL_MEDIUMS, GRACE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/occurrences.test.js` — expected: 6 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 33 tests, 0 fail.
```bash
git add portal/occurrences.js test/occurrences.test.js
git commit -m "feat: content-item parsing and occurrence picking (1.x law, pure logic)"
```

---

### Task 5: `portal/stations.js` — station list parsing + ingest extraction (pure logic)

**Files:**
- Create: `portal/stations.js`
- Test: `test/stations.test.js`

**Interfaces:**
- Produces (pure functions):
  - `parseStations(data): Array<station>` — accepts a bare array, `{data:[…]}`, or `{items:[…]}`; else `[]`.
  - `stationIngest(stations, stationGuid): {ok:true, server, key, stationName} | {ok:false, error}` — `server = rtmpUrl.secure || rtmpUrl.standard`, `key = mux.streamKey`; errors: station not found → `"The studio for this class was not found."`; missing server/key → `"This studio has no stream ingest set up."`
  - `stationSummaries(stations): Array<{name, guid}>` — entries having both, for the test-login station list.

- [ ] **Step 1: Write the failing tests**

`test/stations.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStations, stationIngest, stationSummaries } = require('../portal/stations');

const S = {
  guid: 'g1', name: 'Connect',
  mux: { streamKey: 'sekret-key-value', streamId: 'id' },
  rtmpUrl: { standard: 'rtmp://global-live.mux.com:5222/app', secure: 'rtmps://global-live.mux.com:443/app' },
};

test('parseStations accepts bare array, {data}, {items}', () => {
  assert.equal(parseStations([S]).length, 1);
  assert.equal(parseStations({ data: [S] }).length, 1);
  assert.equal(parseStations({ items: [S] }).length, 1);
  assert.deepEqual(parseStations({ nope: 1 }), []);
});

test('stationIngest: secure preferred, key extracted', () => {
  const r = stationIngest([S], 'g1');
  assert.equal(r.ok, true);
  assert.equal(r.server, 'rtmps://global-live.mux.com:443/app');
  assert.equal(r.key, 'sekret-key-value');
  assert.equal(r.stationName, 'Connect');
});

test('stationIngest: standard fallback when no secure', () => {
  const s2 = { ...S, rtmpUrl: { standard: 'rtmp://global-live.mux.com:5222/app' } };
  assert.equal(stationIngest([s2], 'g1').server, 'rtmp://global-live.mux.com:5222/app');
});

test('stationIngest errors are plain-English and never contain the key', () => {
  const missing = stationIngest([S], 'other-guid');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /studio for this class was not found/i);
  const noKey = stationIngest([{ ...S, mux: {} }], 'g1');
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /no stream ingest set up/i);
  assert.ok(!JSON.stringify([missing, noKey]).includes('sekret-key-value'));
});

test('stationSummaries: name+guid pairs only', () => {
  assert.deepEqual(stationSummaries([S, { guid: 'x' }, { name: 'y' }]), [{ name: 'Connect', guid: 'g1' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stations.test.js`
Expected: FAIL — `Cannot find module '../portal/stations'`.

- [ ] **Step 3: Implement `portal/stations.js`**

```js
'use strict';
// Pure logic ported from 1.x: each Echelon control-station embeds its Mux live
// stream — the RTMP ingest URL + stream key OBS 1.x used, and our engine uses now.
// The stream key is a credential: callers must never log or display it.

function parseStations(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function stationIngest(stations, stationGuid) {
  const s = stations.find(x => x && typeof x === 'object' && x.guid === stationGuid);
  if (!s) return { ok: false, error: 'The studio for this class was not found.' };
  const rtmp = s.rtmpUrl || {};
  const server = rtmp.secure || rtmp.standard;
  const key = (s.mux || {}).streamKey;
  if (!server || !key) return { ok: false, error: 'This studio has no stream ingest set up.' };
  return { ok: true, server, key, stationName: s.name || '' };
}

function stationSummaries(stations) {
  return stations.filter(s => s && s.guid && s.name).map(s => ({ name: s.name, guid: s.guid }));
}

module.exports = { parseStations, stationIngest, stationSummaries };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stations.test.js` — expected: 5 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 38 tests, 0 fail.
```bash
git add portal/stations.js test/stations.test.js
git commit -m "feat: station parsing and ingest extraction (secure rtmps preferred)"
```

---

### Task 6: `portal/client.js` — the facade (auth + the four operations)

**Files:**
- Create: `portal/client.js`
- Test: `test/client.test.js` (fake transport — offline)

**Interfaces:**
- Consumes: `createTransport` (Task 3, injected), occurrence + station functions (Tasks 4-5).
- Produces: `createPortalClient({ getConfig, transport, log = () => {}, now = () => Math.floor(Date.now() / 1000) })` →
  - `testLogin(overrides = {})` → `{ok:true, stations:[{name,guid}]} | {ok:false, error}` — logs in with saved config merged under non-empty overrides (Setup's "Test login" passes typed credentials), then lists stations.
  - `checkClassLink({contentItemGuid, scheduleGuid})` → `{ok:true, count, picked, vertical, medium} | {ok:false, error}` — resolve + exact-match-else-pick.
  - `streamTarget({contentItemGuid, scheduleGuid})` → `{ok:true, server, key, stationName, vertical} | {ok:false, error}` — resolve, exact-match-else-pick, ingest. Logs `streamtarget class=<first 8> -> station "<name>" <guid> <9:16|16:9> (target delivered)` — **never the key**.
  - `endBroadcast({contentItemGuid, scheduleGuid, stationGuid})` → `{ok, status, detail}` — 1.x `do_end` law: when schedule or station missing and a class id exists, resolve and fill from exact match (pasted broadcast link) else picked occurrence; both still missing → `{ok:false, error:'No live broadcast was found to end for this class.'}`; else `POST {apiBase}/control-stations/{stationGuid}/stream/close` body `{scheduleGuid}`.
  - Auth (internal): `POST {apiBase}/auth` `{email, password}` (+X-Api-Key header when set); success = status < 400; token = recursive search of the response JSON for the first string > 20 chars under keys `token, accessToken, access_token, idToken, id_token, jwt, authToken` (1.x `_find_token`); no token found is OK if a session cookie was set (transport jar handles it). Subsequent GET/POST carry `Authorization: Bearer <token>` when a token exists + `X-Api-Key` always-when-configured. Login failure → `{ok:false, error:'The portal login failed — check the email and password in Setup.'}`. Config default `apiBase = 'https://nestapi.echelonfit.com'`.
- One client instance = one session (one transport/cookie jar); each operation logs in fresh per call (ports the 1.x helper, which logged in per request — simple and stateless; token caching is a later optimization if ever needed).

- [ ] **Step 1: Write the failing tests**

`test/client.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createPortalClient } = require('../portal/client');

// A scriptable fake transport: routes[method + ' ' + pathStart] -> {status, json}
function fakeTransport(routes, calls = []) {
  return async (method, url, opts = {}) => {
    calls.push({ method, url, opts });
    for (const [key, resp] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (method === m && url.includes(p)) {
        return { status: resp.status ?? 200, text: JSON.stringify(resp.json ?? {}) };
      }
    }
    return { status: 404, text: '{"error":"not found"}' };
  };
}

const CFG = { email: 'e@x.com', password: 'pw', apiKey: 'K', apiBase: 'https://portal.test' };
const getConfig = () => ({ ...CFG });
const AUTH_OK = { 'POST /auth': { status: 201, json: { token: 'tok-abcdefghijklmnopqrstuvwxyz' } } };
const ITEM = (medium, scheds) => ({ data: { medium, schedule: scheds } });
const SCHED = (n, start) => ({ guid: 'sg-' + n, controlStation: { guid: 'st-' + n, name: 'Studio ' + n }, type: 'live', available: { start, end: start + 3600 } });
const STATIONS = { data: [
  { guid: 'st-1', name: 'Studio 1', mux: { streamKey: 'KEY-ONE' }, rtmpUrl: { secure: 'rtmps://a/app', standard: 'rtmp://a/app' } },
  { guid: 'st-2', name: 'Studio 2', mux: { streamKey: 'KEY-TWO' }, rtmpUrl: { secure: 'rtmps://b/app', standard: 'rtmp://b/app' } },
] };
const NOW = 1000000;

test('testLogin: ok + station summaries; bad login → plain-English error', async () => {
  const c = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /control-stations': { json: STATIONS } }), now: () => NOW });
  const r = await c.testLogin();
  assert.equal(r.ok, true);
  assert.deepEqual(r.stations, [{ name: 'Studio 1', guid: 'st-1' }, { name: 'Studio 2', guid: 'st-2' }]);
  const bad = createPortalClient({ getConfig, transport: fakeTransport({ 'POST /auth': { status: 401, json: {} } }), now: () => NOW });
  const rb = await bad.testLogin();
  assert.equal(rb.ok, false);
  assert.match(rb.error, /login failed/i);
});

test('auth sends X-Api-Key and Bearer on the follow-up request', async () => {
  const calls = [];
  const c = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /control-stations': { json: STATIONS } }, calls), now: () => NOW });
  await c.testLogin();
  const authCall = calls.find(x => x.url.includes('/auth'));
  const listCall = calls.find(x => x.url.includes('/control-stations'));
  assert.equal(authCall.opts.headers['X-Api-Key'], 'K');
  assert.equal(listCall.opts.headers['Authorization'], 'Bearer tok-abcdefghijklmnopqrstuvwxyz');
  assert.equal(listCall.opts.headers['X-Api-Key'], 'K');
});

test('checkClassLink: picks by time; exact scheduleGuid overrides', async () => {
  const routes = { ...AUTH_OK, 'GET /content/items/': { json: ITEM('reflect', [SCHED(1, NOW - 600), SCHED(2, NOW + 90000)]) } };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), now: () => NOW });
  const picked = await c.checkClassLink({ contentItemGuid: 'ci-1' });
  assert.equal(picked.ok, true);
  assert.equal(picked.count, 2);
  assert.equal(picked.picked.scheduleGuid, 'sg-1');       // in-window beats far-future
  assert.equal(picked.vertical, true);
  const exact = await c.checkClassLink({ contentItemGuid: 'ci-1', scheduleGuid: 'sg-2' });
  assert.equal(exact.picked.scheduleGuid, 'sg-2');
});

test('streamTarget: right station ingest + vertical; the key NEVER hits the log', async () => {
  const logs = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(2, NOW - 60)]) },
    'GET /control-stations': { json: STATIONS },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), log: (m) => logs.push(m), now: () => NOW });
  const r = await c.streamTarget({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, true);
  assert.equal(r.server, 'rtmps://b/app');
  assert.equal(r.key, 'KEY-TWO');
  assert.equal(r.stationName, 'Studio 2');
  assert.equal(r.vertical, false);
  assert.match(logs.join('\n'), /streamtarget class=ci-1/);
  assert.match(logs.join('\n'), /16:9/);
  assert.ok(!logs.join('\n').includes('KEY-TWO'), 'stream key must never be logged');
});

test('streamTarget: no resolvable studio → plain-English error', async () => {
  const routes = { ...AUTH_OK, 'GET /content/items/': { json: ITEM('standard', []) } };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes), now: () => NOW });
  const r = await c.streamTarget({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no studio found for this class/i);
});

test('endBroadcast: discovers schedule+station from the class; posts stream/close', async () => {
  const calls = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(1, NOW - 60)]) },
    'POST /control-stations/st-1/stream/close': { status: 204, json: {} },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes, calls), now: () => NOW });
  const r = await c.endBroadcast({ contentItemGuid: 'ci-1' });
  assert.equal(r.ok, true);
  const close = calls.find(x => x.url.includes('/stream/close'));
  assert.deepEqual(close.opts.body, { scheduleGuid: 'sg-1' });
});

test('endBroadcast: pasted scheduleGuid pins the exact occurrence; nothing found → clear error', async () => {
  const calls = [];
  const routes = {
    ...AUTH_OK,
    'GET /content/items/': { json: ITEM('standard', [SCHED(1, NOW - 60), SCHED(2, NOW - 30)]) },
    'POST /control-stations/st-1/stream/close': { status: 200, json: { ok: true } },
  };
  const c = createPortalClient({ getConfig, transport: fakeTransport(routes, calls), now: () => NOW });
  const r = await c.endBroadcast({ contentItemGuid: 'ci-1', scheduleGuid: 'sg-1' });
  assert.equal(r.ok, true);
  assert.match(calls.find(x => x.url.includes('/stream/close')).url, /st-1/);

  const empty = createPortalClient({ getConfig, transport: fakeTransport({ ...AUTH_OK, 'GET /content/items/': { json: ITEM('standard', []) } }), now: () => NOW });
  const re = await empty.endBroadcast({ contentItemGuid: 'ci-1' });
  assert.equal(re.ok, false);
  assert.match(re.error, /no live broadcast was found to end/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/client.test.js`
Expected: FAIL — `Cannot find module '../portal/client'`.

- [ ] **Step 3: Implement `portal/client.js`**

```js
'use strict';
// The portal facade — a direct port of 1.x portal-helper.py's routes, running
// inside the app (no localhost server, no Python). One method per operation;
// each logs in fresh (the 1.x helper did the same — simple and stateless).
// LAW: the stream key is a credential — it must never reach log() or an error.
const { parseContentItem, pickOccurrence, matchOccurrence, isVertical } = require('./occurrences');
const { parseStations, stationIngest, stationSummaries } = require('./stations');

const API_BASE_DEFAULT = 'https://nestapi.echelonfit.com';
const TOKEN_KEYS = ['token', 'accessToken', 'access_token', 'idToken', 'id_token', 'jwt', 'authToken'];

function findToken(obj) {
  if (Array.isArray(obj)) { for (const v of obj) { const t = findToken(v); if (t) return t; } return null; }
  if (obj && typeof obj === 'object') {
    for (const k of TOKEN_KEYS) { const v = obj[k]; if (typeof v === 'string' && v.length > 20) return v; }
    for (const v of Object.values(obj)) { const t = findToken(v); if (t) return t; }
  }
  return null;
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function createPortalClient({ getConfig, transport, log = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  function config(overrides = {}) {
    const base = { apiBase: API_BASE_DEFAULT, apiKey: '', email: '', password: '', ...getConfig() };
    for (const k of ['email', 'password', 'apiKey', 'apiBase']) {
      if (overrides[k]) base[k] = overrides[k];
    }
    return base;
  }

  function authedHeaders(cfg, token) {
    const h = {};
    if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function login(cfg) {
    const r = await transport('POST', cfg.apiBase + '/auth',
      { headers: authedHeaders(cfg, null), body: { email: cfg.email, password: cfg.password } });
    log('login -> ' + r.status);
    if (r.status === 0 || r.status >= 400) {
      return { ok: false, error: 'The portal login failed — check the email and password in Setup.' };
    }
    return { ok: true, token: findToken(parseJson(r.text)) };   // no body token is OK: the cookie jar may carry the session
  }

  async function resolveOccurrences(cfg, token, contentItemGuid) {
    const r = await transport('GET', cfg.apiBase + '/content/items/' + contentItemGuid,
      { headers: authedHeaders(cfg, token) });
    if (r.status === 0 || r.status >= 400) {
      return { ok: false, error: 'The class could not be loaded from the portal — check the class link.' };
    }
    const parsed = parseJson(r.text);
    if (!parsed) return { ok: false, error: 'The portal sent back something unreadable for this class.' };
    return { ok: true, ...parseContentItem(parsed) };
  }

  function chooseOccurrence(occurrences, scheduleGuid) {
    return (scheduleGuid && matchOccurrence(occurrences, scheduleGuid)) || pickOccurrence(occurrences, now());
  }

  async function loadStations(cfg, token) {
    const r = await transport('GET', cfg.apiBase + '/control-stations?take=1000',
      { headers: authedHeaders(cfg, token) });
    if (r.status === 0 || r.status >= 400) {
      return { ok: false, error: 'The studios could not be loaded from the portal.' };
    }
    return { ok: true, stations: parseStations(parseJson(r.text)) };
  }

  return {
    async testLogin(overrides = {}) {
      const cfg = config(overrides);
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      const st = await loadStations(cfg, auth.token);
      if (!st.ok) return st;
      return { ok: true, stations: stationSummaries(st.stations) };
    },

    async checkClassLink({ contentItemGuid, scheduleGuid = '' }) {
      if (!contentItemGuid) return { ok: false, error: 'No class link was given.' };
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
      if (!res.ok) return res;
      const picked = chooseOccurrence(res.occurrences, scheduleGuid);
      return { ok: true, count: res.occurrences.length, picked, vertical: isVertical(res.medium), medium: res.medium };
    },

    async streamTarget({ contentItemGuid, scheduleGuid = '' }) {
      if (!contentItemGuid) return { ok: false, error: 'No class link was given.' };
      const cid = String(contentItemGuid).slice(0, 8);
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) { log('streamtarget class=' + cid + ' -> login failed'); return auth; }
      const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
      if (!res.ok) { log('streamtarget class=' + cid + ' -> ' + res.error); return res; }
      const picked = chooseOccurrence(res.occurrences, scheduleGuid);
      if (!picked || !picked.stationGuid) {
        log('streamtarget class=' + cid + ' -> no studio (occurrences=' + res.occurrences.length + ')');
        return { ok: false, error: 'No studio found for this class — check the class link.' };
      }
      const st = await loadStations(cfg, auth.token);
      if (!st.ok) { log('streamtarget class=' + cid + ' -> ' + st.error); return st; }
      const ingest = stationIngest(st.stations, picked.stationGuid);
      if (!ingest.ok) { log('streamtarget class=' + cid + ' station=' + picked.stationGuid.slice(0, 8) + ' -> ' + ingest.error); return ingest; }
      const vertical = isVertical(res.medium);
      // Station name + id only — NEVER the key.
      log('streamtarget class=' + cid + ' -> station "' + ingest.stationName + '" ' + picked.stationGuid + ' ' + (vertical ? '9:16' : '16:9') + ' (target delivered)');
      return { ok: true, server: ingest.server, key: ingest.key, stationName: ingest.stationName, vertical };
    },

    async endBroadcast({ contentItemGuid = '', scheduleGuid = '', stationGuid = '' }) {
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      let sg = scheduleGuid, st = stationGuid;
      if (contentItemGuid && (!sg || !st)) {
        const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
        if (!res.ok) return res;
        const picked = chooseOccurrence(res.occurrences, sg);
        if (picked) { sg = sg || picked.scheduleGuid; st = st || picked.stationGuid; }
      }
      if (!sg || !st) return { ok: false, error: 'No live broadcast was found to end for this class.' };
      const r = await transport('POST', cfg.apiBase + '/control-stations/' + st + '/stream/close',
        { headers: authedHeaders(cfg, auth.token), body: { scheduleGuid: sg } });
      log('end-broadcast station=' + st + ' schedule=' + sg + ' -> ' + r.status);
      return { ok: r.status > 0 && r.status < 400, status: r.status, detail: r.text.slice(0, 300) };
    },
  };
}

module.exports = { createPortalClient, findToken, API_BASE_DEFAULT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/client.test.js` — expected: 7 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 45 tests, 0 fail.
```bash
git add portal/client.js test/client.test.js
git commit -m "feat: portal client facade (login, class-link resolve, stream target, end broadcast)"
```

---

### Task 7: `scripts/portal-live-check.js` — read-only live verification (dev script)

**Files:**
- Create: `scripts/portal-live-check.js`

**Interfaces:**
- Consumes: `createPortalClient` + `createTransport`.
- Produces: `node scripts/portal-live-check.js <class link or guid>` — a DEV-ONLY, READ-ONLY probe of the real portal: borrows the 1.x helper's saved credentials from `~/Library/Application Support/StreamScheduler/portal.conf` when present (else `PORTAL_EMAIL`/`PORTAL_PASSWORD`/`PORTAL_API_KEY` env vars), runs `testLogin` → `checkClassLink` → `streamTarget`, and prints: station list count, picked occurrence (schedule + station ids), orientation, ingest server, and `stream key: present (<N> chars)` — **NEVER the key itself, never the password**. It calls no mutating endpoint (`endBroadcast` is NOT wired here). Exit 0 on full success.

- [ ] **Step 1: Write the script**

`scripts/portal-live-check.js`:
```js
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
```

- [ ] **Step 2: Syntax-check without hitting the network**

Run: `node --check scripts/portal-live-check.js` — expected: no output (parses clean).
Then: `node scripts/portal-live-check.js` with NO argument — expected: usage error, exit 2 (proves the guard paths without any portal call). Do NOT run it with a real class link — the controller does the one live run with real credentials.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` — expected 45 tests, 0 fail (script adds no tests).
```bash
git add scripts/portal-live-check.js
git commit -m "feat: read-only live portal probe (dev script, prints no secrets)"
```

---

## Definition of Done (Plan 2)

- `npm test` — 45 tests, 0 fail, offline (no real portal contact from tests).
- Controller-run live probe: `node scripts/portal-live-check.js <real class link>` → 3 PASS lines against the real portal (login, resolve incl. orientation, stream target with key present) — the Plan-2 equivalent of Plan 1's dress rehearsal.
- Everything committed; engine suites untouched and still green.

**What Plan 3 picks up:** the scheduler state machine + the ported UI, consuming `createPortalClient` (with `getConfig` reading the real settings + secret store), `probeFile`, and `Broadcast` — plus wiring Electron `safeStorage` into `createSecretStore` and the abort-if-no-target go-live law.
