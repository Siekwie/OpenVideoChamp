import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planExport, buildArgs, buildFilterGraph, normalizeRequest, resolveSequence, timeline, PlanError, ALL_TRANSITIONS } from '../src/plan.js';

// Absolute paths in the platform's own form: "/videos/x" on POSIX, "C:\videos\x" on Windows.
const P = (p) => path.resolve(p);

const src = (over = {}) => ({
  id: 's_1', name: 'clip.mp4', path: P('/videos/clip.mp4'), uploaded: false, size: 50e6, kind: 'video',
  duration: 30, width: 1920, height: 1080, fps: 60,
  videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bitrate: 12000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2', ...over,
});
const req = (over = {}) => ({
  sourceId: 's_1', start: 0, end: 30, preset: 'discord', cut: 'fast', resolution: 'auto',
  fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto', outputPath: null, ...over,
});
const opts = { encoders: ['libx264', 'h264_nvenc'], defaultOutputDir: P('/out'), exists: () => false };
const bpp = (p) => (p.videoKbps * 1000) / (p.width * p.height * p.fps);
const has = (args, ...flags) => flags.every((f) => args.includes(f));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const graphOf = (args) => flagValue(args, '-filter_complex');
// ffmpeg option values that appear more than once (several -ss / -i / -t)
const allValues = (args, flag) => args.map((a, i) => (a === flag ? args[i + 1] : null)).filter((v) => v != null);

// A small media library for sequence tests.
const LIB = {
  s_1: src(),
  s_b: src({ id: 's_b', name: 'b.mkv', path: P('/videos/b.mkv'), duration: 20, width: 1280, height: 720, fps: 30, hasAudio: false, audioCodec: null, bitrate: 4000 }),
  s_img: src({ id: 's_img', name: 'card.png', path: P('/videos/card.png'), kind: 'image', duration: 0, width: 1920, height: 1080, fps: 0, videoCodec: 'png', hasAudio: false, audioCodec: null, bitrate: 0 }),
  s_mus: src({ id: 's_mus', name: 'song.mp3', path: P('/music/song.mp3'), kind: 'audio', duration: 180, width: 0, height: 0, fps: 0, videoCodec: null, audioCodec: 'mp3', hasAudio: true, bitrate: 320 }),
  s_tall: src({ id: 's_tall', name: 'phone.mp4', path: P('/videos/phone.mp4'), duration: 10, width: 1080, height: 1920, fps: 30, bitrate: 8000 }),
};
const lib = (id) => LIB[id] ?? null;
const seqReq = (over = {}) => ({
  clips: [{ sourceId: 's_1', start: 5, end: 10 }, { sourceId: 's_b', start: 0, end: 4 }],
  transitions: [{ type: 'fade', duration: 1 }],
  preset: 'cut', cut: 'precise', resolution: 'auto', fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto', ...over,
});

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
  assert.equal(p.outputPath, P('/videos/clip_10MB.mp4'));
  assert.equal(p.clips, 1);
  assert.equal(p.duration, 30);
  assert.match(p.summary, /2-pass/);

  const passes = buildArgs(p, src(), req(), { passLogFile: 'pl', nullDevice: '/dev/null' });
  assert.equal(passes.length, 2);
  assert.ok(has(passes[0], '-pass', '-an', '-f') && passes[0].at(-1) === '/dev/null');
  assert.equal(flagValue(passes[0], '-pass'), '1');
  assert.equal(flagValue(passes[1], '-pass'), '2');
  assert.equal(passes[1].at(-1), P('/videos/clip_10MB.mp4'));
  assert.equal(flagValue(passes[1], '-b:v'), `${p.videoKbps}k`);
  assert.equal(flagValue(passes[1], '-maxrate'), `${Math.round(p.videoKbps * 1.5)}k`);
  assert.equal(flagValue(passes[1], '-bufsize'), `${p.videoKbps * 3}k`);
  assert.equal(flagValue(passes[1], '-b:a'), '128k');
  assert.equal(flagValue(passes[1], '-preset'), 'medium');
  assert.ok(has(passes[1], '-pix_fmt', '-movflags', '+faststart'));
  // -ss is an input option (before -i), the clip is scaled inside the filter graph
  assert.ok(passes[1].indexOf('-ss') < passes[1].indexOf('-i'));
  assert.equal(flagValue(passes[1], '-ss'), '0');
  assert.equal(flagValue(passes[1], '-t'), '30');
  const g = graphOf(passes[1]);
  assert.match(g, new RegExp(`\\[0:v\\]setpts=PTS-STARTPTS,fps=60,scale=${p.width}:${p.height}:flags=bicubic,setsar=1,format=yuv420p,tpad=stop=-1:stop_mode=clone,trim=end_frame=1800,settb=AVTB\\[v0\\]`));
  assert.match(g, /\[0:a\]asetpts=PTS-STARTPTS,aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=1440000,atrim=end_sample=1440000,afade=t=in:d=0.005,afade=t=out:st=29.995:d=0.005\[a0\]/);
  assert.ok(!g.includes('xfade') && !g.includes('concat') && !g.includes('volume='));
  assert.deepEqual(allValues(passes[1], '-map'), ['[v0]', '[a0]']);
  // pass 1 has no audio graph at all
  assert.ok(!graphOf(passes[0]).includes(':a]'));
  assert.deepEqual(allValues(passes[0], '-map'), ['[v0]']);
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
  assert.ok(!graphOf(args).includes('[0:a]'));
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
  assert.equal(p.outputPath, P('/videos/clip_cut.mp4'));
  assert.equal(p.estimatedBytes, 12000 * 125 * 10); // from the keyframe at 10 s
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /2\.5 s earlier/);
  const [args] = buildArgs(p, src(), r);
  assert.equal(flagValue(args, '-c'), 'copy');
  assert.equal(flagValue(args, '-ss'), '12.5');
  assert.equal(flagValue(args, '-t'), '7.5');
  assert.ok(has(args, '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart'));
  assert.ok(!args.includes('-c:v') && !args.includes('-filter_complex'));
  // no warning when the snap is small
  assert.equal(planExport(src(), req({ preset: 'cut', start: 10.3, end: 20 }), { ...opts, keyframes: [0, 10, 20] }).warnings.length, 0);
});

