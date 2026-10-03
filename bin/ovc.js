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

const HELP = `OpenVideoChamp ${VERSION} - fast video cutting and size-targeted compression

Usage:
  ovc [file] [--port 4455] [--no-open]      start the local server and open the UI
  ovc cut <file> [options]                  export one clip without the UI

Cut options:
  --from <t> --to <t>      range; seconds or mm:ss(.ms) / hh:mm:ss(.ms)   (default: whole file)
  --size <MB>              target size, e.g. 10MB or 2.5     (custom preset)
  --preset <name>          discord | discord50 | discord500 | steam | cut  (default: cut)
  --out <path>             output file (default: next to the source, never overwrites)
  --res <height>           1080 | 720 | 480 | 360 | source | auto
  --fps <n>                60 | 30 | source | auto
  --mute                   drop audio
  --precise                frame-accurate cut (re-encode) instead of keyframe-snapped stream copy
  --speed <s>              fast | balanced | best  (x264 preset veryfast | medium | slow)

Environment: OVC_PORT, OVC_FFMPEG, OVC_FFPROBE.
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
    if (!opts['no-open']) openBrowser(positional[0] ? `${url}?path=${encodeURIComponent(path.resolve(positional[0]))}` : url);
  });
}

async function cut(positional, opts) {
  const file = positional[0];
  if (!file) die('Usage: ovc cut <file> --from <t> --to <t> [options]');
  const { ffmpeg, ffprobe } = locate();
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`File not found: ${abs}`);
  const source = { id: 's_cli', name: path.basename(abs), path: abs, uploaded: false, ...(await probe(ffprobe, abs)) };
  const request = {
    sourceId: source.id,
    start: opts.from != null ? parseTime(opts.from) : 0,
    end: opts.to != null ? parseTime(opts.to) : source.duration,
    preset: opts.size != null ? 'custom' : opts.preset ?? 'cut',
    targetMB: opts.size != null ? parseFloat(opts.size) : null,
    cut: opts.precise ? 'precise' : 'fast',
    resolution: opts.res ?? 'auto',
    fps: opts.fps ?? 'auto',
    audio: opts.mute ? 'mute' : 'keep',
    speed: opts.speed ?? 'balanced',
    encoder: 'auto',
    outputPath: opts.out ?? null,
  };
  const copy = request.preset === 'cut' && request.cut === 'fast';
  const plan = planExport(source, request, {
    encoders: ['libx264'], defaultOutputDir: DEFAULT_OUTPUT_DIR, exists: fs.existsSync,
    keyframes: copy ? await keyframes(ffprobe, abs) : [],
  });
  for (const w of plan.warnings) console.error(`warning: ${w}`);
  console.error(plan.summary);

  const jobs = new Jobs({ ffmpeg, tmpDir });
  shutdownOn(jobs);
  const result = await new Promise((resolve) => {
    jobs.on('change', (job) => {
      if (isTerminal(job.status)) return resolve(job);
      if (job.status !== 'running') return;
      const parts = [`pass ${job.pass}/${job.passes}`, `${Math.round(job.progress * 100)}%`];
      if (job.fps) parts.push(`${Math.round(job.fps)} fps`);
      if (job.speed) parts.push(`${job.speed}x`);
      if (job.etaSeconds != null) parts.push(`eta ${job.etaSeconds}s`);
      process.stderr.write(`\r${parts.join('  ')}    `);
    });
    jobs.create(plan, source, request);
  });
  process.stderr.write('\n');
  if (result.status !== 'done') die(result.error || `Export ${result.status}`);
  console.log(result.outputPath);
}

const { opts, positional } = parseArgv(process.argv.slice(2));
try {
  if (opts.help || opts.h) console.log(HELP);
  else if (opts.version) console.log(VERSION);
  else if (positional[0] === 'cut') await cut(positional.slice(1), opts);
  else serve(positional, opts);
} catch (err) {
  die(err.message);
}
