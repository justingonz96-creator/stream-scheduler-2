# Stream Scheduler 2.0 — Plan 4: Renderer / UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 1.x "Cinematic Dark" interface onto the Plan 3 brain — the schedule list + live status, the schedule form (with the approved **spotlight-step-1** refinement), and a slimmed **Setup** (slate, quality, portal login) — all talking to the brain through `window.api` IPC, and degrading to a built-in mock `window.api` in a plain browser so the whole UI is verifiable with the preview tools.

**Architecture:** The renderer splits into pure, DOM-free logic modules that are unit-tested with `node --test` (`renderer/format.js` — display formatting; `renderer/formstate.js` — the spotlight-step-1 state machine; `renderer/mockapi.js` — the browser-preview fake), plus the presentation layer verified visually by the controller (`renderer/index.html` + `renderer/styles.css` — the ported theme + markup; `renderer/app.js` — the DOM controller that binds `window.api` ↔ the views). `app/main.js` loads the renderer and adds a native file-dialog channel; `app/preload.js` already exposes the generic bridge.

**Tech Stack:** Plain HTML/CSS/vanilla ES modules (no framework, no bundler). Logic modules are Node-testable (`node:test`) and browser-loadable (dual `module.exports` + browser global — see the pattern in Task 1). Zero npm runtime dependencies. The renderer runs identically in Electron (real `window.api` from the Plan 3 preload) and in a browser (the mock).

**Reference (visual + structural parity target):** `/Users/eleonard/Documents/Cluade/stream-scheduler/StreamScheduler.html` — the field-tested 1.x UI. Port its look verbatim (theme CSS lines 11–417) and its layout/field set, MINUS everything OBS-specific (see Global Constraints). It is the single source for the theme; do not invent new visuals.

**Spec:** `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md` (§3 UI incl. spotlight-step-1, §4 architecture).

## Global Constraints

- **The renderer never sees a stream key or the portal password.** It only ever calls the Plan 3 IPC channels, none of which return a key; `secret:setPassword` is write-only (the password field is cleared after save and never read back). The renderer must not persist either to `localStorage` or anywhere.
- **`window.api` contract (from the Plan 3 preload):** `window.api.invoke(channel, payload): Promise<any>` and `window.api.onScheduleChanged(cb): unsubscribe`. All brain access goes through these. The renderer installs the mock ONLY when `window.api` is absent (a plain browser); in Electron the real bridge wins.
- **IPC channels the renderer may call (Plan 3, exact):** `settings:get`, `settings:save`, `secret:hasPassword`, `secret:setPassword`, `portal:testLogin`, `portal:checkLink`, `probe:file`, `engine:selfCheck`, `schedule:list`, `schedule:add`, `schedule:remove`, `schedule:stop`, plus the ONE new channel this plan adds in main.js: `dialog:openFile` (native open dialog → absolute path or `''`).
- **Drop everything OBS-specific from the 1.x UI:** the Setup OBS-WebSocket step (password/port), the "Pick in OBS…" buttons (replace with a native file dialog), "Test connection to OBS", the mute-room-audio option, the OBS connection pill, and the passive/leader "already open" overlay copy about OBS. 2.0 has no OBS.
- **2.0 Setup has exactly three sections:** (1) **Slate** — slate image + looping MP3 (native pick) + fade length; (2) **Streaming quality** — bitrate preset/custom; (3) **Content portal login** — email, password, optional API key, Test login. Plus a small **video engine** status line driven by `engine:selfCheck` (the bundled FFmpeg — green "ready" or a plain-English warning; no install step for the operator).
- **Spotlight-step-1 (approved §3 change):** in the schedule form, step 1 ("Which video should play?") is the visual anchor — enlarged and prominent; steps 2–4 + the portal link + options are visibly **dimmed/disabled** until a video is picked; once picked, step 1 **collapses to a compact "✓ filename · length" row** (with a "change" affordance) and 2–4 become active. This fixes the 1.x problem where the date/time controls drew the eye past step 1. The transition logic lives in the tested `renderer/formstate.js`.
- **Binding notes carried from Plan 3's final review (ledger):** (a) the Setup portal **Test login** must handle `{ok:false}` on a station-list failure as an error message (not an empty list); (b) the station list from the portal is **unsorted** — if the UI ever shows stations, sort by name in the renderer; (c) `schedule:add` payloads should be well-formed — the renderer sends numeric `fireAt`/`leadMs`/`durationSec` and never sets `status` (the brain defaults it). Also: `app/main.js` should use the `if (!gotLock) { app.quit(); return; }`-style guard and may drop `sandbox:false` — fold these into this plan's main.js task.
- Plain-English throughout; the operator is not technical. Match the 1.x copy where it still applies.
- `npm test` = `node --test` (self-discovery). Suite is 94/94 at the start of this plan — must stay green. The renderer's pure modules add unit tests; the presentation is verified by the controller with the preview tools (the Plan-4 equivalent of the earlier rehearsal gates).

---

### Task 1: `renderer/mockapi.js` — the browser-preview mock `window.api`

**Files:**
- Create: `renderer/mockapi.js`
- Test: `test/mockapi.test.js`

**Interfaces:**
- Produces: `createMockApi(seed = {}): { invoke(channel, payload): Promise<any>, onScheduleChanged(cb): () => void, _emitChange(): void }` — an in-memory fake implementing every Plan 3 channel + `dialog:openFile`, returning the SAME shapes the real brain returns. `installMockApi(global = window): void` — if `global.api` is absent, sets `global.api = createMockApi()`. Dual-export: `module.exports` for Node tests AND `globalThis.MockApi = {...}` when loaded in a browser (see the exact footer in the code).
- Canned data: `settings:get` → the DEFAULT_SETTINGS shape; `schedule:list` → the in-memory array (seedable); `portal:testLogin` → `{ok:true, stations:[{name,guid}...]}`; `portal:checkLink` → `{ok:true, count:1, picked:{...}, vertical:false, medium:'standard', contentItemGuid, scheduleGuid}`; `probe:file` → `{ok:true, durationSec:1800, width:1920, height:1080, hasAudio:true}`; `engine:selfCheck` → `{ok:true, version:'ffmpeg 6.1 (bundled)'}`; `dialog:openFile` → a fake path like `/Users/you/Videos/class.mp4`. `schedule:add` pushes a normalized-ish event and returns it; `schedule:remove`/`schedule:stop` return `{ok:true}`.

- [ ] **Step 1: Write the failing tests**

