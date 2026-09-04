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
# A class file laid out the way the studio's export tool (Mainconcept) writes
# them: ~1/3 s CHUNKS of video, then audio, then video… Fragmented MP4 with
# 1/3 s fragments reproduces that packet order exactly (verified against a real
# export 2026-09-04) — and it reproduced the -re pacing fault that a tightly
# interleaved file never triggered. Used by test/real-layout-pacing.test.js.
$FF -y -f lavfi -i "testsrc2=size=1920x1080:rate=30000/1001:duration=20" \
      -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=20" \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 5000k -c:a aac -b:a 253k -ac 2 \
      -movflags frag_keyframe+empty_moov -frag_duration 333333 -shortest "$FIX/class-chunked.mp4"
echo "fixtures ready: $(ls -1 "$FIX" | tr '\n' ' ' | sed 's/ $//')"
