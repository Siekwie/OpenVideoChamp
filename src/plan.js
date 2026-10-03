// Export planning: pure functions, no I/O. Implements the "Export rules"
// section of docs/API.md and turns a Plan into ffmpeg argv arrays.
//
// A request describes a *sequence*: one or more clips (ranges of video or
// image sources) joined by transitions, with optional fades, per-clip volume,
// a music track and loudness normalisation. The legacy single-clip request
// (sourceId/start/end) is a one-clip sequence.
import path from 'node:path';

const PRESET_MB = { discord: 10, discord50: 50, discord500: 500 };
const X264_PRESET = { fast: 'veryfast', balanced: 'medium', best: 'slow' };
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'opus', 'alac']);
const ENUMS = {
  preset: ['cut', 'discord', 'discord50', 'discord500', 'steam', 'custom'],
  cut: ['fast', 'precise'],
  audio: ['keep', 'mute'],
  speed: ['fast', 'balanced', 'best'],
};
// Constant-quality flags for hardware encoders (libx264 uses -crf).
const HW_QUALITY = {
  h264_nvenc: (q) => ['-rc', 'vbr', '-cq', String(q), '-b:v', '0'],
  h264_qsv: (q) => ['-global_quality', String(q)],
  h264_amf: (q) => ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)],
  h264_videotoolbox: (q) => ['-q:v', String(100 - q * 2)],
};

// Every xfade transition name ffmpeg has ever shipped (4.3 .. 6.1). The server narrows this
// to what the local ffmpeg actually supports (see detectTransitions) and passes it in `transitions`.
export const ALL_TRANSITIONS = ['fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup',
  'slidedown', 'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite', 'radial', 'smoothleft', 'smoothright',
  'smoothup', 'smoothdown', 'circleopen', 'circleclose', 'vertopen', 'vertclose', 'horzopen', 'horzclose', 'dissolve',
  'pixelize', 'diagtl', 'diagtr', 'diagbl', 'diagbr', 'hlslice', 'hrslice', 'vuslice', 'vdslice', 'hblur', 'fadegrays',
  'wipetl', 'wipetr', 'wipebl', 'wipebr', 'squeezeh', 'squeezev', 'zoomin', 'fadefast', 'fadeslow', 'hlwind', 'hrwind',
  'vuwind', 'vdwind', 'coverleft', 'coverright', 'coverup', 'coverdown', 'revealleft', 'revealright', 'revealup', 'revealdown'];

export const MAX_CLIPS = 100;
export const MAX_IMAGE_DURATION = 600;
export const MAX_FADE = 30;
export const PREVIEW_HEIGHT = 480;
const AUDIO_RATE = 48000;
const EPS = 1e-6;

export class PlanError extends Error {
  status = 400;
}

function fail(message) {
  throw new PlanError(message);
}

function autoOr(value, fallback = 'auto') {
  if (value == null || value === '') return fallback;
  if (value === 'auto' || value === 'source') return value;
  return Number(value);
}