`test/mockapi.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockApi, installMockApi } = require('../renderer/mockapi');

test('every renderer channel returns a plausibly-shaped result', async () => {
  const api = createMockApi();
  assert.equal((await api.invoke('settings:get')).videoBitrate !== undefined, true);
  assert.equal((await api.invoke('engine:selfCheck')).ok, true);
  assert.equal((await api.invoke('secret:hasPassword')) !== undefined, true);
  const login = await api.invoke('portal:testLogin', {});
  assert.equal(login.ok, true); assert.ok(Array.isArray(login.stations));
  const link = await api.invoke('portal:checkLink', 'https://x/classes/11111111-1111-1111-1111-111111111111');
  assert.equal(link.ok, true); assert.equal(link.contentItemGuid, '11111111-1111-1111-1111-111111111111');
  const probe = await api.invoke('probe:file', '/v.mp4');
  assert.equal(probe.ok, true); assert.ok(probe.durationSec > 0);
  assert.equal(typeof (await api.invoke('dialog:openFile', {})), 'string');
});

test('schedule add/list/remove round-trips in memory', async () => {
  const api = createMockApi();
  assert.deepEqual(await api.invoke('schedule:list'), []);
  const ev = await api.invoke('schedule:add', { title: 'T', fireAt: 5, filePath: '/v.mp4', durationSec: 10 });
  assert.ok(ev.id);
  assert.equal((await api.invoke('schedule:list')).length, 1);
  assert.deepEqual(await api.invoke('schedule:remove', ev.id), { ok: true });
  assert.equal((await api.invoke('schedule:list')).length, 0);
});

test('onScheduleChanged fires on _emitChange and unsubscribes', async () => {
  const api = createMockApi();
  let calls = 0;
  const off = api.onScheduleChanged(() => { calls++; });
  api._emitChange(); assert.equal(calls, 1);
  off(); api._emitChange(); assert.equal(calls, 1);
});

test('installMockApi only fills an absent api', () => {
  const g1 = {}; installMockApi(g1); assert.equal(typeof g1.api.invoke, 'function');
  const real = { invoke() {}, onScheduleChanged() {} }; const g2 = { api: real };
  installMockApi(g2); assert.equal(g2.api, real, 'must not overwrite a real bridge');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/mockapi.test.js` → FAIL (`Cannot find module '../renderer/mockapi'`).

- [ ] **Step 3: Implement `renderer/mockapi.js`**

```js
'use strict';
// A stand-in for the Electron preload's window.api, used ONLY when the renderer
// runs in a plain browser (preview/verification). Same channels and result
// shapes as the Plan 3 brain, backed by in-memory state. Never installed when a
// real window.api exists.
function createMockApi(seed = {}) {
  const settings = Object.assign({
    slateImage: '', slateMusic: '', fadeMs: 1000, videoBitrate: 6000,
    portalEmail: '', portalApiKey: '', portalApiBase: '',
  }, seed.settings || {});
  let events = (seed.events || []).slice();
  let hasPw = !!seed.hasPassword;
  let n = 0;
  const listeners = new Set();
  const emit = () => { for (const f of listeners) { try { f(events.slice()); } catch {} } };
  const firstGuid = (s) => (String(s).match(/[0-9a-fA-F-]{36}/) || [''])[0];

  async function invoke(channel, payload) {
    switch (channel) {
      case 'settings:get': return { ...settings };
      case 'settings:save': { Object.assign(settings, payload || {}); delete settings.password; delete settings.portalPassword; return { ...settings }; }
      case 'secret:hasPassword': return hasPw;
      case 'secret:setPassword': { hasPw = !!payload; return { ok: true }; }
      case 'portal:testLogin': return { ok: true, stations: [{ name: 'Connect', guid: 'g1' }, { name: 'Reflect', guid: 'g2' }] };
      case 'portal:checkLink': {
        const cig = firstGuid(payload);
        return { ok: true, count: 1, picked: { scheduleGuid: '', stationGuid: 'g1', stationName: 'Connect' }, vertical: false, medium: 'standard', contentItemGuid: cig, scheduleGuid: '' };
      }
      case 'probe:file': return { ok: true, durationSec: 1800, width: 1920, height: 1080, hasAudio: true };
      case 'engine:selfCheck': return { ok: true, version: 'ffmpeg 6.1 (bundled)' };
      case 'dialog:openFile': return '/Users/you/Videos/class.mp4';
      case 'schedule:list': return events.slice();
      case 'schedule:add': { const ev = Object.assign({ id: 'mock' + (n++), status: 'pending', outcome: '', doneAt: 0 }, payload); events.push(ev); emit(); return { ...ev }; }
      case 'schedule:remove': { events = events.filter((e) => e.id !== payload); emit(); return { ok: true }; }
      case 'schedule:stop': return { ok: true };
      default: return { ok: false, error: 'unknown channel: ' + channel };
    }
  }
  return { invoke, onScheduleChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, _emitChange: emit };
}

function installMockApi(global) {
  if (global && !global.api) global.api = createMockApi();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMockApi, installMockApi };
if (typeof window !== 'undefined') { window.MockApi = { createMockApi, installMockApi }; installMockApi(window); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mockapi.test.js` → 4 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 98 tests, 0 fail.
```bash
git add renderer/mockapi.js test/mockapi.test.js
git commit -m "feat: browser-preview mock window.api (same channels/shapes as the brain)"
```

---

### Task 2: `renderer/format.js` — pure display formatters

**Files:**
- Create: `renderer/format.js`
- Test: `test/format.test.js`

**Interfaces:**
- Produces (pure, DOM-free; dual-export like Task 1):
  - `fmtClock(ms): string` — e.g. `'7:05 PM'` (local time-of-day, no seconds).
  - `fmtDateTime(ms): string` — e.g. `'Fri, Jul 4 · 7:05 PM'`.
  - `statusPill(ev): { label, kind }` where kind ∈ `'live'|'pending'|'done'|'failed'|'missed'|'preshow'` — maps a scheduler status to a display label ('preshow'→'Slate up', 'playing'→'On air', 'starting'→'Starting…', 'pending'→'Scheduled', 'done'→(ev.outcome or 'Played'), 'failed'→(ev.outcome or 'Failed'), 'missed'→(ev.outcome or 'Missed')).
  - `endsAround(ev): string` — `''` unless `ev.durationSec>0`; else `'ends around ' + fmtClock(fireAt + durationSec*1000)` (+ ` · stream ends by itself` when `ev.autoStop`).
  - `buildTimeOptions(): { hours: string[], minutes: string[] }` — hours `'1'..'12'`, minutes `'00','05',...,'55'` (5-min steps, zero-padded).
  - `orientationLabel(vertical): string` — `vertical ? 'Vertical (9:16)' : 'Widescreen (16:9)'`.
  - `parseDateTime(dateStr, hour, min, ap): number|null` — combine an ISO `date` value + 12h hour/min + AM/PM into an epoch ms (local), or `null` if incomplete/invalid.

- [ ] **Step 1: Write the failing tests**

