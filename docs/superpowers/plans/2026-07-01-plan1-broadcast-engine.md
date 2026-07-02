# Stream Scheduler 2.0 — Plan 1: Foundation + Broadcast Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app skeleton plus a fully proven broadcast engine: slate image + looping MP3 → timed crossfade → class video, streamed as one continuous FFmpeg encode, dress-rehearsed against a local RTMP receiver.

**Architecture:** Pure-Node engine modules (`engine/`) with no Electron dependency, testable headless via `node --test`; a minimal Electron shell (`app/`) proves the packaging foundation. FFmpeg/ffprobe are resolved from a bundled-resources path with a system fallback for development.

**Tech Stack:** Electron (shell only in this plan), Node 26 built-in test runner (`node:test`, zero test deps), FFmpeg/ffprobe static binaries, mediamtx as the local RTMP test sink.

**Spec:** `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md` (sections 4, 5, 10).

## Global Constraints

- Output normalized to **30 fps**; canvas **1920×1080** (default) or **1080×1920** (vertical / Reflect). (Spec §5)
- Ingest format: RTMP(S)/FLV; secure `rtmps://…:443/app` preferred in production. (Spec §5)
- Video: H.264 (`libx264`, `veryfast`), bitrate from settings (default 6000 kbps), keyframe every 2 s. Audio: AAC 160 kbps, 44.1 kHz stereo.
- **Verified start:** an event is "playing" only after media time is confirmed advancing; a broadcast that never starts must fail with a plain-English reason — never a false success. (Spec §5)
- **Resume:** a restarted broadcast resumes the video at the correct offset (`-ss`). (Spec §5)
- All engine modules must run **without Electron** (plain `node`), so tests stay headless.
- No new npm runtime dependencies in this plan — `electron` (dev) only. Engine uses `node:child_process`, `node:fs`, `node:path` only.
- Dev machine: macOS arm64, Node ≥ 26, Homebrew `mediamtx` present. Windows binaries are fetched but only exercised in Plan 4 (packaging).
- Plain-English error strings (non-technical operators read them).

---

### Task 1: Project scaffold + minimal Electron shell

**Files:**
- Create: `package.json`, `app/main.js`, `app/index.html`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm start` opens an empty app window titled "Stream Scheduler 2.0"; `npm test` runs `node --test test/`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "stream-scheduler-2",
  "productName": "Stream Scheduler",
  "version": "2.0.0-dev",
  "private": true,
  "main": "app/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test test/",
    "fixtures": "bash scripts/make-fixtures.sh",
    "rehearsal": "node scripts/rehearsal.js"
  }
}
```

- [ ] **Step 2: Write the minimal shell**

`app/main.js`:
```js
'use strict';
const { app, BrowserWindow } = require('electron');

// Single instance: a second launch focuses the existing window (spec §4).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 940,
    title: 'Stream Scheduler 2.0',
    webPreferences: { contextIsolation: true },
  });
  win.loadFile('app/index.html');
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
```

`app/index.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Stream Scheduler 2.0</title></head>
<body style="background:#070a0e;color:#e8f0f2;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
  <div>Stream Scheduler 2.0 — engine development build</div>
</body></html>
```

- [ ] **Step 3: Extend `.gitignore`**

Append to the existing file:
```
# Fetched binaries + generated test media
resources/ffmpeg/
test/fixtures/
test/tmp/
```

- [ ] **Step 4: Install Electron and launch once**

Run: `npm install --save-dev electron`
Then: `npm start` — expected: an empty dark window titled "Stream Scheduler 2.0" opens (close it). If launching headless/CI-style, `npx electron . --version` printing a version is sufficient.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json app/ .gitignore
git commit -m "feat: Electron scaffold with single-instance lock"
```

---

### Task 2: FFmpeg binaries + resolver module

**Files:**
- Create: `scripts/fetch-ffmpeg.sh`, `engine/ffmpeg.js`
- Test: `test/ffmpeg.test.js`

**Interfaces:**
- Produces: `require('../engine/ffmpeg')` → `{ ffmpegPath(): string, ffprobePath(): string, selfCheck(): Promise<{ok:boolean, version:string, error?:string}> }`. Resolution order: bundled `resources/ffmpeg/<platform>/` → system (`/opt/homebrew/bin`, `/usr/local/bin`, PATH). **Contract: the path getters never throw** (worst case they return the bare tool name for PATH resolution); `selfCheck()` is the authoritative gate and resolves `{ok:false, error:<plain-English>}` when no runnable FFmpeg exists. Callers spawn via these paths and surface failures through their own error handling; the packaged app runs `selfCheck()` at startup (Plan 4).

- [ ] **Step 1: Write the fetch script**

`scripts/fetch-ffmpeg.sh`:
```bash
#!/bin/bash
# Fetch static FFmpeg + ffprobe into resources/ffmpeg/<platform>/.
# mac-arm64 from Martin Riedl's static builds; win-x64 from gyan.dev (used in Plan 4).
set -e
BASE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$BASE/resources/ffmpeg"
mkdir -p "$DEST/mac-arm64" "$DEST/win-x64"

