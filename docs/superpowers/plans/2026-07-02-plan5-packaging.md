# Stream Scheduler 2.0 — Plan 5: Packaging & Distribution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working app on `main` into double-clickable, unsigned installers — a universal Mac DMG (+ZIP) and a Windows NSIS installer — with FFmpeg bundled inside, a packaged-app self-check gate, the spec'd in-app update NOTICE, and plain-English install docs for non-technical staff.

**Architecture:** electron-builder packages the app code into an asar archive while the FFmpeg/ffprobe binaries ship OUTSIDE it as `extraResources` (binaries cannot execute from inside an asar). The engine's resolver gains one new candidate — `process.resourcesPath/ffmpeg/<platform>/` — checked FIRST, so the packaged app finds its bundled engine while dev mode keeps using the repo's `resources/` dir. A `--selfcheck` headless flag makes the PACKAGED app provable from a script. The update notice is a pure module (injected fetch) hitting the GitHub releases API, degrading silently when offline or when the repo doesn't exist yet.

**Tech Stack:** electron-builder (devDependency — the ONLY new dependency; zero runtime deps remains true), the existing static-FFmpeg fetch script extended with mac-x64 (for the universal build), Node 26 built-ins for everything testable.

**Spec:** `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md` §8 (electron-builder, UNSIGNED, Mac universal DMG/ZIP + Windows NSIS, GitHub releases distribution, in-app update NOTICE via GitHub API — no auto-update, documented one-time "Open Anyway"/SmartScreen unblock, design must allow signing later).

## Global Constraints

- **Unsigned, by explicit user decision** (no Apple Developer budget): no signing/notarization config anywhere, but nothing that would BLOCK adding it later (no ad-hoc hacks). The one-time unblock is documented in plain English instead.
- Zero runtime npm dependencies stays true — electron + electron-builder are devDependencies only.
- App identity: `productName` **"Stream Scheduler 2"**, `appId` **`com.echelonfit.stream-scheduler2`**, version **2.0.0** — distinct from 1.x so the two can never be confused on a station (and per rollout law they never run on the same station).
- The bundled FFmpeg resolution order becomes: **packaged resources → repo resources (dev) → /opt/homebrew/bin → /usr/local/bin → PATH**. Never throws; `selfCheck()` stays the authoritative gate.
- Update NOTICE only (spec): a quiet banner when a newer GitHub release exists; NO downloading, NO auto-update, silent no-op on any failure (offline, 404, rate-limit, repo not created yet). Repo constant: `justingonz96-creator/stream-scheduler-2` (private repo — unauthenticated API returns 404 until it exists/is public to the token-less call; that silent no-op is the designed behavior until releases go up).
- Renderer channel law: adding `update:check` means updating the preload ALLOWLIST, the mock, and the ipc handler map together — they must stay in lockstep.
- Docs are for **non-technical operators**: exact clicks, no jargon.
- `npm test` = `node --test`; suite is 111/111 at plan start and must stay green. Publishing anything to GitHub is OUT of scope for the automated tasks — the controller presents the built artifacts and asks the user before any release upload (outward-facing action).

---

### Task 1: Packaged FFmpeg resolution (`engine/ffmpeg.js`)

**Files:**
- Modify: `engine/ffmpeg.js` (the `resolveTool` candidates)
- Test: `test/ffmpeg.test.js` (add two tests; keep existing ones)

**Interfaces:**
- Unchanged exports: `ffmpegPath()`, `ffprobePath()`, `selfCheck()`. New behavior only: when `process.resourcesPath` is set (every packaged Electron app sets it; plain Node does not), `<resourcesPath>/ffmpeg/<platform>/<tool>` is checked FIRST.

- [ ] **Step 1: Write the failing tests** (append to `test/ffmpeg.test.js`)