test('copy mode uses mkv when the source codecs cannot go in mp4', () => {
  const p = planExport(src({ videoCodec: 'vp9', audioCodec: 'vorbis', container: 'matroska,webm' }), req({ preset: 'cut' }), opts);
  assert.equal(p.outputPath, P('/videos/clip_cut.mkv'));
  assert.ok(!buildArgs(p, src(), req({ preset: 'cut' }))[0].includes('-movflags'));
  // audio-only problem goes away when muted
  const muted = planExport(src({ audioCodec: 'vorbis' }), req({ preset: 'cut', audio: 'mute' }), opts);
  assert.equal(muted.outputPath, P('/videos/clip_cut.mp4'));
});

test('cut + precise re-encodes at crf 20', () => {
  const r = req({ preset: 'cut', cut: 'precise' });
  const p = planExport(src(), r, opts);
  assert.equal(p.mode, 'encode');
  assert.equal(p.crf, 20);
  assert.equal(p.videoKbps, null);
  assert.equal(p.outputPath, P('/videos/clip_cut.mp4'));
  const [args] = buildArgs(p, src(), r);
  assert.equal(flagValue(args, '-crf'), '20');
  assert.ok(!args.includes('-pass'));
  // same size as the source: no scale filter at all
  assert.ok(!graphOf(args).includes('scale='));
});