fetch_mac() {
  for tool in ffmpeg ffprobe; do
    if [ -x "$DEST/mac-arm64/$tool" ]; then echo "mac $tool: already present"; continue; fi
    curl -fsSL "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/$tool.zip" -o /tmp/ss2-$tool.zip
    unzip -oq /tmp/ss2-$tool.zip -d "$DEST/mac-arm64"; rm -f /tmp/ss2-$tool.zip
    chmod +x "$DEST/mac-arm64/$tool"
  done
}
fetch_win() {
  if [ -f "$DEST/win-x64/ffmpeg.exe" ]; then echo "win ffmpeg: already present"; return; fi
  curl -fsSL "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -o /tmp/ss2-win.zip
  unzip -oq /tmp/ss2-win.zip -d /tmp/ss2-win
  cp /tmp/ss2-win/ffmpeg-*/bin/ffmpeg.exe /tmp/ss2-win/ffmpeg-*/bin/ffprobe.exe "$DEST/win-x64/"
  rm -rf /tmp/ss2-win /tmp/ss2-win.zip
}
fetch_mac
[ "${1:-}" = "--with-windows" ] && fetch_win
echo "done"
```

- [ ] **Step 2: Write the failing test**

`test/ffmpeg.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ff = require('../engine/ffmpeg');

test('resolves runnable ffmpeg + ffprobe', async () => {
  const chk = await ff.selfCheck();
  assert.equal(chk.ok, true, chk.error || '');
  assert.match(chk.version, /^\d/);            // e.g. "8.0"
  assert.ok(ff.ffmpegPath().length > 0);
  assert.ok(ff.ffprobePath().length > 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/ffmpeg.test.js`
Expected: FAIL — `Cannot find module '../engine/ffmpeg'`.

- [ ] **Step 4: Implement `engine/ffmpeg.js`**

```js
'use strict';
// Resolve FFmpeg/ffprobe: bundled resources first, then common system spots.
// Engine modules call these; nothing else may spawn ffmpeg directly.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PLATFORM_DIR = process.platform === 'win32' ? 'win-x64'
                   : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const EXT = process.platform === 'win32' ? '.exe' : '';

function resolveTool(tool) {
  const cands = [
    path.join(__dirname, '..', 'resources', 'ffmpeg', PLATFORM_DIR, tool + EXT),
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    tool, // PATH fallback
  ];
  for (const c of cands) {
    if (c === tool) return c;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return tool;
}

function ffmpegPath() { return resolveTool('ffmpeg'); }
function ffprobePath() { return resolveTool('ffprobe'); }

function selfCheck() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, version: '', error:
          'The built-in video engine (FFmpeg) is missing or cannot run on this computer. ' +
          'Reinstall Stream Scheduler, or contact the admin.' });
        return;
      }
      const m = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve({ ok: true, version: m ? m[1] : 'unknown' });
    });
  });
}

module.exports = { ffmpegPath, ffprobePath, selfCheck };
```

- [ ] **Step 5: Fetch binaries, re-run test**

Run: `bash scripts/fetch-ffmpeg.sh` (mac only for now)
Then: `node --test test/ffmpeg.test.js`
Expected: PASS. (If the fetch URL is ever down, the test still passes via the Homebrew fallback — that's by design for dev; bundling is enforced in Plan 4.)

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-ffmpeg.sh engine/ffmpeg.js test/ffmpeg.test.js
git commit -m "feat: ffmpeg resolver with bundled-first lookup and self-check"
```

---

### Task 3: Test fixtures generator

**Files:**
- Create: `scripts/make-fixtures.sh`

**Interfaces:**
- Produces (in `test/fixtures/`, gitignored, regenerable): `slate.png` (solid red 1920×1080), `music.mp3` (5 s 440 Hz sine — shorter than any lead-in, so looping is exercised), `class.mp4` (20 s `testsrc2` pattern + 880 Hz sine, 1280×720\@30 — deliberately NOT canvas-sized, so scaling is exercised), `class-vertical.mp4` (20 s, 720×1280).

