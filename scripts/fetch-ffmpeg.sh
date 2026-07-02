#!/bin/bash
# Fetch static FFmpeg + ffprobe into resources/ffmpeg/<platform>/.
# mac-arm64 and mac-x64 from Martin Riedl's static builds (universal Mac build needs both arches);
# win-x64 from gyan.dev (used in Plan 4).
set -e
BASE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$BASE/resources/ffmpeg"
mkdir -p "$DEST/mac-arm64" "$DEST/mac-x64" "$DEST/win-x64"

fetch_mac() {
  for arch_pair in "arm64:mac-arm64" "amd64:mac-x64"; do
    arch="${arch_pair%%:*}"
    platform="${arch_pair##*:}"
    for tool in ffmpeg ffprobe; do
      if [ -x "$DEST/$platform/$tool" ]; then echo "$platform $tool: already present"; continue; fi
      curl -fsSL "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/release/$tool.zip" -o /tmp/ss2-$tool.zip
      unzip -oq /tmp/ss2-$tool.zip -d "$DEST/$platform"; rm -f /tmp/ss2-$tool.zip
      chmod +x "$DEST/$platform/$tool"
    done
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
