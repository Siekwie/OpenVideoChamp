// Export planning: pure functions, no I/O. Implements the "Export rules"
// section of docs/API.md and turns a Plan into ffmpeg argv arrays.
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

export function normalizeRequest(input = {}) {
  const r = {
    sourceId: input.sourceId,
    start: Number(input.start),
    end: Number(input.end),
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
  if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) fail('start and end must be numbers (seconds)');
  for (const key of ['resolution', 'fps']) {
    const v = r[key];
    if (v !== 'auto' && v !== 'source' && !(Number.isFinite(v) && v > 0)) fail(`Invalid ${key}: ${JSON.stringify(input[key])}`);
  }
  if (r.preset === 'custom' && !(r.targetMB > 0)) fail('targetMB must be a positive number for the custom preset');
  return r;
}

const fmtMB = (bytes) => `~${bytes >= 1e8 ? Math.round(bytes / 1e6) : (bytes / 1e6).toFixed(1)} MB`;
const fmtFps = (fps) => String(Math.round(fps * 100) / 100);
const fmtKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${k} kbps`);

export function planExport(source, input, { encoders = ['libx264'], defaultOutputDir = '.', exists = () => false, keyframes = [] } = {}) {
  const req = normalizeRequest(input);
  const { start, end } = req;
  const duration = end - start;
  if (duration < 0.1) fail('Range must be at least 0.1 s long');
  if (start < 0 || end > source.duration + 0.05) fail('Range is outside the source');

  const targetBytes = req.preset === 'custom' ? Math.round(req.targetMB * 1e6)
    : PRESET_MB[req.preset] ? PRESET_MB[req.preset] * 1e6 : null;
  const mode = !targetBytes && req.preset === 'cut' && req.cut === 'fast' ? 'copy' : 'encode';
  const muted = req.audio === 'mute' || !source.hasAudio;
  const warnings = [];

  const plan = {
    mode, twoPass: false, encoder: null, videoKbps: null, crf: null,
    audioKbps: muted ? 0 : null,
    width: source.width, height: source.height, fps: source.fps,
    duration, targetBytes, estimatedBytes: null, outputPath: null, warnings, summary: '',
  };

  let ext = '.mp4';
  if (mode === 'copy') {
    const snapped = [...keyframes].reverse().find((t) => t <= start + 1e-3) ?? start;
    const back = start - snapped;
    if (back > 0.5) {
      warnings.push(`Fast cut starts ${back.toFixed(1)} s earlier (at ${snapped.toFixed(2)} s) to land on a keyframe; use a precise cut for an exact start.`);
    }
    if (!MP4_VIDEO.has(source.videoCodec) || (!muted && !MP4_AUDIO.has(source.audioCodec))) ext = '.mkv';
    plan.estimatedBytes = Math.round((source.bitrate || 0) * 125 * (end - snapped));
    plan.summary = `${fmtMB(plan.estimatedBytes)} · ${plan.width}×${plan.height} · ${fmtFps(plan.fps)} fps · stream copy, no re-encode`;
  } else {
    const encoder = req.encoder === 'auto' ? 'libx264' : req.encoder;
    if (!encoders.includes(encoder)) fail(`Encoder not available: ${encoder}`);
    const hardware = encoder !== 'libx264';
    plan.encoder = encoder;

    if (targetBytes) {
      // 4 % mux overhead/safety; hardware rate control is sloppier, so another 4 %.
      const budget = targetBytes * 0.96 * (hardware ? 0.96 : 1);
      const totalKbps = (budget * 8) / duration / 1000;
      plan.audioKbps = muted ? 0 : totalKbps >= 1200 ? 128 : totalKbps >= 600 ? 96 : 64;
      plan.videoKbps = Math.floor(totalKbps - plan.audioKbps);
      if (plan.videoKbps < 32) fail('Target size is too small for this duration');
      if (plan.videoKbps < 150) warnings.push('Very low bitrate for this length; expect heavy quality loss.');
      plan.twoPass = !hardware;
    } else {
      plan.crf = req.preset === 'steam' ? 18 : 20;
      plan.audioKbps = muted ? 0 : req.preset === 'steam' ? 192 : 160;
    }

    // Resolution / fps. Heights are clamped to the source (never upscale) and even.
    const srcW = source.width, srcH = source.height;
    const dimsFor = (h) => {
      h = Math.min(h, srcH) & ~1;
      return { width: Math.round((srcW * h) / srcH / 2) * 2, height: h };
    };
    const bpp = (d, fps) => (plan.videoKbps * 1000) / (d.width * d.height * fps);
    const steamAuto = req.preset === 'steam' && req.resolution === 'auto';
    let fps = req.fps === 'auto' || req.fps === 'source' ? source.fps : Math.min(req.fps, source.fps);
    if (req.preset === 'steam' && req.fps === 'auto') fps = Math.min(fps, 60);

    let height;
    if (typeof req.resolution === 'number') height = req.resolution;
    else if (req.resolution === 'source' || !targetBytes) height = steamAuto ? Math.min(srcH, 1080) : srcH;
    else {
      const candidates = [...new Set([srcH, 1080, 720, 480, 360].filter((h) => h <= srcH))].sort((a, b) => b - a);
      height = candidates.find((h) => bpp(dimsFor(h), fps) >= 0.05) ?? candidates.at(-1);
    }
    const dims = dimsFor(height);
    if (targetBytes && req.fps === 'auto' && source.fps > 30 && bpp(dims, fps) < 0.05) fps = 30;
    plan.width = dims.width;
    plan.height = dims.height;
    plan.fps = fps;

    const dimsStr = `${dims.width}×${dims.height} · ${fmtFps(fps)} fps`;
    const audioStr = muted ? ', no audio' : ` + ${plan.audioKbps} kbps audio`;
    if (targetBytes) {
      plan.estimatedBytes = Math.round((plan.videoKbps + plan.audioKbps) * 125 * duration);
      plan.summary = `${fmtMB(plan.estimatedBytes)} · ${dimsStr} · ${fmtKbps(plan.videoKbps)} video${audioStr} · ${plan.twoPass ? '2-pass' : `${encoder} 1-pass`}`;
    } else {
      // Rough CRF size guess: bits per pixel typical for crf 18/20, capped by the source bitrate.
      const guessKbps = Math.min((dims.width * dims.height * fps * (plan.crf === 18 ? 0.1 : 0.08)) / 1000, source.bitrate || Infinity);
      plan.estimatedBytes = Math.round((guessKbps + plan.audioKbps) * 125 * duration);
      plan.summary = `${fmtMB(plan.estimatedBytes)} (est.) · ${dimsStr} · CRF ${plan.crf} ${encoder}${audioStr}`;
    }
  }

  if (req.outputPath) {
    plan.outputPath = path.resolve(req.outputPath);
  } else {
    const tag = targetBytes ? `${targetBytes / 1e6}MB` : req.preset === 'steam' ? 'steam' : 'cut';
    const dir = source.uploaded ? defaultOutputDir : path.dirname(source.path);
    const base = `${path.basename(source.name, path.extname(source.name))}_${tag}`;
    plan.outputPath = path.join(dir, base + ext);
    for (let n = 2; exists(plan.outputPath); n++) plan.outputPath = path.join(dir, `${base}-${n}${ext}`);
  }
  return plan;
}

// Returns one ffmpeg argv array per pass.
export function buildArgs(plan, source, input, { passLogFile, nullDevice } = {}) {
  const req = normalizeRequest(input);
  const base = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-ss', String(req.start), '-i', source.path, '-t', String(plan.duration)];
  const faststart = plan.outputPath.toLowerCase().endsWith('.mkv') ? [] : ['-movflags', '+faststart'];
  const audio = plan.audioKbps ? ['-c:a', 'aac', '-b:a', `${plan.audioKbps}k`] : ['-an'];

  if (plan.mode === 'copy') {
    // make_zero: -ss before -i with stream copy yields packets before the cut point with negative timestamps.
    return [[...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(plan.audioKbps === 0 ? ['-an'] : []), ...faststart, plan.outputPath]];
  }

  const filters = [];
  if (Math.abs(plan.fps - source.fps) > 0.01) filters.push(`fps=${plan.fps}`);
  if (plan.width !== source.width || plan.height !== source.height) filters.push(`scale=-2:${plan.height}`);
  const vf = filters.length ? ['-vf', filters.join(',')] : [];
  const video = ['-c:v', plan.encoder, ...(plan.encoder === 'libx264' ? ['-preset', X264_PRESET[req.speed]] : [])];
  const pix = ['-pix_fmt', plan.encoder === 'h264_qsv' ? 'nv12' : 'yuv420p'];

  if (plan.crf != null) {
    const quality = plan.encoder === 'libx264' ? ['-crf', String(plan.crf)] : HW_QUALITY[plan.encoder](plan.crf);
    return [[...base, ...vf, ...video, ...quality, ...pix, ...audio, ...faststart, plan.outputPath]];
  }

  const v = plan.videoKbps;
  const rate = ['-b:v', `${v}k`, '-maxrate', `${Math.round(v * 1.5)}k`, '-bufsize', `${v * 3}k`];
  if (!plan.twoPass) return [[...base, ...vf, ...video, ...rate, ...pix, ...audio, ...faststart, plan.outputPath]];

  const passlog = passLogFile ?? `${plan.outputPath}.passlog`;
  const nul = nullDevice ?? (process.platform === 'win32' ? 'NUL' : '/dev/null');
  return [
    [...base, ...vf, ...video, ...rate, ...pix, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', nul],
    [...base, ...vf, ...video, ...rate, ...pix, '-pass', '2', '-passlogfile', passlog, ...audio, ...faststart, plan.outputPath],
  ];
}