function num(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${name} must be a number`);
  if (n < min || n > max) fail(`${name} must be between ${min} and ${max}`);
  return n;
}

const bool = (value, fallback = false) => (value == null ? fallback : value === true || value === 'true' || value === 1);
const round3 = (t) => Math.round(t * 1000) / 1000;
// Numbers inside a filter graph: fixed decimals, no exponent notation, no trailing zeros.
const f3 = (n) => { const s = round3(n).toFixed(3); return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s; };

function normalizeClip(input, index) {
  if (!input || typeof input !== 'object') fail(`Clip ${index + 1} must be an object`);
  if (typeof input.sourceId !== 'string' || !input.sourceId) fail(`Clip ${index + 1} has no sourceId`);
  return {
    sourceId: input.sourceId,
    start: num(input.start, `Clip ${index + 1} start`, { fallback: 0 }),
    end: num(input.end, `Clip ${index + 1} end`),
    volume: num(input.volume, `Clip ${index + 1} volume`, { min: 0, max: 4, fallback: 1 }),
    mute: bool(input.mute),
  };
}

function normalizeMusic(input) {
  if (input == null || input === false) return null;
  if (typeof input !== 'object') fail('music must be an object');
  if (typeof input.sourceId !== 'string' || !input.sourceId) fail('music has no sourceId');
  const mode = input.mode ?? 'mix';
  if (!['mix', 'replace'].includes(mode)) fail(`Invalid music mode: ${JSON.stringify(input.mode)}`);
  return {
    sourceId: input.sourceId,
    start: num(input.start, 'music start', { min: 0, fallback: 0 }),
    volume: num(input.volume, 'music volume', { min: 0, max: 4, fallback: 0.5 }),
    fadeIn: num(input.fadeIn, 'music fadeIn', { min: 0, max: MAX_FADE, fallback: 0 }),
    fadeOut: num(input.fadeOut, 'music fadeOut', { min: 0, max: MAX_FADE, fallback: 0 }),
    loop: bool(input.loop, true),
    mode,
  };
}

export function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object') fail('Expected a JSON object');
  const legacy = !Array.isArray(input.clips) || !input.clips.length;
  const clips = legacy
    ? [normalizeClip({ sourceId: input.sourceId, start: input.start, end: input.end }, 0)]
    : input.clips.map(normalizeClip);
  if (clips.length > MAX_CLIPS) fail(`At most ${MAX_CLIPS} clips per export`);
  const rawTr = Array.isArray(input.transitions) ? input.transitions : [];
  const transitions = clips.slice(1).map((_, i) => {
    const t = rawTr[i];
    if (t == null) return { type: 'cut', duration: 0 };
    if (typeof t === 'string') return t === 'cut' ? { type: 'cut', duration: 0 } : { type: t, duration: 0.5 };
    if (typeof t !== 'object') fail(`Transition ${i + 1} must be an object`);
    const type = t.type ?? 'cut';
    if (type !== 'cut' && !ALL_TRANSITIONS.includes(type)) fail(`Unknown transition: ${JSON.stringify(type)}`);
    const duration = type === 'cut' ? 0 : num(t.duration, `Transition ${i + 1} duration`, { min: 0, max: MAX_FADE, fallback: 0.5 });
    return duration > 0 ? { type, duration } : { type: 'cut', duration: 0 };
  });

  const r = {
    clips,
    transitions,
    fadeIn: num(input.fadeIn, 'fadeIn', { min: 0, max: MAX_FADE, fallback: 0 }),
    fadeOut: num(input.fadeOut, 'fadeOut', { min: 0, max: MAX_FADE, fallback: 0 }),
    music: normalizeMusic(input.music),
    normalize: bool(input.normalize),
    preview: bool(input.preview),
    preset: input.preset ?? 'cut',
    targetMB: input.targetMB == null ? null : Number(input.targetMB),
    cut: input.cut ?? 'fast',
    resolution: autoOr(input.resolution),
    fps: autoOr(input.fps),
    audio: input.audio ?? 'keep',
    speed: input.speed ?? 'balanced',
    encoder: input.encoder || 'auto',
    outputPath: input.outputPath || null,
  };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(r[key])) fail(`Invalid ${key}: ${JSON.stringify(input[key])}`);
  }
  if (r.resolution !== 'auto' && r.resolution !== 'source' && !(Number.isInteger(r.resolution) && r.resolution >= 144 && r.resolution <= 4320)) {
    fail(`Invalid resolution: ${JSON.stringify(input.resolution)}`);
  }
  if (r.fps !== 'auto' && r.fps !== 'source' && !(Number.isFinite(r.fps) && r.fps >= 1 && r.fps <= 240)) {
    fail(`Invalid fps: ${JSON.stringify(input.fps)}`);
  }
  if (r.preset === 'custom' && !(r.targetMB > 0)) fail('targetMB must be a positive number for the custom preset');
  return r;
}

const kindOf = (source) => source.kind || (source.width > 0 ? 'video' : 'audio');

// Resolves source ids, validates every range and computes the timeline.
export function resolveSequence(req, getSource, { transitions: available = ALL_TRANSITIONS } = {}) {
  const lookup = typeof getSource === 'function' ? getSource : (id) => getSource.get?.(id) ?? getSource[id];
  const clips = req.clips.map((c, i) => {
    const source = lookup(c.sourceId);
    if (!source) fail(`Clip ${i + 1}: unknown source ${c.sourceId}`);
    const kind = kindOf(source);
    if (kind === 'audio') fail(`Clip ${i + 1}: "${source.name}" has no video; use it as music instead`);
    const image = kind === 'image';
    const start = image ? 0 : c.start;
    const end = c.end;
    const duration = end - start;
    const label = req.clips.length > 1 ? `Clip ${i + 1} (${source.name})` : 'Range';
    if (duration < 0.1) fail(`${label} must be at least 0.1 s long`);
    if (image) {
      if (duration > MAX_IMAGE_DURATION) fail(`${label}: an image can be shown for at most ${MAX_IMAGE_DURATION} s`);
    } else if (start < 0 || end > source.duration + 0.05) fail(`${label} is outside the source`);
    const audible = !image && !c.mute && source.hasAudio && req.audio !== 'mute';
    return { source, start, end, duration, volume: c.volume, mute: c.mute, image, audible };
  });

  const transitions = req.transitions.map((t, i) => {
    if (t.type !== 'cut' && !available.includes(t.type)) fail(`Transition "${t.type}" is not supported by this ffmpeg`);
    return { ...t };
  });
  // Every transition eats into both neighbours; the two transitions around a clip may not overlap.
  for (let i = 0; i < clips.length; i++) {
    const before = i > 0 ? transitions[i - 1].duration : 0;
    const after = i < transitions.length ? transitions[i].duration : 0;
    if (before + after > clips[i].duration + EPS) {
      fail(`Clip ${i + 1} (${clips[i].source.name}) is ${f3(clips[i].duration)} s, too short for its ${f3(before + after)} s of transitions`);
    }
  }
  const total = round3(clips.reduce((s, c) => s + c.duration, 0) - transitions.reduce((s, t) => s + t.duration, 0));
  if (req.fadeIn + req.fadeOut > total + EPS) fail('Fade in and fade out together are longer than the video');

  let music = null;
  if (req.music) {
    const source = lookup(req.music.sourceId);
    if (!source) fail(`Music: unknown source ${req.music.sourceId}`);
    if (!source.hasAudio) fail(`Music: "${source.name}" has no audio`);
    if (req.music.start >= source.duration) fail('Music start is beyond the end of the track');
    if (req.music.fadeIn + req.music.fadeOut > total + EPS) fail('Music fades are longer than the video');
    music = { ...req.music, source };
  }
  return { clips, transitions, total, music, fadeIn: req.fadeIn, fadeOut: req.fadeOut, normalize: req.normalize };
}

const fmtMB = (bytes) => `~${bytes >= 1e8 ? Math.round(bytes / 1e6) : (bytes / 1e6).toFixed(1)} MB`;
const fmtFps = (fps) => String(Math.round(fps * 100) / 100);
const fmtKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${k} kbps`);