`test/format.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../renderer/format');

test('statusPill maps every scheduler status', () => {
  assert.equal(F.statusPill({ status: 'playing' }).kind, 'live');
  assert.equal(F.statusPill({ status: 'playing' }).label, 'On air');
  assert.equal(F.statusPill({ status: 'preshow' }).label, 'Slate up');
  assert.equal(F.statusPill({ status: 'starting' }).label, 'Starting…');
  assert.equal(F.statusPill({ status: 'pending' }).label, 'Scheduled');
  assert.equal(F.statusPill({ status: 'done', outcome: 'Played ✓ and the stream ended' }).label, 'Played ✓ and the stream ended');
  assert.equal(F.statusPill({ status: 'failed', outcome: '' }).label, 'Failed');
  assert.equal(F.statusPill({ status: 'missed', outcome: '' }).kind, 'missed');
});

test('endsAround only when a duration is known; notes auto-stop', () => {
  assert.equal(F.endsAround({ fireAt: 0, durationSec: 0 }), '');
  const s = F.endsAround({ fireAt: 0, durationSec: 3600, autoStop: true });
  assert.match(s, /^ends around /);
  assert.match(s, /stream ends by itself/);
  assert.ok(!F.endsAround({ fireAt: 0, durationSec: 3600, autoStop: false }).includes('by itself'));
});

test('buildTimeOptions shape', () => {
  const { hours, minutes } = F.buildTimeOptions();
  assert.deepEqual(hours[0], '1'); assert.equal(hours.length, 12);
  assert.deepEqual(minutes, ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
});

test('parseDateTime combines parts or returns null', () => {
  assert.equal(F.parseDateTime('', '7', '05', 'PM'), null);
  const ms = F.parseDateTime('2026-07-04', '7', '05', 'PM');
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 6); assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 19); assert.equal(d.getMinutes(), 5);
  assert.equal(F.parseDateTime('2026-07-04', '12', '00', 'AM'), new Date(2026, 6, 4, 0, 0, 0, 0).getTime());   // midnight
  assert.equal(new Date(F.parseDateTime('2026-07-04', '12', '00', 'PM')).getHours(), 12);                       // noon
});

test('orientationLabel', () => {
  assert.match(F.orientationLabel(true), /9:16/);
  assert.match(F.orientationLabel(false), /16:9/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/format.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `renderer/format.js`**

```js
'use strict';
// Pure display helpers for the renderer. No DOM, no window — so they run under
// node:test AND in the browser (dual export at the bottom).
function pad2(n) { return String(n).padStart(2, '0'); }

function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad2(d.getMinutes()) + ' ' + ap;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate() + ' · ' + fmtClock(ms);
}

const STATUS = {
  playing: { label: 'On air', kind: 'live' },
  preshow: { label: 'Slate up', kind: 'preshow' },
  starting: { label: 'Starting…', kind: 'preshow' },
  pending: { label: 'Scheduled', kind: 'pending' },
};
function statusPill(ev) {
  if (STATUS[ev.status]) return { ...STATUS[ev.status] };
  if (ev.status === 'done') return { label: ev.outcome || 'Played', kind: 'done' };
  if (ev.status === 'failed') return { label: ev.outcome || 'Failed', kind: 'failed' };
  if (ev.status === 'missed') return { label: ev.outcome || 'Missed', kind: 'missed' };
  return { label: ev.status || '', kind: 'pending' };
}

function endsAround(ev) {
  if (!(ev.durationSec > 0)) return '';
  return 'ends around ' + fmtClock(ev.fireAt + ev.durationSec * 1000) + (ev.autoStop ? ' · stream ends by itself' : '');
}

function buildTimeOptions() {
  const hours = []; for (let h = 1; h <= 12; h++) hours.push(String(h));
  const minutes = []; for (let m = 0; m < 60; m += 5) minutes.push(pad2(m));
  return { hours, minutes };
}

function orientationLabel(vertical) { return vertical ? 'Vertical (9:16)' : 'Widescreen (16:9)'; }

function parseDateTime(dateStr, hour, min, ap) {
  if (!dateStr || !hour || min === '' || min == null || !ap) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr); if (!m) return null;
  let h = parseInt(hour, 10); const mm = parseInt(min, 10);
  if (!(h >= 1 && h <= 12) || !(mm >= 0 && mm < 60)) return null;
  if (ap === 'AM') { if (h === 12) h = 0; } else { if (h !== 12) h += 12; }
  return new Date(+m[1], +m[2] - 1, +m[3], h, mm, 0, 0).getTime();
}

const API = { fmtClock, fmtDateTime, statusPill, endsAround, buildTimeOptions, orientationLabel, parseDateTime };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Fmt = API;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/format.test.js` → 5 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 103 tests, 0 fail.
```bash
git add renderer/format.js test/format.test.js
git commit -m "feat: pure renderer formatters (clock, status pill, time options, date parse)"
```

---

### Task 3: `renderer/formstate.js` — the spotlight-step-1 state machine

**Files:**
- Create: `renderer/formstate.js`
- Test: `test/formstate.test.js`

**Interfaces:**
- Produces (pure, DOM-free; dual-export):
  - `computeFormPhase(state): { step1: 'spotlight'|'collapsed', rest: 'dim'|'active', canSave: boolean, reasons: string[] }` where `state = { filePath, durationSec, fireAt, contentItemGuid, linkChecked }`.
    - `step1` is `'spotlight'` until a video is picked (`filePath` truthy AND `durationSec>0`), then `'collapsed'`.
    - `rest` mirrors it: `'dim'` (steps 2–4 + link + options non-interactive) until the video is picked, then `'active'`.
    - `canSave` requires: a picked video (path + duration), a valid `fireAt` (truthy number), and a class link resolved (`contentItemGuid` truthy AND `linkChecked` true) — the class link is REQUIRED (the brain aborts a broadcast without a studio). `reasons` lists the plain-English blockers for a disabled Save button.
  - `pickedSummary(state): string` — `''` if no video; else `basename(filePath) + ' · ' + mmss(durationSec)` for the collapsed "✓ …" row. `mmss(3600)` → `'60:00'`.

- [ ] **Step 1: Write the failing tests**

`test/formstate.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeFormPhase, pickedSummary } = require('../renderer/formstate');

const S = (o = {}) => Object.assign({ filePath: '', durationSec: 0, fireAt: 0, contentItemGuid: '', linkChecked: false }, o);

test('before a video is picked: step1 spotlight, rest dim, cannot save', () => {
  const p = computeFormPhase(S());
  assert.equal(p.step1, 'spotlight');
  assert.equal(p.rest, 'dim');
  assert.equal(p.canSave, false);
  assert.ok(p.reasons.some((r) => /video/i.test(r)));
});

test('after a video is picked: step1 collapses, rest activates', () => {
  const p = computeFormPhase(S({ filePath: '/v.mp4', durationSec: 1800 }));
  assert.equal(p.step1, 'collapsed');
  assert.equal(p.rest, 'active');
});

test('canSave requires video + time + a resolved class link', () => {
  const base = { filePath: '/v.mp4', durationSec: 1800 };
  assert.equal(computeFormPhase(S({ ...base, fireAt: 0 })).canSave, false);                                   // no time
  assert.equal(computeFormPhase(S({ ...base, fireAt: 123 })).canSave, false);                                 // no link
  assert.ok(computeFormPhase(S({ ...base, fireAt: 123 })).reasons.some((r) => /class link/i.test(r)));
  assert.equal(computeFormPhase(S({ ...base, fireAt: 123, contentItemGuid: 'ci', linkChecked: true })).canSave, true);
});

test('a link typed but not yet checked does not satisfy canSave', () => {
  const p = computeFormPhase(S({ filePath: '/v.mp4', durationSec: 1800, fireAt: 1, contentItemGuid: 'ci', linkChecked: false }));
  assert.equal(p.canSave, false);
});

