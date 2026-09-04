#!/bin/bash
# One command to build a SIGNED + NOTARIZED Mac release.
# Prereqs (one-time, see docs/SIGNING.md):
#   1. A "Developer ID Application" certificate installed in your login keychain.
#   2. A file  signing.env  in the project root with your notarization credentials
#      (copy signing.env.example → signing.env and fill it in). It is git-ignored.
# Then just run:  npm run release:mac
set -e
BASE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE"

# Load notarization credentials (never committed).
if [ -f signing.env ]; then
  set -a; . ./signing.env; set +a
  echo "Loaded notarization credentials from signing.env"
else
  echo "⚠  No signing.env found — the app will be SIGNED but NOT notarized."
  echo "   (It will run, but macOS may still show a warning on first open.)"
  echo "   See docs/SIGNING.md to set it up."
fi

# A Developer ID cert must be present, or this is just an unsigned build.
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No 'Developer ID Application' certificate found in your keychain."
  echo "  Install it first (docs/SIGNING.md, step 1), then re-run."
  exit 1
fi

echo "→ Installing dependencies (npm ci)…";        npm ci
echo "→ Fetching the bundled FFmpeg engine…";       bash scripts/fetch-ffmpeg.sh
echo "→ Building, signing, and notarizing…";        npm run dist:mac

APP="dist/mac-universal/Stream Scheduler 2.app"
echo "→ Verifying the result…"
# A build that fails signing/notarization verification must NOT be shipped —
# stop here loudly instead of printing "Done" (2026-09-04 audit).
bash scripts/verify-signing.sh "$APP" || { echo; echo "✗ Verification FAILED — do not publish these installers."; exit 1; }
echo
echo "Done. Installers are in dist/ :"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null | sed 's/^/   /'