test('steam: crf 18, 1080p cap, 60 fps cap, 192k audio', () => {
  const r = req({ preset: 'steam' });
  const big = src({ width: 2560, height: 1440, fps: 120 });
  const p = planExport(big, r, opts);
  assert.equal(p.crf, 18);
  assert.equal(p.height, 1080);
  assert.equal(p.width, 1920);
  assert.equal(p.fps, 60);
  assert.equal(p.audioKbps, 192);
  assert.equal(p.targetBytes, null);
  assert.equal(p.outputPath, P('/videos/clip_steam.mp4'));
  const [args] = buildArgs(p, big, r);
  assert.equal(flagValue(args, '-crf'), '18');
  assert.equal(flagValue(args, '-b:a'), '192k');
  assert.match(graphOf(args), /fps=60,scale=1920:1080:flags=bicubic/);
  // smaller sources are left alone
  const smallSrc = src({ width: 1280, height: 720, fps: 30 });
  const small = planExport(smallSrc, r, opts);
  assert.equal(small.height, 720);
  assert.equal(small.fps, 30);
  assert.match(graphOf(buildArgs(small, smallSrc, r)[0]), /fps=30,setsar/);
});

test('custom targetMB', () => {
  const p = planExport(src(), req({ preset: 'custom', targetMB: 2.5 }), opts);
  assert.equal(p.targetBytes, 2_500_000);
  assert.ok(p.estimatedBytes <= 2_500_000);
  assert.equal(p.outputPath, P('/videos/clip_2.5MB.mp4'));
  assert.throws(() => planExport(src(), req({ preset: 'custom' }), opts), /targetMB/);
});

test('explicit outputPath never overwrites and may not be the source', () => {
  const taken = new Set([P('/videos/final.mp4')]);
  const p = planExport(src(), req({ outputPath: P('/videos/final.mp4') }), { ...opts, exists: (f) => taken.has(f) });
  assert.equal(p.outputPath, P('/videos/final-2.mp4'));
  assert.throws(() => planExport(src(), req({ outputPath: P('/videos/clip.mp4') }), opts), PlanError);
  assert.throws(() => planExport(src(), req({ resolution: 1 }), opts), PlanError);
  assert.throws(() => planExport(src(), req({ fps: 0.001 }), opts), PlanError);
});

test('non-clobber naming, upload directory and explicit outputPath', () => {
  const taken = new Set([P('/videos/clip_10MB.mp4'), P('/videos/clip_10MB-2.mp4')]);
  const p = planExport(src(), req(), { ...opts, exists: (f) => taken.has(f) });
  assert.equal(p.outputPath, P('/videos/clip_10MB-3.mp4'));
  const up = planExport(src({ uploaded: true, path: P('/tmp/x/clip.mp4') }), req(), opts);
  assert.equal(up.outputPath, P('/out/clip_10MB.mp4'));
  // a file the app keeps under its own output dir (a title card) does not get exports written next to it
  const card = planExport(src({ name: 'intro.png', path: P('/out/title-cards/intro.png') }), req(), opts);
  assert.equal(card.outputPath, P('/out/intro_10MB.mp4'));
  const explicit = planExport(src(), req({ outputPath: P('/elsewhere/final.mp4') }), opts);
  assert.equal(explicit.outputPath, P('/elsewhere/final.mp4'));
});

test('fps auto drops to 30 only when bpp is still < 0.05 at the chosen resolution', () => {
  const ok = planExport(src({ duration: 30 }), req({ end: 30 }), opts);
  assert.equal(ok.fps, 60);
  const long = src({ duration: 120 });
  const starved = planExport(long, req({ end: 120 }), opts);
  assert.equal(starved.height, 360);
  assert.equal(starved.fps, 30);
  assert.match(graphOf(buildArgs(starved, long, req({ end: 120 }))[1]), /fps=30,scale=640:360/);
  // explicit fps is honoured even when starved
  assert.equal(planExport(long, req({ end: 120, fps: 'source' }), opts).fps, 60);
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
    assert.throws(() => planExport(src(), req(over), opts), (e) => e instanceof PlanError && e.status === 400 && re.test(e.message), `${JSON.stringify(over)} should fail with ${re}`);
  };
  bad({ start: 10, end: 10 }, /0\.1 s/);
  bad({ start: 10, end: 10.05 }, /0\.1 s/);
  bad({ start: 20, end: 10 }, /0\.1 s/);
  bad({ start: -1, end: 10 }, /outside/);
  bad({ start: 0, end: 31 }, /outside/);
  bad({ start: 'x', end: 10 }, /number/);
  bad({ preset: 'youtube' }, /preset/);
  bad({ speed: 'turbo' }, /speed/);
  bad({ resolution: 'huge' }, /resolution/);
  bad({ fps: -5 }, /fps/);
  bad({ sourceId: undefined }, /sourceId/);
});

