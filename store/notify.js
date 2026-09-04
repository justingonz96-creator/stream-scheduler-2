'use strict';
// Which desktop notifications to raise, from one schedule snapshot to the next.
// Pure: the main process feeds it the previous and current event lists and
// shows whatever it returns. A class failing or being missed on an unattended
// machine used to be visible only inside the app window (2026-09-04 audit).
function notificationsFor(prev, next) {
  const before = new Map((prev || []).map((e) => [e.id, e]));
  const out = [];
  for (const ev of next || []) {
    const was = before.get(ev.id);
    const name = ev.title || ev.fileName || 'A class';
    if (ev.status === 'failed' && (!was || was.status !== 'failed')) {
      out.push({ id: ev.id, kind: 'failed', title: 'Class did not air', body: name + ': ' + (ev.outcome || 'the broadcast failed') });
    } else if (ev.status === 'missed' && (!was || was.status !== 'missed') && !(ev.needsVideo && !ev.outcome)) {
      out.push({ id: ev.id, kind: 'missed', title: 'Class was missed', body: name + ': ' + (ev.outcome || 'it did not start in time') });
    } else if (ev.blank && !(was && was.blank)) {
      out.push({ id: ev.id, kind: 'blank', title: ev.blank.kind === 'black' ? 'Class picture is black' : 'Class sound is silent',
        body: name + ': the stream is running but the ' + (ev.blank.kind === 'black' ? 'picture is black' : 'sound is silent') });
    } else if (ev.slow && !(was && was.slow)) {
      out.push({ id: ev.id, kind: 'slow', title: ev.slow.mild ? 'Class is running slightly slow' : 'Class is falling behind',
        body: name + ' is running at ' + Number(ev.slow.speed).toFixed(2) + '\u00d7 real time' + (ev.slow.mild ? ' — it will finish late' : ' — viewers may see stutter') });
    }
  }
  return out;
}
module.exports = { notificationsFor };