test('pickedSummary: basename + mm:ss, empty when no video', () => {
  assert.equal(pickedSummary(S()), '');
  assert.equal(pickedSummary(S({ filePath: '/a/b/class-final.mp4', durationSec: 1830 })), 'class-final.mp4 · 30:30');
  assert.equal(pickedSummary(S({ filePath: 'C:\\vids\\x.mp4', durationSec: 5 })), 'x.mp4 · 0:05');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/formstate.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `renderer/formstate.js`**

```js
'use strict';
// The spotlight-step-1 state machine (spec §3). Step 1 (pick the video) is the
// anchor: everything else stays dim until a video is chosen, then step 1 collapses
// to a compact "✓ file · length" row and the rest activates. Pure — the DOM layer
// (app.js) reads these decisions and toggles classes/attributes. A class link is
// REQUIRED to save, because the brain aborts any broadcast with no studio.
function basename(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }
function mmss(sec) { const s = Math.max(0, Math.round(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function hasVideo(state) { return !!state.filePath && state.durationSec > 0; }

function computeFormPhase(state) {
  const picked = hasVideo(state);
  const reasons = [];
  if (!picked) reasons.push('Choose the video that should play.');
  if (!state.fireAt) reasons.push('Set the date and start time.');
  if (!(state.contentItemGuid && state.linkChecked)) reasons.push('Paste the class link and press “Check this class link”.');
  return {
    step1: picked ? 'collapsed' : 'spotlight',
    rest: picked ? 'active' : 'dim',
    canSave: reasons.length === 0,
    reasons,
  };
}

function pickedSummary(state) {
  if (!hasVideo(state)) return '';
  return basename(state.filePath) + ' · ' + mmss(state.durationSec);
}

const API = { computeFormPhase, pickedSummary };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.FormState = API;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/formstate.test.js` → 5 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 108 tests, 0 fail.
```bash
git add renderer/formstate.js test/formstate.test.js
git commit -m "feat: spotlight-step-1 form state machine (pure, tested)"
```

---

### Task 4: `renderer/index.html` + `renderer/styles.css` — theme + markup port

**Files:**
- Create: `renderer/styles.css`, `renderer/index.html`
- Reference: `/Users/eleonard/Documents/Cluade/stream-scheduler/StreamScheduler.html` (theme lines 11–417; markup lines 430–715)

This task is verified **visually by the controller** (preview tools), not by unit tests. Its deliverable is a faithful, static render of the 2.0 UI with the mock api driving it.

- [ ] **Step 1: Create `renderer/styles.css` by porting the 1.x theme verbatim, minus OBS bits**

Copy the CSS **between** `<style>` and `</style>` (source lines 12–416) into `renderer/styles.css` verbatim — the full light + `:root[data-theme="dark"]` cinematic-dark token sets, the `html { font-size: clamp(...) }` fluid scale, and every component rule (`.wrap`, `header.topbar`, `.card`, `.btn-*`, `.field`, `.flabel`, `.row2`, `.timepick`, `.checkrow`, `.sched`, `.setup-step`, `#liveBar`, `#statusBar`, `.pickstatus`, etc.). Then apply ONLY these deletions/edits (OBS/1.x cruft that has no 2.0 markup):
- remove rules that only target `#passiveOverlay`/`.pa-*` (the "already open" overlay is dropped),
- remove `.mic`/`#sbAudio`/mute-related rules if present,
- keep everything else unchanged (the theme must look identical to 1.x).
Add three small **new** rules at the end for spotlight-step-1 (the only new visuals):
```css
/* ---- Spotlight step 1 (Plan 4 §3) ---- */
#step1.spotlight { padding: var(--sp-5); border: 1px solid var(--accent-ring); border-radius: 14px; background: var(--accent-soft); box-shadow: 0 0 0 4px var(--accent-ring); }
#step1.spotlight .flabel { font-size: var(--fs-4); }
#step1.collapsed .step1-full { display: none; }
#step1 .step1-collapsed { display: none; }
#step1.collapsed .step1-collapsed { display: flex; align-items: center; gap: 10px; font-size: var(--fs-4); }
.form-dim { opacity: 0.45; pointer-events: none; filter: saturate(0.6); }

/* ---- Schedule rows + pills + alert bar (these elements are built by app.js, so their classes need styling even though 1.x rendered rows differently) ---- */
.schedrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; background: var(--surface-2); border-radius: 12px; margin-bottom: 8px; }
.schedrow .meta { color: var(--ink-soft); font-size: var(--fs-1); }
.schedrow button { margin-left: auto; }
.pill { padding: 3px 10px; border-radius: 999px; font-size: var(--fs-1); font-weight: 700; background: var(--chip); }
.pill.live { background: var(--bad-soft); color: var(--bad); }
.pill.preshow { background: var(--warn-soft); color: var(--warn); }
.pill.pending { background: var(--accent-soft); color: var(--accent-strong); }
.pill.done { background: var(--good-soft); color: var(--good); }
.pill.failed { background: var(--bad-soft); color: var(--bad); }
.pill.missed { background: var(--warn-soft); color: var(--warn); }
.alert { padding: 12px 16px; border-radius: 12px; margin: 10px 0; }
.alert.bad { background: var(--bad-soft); color: var(--bad); border: 1px solid var(--bad-border); }
.pickstatus.good { color: var(--good); }
.pickstatus.bad { color: var(--bad); }
.hidden { display: none !important; }
```

- [ ] **Step 2: Create `renderer/index.html`** — the ported layout, OBS bits removed, spotlight-step-1 structure, loading the modules

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stream Scheduler</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="logo">Stream<span class="dot"> Scheduler</span></div>
    <div class="spacer"></div>
    <button id="btnGear" class="btn-ghost" title="Setup">Setup</button>
    <button id="btnTheme" class="btn-ghost" title="Switch dark / light mode">Theme</button>
  </header>

  <div id="alertBar"></div>

  <div id="liveBar" class="hidden">
    <span class="livedot"></span>
    <span class="livetext">LIVE — the stream is running</span>
    <span class="spacer"></span>
    <button id="btnStopNow">End stream now</button>
    <span class="livesub" id="liveSub"></span>
  </div>

  <!-- ========= MAIN VIEW ========= -->
  <div id="viewMain">
    <div style="margin:18px 0; display:flex; justify-content:center;">
      <button id="btnNew" class="btn-primary btn-big">+ Schedule a video</button>
    </div>

    <div class="card hidden" id="formCard">
      <h3 id="formHeading" style="margin:0 0 10px;">Schedule a video</h3>

      <!-- Step 1 — the spotlight -->
      <div class="field" id="step1">
        <div class="step1-full">
          <label class="flabel">1. Which video should play?</label>
          <div id="dropZone">
            <button class="btn-primary" id="btnPickVideo" type="button">Choose the video…</button>
            <div id="fileCheck" class="pickstatus"></div>
          </div>
          <div class="fhint">Pick the video file from this computer or a connected drive.</div>
        </div>
        <div class="step1-collapsed">
          <span id="pickedSummary"></span>
          <button class="btn-quiet btn-small" id="btnChangeVideo" type="button">change</button>
        </div>
      </div>

      <div id="restOfForm">
        <div class="field">
          <label class="flabel">2. When should the video start?</label>
          <div class="row2">
            <div><input type="date" id="evDate"><div class="fhint">Date</div></div>
            <div>
              <div class="timepick">
                <select id="evHour" aria-label="Hour"><option value="">Hour</option></select>
                <span class="tp-colon">:</span>
                <select id="evMin" aria-label="Minutes"><option value="">Min</option></select>
                <select id="evAP" aria-label="AM or PM"><option value="">—</option><option value="AM">AM</option><option value="PM">PM</option></select>
              </div>
              <div class="fhint">Start time</div>
            </div>
          </div>
        </div>

        <div class="field">
          <label class="flabel">3. Start the stream early, with the slate up?</label>
          <select id="evLead">
            <option value="0">No — start right at the video time</option>
            <option value="1">1 minute early</option><option value="2">2 minutes early</option>
            <option value="5">5 minutes early</option><option value="10">10 minutes early</option>
            <option value="15">15 minutes early</option><option value="20">20 minutes early</option>
            <option value="30">30 minutes early</option>
          </select>
          <div class="fhint" id="leadHint"></div>
        </div>

        <div class="field">
          <label class="flabel">4. When the video finishes…</label>
          <label class="checkrow">
            <input type="checkbox" id="evAutoStop" checked>
            <span><span class="ck-title">End the stream automatically</span><br>
            <span class="ck-sub">Recommended. If unchecked, the broadcast is left open until someone ends it by hand.</span></span>
          </label>
        </div>

        <div class="field">
          <label class="flabel">Content portal class link</label>
          <input type="text" id="evPortalLink" placeholder="paste this class's link from the content portal (…/classes/…)">
          <div style="margin-top:8px;"><button class="btn-quiet btn-small" id="btnEvPortalCheck" type="button">Check this class link</button></div>
          <div class="pickstatus" id="evPortalStatus"></div>
          <div class="fhint">Required — it tells the Scheduler which studio to stream to, and ends the broadcast when the video finishes.</div>
        </div>

        <div class="field">
          <label class="checkrow">
            <input type="checkbox" id="evRepeat">
            <span><span class="ck-title">Repeat every week</span><br>
            <span class="ck-sub">The slot returns each week and asks for that week's video — it never re-airs an old one.</span></span>
          </label>
        </div>

        <div class="field">
          <label class="flabel">Name for this event <span style="font-weight:400;color:var(--ink-soft)">(optional)</span></label>
          <input type="text" id="evTitle" maxlength="60" placeholder="example: Friday Evening Ride">
        </div>
      </div>

      <div class="form-error" id="formError"></div>
      <div class="form-actions">
        <button class="btn-primary btn-big" id="btnSave">✓ Schedule it</button>
        <button class="btn-quiet" id="btnCancel">Cancel</button>
      </div>
    </div>

    <h2 class="section">Schedule</h2>
    <div id="upcomingList" class="sched"></div>
    <details class="history"><summary>Past events</summary><div id="historyList" style="margin-top:6px;"></div></details>
  </div>

  <!-- ========= SETUP VIEW ========= -->
  <div id="viewSetup" class="hidden">
    <div class="card">
      <h3 style="margin:0; font-size:var(--fs-5);">Setup for this computer</h3>
      <p style="color:var(--ink-soft); font-size:var(--fs-2);" id="engineStatus">Checking the video engine…</p>

      <div class="setup-step"><div class="setup-num">1</div><div class="setup-body">
        <h3>The slate <span style="font-weight:400;color:var(--ink-soft)">(optional)</span></h3>
        <p>What viewers see <b>before the video starts</b>: a picture, usually with waiting music.</p>
        <div class="slate-row"><input type="text" id="setSlateImage" placeholder="no picture chosen yet" readonly>
          <button class="btn-quiet" id="btnPickSlateImage" type="button">Choose…</button></div>
        <div class="fhint" style="margin-bottom:10px;">The picture (PNG or JPG)</div>
        <div class="slate-row"><input type="text" id="setSlateMusic" placeholder="no music chosen yet" readonly>
          <button class="btn-quiet" id="btnPickSlateMusic" type="button">Choose…</button></div>
        <div class="fhint" style="margin-bottom:10px;">The music (MP3) — loops. Leave empty for a silent slate.</div>
        <select id="setFade">
          <option value="500">Fade into the video: Quick (½ second)</option>
          <option value="1000" selected>Fade into the video: Normal (1 second)</option>
          <option value="2000">Fade into the video: Slow &amp; smooth (2 seconds)</option>
        </select>
      </div></div>

      <div class="setup-step"><div class="setup-num">2</div><div class="setup-body">
        <h3>Streaming quality</h3>
        <p><b>Where to stream is automatic</b> — each video's class link tells the Scheduler which Echelon studio to broadcast to. Just pick the quality:</p>
        <select id="setBitratePreset" style="margin-bottom:8px;">
          <option value="2500">Low — saves bandwidth (~2500 kbps)</option>
          <option value="4500">Standard (~4500 kbps)</option>
          <option value="6000">High — best looking (~6000 kbps)</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="number" id="setBitrateCustom" placeholder="video bitrate in kbps" min="500" max="20000" style="display:none;">
        <div class="fhint">Higher looks better but needs more upload speed. Takes effect on the next broadcast.</div>
      </div></div>

      <div class="setup-step"><div class="setup-num">3</div><div class="setup-body">
        <h3>Content portal login</h3>
        <p>The Scheduler signs in to find each class's studio and to end the broadcast when the video finishes. Required.</p>
        <div class="field" style="margin-top:0;"><label class="flabel">Portal email</label>
          <input type="email" id="setPortalEmail" placeholder="you@echelonfit.com"></div>
        <div class="field"><label class="flabel">Portal password</label>
          <input type="password" id="setPortalPassword" placeholder="your content portal password">
          <div class="fhint">Stored only on this computer, in your operating system's secure keychain.</div></div>
        <div class="field"><label class="flabel">Portal API key <span style="font-weight:400;color:var(--ink-soft)">(optional)</span></label>
          <input type="text" id="setPortalApiKey" placeholder="leave blank to start"></div>
        <div style="margin-top:16px;">
          <button class="btn-quiet btn-small" id="btnPortalTest" type="button">Test login</button>
          <div id="portalTestResult" class="pickstatus" style="margin-top:10px;"></div>
        </div>
      </div></div>

      <div class="form-actions" style="margin-top:28px;">
        <button class="btn-primary btn-big" id="btnSetupDone">Save &amp; finish</button>
      </div>
    </div>
  </div>

  <div id="statusBar">
    <span class="sb-item sb-clock" id="clockNow">…</span>
  </div>
</div>

<script src="mockapi.js"></script>
<script src="format.js"></script>
<script src="formstate.js"></script>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Commit (controller verifies visually in Task 6)**

Run: `npm test` → 108, 0 fail (no new tests; the visual gate is Task 6).
```bash
git add renderer/index.html renderer/styles.css
git commit -m "feat: renderer markup + Cinematic Dark theme port (OBS bits removed, spotlight-step-1 structure)"
```

---

### Task 5: `renderer/app.js` — the DOM controller

**Files:**
- Create: `renderer/app.js`
- Test: `test/appjs-smoke.test.js` (a Node-loadable smoke test of the small pure helper `app.js` exports; the DOM binding is verified visually in Task 6)

**Interfaces:**
- Consumes: `window.api` (real or mock), `window.Fmt` (Task 2), `window.FormState` (Task 3).
- Produces: an IIFE that wires the DOM on `DOMContentLoaded`. It ALSO exposes one pure helper for testing via dual-export: `buildAddPayload(form): object` — turns the collected form fields into the exact `schedule:add` payload (numeric `fireAt`/`leadMs`/`durationSec`, `leadMs = leadMin*60000`, no `status` field, includes `contentItemGuid`/`scheduleGuid`/`vertical`/`title`/`fileName`/`filePath`). Wiring behaviors:
  - On load: `engine:selfCheck` → alert bar if not ok; `settings:get` → fill Setup; `schedule:list` → render; subscribe `onScheduleChanged` → re-render + toggle the live bar; tick the clock.
  - `btnNew`/`btnCancel` show/hide the form; the form starts in spotlight phase.
  - `btnPickVideo` → `dialog:openFile` (video filters) → `probe:file`; on `{ok:true}` store filePath/durationSec/vertical(height>width) + show fileCheck ("✓ 30:00 · Widescreen"); on `{ok:false}` show the plain-English error and stay in spotlight. After any change, recompute `FormState.computeFormPhase` and apply `spotlight/collapsed` + `.form-dim` on `#restOfForm` + Save disabled + `pickedSummary`.
  - `btnChangeVideo` clears the pick → back to spotlight.
  - `btnEvPortalCheck` → `portal:checkLink(link)` → on ok store contentItemGuid/scheduleGuid, set `linkChecked=true`, show "✓ Connect · Widescreen"; recompute phase.
  - `btnSave` (enabled only when `canSave`) → `schedule:add(buildAddPayload(...))` → hide form, reset.
  - Schedule list: render upcoming (pending/starting/preshow/playing) with `Fmt.statusPill` + `Fmt.fmtDateTime` + `Fmt.endsAround`; a Remove button per pending row → `schedule:remove(id)`; past events (done/failed/missed) in the history list.
  - Live bar: shown when any event is starting/preshow/playing; `btnStopNow`/row Stop → `schedule:stop(id)`.
  - Setup: `btnPickSlateImage`/`btnPickSlateMusic` → `dialog:openFile` → fill the field; `btnSetupDone` → `settings:save({slateImage,slateMusic,fadeMs,videoBitrate,portalEmail,portalApiKey})` then, if the password field is non-empty, `secret:setPassword(pw)` and clear the field; `btnPortalTest` → `portal:testLogin({email,password,apiKey})` → show `{ok}`/error (handle `{ok:false}` as an error message, per the Plan-3 binding).
  - `btnTheme` toggles `data-theme` dark/light.

- [ ] **Step 1: Write the failing smoke test (the pure payload helper)**

`test/appjs-smoke.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// app.js guards all DOM/window use behind DOMContentLoaded + typeof checks, so it
// loads cleanly under Node and exposes buildAddPayload for testing.
const { buildAddPayload } = require('../renderer/app.js');

test('buildAddPayload produces a well-formed schedule:add payload', () => {
  const p = buildAddPayload({
    filePath: '/vids/ride.mp4', fileName: 'ride.mp4', durationSec: 1800, vertical: false,
    fireAt: 1893000000000, leadMin: 5, autoStop: true, repeatWeekly: true,
    contentItemGuid: 'ci', scheduleGuid: 'sg', title: 'Evening Ride',
  });
  assert.equal(p.leadMs, 5 * 60000);
  assert.equal(p.fireAt, 1893000000000);
  assert.equal(p.durationSec, 1800);
  assert.equal(p.autoStop, true); assert.equal(p.repeatWeekly, true);
  assert.equal(p.contentItemGuid, 'ci'); assert.equal(p.scheduleGuid, 'sg');
  assert.equal(p.filePath, '/vids/ride.mp4'); assert.equal(p.title, 'Evening Ride');
  assert.equal('status' in p, false, 'renderer never sets status — the brain defaults it');
  assert.equal(typeof p.fireAt, 'number'); assert.equal(typeof p.leadMs, 'number'); assert.equal(typeof p.durationSec, 'number');
});

test('buildAddPayload coerces/guards missing optionals', () => {
  const p = buildAddPayload({ filePath: '/v.mp4', fileName: 'v.mp4', durationSec: 10, fireAt: 1, leadMin: 0 });
  assert.equal(p.leadMs, 0); assert.equal(p.autoStop, true);           // default on
  assert.equal(p.repeatWeekly, false); assert.equal(p.title, '');
  assert.equal(p.vertical, false); assert.equal(p.contentItemGuid, '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/appjs-smoke.test.js` → FAIL (module missing / not exported).

- [ ] **Step 3: Implement `renderer/app.js`**

Write the controller as one IIFE. Guard ALL DOM/window access behind `typeof document !== 'undefined'` so the file `require()`s cleanly in Node (exporting only `buildAddPayload`). Key skeleton (fill in each wiring block per the Interfaces list — every `$id` below is from `index.html`):

```js
'use strict';
// The renderer's DOM controller. All brain access goes through window.api
// (real preload bridge in Electron, or the mock in a browser). Pure helpers are
// dual-exported for tests; everything DOM runs only after DOMContentLoaded.

function buildAddPayload(f) {
  return {
    title: f.title || '',
    fileName: f.fileName || '', filePath: f.filePath || '', durationSec: Number(f.durationSec) || 0,
    vertical: !!f.vertical,
    contentItemGuid: f.contentItemGuid || '', scheduleGuid: f.scheduleGuid || '',
    fireAt: Number(f.fireAt) || 0, leadMs: (Number(f.leadMin) || 0) * 60000,
    autoStop: f.autoStop === undefined ? true : !!f.autoStop,
    repeatWeekly: !!f.repeatWeekly,
  };
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const F = window.Fmt, FS = window.FormState;

  // form working state
  const form = { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', linkChecked: false };

  function applyPhase() {
    const state = { filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked };
    const ph = FS.computeFormPhase(state);
    $('step1').className = 'field ' + ph.step1;
    $('restOfForm').className = ph.rest === 'dim' ? 'form-dim' : '';
    $('pickedSummary').textContent = ph.step1 === 'collapsed' ? '✓ ' + FS.pickedSummary(state) : '';
    $('btnSave').disabled = !ph.canSave;
    $('btnSave').title = ph.canSave ? '' : ph.reasons.join('  •  ');
  }

  function recomputeFireAt() {
    form.fireAt = F.parseDateTime($('evDate').value, $('evHour').value, $('evMin').value, $('evAP').value) || 0;
    applyPhase();
  }

  async function pickVideo() {
    const path = await api.invoke('dialog:openFile', { kind: 'video' });
    if (!path) return;
    const pr = await api.invoke('probe:file', path);
    if (!pr.ok) { $('fileCheck').textContent = '✗ ' + pr.error; $('fileCheck').className = 'pickstatus bad'; return; }
    form.filePath = path; form.fileName = path.split(/[\\/]/).pop(); form.durationSec = pr.durationSec; form.vertical = pr.height > pr.width;
    $('fileCheck').textContent = '✓ ' + F.orientationLabel(form.vertical); $('fileCheck').className = 'pickstatus good';
    applyPhase();
  }

  async function checkLink() {
    const r = await api.invoke('portal:checkLink', $('evPortalLink').value.trim());
    if (!r.ok) { $('evPortalStatus').textContent = '✗ ' + r.error; $('evPortalStatus').className = 'pickstatus bad'; form.linkChecked = false; applyPhase(); return; }
    form.contentItemGuid = r.contentItemGuid; form.scheduleGuid = r.scheduleGuid || ''; form.vertical = r.vertical; form.linkChecked = true;
    $('evPortalStatus').textContent = '✓ ' + (r.picked && r.picked.stationName ? r.picked.stationName + ' · ' : '') + F.orientationLabel(r.vertical);
    $('evPortalStatus').className = 'pickstatus good'; applyPhase();
  }

  async function save() {
    const ph = FS.computeFormPhase({ filePath: form.filePath, durationSec: form.durationSec, fireAt: form.fireAt, contentItemGuid: form.contentItemGuid, linkChecked: form.linkChecked });
    if (!ph.canSave) { $('formError').textContent = ph.reasons.join('  '); return; }   // never trust the disabled attribute alone
    $('formError').textContent = '';
    const payload = buildAddPayload({ ...form, leadMin: parseInt($('evLead').value, 10) || 0, autoStop: $('evAutoStop').checked, repeatWeekly: $('evRepeat').checked, title: $('evTitle').value.trim() });
    await api.invoke('schedule:add', payload);
    hideForm();
  }

  function renderList(events) {
    const up = events.filter((e) => ['pending', 'starting', 'preshow', 'playing'].includes(e.status));
    const past = events.filter((e) => ['done', 'failed', 'missed'].includes(e.status));
    const live = up.find((e) => ['starting', 'preshow', 'playing'].includes(e.status));
    $('liveBar').className = live ? '' : 'hidden';
    $('upcomingList').innerHTML = '';
    for (const ev of up.sort((a, b) => a.fireAt - b.fireAt)) $('upcomingList').appendChild(row(ev, true));
    $('historyList').innerHTML = '';
    for (const ev of past.sort((a, b) => b.doneAt - a.doneAt)) $('historyList').appendChild(row(ev, false));
  }

  function row(ev, upcoming) {
    const el = document.createElement('div'); el.className = 'schedrow';
    const pill = F.statusPill(ev);
    const title = ev.title || ev.fileName || '(video)';
    el.innerHTML = '<span class="pill ' + pill.kind + '">' + escapeHtml(pill.label) + '</span> <b>' + escapeHtml(title) + '</b> <span class="meta">' + F.fmtDateTime(ev.fireAt) + '</span> <span class="meta">' + escapeHtml(F.endsAround(ev)) + '</span>';
    if (upcoming) {
      if (['starting', 'preshow', 'playing'].includes(ev.status)) { const s = btn('Stop', () => api.invoke('schedule:stop', ev.id)); el.appendChild(s); }
      else { const r = btn('Remove', async () => { const res = await api.invoke('schedule:remove', ev.id); if (!res.ok) alert(res.error); }); el.appendChild(r); }
    }
    return el;
  }

  function btn(label, fn) { const b = document.createElement('button'); b.className = 'btn-quiet btn-small'; b.textContent = label; b.onclick = fn; return b; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function showForm() { $('formCard').className = 'card'; resetForm(); }
  function hideForm() { $('formCard').className = 'card hidden'; }
  function resetForm() {
    Object.assign(form, { filePath: '', fileName: '', durationSec: 0, vertical: false, fireAt: 0, contentItemGuid: '', scheduleGuid: '', linkChecked: false });
    for (const id of ['evDate', 'evPortalLink', 'evTitle']) $(id).value = '';
    $('evLead').value = '0'; $('evAutoStop').checked = true; $('evRepeat').checked = false;
    $('fileCheck').textContent = ''; $('evPortalStatus').textContent = '';
    applyPhase();
  }

  async function loadSetup() {
    const s = await api.invoke('settings:get');
    $('setSlateImage').value = s.slateImage || ''; $('setSlateMusic').value = s.slateMusic || '';
    $('setFade').value = String(s.fadeMs || 1000);
    const presets = ['2500', '4500', '6000'];
    if (presets.includes(String(s.videoBitrate))) { $('setBitratePreset').value = String(s.videoBitrate); $('setBitrateCustom').style.display = 'none'; }
    else { $('setBitratePreset').value = 'custom'; $('setBitrateCustom').style.display = ''; $('setBitrateCustom').value = s.videoBitrate; }
    $('setPortalEmail').value = s.portalEmail || ''; $('setPortalApiKey').value = s.portalApiKey || '';
  }
  function chosenBitrate() { const p = $('setBitratePreset').value; return p === 'custom' ? (parseInt($('setBitrateCustom').value, 10) || 6000) : parseInt(p, 10); }
  async function saveSetup() {
    await api.invoke('settings:save', { slateImage: $('setSlateImage').value, slateMusic: $('setSlateMusic').value, fadeMs: parseInt($('setFade').value, 10), videoBitrate: chosenBitrate(), portalEmail: $('setPortalEmail').value.trim(), portalApiKey: $('setPortalApiKey').value.trim() });
    const pw = $('setPortalPassword').value; if (pw) { await api.invoke('secret:setPassword', pw); $('setPortalPassword').value = ''; }
    showView('main');
  }
  async function testLogin() {
    $('portalTestResult').textContent = 'Testing…';
    const r = await api.invoke('portal:testLogin', { email: $('setPortalEmail').value.trim(), password: $('setPortalPassword').value, apiKey: $('setPortalApiKey').value.trim() });
    if (!r.ok) { $('portalTestResult').textContent = '✗ ' + (r.error || 'Login failed'); $('portalTestResult').className = 'pickstatus bad'; return; }
    $('portalTestResult').textContent = '✓ Signed in — ' + (r.stations ? r.stations.length : 0) + ' studios found'; $('portalTestResult').className = 'pickstatus good';
  }

  function showView(which) { $('viewMain').className = which === 'main' ? '' : 'hidden'; $('viewSetup').className = which === 'setup' ? '' : 'hidden'; }

  async function init() {
    // time-picker options
    const { hours, minutes } = F.buildTimeOptions();
    for (const h of hours) $('evHour').add(new Option(h, h));
    for (const m of minutes) $('evMin').add(new Option(m, m));
    // engine status
    const chk = await api.invoke('engine:selfCheck');
    if (!chk.ok) { $('alertBar').textContent = '⚠ The video engine isn’t ready: ' + (chk.error || '') ; $('alertBar').className = 'alert bad'; }
    $('engineStatus').textContent = chk.ok ? ('Video engine ready — ' + (chk.version || 'bundled FFmpeg')) : ('Video engine problem: ' + (chk.error || ''));
    // wire buttons
    $('btnNew').onclick = showForm; $('btnCancel').onclick = hideForm;
    $('btnPickVideo').onclick = pickVideo; $('btnChangeVideo').onclick = () => { form.filePath = ''; form.durationSec = 0; $('fileCheck').textContent = ''; applyPhase(); };
    for (const id of ['evDate', 'evHour', 'evMin', 'evAP']) $(id).addEventListener('change', recomputeFireAt);
    $('btnEvPortalCheck').onclick = checkLink; $('btnSave').onclick = save;
    $('btnGear').onclick = () => { loadSetup(); showView('setup'); }; $('btnSetupDone').onclick = saveSetup;
    $('btnPortalTest').onclick = testLogin;
    $('btnPickSlateImage').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'image' }); if (p) $('setSlateImage').value = p; };
    $('btnPickSlateMusic').onclick = async () => { const p = await api.invoke('dialog:openFile', { kind: 'audio' }); if (p) $('setSlateMusic').value = p; };
    $('setBitratePreset').addEventListener('change', () => { $('setBitrateCustom').style.display = $('setBitratePreset').value === 'custom' ? '' : 'none'; });
    $('btnStopNow').onclick = async () => { const evs = await api.invoke('schedule:list'); const live = evs.find((e) => ['starting', 'preshow', 'playing'].includes(e.status)); if (live) api.invoke('schedule:stop', live.id); };
    $('btnTheme').onclick = () => { const el = document.documentElement; el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); };
    // clock
    setInterval(() => { $('clockNow').textContent = F.fmtClock(Date.now()); }, 1000); $('clockNow').textContent = F.fmtClock(Date.now());
    // schedule
    renderList(await api.invoke('schedule:list'));
    api.onScheduleChanged((events) => renderList(events));
    showView('main');            // assert the starting view — never rely on the HTML default
    resetForm();
  }
  document.addEventListener('DOMContentLoaded', init);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildAddPayload };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/appjs-smoke.test.js` → 2 passing.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 110 tests, 0 fail.
```bash
git add renderer/app.js test/appjs-smoke.test.js
git commit -m "feat: renderer DOM controller (spotlight form, schedule list, setup, live bar)"
```

---

### Task 6: Wire the renderer into Electron + native file dialog + controller visual gate

**Files:**
- Modify: `app/main.js` (load `renderer/index.html`; add the `dialog:openFile` channel; apply the Plan-3 main.js Minors)
- Create: `.claude/launch.json` (a static server for browser preview)
- Read for reference: `app/main.js`, `app/preload.js`

**Interfaces:**
- `dialog:openFile` (registered in main.js — needs Electron `dialog` + `BrowserWindow`, so it lives in main.js, NOT the pure `app/ipc.js`): `(payload: {kind}) => Promise<string>` — opens a native open dialog filtered by `kind` (`'video'` → mp4/mov/mkv/…; `'image'` → png/jpg; `'audio'` → mp3/m4a/wav), returns the chosen absolute path or `''` if cancelled.
- main.js: point the existing `win.loadFile(...)` at `renderer/index.html`; add the dialog handler; apply the Plan-3 Minors (`if (!gotLock) { app.quit(); return; }`, drop `sandbox:false`).

- [ ] **Step 1: Read the current wiring**

Run: `sed -n '1,90p' app/main.js` — find the `win.loadFile`/`loadURL` call and the `webPreferences`, and confirm the ipc registration loop from Plan 3.

- [ ] **Step 2: Point the window at the renderer + add the dialog channel**

In `app/main.js`, change the window load to `win.loadFile(require('node:path').join(__dirname, '..', 'renderer', 'index.html'))` (match the real var name). Add, alongside the Plan-3 `ipcMain.handle` loop:
```js
const { dialog } = require('electron');
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
```
Apply the Plan-3 Minors: `const gotLock = app.requestSingleInstanceLock(); if (!gotLock) { app.quit(); return; }` and remove `sandbox: false` from `webPreferences` (keep `preload`, `contextIsolation: true`, `nodeIntegration: false`).

- [ ] **Step 3: Create `.claude/launch.json` for browser preview**

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "renderer-preview", "runtimeExecutable": "npx", "runtimeArgs": ["--yes", "http-server", "renderer", "-p", "4599", "-c-1"], "port": 4599 }
  ]
}
```

- [ ] **Step 4: Syntax-check + suite + commit**

Run: `node --check app/main.js` → clean. `npm test` → 110, 0 fail.
```bash
git add app/main.js .claude/launch.json
git commit -m "feat: load renderer in Electron, native file dialog channel, single-instance guard"
```

- [ ] **Step 5: Controller visual gate (NOT a subagent step — the controller runs this)**

The controller starts the preview server (`renderer-preview`), then verifies with the preview tools against the mock api:
1. Main view renders: topbar, "Schedule a video", empty schedule, clock ticking; dark theme by default; toggle to light works.
2. Open the form → **step 1 is the spotlight** (accented, enlarged), steps 2–4 + link + options are **dimmed**, Save disabled.
3. Click "Choose the video…" (mock returns a path + probe) → step 1 **collapses to "✓ class.mp4 · Widescreen (16:9)"**, the rest **activates**, Save still disabled (no time/link yet).
4. Set date/time, paste a link, "Check this class link" (mock → ✓ Connect) → Save **enables**; click it → row appears in Schedule with a "Scheduled" pill and "ends around …".
5. Setup view: three sections only (slate / quality / portal), engine status line green, "Test login" (mock → ✓ studios), Save & finish returns to main.
6. Screenshot main + form(spotlight) + form(collapsed) + setup for the user.
Fix any visual/behavioral defects by editing `renderer/*` and re-checking before declaring done.

---

## Definition of Done (Plan 4)

- `npm test` — 110 tests, 0 fail, fully offline. Pure renderer logic (mock api, formatters, spotlight state machine, add-payload) is unit-tested; DOM binding is verified visually.
- Controller visual gate passed (Task 6 Step 5): the UI renders faithfully in the Cinematic Dark theme, the spotlight-step-1 flow works end-to-end against the mock (spotlight → pick → collapse → activate → save), and Setup shows the three 2.0 sections with no OBS remnants. Screenshots shared with the user.
- The renderer talks only to the Plan 3 IPC channels (+ `dialog:openFile`); no stream key or password is ever read into the renderer; the password field is write-only and cleared after save.
- Everything committed; engine/portal/store/scheduler suites from Plans 1–3 untouched and still green.

**What Plan 5 picks up:** electron-builder packaging — unsigned Mac DMG + Windows NSIS, the bundled per-OS FFmpeg included as a resource, startup `selfCheck` surfaced to the operator, the one-time "Open Anyway"/SmartScreen unblock documented, and a bootstrap README (fresh clone → `fetch-ffmpeg` → `fixtures` → run).
