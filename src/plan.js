// Export planning: pure functions, no I/O. Implements the "Export rules"
// section of docs/API.md and turns a Plan into ffmpeg argv arrays.
//
// A request describes a *sequence*: one or more clips (ranges of video or
// image sources) joined by transitions, with optional fades, per-clip volume,
// a music track and loudness normalisation. The legacy single-clip request
// (sourceId/start/end) is a one-clip sequence.
import path from 'node:path';
import { LOOKS } from '../public/js/looks.js';

const PRESET_MB = { discord: 10, discord50: 50, discord500: 500 };
// Presets without a size target that cap the canvas at 1080 (short side) and 60 fps, CRF 18.
const HQ_PRESETS = new Set(['steam', 'tiktok']);
const X264_PRESET = { fast: 'veryfast', balanced: 'medium', best: 'slow' };
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'opus', 'alac']);
const ENUMS = {
  preset: ['cut', 'discord', 'discord50', 'discord500', 'steam', 'tiktok', 'custom'],
  cut: ['fast', 'precise'],
  audio: ['keep', 'mute'],
  speed: ['fast', 'balanced', 'best'],
  fit: ['fit', 'fill', 'blur'],
};
// Output canvas shapes. "auto" follows the clips (landscape unless portrait clips dominate); the tiktok
// preset makes "auto" mean 9:16.
export const ASPECTS = { auto: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
export const FITS = ENUMS.fit;
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
export const MAX_SOUNDS = 20;
export const MAX_PAN_KEYS = 50;
export const FLASH_SECONDS = 0.35;
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
const fixed = (n, digits) => { const s = n.toFixed(digits); return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s; };
const f3 = (n) => fixed(n, 3);
const f6 = (n) => fixed(n, 6); // frame-derived times (n / fps) need more than milliseconds

function hex(value, name, fallback) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(`${name} is required`);
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value));
  if (!m) fail(`${name} must be a colour like "#e0301e"`);
  return `#${m[1].toLowerCase()}`;
}

