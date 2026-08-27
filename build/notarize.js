'use strict';
// electron-builder afterSign hook. Once the .app is signed, submit it to Apple's
// notary service (which scans it and staples an approval ticket, so macOS opens it
// with no "unidentified developer" warning). It runs ONLY when notarization
// credentials are present in the environment — so unsigned/dev builds, and
// signed-but-local test builds, are never blocked or slowed by it.
const path = require('node:path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  // A universal build produces intermediate per-arch "…-temp" app dirs; only the
  // final merged app is the one to notarize, so skip the temps.
  if (/-temp$/.test(appOutDir)) { console.log('[notarize] skipping intermediate build dir: ' + appOutDir); return; }

  // Two credential styles are supported (set ONE of them in the environment):
  //   • App Store Connect API key:  APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
  //   • Apple ID:                   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
  const e = process.env;
  const hasApiKey = e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER;
  const hasAppleId = e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID;
  if (!hasApiKey && !hasAppleId) {
    console.log('[notarize] no Apple credentials in the environment — skipping notarization (this build will still be signed if a certificate is installed).');
    return;
  }

  let notarize;
  try { ({ notarize } = require('@electron/notarize')); }
  catch (err) {
    console.log('[notarize] @electron/notarize is not installed — run `npm ci`. Skipping notarization.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const opts = hasApiKey
    ? { appPath, appleApiKey: e.APPLE_API_KEY, appleApiKeyId: e.APPLE_API_KEY_ID, appleApiIssuer: e.APPLE_API_ISSUER }
    : { appPath, appleId: e.APPLE_ID, appleIdPassword: e.APPLE_APP_SPECIFIC_PASSWORD, teamId: e.APPLE_TEAM_ID };

  console.log('[notarize] submitting "' + appName + '.app" to Apple — this usually takes 2–10 minutes…');
  await notarize(opts);
  console.log('[notarize] approved and stapled ✓');
};
