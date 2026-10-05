#!/usr/bin/env node
// CLI: `ovc [file]` starts the local server + UI, `ovc cut <file> ...` exports headlessly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { locate, detectCapabilities, probe, keyframes } from '../src/ffmpeg.js';
import { createServer, DEFAULT_OUTPUT_DIR, VERSION } from '../src/server.js';
import { Jobs, isTerminal } from '../src/jobs.js';
import { planExport } from '../src/plan.js';
import { resolveProject, projectRequest } from '../src/project.js';
import { beats as analyseBeats, highlights as analyseHighlights } from '../src/analysis.js';
import { arrangeMontage, beatGrid, normalizeMontage } from '../src/montage.js';
import { LOOKS, MONTAGE_STYLE } from '../public/js/looks.js';

const HELP = `OpenVideoChamp ${VERSION} - video cutting, trailers and size-targeted compression

Usage:
  ovc [file] [--port 4455] [--no-open]      start the local server and open the UI (file: a video or a project)
  ovc cut <file> [options]                  export one clip without the UI
  ovc render <project.ovc.json> [options]   render a project saved by the UI (clips, transitions, music, ...)
  ovc montage <clips or folders...> [options]
                                            auto-edit a vertical highlight montage: finds the goal in every
                                            clip, trims around it, cuts on the beats of --music, writes a
                                            project you can open and tweak in the UI (--render exports it too)
  ovc beats <music file>                    print the tempo and beat times (JSON)
  ovc hits <video>                          print the detected highlight moments (JSON)

Cut options:
  --from <t> --to <t>      range; seconds or mm:ss(.ms) / hh:mm:ss(.ms)   (default: whole file)
  --precise                frame-accurate cut (re-encode) instead of keyframe-snapped stream copy

Cut and render options:
  --size <MB>              target size, e.g. 10MB or 2.5     (custom preset)
  --preset <name>          discord | discord50 | discord500 | steam | tiktok | cut  (cut: default, render: from the project)
  --out <path>             output file (default: next to the source, never overwrites)
  --res <height>           1080 | 720 | 480 | 360 | source | auto
  --fps <n>                60 | 30 | source | auto
  --mute                   drop audio
  --speed <s>              fast | balanced | best  (x264 preset veryfast | medium | slow)
  --encoder <name>         libx264 (default) or a verified hardware encoder (h264_nvenc, h264_qsv, ...)

Montage options:
  --music <file>           the track to cut to (its beats set the rhythm)
  --music-start <t>        start that far into the track
  --setup <s[,s]>          seconds before each goal: first clip, last clip   (default 5,2.5)
  --hold <s>               seconds after each goal                             (default 0.8)
  --sync <beat|bar|off>    land goals on beats, on bars, or not at all          (default beat)
  --look <name>            ${Object.keys(LOOKS).join(' | ')}   (default punchy)
  --aspect <a>             9:16 | 16:9 | 1:1 | 4:5 | auto   (default 9:16)
  --fit <f>                fill | blur | fit                 (default fill)
  --project <path>         where to write the project       (default montage.ovc.json next to the first clip)
  --render                 also export it (preset tiktok unless --preset / --size say otherwise)

Environment: OVC_PORT, OVC_FFMPEG, OVC_FFPROBE, OVC_OUTPUT_DIR (default ~/Videos/OpenVideoChamp).
`;
const FLAGS = new Set(['no-open', 'mute', 'precise', 'help', 'h', 'version', 'render']);
const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|m4v|ts|mts|wmv|flv|mpg|mpeg)$/i;

function parseArgv(argv) {
  const opts = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [key, inline] = arg.replace(/^-+/, '').split(/=(.*)/s);
    opts[key] = inline ?? (FLAGS.has(key) ? true : argv[++i]);
  }
  return { opts, positional };
}

