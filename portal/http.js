'use strict';
// The portal transport: JSON in/out, a minimal per-transport cookie jar (the
// portal may carry the session in a cookie rather than the body token), a
// bounded timeout, and NO throwing — network failure is {status: 0, text}.
// Everything above this (auth, client) treats status 0 / >=400 as failure.

function createTransport({ timeoutMs = 25000 } = {}) {
  const jar = new Map();   // cookie name -> value

  return async function transport(method, url, { headers = {}, body = undefined } = {}) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      ...headers,
    };
    if (jar.size > 0) {
      h['Cookie'] = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method, headers: h, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const sc of res.headers.getSetCookie?.() || []) {
        const m = /^([^=;]+)=([^;]*)/.exec(sc);
        if (m) jar.set(m[1].trim(), m[2]);
      }
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: String(e && e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createTransport };
