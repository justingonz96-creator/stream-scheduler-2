'use strict';
// The portal facade — a direct port of 1.x portal-helper.py's routes, running
// inside the app (no localhost server, no Python). One method per operation;
// each logs in fresh (the 1.x helper did the same — simple and stateless).
// LAW: the stream key is a credential — it must never reach log() or an error.
const { parseContentItem, pickOccurrence, matchOccurrence, isVertical } = require('./occurrences');
const { parseStations, stationIngest, stationSummaries } = require('./stations');

const API_BASE_DEFAULT = 'https://nestapi.echelonfit.com';
const TOKEN_KEYS = ['token', 'accessToken', 'access_token', 'idToken', 'id_token', 'jwt', 'authToken'];

function findToken(obj) {
  if (Array.isArray(obj)) { for (const v of obj) { const t = findToken(v); if (t) return t; } return null; }
  if (obj && typeof obj === 'object') {
    for (const k of TOKEN_KEYS) { const v = obj[k]; if (typeof v === 'string' && v.length > 20) return v; }
    for (const v of Object.values(obj)) { const t = findToken(v); if (t) return t; }
  }
  return null;
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function createPortalClient({ getConfig, transport, log = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  function config(overrides = {}) {
    const base = { apiBase: API_BASE_DEFAULT, apiKey: '', email: '', password: '', ...getConfig() };
    for (const k of ['email', 'password', 'apiKey', 'apiBase']) {
      if (overrides[k]) base[k] = overrides[k];
    }
    if (!base.apiBase) base.apiBase = API_BASE_DEFAULT;   // a blank Setup field must never wipe the portal address (1.x law)
    return base;
  }

  function authedHeaders(cfg, token) {
    const h = {};
    if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function login(cfg) {
    const r = await transport('POST', cfg.apiBase + '/auth',
      { headers: authedHeaders(cfg, null), body: { email: cfg.email, password: cfg.password } });
    log('login -> ' + r.status);
    // Say WHICH kind of failure this is. Reporting a dropped connection as
    // "check the email and password" sent operators hunting for a login problem
    // during a network blip (2026-09-04 audit).
    if (r.status === 0) {
      return { ok: false, error: 'The content portal could not be reached - check this computer\u2019s internet connection, then try again.' };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: 'The portal login failed \u2014 check the email and password in Setup.' };
    }
    if (r.status >= 500) {
      return { ok: false, error: 'The content portal is having trouble right now (error ' + r.status + '). Try again shortly.' };
    }
    if (r.status >= 400) {
      return { ok: false, error: 'The portal refused the sign-in (error ' + r.status + ') \u2014 check the email and password in Setup.' };
    }
    // A 2xx is not proof of a session: some portals answer 200 with an HTML
    // login page. Require a token in the body OR a session cookie.
    const token = findToken(parseJson(r.text));
    if (!token && !(r.cookies > 0)) {
      return { ok: false, error: 'The portal sign-in did not complete \u2014 no session was returned. Check the email and password in Setup.' };
    }
    return { ok: true, token };
  }

  async function resolveOccurrences(cfg, token, contentItemGuid) {
    const r = await transport('GET', cfg.apiBase + '/content/items/' + contentItemGuid,
      { headers: authedHeaders(cfg, token) });
    if (r.status === 0 || r.status >= 400) {
      return { ok: false, error: 'The class could not be loaded from the portal — check the class link.' };
    }
    const parsed = parseJson(r.text);
    if (!parsed) return { ok: false, error: 'The portal sent back something unreadable for this class.' };
    return { ok: true, ...parseContentItem(parsed) };
  }

  function chooseOccurrence(occurrences, scheduleGuid) {
    return (scheduleGuid && matchOccurrence(occurrences, scheduleGuid)) || pickOccurrence(occurrences, now());
  }

  async function loadStations(cfg, token) {
    const r = await transport('GET', cfg.apiBase + '/control-stations?take=1000',
      { headers: authedHeaders(cfg, token) });
    if (r.status === 0 || r.status >= 400) {
      return { ok: false, error: 'The studios could not be loaded from the portal.' };
    }
    return { ok: true, stations: parseStations(parseJson(r.text)) };
  }

  return {
    async testLogin(overrides = {}) {
      const cfg = config(overrides);
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      const st = await loadStations(cfg, auth.token);
      if (!st.ok) return st;
      return { ok: true, stations: stationSummaries(st.stations) };
    },

    async checkClassLink({ contentItemGuid, scheduleGuid = '' } = {}) {
      if (!contentItemGuid) return { ok: false, error: 'No class link was given.' };
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
      if (!res.ok) return res;
      const picked = chooseOccurrence(res.occurrences, scheduleGuid);
      return { ok: true, count: res.occurrences.length, picked, vertical: isVertical(res.medium), medium: res.medium };
    },

    async streamTarget({ contentItemGuid, scheduleGuid = '' } = {}) {
      if (!contentItemGuid) return { ok: false, error: 'No class link was given.' };
      const cid = String(contentItemGuid).slice(0, 8);
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) { log('streamtarget class=' + cid + ' -> login failed'); return auth; }
      const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
      if (!res.ok) { log('streamtarget class=' + cid + ' -> ' + res.error); return res; }
      const picked = chooseOccurrence(res.occurrences, scheduleGuid);
      if (!picked || !picked.stationGuid) {
        log('streamtarget class=' + cid + ' -> no studio (occurrences=' + res.occurrences.length + ')');
        return { ok: false, error: 'No studio found for this class — check the class link.' };
      }
      const st = await loadStations(cfg, auth.token);
      if (!st.ok) { log('streamtarget class=' + cid + ' -> ' + st.error); return st; }
      const ingest = stationIngest(st.stations, picked.stationGuid);
      if (!ingest.ok) { log('streamtarget class=' + cid + ' station=' + picked.stationGuid.slice(0, 8) + ' -> ' + ingest.error); return ingest; }
      const vertical = isVertical(res.medium);
      // Station name + id only — NEVER the key.
      log('streamtarget class=' + cid + ' -> station "' + ingest.stationName + '" ' + picked.stationGuid + ' ' + (vertical ? '9:16' : '16:9') + ' (target delivered)');
      return { ok: true, server: ingest.server, key: ingest.key, stationName: ingest.stationName, vertical };
    },

    async endBroadcast({ contentItemGuid = '', scheduleGuid = '', stationGuid = '' } = {}) {
      const cfg = config();
      const auth = await login(cfg);
      if (!auth.ok) return auth;
      let sg = scheduleGuid, st = stationGuid;
      if (contentItemGuid && (!sg || !st)) {
        const res = await resolveOccurrences(cfg, auth.token, contentItemGuid);
        if (!res.ok) return res;
        const picked = chooseOccurrence(res.occurrences, sg);
        if (picked) { sg = sg || picked.scheduleGuid; st = st || picked.stationGuid; }
      }
      if (!sg || !st) return { ok: false, error: 'No live broadcast was found to end for this class.' };
      const r = await transport('POST', cfg.apiBase + '/control-stations/' + st + '/stream/close',
        { headers: authedHeaders(cfg, auth.token), body: { scheduleGuid: sg } });
      log('end-broadcast station=' + st + ' schedule=' + sg + ' -> ' + r.status);
      return { ok: r.status > 0 && r.status < 400, status: r.status, detail: r.text.slice(0, 300) };
    },
  };
}

module.exports = { createPortalClient, findToken, API_BASE_DEFAULT };
