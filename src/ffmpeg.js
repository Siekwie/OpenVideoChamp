// Locating ffmpeg/ffprobe and the few ffprobe/ffmpeg queries the server needs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ENCODER_CANDIDATES = ['libx264', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_videotoolbox'];

export function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
    }
  }
  return null;
}

function fromStatic(pkg) {
  try {
    const mod = require(pkg);
    const file = typeof mod === 'string' ? mod : mod?.path;
    return file && fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

// Resolution order: OVC_FFMPEG/OVC_FFPROBE env → ffmpeg-static/ffprobe-static → PATH.
export function locate() {
  const ffmpeg = process.env.OVC_FFMPEG || fromStatic('ffmpeg-static') || onPath('ffmpeg');
  const ffprobe = process.env.OVC_FFPROBE || fromStatic('ffprobe-static') || onPath('ffprobe');
  const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean);
  if (missing.length) {
    throw new Error(`${missing.join(' and ')} not found. Install ffmpeg (https://ffmpeg.org/download.html) and put it on PATH, `
      + 'set OVC_FFMPEG / OVC_FFPROBE to the binaries, or run "npm install" so the optional ffmpeg-static/ffprobe-static packages provide them.');
  }
  return { ffmpeg, ffprobe };
}

export function run(bin, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || '').trim().split('\n').pop() || err.message;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function version(ffmpeg) {
  const { stdout } = await run(ffmpeg, ['-version']);
  return /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown';
}

function rate(str) {
  const [n, d] = String(str || '').split('/').map(Number);
  return n > 0 && d > 0 ? n / d : NaN;
}

function rotation(stream) {
  const sd = (stream.side_data_list || []).find((s) => s.rotation != null);
  return Number(sd?.rotation ?? stream.tags?.rotate ?? 0);
}

// Returns the Source fields that come from ffprobe (id/name/path/uploaded are the caller's).
export async function probe(ffprobe, file) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw Object.assign(new Error('No video stream found in file'), { status: 400 });
  const a = streams.find((s) => s.codec_type === 'audio');
  const swap = Math.abs(rotation(v)) % 180 === 90;
  let fps = rate(v.r_frame_rate);
  // r_frame_rate can be a huge "timebase" rate for variable-frame-rate files; the average is saner then.
  if (!(fps > 0) || fps > 240) fps = rate(v.avg_frame_rate) || 30;
  return {
    size: Number(info.format.size) || 0,
    duration: Number(info.format.duration ?? v.duration) || 0,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
    hasAudio: Boolean(a),
    bitrate: Math.round(Number(info.format.bit_rate) / 1000) || 0,
    container: info.format.format_name,
  };
}

function parseTimes(stdout, pick) {
  const times = [];
  for (const line of stdout.split('\n')) {
    const t = pick(line.split(','));
    if (Number.isFinite(t)) times.push(t);
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

// Keyframe timestamps of the first video stream, ascending.
export async function keyframes(ffprobe, file) {
  const common = ['-v', 'error', '-select_streams', 'v:0'];
  try {
    const { stdout } = await run(ffprobe, [...common, '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { timeout: 30_000 });
    const times = parseTimes(stdout, (f) => Number(f[0]));
    if (times.length) return times;
  } catch { /* slow or unsupported: fall through to the packet scan */ }
  const { stdout } = await run(ffprobe, [...common, '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', file]);
  return parseTimes(stdout, (f) => (f[2]?.includes('K') ? Number(f[0]) || Number(f[1]) : NaN));
}

async function verifyEncoder(ffmpeg, name) {
  try {
    await run(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=size=128x128:rate=30', '-frames:v', '5', '-c:v', name, '-f', 'null', '-'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Starts detection in the background; read `state.encoders` at any time, await `state.ready` for the final list.
export function detectEncoders(ffmpeg) {
  const state = { encoders: [], ready: null };
  state.ready = (async () => {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-encoders']).catch(() => ({ stdout: '' }));
    const listed = ENCODER_CANDIDATES.filter((name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, 'm').test(stdout));
    if (listed.includes('libx264')) state.encoders = ['libx264']; // assumed until verified
    const ok = await Promise.all(listed.map((name) => verifyEncoder(ffmpeg, name)));
    state.encoders = listed.filter((_, i) => ok[i]);
    return state.encoders;
  })();
  return state;
}
