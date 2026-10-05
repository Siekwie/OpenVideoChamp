// Media analysis for montage editing: the beats of a music track (so cuts and goals can land on them) and
// the "hit" moments of gameplay (a goal explosion: a sudden jump in loudness and brightness).
// ffmpeg decodes; everything after that is plain, synchronous and testable.
import { spawn } from 'node:child_process';

const MAX_BYTES = 1024 * 1024 * 1024;

// Runs ffmpeg with the given output on stdout and resolves to it as one Buffer.
function ffmpegData(ffmpeg, args, { timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let size = 0, stderr = '', failed = null;
    const timer = setTimeout(() => { failed = 'ffmpeg took too long'; proc.kill('SIGKILL'); }, timeout);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { failed = 'the decoded data is too large'; proc.kill('SIGKILL'); } else chunks.push(c);
    });
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) return reject(new Error(failed || stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

// The file's first audio stream as mono float samples at `rate` Hz.
export async function decodeAudio(ffmpeg, file, { rate = 22050 } = {}) {
  const buf = await ffmpegData(ffmpeg, ['-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
  // Copy into an aligned buffer: Buffer.concat may hand back a slice of a shared pool at any offset.
  const out = new Float32Array(Math.floor(buf.length / 4));
  new Uint8Array(out.buffer).set(buf.subarray(0, out.length * 4));
  return out;
}

// ---------------------------------------------------------------- beats

// In-place radix-2 FFT; `re`/`im` have a power-of-two length.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Spectral flux: how much new energy appears in each short frame. `env` is the whole spectrum, `low`
// only the bass (kick drums, which mostly mark the beats), `bass` the plain bass level (heavier on the
// first beat of a bar), `punch` the rise in plain loudness. `fps` frames per second.
const FFT_SIZE = 1024, HOP = 256;

export function onsetEnvelope(samples, rate, { fftSize = FFT_SIZE, hop = HOP } = {}) {
  const frames = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const bins = fftSize / 2;
  const lowBins = Math.max(2, Math.round((150 * fftSize) / rate));
  const window = new Float32Array(fftSize).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize));
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  let prev = new Float32Array(bins), cur = new Float32Array(bins);
  const raw = new Float32Array(frames), rawLow = new Float32Array(frames), bass = new Float32Array(frames), level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let power = 0;
    for (let i = 0; i < fftSize; i++) { re[i] = samples[off + i] * window[i]; im[i] = 0; power += re[i] * re[i]; }
    level[f] = Math.sqrt(power / fftSize);
    fft(re, im);
    let flux = 0, low = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0 && f > 0) { flux += d; if (k <= lowBins) low += d; }
      if (k <= lowBins) bass[f] += Math.hypot(re[k], im[k]);
    }
    raw[f] = flux;
    rawLow[f] = low;
    [prev, cur] = [cur, prev];
  }
  const fps = rate / hop;
  // How much louder (plain RMS) each frame is than the one a few frames before: drums yes, hi-hats barely.
  const punch = level.map((v, f) => Math.max(0, v - level[Math.max(0, f - 3)]));
  return { env: detrend(raw, Math.round(fps * 0.5)), low: detrend(rawLow, Math.round(fps * 0.5)), bass, punch, fps };
}

// Subtracts a moving average (removes slow loudness changes), keeps the positive part, scales to max 1.
function detrend(x, radius) {
  const n = x.length, out = new Float32Array(n);
  let sum = 0, lo = 0, hi = -1;
  let max = 0;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + radius)) sum += x[++hi];
    while (lo < i - radius) sum -= x[lo++];
    out[i] = Math.max(0, x[i] - sum / (hi - lo + 1));
    if (out[i] > max) max = out[i];
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

// Gaussian smoothing (sigma in frames).
function smooth(x, sigma) {
  const r = Math.ceil(sigma * 3), k = [];
  for (let o = -r; o <= r; o++) k.push(Math.exp(-0.5 * (o / sigma) ** 2));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0, w = 0;
    for (let o = -r; o <= r; o++) { const j = i + o; if (j >= 0 && j < x.length) { s += x[j] * k[o + r]; w += k[o + r]; } }
    out[i] = s / w;
  }
  return out;
}