- [ ] **Step 1: Write the generator**

`scripts/make-fixtures.sh`:
```bash
#!/bin/bash
set -e
BASE="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$BASE/test/fixtures"; mkdir -p "$FIX"
FF="$BASE/resources/ffmpeg/mac-arm64/ffmpeg"; [ -x "$FF" ] || FF=ffmpeg

$FF -y -f lavfi -i color=c=red:s=1920x1080 -frames:v 1 "$FIX/slate.png"
$FF -y -f lavfi -i "sine=frequency=440:duration=5" -c:a libmp3lame -q:a 4 "$FIX/music.mp3"
$FF -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=20" \
      -f lavfi -i "sine=frequency=880:duration=20" \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$FIX/class.mp4"
$FF -y -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=20" \
      -f lavfi -i "sine=frequency=880:duration=20" \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$FIX/class-vertical.mp4"
echo "fixtures ready: $(ls "$FIX")"
```

- [ ] **Step 2: Run it**

Run: `npm run fixtures`
Expected: prints `fixtures ready: class-vertical.mp4 class.mp4 music.mp3 slate.png`.

- [ ] **Step 3: Commit**

```bash
git add scripts/make-fixtures.sh
git commit -m "feat: generated media fixtures for engine tests"
```

---

### Task 4: `engine/probe.js` — file probe (ffprobe wrapper)

**Files:**
- Create: `engine/probe.js`
- Test: `test/probe.test.js`

**Interfaces:**
- Consumes: `engine/ffmpeg.js` → `ffprobePath()`.
- Produces: `probeFile(filePath): Promise<{ok:true, durationSec:number, width:number, height:number, hasAudio:boolean} | {ok:false, error:string}>`. Errors are plain-English ("This video file could not be opened…", "This video has no sound…"). A video with no audio stream is `ok:false` per spec (§5: caught at scheduling, engine assumes audio).

- [ ] **Step 1: Write the failing tests**

`test/probe.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { probeFile } = require('../engine/probe');
const FIX = path.join(__dirname, 'fixtures');

test('probes a good file', async () => {
  const r = await probeFile(path.join(FIX, 'class.mp4'));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.durationSec - 20) < 0.5, `duration ${r.durationSec}`);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 720);
  assert.equal(r.hasAudio, true);
});

test('missing file → plain-English error', async () => {
  const r = await probeFile(path.join(FIX, 'nope.mp4'));
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be opened/i);
});

test('audio-less file → rejected with clear reason', async () => {
  // generate on the fly next to the other fixtures
  const { execFileSync } = require('node:child_process');
  const { ffmpegPath } = require('../engine/ffmpeg');
  const silent = path.join(FIX, 'silent.mp4');
  execFileSync(ffmpegPath(), ['-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=2',
    '-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p', silent]);
  const r = await probeFile(silent);
  assert.equal(r.ok, false);
  assert.match(r.error, /no sound/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/probe.test.js`
Expected: FAIL — `Cannot find module '../engine/probe'`.

- [ ] **Step 3: Implement `engine/probe.js`**

```js
'use strict';
const { execFile } = require('node:child_process');
const { ffprobePath } = require('./ffmpeg');

function probeFile(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath(),
      ['-v','error','-print_format','json','-show_format','-show_streams', filePath],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error:
            'This video file could not be opened. Check that the file plays, and that the network drive is connected.' });
          return;
        }
        let info; try { info = JSON.parse(stdout); } catch {
          resolve({ ok: false, error: 'This video file could not be read.' }); return;
        }
        const v = (info.streams || []).find(s => s.codec_type === 'video');
        const a = (info.streams || []).find(s => s.codec_type === 'audio');
        if (!v) { resolve({ ok: false, error: 'This file has no video in it.' }); return; }
        if (!a) { resolve({ ok: false, error:
          'This video has no sound. Broadcasts need a video with an audio track.' }); return; }
        resolve({
          ok: true,
          durationSec: parseFloat(info.format?.duration || v.duration || '0') || 0,
          width: v.width || 0, height: v.height || 0,
          hasAudio: true,
        });
      });
  });
}

module.exports = { probeFile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/probe.test.js` — expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/probe.js test/probe.test.js
git commit -m "feat: file probe with plain-English failures (audio required)"
```

---

### Task 5: `engine/timeline.js` — the broadcast argument builder (the core)

**Files:**
- Create: `engine/timeline.js`
- Test: `test/timeline.test.js`

**Interfaces:**
- Produces: `buildBroadcastArgs(opts): string[]` — the complete ffmpeg argv (no shell quoting; callers spawn with an array). `opts = { videoPath, vertical=false, bitrateKbps=6000, fps=30, leadSec=0, fadeSec=1, slateImage=null, slateMusic=null, resumeOffsetSec=0, outUrl }`. Also `SLATE_AUDIO_SILENT` (exported constant, the lavfi silence spec) and `videoStartsAtSec(opts): number` (where in the OUTPUT timeline the video begins: `leadSec` with slate, else 0 — Task 6 uses it for resume math).
- Timeline law (spec §5): output = slate for `leadSec` → crossfade of `fadeSec` → video; total output duration = `leadSec + videoDuration`. With no lead/slate (or on resume) the output is just the video (from `resumeOffsetSec`).

- [ ] **Step 1: Write the failing tests**

`test/timeline.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBroadcastArgs, videoStartsAtSec } = require('../engine/timeline');