function oneOf(value, allowed, name, fallback) {
  if (value == null || value === '') return fallback;
  if (!allowed.includes(value)) fail(`Invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

// A colour grade. Returns null when it changes nothing, so "no look" has a single representation.
export function normalizeLook(input, name = 'look') {
  if (input == null || input === false) return null;
  // A preset by name: "punchy", "neon", ... (GET /api/info lists them with their values).
  if (typeof input === 'string') {
    if (!Object.hasOwn(LOOKS, input)) fail(`Unknown ${name}: ${JSON.stringify(input)} (one of ${Object.keys(LOOKS).join(', ')})`);
    return LOOKS[input].look ? normalizeLook(LOOKS[input].look, name) : null;
  }
  if (typeof input !== 'object') fail(`${name} must be an object or a look name`);
  let tint = null;
  if (input.tint != null && input.tint !== false) {
    const t = typeof input.tint === 'string' ? { color: input.tint } : input.tint;
    if (typeof t !== 'object') fail(`${name} tint must be an object`);
    tint = { color: hex(t.color, `${name} tint color`), amount: num(t.amount, `${name} tint amount`, { min: 0, max: 1, fallback: 0.3 }) };
    if (!tint.amount) tint = null;
  }
  const look = {
    brightness: num(input.brightness, `${name} brightness`, { min: -1, max: 1, fallback: 0 }),
    contrast: num(input.contrast, `${name} contrast`, { min: 0, max: 3, fallback: 1 }),
    saturation: num(input.saturation, `${name} saturation`, { min: 0, max: 3, fallback: 1 }),
    gamma: num(input.gamma, `${name} gamma`, { min: 0.1, max: 10, fallback: 1 }),
    hue: num(input.hue, `${name} hue`, { min: -180, max: 180, fallback: 0 }),
    sharpen: num(input.sharpen, `${name} sharpen`, { min: 0, max: 2, fallback: 0 }),
    motionBlur: num(input.motionBlur, `${name} motionBlur`, { min: 0, max: 1, fallback: 0 }),
    tint,
  };
  const identity = !look.brightness && look.contrast === 1 && look.saturation === 1 && look.gamma === 1 && !look.hue
    && !look.sharpen && !look.motionBlur && !look.tint;
  return identity ? null : look;
}

// Reframing keyframes: [{ t, x, y }] (t in source seconds, x/y 0..1 = where the crop window sits inside
// the room it has to move). A single { x, y } object is a fixed position.
function normalizePan(input, name) {
  if (input == null || input === false) return [];
  const list = Array.isArray(input) ? input : [input];
  if (list.length > MAX_PAN_KEYS) fail(`${name}: at most ${MAX_PAN_KEYS} keyframes`);
  return list.map((k, i) => {
    if (!k || typeof k !== 'object') fail(`${name} keyframe ${i + 1} must be an object`);
    return {
      t: num(k.t, `${name} keyframe ${i + 1} t`, { min: 0, fallback: 0 }),
      x: num(k.x, `${name} keyframe ${i + 1} x`, { min: 0, max: 1, fallback: 0.5 }),
      y: num(k.y, `${name} keyframe ${i + 1} y`, { min: 0, max: 1, fallback: 0.5 }),
    };
  }).sort((a, b) => a.t - b.t);
}

// Selective colour: everything but one colour turns grey, optionally only from/until a source time.
function normalizeKeepColor(input, name) {
  if (input == null || input === false) return null;
  const k = input === true ? {} : input;
  if (typeof k !== 'object') fail(`${name} must be an object`);
  const time = (v, what) => (v == null || v === '' ? null : num(v, `${name} ${what}`, { min: 0 }));
  return {
    color: hex(k.color, `${name} color`, '#e0301e'),
    range: num(k.range, `${name} range`, { min: 0.01, max: 1, fallback: 0.3 }),
    softness: num(k.softness, `${name} softness`, { min: 0, max: 1, fallback: 0.1 }),
    from: time(k.from, 'from'),
    until: time(k.until, 'until'),
  };
}

function normalizeSounds(input, name) {
  if (input == null || input === false) return [];
  if (!Array.isArray(input)) fail(`${name} must be an array`);
  if (input.length > MAX_SOUNDS) fail(`${name}: at most ${MAX_SOUNDS} sounds per clip`);
  return input.map((s, i) => {
    if (!s || typeof s !== 'object') fail(`${name} ${i + 1} must be an object`);
    if (typeof s.sourceId !== 'string' || !s.sourceId) fail(`${name} ${i + 1} has no sourceId`);
    return {
      sourceId: s.sourceId,
      at: s.at == null || s.at === '' ? null : num(s.at, `${name} ${i + 1} at`, { min: 0 }),
      volume: num(s.volume, `${name} ${i + 1} volume`, { min: 0, max: 4, fallback: 1 }),
    };
  });
}

// The fields of one clip; the legacy single-range request carries the same ones at the top level.
const CLIP_KEYS = ['sourceId', 'start', 'end', 'volume', 'mute', 'rate', 'fit', 'zoom', 'pan', 'look', 'keepColor', 'hit', 'flash', 'sounds'];

function normalizeClip(input, index) {
  if (!input || typeof input !== 'object') fail(`Clip ${index + 1} must be an object`);
  if (typeof input.sourceId !== 'string' || !input.sourceId) fail(`Clip ${index + 1} has no sourceId`);
  const name = `Clip ${index + 1}`;
  return {
    sourceId: input.sourceId,
    start: num(input.start, `${name} start`, { fallback: 0 }),
    end: num(input.end, `${name} end`),
    volume: num(input.volume, `${name} volume`, { min: 0, max: 4, fallback: 1 }),
    mute: bool(input.mute),
    rate: num(input.rate, `${name} rate`, { min: 0.1, max: 4, fallback: 1 }), // playback speed
    fit: oneOf(input.fit, FITS, `${name} fit`, null),
    zoom: num(input.zoom, `${name} zoom`, { min: 1, max: 4, fallback: 1 }),
    pan: normalizePan(input.pan, `${name} pan`),
    look: normalizeLook(input.look, `${name} look`),
    keepColor: normalizeKeepColor(input.keepColor, `${name} keepColor`),
    hit: input.hit == null || input.hit === '' ? null : num(input.hit, `${name} hit`, { min: 0 }),
    flash: num(input.flash === true ? 0.8 : input.flash, `${name} flash`, { min: 0, max: 1, fallback: 0 }),
    sounds: normalizeSounds(input.sounds, `${name} sound`),
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
  // `look` and `fit` at the top level are the whole video's; the clip's own come from `clips`.
  const clips = legacy
    ? [normalizeClip(Object.fromEntries(CLIP_KEYS.filter((k) => k !== 'look' && k !== 'fit').map((k) => [k, input[k]])), 0)]
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
    aspect: input.aspect ?? 'auto',
    fit: input.fit ?? 'fit',
    look: normalizeLook(input.look),
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
  if (!Object.hasOwn(ASPECTS, r.aspect)) fail(`Invalid aspect: ${JSON.stringify(input.aspect)}`);
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
  const notes = [];
  const clips = req.clips.map((c, i) => {
    const source = lookup(c.sourceId);
    if (!source) fail(`Clip ${i + 1}: unknown source ${c.sourceId}`);
    const kind = kindOf(source);
    if (kind === 'audio') fail(`Clip ${i + 1}: "${source.name}" has no video; use it as music instead`);
    const image = kind === 'image';
    const start = image ? 0 : c.start;
    const end = c.end;
    const srcDuration = end - start;
    const rate = image ? 1 : c.rate;
    const label = req.clips.length > 1 ? `Clip ${i + 1} (${source.name})` : 'Range';
    if (srcDuration < 0.1) fail(`${label} must be at least 0.1 s long`);
    if (image) {
      if (srcDuration > MAX_IMAGE_DURATION) fail(`${label}: an image can be shown for at most ${MAX_IMAGE_DURATION} s`);
    } else if (start < 0 || end > source.duration + 0.05) fail(`${label} is outside the source`);
    const audible = !image && !c.mute && source.hasAudio && req.audio !== 'mute';
    const duration = srcDuration / rate; // on the output timeline
    // Everything below is placed in clip time: seconds from the clip's first output frame.
    const local = (t) => (t - start) / rate;
    const inside = (t) => t >= start - EPS && t <= end + EPS;

    const hitAt = c.hit != null && inside(c.hit) ? local(c.hit) : null;
    if (c.flash > 0 && c.hit == null) fail(`${label}: a flash needs a hit point (the moment it fires)`);
    if (c.flash > 0 && hitAt == null) notes.push(`${label}: the hit point is outside the clip, so there is no flash.`);

    let keepColor = null;
    if (c.keepColor) {
      const k = c.keepColor;
      const from = k.from == null ? null : local(k.from), until = k.until == null ? null : local(k.until);
      // A window that misses the clip entirely is no effect; one that covers all of it needs no `enable`.
      if (!((until != null && until <= 0) || (from != null && from >= duration))) {
        keepColor = { ...k, from: from != null && from > 0 ? from : null, until: until != null && until < duration ? until : null };
      }
    }

    const sounds = [];
    c.sounds.forEach((s, j) => {
      const src = lookup(s.sourceId);
      if (!src) fail(`${label}, sound ${j + 1}: unknown source ${s.sourceId}`);
      if (!src.hasAudio) fail(`${label}, sound ${j + 1}: "${src.name}" has no audio`);
      const at = s.at ?? c.hit ?? start;
      if (!inside(at)) { notes.push(`${label}: sound "${src.name}" is placed outside the clip and is left out.`); return; }
      sounds.push({ source: src, at: local(at), volume: s.volume });
    });

    return {
      source, start, end, duration, srcDuration, rate, volume: c.volume, mute: c.mute, image, audible,
      fit: c.fit ?? req.fit, zoom: c.zoom, pan: c.pan.map((k) => ({ ...k, t: local(k.t) })),
      look: c.look, keepColor, hitAt, flash: hitAt == null ? 0 : c.flash, sounds,
    };
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
  return { clips, transitions, total, music, fadeIn: req.fadeIn, fadeOut: req.fadeOut, normalize: req.normalize, look: req.look, notes };
}

// The sequence in whole output frames. Every clip and transition is rounded to frames once, here, and
// both the video and the audio graph are cut to those lengths: a video stream can only be whole frames
// long, so audio cut to the nominal length would drift a little further ahead at every clip boundary.
// The clip boundaries (not the lengths) are what gets rounded, so no cut is ever more than half a frame
// from where the nominal timeline puts it: a montage cut to the beats of a song stays on them.
export function timeline(seq, fps) {
  const frames = [], overlap = [];
  let nominal = 0, first = 0; // the clip's nominal start in seconds, and its first frame
  seq.clips.forEach((c, k) => {
    frames.push(Math.max(1, Math.round((nominal + c.duration) * fps) - first));
    const t = seq.transitions[k];
    if (!t) return;
    nominal += c.duration - (t.type === 'cut' ? 0 : t.duration);
    const end = first + frames[k];
    overlap.push(t.type === 'cut' ? 0 : Math.max(1, end - Math.round(nominal * fps)));
    first = end - overlap[k];
  });
  // Rounding can push the two transitions around a short clip one frame past its length.
  frames.forEach((n, i) => {
    while ((overlap[i - 1] || 0) + (overlap[i] || 0) > n) {
      if ((overlap[i - 1] || 0) >= (overlap[i] || 0)) overlap[i - 1]--; else overlap[i]--;
    }
  });
  const total = frames.reduce((s, n) => s + n, 0) - overlap.reduce((s, n) => s + n, 0);
  return { frames, overlap, total, duration: total / fps };
}

const fmtMB = (bytes) => `~${bytes >= 1e8 ? Math.round(bytes / 1e6) : (bytes / 1e6).toFixed(1)} MB`;
const fmtFps = (fps) => String(Math.round(fps * 100) / 100);
const fmtKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${k} kbps`);

// Can this request be a stream copy? Only a plain single video range with nothing applied to it.
function copyEligible(req, seq) {
  const [c] = seq.clips;
  const untouched = c.volume === 1 && c.rate === 1 && c.zoom === 1 && !c.look && !c.keepColor && !c.flash && !c.sounds.length;
  return seq.clips.length === 1 && !c.image && untouched && !seq.music && !seq.fadeIn && !seq.fadeOut
    && !seq.normalize && !seq.look && req.aspect === 'auto' && !req.preview && req.preset === 'cut' && req.cut === 'fast';
}

// The canvas shape as a width/height ratio, or null to follow the clips.
const canvasRatio = (req) => ASPECTS[req.aspect] ?? (req.preset === 'tiktok' ? ASPECTS['9:16'] : null);

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
    hasAudio: seq.clips.some((c) => c.audible || c.sounds.length) || Boolean(seq.music),
    // For a fixed canvas shape: the sharpest short side among the videos (or the images when there are none).
    short: Math.max(...(allVideos.length ? allVideos : seq.clips).map((c) => Math.min(c.source.width, c.source.height))),
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
  const warnings = [...seq.notes];

  const plan = {
    mode, twoPass: false, encoder: null, videoKbps: null, crf: null,
    audioKbps: muted ? 0 : null,
    width: ref.width, height: ref.height, fps: ref.fps,
    duration, clips: seq.clips.length, transitions: seq.transitions.filter((t) => t.type !== 'cut').length,
    music: Boolean(seq.music), preview: req.preview,
    aspect: req.aspect !== 'auto' ? req.aspect : req.preset === 'tiktok' ? '9:16' : 'auto',
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
      plan.crf = HQ_PRESETS.has(req.preset) ? 18 : 20;
      plan.audioKbps = muted ? 0 : HQ_PRESETS.has(req.preset) ? 192 : 160;
    }

    // Resolution / fps. Sizes are clamped to the reference (never upscale) and even. `size` is the height,
    // or, for a fixed canvas shape (aspect / tiktok), the short side: 1080 in 9:16 is 1080x1920.
    const ratio = canvasRatio(req);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const limit = ratio ? ref.short : ref.height;
    const dimsFor = (size) => {
      size = Math.min(size, limit) & ~1;
      if (!ratio) return { width: even((ref.width * size) / ref.height), height: size };
      return ratio >= 1 ? { width: even(size * ratio), height: size } : { width: size, height: even(size / ratio) };
    };
    const bpp = (d, fps) => (plan.videoKbps * 1000) / (d.width * d.height * fps);
    const hqAuto = HQ_PRESETS.has(req.preset) && req.resolution === 'auto';
    let fps = req.fps === 'auto' || req.fps === 'source' ? ref.fps : Math.min(req.fps, ref.fps);
    if (HQ_PRESETS.has(req.preset) && req.fps === 'auto') fps = Math.min(fps, 60);

    let height;
    if (typeof req.resolution === 'number') height = req.resolution;
    else if (req.resolution === 'source' || !targetBytes || capped) height = hqAuto ? Math.min(limit, 1080) : limit;
    else {
      const candidates = [...new Set([limit, 1080, 720, 480, 360].filter((h) => h <= limit))].sort((a, b) => b - a);
      height = candidates.find((h) => bpp(dimsFor(h), fps) >= 0.05) ?? candidates.at(-1);
    }
    if (req.preview) { height = Math.min(height, PREVIEW_HEIGHT); fps = Math.min(fps, 60); }
    const dims = dimsFor(height);
    if (targetBytes && !capped && req.fps === 'auto' && ref.fps > 30 && bpp(dims, fps) < 0.05) fps = 30;
    plan.width = dims.width;
    plan.height = dims.height;
    plan.fps = fps;
    plan.duration = round3(timeline(seq, fps).duration); // what the file will really be: whole frames

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
    for (const c of seq.clips) for (const s of c.sounds) if (p === path.resolve(s.source.path)) fail('Output path must differ from the sound files');
    dir = path.dirname(p);
    ext = path.extname(p) || ext;
    base = path.basename(p, path.extname(p));
  } else {
    const tag = targetBytes ? `${targetBytes / 1e6}MB` : HQ_PRESETS.has(req.preset) ? req.preset : 'cut';
    // Files the app keeps itself (uploads in the temp dir, title cards under the output dir) are no place for exports.
    const own = first.uploaded || path.resolve(first.path).startsWith(path.resolve(defaultOutputDir) + path.sep);
    dir = own ? defaultOutputDir : path.dirname(first.path);
    const stem = path.basename(first.name, path.extname(first.name));
    base = `${stem}_${seq.clips.length > 1 ? 'edit_' : ''}${tag}`;
  }
  // Never overwrite anything, explicit path or not.
  plan.outputPath = path.join(dir, base + ext);
  for (let n = 2; exists(plan.outputPath); n++) plan.outputPath = path.join(dir, `${base}-${n}${ext}`);
  return plan;
}

