#!/bin/bash
# Fetch the bundled FFmpeg + ffprobe into resources/ffmpeg/<platform>/ — PINNED.
#
# mac-arm64 + mac-x64: Martin Riedl's static builds (the universal Mac app ships both).
# win-x64: gyan.dev "essentials" build.
#
# WHY PINNED: this script used to pull "latest". A rebuild on a clean checkout then
# silently swapped in a newer engine, and the newer macOS build (OpenSSL-based TLS)
# could not verify any certificate — every rtmps:// studio became unreachable from
# every Mac (2026-09-03). The engine is part of what we ship; it changes only when
# someone changes the pins below, on purpose, and re-tests a real broadcast.
#
# TO BUMP: set the new build id / version, download once, put the new sha256s in,
# run `bash scripts/fetch-ffmpeg.sh --with-windows`, then run the tests AND a real
# rtmps broadcast before releasing. (tls-ca.test.js + the engine self-check cover
# the TLS trap that bit us.)
set -euo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$BASE/resources/ffmpeg"
mkdir -p "$DEST/mac-arm64" "$DEST/mac-x64" "$DEST/win-x64"

# --- the pins -----------------------------------------------------------------
FFMPEG_VERSION="9.0.1"
MAC_ARM64_BUILD="1787073674_9.0.1"
MAC_X64_BUILD="1787081194_9.0.1"
# sha256 of the extracted binaries (what actually ends up in the app)
SHA_mac_arm64_ffmpeg="393e4c395020a1cb7cbd77fbe00599ce69d1c6466fee0dbd59d13f86a81a1611"
SHA_mac_arm64_ffprobe="7abc49fb2bdf2204f018e76dc6e0a8ae7643313bae09a9fa43e7eb12442271bc"
SHA_mac_x64_ffmpeg="56f4a0478fff60fa549ab7aa03759d7ab116dadcdf63dba4d466ebfba1280b2f"
SHA_mac_x64_ffprobe="dd287b051b569382fe32eb73003b04035d416bccfa30148c140e35636cd3a1d8"
SHA_win_x64_ffmpeg="72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3"
SHA_win_x64_ffprobe="19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f"
# ------------------------------------------------------------------------------

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }   # Git Bash on Windows may lack shasum
expected() { local v="SHA_$1_$2"; v="${v//-/_}"; echo "${!v}"; }

# ok <platform> <tool> <file>: true when the file is present AND is the pinned build.
ok() {
  [ -f "$3" ] || return 1
  local want; want="$(expected "$1" "$2")"
  [ "$(sha "$3")" = "$want" ]
}
verify_or_die() {   # after a download: wrong bytes = stop the build, never ship them
  local want; want="$(expected "$1" "$2")"; local got; got="$(sha "$3")"
  if [ "$got" != "$want" ]; then
    echo "ERROR: $1/$2 does not match the pinned sha256." >&2
    echo "  expected $want" >&2; echo "  got      $got" >&2
    echo "  The download source changed. Do NOT ship this; re-pin deliberately." >&2
    rm -f "$3"; exit 1
  fi
}

fetch_mac() {
  for spec in "arm64 $MAC_ARM64_BUILD mac-arm64" "amd64 $MAC_X64_BUILD mac-x64"; do
    set -- $spec; arch="$1"; build="$2"; platform="$3"
    for tool in ffmpeg ffprobe; do
      f="$DEST/$platform/$tool"
      if ok "$platform" "$tool" "$f"; then echo "$platform $tool: present, matches pin ($FFMPEG_VERSION)"; continue; fi
      [ -f "$f" ] && echo "$platform $tool: present but NOT the pinned build — replacing"
      tmp="$(mktemp -d)"
      curl -fsSL "https://ffmpeg.martin-riedl.de/download/macos/$arch/$build/$tool.zip" -o "$tmp/$tool.zip"
      unzip -oq "$tmp/$tool.zip" -d "$tmp"
      verify_or_die "$platform" "$tool" "$tmp/$tool"
      mv -f "$tmp/$tool" "$f"; chmod +x "$f"; rm -rf "$tmp"
      echo "$platform $tool: fetched + verified ($FFMPEG_VERSION build $build)"
    done
  done
}
fetch_win() {
  if ok win-x64 ffmpeg "$DEST/win-x64/ffmpeg.exe" && ok win-x64 ffprobe "$DEST/win-x64/ffprobe.exe"; then
    echo "win-x64: present, matches pin ($FFMPEG_VERSION)"; return
  fi
  [ -f "$DEST/win-x64/ffmpeg.exe" ] && echo "win-x64: present but NOT the pinned build — replacing"
  tmp="$(mktemp -d)"
  curl -fsSL "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$FFMPEG_VERSION-essentials_build.zip" -o "$tmp/win.zip"
  unzip -oq "$tmp/win.zip" -d "$tmp"
  verify_or_die win-x64 ffmpeg "$tmp"/ffmpeg-*/bin/ffmpeg.exe
  verify_or_die win-x64 ffprobe "$tmp"/ffmpeg-*/bin/ffprobe.exe
  mv -f "$tmp"/ffmpeg-*/bin/ffmpeg.exe "$tmp"/ffmpeg-*/bin/ffprobe.exe "$DEST/win-x64/"
  rm -rf "$tmp"
  echo "win-x64: fetched + verified ($FFMPEG_VERSION)"
}
case "${1:-}" in
  --windows-only) fetch_win ;;                 # CI Windows runner: no Mac binaries needed
  --with-windows) fetch_mac; fetch_win ;;
  *) fetch_mac ;;
esac
echo "done"
