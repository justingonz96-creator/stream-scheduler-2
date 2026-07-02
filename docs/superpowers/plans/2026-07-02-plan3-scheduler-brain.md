# Stream Scheduler 2.0 — Plan 3: Scheduler Brain + Electron Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless "brain" — a scheduler state machine that drives Plan 1's `Broadcast` engine and Plan 2's portal client through a real broadcast lifecycle (wait → resolve studio → go live → verified start → clean end / retry-once / resume-at-offset / weekly renewal) — plus the settings store, the `safeStorage` password codec, and the Electron IPC bridge. No UI in this plan (that is Plan 4); everything here is provable with `node --test` against injected fakes, then a controller-run rehearsal that drives the REAL engine.

**Architecture:** `schedule/model.js` = pure event helpers (defaults, timing math, weekly renewal). `schedule/scheduler.js` = the state machine — a factory taking injected `store`, `portal`, `engineFactory`, `settings`, `now`, `genId`, `log`, so tests run offline with a fake engine + fake portal and a controllable clock. `store/` gains the settings store, the schedule store, and the `safeStorage` codec (the injectable codec Plan 2's secret store was built to accept). `app/` gains a pure IPC handler map (unit-tested) plus the thin Electron wiring (main + preload) that registers it. The engine and portal are consumed exactly through their Plan 1/Plan 2 interfaces; nothing here reaches into their internals.

**Tech Stack:** Node 26 built-ins only for `schedule/*` and `store/*` (`node:test`, `node:fs`/`path`/`os`/`events`). `app/main.js` + `app/preload.js` use Electron (`app`, `BrowserWindow`, `ipcMain`, `ipcRenderer`, `contextBridge`, `safeStorage`) — these two files are not unit-tested (they are thin registration glue); their logic lives in the tested handler map and codec. Zero npm runtime dependencies.

**Reference (behavioral parity target):** `/Users/eleonard/Documents/Cluade/stream-scheduler/StreamScheduler.html` — the field-tested 1.x scheduler (`engineTick`, `startBroadcast`, `rollVideoInner`, `finishPlayback`, `renewWeekly`, `adoptInterrupted`, `applyStreamTarget`, `endPortalBroadcast`). Port its *decisions*, not its OBS mechanics: in 2.0 the `Broadcast` engine performs slate→music→fade→video as one encode and reports `playing`/`ended`/`failed`, so the scheduler no longer polls media states, manages scenes, mutes audio, or rolls the video as a separate step.

**Spec:** `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md` (§4 architecture, §5 engine, §6 portal, §7 storage).

## Global Constraints

- `schedule/*` and `store/*` run **without Electron**: `node:*` built-ins only, zero npm runtime deps. Only `app/main.js` and `app/preload.js` import Electron.
- Plain-English strings everywhere an operator can see them (outcomes, errors) — non-technical operators read them.
- **The stream key is a credential.** It is never persisted to `schedule.json`, never logged, never returned to the renderer. The scheduler resolves the ingest server+key fresh at go-live via `portal.streamTarget` and holds them only in memory for the life of that broadcast.
- **The portal password** is stored only via the injected secret store (OS keychain through `safeStorage`); never in `settings.json`, never in a repo, never logged. `settings.save` strips any `password`/`portalPassword` key defensively.
- **Verified-start law:** an event only reaches `preshow`/`playing` after the engine emits `playing` (its ≥0.5 s out_time gate). The scheduler never reports a broadcast as live, played, or "Played ✓" that the engine did not confirm.
- **Abort-if-no-target law:** if `portal.streamTarget` returns `{ok:false}`, the event fails with a plain-English reason and **no engine is spawned** — never stream to a wrong/last-used studio.
- **End-portal-before-stop law:** on operator stop, takeover, and auto-stop, call `portal.endBroadcast` for the event BEFORE killing the encode. On a clean natural end (the file finished, the encode already exited), end the portal broadcast promptly after.
- **Retry-once law:** if a broadcast fails before it was ever seen `playing`, spawn exactly one fresh engine (engine is one-shot); a second failure marks the event `failed`.
- **Resume-at-offset law:** if a broadcast drops after it was `playing` and the video's planned end has not passed, spawn a fresh engine with `resumeOffsetSec = broadcast.videoOffsetSec()`, `leadSec = 0`, no slate — up to `MAX_RESUMES` times.
- **Plan-2 binding — endBroadcast pairing:** always pass `endBroadcast` the event's OWN `{contentItemGuid, scheduleGuid}` (both from the one class link stored on the event) — never a schedule guid from one source paired with a station from another. This sidesteps the recorded 1.x stale-scheduleGuid quirk.
- **Plan-2 binding — getConfig contract:** the `getConfig` handed to the portal client is synchronous, total (never throws), and returns `{email, password, apiKey, apiBase}`; a blank `apiBase` is allowed (the client restores the default).
- **Plan-2 binding — never-throws is compositional:** the portal client only upholds never-throws given a no-throw transport and a total `getConfig`; wiring must inject Plan 2's `createTransport` and the total `buildPortalConfig`.
- Timing units are explicit: `fireAt` and `leadMs` and `doneAt` are epoch/duration **milliseconds**; `durationSec` and engine `leadSec`/`fadeSec`/`resumeOffsetSec` are **seconds**. Never mix.
- `GRACE_MS = 120000` (2 min late → missed). `MAX_RESUMES = 3`.
- `npm test` = `node --test` (self-discovery). Suite is 50/50 at the start of this plan — must stay green.
- Tests never touch the real portal, the network, or Electron. The one live-ish proof is the controller-run rehearsal (Task 6) driving the real engine into a local RTMP sink.

---

### Task 1: `store/settings.js` + `store/schedule-store.js` — settings, portal-config builder, schedule file

**Files:**
- Create: `store/settings.js`, `store/schedule-store.js`
- Test: `test/appstore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJsonAtomic` from `store/jsonstore.js` (Plan 2).
- Produces:
  - `store/settings.js`: `DEFAULT_SETTINGS` (object); `createSettingsStore({ file })` → `{ get(): settings, save(patch): settings }` — `get` returns `DEFAULT_SETTINGS` merged over file contents; `save` merges a patch (after deleting any `password`/`portalPassword` key), writes atomically, returns the merged result. `buildPortalConfig(settings, secrets)` → `{ email, password, apiKey, apiBase }` — total, never throws (`secrets.get` returns null → `''`).
  - `store/schedule-store.js`: `createScheduleStore({ file })` → `{ load(): array, save(events): void }` (`load` returns `[]` when the file is missing/corrupt).

- [ ] **Step 1: Write the failing tests**

`test/appstore.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULT_SETTINGS, createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');

function tmp(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-app-')), name); }

test('settings: get returns defaults, save merges and persists', () => {
  const file = tmp('settings.json');
  const s = createSettingsStore({ file });
  assert.deepEqual(s.get(), DEFAULT_SETTINGS);
  const merged = s.save({ videoBitrate: 4500, portalEmail: 'e@x.com' });
  assert.equal(merged.videoBitrate, 4500);
  assert.equal(merged.portalEmail, 'e@x.com');
  assert.equal(merged.fadeMs, DEFAULT_SETTINGS.fadeMs);          // untouched default preserved
  assert.equal(createSettingsStore({ file }).get().videoBitrate, 4500);   // persisted across instances
});

test('settings: save never writes a password into settings.json', () => {
  const file = tmp('settings.json');
  const s = createSettingsStore({ file });
  s.save({ portalEmail: 'e@x.com', password: 'nope', portalPassword: 'also-nope' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('nope'), 'no password may reach settings.json');
  assert.equal(s.get().password, undefined);
  assert.equal(s.get().portalPassword, undefined);
});

test('buildPortalConfig: total, maps settings + secret, blank apiBase allowed', () => {
  const settings = { portalEmail: 'e@x.com', portalApiKey: 'K', portalApiBase: '' };
  const secrets = { get: (k) => (k === 'portalPassword' ? 'pw' : null) };
  assert.deepEqual(buildPortalConfig(settings, secrets), { email: 'e@x.com', password: 'pw', apiKey: 'K', apiBase: '' });
  // missing everything → all empty strings, never throws
  assert.deepEqual(buildPortalConfig({}, { get: () => null }), { email: '', password: '', apiKey: '', apiBase: '' });
});

test('schedule store: load [] when absent, round-trips events', () => {
  const file = tmp('schedule.json');
  const st = createScheduleStore({ file });
  assert.deepEqual(st.load(), []);
  st.save([{ id: 'a', title: 'x' }]);
  assert.deepEqual(createScheduleStore({ file }).load(), [{ id: 'a', title: 'x' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/appstore.test.js`
Expected: FAIL — `Cannot find module '../store/settings'`.

- [ ] **Step 3: Implement**

`store/settings.js`:
```js
'use strict';
// App settings (spec §7): everything the operator configures EXCEPT the portal
// password, which lives in the OS keychain via the secret store. 1.x's OBS-only
// fields (port, OBS password, muteRoomAudio) are gone — 2.0 has no OBS.
const { readJson, writeJsonAtomic } = require('./jsonstore');

const DEFAULT_SETTINGS = {
  slateImage: '',        // path to the slate picture shown during the lead-in
  slateMusic: '',        // path to the looping MP3 played under the slate
  fadeMs: 1000,          // slate→video crossfade length (ms)
  videoBitrate: 6000,    // kbps
  portalEmail: '',
  portalApiKey: '',
  portalApiBase: '',     // blank ⇒ client uses its built-in default
};

function createSettingsStore({ file }) {
  return {
    get() { return { ...DEFAULT_SETTINGS, ...readJson(file, {}) }; },
    save(patch) {
      const clean = { ...patch };
      delete clean.password; delete clean.portalPassword;   // never persist a password here
      const merged = { ...DEFAULT_SETTINGS, ...readJson(file, {}), ...clean };
      writeJsonAtomic(file, merged);
      return merged;
    },
  };
}

// Total, never-throws (Plan-2 getConfig contract): the portal client restores
// the default when apiBase is blank.
function buildPortalConfig(settings, secrets) {
  return {
    email: settings.portalEmail || '',
    password: secrets.get('portalPassword') || '',
    apiKey: settings.portalApiKey || '',
    apiBase: settings.portalApiBase || '',
  };
}

module.exports = { DEFAULT_SETTINGS, createSettingsStore, buildPortalConfig };
```

`store/schedule-store.js`:
```js
'use strict';
// The schedule (list of events/weekly slots) as one atomic JSON file. The stream
// key is NEVER a field here — it is resolved fresh at go-live and held in memory.
const { readJson, writeJsonAtomic } = require('./jsonstore');

function createScheduleStore({ file }) {
  return {
    load() { const v = readJson(file, []); return Array.isArray(v) ? v : []; },
    save(events) { writeJsonAtomic(file, events); },
  };
}

module.exports = { createScheduleStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/appstore.test.js` — expected: 4 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 54 tests, 0 fail.
```bash
git add store/settings.js store/schedule-store.js test/appstore.test.js
git commit -m "feat: settings store, portal-config builder, schedule store"
```

---

### Task 2: `store/safe-codec.js` — the `safeStorage` codec for the secret store

**Files:**
- Create: `store/safe-codec.js`
- Test: `test/safe-codec.test.js`

**Interfaces:**
- Produces: `createSafeCodec(safeStorage)` → `{ encrypt(plaintext: string): Buffer, decrypt(blob: Buffer): string }` — the exact codec shape Plan 2's `createSecretStore({ file, encrypt, decrypt })` consumes. `safeStorage` is injected (Electron's module in the app; a fake in tests). `encrypt` throws a plain-English Error when `safeStorage.isEncryptionAvailable()` is false (the caller — the IPC `secret:setPassword` handler — turns that into `{ok:false, error}`). `decrypt` delegates to `safeStorage.decryptString`.