test('short clip under a size target is capped at 1.5x the source bitrate instead of inflated', () => {
  const small = src({ duration: 20, width: 1280, height: 720, fps: 30, bitrate: 2000 });
  const p = planExport(small, req({ end: 5 }), opts);
  assert.equal(p.videoKbps, 3000);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
  assert.ok(p.estimatedBytes < 2.5e6, `estimated ${p.estimatedBytes}`);
  // A long clip still uses the whole budget.
  const q = planExport(small, req({ end: 20, preset: 'custom', targetMB: 1 }), opts);
  assert.ok(q.videoKbps < 500);
});

// ---------------------------------------------------------------- sequences

test('normalizeRequest: legacy request becomes a one-clip sequence; transitions are padded/typed', () => {
  const r = normalizeRequest(req({ start: 1, end: 2 }));
  assert.deepEqual(r.clips, [{ sourceId: 's_1', start: 1, end: 2, volume: 1, mute: false }]);
  assert.deepEqual(r.transitions, []);
  assert.equal(r.music, null);
  assert.equal(r.fadeIn, 0);
  const s = normalizeRequest(seqReq({ clips: [{ sourceId: 'a', end: 1 }, { sourceId: 'b', end: 1 }, { sourceId: 'c', end: 1 }], transitions: ['fadeblack'] }));
  assert.deepEqual(s.transitions, [{ type: 'fadeblack', duration: 0.5 }, { type: 'cut', duration: 0 }]);
  assert.equal(s.clips[0].start, 0);
  assert.throws(() => normalizeRequest(seqReq({ transitions: [{ type: 'sparkle', duration: 1 }] })), /Unknown transition/);
  assert.throws(() => normalizeRequest(seqReq({ clips: [{ sourceId: 'a', end: 1 }, { start: 0, end: 1 }] })), /no sourceId/);
  assert.throws(() => normalizeRequest(seqReq({ music: { sourceId: 's_mus', mode: 'duck' } })), /music mode/);
  assert.throws(() => normalizeRequest(seqReq({ clips: [{ sourceId: 'a', end: 1, volume: 9 }] })), /volume/);
  assert.ok(ALL_TRANSITIONS.includes('fade') && ALL_TRANSITIONS.includes('wipeleft'));
});

test('two clips with a 1 s crossfade: total 8 s, reference is the sharpest source, xfade offset = 4', () => {
  const r = seqReq();
  const p = planExport(lib, r, opts);
  assert.equal(p.mode, 'encode');
  assert.equal(p.duration, 8);
  assert.equal(p.clips, 2);
  assert.equal(p.transitions, 1);
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 60);
  assert.equal(p.crf, 20);
  assert.equal(p.audioKbps, 160); // clip 1 has audio
  assert.equal(p.outputPath, P('/videos/clip_edit_cut.mp4'));
  assert.ok(p.warnings.some((w) => /conformed to 60 fps/.test(w)) === false, 'no fps warning when nothing is slowed down');
  const [args] = buildArgs(p, lib, r);
  assert.deepEqual(allValues(args, '-ss'), ['5', '0']);
  assert.deepEqual(allValues(args, '-i'), [P('/videos/clip.mp4'), P('/videos/b.mkv')]);
  assert.deepEqual(allValues(args, '-t'), ['5', '4', '8']); // two input -t and the output -t
  const g = graphOf(args);
  assert.match(g, /\[1:v\]setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p,tpad=stop=-1:stop_mode=clone,trim=end_frame=240,settb=AVTB\[v1\]/);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=end_sample=192000\[a1\]/); // silent clip gets silence
  assert.match(g, /\[v0\]\[v1\]xfade=transition=fade:duration=1:offset=4\[x1\]/);
  assert.match(g, /\[a0\]\[a1\]acrossfade=ns=48000:c1=tri:c2=tri\[y1\]/);
  assert.deepEqual(allValues(args, '-map'), ['[x1]', '[y1]']);
});

