# Stream Scheduler 2.0 — Design

**Date:** July 1, 2026
**Status:** Approved by Justin (design sections walked through and confirmed in session)
**Supersedes:** nothing — Stream Scheduler 1.x (`../stream-scheduler/`) keeps running all stations until 2.0 is proven.

## 1. Vision

Turn Stream Scheduler into **one self-contained desktop application** — its own icon, its own
window, its own streaming engine. A station installs one thing and is done. No Google Chrome,
no OBS, no Python. Everything today's system does, on a real foundation.

Driving quote: *"It integrates OBS's foundation as a streaming tool into the app. Instead of it
using a local Chrome browser to run, I'd like for it to be its own thing."*

## 2. Background (what 1.x is, and why rebuild)

1.x is a single HTML file running in a Chrome `--app` window that remote-controls a separately
installed OBS over its WebSocket, plus a Python helper process for content-portal calls. It
works, but every dependency is a live failure surface, and each has actually failed in the
field: Chrome data-dir issues on Windows, macOS Gatekeeper/App-Translocation on the app, the
Python stub on a fresh Mac silently killing portal login, OBS WebSocket setup steps, OBS's
media-loading race at video roll.

Confirmed by Justin: the stations are **file-playout only** — they never stream cameras, mics,
overlays, or screens. OBS's compositing power is unused. That makes OBS replaceable by a far
simpler engine.

## 3. Scope

**In (feature parity with 1.x — no new features in v1):**
- Schedule a video: native file picker (network drives fine), title, date + 5-minute-step
  time picker, slate lead-in (0–30 min), auto-stop toggle, weekly repeat.
- Content-portal class link per event (required): resolves the studio (control station), RTMP
  ingest + stream key, and orientation automatically. "Check this class link" preview.
- Broadcast: slate picture + **looping MP3 music** for the lead-in → timed crossfade (audio and
  video) → class video from frame 0 → auto-end. Portal End Broadcast always fires **before**
  the stream stops.
- 9:16 vertical (1080×1920) for Reflect classes (`medium == "reflect"`), 16:9 (1920×1080)
  otherwise, per broadcast.
- Weekly slots renew **empty** (needsVideo) — never re-air last week's file; 24-hour warning;
  Missed if no video chosen.
- LIVE bar with "End stream now" (press twice); history list; the 1.x Cinematic Dark UI.
- Setup: portal login (email/password/optional API key), slate image + music, fade duration,
  bitrate presets/custom.
- Honest outcomes: "Played ✓" only if the video actually played; clear plain-English failure
  reasons otherwise (1.x Round-25 lesson carried forward as a design rule).

**Out (non-goals for v1):**
- No live inputs of any kind (no capture devices exist in the app — a mic physically cannot leak).
- No multi-station dashboard, no server/cloud component, no accounts.
- No code signing / notarization (documented one-time unblock instead; design must allow
  signing to be added later without rebuild).
- No import of 1.x data (schedules are short-lived; stations re-enter portal login once).

## 4. Architecture

