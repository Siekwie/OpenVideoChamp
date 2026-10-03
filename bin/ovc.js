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

const HELP = `OpenVideoChamp ${VERSION} - video cutting, trailers and size-targeted compression

Usage:
  ovc [file] [--port 4455] [--no-open]      start the local server and open the UI (file: a video or a project)
  ovc cut <file> [options]                  export one clip without the UI
  ovc render <project.ovc.json> [options]   render a project saved by the UI (clips, transitions, music, ...)

Cut options:
  --from <t> --to <t>      range; seconds or mm:ss(.ms) / hh:mm:ss(.ms)   (default: whole file)
  --precise                frame-accurate cut (re-encode) instead of keyframe-snapped stream copy

Cut and render options:
  --size <MB>              target size, e.g. 10MB or 2.5     (custom preset)
  --preset <name>          discord | discord50 | discord500 | steam | cut  (cut: default, render: from the project)
  --out <path>             output file (default: next to the source, never overwrites)
  --res <height>           1080 | 720 | 480 | 360 | source | auto
  --fps <n>                60 | 30 | source | auto
  --mute                   drop audio
  --speed <s>              fast | balanced | best  (x264 preset veryfast | medium | slow)
  --encoder <name>         libx264 (default) or a verified hardware encoder (h264_nvenc, h264_qsv, ...)

Environment: OVC_PORT, OVC_FFMPEG, OVC_FFPROBE, OVC_OUTPUT_DIR (default ~/Videos/OpenVideoChamp).
`;
const FLAGS = new Set(['no-open', 'mute', 'precise', 'help', 'h', 'version']);

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

const { opts, positional } = parseArgv(process.argv.slice(2));
try {
  if (opts.help || opts.h) console.log(HELP);
  else if (opts.version) console.log(VERSION);
  else if (positional[0] === 'cut') await cut(positional.slice(1), opts);
  else if (positional[0] === 'render') await render(positional.slice(1), opts);
  else serve(positional, opts);
} catch (err) {
  die(err.message);
}