// Can this request be a stream copy? Only a plain single video range with nothing applied to it.
function copyEligible(req, seq) {
  const [c] = seq.clips;
  return seq.clips.length === 1 && !c.image && c.volume === 1 && !seq.music && !seq.fadeIn && !seq.fadeOut
    && !seq.normalize && !req.preview && req.preset === 'cut' && req.cut === 'fast';
}

// The "reference" the resolution/fps/bitrate rules work against: the canvas follows the orientation
// that is on screen longest (a vertical phone clip in a landscape trailer gets pillarboxed, not the
// other way round), and within it the sharpest video source (or the first image when there is no video).
function referenceSource(seq) {
  const orient = (s) => (s.width > s.height ? 'landscape' : s.width < s.height ? 'portrait' : 'square');
  const time = {};
  for (const c of seq.clips) time[orient(c.source)] = (time[orient(c.source)] || 0) + c.duration;
  const dominant = Object.keys(time).sort((a, b) => time[b] - time[a] || (a === 'landscape' ? -1 : 1))[0];
  const pool = seq.clips.filter((c) => orient(c.source) === dominant);
  const videos = pool.filter((c) => !c.image);
  const ref = (videos.length ? videos : pool).reduce((best, c) => (c.source.height > best.source.height ? c : best)).source;
  const allVideos = seq.clips.filter((c) => !c.image);
  const span = allVideos.reduce((s, c) => s + c.duration, 0);
  const bitrate = span ? Math.round(allVideos.reduce((s, c) => s + (c.source.bitrate || 0) * c.duration, 0) / span) : 0;
  return {
    width: ref.width, height: ref.height,
    fps: allVideos.length ? Math.max(...allVideos.map((c) => c.source.fps || 30)) : 30,
    bitrate,
    hasAudio: seq.clips.some((c) => c.audible) || Boolean(seq.music),
  };
}