// "12.5", "01:05.25" or "1:02:03" -> seconds
function parseTime(text) {
  const parts = String(text).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) die(`Bad time: ${text}`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

const tmpDir = path.join(os.tmpdir(), 'openvideochamp', String(process.pid));
fs.mkdirSync(tmpDir, { recursive: true });
const cleanTmp = () => fs.rmSync(tmpDir, { recursive: true, force: true });
process.on('exit', cleanTmp);

function shutdownOn(jobs, server) {
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    server?.close();
    await jobs.killAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function serve(positional, opts) {
  const { ffmpeg, ffprobe } = locate();
  const capabilities = detectCapabilities(ffmpeg);
  const { server, jobs } = createServer({ ffmpeg, ffprobe, capabilities, tmpDir });
  shutdownOn(jobs, server);
  const port = Number(opts.port ?? process.env.OVC_PORT ?? 4455);
  server.on('error', (e) => die(`Cannot listen on 127.0.0.1:${port}: ${e.message}`));
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`OpenVideoChamp ${VERSION} running at ${url}  (ffmpeg: ${ffmpeg})`);
    const file = positional[0] && path.resolve(positional[0]);
    const query = file ? `?${/\.json$/i.test(file) ? 'project' : 'path'}=${encodeURIComponent(file)}` : '';
    if (!opts['no-open']) openBrowser(url + query);
  });
}

// Runs one plan to completion with progress on stderr; resolves to the terminal Job.
function runJob(ffmpeg, plan, sources, request) {
  const jobs = new Jobs({ ffmpeg, tmpDir });
  shutdownOn(jobs);
  return new Promise((resolve) => {
    jobs.on('change', (job) => {
      if (isTerminal(job.status)) return resolve(job);
      if (job.status !== 'running') return;
      const parts = [`pass ${job.pass}/${job.passes}`, `${Math.round(job.progress * 100)}%`];
      if (job.fps) parts.push(`${Math.round(job.fps)} fps`);
      if (job.speed) parts.push(`${job.speed}x`);
      if (job.etaSeconds != null) parts.push(`eta ${job.etaSeconds}s`);
      process.stderr.write(`\r${parts.join('  ')}    `);
    });
    jobs.create(plan, sources, request);
  });
}

async function finish(ffmpeg, plan, sources, request) {
  for (const w of plan.warnings) console.error(`warning: ${w}`);
  console.error(plan.summary);
  const result = await runJob(ffmpeg, plan, sources, request);
  process.stderr.write('\n');
  if (result.status !== 'done') die(result.error || `Export ${result.status}`);
  console.log(result.outputPath);
}

// Encoders/transitions the local ffmpeg has; only waited for when something needs it.
async function capabilities(ffmpeg, { encoders = false } = {}) {
  const caps = detectCapabilities(ffmpeg);
  if (encoders) await caps.ready;
  else await caps.transitionsReady;
  return caps;
}

function outputOptions(opts, defaults = {}) {
  return {
    preset: opts.size != null ? 'custom' : opts.preset ?? defaults.preset ?? 'cut',
    targetMB: opts.size != null ? parseFloat(opts.size) : defaults.targetMB ?? null,
    resolution: opts.res ?? defaults.resolution ?? 'auto',
    fps: opts.fps ?? defaults.fps ?? 'auto',
    audio: opts.mute ? 'mute' : defaults.audio ?? 'keep',
    speed: opts.speed ?? defaults.speed ?? 'balanced',
    encoder: opts.encoder ?? 'auto',
    outputPath: opts.out ?? null,
  };
}

async function cut(positional, opts) {
  const file = positional[0];
  if (!file) die('Usage: ovc cut <file> --from <t> --to <t> [options]');
  const { ffmpeg, ffprobe } = locate();
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`File not found: ${abs}`);
  const source = { id: 's_cli', name: path.basename(abs), path: abs, uploaded: false, ...(await probe(ffprobe, abs)) };
  if (source.kind !== 'video') die(`${source.name} is ${source.kind === 'audio' ? 'an audio file' : 'an image'}; ovc cut needs a video`);
  const request = {
    sourceId: source.id,
    start: opts.from != null ? parseTime(opts.from) : 0,
    end: opts.to != null ? parseTime(opts.to) : source.duration,
    cut: opts.precise ? 'precise' : 'fast',
    ...outputOptions(opts),
  };
  const copy = request.preset === 'cut' && request.cut === 'fast';
  const encoders = opts.encoder && opts.encoder !== 'auto' ? (await capabilities(ffmpeg, { encoders: true })).encoders : ['libx264'];
  const plan = planExport(source, request, {
    encoders, defaultOutputDir: DEFAULT_OUTPUT_DIR, exists: fs.existsSync,
    keyframes: copy ? await keyframes(ffprobe, abs) : [],
  });
  await finish(ffmpeg, plan, source, request);
}