// The beat period (in envelope frames) from the autocorrelation of the onset envelope, weighted towards
// 125 BPM (most montage music is 100..170) so that half and double tempo only win when clearly stronger.
export function estimateTempo(onsets, fps, { min = 60, max = 200, prior = 125, octaves = 0.7 } = {}) {
  // Onsets are a frame or two wide; smoothed, a period that falls between two whole frames still lines up.
  const env = smooth(onsets, 1.5);
  const lagMin = Math.max(1, Math.floor((fps * 60) / max)), lagMax = Math.ceil((fps * 60) / min);
  const n = Math.min(env.length, Math.round(fps * 120)); // two minutes say enough about the tempo
  if (n < lagMax * 2) return null;
  let zero = 0;
  for (let i = 0; i < n; i++) zero += env[i] * env[i];
  if (!zero) return null;
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / zero;
  }
  let best = -Infinity, bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * fps) / lag;
    const score = Math.log1p(1e6 * Math.max(0, ac[lag])) - 0.5 * (Math.log2(bpm / prior) / octaves) ** 2;
    if (score > best) { best = score; bestLag = lag; }
  }
  // Parabolic interpolation between the neighbouring lags: a whole frame is ~1 % of the tempo.
  const [a, b, c] = [ac[bestLag - 1], ac[bestLag], ac[bestLag + 1]];
  const den = a - 2 * b + c;
  const period = bestLag + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
  return { period, bpm: (60 * fps) / period };
}