```js
test('packaged app: process.resourcesPath candidate wins when present', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2-res-'));
  const platDir = process.platform === 'win32' ? 'win-x64' : (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64');
  const dir = path.join(fake, 'ffmpeg', platDir);
  fs.mkdirSync(dir, { recursive: true });
  const tool = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(tool, '#!/bin/sh\n'); fs.chmodSync(tool, 0o755);
  const orig = process.resourcesPath;
  try {
    process.resourcesPath = fake;                       // simulate the packaged app
    delete require.cache[require.resolve('../engine/ffmpeg')];
    const ff = require('../engine/ffmpeg');
    assert.equal(ff.ffmpegPath(), tool, 'the packaged location must win');
  } finally {
    if (orig === undefined) delete process.resourcesPath; else process.resourcesPath = orig;
    delete require.cache[require.resolve('../engine/ffmpeg')];
  }
});

test('dev mode: without resourcesPath the repo/system resolution still works', () => {
  delete require.cache[require.resolve('../engine/ffmpeg')];
  const ff = require('../engine/ffmpeg');
  assert.ok(ff.ffmpegPath().length > 0);                // same guarantee as before
});
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `node --test test/ffmpeg.test.js` → the packaged-candidate test FAILS (resolver ignores resourcesPath).

- [ ] **Step 3: Implement** — in `engine/ffmpeg.js`, replace the `cands` array in `resolveTool`:

```js
  const cands = [
    // Packaged app: electron-builder's extraResources puts the binaries at
    // <resourcesPath>/ffmpeg/<platform>/ — OUTSIDE the asar, so they can execute.
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'ffmpeg', PLATFORM_DIR, tool + EXT)] : []),
    path.join(__dirname, '..', 'resources', 'ffmpeg', PLATFORM_DIR, tool + EXT),   // dev checkout
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    tool, // PATH fallback
  ];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ffmpeg.test.js` → all pass (2 new + existing).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 113 tests, 0 fail.
```bash
git add engine/ffmpeg.js test/ffmpeg.test.js
git commit -m "feat: resolve bundled ffmpeg from the packaged app's resources dir first"
```

---

### Task 2: mac-x64 in the fetch script (universal build needs both Mac arches)

**Files:**
- Modify: `scripts/fetch-ffmpeg.sh`

- [ ] **Step 1: Extend the mac section** — generalize the mac loop to fetch BOTH arches from Martin Riedl's static builds (`https://ffmpeg.martin-riedl.de/`): current pattern downloads `.../macos/arm64/<build>/ffmpeg.zip` style URLs; add the `macos/amd64` equivalents into `$DEST/mac-x64/` with the same already-present skip, unzip, chmod +x flow. Keep win-x64 untouched. (Read the existing script first and mirror its exact URL/build-id pattern for amd64 — the site serves both arches with identical path shapes.)

- [ ] **Step 2: Run it** (network; idempotent)

Run: `bash scripts/fetch-ffmpeg.sh`
Expected: `resources/ffmpeg/mac-arm64/` (already present, skipped), `resources/ffmpeg/mac-x64/ffmpeg + ffprobe` (downloaded, executable), `resources/ffmpeg/win-x64/ffmpeg.exe + ffprobe.exe` (downloaded).
Verify: `file resources/ffmpeg/mac-x64/ffmpeg` reports `x86_64`; `resources/ffmpeg/mac-x64/ffmpeg -version` runs (Rosetta) or at minimum `file` confirms the arch.

- [ ] **Step 3: Suite + commit**

Run: `npm test` → 113, 0 fail.
```bash
git add scripts/fetch-ffmpeg.sh
git commit -m "feat: fetch mac-x64 ffmpeg too (universal Mac build ships both arches)"
```

---

### Task 3: `--selfcheck` headless mode in `app/main.js`

**Files:**
- Modify: `app/main.js` (top, BEFORE the single-instance lock)

**Interfaces:**
- `"/path/to/Stream Scheduler 2" --selfcheck` → prints one JSON line `{"ok":true,"version":"..."}` (or `ok:false` + error), exits 0/1, never opens a window, never takes the single-instance lock (so it can run beside a running app).

- [ ] **Step 1: Implement** — insert immediately after the requires, before the lock:

