# Stream Scheduler 2

Schedules video files to stream to Echelon studios at exact times: a slate
picture + lead-in music, an auto-fade into the class video, automatic studio
routing from a class link, and automatic end-of-stream on the content portal.
Self-contained Electron app with a bundled FFmpeg — no Chrome, no OBS, no
Python. Full design: `docs/superpowers/specs/2026-07-01-stream-scheduler-2-design.md`.

## Setup (fresh clone)

```bash
npm install
bash scripts/fetch-ffmpeg.sh   # downloads FFmpeg/ffprobe into resources/ffmpeg/
npm run fixtures               # generates test video/audio fixtures
npm test                       # 116 tests
```

## Run

```bash
npm run start
```

## Rehearsals

End-to-end dress rehearsals against a local RTMP server. Require MediaMTX:
`brew install mediamtx`.

```bash
npm run rehearsal          # engine -> local RTMP -> recorder -> automated checks
npm run rehearsal:resume   # crash/resume mid-broadcast
npm run rehearsal:brain    # full scheduler brain, not just the engine
```

## Live portal probe

Read-only check against the real Echelon content portal (dev machine only,
prints no secrets):

```bash
node scripts/portal-live-check.js <class link or contentItemGuid>
```

## Build

```bash
npm run dist:mac   # dist/Stream Scheduler 2-2.0.0-mac-universal.dmg (+ .zip)
npm run dist:win   # dist/Stream Scheduler 2-2.0.0-win-x64.exe
```

Both are unsigned by design (no Apple/Microsoft code-signing certificate) —
expect "skipped code signing" warnings from electron-builder.

## Layout

| Dir | What's in it |
|---|---|
| `engine/` | FFmpeg broadcast engine (slate → music → fade → video, one encode) |
| `portal/` | Echelon content-portal client (login, class links, station routing, end-stream) |
| `schedule/` | Scheduler state machine (go-live timing, retries, crash recovery) |
| `store/` | Settings, schedule, and secrets persistence on disk / OS keychain |
| `renderer/` | The UI (Electron renderer process) |
| `app/` | Electron main process, preload script, IPC wiring |
| `scripts/` | Fetch FFmpeg, build fixtures, rehearsal harnesses, live portal probe |
| `test/` | `node --test` suite |
| `docs/superpowers/` | Spec and per-plan implementation plans |