async function render(positional, opts) {
  const file = positional[0];
  if (!file) die('Usage: ovc render <project.ovc.json> [--preset <name>] [--size <MB>] [--out <path>]');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`File not found: ${abs}`);
  let data;
  try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { die(`Cannot read project: ${e.message}`); }
  const { ffmpeg, ffprobe } = locate();
  const caps = await capabilities(ffmpeg, { encoders: Boolean(opts.encoder && opts.encoder !== 'auto') });
  const sources = new Map();
  const project = await resolveProject(data, {
    baseDir: path.dirname(abs),
    open: async (p, s) => {
      const source = { id: s.id, name: s.name || path.basename(p), path: p, uploaded: false, ...(await probe(ffprobe, p)) };
      sources.set(source.id, source);
      return source;
    },
  });
  if (project.missing.length) die(`Source not found: ${project.missing.join(', ')}`);
  if (!project.clips.length) die('The project has no clips');
  const request = projectRequest(project, outputOptions(opts, { preset: 'steam', ...project.output }));
  const getSource = (id) => sources.get(id) || null;
  const plan = planExport(getSource, request, {
    encoders: caps.encoders.length ? caps.encoders : ['libx264'], transitions: caps.transitions,
    defaultOutputDir: DEFAULT_OUTPUT_DIR, exists: fs.existsSync,
  });
  console.error(`${data.name || path.basename(abs)}: ${plan.clips} clip${plan.clips === 1 ? '' : 's'}, ${plan.transitions} transition${plan.transitions === 1 ? '' : 's'}${plan.music ? ', music' : ''}, ${plan.duration.toFixed(1)} s`);
  await finish(ffmpeg, plan, getSource, request);
}

// A free file name: "name.ext", then "name-2.ext", ...
function freeFile(file) {
  const ext = path.extname(file), stem = file.slice(0, -ext.length || undefined);
  let out = file;
  for (let n = 2; fs.existsSync(out); n++) out = `${stem}-${n}${ext}`;
  return out;
}

async function openSource(ffprobe, file, id) {
  return { id, name: path.basename(file), path: file, uploaded: false, ...(await probe(ffprobe, file)) };
}