export function planExport(sources, input, { encoders = ['libx264'], transitions = ALL_TRANSITIONS, defaultOutputDir = '.', previewDir = null, exists = () => false, keyframes = [] } = {}) {
  const req = normalizeRequest(input);
  // Legacy call style: a single Source object.
  const getSource = sources && typeof sources === 'object' && typeof sources.id === 'string' ? (id) => (id === sources.id ? sources : null) : sources;
  const seq = resolveSequence(req, getSource, { transitions });
  const first = seq.clips[0].source;
  const duration = seq.total;
  const ref = referenceSource(seq);

  const targetBytes = req.preview ? null : req.preset === 'custom' ? Math.round(req.targetMB * 1e6)
    : PRESET_MB[req.preset] ? PRESET_MB[req.preset] * 1e6 : null;
  const mode = !targetBytes && copyEligible(req, seq) ? 'copy' : 'encode';
  const muted = req.audio === 'mute' || !ref.hasAudio;
  const warnings = [];

  const plan = {
    mode, twoPass: false, encoder: null, videoKbps: null, crf: null,
    audioKbps: muted ? 0 : null,
    width: ref.width, height: ref.height, fps: ref.fps,
    duration, clips: seq.clips.length, transitions: seq.transitions.filter((t) => t.type !== 'cut').length,
    music: Boolean(seq.music), preview: req.preview,
    targetBytes, estimatedBytes: null, outputPath: null, warnings, summary: '',
  };

  let ext = '.mp4';
  if (mode === 'copy') {
    const [clip] = seq.clips;
    const snapped = [...keyframes].reverse().find((t) => t <= clip.start + 1e-3) ?? clip.start;
    const back = clip.start - snapped;
    if (back > 0.5) {
      warnings.push(`Fast cut starts ${back.toFixed(1)} s earlier (at ${snapped.toFixed(2)} s) to land on a keyframe; use a precise cut for an exact start.`);
    }
    if (!MP4_VIDEO.has(first.videoCodec) || (!muted && !MP4_AUDIO.has(first.audioCodec))) ext = '.mkv';
    plan.estimatedBytes = Math.round((first.bitrate || 0) * 125 * (clip.end - snapped));
    plan.summary = `${fmtMB(plan.estimatedBytes)} · ${plan.width}×${plan.height} · ${fmtFps(plan.fps)} fps · stream copy, no re-encode`;
  } else {
    const encoder = req.encoder === 'auto' ? 'libx264' : req.encoder;
    if (!encoders.includes(encoder)) fail(`Encoder not available: ${encoder}`);
    const hardware = encoder !== 'libx264';
    plan.encoder = encoder;
    let capped = false;

    if (targetBytes) {
      // 4 % mux overhead/safety; hardware rate control is sloppier, so another 4 %.
      const budget = targetBytes * 0.96 * (hardware ? 0.96 : 1);
      const totalKbps = (budget * 8) / duration / 1000;
      plan.audioKbps = muted ? 0 : totalKbps >= 1200 ? 128 : totalKbps >= 600 ? 96 : 64;
      plan.videoKbps = Math.floor(totalKbps - plan.audioKbps);
      // Don't inflate short clips past their source: more bits than ~1.5x the source bitrate buy nothing.
      if (ref.bitrate > 0 && plan.videoKbps > ref.bitrate * 1.5) {
        plan.videoKbps = Math.round(ref.bitrate * 1.5);
        capped = true;
      }
      if (plan.videoKbps < 32) fail('Target size is too small for this duration');
      if (plan.videoKbps < 150) warnings.push('Very low bitrate for this length; expect heavy quality loss.');
      plan.twoPass = !hardware;
    } else if (req.preview) {
      plan.crf = 28;
      plan.audioKbps = muted ? 0 : 96;
    } else {
      plan.crf = req.preset === 'steam' ? 18 : 20;
      plan.audioKbps = muted ? 0 : req.preset === 'steam' ? 192 : 160;
    }

    // Resolution / fps. Heights are clamped to the reference (never upscale) and even.
    const srcW = ref.width, srcH = ref.height;
    const dimsFor = (h) => {
      h = Math.min(h, srcH) & ~1;
      return { width: Math.round((srcW * h) / srcH / 2) * 2, height: h };
    };
    const bpp = (d, fps) => (plan.videoKbps * 1000) / (d.width * d.height * fps);
    const steamAuto = req.preset === 'steam' && req.resolution === 'auto';
    let fps = req.fps === 'auto' || req.fps === 'source' ? ref.fps : Math.min(req.fps, ref.fps);
    if (req.preset === 'steam' && req.fps === 'auto') fps = Math.min(fps, 60);

    let height;
    if (typeof req.resolution === 'number') height = req.resolution;
    else if (req.resolution === 'source' || !targetBytes || capped) height = steamAuto ? Math.min(srcH, 1080) : srcH;
    else {
      const candidates = [...new Set([srcH, 1080, 720, 480, 360].filter((h) => h <= srcH))].sort((a, b) => b - a);
      height = candidates.find((h) => bpp(dimsFor(h), fps) >= 0.05) ?? candidates.at(-1);
    }
    if (req.preview) { height = Math.min(height, PREVIEW_HEIGHT); fps = Math.min(fps, 60); }
    const dims = dimsFor(height);
    if (targetBytes && !capped && req.fps === 'auto' && ref.fps > 30 && bpp(dims, fps) < 0.05) fps = 30;
    plan.width = dims.width;
    plan.height = dims.height;
    plan.fps = fps;

    const dimsStr = `${dims.width}×${dims.height} · ${fmtFps(fps)} fps`;
    const audioStr = muted ? ', no audio' : ` + ${plan.audioKbps} kbps audio`;
    if (targetBytes) {
      plan.estimatedBytes = Math.round((plan.videoKbps + plan.audioKbps) * 125 * duration);
      plan.summary = `${fmtMB(plan.estimatedBytes)} · ${dimsStr} · ${fmtKbps(plan.videoKbps)} video${audioStr} · ${plan.twoPass ? '2-pass' : `${encoder} 1-pass`}`;
    } else {
      // Rough CRF size guess: bits per pixel typical for crf 18/20/28, capped by the source bitrate.
      const bppGuess = plan.crf === 18 ? 0.1 : plan.crf === 20 ? 0.08 : 0.04;
      const guessKbps = Math.min((dims.width * dims.height * fps * bppGuess) / 1000, ref.bitrate || Infinity);
      plan.estimatedBytes = Math.round((guessKbps + plan.audioKbps) * 125 * duration);
      plan.summary = req.preview ? `Draft preview · ${dimsStr}${audioStr}`
        : `${fmtMB(plan.estimatedBytes)} (est.) · ${dimsStr} · CRF ${plan.crf} ${encoder}${audioStr}`;
    }
    if (seq.clips.some((c) => !c.image && c.source.fps > fps + 0.01) && seq.clips.length > 1 && !req.preview) {
      warnings.push(`Clips are conformed to ${fmtFps(fps)} fps.`);
    }
  }

  let dir, base;
  if (req.preview) {
    dir = previewDir || defaultOutputDir;
    base = `preview-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  } else if (req.outputPath) {
    const p = path.resolve(req.outputPath);
    for (const c of seq.clips) if (p === path.resolve(c.source.path)) fail('Output path must differ from the source file');
    if (seq.music && p === path.resolve(seq.music.source.path)) fail('Output path must differ from the music file');
    dir = path.dirname(p);
    ext = path.extname(p) || ext;
    base = path.basename(p, path.extname(p));
  } else {
    const tag = targetBytes ? `${targetBytes / 1e6}MB` : req.preset === 'steam' ? 'steam' : 'cut';
    dir = first.uploaded ? defaultOutputDir : path.dirname(first.path);
    const stem = path.basename(first.name, path.extname(first.name));
    base = `${stem}_${seq.clips.length > 1 ? 'edit_' : ''}${tag}`;
  }
  // Never overwrite anything, explicit path or not.
  plan.outputPath = path.join(dir, base + ext);
  for (let n = 2; exists(plan.outputPath); n++) plan.outputPath = path.join(dir, `${base}-${n}${ext}`);
  return plan;
}

// Scale a clip into the W×H canvas: same aspect → plain scale, otherwise letterbox/pillarbox.
function fitFilters(src, W, H) {
  if (src.width === W && src.height === H) return [];
  const same = Math.abs(src.width / src.height - W / H) < 0.01;
  if (same) return [`scale=${W}:${H}:flags=bicubic`];
  return [`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`];
}

const AFORMAT = `aresample=${AUDIO_RATE}:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo`;

// filter_complex for the sequence. `withAudio=false` builds the video-only graph for two-pass pass 1.
export function buildFilterGraph(plan, seq, { withAudio = true } = {}) {
  const { width: W, height: H, fps: F } = plan;
  const T = seq.total;
  const parts = [];
  const vLabels = [], aLabels = [];
  // "Music only" drops the clip audio entirely; building it would leave an unconnected filter output.
  const clipAudio = withAudio && !(seq.music && seq.music.mode === 'replace');

  seq.clips.forEach((c, k) => {
    const d = f3(c.duration);
    const video = ['setpts=PTS-STARTPTS', `fps=${f3(F)}`, ...fitFilters(c.source, W, H), 'setsar=1', 'format=yuv420p', 'tpad=stop=-1', `trim=duration=${d}`];
    parts.push(`[${k}:v]${video.join(',')}[v${k}]`);
    vLabels.push(`[v${k}]`);
    if (!clipAudio) return;
    if (c.audible) {
      const vol = c.volume !== 1 ? [`volume=${f3(c.volume)}`] : [];
      // 5 ms edge fades remove clicks at hard cuts without changing the clip length.
      const audio = ['asetpts=PTS-STARTPTS', AFORMAT, ...vol, `apad=whole_dur=${d}`, `atrim=duration=${d}`, 'afade=t=in:d=0.005', `afade=t=out:st=${f3(c.duration - 0.005)}:d=0.005`];
      parts.push(`[${k}:a]${audio.join(',')}[a${k}]`);
    } else {
      parts.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${d}[a${k}]`);
    }
    aLabels.push(`[a${k}]`);
  });

  // Chain the clips: a cut is a concat, anything else an xfade/acrossfade at the running offset.
  let v = vLabels[0], a = aLabels[0], acc = seq.clips[0].duration;
  seq.transitions.forEach((t, i) => {
    const k = i + 1;
    if (t.type === 'cut') {
      parts.push(`${v}${vLabels[k]}concat=n=2:v=1:a=0[x${k}]`);
      if (clipAudio) parts.push(`${a}${aLabels[k]}concat=n=2:v=0:a=1[y${k}]`);
      acc += seq.clips[k].duration;
    } else {
      parts.push(`${v}${vLabels[k]}xfade=transition=${t.type}:duration=${f3(t.duration)}:offset=${f3(acc - t.duration)}[x${k}]`);
      if (clipAudio) parts.push(`${a}${aLabels[k]}acrossfade=d=${f3(t.duration)}:c1=tri:c2=tri[y${k}]`);
      acc += seq.clips[k].duration - t.duration;
    }
    v = `[x${k}]`;
    a = `[y${k}]`;
  });

  const vTail = [];
  if (seq.fadeIn > 0) vTail.push(`fade=t=in:d=${f3(seq.fadeIn)}`);
  if (seq.fadeOut > 0) vTail.push(`fade=t=out:st=${f3(T - seq.fadeOut)}:d=${f3(seq.fadeOut)}`);
  if (vTail.length) { parts.push(`${v}${vTail.join(',')}[vout]`); v = '[vout]'; }
  if (!withAudio) return { graph: parts.join(';'), video: v, audio: null };

  if (seq.music) {
    const m = seq.music, M = seq.clips.length;
    const chain = ['asetpts=PTS-STARTPTS', AFORMAT];
    if (m.volume !== 1) chain.push(`volume=${f3(m.volume)}`);
    if (m.fadeIn > 0) chain.push(`afade=t=in:d=${f3(m.fadeIn)}`);
    if (m.fadeOut > 0) chain.push(`afade=t=out:st=${f3(T - m.fadeOut)}:d=${f3(m.fadeOut)}`);
    chain.push(`apad=whole_dur=${f3(T)}`, `atrim=duration=${f3(T)}`);
    parts.push(`[${M}:a]${chain.join(',')}[m]`);
    if (m.mode === 'replace') a = '[m]';
    else { parts.push(`${a}[m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`); a = '[mix]'; }
  }
  const aTail = [];
  if (seq.fadeIn > 0) aTail.push(`afade=t=in:d=${f3(seq.fadeIn)}`);
  if (seq.fadeOut > 0) aTail.push(`afade=t=out:st=${f3(T - seq.fadeOut)}:d=${f3(seq.fadeOut)}`);
  // loudnorm works internally at 192 kHz and would output that; bring it back down.
  if (seq.normalize) aTail.push('loudnorm=I=-14:TP=-1.5:LRA=11', `aresample=${AUDIO_RATE}`);
  if (aTail.length) { parts.push(`${a}${aTail.join(',')}[aout]`); a = '[aout]'; }
  return { graph: parts.join(';'), video: v, audio: a };
}

