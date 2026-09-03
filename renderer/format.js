'use strict';
// Pure display helpers for the renderer. No DOM, no window — so they run under
// node:test AND in the browser (dual export at the bottom).
function pad2(n) { return String(n).padStart(2, '0'); }

function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad2(d.getMinutes()) + ' ' + ap;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate() + ' · ' + fmtClock(ms);
}

const STATUS = {
  playing: { label: 'On air', kind: 'live' },
  preshow: { label: 'Slate up', kind: 'preshow' },
  starting: { label: 'Starting…', kind: 'preshow' },
  pending: { label: 'Scheduled', kind: 'pending' },
};
function statusPill(ev) {
  if (STATUS[ev.status]) return { ...STATUS[ev.status] };
  // Past events keep the pill SHORT; the full outcome sentence renders as row meta
  // (a paragraph-length pill buries the class name — visual-audit finding).
  if (ev.status === 'done') return { label: 'Played ✓', kind: 'done' };
  if (ev.status === 'failed') return { label: 'Failed', kind: 'failed' };
  if (ev.status === 'missed') return { label: 'Missed', kind: 'missed' };
  return { label: ev.status || '', kind: 'pending' };
}

function endsAround(ev) {
  if (!(ev.durationSec > 0)) return '';
  return 'ends around ' + fmtClock(ev.fireAt + ev.durationSec * 1000) + (ev.autoStop ? ' · stream ends by itself' : '');
}

function buildTimeOptions() {
  const hours = []; for (let h = 1; h <= 12; h++) hours.push(String(h));
  const minutes = []; for (let m = 0; m < 60; m += 5) minutes.push(pad2(m));
  return { hours, minutes };
}

// Big-numeral countdown for the hero card: '5d 3h' far out, '2:14:09' within
// hours, '14:32' inside the hour, '0:00' once due. Tabular digits keep it steady.
function fmtCountdown(msLeft) {
  if (msLeft <= 0) return '0:00';
  const s = Math.floor(msLeft / 1000);
  if (s >= 36 * 3600) { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); return d + 'd ' + h + 'h'; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

// Inverse of parseDateTime: turn an instant back into the three picker values,
// so an existing broadcast can be loaded into the form for editing.
function splitDateTime(ms) {
  const d = new Date(ms);
  const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return { date, hour: String(h), min: pad2(d.getMinutes()), ap };
}

function orientationLabel(vertical) { return vertical ? 'Vertical (9:16)' : 'Widescreen (16:9)'; }

function parseDateTime(dateStr, hour, min, ap) {
  if (!dateStr || !hour || min === '' || min == null || !ap) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr); if (!m) return null;
  let h = parseInt(hour, 10); const mm = parseInt(min, 10);
  if (!(h >= 1 && h <= 12) || !(mm >= 0 && mm < 60)) return null;
  if (ap === 'AM') { if (h === 12) h = 0; } else { if (h !== 12) h += 12; }
  return new Date(+m[1], +m[2] - 1, +m[3], h, mm, 0, 0).getTime();
}

// Broadcasts that DID NOT AIR and deserve a heads-up: real failures, plus misses
// of classes that HAD a video (a weekly slot still waiting for its video is
// expected, not a failure). Only those that happened AFTER `afterMs` — the app's
// open time — so reopening the app doesn't greet the operator with old errors;
// and minus any already dismissed this session.
function recentFailures(events, afterMs, dismissed) {
  const seen = dismissed || new Set();
  return (events || []).filter((e) =>
    (e.status === 'failed' || (e.status === 'missed' && !e.needsVideo)) &&
    (e.doneAt || 0) > (afterMs || 0) &&
    !(seen.has && seen.has(e.id)));
}

// Just the file name from a path (either slash style) — the Setup screen shows a
// chosen slate by name; the full path lives in a tooltip.
function fileName(p) { const s = p == null ? '' : String(p); return s.split(/[\\/]/).pop(); }

const FMT_API = { fmtClock, fmtDateTime, statusPill, endsAround, buildTimeOptions, orientationLabel, parseDateTime, splitDateTime, fmtCountdown, recentFailures, fileName };
if (typeof module !== 'undefined' && module.exports) module.exports = FMT_API;
if (typeof window !== 'undefined') window.Fmt = FMT_API;
