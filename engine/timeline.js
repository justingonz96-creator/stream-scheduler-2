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

function buildBroadcastArgs(o) {
  const fps = o.fps || 30;
  const kbps = o.bitrateKbps || 6000;
  const fade = o.fadeSec == null ? 1 : o.fadeSec;
  const [W, H] = canvas(!!o.vertical);
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
              `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  const afmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1'];
  let filter;

  if (hasSlatePhase(o)) {
    const span = o.leadSec + fade;                       // slate persists through the fade
    args.push('-re', '-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', o.slateImage);
    if (o.slateMusic) args.push('-re', '-stream_loop', '-1', '-t', String(span), '-i', o.slateMusic);
    else args.push('-f', 'lavfi', '-t', String(span), '-i', SLATE_AUDIO_SILENT);
    args.push('-re', '-i', o.videoPath);
    filter = [
      `[0:v]${fit}[slv]`,
      `[2:v]${fit}[vv]`,
      // `realtime` clamps the graph output to wall-clock. Per-input `-re` reliably
      // paces a SINGLE input, but not this multi-input (looped slate) composition —
      // without it the slate path ran ~4.7% fast, ending classes minutes early.
      // format=yuv420p LAST: the slate and the class share one output stream, and
      // the pixel format is re-negotiated after the crossfade — a 4:4:4 slate JPEG
      // (Photoshop's default) otherwise drags the WHOLE broadcast into H.264
      // High 4:4:4 Predictive, which streaming platforms and many decoders reject.
      `[slv][vv]xfade=transition=fade:duration=${fade}:offset=${o.leadSec},realtime,format=yuv420p[vout]`,
      `[1:a]${afmt}[sla]`,
      `[2:a]${afmt}[va]`,
      `[sla][va]acrossfade=d=${fade}[aout]`,
    ].join(';');
  } else {
    if ((o.resumeOffsetSec || 0) > 0) args.push('-ss', String(o.resumeOffsetSec));
    args.push('-re', '-i', o.videoPath);
    filter = [`[0:v]${fit},format=yuv420p[vout]`, `[0:a]${afmt}[aout]`].join(';');
  }

  args.push(
    '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', o.outUrl,
  );
  return args;
}

module.exports = { buildBroadcastArgs, videoStartsAtSec, SLATE_AUDIO_SILENT };
