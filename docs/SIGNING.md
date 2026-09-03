# Signing & notarizing the Mac app

> ## Windows in-app update — read before touching `build/installer.nsh` or `nsis` config
>
> In-app updates on Windows used to fail with *"Failed to uninstall old application
> files … : 2"* on every version and install location. **Root cause (proven in a
> clean Windows VM with Sysinternals Handle, 2026-09-03):** electron-updater launches
> the new installer *before* the app has finished quitting; the installer's "is the
> app running?" check passes inside that teardown gap; the old uninstaller then tries
> to rename the app's files (required during an update) while the exiting
> `Stream Scheduler 2.exe` still holds `icudtl.dat` / `app.asar` / `*.pak` open, and
> its stock retry budget (5 × 1 s) is too short. It was **not** the install location,
> **not** the electron-builder version, and **not** antivirus.
>
> The fix is `build/installer.nsh` (wired via `nsis.include`): the new installer waits
> for the old app to be fully gone, then retries the uninstall patiently. Because it
> lives in the *new* installer, it repairs updates coming from already-installed
> versions — no manual reinstall. Keep it; keep `nsis.include` pointing at it.
>
> `electron-builder` is still pinned to 26.4.0 (harmless; the 26.7.0+ "regression"
> reports match the symptom, not our cause). Bumping it is not known to be unsafe, but
> re-test a Windows in-app update in the VM after any bump.


Signing the app with your Apple Developer account does two things:

1. **No more "unidentified developer" warning** — the app opens with a normal double-click.
2. **The Mac "Restart & update" button actually works** — macOS only lets a *signed* app
   replace itself, so the self-updater can finish instead of failing.

Everything is already wired up in the build. You just need to do the one-time account
setup below, then run one command.

> Windows is **not** covered by an Apple account — it needs a separate Windows
> certificate. That's left as a future step.

---

## One-time setup (do these once)

### Step 1 — Create a "Developer ID Application" certificate

**Easiest (via Xcode, already installed on this Mac):**
1. Open **Xcode** → menu **Xcode → Settings… → Accounts**.
2. Click **+** (bottom-left) → **Apple ID** → sign in with your developer account.
3. Select your team, then click **Manage Certificates…**.
4. Click the **+** (bottom-left) → choose **Developer ID Application**.
5. It appears in the list and is installed into your login keychain automatically.

**Alternative (via the website):** create a certificate request in Keychain Access
(Certificate Assistant → *Request a Certificate From a Certificate Authority*, saved to disk),
then at developer.apple.com → **Certificates → + → Developer ID Application**, upload the
request, download the `.cer`, and double-click it to install.

**Check it worked** — this should list a "Developer ID Application" line:
```bash
security find-identity -v -p codesigning
```

### Step 2 — Create a notarization password

1. Go to **appleid.apple.com** → sign in → **Sign-In and Security → App-Specific Passwords**.
2. Click **+**, name it e.g. `Stream Scheduler notarize`, and copy the password it shows
   (looks like `abcd-efgh-ijkl-mnop`).

**Find your Team ID:** developer.apple.com → **Membership** → the 10-character **Team ID**.

### Step 3 — Save the credentials locally

1. Copy `signing.env.example` to `signing.env` (this file is git-ignored — it never leaves
   your machine and is never committed).
2. Fill in:
   - `APPLE_ID` — your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` — the password from Step 2
   - `APPLE_TEAM_ID` — your Team ID

---

## Building a signed + notarized release

```bash
npm run release:mac
```

This installs dependencies, fetches the FFmpeg engine, builds the universal Mac app, signs
it, notarizes it with Apple (a few minutes), and verifies the result. The signed + notarized
`.dmg` and `.zip` land in `dist/`.

## Verify a build by hand

```bash
bash scripts/verify-signing.sh "dist/mac-universal/Stream Scheduler 2.app"
```

It checks the signature is valid and deep (app + the bundled FFmpeg), the hardened runtime
is on, Gatekeeper would accept it, and the notarization ticket is stapled.

---

## How it works (for the curious)

- **`build.mac.hardenedRuntime` + `build/entitlements.mac.plist`** — Apple's security
  requirements for notarization. The entitlements let Electron's JIT run and let the app
  launch its bundled, separately-signed FFmpeg engine.
- **`build.afterSign` → `build/notarize.js`** — after electron-builder signs the app, this
  hook submits it to Apple's notary service and staples the approval. It runs **only** when
  notarization credentials are in the environment, so plain `npm run dist:mac` (and dev
  builds) are never blocked.
- **The bundled FFmpeg** is signed as part of the app, so Gatekeeper doesn't block it.

## Credential alternative (App Store Connect API key)

Instead of the Apple ID + app-specific password, you can set an API key in `signing.env`:
`APPLE_API_KEY` (path to the downloaded `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
The build supports either style automatically.