// Scale a clip into the W×H canvas: same aspect → plain scale, otherwise letterbox/pillarbox.
// `pad: false` leaves the letterboxed picture at its own size (the blur fill lays it over a background).
function fitFilters(src, W, H, { pad = true } = {}) {
  if (src.width === W && src.height === H) return [];
  const same = Math.abs(src.width / src.height - W / H) < 0.01;
  if (same) return [`scale=${W}:${H}:flags=bicubic`];
  const scale = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`;
  return pad ? [scale, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`] : [scale];
}

const evenFloor = (n) => Math.max(2, Math.floor(n / 2) * 2);

// A value that moves through keyframes [{ t, v }] (clip time), linearly, held before the first and after the last.
function keyframed(keys) {
  let expr = f3(keys.at(-1).v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    if (b.t - a.t < 1e-3) continue;
    expr = `if(lt(t,${f6(b.t)}),${f3(a.v)}+${f6(b.v - a.v)}*(t-${f6(a.t)})/${f6(b.t - a.t)},${expr})`;
  }
  return `if(lt(t,${f6(keys[0].t)}),${f3(keys[0].v)},${expr})`;
}

// The part of the source a clip shows: for "fill" the canvas shape (cropping the sides of a landscape clip
// in a 9:16 video), otherwise the source shape; zoom shrinks it, pan moves it. Returns its size and the
// crop filter (null when the whole frame is used).
function framing(c, W, H) {
  const { width: sw, height: sh } = c.source;
  const ratio = c.fit === 'fill' ? W / H : sw / sh;
  let rw = sw, rh = sh;
  if (sw / sh > ratio) rw = sh * ratio; else rh = sw / ratio;
  rw = Math.min(sw, evenFloor(rw / c.zoom));
  rh = Math.min(sh, evenFloor(rh / c.zoom));
  if (rw >= sw - 1 && rh >= sh - 1) return { region: { width: sw, height: sh }, crop: null };
  const room = { x: sw - rw, y: sh - rh };
  const keys = c.pan.length ? c.pan : [{ t: 0, x: 0.5, y: 0.5 }];
  const axis = (k) => {
    const values = keys.map((p) => ({ t: p.t, v: Math.round(p[k] * room[k]) }));
    return values.every((p) => p.v === values[0].v) ? String(values[0].v) : `'floor(${keyframed(values)})'`;
  };
  return { region: { width: rw, height: rh }, crop: `crop=w=${rw}:h=${rh}:x=${axis('x')}:y=${axis('y')}` };
}