**Shell: Electron** (Chromium + Node bundled inside the app — this is what makes it "its own
thing" with zero external dependencies while reusing the proven 1.x interface).

- **Renderer (UI):** the 1.x HTML/CSS/JS ported over — same look, same scheduling flow, same
  state machine concepts. OBS-specific plumbing (WebSocket client, password handshake,
  leader election, mic-mute enforcement) is deleted; engine calls go through a small IPC API.
- **Main process (the app's brain), as isolated modules:**
  - `scheduler` — the tick/state machine (pending → starting → preshow → playing → done/failed/
    missed), weekly renewal, adoption of in-flight broadcasts on relaunch.
  - `portal` — direct HTTPS client for the Echelon portal (port of portal-helper.py: auth,
    `GET /content/items/{guid}`, occurrence picking with exact-scheduleGuid match when a full
    broadcast link was pasted, `GET /control-stations`, `POST …/stream/close`). No localhost
    server, no CORS, no Python.
  - `engine` — the broadcast engine wrapping bundled FFmpeg (below).
  - `store` — settings + schedule as JSON files in the OS per-user app-data dir; portal
    password encrypted via Electron `safeStorage` (OS keychain-backed).
  - `updates` — checks the GitHub releases API, shows an in-app "Update available" notice
    (no auto-install; that requires signing).
- **Single instance:** Electron's single-instance lock replaces 1.x's localStorage leader
  election. Second launch focuses the existing window. A broadcast can never fire twice.

## 5. The broadcast engine

**FFmpeg, bundled per platform** (mac arm64+x64, win x64) inside the app's resources.

**One continuous encode per broadcast.** The whole timeline is known at go-live (lead-in
length, fade duration, file path, orientation, ingest + key), so the engine builds a single
FFmpeg run:

1. **Slate phase:** slate image (scaled/padded to canvas) + slate MP3 looped seamlessly,
   encoded live to the studio ingest for the lead-in duration.
2. **Crossfade at the scheduled second:** video `xfade` + audio `acrossfade` over the
   configured fade duration (music out, video audio in).
3. **Video phase:** the class file from frame 0 to its end.
4. End of file → encode ends → portal End Broadcast already sent → done.

- Canvas: 1080×1920 when vertical, else 1920×1080; output normalized to 30 fps; bitrate from settings.
- Output: `rtmps://global-live.mux.com:443/app/<streamKey>` (secure ingest preferred, per
  station data).
- No-lead-in broadcasts skip phase 1–2 (straight into the video).

**Safety rules (ported 1.x guarantees):**
- **Abort if no target:** studio/key resolved fresh at go-live; resolution failure ⇒ the event
  fails with a clear reason and nothing is streamed (never the previous class's studio).
- **Verified start:** the engine confirms frames are actually flowing before the event is
  "playing"; a file that never starts ⇒ one retry, then a clear FAILED (never a false ✓).
- **Reconnect + resume:** if the encode dies mid-broadcast (network blip, crash), restart it
  resuming the video at the correct time offset (`-ss`), within Mux's ~30 s reconnect window.
  Same mechanism covers app/computer restarts mid-broadcast (adoption): on reopen, resume at
  the right offset.
- **Stop early:** End portal broadcast first, then kill the encode.
- **File probe at scheduling:** the engine (ffprobe) opens the picked file immediately and
  reads its duration — bad files fail at scheduling time.

**Known risk + approved fallback:** the timed crossfade inside a live encode is the hardest
piece (timing/audio-sync tuning). Fallback if it fights: a clean cut (or ≤1 s freeze) from
slate to video — approved by Justin as acceptable. The capability itself is native to FFmpeg
(`xfade`/`acrossfade`); the fallback exists so a broadcast can never fail because of a
transition effect.

## 6. Portal integration (unchanged rules, new home)

Same endpoints and rules as 1.x, running directly in the app's main process:
- Class link (`…/classes/{guid}`) is the durable, required handle; full broadcast links
  (`…/broadcast/{guid}/{guid}`) pin the exact occurrence for both stream-target and end.
- Orientation from the content item's `medium` (`reflect` ⇒ vertical). `VERTICAL_MEDIUMS`
  stays a one-line config.
- Occurrence picking: window-containing-now with grace, else nearest — the 1.x logic ported.
- End Broadcast: `POST /control-stations/{stationGuid}/stream/close {scheduleGuid}` with
  Bearer + X-Api-Key, always before the stream stops.
- Credentials: email/password (+ optional API key) entered once in Setup, stored via
  `safeStorage`; never in any file in the project folder, never in a repo.

## 7. Storage

- `settings.json` + `schedule.json` in the app-data dir (e.g. `~/Library/Application
  Support/StreamScheduler2/` / `%APPDATA%\StreamScheduler2\`), written atomically.
- Portal password: `safeStorage`-encrypted blob (macOS Keychain / Windows DPAPI backing).
- History retained in `schedule.json` like 1.x.

## 8. Packaging, distribution, updates

- **electron-builder**: macOS universal `.dmg`/`.zip` (unsigned; ad-hoc signature), Windows
  NSIS installer `.exe`.
- Distribution: private GitHub repo (new: `stream-scheduler-2`) with versioned releases —
  same flow the team already uses. Desktop ZIP copies for the no-GitHub shared-drive path.
- First-open unblock (unsigned): Mac "Open Anyway" step; Windows SmartScreen "Run anyway" —
  both documented up front in the new SOP, ported from the 1.x docs.
- Updates: in-app notice via GitHub releases check; user clicks → downloads new build →
  replaces app. Auto-update deferred until signing exists.

## 9. Rollout

1. Build + verify locally (below) — 1.x stations untouched throughout.
2. **Pilot:** one station (either OS) runs a real class end-to-end on 2.0.
3. Fleet rollout station by station: install 2.0, enter portal login, schedule upcoming
   classes in it, retire the 1.x folder. **Rule: never run 1.x and 2.0 on the same station
   simultaneously** (both would fire broadcasts).

## 10. Testing

- **Engine dress rehearsals on the dev Mac:** full broadcasts (slate + MP3 loop + fade +
  video, both orientations) streamed to a local RTMP sink (mediamtx — already proven as the
  1.x test rig), with recordings inspected for: fade lands at the scheduled second, audio
  crossfade clean, MP3 loop seamless, video from frame 0, resume-at-offset after a killed
  encode.
- **Unit tests** on the scheduler state machine and portal client (offline, mocked HTTP —
  same style as the 1.x helper tests).
- **Failure-path tests:** portal down at go-live (must not stream), missing file, encode
  killed mid-broadcast, app relaunch mid-broadcast, end-early ordering (portal before stop).
- **Pilot class** on a real station as the final gate.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Crossfade timing/sync in a live encode | Native FFmpeg xfade/acrossfade; approved cut/freeze fallback; dress-rehearsal verification |
| Long-running encode stability (30–60 min classes) | Reconnect+resume design; local soak tests with full-length files |
| Unsigned install friction | Documented one-time unblock (already familiar to the team); signing can be added later without redesign |
| FFmpeg binary bundling per platform | electron-builder ships per-OS resources; startup self-check verifies the binary runs |
| Scope creep during port | v1 is strict feature parity; new features only after pilot |