const BASE = {
  videoPath: '/media/class.mp4', outUrl: 'rtmp://127.0.0.1:1935/live/test',
  leadSec: 300, fadeSec: 1, slateImage: '/media/slate.png', slateMusic: '/media/music.mp3',
};

test('full slate broadcast: inputs, xfade at lead, acrossfade, encode, flv out', () => {
  const a = buildBroadcastArgs({ ...BASE });
  const s = a.join(' ');
  assert.ok(s.includes('-loop 1'), 'slate image looped');
  assert.ok(s.includes('-stream_loop -1'), 'mp3 loops');
  assert.ok(s.includes('-t 301'), 'slate span = lead + fade');
  assert.ok(s.includes('xfade=transition=fade:duration=1:offset=300'), 'fade lands at the scheduled second');
  assert.ok(s.includes('acrossfade=d=1'), 'audio crossfade');
  assert.ok(s.includes('scale=1920:1080'), 'default 16:9 canvas');
  assert.ok(s.includes('-b:v 6000k'), 'default bitrate');
  assert.ok(s.includes('-g 60'), '2s keyframes @30fps');
  assert.ok(s.endsWith('-f flv rtmp://127.0.0.1:1935/live/test'), 'flv to ingest');
});

test('vertical → 1080x1920 canvas', () => {
  const s = buildBroadcastArgs({ ...BASE, vertical: true }).join(' ');
  assert.ok(s.includes('scale=1080:1920'));
  assert.ok(!s.includes('scale=1920:1080'));
});

test('no music → silent slate audio, acrossfade still used (one audio path)', () => {
  const s = buildBroadcastArgs({ ...BASE, slateMusic: null }).join(' ');
  assert.ok(s.includes('anullsrc'), 'silence stands in for music');
  assert.ok(s.includes('acrossfade=d=1'));
});

test('no lead-in → no slate inputs, video only', () => {
  const s = buildBroadcastArgs({ ...BASE, leadSec: 0 }).join(' ');
  assert.ok(!s.includes('xfade'), 'no fade without a slate phase');
  assert.ok(!s.includes('/media/slate.png'));
  assert.ok(s.includes('/media/class.mp4'));
});

test('resume → -ss before the video input, no slate', () => {
  const a = buildBroadcastArgs({ ...BASE, resumeOffsetSec: 372 });
  const s = a.join(' ');
  assert.ok(!s.includes('xfade'));
  const ss = a.indexOf('-ss');
  assert.ok(ss >= 0 && a[ss + 1] === '372');
  assert.ok(ss < a.indexOf('/media/class.mp4'), '-ss placed before -i (fast seek)');
});