```js
// Headless self-check: `--selfcheck` proves the packaged app can find and run
// its bundled FFmpeg, with no window and no single-instance lock. Used by the
// packaging gate and by support ("run this and send me the line it prints").
if (process.argv.includes('--selfcheck')) {
  ffmpeg.selfCheck().then((r) => {
    console.log(JSON.stringify(r));
    app.exit(r.ok ? 0 : 1);
  });
} else {
  // ... (the existing gotLock/app.whenReady flow wraps here unchanged)
}
```
(Match the file's real structure: the guard must ensure the normal startup — lock, window, scheduler — runs only in the else branch. `ffmpeg` and `app` are already required in this file.)

- [ ] **Step 2: Verify in dev mode**

Run: `node --check app/main.js` → clean. `npx electron . --selfcheck` → one JSON line with `"ok":true`, exit 0 (verify `echo $?`).

- [ ] **Step 3: Suite + commit**

Run: `npm test` → 113, 0 fail.
```bash
git add app/main.js
git commit -m "feat: --selfcheck headless mode (packaged-app engine proof)"
```

---

### Task 4: Update notice (spec §8) — module, channel, banner

**Files:**
- Create: `store/update-check.js`
- Modify: `app/ipc.js` (add `update:check`), `app/preload.js` (ALLOWLIST +1), `renderer/mockapi.js` (channel +1), `renderer/app.js` (banner on load), `app/main.js` (pass deps)
- Test: `test/update-check.test.js` (new), `test/ipc.test.js` (channel-list test update)

**Interfaces:**
- `store/update-check.js`: `checkForUpdate({ currentVersion, fetchImpl, repo = 'justingonz96-creator/stream-scheduler-2' }): Promise<{hasUpdate:boolean, latestVersion?:string, url?:string}>` — GETs `https://api.github.com/repos/<repo>/releases/latest` via the injected `fetchImpl`, compares `tag_name` (tolerating a `v` prefix) against `currentVersion` numerically per dotted segment, returns `{hasUpdate:false}` on ANY failure (non-200, bad JSON, malformed tag, thrown fetch). Never throws. Dual behavior not needed (main-process only, plain CommonJS).
- ipc: `'update:check': async () => checkForUpdate({ currentVersion: app.getVersion(), fetchImpl: fetch })` — wired in main.js by passing `{ updates: { check: () => checkForUpdate({...}) } }` into `createIpcHandlers` and adding the handler entry `'update:check': async () => updates.check()`.
- renderer: after the engine self-check in `init()`, `api.invoke('update:check')` → if `hasUpdate`, set `alertBar` to `className='alert warn'`, text `'A newer version (vX.Y.Z) is available — ask the admin to update this computer.'`. Mock returns `{hasUpdate:false}`.

- [ ] **Step 1: Write the failing tests**

`test/update-check.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkForUpdate } = require('../store/update-check');

const fake = (status, body) => async () => ({ status, ok: status === 200, json: async () => body, text: async () => JSON.stringify(body) });

test('newer release → hasUpdate with version and url', async () => {
  const r = await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'v2.1.0', html_url: 'https://x/rel' }) });
  assert.deepEqual(r, { hasUpdate: true, latestVersion: '2.1.0', url: 'https://x/rel' });
});
test('same or older release → no update', async () => {
  assert.equal((await checkForUpdate({ currentVersion: '2.1.0', fetchImpl: fake(200, { tag_name: 'v2.1.0', html_url: 'u' }) })).hasUpdate, false);
  assert.equal((await checkForUpdate({ currentVersion: '2.1.0', fetchImpl: fake(200, { tag_name: 'v2.0.9', html_url: 'u' }) })).hasUpdate, false);
  assert.equal((await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'v2.0.10', html_url: 'u' }) })).hasUpdate, true, 'numeric not lexicographic (10 > 9)');
});
test('failures are silent no-ops: 404, garbage tag, thrown fetch', async () => {
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(404, {}) }), { hasUpdate: false });
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: fake(200, { tag_name: 'not-a-version' }) }), { hasUpdate: false });
  assert.deepEqual(await checkForUpdate({ currentVersion: '2.0.0', fetchImpl: async () => { throw new Error('offline'); } }), { hasUpdate: false });
});
```
And in `test/ipc.test.js`, add `'update:check'` to the expected channel list and `updates: { check: async () => ({ hasUpdate: false }) }` to the handler fixture (the map test asserts the exact channel set).

- [ ] **Step 2: Run to verify failures** — `node --test test/update-check.test.js` (module missing) and `node --test test/ipc.test.js` (channel-list mismatch after the list edit).

- [ ] **Step 3: Implement**

`store/update-check.js`:
```js
'use strict';
// The spec'd update NOTICE (§8): ask GitHub for the latest release, say so
// quietly if it's newer. NEVER throws, NEVER blocks startup, no auto-update.
function parseVer(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function newer(a, b) {   // a > b ?
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
async function checkForUpdate({ currentVersion, fetchImpl, repo = 'justingonz96-creator/stream-scheduler-2' }) {
  try {
    const res = await fetchImpl('https://api.github.com/repos/' + repo + '/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res || res.status !== 200) return { hasUpdate: false };
    const body = await res.json();
    const latest = parseVer(body && body.tag_name);
    const cur = parseVer(currentVersion);
    if (!latest || !cur || !newer(latest, cur)) return { hasUpdate: false };
    return { hasUpdate: true, latestVersion: latest.join('.'), url: (body && body.html_url) || '' };
  } catch { return { hasUpdate: false }; }
}
module.exports = { checkForUpdate };
```
Wiring: `app/ipc.js` — `createIpcHandlers({ ..., updates })` + entry `'update:check': async () => updates.check()`. `app/preload.js` — add `'update:check'` to ALLOWED. `renderer/mockapi.js` — `case 'update:check': return { hasUpdate: false };`. `app/main.js` — `const { checkForUpdate } = require('../store/update-check');` and pass `updates: { check: () => checkForUpdate({ currentVersion: app.getVersion(), fetchImpl: fetch }) }`. `renderer/app.js` — in `init()` after the selfCheck block:
```js
    try {
      const upd = await api.invoke('update:check');
      // Never clobber a more important engine-failure alert with the update notice.
      if (upd && upd.hasUpdate && $('alertBar').className !== 'alert bad') { $('alertBar').textContent = 'A newer version (v' + upd.latestVersion + ') is available — ask the admin to update this computer.'; $('alertBar').className = 'alert warn'; }
    } catch {}
```

- [ ] **Step 4: Run tests to verify they pass** — `node --test test/update-check.test.js test/ipc.test.js` → all pass.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → 116 tests, 0 fail (113 + the 3 update-check tests; the ipc edits modify existing tests).
```bash
git add store/update-check.js app/ipc.js app/preload.js renderer/mockapi.js renderer/app.js app/main.js test/update-check.test.js test/ipc.test.js
git commit -m "feat: update notice via GitHub releases (silent no-op on any failure)"
```

---

### Task 5: electron-builder configuration

**Files:**
- Modify: `package.json` (version, devDependency, `build` block, `dist:*` scripts)

- [ ] **Step 1: Install the builder**

Run: `npm install --save-dev electron-builder` (devDependency only; verify `dependencies` stays absent from package.json).

- [ ] **Step 2: Configure** — in `package.json`: set `"version": "2.0.0"`, `"productName": "Stream Scheduler 2"`, add scripts `"dist:mac": "electron-builder --mac"`, `"dist:win": "electron-builder --win"`, and the `build` block:

```json
"build": {
  "appId": "com.echelonfit.stream-scheduler2",
  "productName": "Stream Scheduler 2",
  "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
  "files": ["app/**", "engine/**", "portal/**", "schedule/**", "store/**", "renderer/**", "package.json"],
  "asar": true,
  "npmRebuild": false,
  "mac": {
    "target": [{ "target": "dmg", "arch": ["universal"] }, { "target": "zip", "arch": ["universal"] }],
    "category": "public.app-category.video",
    "extraResources": [
      { "from": "resources/ffmpeg/mac-arm64", "to": "ffmpeg/mac-arm64" },
      { "from": "resources/ffmpeg/mac-x64", "to": "ffmpeg/mac-x64" }
    ]
  },
  "dmg": { "writeUpdateInfo": false },
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "extraResources": [{ "from": "resources/ffmpeg/win-x64", "to": "ffmpeg/win-x64" }]
  },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "perMachine": false }
}
```
Notes: NO `mergeASARs`-breaking native deps exist (zero runtime deps), so the universal merge is safe; both mac arch dirs ship so `process.arch` picks at runtime (Task 1 resolver). No signing config (unsigned by decision). No `publish` block (releases are uploaded manually with user consent).

- [ ] **Step 3: Verify + commit** (build runs in Task 6, by the controller)

Run: `npm test` → 116, 0 fail. `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` → clean.
```bash
git add package.json package-lock.json
git commit -m "feat: electron-builder config — unsigned universal Mac DMG/ZIP + Windows NSIS, bundled ffmpeg"
```

---

### Task 6: Operator + developer docs

**Files:**
- Create: `README.md`, `docs/INSTALL.md`

- [ ] **Step 1: `README.md`** (developer bootstrap — concise): what the app is (one paragraph, points at the spec); fresh-clone setup `npm install` → `bash scripts/fetch-ffmpeg.sh` → `npm run fixtures` → `npm test`; run `npm run start`; rehearsals `npm run rehearsal`, `rehearsal:resume`, `rehearsal:brain` (mediamtx required: `brew install mediamtx`); build `npm run dist:mac` / `dist:win`; repo layout table (engine/portal/schedule/store/renderer/app, one line each); the plans/specs live under `docs/superpowers/`.

- [ ] **Step 2: `docs/INSTALL.md`** (for non-technical staff, plain English, numbered clicks):
- **Mac:** download the DMG → open it → drag "Stream Scheduler 2" to Applications → FIRST launch: right-click (or Control-click) the app → **Open** → in the warning box press **Open** ("this is a one-time step — the app isn't signed with Apple, and this tells your Mac you trust it"; on newer macOS: System Settings → Privacy & Security → scroll to the blocked-app note → **Open Anyway**). After that it opens normally forever.
- **Windows:** download the installer → run it → if a blue **"Windows protected your PC"** box appears: click **More info** → **Run anyway** (one-time, same reason) → follow the installer.
- **First-time setup in the app** (both): open **Setup** → pick the slate picture and waiting music (optional) → choose the streaming quality → enter the content-portal email and password → **Test login** (wait for the green check) → **Save & finish**.
- What the update banner means ("ask the admin").

- [ ] **Step 3: Commit**

```bash
git add README.md docs/INSTALL.md
git commit -m "docs: developer bootstrap README + plain-English install guide (Open Anyway / SmartScreen)"
```

---

## Definition of Done (Plan 5) — controller-run gates

1. `npm test` → 116, 0 fail.
2. `npm run dist:mac` → `dist/Stream Scheduler 2-2.0.0-mac-universal.dmg` (+`.zip`) builds without signing errors ("skipped macOS code signing" warnings are EXPECTED and fine).
3. **Packaged self-check gate:** run the built app binary headlessly — `"dist/mac-universal/Stream Scheduler 2.app/Contents/MacOS/Stream Scheduler 2" --selfcheck` → `{"ok":true,...}`, exit 0 — proving the PACKAGED app finds and runs its bundled FFmpeg via the Task-1 resources path (not homebrew: temporarily `PATH=/usr/bin:/bin` and confirm it still passes).
4. Bundled layout verified: `ls "dist/mac-universal/Stream Scheduler 2.app/Contents/Resources/ffmpeg/"` shows `mac-arm64/ mac-x64/`.
5. `npm run dist:win` attempted on this Mac → `dist/Stream Scheduler 2-2.0.0-win-x64.exe` (NSIS cross-builds on macOS without wine for unsigned apps). CONTINGENCY if the cross-build fails: record it in the ledger and defer the Windows artifact to a GitHub Actions build (the obs-multi-rtmp pattern) as a follow-up — not a merge blocker, the Mac pilot comes first.
6. Everything committed; the whole-branch review passes; merged to main.
7. **Publishing is a separate, user-confirmed step:** the controller presents the artifacts and asks before creating any GitHub repo/release (outward-facing).

**What comes after Plan 5 (no more plans):** pilot — install the DMG on ONE real station (never beside 1.x), run one real class end-to-end, then roll out.