// Colour grade → filters (the order matters: grade, then the selective colour, motion blur and flash).
function lookFilters(look) {
  if (!look) return [];
  const out = [];
  const { brightness: b, contrast: c, saturation: s, gamma: g } = look;
  if (b || c !== 1 || s !== 1 || g !== 1) out.push(`eq=brightness=${f3(b)}:contrast=${f3(c)}:saturation=${f3(s)}:gamma=${f3(g)}`);
  if (look.hue) out.push(`hue=h=${f3(look.hue)}`);
  if (look.tint) {
    // Push shadows, midtones and highlights towards the tint colour, keeping the lightness.
    const rgb = [1, 3, 5].map((i) => parseInt(look.tint.color.slice(i, i + 2), 16) / 255);
    const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const shift = (k, scale) => f3(Math.max(-1, Math.min(1, (rgb[k] - mean) * look.tint.amount * scale)));
    const ranges = [['s', 0.5], ['m', 1], ['h', 0.6]];
    out.push(`colorbalance=${ranges.flatMap(([r, scale]) => ['r', 'g', 'b'].map((ch, k) => `${ch}${r}=${shift(k, scale)}`)).join(':')}:pl=1`);
  }
  if (look.sharpen) out.push(`unsharp=5:5:${f3(look.sharpen)}:5:5:0`);
  return out;
}

