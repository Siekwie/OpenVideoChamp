import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planExport, buildArgs, PlanError } from '../src/plan.js';

const src = (over = {}) => ({
  id: 's_1', name: 'clip.mp4', path: '/videos/clip.mp4', uploaded: false, size: 50e6,
  duration: 30, width: 1920, height: 1080, fps: 60,
  videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bitrate: 12000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2', ...over,
});
const req = (over = {}) => ({
  sourceId: 's_1', start: 0, end: 30, preset: 'discord', cut: 'fast', resolution: 'auto',
  fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto', outputPath: null, ...over,
});
const opts = { encoders: ['libx264', 'h264_nvenc'], defaultOutputDir: '/out', exists: () => false };
const bpp = (p) => (p.videoKbps * 1000) / (p.width * p.height * p.fps);
const has = (args, ...flags) => flags.every((f) => args.includes(f));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('discord 10 MB on 30 s 1080p60: 720p or lower by the bpp rule, two-pass, under target', () => {
  const p = planExport(src(), req(), opts);
  assert.equal(p.mode, 'encode');
  assert.equal(p.encoder, 'libx264');
  assert.equal(p.twoPass, true);
  assert.equal(p.targetBytes, 10_000_000);
  assert.ok(p.height <= 720, `height ${p.height}`);
  assert.ok(bpp(p) >= 0.05, `bpp ${bpp(p)}`);
  assert.equal(p.width % 2, 0);
  assert.equal(p.fps, 60);
  assert.equal(p.audioKbps, 128);
  assert.equal(p.videoKbps, Math.floor((10e6 * 0.96 * 8) / 30 / 1000) - 128);
  assert.ok(p.estimatedBytes <= 10_000_000);
  assert.equal(p.outputPath, '/videos/clip_10MB.mp4');
  assert.match(p.summary, /2-pass/);

  const passes = buildArgs(p, src(), req(), { passLogFile: '/tmp/pl', nullDevice: '/dev/null' });
  assert.equal(passes.length, 2);
  assert.ok(has(passes[0], '-pass', '-an', '-f') && passes[0].at(-1) === '/dev/null');
  assert.equal(flagValue(passes[0], '-pass'), '1');
  assert.equal(flagValue(passes[1], '-pass'), '2');
  assert.equal(passes[1].at(-1), '/videos/clip_10MB.mp4');
  assert.equal(flagValue(passes[1], '-b:v'), `${p.videoKbps}k`);
  assert.equal(flagValue(passes[1], '-maxrate'), `${Math.round(p.videoKbps * 1.5)}k`);
  assert.equal(flagValue(passes[1], '-bufsize'), `${p.videoKbps * 3}k`);
  assert.equal(flagValue(passes[1], '-vf'), `scale=-2:${p.height}`);
  assert.equal(flagValue(passes[1], '-b:a'), '128k');
  assert.equal(flagValue(passes[1], '-preset'), 'medium');
  assert.ok(has(passes[1], '-pix_fmt', '-movflags', '+faststart'));
  // -ss is an input option (before -i)
  assert.ok(passes[1].indexOf('-ss') < passes[1].indexOf('-i'));
});

test('audio tier follows total kbps', () => {
  assert.equal(planExport(src({ duration: 30 }), req({ end: 30 }), opts).audioKbps, 128); // 2560 kbps
  assert.equal(planExport(src({ duration: 100 }), req({ end: 100 }), opts).audioKbps, 96); // 768 kbps
  assert.equal(planExport(src({ duration: 200 }), req({ end: 200 }), opts).audioKbps, 64); // 384 kbps
});

test('mute gives audioKbps 0 and -an; no-audio source likewise', () => {
  const p = planExport(src(), req({ audio: 'mute' }), opts);
  assert.equal(p.audioKbps, 0);
  const args = buildArgs(p, src(), req({ audio: 'mute' }))[1];
  assert.ok(args.includes('-an') && !args.includes('-c:a'));
  assert.equal(planExport(src({ hasAudio: false, audioCodec: null }), req(), opts).audioKbps, 0);
});

