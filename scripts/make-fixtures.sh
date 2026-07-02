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
echo "fixtures ready: $(ls -1 "$FIX" | tr '\n' ' ' | sed 's/ $//')"