function effectFilters(c, globalLook) {
  const out = [...lookFilters(c.look), ...lookFilters(globalLook)];
  const k = c.keepColor;
  if (k) {
    const when = k.from != null && k.until != null ? `between(t,${f6(k.from)},${f6(k.until)})`
      : k.until != null ? `lt(t,${f6(k.until)})` : k.from != null ? `gte(t,${f6(k.from)})` : null;
    out.push(`colorhold=color=0x${k.color.slice(1)}:similarity=${f3(k.range)}:blend=${f3(k.softness)}${when ? `:enable='${when}'` : ''}`);
  }
  const blur = Math.max(c.look?.motionBlur || 0, globalLook?.motionBlur || 0);
  if (blur > 0) out.push(`tmix=frames=${1 + Math.max(1, Math.round(blur * 4))}`);
  if (c.flash > 0) {
    // A white flash on the hit that fades out over FLASH_SECONDS: brightness up and colour out, by `flash`.
    const at = f6(c.hitAt), d = f6(FLASH_SECONDS);
    const k = `${f3(c.flash)}*max(0,1-(t-${at})/${d})`;
    out.push(`eq=brightness='0.9*${k}':saturation='1-${k}':eval=frame:enable='between(t,${at},${f6(c.hitAt + FLASH_SECONDS)})'`);
  }
  return out;
}