test('cuts concat, fades wrap the ends, chained offsets account for earlier transitions', () => {
  const r = seqReq({
    clips: [{ sourceId: 's_1', start: 0, end: 3 }, { sourceId: 's_b', start: 0, end: 3 }, { sourceId: 's_1', start: 10, end: 13 }],
    transitions: [{ type: 'cut' }, { type: 'wipeleft', duration: 0.5 }],
    fadeIn: 0.5, fadeOut: 1,
  });
  const p = planExport(lib, r, opts);
  assert.equal(p.duration, 8.5);
  assert.equal(p.transitions, 1);
  const g = graphOf(buildArgs(p, lib, r)[0]);
  assert.match(g, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[x1\]/);
  assert.match(g, /\[a0\]\[a1\]concat=n=2:v=0:a=1\[y1\]/);
  assert.match(g, /\[x1\]\[v2\]xfade=transition=wipeleft:duration=0.5:offset=5.5\[x2\]/);
  assert.match(g, /\[x2\]fade=t=in:d=0.5,fade=t=out:st=7.5:d=1\[vout\]/);
  assert.match(g, /\[y2\]afade=t=in:d=0.5,afade=t=out:st=7.5:d=1\[aout\]/);
  // xfade refuses inputs on different timebases and concat changes its output's, so a transition after
  // a cut only works because every clip is put on the same timebase
  assert.equal(g.match(/,settb=AVTB\[v\d\]/g).length, 3);
});

test('timeline: clips and transitions are whole frames, audio is cut to the same lengths', () => {
  // 0.517 s at 30 fps is 15.51 frames: video can only be 16 frames, so the audio must be 16 frames long too
  const clips = Array.from({ length: 4 }, (_, i) => ({ sourceId: 's_b', start: i, end: i + 0.517 }));
  const one = { sourceId: 's_tall', start: 0, end: 0.517 };
  const r = seqReq({ clips: [...clips, one], transitions: ['cut', 'cut', { type: 'fade', duration: 0.21 }, 'cut'], fadeOut: 0.5 });
  const p = planExport(lib, r, opts);
  assert.equal(p.fps, 30);
  assert.equal(p.duration, 2.467); // (5 * 16 - 6) / 30, not the nominal 5 * 0.517 - 0.21 = 2.375
  const seq = resolveSequence(normalizeRequest(r), lib);
  assert.deepEqual(timeline(seq, 30), { frames: [16, 16, 16, 16, 16], overlap: [0, 0, 6, 0], total: 74, duration: 74 / 30 });
  const [args] = buildArgs(p, lib, r);
  const g = graphOf(args);
  assert.equal(g.match(/trim=end_frame=16,/g).length, 5);
  assert.match(g, /\[4:a\][^;]*apad=whole_len=25600,atrim=end_sample=25600,afade=t=in:d=0.005,afade=t=out:st=0.528333:d=0.005\[a4\]/);
  assert.equal(g.match(/anullsrc=r=48000:cl=stereo,atrim=end_sample=25600/g).length, 4);
  assert.match(g, /\[x2\]\[v3\]xfade=transition=fade:duration=0.2:offset=1.4\[x3\]/); // 6 frames, starting at frame 48 - 6
  assert.match(g, /acrossfade=ns=9600:/);
  assert.match(g, /fade=t=out:st=1.966667:d=0.5\[vout\]/);
  assert.equal(allValues(args, '-t').at(-1), '2.466667');
  // two transitions that fill a clip exactly are trimmed by a frame when rounding pushes them past it
  const tight = resolveSequence(normalizeRequest(seqReq({
    clips: [{ sourceId: 's_b', start: 0, end: 2 }, { sourceId: 's_b', start: 0, end: 0.5 }, { sourceId: 's_b', start: 0, end: 2 }],
    transitions: [{ type: 'fade', duration: 0.25 }, { type: 'fade', duration: 0.25 }],
  })), lib);
  const tl = timeline(tight, 30);
  assert.deepEqual(tl.frames, [60, 15, 60]);
  assert.ok(tl.overlap[0] + tl.overlap[1] <= 15, JSON.stringify(tl.overlap));
});

