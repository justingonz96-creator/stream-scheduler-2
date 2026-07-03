'use strict';
// The spec'd update NOTICE (§8): ask GitHub for the latest release, say so
// quietly if it's newer. NEVER throws, NEVER blocks startup, no auto-update.
function parseVer(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function newer(a, b) {   // a > b ?
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
async function checkForUpdate({ currentVersion, fetchImpl, repo = 'justingonz96-creator/stream-scheduler-2' }) {
  try {
    const res = await fetchImpl('https://api.github.com/repos/' + repo + '/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res || res.status !== 200) return { hasUpdate: false };
    const body = await res.json();
    const latest = parseVer(body && body.tag_name);
    const cur = parseVer(currentVersion);
    if (!latest || !cur || !newer(latest, cur)) return { hasUpdate: false };
    return { hasUpdate: true, latestVersion: latest.join('.'), url: (body && body.html_url) || '' };
  } catch { return { hasUpdate: false }; }
}
module.exports = { checkForUpdate };