// atempo only takes 0.5..2 per instance on older ffmpeg; chain it for anything beyond.
function tempoFilters(rate) {
  if (rate === 1) return [];
  const out = [];
  let s = rate;
  while (s > 2 + EPS) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5 - EPS) { out.push('atempo=0.5'); s /= 0.5; }
  out.push(`atempo=${f6(s)}`);
  return out;
}

const AFORMAT = `aresample=${AUDIO_RATE}:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo`;

// filter_complex for the sequence. `withAudio=false` builds the video-only graph for two-pass pass 1.
// Returns { graph, video, audio, duration }: the graph, its output labels and its exact length in seconds.
// Inputs: one per clip, then the music (when there is one), then every clip sound in clip order.
export function buildFilterGraph(plan, seq, { withAudio = true } = {}) {
  const { width: W, height: H, fps: F } = plan;
  const tl = timeline(seq, F);
  const T = tl.duration;
  const sec = (frames) => f6(frames / F);
  const samples = (frames) => Math.round((frames / F) * AUDIO_RATE);
  const fadeOutAt = (d) => f6(Math.max(0, T - d));
  const parts = [];
  const vLabels = [], aLabels = [];
  // "Music only" drops the clip audio entirely; building it would leave an unconnected filter output.
  const clipAudio = withAudio && !(seq.music && seq.music.mode === 'replace');

  seq.clips.forEach((c, k) => {
    const n = tl.frames[k];
    const pre = [c.rate !== 1 ? `setpts=(PTS-STARTPTS)/${f6(c.rate)}` : 'setpts=PTS-STARTPTS', `fps=${f3(F)}`];
    const { region, crop } = framing(c, W, H);
    if (crop) pre.push(crop);
    // Effects run on the cropped picture, before it is scaled or padded: cheaper when it is smaller than
    // the canvas, and the bars of a letterboxed clip stay black.
    pre.push(...effectFilters(c, seq.look));
    // settb: concat hands on a 1/1000000 timebase and xfade refuses inputs whose timebases differ,
    // so a cut followed by a transition only works when every clip is on that timebase from the start.
    const post = ['setsar=1', 'format=yuv420p', 'tpad=stop=-1:stop_mode=clone', `trim=end_frame=${n}`, 'settb=AVTB'];
    const fits = Math.abs(region.width / region.height - W / H) < 0.01;
    if (c.fit === 'blur' && !fits) {
      // The picture letterboxed over a blurred, darkened copy of itself that fills the canvas.
      const bw = evenFloor(W / 8), bh = evenFloor(H / 8);
      parts.push(`[${k}:v]${pre.join(',')},split=2[bg${k}][fg${k}]`);
      parts.push(`[bg${k}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=6,eq=brightness=-0.06,scale=${W}:${H},setsar=1[bb${k}]`);
      parts.push(`[fg${k}]${fitFilters(region, W, H, { pad: false }).join(',') || 'null'},setsar=1[ff${k}]`);
      parts.push(`[bb${k}][ff${k}]overlay=(W-w)/2:(H-h)/2,${post.join(',')}[v${k}]`);
    } else {
      parts.push(`[${k}:v]${[...pre, ...fitFilters(region, W, H), ...post].join(',')}[v${k}]`);
    }
    vLabels.push(`[v${k}]`);
    if (!clipAudio) return;
    const len = samples(n);
    if (c.audible) {
      const vol = c.volume !== 1 ? [`volume=${f3(c.volume)}`] : [];
      // 5 ms edge fades remove clicks at hard cuts without changing the clip length.
      const audio = ['asetpts=PTS-STARTPTS', AFORMAT, ...tempoFilters(c.rate), ...vol, `apad=whole_len=${len}`, `atrim=end_sample=${len}`, 'afade=t=in:d=0.005', `afade=t=out:st=${f6(Math.max(0, n / F - 0.005))}:d=0.005`];
      parts.push(`[${k}:a]${audio.join(',')}[a${k}]`);
    } else {
      parts.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${len}[a${k}]`);
    }
    aLabels.push(`[a${k}]`);
  });

  // Chain the clips: a cut is a concat, anything else an xfade/acrossfade at the running offset.
  // `starts` collects where each clip begins on the output timeline (in frames), for the clip sounds.
  let v = vLabels[0], a = aLabels[0], acc = tl.frames[0];
  const starts = [0];
  seq.transitions.forEach((t, i) => {
    const k = i + 1, o = tl.overlap[i];
    starts.push(acc - o);
    if (!o) {
      parts.push(`${v}${vLabels[k]}concat=n=2:v=1:a=0[x${k}]`);
      if (clipAudio) parts.push(`${a}${aLabels[k]}concat=n=2:v=0:a=1[y${k}]`);
    } else {
      parts.push(`${v}${vLabels[k]}xfade=transition=${t.type}:duration=${sec(o)}:offset=${sec(acc - o)}[x${k}]`);
      if (clipAudio) parts.push(`${a}${aLabels[k]}acrossfade=ns=${samples(o)}:c1=tri:c2=tri[y${k}]`);
    }
    acc += tl.frames[k] - o;
    v = `[x${k}]`;
    a = `[y${k}]`;
  });

  const vTail = [];
  if (seq.fadeIn > 0) vTail.push(`fade=t=in:d=${f3(seq.fadeIn)}`);
  if (seq.fadeOut > 0) vTail.push(`fade=t=out:st=${fadeOutAt(seq.fadeOut)}:d=${f3(seq.fadeOut)}`);
  if (vTail.length) { parts.push(`${v}${vTail.join(',')}[vout]`); v = '[vout]'; }
  if (!withAudio) return { graph: parts.join(';'), video: v, audio: null, duration: T };

  const M = seq.clips.length;
  const extra = []; // music (mixed) and clip sounds, laid over the base track
  if (seq.music) {
    const m = seq.music;
    const chain = ['asetpts=PTS-STARTPTS', AFORMAT];
    if (m.volume !== 1) chain.push(`volume=${f3(m.volume)}`);
    if (m.fadeIn > 0) chain.push(`afade=t=in:d=${f3(m.fadeIn)}`);
    if (m.fadeOut > 0) chain.push(`afade=t=out:st=${fadeOutAt(m.fadeOut)}:d=${f3(m.fadeOut)}`);
    chain.push(`apad=whole_len=${samples(tl.total)}`, `atrim=end_sample=${samples(tl.total)}`);
    parts.push(`[${M}:a]${chain.join(',')}[m]`);
    if (m.mode === 'replace') a = '[m]'; else extra.push('[m]');
  }
  let input = M + (seq.music ? 1 : 0);
  seq.clips.forEach((c, k) => c.sounds.forEach((s) => {
    const label = `[s${input}]`;
    const delay = Math.max(0, Math.round((starts[k] / F + s.at) * 1000));
    const chain = ['asetpts=PTS-STARTPTS', AFORMAT, ...(s.volume !== 1 ? [`volume=${f3(s.volume)}`] : []), `adelay=delays=${delay}:all=1`, `atrim=end_sample=${samples(tl.total)}`];
    parts.push(`[${input++}:a]${chain.join(',')}${label}`);
    extra.push(label);
  }));
  if (extra.length) {
    parts.push(`${a}${extra.join('')}amix=inputs=${extra.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`);
    a = '[mix]';
  }
  const aTail = [];
  if (seq.fadeIn > 0) aTail.push(`afade=t=in:d=${f3(seq.fadeIn)}`);
  if (seq.fadeOut > 0) aTail.push(`afade=t=out:st=${fadeOutAt(seq.fadeOut)}:d=${f3(seq.fadeOut)}`);
  // loudnorm works internally at 192 kHz and would output that; bring it back down.
  if (seq.normalize) aTail.push('loudnorm=I=-14:TP=-1.5:LRA=11', `aresample=${AUDIO_RATE}`);
  if (aTail.length) { parts.push(`${a}${aTail.join(',')}[aout]`); a = '[aout]'; }
  return { graph: parts.join(';'), video: v, audio: a, duration: T };
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
    if (c.image) inputs.push('-loop', '1', '-framerate', f3(plan.fps), '-t', f3(c.srcDuration), '-i', c.source.path);
    else inputs.push('-ss', f3(c.start), '-t', f3(c.srcDuration), '-i', c.source.path);
  }
  // Music and clip sounds: the audio-only inputs after the clips (see buildFilterGraph for the order).
  const musicInput = [];
  if (seq.music && plan.audioKbps) {
    if (seq.music.loop) musicInput.push('-stream_loop', '-1');
    if (seq.music.start > 0) musicInput.push('-ss', f3(seq.music.start));
    musicInput.push('-i', seq.music.source.path);
  }
  if (plan.audioKbps) for (const c of seq.clips) for (const s of c.sounds) musicInput.push('-i', s.source.path);
  const withAudio = plan.audioKbps > 0;
  const full = buildFilterGraph(plan, seq, { withAudio });
  const mapsFor = (g, useAudio) => ['-filter_complex', g.graph, '-map', g.video, ...(useAudio && g.audio ? ['-map', g.audio] : [])];
  const common = ['-t', f6(full.duration)];
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
