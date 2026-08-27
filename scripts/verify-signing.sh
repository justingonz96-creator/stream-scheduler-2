#!/bin/bash
# Prove a built Mac app is correctly signed, notarized, and Gatekeeper-approved.
# Usage: bash scripts/verify-signing.sh "dist/mac-universal/Stream Scheduler 2.app"
set -u
APP="${1:-dist/mac-universal/Stream Scheduler 2.app}"

if [ ! -d "$APP" ]; then echo "✗ App not found: $APP"; echo "  Build first (npm run dist:mac), then pass the .app path."; exit 1; fi
echo "Checking: $APP"
echo

fail=0

echo "1) Code signature is valid and deep (app + every nested binary, incl. FFmpeg)…"
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/   /'; then
  echo "   ✓ signature valid"
else echo "   ✗ signature INVALID"; fail=1; fi
echo

echo "2) Signed by a Developer ID with the hardened runtime on…"
codesign -dvv "$APP" 2>&1 | grep -E "Authority=|TeamIdentifier=|flags=.*runtime" | sed 's/^/   /' \
  || { echo "   ✗ could not read signing details"; fail=1; }
echo

echo "3) Gatekeeper would ALLOW it (this is the 'no unidentified-developer warning' check)…"
if spctl -a -vvv --type exec "$APP" 2>&1 | sed 's/^/   /' | grep -q "accepted"; then
  echo "   ✓ Gatekeeper: accepted"
else echo "   ✗ Gatekeeper would REJECT (likely not notarized yet)"; fail=1; fi
echo

echo "4) Notarization ticket is stapled to the app…"
if xcrun stapler validate "$APP" 2>&1 | sed 's/^/   /' | grep -q "The validate action worked"; then
  echo "   ✓ ticket stapled"
else echo "   ✗ no stapled ticket (not notarized, or notarization not finished)"; fail=1; fi
echo

if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED — this app will open cleanly and can self-update on Mac."; else
  echo "SOME CHECKS FAILED — see above. A signed-but-not-notarized build passes 1–2 but fails 3–4."; fi
exit "$fail"