test('cut + fast is stream copy with keyframe snap warning', () => {
  const r = req({ preset: 'cut', cut: 'fast', start: 12.5, end: 20 });
  const p = planExport(src(), r, { ...opts, keyframes: [0, 10, 20] });
  assert.equal(p.mode, 'copy');
  assert.equal(p.twoPass, false);
  assert.equal(p.videoKbps, null);
  assert.equal(p.crf, null);
  assert.equal(p.width, 1920);
  assert.equal(p.targetBytes, null);
  assert.equal(p.outputPath, '/videos/clip_cut.mp4');
  assert.equal(p.estimatedBytes, 12000 * 125 * 10); // from the keyframe at 10 s
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /2\.5 s earlier/);
  const [args] = buildArgs(p, src(), r);
  assert.equal(flagValue(args, '-c'), 'copy');
  assert.equal(flagValue(args, '-ss'), '12.5');
  assert.equal(flagValue(args, '-t'), '7.5');
  assert.ok(has(args, '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart'));
  assert.ok(!args.includes('-c:v'));
  // no warning when the snap is small
  assert.equal(planExport(src(), req({ preset: 'cut', start: 10.3, end: 20 }), { ...opts, keyframes: [0, 10, 20] }).warnings.length, 0);
});

test('copy mode uses mkv when the source codecs cannot go in mp4', () => {
  const p = planExport(src({ videoCodec: 'vp9', audioCodec: 'vorbis', container: 'matroska,webm' }), req({ preset: 'cut' }), opts);
  assert.equal(p.outputPath, '/videos/clip_cut.mkv');
  assert.ok(!buildArgs(p, src(), req({ preset: 'cut' }))[0].includes('-movflags'));
  // audio-only problem goes away when muted
  const muted = planExport(src({ audioCodec: 'vorbis' }), req({ preset: 'cut', audio: 'mute' }), opts);
  assert.equal(muted.outputPath, '/videos/clip_cut.mp4');
});

test('cut + precise re-encodes at crf 20', () => {
  const r = req({ preset: 'cut', cut: 'precise' });
  const p = planExport(src(), r, opts);
  assert.equal(p.mode, 'encode');
  assert.equal(p.crf, 20);
  assert.equal(p.videoKbps, null);
  assert.equal(p.outputPath, '/videos/clip_cut.mp4');
  const [args] = buildArgs(p, src(), r);
  assert.equal(flagValue(args, '-crf'), '20');
  assert.ok(!args.includes('-pass'));
});

test('steam: crf 18, 1080p cap, 60 fps cap, 192k audio', () => {
  const r = req({ preset: 'steam' });
  const p = planExport(src({ width: 2560, height: 1440, fps: 120 }), r, opts);
  assert.equal(p.crf, 18);
  assert.equal(p.height, 1080);
  assert.equal(p.width, 1920);
  assert.equal(p.fps, 60);
  assert.equal(p.audioKbps, 192);
  assert.equal(p.targetBytes, null);
  assert.equal(p.outputPath, '/videos/clip_steam.mp4');
  const [args] = buildArgs(p, src({ width: 2560, height: 1440, fps: 120 }), r);
  assert.equal(flagValue(args, '-crf'), '18');
  assert.equal(flagValue(args, '-b:a'), '192k');
  assert.equal(flagValue(args, '-vf'), 'fps=60,scale=-2:1080');
  // smaller sources are left alone
  const small = planExport(src({ width: 1280, height: 720, fps: 30 }), r, opts);
  assert.equal(small.height, 720);
  assert.equal(small.fps, 30);
  assert.ok(!buildArgs(small, src({ width: 1280, height: 720, fps: 30 }), r)[0].includes('-vf'));
});

test('custom targetMB', () => {
  const p = planExport(src(), req({ preset: 'custom', targetMB: 2.5 }), opts);
  assert.equal(p.targetBytes, 2_500_000);
  assert.ok(p.estimatedBytes <= 2_500_000);
  assert.equal(p.outputPath, '/videos/clip_2.5MB.mp4');
  assert.throws(() => planExport(src(), req({ preset: 'custom' }), opts), /targetMB/);
});