test('per-clip volume and mute, image clips, mixed aspect ratios are letterboxed', () => {
  const r = seqReq({
    clips: [{ sourceId: 's_1', start: 0, end: 2, volume: 0.25 }, { sourceId: 's_img', end: 3 }, { sourceId: 's_tall', start: 0, end: 2, mute: true }],
    transitions: [{ type: 'cut' }, { type: 'cut' }],
  });
  const p = planExport(lib, r, opts);
  assert.equal(p.duration, 7);
  assert.equal(p.width, 1920); // landscape is on screen longer (5 s vs 2 s), so the phone video gets pillarboxed
  assert.equal(p.height, 1080);
  const [args] = buildArgs(p, lib, r);
  // image input: looped at the output fps for its duration, no -ss
  const i = args.indexOf(P('/videos/card.png'));
  assert.deepEqual(args.slice(i - 7, i), ['-loop', '1', '-framerate', '60', '-t', '3', '-i']);
  const g = graphOf(args);
  assert.match(g, /\[0:a\]asetpts=PTS-STARTPTS,aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.25,apad=whole_len=96000,/);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=end_sample=144000\[a1\]/);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=end_sample=96000\[a2\]/); // muted clip
  assert.match(g, /\[2:v\]setpts=PTS-STARTPTS,fps=60,scale=1920:1080:force_original_aspect_ratio=decrease:flags=bicubic,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1/);
  // all-muted sequence has no audio at all
  const silent = planExport(lib, seqReq({ clips: [{ sourceId: 's_b', end: 2 }, { sourceId: 's_img', end: 2 }], transitions: ['cut'] }), opts);
  assert.equal(silent.audioKbps, 0);
  assert.ok(buildArgs(silent, lib, seqReq({ clips: [{ sourceId: 's_b', end: 2 }, { sourceId: 's_img', end: 2 }], transitions: ['cut'] }))[0].includes('-an'));
});

test('image-only sequence: 30 fps, no bitrate cap, reference is the image', () => {
  const r = seqReq({ clips: [{ sourceId: 's_img', end: 4 }], transitions: [], preset: 'discord' });
  const p = planExport(lib, r, opts);
  assert.equal(p.fps, 30);
  assert.equal(p.height, 1080);
  assert.equal(p.audioKbps, 0);
  assert.equal(p.outputPath, P('/videos/card_10MB.mp4'));
  assert.equal(p.mode, 'encode');
});

