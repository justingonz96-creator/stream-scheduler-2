'use strict';
/* Headless proof that the scheduler drives the REAL Broadcast engine end-to-end
   into a local RTMP sink (mediamtx). No Electron, no real portal. */
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createScheduler } = require('../schedule/scheduler');
const { Broadcast } = require('../engine/broadcast');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const CFG = path.join(__dirname, 'mediamtx-test.yml');

function memStore(init = []) { let d = init.slice(); return { load: () => d.slice(), save: (e) => { d = e.slice(); } }; }

(async () => {
  const mtx = spawn('mediamtx', [CFG], { stdio: 'ignore' });
  const cleanup = () => { try { mtx.kill('SIGKILL'); } catch {} };
  mtx.on('error', (e) => { console.error('could not start mediamtx (brew install mediamtx):', e.message); process.exit(2); });
  await new Promise((r) => setTimeout(r, 1500));

  const settings = { get: () => ({ slateImage: path.join(FIX, 'slate.png'), slateMusic: path.join(FIX, 'music.mp3'), fadeMs: 1000, videoBitrate: 3000 }) };
  const portal = {
    streamTarget: async () => ({ ok: true, server: 'rtmp://127.0.0.1:1935/live', key: 'brain', vertical: false }),
    endBroadcast: async () => ({ ok: true }),
  };
  let idc = 0;
  const start = Date.now();
  const sched = createScheduler({
    store: memStore(), portal, settings, engineFactory: (o) => new Broadcast(o),
    genId: () => 'r' + (idc++), log: (m) => console.log('[sched]', m),
  });
  sched.addEvent({
    id: 'rehearse', title: 'Rehearsal', filePath: path.join(FIX, 'class.mp4'), durationSec: 20,
    contentItemGuid: 'ci', scheduleGuid: 'sg',
    fireAt: start + 4000, leadMs: 2000, autoStop: true, status: 'pending',
  });

  const iv = setInterval(() => sched.tick(), 1000);
  let sawPlaying = false;
  const deadline = start + 4000 + 20000 + 20000;   // fire + video + generous margin
  const poll = setInterval(() => {
    const ev = sched.getEvents().find((e) => e.id === 'rehearse');
    if (ev && (ev.status === 'playing')) sawPlaying = true;
    if (ev && (ev.status === 'done' || ev.status === 'failed')) {
      clearInterval(iv); clearInterval(poll); cleanup();
      const ok = ev.status === 'done' && sawPlaying;
      console.log(ok ? '\nBRAIN REHEARSAL PASSED (' + ev.outcome + ')' : '\nBRAIN REHEARSAL FAILED (' + ev.status + ': ' + ev.outcome + ', sawPlaying=' + sawPlaying + ')');
      process.exit(ok ? 0 : 1);
    }
    if (Date.now() > deadline) {
      clearInterval(iv); clearInterval(poll); cleanup();
      console.log('\nBRAIN REHEARSAL FAILED (timed out; last status ' + (ev && ev.status) + ')');
      process.exit(1);
    }
  }, 1000);
  void spawnSync;
})();