test('non-clobber naming, upload directory and explicit outputPath', () => {
  const taken = new Set(['/videos/clip_10MB.mp4', '/videos/clip_10MB-2.mp4']);
  const p = planExport(src(), req(), { ...opts, exists: (f) => taken.has(f) });
  assert.equal(p.outputPath, '/videos/clip_10MB-3.mp4');
  const up = planExport(src({ uploaded: true, path: '/tmp/x/clip.mp4' }), req(), opts);
  assert.equal(up.outputPath, '/out/clip_10MB.mp4');
  const explicit = planExport(src(), req({ outputPath: '/elsewhere/final.mp4' }), { ...opts, exists: () => true });
  assert.equal(explicit.outputPath, '/elsewhere/final.mp4');
});

test('fps auto drops to 30 only when bpp is still < 0.05 at the chosen resolution', () => {
  const ok = planExport(src({ duration: 30 }), req({ end: 30 }), opts);
  assert.equal(ok.fps, 60);
  const starved = planExport(src({ duration: 120 }), req({ end: 120 }), opts);
  assert.equal(starved.height, 360);
  assert.equal(starved.fps, 30);
  assert.ok(buildArgs(starved, src({ duration: 120 }), req({ end: 120 }))[1].includes('-vf'));
  assert.equal(flagValue(buildArgs(starved, src({ duration: 120 }), req({ end: 120 }))[1], '-vf'), 'fps=30,scale=-2:360');
  // explicit fps is honoured even when starved
  assert.equal(planExport(src({ duration: 120 }), req({ end: 120, fps: 'source' }), opts).fps, 60);
  // a 30 fps source never changes fps
  assert.equal(planExport(src({ duration: 120, fps: 30 }), req({ end: 120 }), opts).fps, 30);
});

test('explicit resolution is clamped to the source and never upscaled', () => {
  const p = planExport(src({ width: 1280, height: 720 }), req({ resolution: 1080 }), opts);
  assert.equal(p.height, 720);
  const q = planExport(src(), req({ resolution: '480' }), opts);
  assert.equal(q.height, 480);
  assert.equal(q.width, 854);
});

test('low bitrate warning', () => {
  const p = planExport(src({ duration: 60 }), req({ end: 60, preset: 'custom', targetMB: 1 }), opts);
  assert.ok(p.videoKbps < 150);
  assert.ok(p.warnings.some((w) => /heavy quality loss/.test(w)));
  assert.throws(() => planExport(src({ duration: 600 }), req({ end: 600, preset: 'custom', targetMB: 1 }), opts), /too small/);
});

test('hardware encoder: single pass with extra margin', () => {
  const r = req({ encoder: 'h264_nvenc' });
  const p = planExport(src(), r, opts);
  assert.equal(p.twoPass, false);
  assert.equal(p.encoder, 'h264_nvenc');
  assert.ok(p.estimatedBytes <= 10e6 * 0.96 * 0.96);
  const passes = buildArgs(p, src(), r);
  assert.equal(passes.length, 1);
  assert.equal(flagValue(passes[0], '-c:v'), 'h264_nvenc');
  assert.ok(has(passes[0], '-b:v', '-maxrate', '-bufsize'));
  assert.throws(() => planExport(src(), req({ encoder: 'h264_amf' }), opts), /not available/);
});

test('invalid ranges and values are rejected with a 400 error', () => {
  const bad = (over, re) => {
    assert.throws(() => planExport(src(), req(over), opts), (e) => e instanceof PlanError && e.status === 400 && re.test(e.message));
  };
  bad({ start: 10, end: 10 }, /0\.1 s/);
  bad({ start: 10, end: 10.05 }, /0\.1 s/);
  bad({ start: 20, end: 10 }, /0\.1 s/);
  bad({ start: -1, end: 10 }, /outside/);
  bad({ start: 0, end: 31 }, /outside/);
  bad({ start: 'x', end: 10 }, /numbers/);
  bad({ preset: 'youtube' }, /preset/);
  bad({ speed: 'turbo' }, /speed/);
  bad({ resolution: 'huge' }, /resolution/);
  bad({ fps: -5 }, /fps/);
});