// Dynamic-programming beat tracker (Ellis 2007): picks onsets that are strong and about one period apart.
// Returns frame indices.
export function trackBeats(env, period, { tightness = 100 } = {}) {
  const n = env.length;
  if (!n || !(period > 1)) return [];
  // Smooth the envelope a little around each frame.
  const radius = Math.max(1, Math.round(period));
  const kernel = [];
  for (let o = -radius; o <= radius; o++) kernel.push(Math.exp(-0.5 * ((o * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let o = -radius; o <= radius; o++) { const j = i + o; if (j >= 0 && j < n) s += env[j] * kernel[o + radius]; }
    local[i] = s;
  }
  const lo = Math.round(-2 * period), hi = Math.min(-1, Math.round(-period / 2));
  const penalty = [];
  for (let o = lo; o <= hi; o++) penalty.push(-tightness * Math.log(-o / period) ** 2);
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const maxLocal = local.reduce((m, v) => Math.max(m, v), 0);
  let started = false;
  for (let i = 0; i < n; i++) {
    let best = -Infinity, arg = -1;
    for (let o = lo; o <= hi; o++) {
      const j = i + o;
      if (j < 0) continue;
      const s = score[j] + penalty[o - lo];
      if (s > best) { best = s; arg = j; }
    }
    score[i] = local[i] + (started && arg >= 0 ? best : 0);
    back[i] = started ? arg : -1;
    if (!started && local[i] > 0.01 * maxLocal) started = true;
  }
  // The last beat: the last local maximum of the cumulative score that is not much weaker than usual.
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (score[i] > score[i - 1] && score[i] >= score[i + 1]) peaks.push(i);
  if (!peaks.length) return [];
  const sorted = peaks.map((i) => score[i]).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  let last = peaks.at(-1);
  for (let k = peaks.length - 1; k >= 0; k--) if (score[peaks[k]] >= 0.5 * median) { last = peaks[k]; break; }
  const beats = [];
  for (let i = last; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  // Drop weak beats at the very start and end (silence, fade-outs).
  const rms = Math.sqrt(beats.reduce((s, i) => s + local[i] ** 2, 0) / beats.length);
  let a = 0, b = beats.length;
  while (a < b && local[beats[a]] < 0.5 * rms) a++;
  while (b > a && local[beats[b - 1]] < 0.5 * rms) b--;
  return beats.slice(a, b);
}

const r3 = (t) => Math.round(t * 1000) / 1000;

// { bpm, beats, downbeats } in seconds from the start of the samples. Downbeats assume four beats to a bar
// and pick the phase where the bass hits hardest.
export function detectBeats(samples, rate) {
  const { env, low, bass, punch, fps } = onsetEnvelope(samples, rate);
  const tempo = estimateTempo(env, fps);
  if (!tempo) return { bpm: null, beats: [], downbeats: [] };
  let frames = trackBeats(env, tempo.period);
  if (frames.length < 2) return { bpm: null, beats: [], downbeats: [] };
  // Hi-hats and claps between the beats can pull the tracker half a beat off. The beat is where the bass
  // drum is: if the kicks fall between the tracked beats, move every beat half a period.
  const half = tempo.period / 2;
  const peakAt = (j) => { let best = j; for (let o = -2; o <= 2; o++) if (j + o >= 0 && j + o < env.length && env[j + o] > env[best]) best = j + o; return best; };
  const near = (x, j) => { let m = 0; for (let o = -2; o <= 2; o++) if (j + o >= 0 && j + o < x.length) m = Math.max(m, x[j + o]); return m; };
  const on = frames.reduce((s, f) => s + near(low, f), 0), off = frames.reduce((s, f) => s + near(low, Math.round(f + half)), 0);
  if (off > 1.3 * on) {
    frames = frames.map((f) => Math.round(f + half)).filter((f) => f < env.length).map(peakAt);
  }
  // Kick on 1 and 3, snare on 2 and 4 reads as half tempo. A slow result with loud drum hits right between
  // its beats (not just hi-hats) is really twice as fast.
  if ((60 * fps * (frames.length - 1)) / (frames.at(-1) - frames[0]) < 100) {
    const mids = frames.slice(1).map((f, i) => peakAt(Math.round((frames[i] + f) / 2)));
    const mean = (x, list) => list.reduce((sum, f) => sum + near(x, f), 0) / list.length;
    if (mean(env, mids) > 0.6 * mean(env, frames) && mean(punch, mids) > 0.35 * mean(punch, frames)) frames = frames.flatMap((f, i) => (i < mids.length ? [f, mids[i]] : [f]));
  }
  // The tempo the tracked beats actually have (their average spacing).
  const bpm = Math.round(((60 * fps * (frames.length - 1)) / (frames.at(-1) - frames[0])) * 10) / 10;
  const accent = [0, 0, 0, 0];
  frames.forEach((f, i) => { accent[i % 4] += near(bass, f + 1); });
  const phase = accent.indexOf(Math.max(...accent));
  // A frame's flux peaks when the attack reaches the middle of its window, half a window after it starts.
  const beats = frames.map((f) => r3((f * HOP + FFT_SIZE / 2) / rate));
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === phase) };
}

// ---------------------------------------------------------------- highlights

// Loudness in dB per `step` seconds.
export function loudnessCurve(samples, rate, step = 0.1) {
  const size = Math.max(1, Math.round(rate * step));
  const out = new Float32Array(Math.ceil(samples.length / size));
  for (let w = 0; w < out.length; w++) {
    let s = 0, n = 0;
    for (let i = w * size; i < Math.min(samples.length, (w + 1) * size); i++) { s += samples[i] * samples[i]; n++; }
    out[w] = 20 * Math.log10(Math.sqrt(s / Math.max(1, n)) + 1e-5);
  }
  return out;
}

// Average brightness (0..1) of the picture per `step` seconds, from tiny greyscale frames.
export async function brightnessCurve(ffmpeg, file, step = 0.1) {
  const W = 32, H = 18;
  const buf = await ffmpegData(ffmpeg, ['-i', file, '-an', '-sn', '-dn', '-vf', `fps=${1 / step},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1']);
  const n = Math.floor(buf.length / (W * H));
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * W * H; i < (f + 1) * W * H; i++) s += buf[i];
    out[f] = s / (W * H * 255);
  }
  return out;
}

// How far each value is above the lowest of the `back` values before it (a sudden rise, not a level).
function rise(x, back) {
  const out = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) {
    let lo = Infinity;
    for (let j = Math.max(0, i - back); j < i; j++) lo = Math.min(lo, x[j]);
    out[i] = Math.max(0, x[i] - lo);
  }
  return out;
}

// A robust scale for a rise curve: its 98th percentile, never tiny.
function scaleOf(x, floor) {
  const sorted = Array.from(x).sort((a, b) => a - b);
  return Math.max(floor, sorted[Math.floor(sorted.length * 0.98)] || 0, sorted.at(-1) * 0.5 || 0);
}

// The moments where both the sound and the picture jump (a goal explosion, a big hit), best first.
// `loudness` in dB and `brightness` 0..1, one value per `step` seconds; either may be missing.
export function findHits({ step = 0.1, loudness = null, brightness = null }, { count = 5, minGap = 2 } = {}) {
  const back = Math.max(1, Math.round(0.4 / step));
  const n = Math.max(loudness?.length || 0, brightness?.length || 0);
  if (!n) return [];
  // A 12 dB jump in sound and a 0.25 jump in brightness are both "big" (score 1); whichever exists counts.
  const parts = [];
  if (loudness?.length) parts.push({ x: loudness, floor: 6, weight: 0.6 });
  if (brightness?.length) parts.push({ x: brightness, floor: 0.08, weight: 0.4 });
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const w = Math.max(1, Math.round(0.2 / step));
  const at = new Float32Array(n), combined = new Float32Array(n);
  for (const p of parts) {
    const r = rise(p.x, back), scale = scaleOf(r, p.floor);
    const norm = (i) => Math.min(1.5, (r[Math.min(i, r.length - 1)] || 0) / scale);
    for (let i = 0; i < n; i++) {
      at[i] += (p.weight / total) * norm(i);
      // The two rises can be a frame or two apart: each moment takes the best of its ±0.2 s.
      let best = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) best = Math.max(best, norm(j));
      combined[i] += (p.weight / total) * best;
    }
  }
  // The moment itself has to be a rise, not just near one.
  for (let i = 0; i < n; i++) if (at[i] < 0.15) combined[i] = 0;
  const order = Array.from(combined.keys()).filter((i) => combined[i] > 0.2).sort((a, b) => combined[b] - combined[a] || a - b);
  const hits = [];
  for (const peak of order) {
    if (hits.length >= count) break;
    if (hits.some((h) => Math.abs(h.i - peak) * step < minGap)) continue;
    // A rise scores about as high for a few samples after it starts; the hit is where it starts.
    let i = peak;
    while (i > 0 && peak - i < back && combined[i - 1] >= 0.9 * combined[peak]) i--;
    hits.push({ i, t: r3(i * step), score: Math.round(combined[peak] * 100) / 100 });
  }
  return hits.map(({ t, score: s }) => ({ t, score: s }));
}

// Everything the UI and the montage need about a gameplay source.
export async function highlights(ffmpeg, source, { step = 0.05 } = {}) {
  const [loud, bright] = await Promise.all([
    source.hasAudio ? decodeAudio(ffmpeg, source.path, { rate: 8000 }).then((s) => loudnessCurve(s, 8000, step)) : null,
    source.kind === 'video' ? brightnessCurve(ffmpeg, source.path, step) : null,
  ]);
  const round = (x, k) => (x ? Array.from(x, (v) => Math.round(v * k) / k) : null);
  return {
    step,
    hits: findHits({ step, loudness: loud, brightness: bright }),
    loudness: round(loud, 10),
    brightness: round(bright, 1000),
  };
}

// The beats of a track, in seconds from its start.
export async function beats(ffmpeg, source) {
  const rate = 22050;
  const samples = await decodeAudio(ffmpeg, source.path, { rate });
  return { ...detectBeats(samples, rate), duration: r3(samples.length / rate) };
}