test('videoStartsAtSec: lead with slate, 0 otherwise', () => {
  assert.equal(videoStartsAtSec({ ...BASE }), 300);
  assert.equal(videoStartsAtSec({ ...BASE, leadSec: 0 }), 0);
  assert.equal(videoStartsAtSec({ ...BASE, resumeOffsetSec: 5 }), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/timeline.test.js`
Expected: FAIL — `Cannot find module '../engine/timeline'`.

- [ ] **Step 3: Implement `engine/timeline.js`**

```js
'use strict';
// Builds the complete ffmpeg argv for one continuous broadcast (spec §5).
// Uniform shape: exactly three inputs when a slate phase exists —
//   [0] slate image (looped stills), [1] slate audio (MP3 looped, or silence), [2] class video —
// so there is ONE filter-graph path, not four.

const SLATE_AUDIO_SILENT = 'anullsrc=r=44100:cl=stereo';

function canvas(vertical) { return vertical ? [1080, 1920] : [1920, 1080]; }

function hasSlatePhase(o) {
  return (o.resumeOffsetSec || 0) <= 0 && (o.leadSec || 0) > 0 && !!o.slateImage;
}

function videoStartsAtSec(o) { return hasSlatePhase(o) ? o.leadSec : 0; }

function buildBroadcastArgs(o) {
  const fps = o.fps || 30;
  const kbps = o.bitrateKbps || 6000;
  const fade = o.fadeSec == null ? 1 : o.fadeSec;
  const [W, H] = canvas(!!o.vertical);
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
              `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  const afmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1'];
  let filter;

  if (hasSlatePhase(o)) {
    const span = o.leadSec + fade;                       // slate persists through the fade
    args.push('-re', '-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', o.slateImage);
    if (o.slateMusic) args.push('-re', '-stream_loop', '-1', '-t', String(span), '-i', o.slateMusic);
    else args.push('-f', 'lavfi', '-t', String(span), '-i', SLATE_AUDIO_SILENT);
    args.push('-re', '-i', o.videoPath);
    filter = [
      `[0:v]${fit}[slv]`,
      `[2:v]${fit}[vv]`,
      `[slv][vv]xfade=transition=fade:duration=${fade}:offset=${o.leadSec}[vout]`,
      `[1:a]${afmt}[sla]`,
      `[2:a]${afmt}[va]`,
      `[sla][va]acrossfade=d=${fade}[aout]`,
    ].join(';');
  } else {
    if ((o.resumeOffsetSec || 0) > 0) args.push('-ss', String(o.resumeOffsetSec));
    args.push('-re', '-i', o.videoPath);
    filter = [`[0:v]${fit}[vout]`, `[0:a]${afmt}[aout]`].join(';');
  }

  args.push(
    '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', o.outUrl,
  );
  return args;
}

module.exports = { buildBroadcastArgs, videoStartsAtSec, SLATE_AUDIO_SILENT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/timeline.test.js` — expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add engine/timeline.js test/timeline.test.js
git commit -m "feat: broadcast timeline builder (slate+mp3 -> xfade -> video, one encode)"
```

---

### Task 6: `engine/broadcast.js` — process lifecycle with verified start

**Files:**
- Create: `engine/broadcast.js`
- Test: `test/broadcast.test.js`

**Interfaces:**
- Consumes: `buildBroadcastArgs`, `videoStartsAtSec` (Task 5); `ffmpegPath()` (Task 2).
- Produces: `class Broadcast extends EventEmitter` — `new Broadcast(opts)` (same opts as `buildBroadcastArgs`), `.start()`, `.stop(): Promise<void>` (SIGTERM, SIGKILL after 3 s), `.outTimeSec` (media time in the output timeline, parsed from ffmpeg `-progress`), `.videoOffsetSec()` (position **within the class video** = `max(0, outTimeSec - videoStartsAtSec(opts)) + resumeOffsetSec` — what a resume passes as the next `resumeOffsetSec`). Events: `'playing'` (verified start: out_time advancing past 0.5 s), `'ended'` (exit 0), `'failed'` (`{reason}` plain-English: never after a clean stop), `'progress'` (`{outTimeSec}`).
- **Verified-start law (spec §5):** if the process exits — or out_time never advances — before the 0.5 s threshold, that is `'failed'` with `"The broadcast could not start…"`, never `'ended'`.

- [ ] **Step 1: Write the failing tests**

`test/broadcast.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');

const FIX = path.join(__dirname, 'fixtures');
const TMP = path.join(__dirname, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const short = (over = {}) => ({
  videoPath: path.join(FIX, 'class.mp4'), leadSec: 2, fadeSec: 1,
  slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
  outUrl: path.join(TMP, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.flv`), ...over,
});

test('plays to the end: playing -> ended, file written', async () => {
  const b = new Broadcast(short());
  const events = [];
  b.on('playing', () => events.push('playing'));
  await new Promise((res, rej) => { b.on('ended', res); b.on('failed', e => rej(new Error(e.reason))); b.start(); });
  assert.deepEqual(events, ['playing']);
  assert.ok(fs.statSync(b.opts.outUrl).size > 10000, 'output has real content');
});

test('bad file → failed with plain-English reason, never ended', async () => {
  const b = new Broadcast(short({ videoPath: path.join(FIX, 'missing.mp4') }));
  const r = await new Promise((res) => { b.on('failed', res); b.on('ended', () => res({ reason: 'WRONGLY ENDED' })); b.start(); });
  assert.match(r.reason, /could not start/i);
});

test('stop(): clean kill, no failed event, offset math sane', async () => {
  const b = new Broadcast(short({ leadSec: 0, slateImage: null }));
  let failed = false; b.on('failed', () => { failed = true; });
  await new Promise((res) => { b.on('playing', res); b.start(); });
  await new Promise(r => setTimeout(r, 1500));
  const off = b.videoOffsetSec();
  await b.stop();
  assert.equal(failed, false, 'a deliberate stop is not a failure');
  assert.ok(off > 0.5 && off < 10, `offset ${off}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/broadcast.test.js`
Expected: FAIL — `Cannot find module '../engine/broadcast'`.

- [ ] **Step 3: Implement `engine/broadcast.js`**

```js
'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { ffmpegPath } = require('./ffmpeg');
const { buildBroadcastArgs, videoStartsAtSec } = require('./timeline');

const VERIFY_AT_SEC = 0.5;   // out_time must pass this to count as "actually playing"

class Broadcast extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.outTimeSec = 0;
    this._proc = null;
    this._playing = false;
    this._stopping = false;
    this._stderrTail = '';
  }

  start() {
    const args = buildBroadcastArgs(this.opts);
    this._proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._proc.stdout.on('data', (buf) => {          // -progress pipe:1 key=value lines
      for (const line of String(buf).split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m) {
          this.outTimeSec = Number(m[1]) / 1e6;
          if (!this._playing && this.outTimeSec >= VERIFY_AT_SEC) {
            this._playing = true;
            this.emit('playing');
          }
          this.emit('progress', { outTimeSec: this.outTimeSec });
        }
      }
    });
    this._proc.stderr.on('data', (buf) => {
      this._stderrTail = (this._stderrTail + String(buf)).slice(-2000);
    });
    this._proc.on('close', (code) => {
      if (this._stopping) return;                     // deliberate stop: caller handles state
      if (!this._playing) {
        this.emit('failed', { reason:
          'The broadcast could not start — the video (or slate) file could not be played. ' +
          'Check the file and the network drive. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')' });
      } else if (code === 0) {
        this.emit('ended');
      } else {
        this.emit('failed', { reason:
          'The broadcast stopped unexpectedly (connection or file problem). ' +
          'It can be resumed. (' + this._stderrTail.split('\n').slice(-2).join(' ').trim() + ')' });
      }
    });
  }

  videoOffsetSec() {
    const inVideo = Math.max(0, this.outTimeSec - videoStartsAtSec(this.opts));
    return inVideo + (this.opts.resumeOffsetSec || 0);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.exitCode !== null) { resolve(); return; }
      this._stopping = true;
      const killTimer = setTimeout(() => { try { this._proc.kill('SIGKILL'); } catch {} }, 3000);
      this._proc.on('close', () => { clearTimeout(killTimer); resolve(); });
      try { this._proc.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
    });
  }
}

module.exports = { Broadcast, VERIFY_AT_SEC };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/broadcast.test.js`
Expected: 3 passing (first test takes ~25 s real time — `-re` paces at realtime; that is correct behavior, not a hang).

- [ ] **Step 5: Run the whole suite + commit**

Run: `npm test` — expected: all tests green.
```bash
git add engine/broadcast.js test/broadcast.test.js
git commit -m "feat: broadcast lifecycle with verified start, honest failures, resume offset"
```

---

### Task 7: Dress rehearsal against a real RTMP receiver (the proof gate)

**Files:**
- Create: `scripts/rehearsal.js`, `scripts/mediamtx-test.yml`

**Interfaces:**
- Consumes: `Broadcast` (Task 6), fixtures (Task 3), `ffmpegPath/ffprobePath` (Task 2).
- Produces: `npm run rehearsal` — runs TWO live broadcasts (16:9 and vertical) to a local mediamtx over RTMP, records them, and PASS/FAILs these checks automatically: (1) recording duration ≈ lead + video ±2 s; (2) realtime pacing (wall clock ≈ duration ±15%); (3) a frame during the slate phase is red; (4) a frame after the fade is NOT red (video content); (5) audio present and audible (mean volume > −60 dB); (6) vertical run is 1080×1920. Exit code 0 = all pass.

- [ ] **Step 1: Write the mediamtx test config**

`scripts/mediamtx-test.yml`:
```yaml
logLevel: error
rtmp: yes
rtmpAddress: :1935
hls: no
webrtc: no
srt: no
api: no
metrics: no
paths:
  all_others:
```

- [ ] **Step 2: Write the rehearsal harness**

`scripts/rehearsal.js`:
```js
'use strict';
/* Full dress rehearsal: engine -> local RTMP -> recorder -> automated checks.
   Usage: node scripts/rehearsal.js   (assumes fixtures exist: npm run fixtures) */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');
const { ffmpegPath, ffprobePath } = require('../engine/ffmpeg');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', 'test', 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const LEAD = 8, FADE = 1, VIDEO = 20;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

function frameMeanRGB(file, atSec, w, h) {
  const raw = execFileSync(ffmpegPath(),
    ['-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: w * h * 3 + 1024 });
  let r = 0, g = 0, b = 0; const n = Math.floor(raw.length / 3);
  for (let i = 0; i < n * 3; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return [r / n, g / n, b / n];
}
function probeJson(file) {
  return JSON.parse(execFileSync(ffprobePath(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
}
function meanVolumeDb(file) {
  // volumedetect reports on STDERR — spawnSync exposes it; execFileSync would not.
  const r = require('node:child_process').spawnSync(ffmpegPath(),
    ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
  return m ? Number(m[1]) : -Infinity;
}

async function runOne(label, vertical) {
  const streamPath = `live/${label}`;
  const rec = path.join(TMP, `rehearsal-${label}.flv`);
  const recorder = spawn(ffmpegPath(),
    ['-y', '-i', `rtmp://127.0.0.1:1935/${streamPath}`, '-c', 'copy', rec],
    { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));

  const t0 = Date.now();
  const b = new Broadcast({
    videoPath: path.join(FIX, vertical ? 'class-vertical.mp4' : 'class.mp4'),
    slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'),
    leadSec: LEAD, fadeSec: FADE, vertical, bitrateKbps: 2500,
    outUrl: `rtmp://127.0.0.1:1935/${streamPath}`,
  });
  await new Promise((res, rej) => { b.on('ended', res); b.on('failed', e => rej(new Error(e.reason))); b.start(); });
  const wallSec = (Date.now() - t0) / 1000;
  await new Promise(r => setTimeout(r, 1500)); recorder.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));

  const expect = LEAD + VIDEO;
  const info = probeJson(rec);
  const dur = parseFloat(info.format.duration);
  const v = info.streams.find(s => s.codec_type === 'video');
  check(`${label}: duration ≈ ${expect}s`, Math.abs(dur - expect) < 2, `${dur.toFixed(1)}s`);
  check(`${label}: realtime pacing`, Math.abs(wallSec - expect) / expect < 0.15, `wall ${wallSec.toFixed(1)}s`);
  const slate = frameMeanRGB(rec, 3, v.width, v.height);
  check(`${label}: slate frame is red`, slate[0] > 150 && slate[1] < 90 && slate[2] < 90, `rgb ${slate.map(x => x | 0)}`);
  const vid = frameMeanRGB(rec, LEAD + FADE + 3, v.width, v.height);
  check(`${label}: post-fade frame is video (not red)`, !(vid[0] > 150 && vid[1] < 90), `rgb ${vid.map(x => x | 0)}`);
  check(`${label}: audio audible`, meanVolumeDb(rec) > -60);
  check(`${label}: canvas`, vertical ? (v.width === 1080 && v.height === 1920) : (v.width === 1920 && v.height === 1080),
        `${v.width}x${v.height}`);
}

(async () => {
  const mtx = spawn('mediamtx', [path.join(__dirname, 'mediamtx-test.yml')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));
  try {
    await runOne('horizontal', false);
    await runOne('vertical', true);
  } catch (e) { check('rehearsal ran to completion', false, e.message); }
  mtx.kill('SIGTERM');
  console.log(failures === 0 ? '\nALL REHEARSAL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 3: Run it (expect ~1 minute of real time: two realtime broadcasts)**

Run: `npm run rehearsal`
Expected: 12 PASS lines and `ALL REHEARSAL CHECKS PASSED`, exit 0.
If the fade checks fail here, this is the spec's known-risk point: debug the filter graph first (xfade offset/duration, input `-t` spans); the approved fallback (cut instead of fade) is a last resort, not the first response.

- [ ] **Step 4: Commit**

```bash
git add scripts/rehearsal.js scripts/mediamtx-test.yml
git commit -m "feat: automated dress rehearsal vs local RTMP (fade, pacing, audio, canvas checks)"
```

---

### Task 8: Resume-at-offset rehearsal (mid-broadcast recovery)

**Files:**
- Create: `scripts/rehearsal-resume.js`
- Modify: `package.json` (add script `"rehearsal:resume": "node scripts/rehearsal-resume.js"`)

**Interfaces:**
- Consumes: `Broadcast.videoOffsetSec()` (Task 6) — the value a supervisor passes as `resumeOffsetSec` when restarting a dead broadcast (spec §5 reconnect/resume; Plan 3's scheduler will do this automatically).
- Produces: `npm run rehearsal:resume` — starts a broadcast, kills the encode mid-video (simulating a network death), restarts with the captured offset, records both segments, and verifies the second segment's length ≈ what remained ±2 s. Exit 0 = pass.

- [ ] **Step 1: Write the harness**

`scripts/rehearsal-resume.js`:
```js
'use strict';
/* Kill a live broadcast mid-video, resume at the captured offset, verify the
   remainder's length. Segment 2 is recorded separately (a real Mux ingest would
   splice within its reconnect window; length math is what we can assert locally). */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Broadcast } = require('../engine/broadcast');
const { ffmpegPath, ffprobePath } = require('../engine/ffmpeg');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', 'test', 'tmp'); fs.mkdirSync(TMP, { recursive: true });
const LEAD = 4, FADE = 1, VIDEO = 20, KILL_AFTER = 10; // kill ~5s into the video
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${n}${d ? ' — ' + d : ''}`); if (!ok) failures++; };
const durOf = f => parseFloat(JSON.parse(execFileSync(ffprobePath(),
  ['-v','error','-print_format','json','-show_format', f])).format.duration);

function record(streamPath, to) {
  return spawn(ffmpegPath(), ['-y', '-i', `rtmp://127.0.0.1:1935/${streamPath}`, '-c', 'copy', to], { stdio: 'ignore' });
}

(async () => {
  const mtx = spawn('mediamtx', [path.join(__dirname, 'mediamtx-test.yml')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));
  const opts = {
    videoPath: path.join(FIX, 'class.mp4'), slateImage: path.join(FIX, 'slate.png'),
    slateMusic: path.join(FIX, 'music.mp3'), leadSec: LEAD, fadeSec: FADE,
    bitrateKbps: 2500, outUrl: 'rtmp://127.0.0.1:1935/live/resume',
  };
  const rec1 = record('live/resume', path.join(TMP, 'resume-seg1.flv'));
  const b1 = new Broadcast(opts);
  let offset = 0;
  const died = new Promise(res => b1.on('failed', res));       // a mid-run kill = 'failed' (resumable)
  b1.start();
  setTimeout(() => { offset = b1.videoOffsetSec(); b1._proc.kill('SIGKILL'); }, KILL_AFTER * 1000);
  await died;
  rec1.kill('SIGTERM'); await new Promise(r => setTimeout(r, 800));
  check('offset captured mid-video', offset > 3 && offset < 9, `${offset.toFixed(1)}s`);

  const rec2 = record('live/resume', path.join(TMP, 'resume-seg2.flv'));
  const b2 = new Broadcast({ ...opts, resumeOffsetSec: offset });
  await new Promise((res, rej) => { b2.on('ended', res); b2.on('failed', e => rej(new Error(e.reason))); b2.start(); });
  await new Promise(r => setTimeout(r, 1200)); rec2.kill('SIGTERM'); await new Promise(r => setTimeout(r, 800));

  const remain = VIDEO - offset;
  const d2 = durOf(path.join(TMP, 'resume-seg2.flv'));
  check('resumed segment ≈ remaining video', Math.abs(d2 - remain) < 2, `${d2.toFixed(1)}s vs ${remain.toFixed(1)}s`);
  mtx.kill('SIGTERM');
  console.log(failures === 0 ? '\nRESUME REHEARSAL PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add: `"rehearsal:resume": "node scripts/rehearsal-resume.js"`.

- [ ] **Step 3: Run it**

Run: `npm run rehearsal:resume`
Expected: both PASS lines and `RESUME REHEARSAL PASSED`, exit 0 (~40 s real time).

- [ ] **Step 4: Full suite one last time + commit**

Run: `npm test && npm run rehearsal && npm run rehearsal:resume`
Expected: everything green.
```bash
git add scripts/rehearsal-resume.js package.json
git commit -m "feat: mid-broadcast kill + resume-at-offset rehearsal"
```

---

## Definition of Done (Plan 1)

- `npm test` green (ffmpeg, probe, timeline, broadcast suites).
- `npm run rehearsal` — all 12 checks PASS: the slate + looping MP3 + timed fade + video pipeline is proven end-to-end over real RTMP, both orientations, realtime-paced, with audible audio.
- `npm run rehearsal:resume` — mid-broadcast death and resume-at-offset proven.
- Everything committed; 1.x untouched.

**What Plan 2 picks up:** the portal client (port of `portal-helper.py`) + `safeStorage` credential store, consuming `probeFile` and producing the `{outUrl, vertical}` a `Broadcast` needs.