- [ ] **Step 1: Write the failing tests**

`test/safe-codec.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createSafeCodec } = require('../store/safe-codec');

// Fake Electron safeStorage: reversible, availability-toggleable.
function fakeSafe(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('SS:' + s, 'utf8'),
    decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith('SS:')) throw new Error('bad'); return t.slice(3); },
  };
}

test('round-trips through the fake safeStorage', () => {
  const codec = createSafeCodec(fakeSafe(true));
  const blob = codec.encrypt('hunter2');
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(codec.decrypt(blob), 'hunter2');
});

test('encrypt throws plain-English when encryption is unavailable', () => {
  const codec = createSafeCodec(fakeSafe(false));
  assert.throws(() => codec.encrypt('x'), /secure storage is not available/i);
});

test('composes with the secret store as its injected codec', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { createSecretStore } = require('../store/secrets');
  const codec = createSafeCodec(fakeSafe(true));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-codec-')), 'secrets.json');
  const store = createSecretStore({ file, ...codec });
  store.set('portalPassword', 's3cret');
  assert.equal(store.get('portalPassword'), 's3cret');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('s3cret'), 'plaintext must not hit disk');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/safe-codec.test.js`
Expected: FAIL — `Cannot find module '../store/safe-codec'`.

- [ ] **Step 3: Implement `store/safe-codec.js`**

```js
'use strict';
// Bridges Electron's safeStorage (OS keychain / DPAPI) to the {encrypt, decrypt}
// codec Plan 2's secret store accepts. safeStorage is injected so this file stays
// Electron-free and testable; app/main.js passes the real module.
function createSafeCodec(safeStorage) {
  return {
    encrypt(plaintext) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('This computer’s secure storage is not available, so the password can’t be saved safely.');
      }
      return safeStorage.encryptString(String(plaintext));   // Buffer
    },
    decrypt(blob) {
      return safeStorage.decryptString(blob);                // string; secret store catches any throw → null
    },
  };
}

module.exports = { createSafeCodec };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/safe-codec.test.js` — expected: 3 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 57 tests, 0 fail.
```bash
git add store/safe-codec.js test/safe-codec.test.js
git commit -m "feat: safeStorage codec for the secret store (injectable, Electron-free)"
```

---

### Task 3: `schedule/model.js` — pure event helpers

**Files:**
- Create: `schedule/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Produces (pure, no I/O):
  - `GRACE_MS = 120000`, `MAX_RESUMES = 3`.
  - `normalizeEvent(e): event` — fills defaults over `e` (see code for the full shape).
  - `streamAtOf(ev): number` = `ev.fireAt - (ev.leadMs || 0)`.
  - `computeLeadSec(ev, nowMs): number` = `max(0, round((ev.fireAt - nowMs) / 1000))`.
  - `plannedVideoEndAtMs(ev): number` = `ev.fireAt + (ev.durationSec || 0) * 1000`.
  - `joinRtmpUrl(server, key): string` = server with trailing slashes trimmed + `'/'` + key.
  - `renewWeekly(ev, nowMs, genId): event|null` — `null` unless `ev.repeatWeekly`; else a fresh pending, `needsVideo:true` slot 7+ days out (past `nowMs + 60000`), carrying `slotId`, `title`, `autoStop`, `leadMs`. `genId()` supplies the id (injected for determinism).

- [ ] **Step 1: Write the failing tests**

`test/model.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
} = require('../schedule/model');

test('constants', () => { assert.equal(GRACE_MS, 120000); assert.equal(MAX_RESUMES, 3); });

test('normalizeEvent fills the full default shape and keeps given fields', () => {
  const ev = normalizeEvent({ id: 'x', fireAt: 1000, title: 'Yoga' });
  assert.equal(ev.id, 'x'); assert.equal(ev.fireAt, 1000); assert.equal(ev.title, 'Yoga');
  assert.equal(ev.status, 'pending'); assert.equal(ev.autoStop, true);
  assert.equal(ev.leadMs, 0); assert.equal(ev.durationSec, 0); assert.equal(ev.vertical, false);
  assert.equal(ev.needsVideo, false); assert.equal(ev.repeatWeekly, false);
  assert.equal(ev.contentItemGuid, ''); assert.equal(ev.scheduleGuid, '');
  assert.ok(!('streamKey' in ev), 'the stream key is never a persisted field');
});

test('streamAtOf / computeLeadSec / plannedVideoEndAtMs', () => {
  const ev = normalizeEvent({ fireAt: 100000, leadMs: 30000, durationSec: 600 });
  assert.equal(streamAtOf(ev), 70000);
  assert.equal(computeLeadSec(ev, 70000), 30);          // full lead when on time
  assert.equal(computeLeadSec(ev, 95000), 5);           // shortened when late-ish
  assert.equal(computeLeadSec(ev, 100000), 0);          // at/after fireAt ⇒ no slate
  assert.equal(computeLeadSec(ev, 200000), 0);
  assert.equal(plannedVideoEndAtMs(ev), 100000 + 600000);
});

test('joinRtmpUrl trims trailing slashes then appends the key', () => {
  assert.equal(joinRtmpUrl('rtmps://global-live.mux.com:443/app', 'KEY'), 'rtmps://global-live.mux.com:443/app/KEY');
  assert.equal(joinRtmpUrl('rtmps://h/app/', 'KEY'), 'rtmps://h/app/KEY');
});

