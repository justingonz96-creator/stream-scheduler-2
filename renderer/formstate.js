'use strict';
// The spotlight-step-1 state machine (spec §3). Step 1 (pick the video) is the
// anchor: everything else stays dim until a video is chosen, then step 1 collapses
// to a compact "✓ file · length" row and the rest activates. Pure — the DOM layer
// (app.js) reads these decisions and toggles classes/attributes. A class link is
// REQUIRED to save, because the brain aborts any broadcast with no studio.
function basename(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }
function mmss(sec) { const s = Math.max(0, Math.round(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function hasVideo(state) { return !!state.filePath && state.durationSec > 0; }

function computeFormPhase(state) {
  const picked = hasVideo(state);
  const reasons = [];
  if (!picked) reasons.push('Choose the video that should play.');
  if (!state.fireAt) reasons.push('Set the date and start time.');
  if (!(state.contentItemGuid && state.linkChecked)) reasons.push('Paste the class link and press "Check this class link".');
  return {
    step1: picked ? 'collapsed' : 'spotlight',
    rest: picked ? 'active' : 'dim',
    canSave: reasons.length === 0,
    reasons,
  };
}

function pickedSummary(state) {
  if (!hasVideo(state)) return '';
  return basename(state.filePath) + ' · ' + mmss(state.durationSec);
}

const API = { computeFormPhase, pickedSummary };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.FormState = API;