async function montage(positional, opts) {
  if (!positional.length) die('Usage: ovc montage <clips or folders...> --music <file> [options]');
  const files = [];
  for (const arg of positional) {
    const abs = path.resolve(arg);
    if (!fs.existsSync(abs)) die(`Not found: ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      files.push(...fs.readdirSync(abs).filter((f) => VIDEO_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => path.join(abs, f)));
    } else files.push(abs);
  }
  if (!files.length) die('No video files found');
  let options;
  try {
    options = normalizeMontage({
      ...MONTAGE_STYLE.montage,
      ...(opts.setup != null ? { setup: String(opts.setup).split(',').map(Number) } : {}),
      ...(opts.hold != null ? { hold: Number(opts.hold) } : {}),
      ...(opts.sync != null ? { sync: opts.sync } : {}),
    });
  } catch (e) { die(e.message); }
  const lookKey = opts.look ?? 'punchy';
  if (!LOOKS[lookKey]) die(`Unknown look: ${lookKey} (${Object.keys(LOOKS).join(', ')})`);
  const { ffmpeg, ffprobe } = locate();

  const sources = [], clips = [];
  for (const [i, file] of files.entries()) {
    const src = await openSource(ffprobe, file, `s_${i + 1}`);
    if (src.kind !== 'video') { console.error(`skipped ${src.name}: not a video`); continue; }
    process.stderr.write(`\rfinding the highlight in ${i + 1}/${files.length}: ${src.name}    `);
    const h = await analyseHighlights(ffmpeg, src);
    sources.push(src);
    clips.push({ sourceId: src.id, start: 0, end: src.duration, volume: MONTAGE_STYLE.clipVolume, hit: h.hits[0]?.t ?? null, duration: src.duration });
  }
  process.stderr.write('\n');
  if (!clips.length) die('None of the files is a video');

  let music = null, grid = null;
  if (opts.music) {
    const file = path.resolve(opts.music);
    if (!fs.existsSync(file)) die(`Not found: ${file}`);
    const src = await openSource(ffprobe, file, 's_music');
    if (!src.hasAudio) die(`${src.name} has no audio`);
    sources.push(src);
    music = { sourceId: src.id, start: opts['music-start'] != null ? parseTime(opts['music-start']) : 0, ...MONTAGE_STYLE.music };
    if (options.sync !== 'off') {
      process.stderr.write(`finding the beats of ${src.name}…\n`);
      const b = await analyseBeats(ffmpeg, src);
      if (b.bpm) console.error(`${b.bpm} BPM, ${b.beats.length} beats`);
      grid = beatGrid(b, { start: music.start, loop: music.loop, until: clips.reduce((s, c) => s + c.duration, 0) + 60 });
    }
  }
  const arranged = arrangeMontage(clips, options, grid);
  for (const n of arranged.notes) console.error(`note: ${n}`);

  const project = {
    app: 'OpenVideoChamp', version: 1, name: 'montage',
    sources: sources.map(({ id, path: p, name, kind }) => ({ id, path: p, name, kind })),
    clips: arranged.clips.map(({ duration, ...c }) => c),
    transitions: arranged.clips.slice(1).map(() => ({ type: 'cut', duration: 0 })),
    fadeIn: 0, fadeOut: MONTAGE_STYLE.fadeOut, normalize: Boolean(music),
    aspect: opts.aspect ?? MONTAGE_STYLE.aspect, fit: opts.fit ?? MONTAGE_STYLE.fit, look: LOOKS[lookKey].look,
    music,
    output: { preset: MONTAGE_STYLE.preset, resolution: 'auto', fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto' },
  };
  const projectFile = opts.project ? path.resolve(opts.project) : freeFile(path.join(path.dirname(files[0]), 'montage.ovc.json'));
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
  const total = arranged.timeline.at(-1)?.end ?? 0;
  console.error(`${clips.length} clips, ${total.toFixed(1)} s${grid ? `, cut to the ${options.sync === 'bar' ? 'bars' : 'beats'}` : ''}: ${projectFile}`);
  console.log(projectFile);
  if (opts.render) await render([projectFile], opts);
}

async function analyse(kind, positional) {
  const file = positional[0] && path.resolve(positional[0]);
  if (!file || !fs.existsSync(file)) die(`Usage: ovc ${kind} <file>`);
  const { ffmpeg, ffprobe } = locate();
  const src = await openSource(ffprobe, file, 's_cli');
  if (kind === 'beats') {
    if (!src.hasAudio) die(`${src.name} has no audio`);
    console.log(JSON.stringify(await analyseBeats(ffmpeg, src)));
  } else {
    if (src.kind !== 'video') die(`${src.name} is not a video`);
    const { hits, step } = await analyseHighlights(ffmpeg, src);
    console.log(JSON.stringify({ hits, step }));
  }
}

const { opts, positional } = parseArgv(process.argv.slice(2));
try {
  if (opts.help || opts.h) console.log(HELP);
  else if (opts.version) console.log(VERSION);
  else if (positional[0] === 'cut') await cut(positional.slice(1), opts);
  else if (positional[0] === 'render') await render(positional.slice(1), opts);
  else if (positional[0] === 'montage') await montage(positional.slice(1), opts);
  else if (positional[0] === 'beats' || positional[0] === 'hits') await analyse(positional[0], positional.slice(1));
  else serve(positional, opts);
} catch (err) {
  die(err.message);
}
