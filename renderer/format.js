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

function orientationLabel(vertical) { return vertical ? 'Vertical (9:16)' : 'Widescreen (16:9)'; }

function parseDateTime(dateStr, hour, min, ap) {
  if (!dateStr || !hour || min === '' || min == null || !ap) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr); if (!m) return null;
  let h = parseInt(hour, 10); const mm = parseInt(min, 10);
  if (!(h >= 1 && h <= 12) || !(mm >= 0 && mm < 60)) return null;
  if (ap === 'AM') { if (h === 12) h = 0; } else { if (h !== 12) h += 12; }
  return new Date(+m[1], +m[2] - 1, +m[3], h, mm, 0, 0).getTime();
}

const FMT_API = { fmtClock, fmtDateTime, statusPill, endsAround, buildTimeOptions, orientationLabel, parseDateTime };
if (typeof module !== 'undefined' && module.exports) module.exports = FMT_API;
if (typeof window !== 'undefined') window.Fmt = FMT_API;