// Returns one ffmpeg argv array per pass.
export function buildArgs(plan, sources, input, { passLogFile, nullDevice, transitions = ALL_TRANSITIONS } = {}) {
  const req = normalizeRequest(input);
  const getSource = sources && typeof sources === 'object' && typeof sources.id === 'string' ? (id) => (id === sources.id ? sources : null) : sources;
  const seq = resolveSequence(req, getSource, { transitions });
  const head = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const faststart = plan.outputPath.toLowerCase().endsWith('.mkv') ? [] : ['-movflags', '+faststart'];
  const audio = plan.audioKbps ? ['-c:a', 'aac', '-b:a', `${plan.audioKbps}k`, '-ar', String(AUDIO_RATE)] : ['-an'];

  if (plan.mode === 'copy') {
    const [c] = seq.clips;
    // make_zero: -ss before -i with stream copy yields packets before the cut point with negative timestamps.
    return [[...head, '-ss', String(c.start), '-i', c.source.path, '-t', String(plan.duration),
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(plan.audioKbps === 0 ? ['-an'] : []), ...faststart, plan.outputPath]];
  }

  const inputs = [];
  for (const c of seq.clips) {
    if (c.image) inputs.push('-loop', '1', '-framerate', f3(plan.fps), '-t', f3(c.duration), '-i', c.source.path);
    else inputs.push('-ss', f3(c.start), '-t', f3(c.duration), '-i', c.source.path);
  }
  const musicInput = [];
  if (seq.music && plan.audioKbps) {
    if (seq.music.loop) musicInput.push('-stream_loop', '-1');
    if (seq.music.start > 0) musicInput.push('-ss', f3(seq.music.start));
    musicInput.push('-i', seq.music.source.path);
  }
  const withAudio = plan.audioKbps > 0;
  const full = buildFilterGraph(plan, seq, { withAudio });
  const mapsFor = (g, useAudio) => ['-filter_complex', g.graph, '-map', g.video, ...(useAudio && g.audio ? ['-map', g.audio] : [])];
  const common = ['-t', f3(plan.duration)];
  const x264 = plan.encoder === 'libx264' ? ['-preset', req.preview ? 'ultrafast' : X264_PRESET[req.speed]] : [];
  const video = ['-c:v', plan.encoder, ...x264];
  const pix = ['-pix_fmt', plan.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p'];

  if (plan.crf != null) {
    const quality = plan.encoder === 'libx264' ? ['-crf', String(plan.crf)] : HW_QUALITY[plan.encoder](plan.crf);
    return [[...head, ...inputs, ...musicInput, ...mapsFor(full, withAudio), ...common, ...video, ...quality, ...pix, ...(withAudio ? audio : ['-an']), ...faststart, plan.outputPath]];
  }

  const v = plan.videoKbps;
  const rate = ['-b:v', `${v}k`, '-maxrate', `${Math.round(v * 1.5)}k`, '-bufsize', `${v * 3}k`];
  if (!plan.twoPass) return [[...head, ...inputs, ...musicInput, ...mapsFor(full, withAudio), ...common, ...video, ...rate, ...pix, ...(withAudio ? audio : ['-an']), ...faststart, plan.outputPath]];

  const passlog = passLogFile ?? `${plan.outputPath}.passlog`;
  const nul = nullDevice ?? (process.platform === 'win32' ? 'NUL' : '/dev/null');
  const videoOnly = buildFilterGraph(plan, seq, { withAudio: false });
  return [
    [...head, ...inputs, ...mapsFor(videoOnly, false), ...common, ...video, ...rate, ...pix, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', nul],
    [...head, ...inputs, ...musicInput, ...mapsFor(full, withAudio), ...common, ...video, ...rate, ...pix, '-pass', '2', '-passlogfile', passlog, ...(withAudio ? audio : ['-an']), ...faststart, plan.outputPath],
  ];
}