test('renewWeekly: null unless repeatWeekly; else fresh empty slot 7d+ out', () => {
  assert.equal(renewWeekly(normalizeEvent({ repeatWeekly: false, fireAt: 1000 }), 2000, () => 'id'), null);
  const base = normalizeEvent({ id: 'orig', fireAt: 1_000_000, leadMs: 30000, title: 'Ride', repeatWeekly: true, autoStop: true });
  const nv = renewWeekly(base, 1_000_000, () => 'NEW');
  assert.equal(nv.id, 'NEW'); assert.equal(nv.slotId, 'orig'); assert.equal(nv.title, 'Ride');
  assert.equal(nv.repeatWeekly, true); assert.equal(nv.needsVideo, true); assert.equal(nv.status, 'pending');
  assert.equal(nv.leadMs, 30000); assert.equal(nv.fileName, ''); assert.equal(nv.filePath, '');
  assert.equal(nv.fireAt, 1_000_000 + 7 * 86400000);
});

test('renewWeekly skips weeks already in the past relative to now', () => {
  const base = normalizeEvent({ id: 'o', slotId: 'slot', fireAt: 1000, repeatWeekly: true });
  const nowMs = 1000 + 3 * 7 * 86400000;   // 3 weeks later
  const nv = renewWeekly(base, nowMs, () => 'N');
  assert.ok(nv.fireAt > nowMs + 60000, 'next occurrence is safely in the future');
  assert.equal((nv.fireAt - 1000) % (7 * 86400000), 0, 'still aligned to the weekly cadence');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: FAIL — `Cannot find module '../schedule/model'`.

- [ ] **Step 3: Implement `schedule/model.js`**

```js
'use strict';
// Pure helpers for the scheduler: the event shape and the timing math. No I/O,
// no clock of its own (callers pass nowMs), no id source of its own (callers pass
// genId) — so every function is deterministic and trivially testable.

const GRACE_MS = 2 * 60 * 1000;   // start up to 2 min late, otherwise "missed"
const MAX_RESUMES = 3;            // cap reconnect-and-resume attempts per broadcast

function normalizeEvent(e) {
  return Object.assign({
    id: '', slotId: '', title: '',
    fileName: '', filePath: '', durationSec: 0, vertical: false,
    contentItemGuid: '', scheduleGuid: '',
    fireAt: 0, leadMs: 0, autoStop: true, repeatWeekly: false, needsVideo: false,
    status: 'pending', outcome: '', doneAt: 0,
  }, e);
}

function streamAtOf(ev) { return ev.fireAt - (ev.leadMs || 0); }

function computeLeadSec(ev, nowMs) { return Math.max(0, Math.round((ev.fireAt - nowMs) / 1000)); }

function plannedVideoEndAtMs(ev) { return ev.fireAt + (ev.durationSec || 0) * 1000; }

function joinRtmpUrl(server, key) { return String(server).replace(/\/+$/, '') + '/' + key; }

function renewWeekly(ev, nowMs, genId) {
  if (!ev.repeatWeekly) return null;
  const WEEK = 7 * 86400000;
  let next = ev.fireAt;
  do { next += WEEK; } while (next <= nowMs + 60000);
  return normalizeEvent({
    id: genId(), slotId: ev.slotId || ev.id, title: ev.title,
    autoStop: ev.autoStop, leadMs: ev.leadMs,
    repeatWeekly: true, needsVideo: true,
    fireAt: next, status: 'pending',
  });
}

module.exports = {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js` — expected: 6 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 63 tests, 0 fail.
```bash
git add schedule/model.js test/model.test.js
git commit -m "feat: pure scheduler model — event shape, timing math, weekly renewal"
```

---

### Task 4: `schedule/scheduler.js` — the state machine

This is the centerpiece. It consumes the model (Task 3), the portal client (Plan 2), and the engine (Plan 1) — all injected — and enforces every law in Global Constraints. Read them before implementing.

**Files:**
- Create: `schedule/scheduler.js`
- Test: `test/scheduler.test.js`

**Interfaces:**
- Consumes:
  - `store`: `{ load(): event[], save(events): void }` (Task 1's schedule store, or a fake).
  - `portal`: `{ streamTarget({contentItemGuid, scheduleGuid}): Promise<{ok, server, key, stationName, vertical}|{ok:false,error}>, endBroadcast({contentItemGuid, scheduleGuid}): Promise<{ok,...}> }` (Plan 2 client).
  - `engineFactory(opts): Broadcast` — `opts` is exactly Plan 1's `Broadcast` options `{videoPath, vertical, bitrateKbps, fps, leadSec, fadeSec, slateImage, slateMusic, resumeOffsetSec, outUrl}`. The returned object is an EventEmitter with `start()`, `stop()`, `videoOffsetSec(): number`, emitting `playing`, `ended`, `failed({reason})`.
  - `settings`: `{ get(): {slateImage, slateMusic, fadeMs, videoBitrate, ...} }` (Task 1).
  - `now(): number` (ms, injectable), `genId(): string` (injectable), `log(msg): void` (optional).
- Produces: `createScheduler(deps)` → `{ tick(), start(), stop(), getEvents(): event[], addEvent(ev): event, removeEvent(id): {ok, error?}, stopActive(id): Promise<{ok, error?}>, onChanged(fn): unsubscribe }`. On construction it loads + normalizes stored events and calls internal recovery (any event left mid-broadcast by a crash → `missed`, then weekly-renewed). `tick()` is idempotent and safe to call every second.

- [ ] **Step 1: Write the failing tests**

`test/scheduler.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createScheduler } = require('../schedule/scheduler');
const { normalizeEvent } = require('../schedule/model');

// ---- fakes ----
function memStore(initial = []) {
  let data = initial.map((e) => ({ ...e }));
  return { load: () => data.map((e) => ({ ...e })), save: (evs) => { data = evs.map((e) => ({ ...e })); }, _last: () => data };
}
function fakeEngine(offset = 5) {
  const e = new EventEmitter();
  e.started = false; e.stopped = false;
  e.start = () => { e.started = true; };
  e.stop = () => { e.stopped = true; };
  e.videoOffsetSec = () => offset;
  return e;
}
function harness({ events = [], target = { ok: true, server: 'rtmps://h/app', key: 'KEY', stationName: 'S', vertical: false }, offset = 5 } = {}) {
  const spawned = [];
  const ended = [];
  const order = [];   // records 'end' (portal) and 'stop' (engine) call ordering
  const engineFactory = (opts) => {
    const e = fakeEngine(offset); e.opts = opts;
    const origStop = e.stop; e.stop = () => { order.push('stop'); origStop(); };
    spawned.push(e); return e;
  };
  const portal = {
    streamTarget: async () => (typeof target === 'function' ? target() : target),
    endBroadcast: async (a) => { ended.push(a); order.push('end'); return { ok: true }; },
  };
  const settings = { get: () => ({ slateImage: 'slate.png', slateMusic: 'm.mp3', fadeMs: 1000, videoBitrate: 6000 }) };
  let clock = 0;
  let idc = 0;
  const sched = createScheduler({
    store: memStore(events), portal, engineFactory, settings,
    now: () => clock, genId: () => 'gen' + (idc++), log: () => {},
  });
  return { sched, spawned, ended, order, setClock: (t) => { clock = t; }, getClock: () => clock };
}
const liveEvent = (over = {}) => normalizeEvent(Object.assign({
  id: 'e1', filePath: '/v.mp4', durationSec: 600, contentItemGuid: 'ci', scheduleGuid: 'sg',
  fireAt: 100000, leadMs: 30000, autoStop: true, status: 'pending',
}, over));

test('go-live: resolves target, spawns one engine with the right options; verified-start gates status', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000);                 // == streamAt (fireAt 100000 − lead 30000)
  await h.sched.tick();
  assert.equal(h.spawned.length, 1);
  const opts = h.spawned[0].opts;
  assert.equal(opts.videoPath, '/v.mp4');
  assert.equal(opts.leadSec, 30);            // full lead
  assert.equal(opts.fadeSec, 1);
  assert.equal(opts.slateImage, 'slate.png');
  assert.equal(opts.outUrl, 'rtmps://h/app/KEY');
  assert.equal(h.sched.getEvents()[0].status, 'starting');   // not yet 'playing' — engine hasn't confirmed
  h.spawned[0].emit('playing');
  assert.equal(h.sched.getEvents()[0].status, 'preshow');    // playing before fireAt ⇒ slate is up
  h.setClock(100000); await h.sched.tick();
  assert.equal(h.sched.getEvents()[0].status, 'playing');    // fireAt reached ⇒ video label
});

test('abort-if-no-target: streamTarget fails ⇒ event failed, NO engine spawned', async () => {
  const h = harness({ events: [liveEvent()], target: { ok: false, error: 'No studio found for this class — check the class link.' } });
  h.setClock(70000);
  await h.sched.tick();
  assert.equal(h.spawned.length, 0, 'must not spawn an engine without a target');
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.outcome, /No studio found/);
});

test('no-slate path when starting at/after fireAt: leadSec 0 and slate fields blank', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(100000);               // exactly fireAt — late enough that lead is gone
  await h.sched.tick();
  assert.equal(h.spawned[0].opts.leadSec, 0);
  assert.equal(h.spawned[0].opts.slateImage, '');
  assert.equal(h.spawned[0].opts.slateMusic, '');
});

test('clean end with autoStop: ends portal, marks Played ✓ done', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));    // let the async end handler run
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'done');
  assert.match(ev.outcome, /Played ✓/);
  assert.deepEqual(h.ended[0], { contentItemGuid: 'ci', scheduleGuid: 'sg' });   // event's OWN pair
});

test('clean end with autoStop OFF: video done but portal left open, not ended', async () => {
  const h = harness({ events: [liveEvent({ autoStop: false })] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sched.getEvents()[0].status, 'done');
  assert.equal(h.ended.length, 0, 'portal broadcast is NOT auto-ended when autoStop is off');
});

test('retry-once: a start failure spawns exactly one fresh engine; a second failure fails the event', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'ffmpeg exited' });   // never saw 'playing'
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'one automatic retry');
  assert.equal(h.sched.getEvents()[0].status, 'starting');
  h.spawned[1].emit('failed', { reason: 'again' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'no second retry');
  assert.equal(h.sched.getEvents()[0].status, 'failed');
});

test('resume-at-offset: a drop after playing respawns with resumeOffsetSec and no slate', async () => {
  const h = harness({ events: [liveEvent()], offset: 42 });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.setClock(150000);                              // mid-video, well before planned end (700000)
  h.spawned[0].emit('failed', { reason: 'network blip' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 42);
  assert.equal(h.spawned[1].opts.leadSec, 0);
  assert.equal(h.spawned[1].opts.slateImage, '');
});

test('resume respects MAX_RESUMES then fails cleanly', async () => {
  const h = harness({ events: [liveEvent()], offset: 10 });
  h.setClock(70000); await h.sched.tick();
  h.setClock(150000);
  // 1 initial + 3 resumes = 4 engines, then the 4th failure gives up
  for (let i = 0; i < 4; i++) { h.spawned[i].emit('playing'); h.spawned[i].emit('failed', { reason: 'drop' }); await new Promise((r) => setImmediate(r)); }
  assert.equal(h.spawned.length, 4, '1 original + MAX_RESUMES(3)');
  assert.equal(h.sched.getEvents()[0].status, 'failed');
});

test('missed: past the grace window ⇒ missed (never spawns)', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(100000 + 120000 + 1);       // fireAt + GRACE + 1ms
  await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.sched.getEvents()[0].status, 'missed');
});

test('needsVideo weekly slot never goes live', async () => {
  const h = harness({ events: [liveEvent({ needsVideo: true, filePath: '' })] });
  h.setClock(70000); await h.sched.tick();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.sched.getEvents()[0].status, 'pending');   // still waiting; not missed yet
});

test('weekly renewal: a completed repeating event seeds next week exactly once', async () => {
  const h = harness({ events: [liveEvent({ repeatWeekly: true })] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing'); h.spawned[0].emit('ended');
  await new Promise((r) => setImmediate(r));
  const evs = h.sched.getEvents();
  const pend = evs.filter((e) => e.status === 'pending');
  assert.equal(pend.length, 1, 'exactly one renewed slot');
  assert.equal(pend[0].needsVideo, true);
  assert.equal(pend[0].fireAt, 100000 + 7 * 86400000);
});

test('operator stop: ends portal BEFORE stopping the engine, marks stopped', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  const res = await h.sched.stopActive('e1');
  assert.equal(res.ok, true);
  assert.deepEqual(h.order, ['end', 'stop'], 'portal end must precede engine stop (end-portal-before-stop law)');
  assert.equal(h.spawned[0].stopped, true, 'engine stopped');
  assert.equal(h.sched.getEvents()[0].status, 'done');
  assert.match(h.sched.getEvents()[0].outcome, /Stopped by the operator/);
});

test('takeover: a new event at its time ends the previous one early', async () => {
  const a = liveEvent({ id: 'A', fireAt: 100000, leadMs: 30000 });
  const b = liveEvent({ id: 'B', fireAt: 160000, leadMs: 0, contentItemGuid: 'ci2', scheduleGuid: 'sg2' });
  const h = harness({ events: [a, b] });
  h.setClock(70000); await h.sched.tick();          // A goes live
  h.spawned[0].emit('playing');
  h.setClock(160000); await h.sched.tick();          // B's moment — takeover
  await new Promise((r) => setImmediate(r));
  const evA = h.sched.getEvents().find((e) => e.id === 'A');
  assert.equal(evA.status, 'done');
  assert.match(evA.outcome, /Ended early/);
  assert.equal(h.spawned[0].stopped, true);
  assert.equal(h.spawned.length, 2, 'B spawned its own engine');
});

test('crash recovery: an event left mid-broadcast on load becomes missed (+renew)', () => {
  const h = harness({ events: [liveEvent({ status: 'playing', repeatWeekly: true })] });
  const evs = h.sched.getEvents();
  const orig = evs.find((e) => e.id === 'e1');
  assert.equal(orig.status, 'missed');
  assert.match(orig.outcome, /Interrupted/);
  assert.equal(evs.filter((e) => e.status === 'pending').length, 1, 'renewed once');
});

test('addEvent normalizes + persists; removeEvent refuses the live event', async () => {
  const h = harness({ events: [] });
  const ev = h.sched.addEvent({ title: 'New', fireAt: 5, filePath: '/x.mp4', durationSec: 1, contentItemGuid: 'ci', scheduleGuid: 'sg' });
  assert.equal(ev.status, 'pending'); assert.ok(ev.id);
  h.setClock(5); await h.sched.tick();
  h.spawned[0].emit('playing');
  const r = h.sched.removeEvent(ev.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /Stop the live broadcast/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scheduler.test.js`
Expected: FAIL — `Cannot find module '../schedule/scheduler'`.

- [ ] **Step 3: Implement `schedule/scheduler.js`**

```js
'use strict';
// The scheduler brain. Ports the DECISIONS of 1.x's engineTick/startBroadcast/
// finishPlayback/renewWeekly/adoptInterrupted, but the engine (Plan 1) now does
// slate→music→fade→video as one encode and reports playing/ended/failed — so no
// media-state polling, scenes, or audio muting live here. Every dependency is
// injected; with fakes this whole file runs offline under node:test.
const {
  GRACE_MS, MAX_RESUMES, normalizeEvent, streamAtOf, computeLeadSec,
  plannedVideoEndAtMs, joinRtmpUrl, renewWeekly,
} = require('./model');

function createScheduler({ store, portal, engineFactory, settings, now = () => Date.now(), genId, log = () => {} }) {
  let events = store.load().map(normalizeEvent);
  let active = null;      // { eventId, broadcast, target, sawPlaying, retried, resumeCount }
  let busy = false;       // one go-live / takeover / stop orchestration at a time
  let timer = null;
  const listeners = new Set();

  const emit = () => { const snap = getEvents(); for (const fn of listeners) { try { fn(snap); } catch {} } };
  const persist = () => { store.save(events); emit(); };
  const byId = (id) => events.find((e) => e.id === id) || null;
  function getEvents() { return events.map((e) => ({ ...e })); }

  // ----- crash recovery: a live ffmpeg cannot survive an app restart -----
  for (const ev of events) {
    if (['starting', 'preshow', 'playing'].includes(ev.status)) {
      ev.status = 'missed';
      ev.outcome = 'Interrupted — the app was closed during the broadcast';
      ev.doneAt = now();
      renew(ev);
    }
  }
  store.save(events);   // no emit yet (no listeners at construction)

  function renew(ev) {
    const slot = ev.slotId || ev.id;
    if (events.some((e) => e.status === 'pending' && (e.slotId || e.id) === slot)) return;   // already renewed
    const nv = renewWeekly(ev, now(), genId);
    if (nv) events.push(nv);
  }

  function markMissed(ev) {
    ev.status = 'missed';
    ev.outcome = ev.needsVideo ? 'Missed — no video was chosen for this week'
                               : 'Missed — this window was not open at start time';
    ev.doneAt = now();
    renew(ev);
    persist();
  }

  function fail(ev, reason) {
    ev.status = 'failed';
    ev.outcome = 'Could not start: ' + reason;
    ev.doneAt = now();
    renew(ev);
    persist();
  }

  async function endPortal(ev) {
    if (!ev || (!ev.contentItemGuid && !ev.scheduleGuid)) return;   // no class link → nothing to end
    try {
      const r = await portal.endBroadcast({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid });
      log('portal end -> ' + (r && r.ok ? 'ok' : ('not confirmed: ' + ((r && (r.error || r.status)) || '?'))));
    } catch (e) { log('portal end error: ' + (e && e.message)); }
  }

  function spawn(ev, { leadSec, resumeOffsetSec, target, retried, resumeCount }) {
    const s = settings.get();
    const useSlate = leadSec > 0;
    const bc = engineFactory({
      videoPath: ev.filePath,
      vertical: !!target.vertical,
      bitrateKbps: s.videoBitrate,
      fps: 30,
      leadSec,
      fadeSec: (s.fadeMs || 0) / 1000,
      slateImage: useSlate ? s.slateImage : '',
      slateMusic: useSlate ? s.slateMusic : '',
      resumeOffsetSec,
      outUrl: joinRtmpUrl(target.server, target.key),
    });
    active = { eventId: ev.id, broadcast: bc, target, sawPlaying: false, retried, resumeCount };
    bc.on('playing', () => onPlaying(ev.id));
    bc.on('ended', () => { onEnded(ev.id); });
    bc.on('failed', (info) => { onFailed(ev.id, (info && info.reason) || 'unknown'); });
    try { bc.start(); }
    catch (e) { onFailed(ev.id, (e && e.message) || 'the video engine could not start'); }
  }

  function onPlaying(id) {
    if (!active || active.eventId !== id) return;
    active.sawPlaying = true;
    const ev = byId(id); if (!ev) return;
    ev.status = now() >= ev.fireAt ? 'playing' : 'preshow';
    persist();
  }

  async function onEnded(id) {
    if (!active || active.eventId !== id) return;
    const ev = byId(id); const target = active.target; active = null;
    if (!ev) return;
    if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
    else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
    ev.status = 'done'; ev.doneAt = now();
    renew(ev); persist();
    void target;
  }

  async function onFailed(id, reason) {
    if (!active || active.eventId !== id) return;
    const ev = byId(id); if (!ev) { active = null; return; }
    const { sawPlaying, retried, resumeCount, target, broadcast } = active;

    if (!sawPlaying) {
      // never went live → retry exactly once
      active = null;
      if (!retried) {
        log('start failed, retrying once: ' + reason);
        spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: true, resumeCount });
      } else {
        fail(ev, reason);
      }
      return;
    }

    // was live → resume at offset, unless we're basically done or out of tries
    const offset = typeof broadcast.videoOffsetSec === 'function' ? broadcast.videoOffsetSec() : 0;
    active = null;
    if (now() >= plannedVideoEndAtMs(ev) - 1500) {
      // effectively finished — treat as a clean play
      if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
      else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
      ev.status = 'done'; ev.doneAt = now(); renew(ev); persist();
      return;
    }
    if (resumeCount >= MAX_RESUMES) {
      await endPortal(ev);
      ev.status = 'failed'; ev.outcome = 'The stream kept dropping and could not be recovered';
      ev.doneAt = now(); renew(ev); persist();
      return;
    }
    log('stream dropped, resuming at ' + offset + 's');
    spawn(ev, { leadSec: 0, resumeOffsetSec: offset, target, retried: true, resumeCount: resumeCount + 1 });
  }

  async function takeover(prev) {
    prev.status = 'done';
    prev.outcome = 'Ended early — the next scheduled video started';
    prev.doneAt = now();
    const bc = active && active.broadcast;
    if (prev.autoStop) await endPortal(prev);
    active = null;
    try { if (bc) bc.stop(); } catch {}
    renew(prev);
    persist();
  }

  async function goLive(ev) {
    ev.status = 'starting'; persist();
    log('starting broadcast: ' + (ev.title || ev.fileName || ev.id));
    const target = await portal.streamTarget({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid });
    if (!target || !target.ok) { fail(ev, (target && target.error) || 'no studio was returned by the portal'); return; }
    spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: false, resumeCount: 0 });
  }

  async function tick() {
    const t = now();
    for (const ev of events) {
      if (ev.status !== 'pending') continue;
      if (t < streamAtOf(ev)) continue;
      if (t - ev.fireAt > GRACE_MS) { markMissed(ev); continue; }
      if (ev.needsVideo) continue;             // a weekly slot with no video never goes live
      if (busy) continue;
      if (active) {
        const cur = byId(active.eventId);
        if (cur && cur.id !== ev.id && ['starting', 'preshow', 'playing'].includes(cur.status)) {
          busy = true;
          try { await takeover(cur); await goLive(ev); } finally { busy = false; }
        }
        continue;
      }
      busy = true;
      try { await goLive(ev); } finally { busy = false; }
    }
    // slate→video label flip (the engine already faded on its own at fireAt)
    if (active) {
      const cur = byId(active.eventId);
      if (cur && cur.status === 'preshow' && t >= cur.fireAt) { cur.status = 'playing'; persist(); }
    }
  }

  function addEvent(ev) {
    const norm = normalizeEvent({ ...ev, id: ev.id || genId() });
    events.push(norm); persist();
    return { ...norm };
  }

  function removeEvent(id) {
    if (active && active.eventId === id) return { ok: false, error: 'Stop the live broadcast before removing it.' };
    const before = events.length;
    events = events.filter((e) => e.id !== id);
    if (events.length === before) return { ok: false, error: 'That broadcast was not found.' };
    persist();
    return { ok: true };
  }

  async function stopActive(id) {
    if (!active || active.eventId !== id) return { ok: false, error: 'That broadcast is not currently live.' };
    if (busy) return { ok: false, error: 'The scheduler is busy — try again in a moment.' };
    busy = true;
    try {
      const ev = byId(id); const bc = active.broadcast; active = null;
      await endPortal(ev);                 // end-portal-before-stop
      try { bc.stop(); } catch {}
      if (ev) { ev.status = 'done'; ev.outcome = 'Stopped by the operator'; ev.doneAt = now(); renew(ev); }
      persist();
      return { ok: true };
    } finally { busy = false; }
  }

  function onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function start() { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, 1000); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop, getEvents, addEvent, removeEvent, stopActive, onChanged };
}

module.exports = { createScheduler };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scheduler.test.js` — expected: 15 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 78 tests, 0 fail.
```bash
git add schedule/scheduler.js test/scheduler.test.js
git commit -m "feat: scheduler state machine — go-live, verified start, retry/resume, weekly renewal, laws"
```

#### Task 4 — review-mandated amendments (apply after Step 5)

The whole-branch-grade review of this task found four reachable, plan-mandated defects. The fixes are all local to `schedule/scheduler.js` (+ harness/tests). Replace the named functions with the versions below and add a `redactSecrets` helper + the new tests. Then `npm test` → 83 tests, 0 fail.

**(a) `redactSecrets` helper** — add inside the factory (near `endPortal`):
```js
  // The engine's failure reason can embed ffmpeg stderr, which on a connection
  // error prints the full output URL — INCLUDING the stream key. Scrub it before
  // anything reaches a log line or the persisted outcome (key-secrecy law).
  function redactSecrets(text, target) {
    let s = String(text == null ? '' : text);
    if (target) {
      if (target.server && target.key) { const u = joinRtmpUrl(target.server, target.key); if (u) s = s.split(u).join('***'); }
      if (target.key) s = s.split(target.key).join('***');
    }
    return s;
  }
```

**(b) `spawn`** — capture the instance in the listeners; guard the floating async handlers; wrap the sync one:
```js
  function spawn(ev, { leadSec, resumeOffsetSec, target, retried, resumeCount }) {
    const s = settings.get();
    const useSlate = leadSec > 0;
    const bc = engineFactory({
      videoPath: ev.filePath, vertical: !!target.vertical, bitrateKbps: s.videoBitrate, fps: 30,
      leadSec, fadeSec: (s.fadeMs || 0) / 1000,
      slateImage: useSlate ? s.slateImage : '', slateMusic: useSlate ? s.slateMusic : '',
      resumeOffsetSec, outUrl: joinRtmpUrl(target.server, target.key),
    });
    active = { eventId: ev.id, broadcast: bc, target, sawPlaying: false, retried, resumeCount };
    bc.on('playing', () => { try { onPlaying(ev.id, bc); } catch (e) { log('playing handler error: ' + ((e && e.message) || e)); } });
    bc.on('ended', () => { onEnded(ev.id, bc).catch((e) => log('ended handler error: ' + ((e && e.message) || e))); });
    bc.on('failed', (info) => { onFailed(ev.id, (info && info.reason) || 'unknown', bc).catch((e) => log('failed handler error: ' + ((e && e.message) || e))); });
    try { bc.start(); }
    catch (e) { onFailed(ev.id, (e && e.message) || 'the video engine could not start', bc).catch(() => {}); }
  }
```

**(c) `onPlaying` / `onEnded` / `onFailed`** — add the `bc` param and the `active.broadcast !== bc` instance guard; redact reasons:
```js
  function onPlaying(id, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    active.sawPlaying = true;
    const ev = byId(id); if (!ev) return;
    ev.status = now() >= ev.fireAt ? 'playing' : 'preshow';
    persist();
  }

  async function onEnded(id, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    const ev = byId(id); active = null;
    if (!ev) return;
    if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
    else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
    ev.status = 'done'; ev.doneAt = now();
    renew(ev); persist();
  }

  async function onFailed(id, reason, bc) {
    if (!active || active.eventId !== id || active.broadcast !== bc) return;
    const ev = byId(id); if (!ev) { active = null; return; }
    const { sawPlaying, retried, resumeCount, target, broadcast } = active;
    const safeReason = redactSecrets(reason, target);
    if (!sawPlaying) {
      active = null;
      if (!retried) {
        log('start failed, retrying once: ' + safeReason);
        spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: true, resumeCount });
      } else { fail(ev, safeReason); }
      return;
    }
    const offset = typeof broadcast.videoOffsetSec === 'function' ? broadcast.videoOffsetSec() : 0;
    active = null;
    if (now() >= plannedVideoEndAtMs(ev) - 1500) {
      if (ev.autoStop) { await endPortal(ev); ev.outcome = 'Played ✓ and the stream ended'; }
      else { ev.outcome = 'Played ✓ — video finished (portal broadcast left open, as requested)'; }
      ev.status = 'done'; ev.doneAt = now(); renew(ev); persist();
      return;
    }
    if (resumeCount >= MAX_RESUMES) {
      await endPortal(ev);
      ev.status = 'failed'; ev.outcome = 'The stream kept dropping and could not be recovered';
      ev.doneAt = now(); renew(ev); persist();
      return;
    }
    log('stream dropped, resuming at ' + offset + 's');
    spawn(ev, { leadSec: 0, resumeOffsetSec: offset, target, retried: true, resumeCount: resumeCount + 1 });
  }
```

**(d) `takeover`** — unlink `active` BEFORE the awaited portal call (kills the orphan race), keeping end-portal-before-stop:
```js
  async function takeover(prev) {
    const bc = active && active.broadcast;
    active = null;                                 // unlink FIRST — a late event from the outgoing engine can't resume-spawn
    prev.status = 'done';
    prev.outcome = 'Ended early — the next scheduled video started';
    prev.doneAt = now();
    if (prev.autoStop) await endPortal(prev);      // end-portal-before-stop
    try { if (bc) bc.stop(); } catch {}
    renew(prev); persist();
  }
```

**(e) `goLive`** — guard a `streamTarget` rejection so a client bug can't strand the event at `starting`:
```js
  async function goLive(ev) {
    ev.status = 'starting'; persist();
    log('starting broadcast: ' + (ev.title || ev.fileName || ev.id));
    let target;
    try { target = await portal.streamTarget({ contentItemGuid: ev.contentItemGuid, scheduleGuid: ev.scheduleGuid }); }
    catch (e) { fail(ev, 'the studio could not be reached: ' + ((e && e.message) || e)); return; }
    if (!target || !target.ok) { fail(ev, (target && target.error) || 'no studio was returned by the portal'); return; }
    spawn(ev, { leadSec: computeLeadSec(ev, now()), resumeOffsetSec: 0, target, retried: false, resumeCount: 0 });
  }
```

**(f) Harness + new tests** — extend the harness to record logs and to fail persistence on demand, then add five tests:
```js
// in memStore: add a fail toggle
function memStore(initial = []) {
  let data = initial.map((e) => ({ ...e })); let willFail = false;
  return { load: () => data.map((e) => ({ ...e })), save: (evs) => { if (willFail) throw new Error('disk full'); data = evs.map((e) => ({ ...e })); }, _fail: () => { willFail = true; } };
}
// in harness: capture logs + expose failSave (build the store first so we can ref it),
// and accept an onEndBroadcast hook that fires INSIDE the endBroadcast fake (used to
// inject a failure during the portal-end await — the real takeover orphan window):
//   function harness({ events = [], target = ..., offset = 5, onEndBroadcast = null } = {}) {
//     ...
//     const portal = { streamTarget: async () => ..., endBroadcast: async (a) => { ended.push(a); order.push('end'); if (onEndBroadcast) onEndBroadcast(); return { ok: true }; } };
//     const store = memStore(events); const logs = [];
//     const sched = createScheduler({ store, portal, engineFactory, settings, now: () => clock, genId: () => 'gen' + (idc++), log: (m) => logs.push(m) });
//     return { sched, spawned, ended, order, logs, setClock, getClock, failSave: () => store._fail() };
//   }

test('instance guard: a late "playing" from a dead engine does not flip status', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'start fail' });      // retry → spawned[1]
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2);
  h.spawned[0].emit('playing');                                // dead instance emits late
  assert.equal(h.sched.getEvents()[0].status, 'starting', 'dead engine playing must be ignored');
});

test('takeover: a failure DURING the portal-end await cannot orphan a resume engine', async () => {
  // Fire the outgoing engine's failure from INSIDE endBroadcast — i.e. exactly while
  // takeover is awaiting the portal end (the original orphan window). With active nulled
  // first, onFailed hits its guard and spawns nothing; pre-fix it would resume-spawn an
  // A-engine (resumeOffsetSec === offset) that takeover then orphans → 3 engines.
  let h;
  const a = liveEvent({ id: 'A', fireAt: 100000, leadMs: 30000 });
  const b = liveEvent({ id: 'B', fireAt: 160000, leadMs: 0, contentItemGuid: 'ci2', scheduleGuid: 'sg2' });
  h = harness({ events: [a, b], offset: 42, onEndBroadcast: () => { if (h.spawned[0]) h.spawned[0].emit('failed', { reason: 'drop during end' }); } });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');                 // A live
  h.setClock(160000); await h.sched.tick();      // takeover A (failure injected mid-await), then go live B
  await new Promise((r) => setImmediate(r));
  assert.equal(h.spawned.length, 2, 'no orphaned resume engine for the taken-over event');
  assert.equal(h.spawned[1].opts.resumeOffsetSec, 0, 'the 2nd engine is B fresh, not an A-resume (which would carry offset 42)');
  assert.equal(h.sched.getEvents().find((e) => e.id === 'A').status, 'done');
});

test('key redaction: a stream key in a failure reason never reaches outcome or logs', async () => {
  const h = harness({ events: [liveEvent()] });      // target.key === 'KEY', server 'rtmps://h/app'
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('failed', { reason: 'rtmps://h/app/KEY: Input/output error' });
  await new Promise((r) => setImmediate(r));          // retry
  h.spawned[1].emit('failed', { reason: 'rtmps://h/app/KEY: Input/output error' });
  await new Promise((r) => setImmediate(r));          // fail
  const ev = h.sched.getEvents()[0];
  assert.equal(ev.status, 'failed');
  assert.ok(!ev.outcome.includes('KEY'), 'key must not be in the persisted outcome');
  assert.ok(!h.logs.join('\n').includes('KEY'), 'key must not be in logs');
});

test('a store.save failure inside the async ended handler does not throw or reject unhandled', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.spawned[0].emit('playing');
  h.failSave();
  assert.doesNotThrow(() => h.spawned[0].emit('ended'));
  await new Promise((r) => setImmediate(r));           // rejection, if any, is swallowed by the handler's .catch
});

test('a store.save failure inside the sync playing handler does not throw', async () => {
  const h = harness({ events: [liveEvent()] });
  h.setClock(70000); await h.sched.tick();
  h.failSave();
  assert.doesNotThrow(() => h.spawned[0].emit('playing'));
});
```

Commit the amendments:
```bash
git add schedule/scheduler.js test/scheduler.test.js
git commit -m "fix: takeover orphan race, unhandled-rejection guards, key redaction, instance guard"
```

---

### Task 5: `portal/link.js` + `app/ipc.js` — link parsing + the IPC handler map

**Files:**
- Create: `portal/link.js`, `app/ipc.js`
- Test: `test/ipc.test.js`

**Interfaces:**
- Consumes: `parsePortalLink` (this task), the portal client, scheduler, settings store, secret store, probe (`engine/probe.js` → `probeFile`), ffmpeg self-check (`engine/ffmpeg.js` → `selfCheck`).
- Produces:
  - `portal/link.js`: `parsePortalLink(input): {contentItemGuid, scheduleGuid}` — a `/broadcast/<guid>/<guid>` URL → both; otherwise the first GUID found → `contentItemGuid` (and a second, if any → `scheduleGuid`); none → both `''`.
  - `app/ipc.js`: `createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg }): Record<string, (payload) => Promise<any>>` — the channel→handler map the Electron main process registers. Channels: `settings:get`, `settings:save`, `secret:hasPassword`, `secret:setPassword`, `portal:testLogin`, `portal:checkLink`, `probe:file`, `engine:selfCheck`, `schedule:list`, `schedule:add`, `schedule:remove`, `schedule:stop`. Every handler is async and returns plain data; `secret:setPassword` catches a codec throw into `{ok:false, error}`.

- [ ] **Step 1: Write the failing tests**

`test/ipc.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePortalLink } = require('../portal/link');
const { createIpcHandlers } = require('../app/ipc');

test('parsePortalLink: broadcast link → both guids', () => {
  const r = parsePortalLink('https://content.echelonfit.com/broadcast/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222');
  assert.deepEqual(r, { contentItemGuid: '11111111-1111-1111-1111-111111111111', scheduleGuid: '22222222-2222-2222-2222-222222222222' });
});
test('parsePortalLink: class link → contentItemGuid only', () => {
  const r = parsePortalLink('https://content.echelonfit.com/classes/33333333-3333-3333-3333-333333333333');
  assert.deepEqual(r, { contentItemGuid: '33333333-3333-3333-3333-333333333333', scheduleGuid: '' });
});
test('parsePortalLink: junk → empty', () => {
  assert.deepEqual(parsePortalLink('nope'), { contentItemGuid: '', scheduleGuid: '' });
  assert.deepEqual(parsePortalLink(null), { contentItemGuid: '', scheduleGuid: '' });
});

function handlers(over = {}) {
  const calls = { save: [], setPw: [], add: [], remove: [], stop: [], check: [] };
  const base = {
    settings: { get: () => ({ videoBitrate: 6000 }), save: (p) => { calls.save.push(p); return { videoBitrate: 6000, ...p }; } },
    secrets: { has: () => true, set: (k, v) => { calls.setPw.push([k, v]); } },
    portal: {
      testLogin: async (o) => ({ ok: true, stations: [], _o: o }),
      checkClassLink: async (a) => { calls.check.push(a); return { ok: true, count: 1, vertical: false, ...a }; },
    },
    scheduler: {
      getEvents: () => [{ id: 'e1' }],
      addEvent: (e) => { calls.add.push(e); return { id: 'new', ...e }; },
      removeEvent: (id) => { calls.remove.push(id); return { ok: true }; },
      stopActive: async (id) => { calls.stop.push(id); return { ok: true }; },
    },
    probe: { probeFile: async (p) => ({ ok: true, durationSec: 10, width: 1920, height: 1080, _p: p }) },
    ffmpeg: { selfCheck: async () => ({ ok: true, version: 'x' }) },
  };
  return { h: createIpcHandlers({ ...base, ...over }), calls };
}

test('handler map covers exactly the expected channels', () => {
  const { h } = handlers();
  assert.deepEqual(Object.keys(h).sort(), [
    'engine:selfCheck', 'portal:checkLink', 'portal:testLogin', 'probe:file',
    'schedule:add', 'schedule:list', 'schedule:remove', 'schedule:stop',
    'secret:hasPassword', 'secret:setPassword', 'settings:get', 'settings:save',
  ].sort());
});

test('settings:save strips nothing but is passed through; settings:get returns store data', async () => {
  const { h, calls } = handlers();
  assert.deepEqual(await h['settings:get'](), { videoBitrate: 6000 });
  await h['settings:save']({ portalEmail: 'e@x.com' });
  assert.deepEqual(calls.save[0], { portalEmail: 'e@x.com' });
});

test('secret:setPassword returns {ok:true} on success and {ok:false,error} when the codec throws', async () => {
  const good = handlers();
  assert.deepEqual(await good.h['secret:setPassword']('pw'), { ok: true });
  assert.deepEqual(good.calls.setPw[0], ['portalPassword', 'pw']);
  const bad = handlers({ secrets: { has: () => false, set: () => { throw new Error('no keychain'); } } });
  const r = await bad.h['secret:setPassword']('pw');
  assert.equal(r.ok, false);
  assert.match(r.error, /no keychain/);
});

test('portal:checkLink parses the pasted string, resolves, and returns the guids for storage', async () => {
  const { h } = handlers();
  const r = await h['portal:checkLink']('https://x/classes/44444444-4444-4444-4444-444444444444');
  assert.equal(r.ok, true);
  assert.equal(r.contentItemGuid, '44444444-4444-4444-4444-444444444444');
  assert.equal(r.scheduleGuid, '');
});

test('schedule + probe + selfCheck handlers delegate correctly', async () => {
  const { h, calls } = handlers();
  assert.deepEqual(await h['schedule:list'](), [{ id: 'e1' }]);
  await h['schedule:add']({ title: 'T' }); assert.equal(calls.add[0].title, 'T');
  await h['schedule:remove']('e1'); assert.equal(calls.remove[0], 'e1');
  await h['schedule:stop']('e1'); assert.equal(calls.stop[0], 'e1');
  assert.equal((await h['probe:file']('/v.mp4')).durationSec, 10);
  assert.equal((await h['engine:selfCheck']()).ok, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/ipc.test.js`
Expected: FAIL — `Cannot find module '../portal/link'`.

- [ ] **Step 3: Implement**

`portal/link.js`:
```js
'use strict';
// Turn whatever the operator pastes (a full broadcast link, a class link, or a
// bare id) into the durable handles the portal client needs.
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function parsePortalLink(input) {
  const s = String(input || '');
  const b = /\/broadcast\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})/.exec(s);
  if (b) return { contentItemGuid: b[1], scheduleGuid: b[2] };
  const found = s.match(GUID) || [];
  return { contentItemGuid: found[0] || '', scheduleGuid: found[1] || '' };
}

module.exports = { parsePortalLink };
```

`app/ipc.js`:
```js
'use strict';
// The channel→handler map the Electron main process registers on ipcMain. Pure
// wiring: no Electron import here, so it is unit-tested directly. main.js does the
// ipcMain.handle registration and the push channel (schedule:changed).
const { parsePortalLink } = require('../portal/link');

function createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg }) {
  return {
    'settings:get': async () => settings.get(),
    'settings:save': async (patch) => settings.save(patch || {}),

    'secret:hasPassword': async () => secrets.has('portalPassword'),
    'secret:setPassword': async (pw) => {
      try { secrets.set('portalPassword', String(pw == null ? '' : pw)); return { ok: true }; }
      catch (e) { return { ok: false, error: (e && e.message) || 'The password could not be saved.' }; }
    },

    'portal:testLogin': async (overrides) => portal.testLogin(overrides || {}),
    'portal:checkLink': async (link) => {
      const ids = parsePortalLink(typeof link === 'string' ? link : (link && link.url) || '');
      const res = await portal.checkClassLink(ids);
      return { ...res, contentItemGuid: ids.contentItemGuid, scheduleGuid: ids.scheduleGuid };
    },

    'probe:file': async (filePath) => probe.probeFile(String(filePath || '')),
    'engine:selfCheck': async () => ffmpeg.selfCheck(),

    'schedule:list': async () => scheduler.getEvents(),
    'schedule:add': async (ev) => scheduler.addEvent(ev || {}),
    'schedule:remove': async (id) => scheduler.removeEvent(String(id || '')),
    'schedule:stop': async (id) => scheduler.stopActive(String(id || '')),
  };
}

module.exports = { createIpcHandlers };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ipc.test.js` — expected: 8 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected 86 tests, 0 fail.
```bash
git add portal/link.js app/ipc.js test/ipc.test.js
git commit -m "feat: portal link parsing + IPC handler map (pure, unit-tested)"
```

---

### Task 6: Electron wiring (`app/main.js`, `app/preload.js`) + controller-run brain rehearsal

**Files:**
- Modify: `app/main.js` (the Plan 1 scaffold — extend it)
- Create: `app/preload.js`
- Create: `scripts/brain-rehearsal.js`
- Read for reference: `app/main.js` (current), `engine/broadcast.js`, `engine/ffmpeg.js`, `engine/probe.js`, `scripts/rehearsal.js` + `scripts/mediamtx-test.yml` (Plan 1's local RTMP sink)

**Interfaces:**
- Consumes: everything above + Plan 1/2. Produces no new exports — this task wires the app together and adds one integration proof.
- `app/main.js` (after `app.whenReady`, single-instance lock already present from Plan 1): resolve the app-data dir (`store/appdata.js`), build `createSettingsStore`, `createScheduleStore`, `createSafeCodec(require('electron').safeStorage)`, `createSecretStore({ file, ...codec })`, `createTransport` (Plan 2), a portal client with `getConfig: () => buildPortalConfig(settings.get(), secrets)`, and `createScheduler({ store: scheduleStore, portal, engineFactory: (opts) => new Broadcast(opts), settings, genId })`. Register every entry of `createIpcHandlers(...)` with `ipcMain.handle(channel, (_e, payload) => handler(payload))`. Wire the push channel: `scheduler.onChanged((events) => win.webContents.send('schedule:changed', events))`. Call `scheduler.start()`. Run `ffmpeg.selfCheck()` once and send `engine:selfCheck` result to the renderer on load (Plan 4 shows a warning if not ok). The window still loads a placeholder page (Plan 4 replaces the renderer).
- `app/preload.js`: expose `window.api = { invoke(channel, payload), onScheduleChanged(cb) }` via `contextBridge.exposeInMainWorld`, backed by `ipcRenderer.invoke` / `ipcRenderer.on('schedule:changed', ...)`. `contextIsolation` stays on; no Node globals leak to the renderer.
- `scripts/brain-rehearsal.js`: a headless integration proof (no Electron). It builds a scheduler with the REAL `engineFactory` (`new Broadcast(opts)`), a FAKE portal returning the LOCAL mediamtx target `{ ok:true, server:'rtmp://127.0.0.1:1935/live', key:'brain', vertical:false }` and a no-op `endBroadcast`, an in-memory store, real settings pointing at the Plan 1 fixtures (slate.png, music.mp3), and a genId. It adds one event `~4 s` out with a `2 s` lead using the fixture `class.mp4`, starts mediamtx (reusing `scripts/mediamtx-test.yml`), runs `tick()` on a 1 s interval, and asserts the event reaches `playing` then `done` within the video's length + margin. Prints `BRAIN REHEARSAL PASSED` / `FAILED` and exits 0/1. This proves the brain drives the REAL engine end-to-end.

- [ ] **Step 1: Read the current scaffold and Plan 1 rehearsal harness**

Run: `sed -n '1,80p' app/main.js` and `sed -n '1,60p' scripts/rehearsal.js`
Expected: see the current `app.whenReady`/`BrowserWindow` setup and the mediamtx spawn + fixture pattern to mirror.

- [ ] **Step 2: Implement `app/preload.js`**

```js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onScheduleChanged: (cb) => {
    const listener = (_e, events) => cb(events);
    ipcRenderer.on('schedule:changed', listener);
    return () => ipcRenderer.removeListener('schedule:changed', listener);
  },
});
```

- [ ] **Step 3: Extend `app/main.js` to build the brain and register IPC**

Add the following wiring inside the existing `app.whenReady().then(...)` (after the window is created), and add `preload` to the `BrowserWindow` `webPreferences`. Show the exact additions:

```js
// --- webPreferences: add preload + keep isolation on ---
// webPreferences: {
//   preload: require('node:path').join(__dirname, 'preload.js'),
//   contextIsolation: true, nodeIntegration: false, sandbox: false,
// }

const path = require('node:path');
const { ipcMain, safeStorage } = require('electron');
const { appDataDir } = require('../store/appdata');
const { createSettingsStore, buildPortalConfig } = require('../store/settings');
const { createScheduleStore } = require('../store/schedule-store');
const { createSecretStore } = require('../store/secrets');
const { createSafeCodec } = require('../store/safe-codec');
const { createTransport } = require('../portal/http');
const { createPortalClient } = require('../portal/client');
const { createScheduler } = require('../schedule/scheduler');
const { createIpcHandlers } = require('./ipc');
const ffmpeg = require('../engine/ffmpeg');
const probe = require('../engine/probe');
const { Broadcast } = require('../engine/broadcast');

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
const scheduler = createScheduler({
  store: scheduleStore, portal, settings,
  engineFactory: (opts) => new Broadcast(opts),
  genId: () => 'ev' + Date.now() + '-' + (idc++),
  log: (m) => console.log('[sched] ' + m),
});
const handlers = createIpcHandlers({ settings, secrets, portal, scheduler, probe, ffmpeg });
for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, (_e, payload) => fn(payload));
}
scheduler.onChanged((events) => { if (!win.isDestroyed()) win.webContents.send('schedule:changed', events); });
scheduler.start();
ffmpeg.selfCheck().then((r) => { if (!win.isDestroyed()) win.webContents.send('engine:selfCheck', r); });
```

(Keep the existing single-instance lock and window creation. `win` is the existing `BrowserWindow` variable — match its actual name in the file.)

- [ ] **Step 4: Implement `scripts/brain-rehearsal.js`**

```js
'use strict';
/* Headless proof that the scheduler drives the REAL Broadcast engine end-to-end
   into a local RTMP sink (mediamtx). No Electron, no real portal. */
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createScheduler } = require('../schedule/scheduler');
const { Broadcast } = require('../engine/broadcast');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const CFG = path.join(__dirname, 'mediamtx-test.yml');

function memStore(init = []) { let d = init.slice(); return { load: () => d.slice(), save: (e) => { d = e.slice(); } }; }

(async () => {
  const mtx = spawn('mediamtx', [CFG], { stdio: 'ignore' });
  const cleanup = () => { try { mtx.kill('SIGKILL'); } catch {} };
  mtx.on('error', (e) => { console.error('could not start mediamtx (brew install mediamtx):', e.message); process.exit(2); });
  await new Promise((r) => setTimeout(r, 1500));

  const settings = { get: () => ({ slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'), fadeMs: 1000, videoBitrate: 3000 }) };
  const portal = {
    streamTarget: async () => ({ ok: true, server: 'rtmp://127.0.0.1:1935/live', key: 'brain', vertical: false }),
    endBroadcast: async () => ({ ok: true }),
  };
  let idc = 0;
  const start = Date.now();
  const sched = createScheduler({
    store: memStore(), portal, settings, engineFactory: (o) => new Broadcast(o),
    genId: () => 'r' + (idc++), log: (m) => console.log('[sched]', m),
  });
  sched.addEvent({
    id: 'rehearse', title: 'Rehearsal', filePath: path.join(FIX, 'class.mp4'), durationSec: 20,
    contentItemGuid: 'ci', scheduleGuid: 'sg',
    fireAt: start + 4000, leadMs: 2000, autoStop: true, status: 'pending',
  });

  const iv = setInterval(() => sched.tick(), 1000);
  let sawPlaying = false;
  const deadline = start + 4000 + 20000 + 20000;   // fire + video + generous margin
  const poll = setInterval(() => {
    const ev = sched.getEvents().find((e) => e.id === 'rehearse');
    if (ev && (ev.status === 'playing')) sawPlaying = true;
    if (ev && (ev.status === 'done' || ev.status === 'failed')) {
      clearInterval(iv); clearInterval(poll); cleanup();
      const ok = ev.status === 'done' && sawPlaying;
      console.log(ok ? '\nBRAIN REHEARSAL PASSED (' + ev.outcome + ')' : '\nBRAIN REHEARSAL FAILED (' + ev.status + ': ' + ev.outcome + ', sawPlaying=' + sawPlaying + ')');
      process.exit(ok ? 0 : 1);
    }
    if (Date.now() > deadline) {
      clearInterval(iv); clearInterval(poll); cleanup();
      console.log('\nBRAIN REHEARSAL FAILED (timed out; last status ' + (ev && ev.status) + ')');
      process.exit(1);
    }
  }, 1000);
  void spawnSync;
})();
```

- [ ] **Step 5: Add the rehearsal script to package.json**

Add to `"scripts"`: `"rehearsal:brain": "node scripts/brain-rehearsal.js"`.

- [ ] **Step 6: Syntax-check, run the suite, and commit (controller runs the live rehearsal)**

Run: `node --check app/main.js && node --check app/preload.js && node --check scripts/brain-rehearsal.js` — expected: clean.
Run: `npm test` — expected 86 tests, 0 fail (no new unit tests; the wiring is glue, the handler map is already tested in Task 5).

Do NOT run `npm run start` (opens a window) or the brain rehearsal in this task — the CONTROLLER runs `npm run rehearsal:brain` as the Plan-3 gate after the final review (it needs mediamtx and spawns a real encode).

```bash
git add app/main.js app/preload.js scripts/brain-rehearsal.js package.json
git commit -m "feat: Electron wiring (main+preload) and headless brain rehearsal driving the real engine"
```

---

## Definition of Done (Plan 3)

- `npm test` — 86 tests, 0 fail, fully offline (no Electron, no network, no real portal).
- Controller-run: `npm run rehearsal:brain` → `BRAIN REHEARSAL PASSED` — the scheduler drives the REAL `Broadcast` engine through slate→fade→video into local mediamtx and reports a clean `done`. This is Plan 3's dress-rehearsal gate (the Plan-1 rehearsal proved the engine alone; this proves the brain driving it).
- Every law in Global Constraints has a passing test: verified-start, abort-if-no-target, end-portal-before-stop, retry-once, resume-at-offset, weekly renewal, takeover, crash recovery, key-never-persisted.
- Everything committed; engine + portal + store suites from Plans 1/2 untouched and still green.

**What Plan 4 picks up:** the renderer — porting the 1.x Cinematic Dark UI to talk to `window.api` (the IPC channels above), with the approved **spotlight-step-1** schedule form (step 1 enlarged, steps 2–4 dimmed until a video is picked, then collapsing to a "✓ filename" row). Plan 5: electron-builder packaging (unsigned Mac DMG + Windows NSIS), startup `selfCheck` surfacing, bootstrap README.
