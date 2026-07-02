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
