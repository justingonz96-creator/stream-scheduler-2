'use strict';
// Builds the complete ffmpeg argv for one continuous broadcast (spec §5).
// Uniform shape: exactly three inputs when a slate phase exists —
//   [0] slate image (looped stills), [1] slate audio (MP3 looped, or silence), [2] class video —
// so there is ONE filter-graph path, not four.

const SLATE_AUDIO_SILENT = 'anullsrc=r=44100:cl=stereo';

function canvas(vertical) { return vertical ? [1080, 1920] : [1920, 1080]; }

function hasSlatePhase(o) {
  return (o.resumeOffsetSec || 0) <= 0 && (o.leadSec || 0) > 0 && !!o.slateImage;
}

function videoStartsAtSec(o) { return hasSlatePhase(o) ? o.leadSec : 0; }

// Frame rate: use the source's own when it is a sane broadcast rate, so a
// 29.97 export is not re-timed to 30 (a duplicated frame every 33 s). Delivered
// as an exact ratio for the NTSC rates. Above 60 or below 23 → 30.
function fpsSpec(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n < 23 || n > 60 || n > 30.5) return { num: 30, filter: '30' };
  if (Math.abs(n - 29.97) < 0.02) return { num: 30000 / 1001, filter: '30000/1001' };
  if (Math.abs(n - 23.976) < 0.02) return { num: 24000 / 1001, filter: '24000/1001' };
  return { num: n, filter: String(n) };
}
function clampKbps(k) {
  const n = Number(k);
  if (!Number.isFinite(n) || n === 0) return 6000;
  return Math.min(20000, Math.max(500, Math.round(n)));
}

function buildBroadcastArgs(o) {
  const fpsS = fpsSpec(o.fps);
  const fps = fpsS.filter;                 // for the fps= filter
  const gop = String(Math.round(fpsS.num * 2));
  const kbps = clampKbps(o.bitrateKbps);
  const fade = o.fadeSec == null ? 1 : o.fadeSec;
  const [W, H] = canvas(!!o.vertical);
  // Colour: convert EVERY input to limited-range bt709 explicitly. The slate
  // JPEG is full-range (pc) with a bt470bg matrix, and the crossfade output
  // inherited those tags for the WHOLE class — whose content is tv-range bt709 —
  // so players could render it washed out or crushed (2026-09-04 audit).
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:in_range=auto:out_range=tv:in_color_matrix=auto:out_color_matrix=bt709,` +
              `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},` +
              // stamp the full set on the FRAMES: libx264 writes its VUI from frame
              // properties, so -color_primaries/-color_trc alone left them "unspecified"
              `setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,format=yuv420p`;
  const afmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

  // -y: never ASK about an existing output. stdin is a pipe now (so 'q' can stop
  // the encode gracefully), and without -y ffmpeg would sit waiting for an
  // "Overwrite? [y/N]" answer that never comes — a broadcast that silently never
  // starts (found by the audit-fix tests, 2026-09-04).
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1'];
  let filter;

  // Detectors print to stderr (metadata=print → pipe:2), which the engine parses
  // for a live "picture is black / sound is silent" warning (2026-09-04 audit).
  // (one keyless printer each: it prints every start/end line the detector sets;
  // the colon in pipe:2 must be quoted+escaped for the filter-graph parser)
  const blackDet = "blackdetect=d=10:pix_th=0.10,metadata=print:file='pipe\\:2'";
  const silentDet = "silencedetect=n=-50dB:d=15,ametadata=print:file='pipe\\:2'";

  if (hasSlatePhase(o)) {
    const span = o.leadSec + fade;                       // slate persists through the fade
    // NO -re on any input. Pacing happens once, at the OUTPUT (realtime on
    // video + arealtime on audio, below). Per-input -re paces by packet
    // timestamps, and the studio's export tool writes files in ~⅓ s chunks of
    // video then audio; once the class input has waited behind the slate, -re
    // on such a file throttled the whole encode to ~0.70x (20 fps, ⅔ bitrate at
    // the platform, class ends late). Proven 2026-09-04 with a real export on a
    // Mac and on the studio PC; output pacing ran 0.999x on every path.
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', o.slateImage);
    if (o.slateMusic) args.push('-stream_loop', '-1', '-t', String(span), '-i', o.slateMusic);
    else args.push('-f', 'lavfi', '-t', String(span), '-i', SLATE_AUDIO_SILENT);
    args.push('-i', o.videoPath);
    filter = [
      // Flatten the slate onto black first: a PNG with transparency otherwise
      // shows whatever colour sits under its alpha once alpha is dropped.
      `[0:v]${fit.replace(',format=yuv420p', '')},format=rgba[slraw]`,
      `color=c=black:s=${W}x${H}:r=${fps}[slbg]`,
      `[slbg][slraw]overlay=0:0:shortest=1,${fit.replace(/^scale=[^,]+,pad=[^,]+,/, '')}[slv]`,
      `[2:v]${fit},${blackDet}[vv]`,
      // `realtime` clamps the graph output to wall-clock. Per-input `-re` reliably
      // paces a SINGLE input, but not this multi-input (looped slate) composition —
      // without it the slate path ran ~4.7% fast, ending classes minutes early.
      // format=yuv420p LAST: the slate and the class share one output stream, and
      // the pixel format is re-negotiated after the crossfade — a 4:4:4 slate JPEG
      // (Photoshop's default) otherwise drags the WHOLE broadcast into H.264
      // High 4:4:4 Predictive, which streaming platforms and many decoders reject.
      `[slv][vv]xfade=transition=fade:duration=${fade}:offset=${o.leadSec},realtime,format=yuv420p[vout]`,
      `[1:a]${afmt}[sla]`,
      `[2:a]${afmt},${silentDet}[va]`,
      `[sla][va]acrossfade=d=${fade},arealtime[aout]`,
    ].join(';');
  } else {
    if ((o.resumeOffsetSec || 0) > 0) args.push('-ss', String(o.resumeOffsetSec));
    args.push('-i', o.videoPath);   // no -re: see the slate path — the plain path ran 0.54x on a real export with it
    filter = [`[0:v]${fit},${blackDet},realtime,format=yuv420p[vout]`, `[0:a]${afmt},${silentDet},arealtime[aout]`].join(';');
  }

  args.push(
    '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',   // signal what we now produce
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-g', gop, '-keyint_min', gop,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', o.outUrl,
  );
  return args;
}

module.exports = { buildBroadcastArgs, videoStartsAtSec, SLATE_AUDIO_SILENT };