test('music: mixed under the clips with its own fades, looped, seeked, or replacing the clip audio', () => {
  const r = seqReq({ music: { sourceId: 's_mus', start: 12, volume: 0.4, fadeIn: 1, fadeOut: 2, loop: true } });
  const p = planExport(lib, r, opts);
  assert.equal(p.music, true);
  const [args] = buildArgs(p, lib, r);
  const m = args.indexOf(P('/music/song.mp3'));
  assert.deepEqual(args.slice(m - 5, m), ['-stream_loop', '-1', '-ss', '12', '-i']);
  const g = graphOf(args);
  assert.match(g, /\[2:a\]asetpts=PTS-STARTPTS,aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.4,afade=t=in:d=1,afade=t=out:st=6:d=2,apad=whole_len=384000,atrim=end_sample=384000\[m\]/);
  assert.match(g, /\[y1\]\[m\]amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[mix\]/);
  assert.deepEqual(allValues(args, '-map'), ['[x1]', '[mix]']);

  const rep = seqReq({ music: { sourceId: 's_mus', mode: 'replace', loop: false }, fadeOut: 1 });
  const a2 = buildArgs(planExport(lib, rep, opts), lib, rep)[0];
  assert.ok(!a2.includes('-stream_loop'));
  const g2 = graphOf(a2);
  assert.ok(!g2.includes('amix'));
  // the clip audio is not built at all (an unconsumed [y1] would make ffmpeg refuse the graph)
  assert.ok(!/\[[01]:a\]/.test(g2) && !g2.includes('anullsrc') && !g2.includes('acrossfade'), g2);
  assert.match(g2, /\[m\]afade=t=out:st=7:d=1\[aout\]/);
  assert.deepEqual(allValues(a2, '-map'), ['[vout]', '[aout]']);

  // music on an otherwise silent sequence still produces an audio track; music + global mute has none
  const silentClips = { clips: [{ sourceId: 's_b', end: 2 }], transitions: [] };
  assert.equal(planExport(lib, seqReq({ ...silentClips, music: { sourceId: 's_mus' } }), opts).audioKbps, 160);
  const muted = seqReq({ ...silentClips, music: { sourceId: 's_mus' }, audio: 'mute' });
  assert.ok(!buildArgs(planExport(lib, muted, opts), lib, muted)[0].includes(P('/music/song.mp3')));
  // a video file can be the music too
  assert.equal(planExport(lib, seqReq({ music: { sourceId: 's_1' } }), opts).music, true);
});

test('normalize adds loudnorm and resamples back to 48 kHz; two-pass pass 1 skips music', () => {
  const r = seqReq({ normalize: true, preset: 'discord', music: { sourceId: 's_mus' } });
  const p = planExport(lib, r, opts);
  assert.equal(p.twoPass, true);
  const passes = buildArgs(p, lib, r, { passLogFile: '/tmp/pl', nullDevice: '/dev/null' });
  assert.match(graphOf(passes[1]), /\[mix\]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000\[aout\]/);
  assert.ok(!passes[0].includes(P('/music/song.mp3')) && !graphOf(passes[0]).includes('[m]'));
  assert.ok(passes[1].includes(P('/music/song.mp3')));
  assert.equal(allValues(passes[1], '-i').length, 3);
});

test('sequence validation: short clips vs transitions, bad ranges, audio as a clip, bad music', () => {
  const bad = (over, re) => assert.throws(() => planExport(lib, seqReq(over), opts), (e) => e instanceof PlanError && re.test(e.message), `${JSON.stringify(over)} should fail with ${re}`);
  bad({ clips: [{ sourceId: 's_1', start: 0, end: 1 }, { sourceId: 's_b', start: 0, end: 5 }], transitions: [{ type: 'fade', duration: 1.5 }] }, /too short for its 1.5 s of transitions/);
  // the middle clip's two transitions together exceed its length
  bad({ clips: [{ sourceId: 's_1', start: 0, end: 5 }, { sourceId: 's_b', start: 0, end: 1 }, { sourceId: 's_1', start: 6, end: 10 }], transitions: [{ type: 'fade', duration: 0.6 }, { type: 'fade', duration: 0.6 }] }, /Clip 2 .* too short/);
  bad({ clips: [{ sourceId: 's_1', start: 29, end: 31 }, { sourceId: 's_b', end: 2 }] }, /Clip 1 .* outside the source/);
  bad({ clips: [{ sourceId: 's_mus', end: 2 }, { sourceId: 's_b', end: 2 }] }, /no video; use it as music/);
  bad({ clips: [{ sourceId: 's_nope', end: 2 }, { sourceId: 's_b', end: 2 }] }, /unknown source s_nope/);
  bad({ clips: [{ sourceId: 's_img', end: 601 }, { sourceId: 's_b', end: 2 }] }, /at most 600 s/);
  bad({ music: { sourceId: 's_img' } }, /has no audio/);
  bad({ music: { sourceId: 's_mus', start: 500 } }, /beyond the end/);
  bad({ music: { sourceId: 's_mus', fadeIn: 5, fadeOut: 5 } }, /Music fades are longer/);
  bad({ fadeIn: 5, fadeOut: 5 }, /Fade in and fade out together/);
  assert.throws(() => planExport(lib, seqReq({ transitions: [{ type: 'zoomin', duration: 0.5 }] }), { ...opts, transitions: ['fade', 'wipeleft'] }), /not supported by this ffmpeg/);
  assert.throws(() => planExport(lib, seqReq({ clips: Array.from({ length: 101 }, () => ({ sourceId: 's_b', end: 1 })) }), opts), /At most 100 clips/);
  // unsupported-transition check honours the capability list
  assert.ok(planExport(lib, seqReq({ transitions: [{ type: 'zoomin', duration: 0.5 }] }), { ...opts, transitions: ALL_TRANSITIONS }).transitions === 1);
});

test('copy mode is only for a single untouched video clip', () => {
  const copy = (over) => planExport(lib, { clips: [{ sourceId: 's_1', start: 0, end: 5 }], preset: 'cut', cut: 'fast', ...over }, opts).mode;
  assert.equal(copy({}), 'copy');
  assert.equal(copy({ clips: [{ sourceId: 's_1', start: 0, end: 5, mute: true }] }), 'copy'); // -an is fine in copy mode
  assert.equal(copy({ clips: [{ sourceId: 's_1', start: 0, end: 5, volume: 0.5 }] }), 'encode');
  // the single-range shape takes volume and mute too
  assert.equal(planExport(lib, { sourceId: 's_1', start: 0, end: 5, volume: 0.5 }, opts).mode, 'encode');
  assert.equal(planExport(lib, { sourceId: 's_1', start: 0, end: 5, mute: true }, opts).audioKbps, 0);
  assert.equal(copy({ fadeIn: 1 }), 'encode');
  assert.equal(copy({ music: { sourceId: 's_mus' } }), 'encode');
  assert.equal(copy({ normalize: true }), 'encode');
  assert.equal(copy({ preview: true }), 'encode');
  assert.equal(copy({ clips: [{ sourceId: 's_img', end: 5 }] }), 'encode');
  assert.equal(copy({ clips: [{ sourceId: 's_1', start: 0, end: 5 }, { sourceId: 's_b', end: 1 }] }), 'encode');
});

test('preview: draft 480p CRF 28 ultrafast, written to the preview dir, no size target', () => {
  const r = seqReq({ preview: true, preset: 'discord', fadeOut: 1 });
  const p = planExport(lib, r, { ...opts, previewDir: P('/tmp/previews') });
  assert.equal(p.preview, true);
  assert.equal(p.targetBytes, null);
  assert.equal(p.crf, 28);
  assert.equal(p.twoPass, false);
  assert.equal(p.height, 480);
  assert.equal(p.width, 854);
  assert.equal(p.audioKbps, 96);
  assert.equal(path.dirname(p.outputPath), P('/tmp/previews'));
  assert.match(path.basename(p.outputPath), /^preview-[a-z0-9]+\.mp4$/);
  assert.match(p.summary, /^Draft preview/);
  const [args] = buildArgs(p, lib, r);
  assert.equal(flagValue(args, '-preset'), 'ultrafast');
  assert.equal(flagValue(args, '-crf'), '28');
  assert.match(graphOf(args), /fade=t=out:st=7:d=1\[vout\]/);
});

test('resolveSequence exposes the timeline the UI needs', () => {
  const seq = resolveSequence(normalizeRequest(seqReq({ fadeIn: 0.5 })), lib);
  assert.equal(seq.total, 8);
  assert.equal(seq.clips.length, 2);
  assert.equal(seq.clips[0].audible, true);
  assert.equal(seq.clips[1].audible, false);
  assert.equal(seq.fadeIn, 0.5);
  const { graph, video, audio } = buildFilterGraph({ width: 1280, height: 720, fps: 30 }, seq);
  assert.equal(video, '[vout]');
  assert.equal(audio, '[aout]');
  assert.match(graph, /xfade=transition=fade:duration=1:offset=4/);
});
