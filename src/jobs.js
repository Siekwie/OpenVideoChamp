// Export job queue: one ffmpeg at a time, progress parsing, cancel, change events.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { buildArgs } from './plan.js';

const TERMINAL = new Set(['done', 'error', 'cancelled']);
const EMIT_INTERVAL = 200;

export class Jobs extends EventEmitter {
  constructor({ ffmpeg, tmpDir, capabilities }) {
    super();
    this.ffmpeg = ffmpeg;
    this.tmpDir = tmpDir;
    this.capabilities = capabilities; // { transitions } filled in asynchronously; undefined = accept every known transition
    this.jobs = new Map();
    this.queue = [];
    this.running = null;
  }

  // `sources` is a Source, or a function/Map resolving source ids (see plan.js).
  create(plan, sources, request) {
    let id;
    do id = `j_${randomBytes(4).toString('hex')}`; while (this.jobs.has(id));
    // ffmpeg writes to <name>.part<ext>; it is renamed to the final name only on success, so a
    // failed or cancelled job can never clobber or delete a file it did not fully produce.
    const ext = path.extname(plan.outputPath);
    const tempPath = plan.outputPath.slice(0, -ext.length) + '.part' + ext;
    const job = {
      id, status: 'queued', pass: 0, passes: plan.twoPass ? 2 : 1, progress: 0, fps: null, speed: null,
      etaSeconds: null, plan, outputPath: plan.outputPath, tempPath, outputBytes: null, error: null, log: [],
      args: buildArgs({ ...plan, outputPath: tempPath }, sources, request, { passLogFile: path.join(this.tmpDir, `pass-${id}`), transitions: this.capabilities?.transitions }),
      passProgress: 0, proc: null, cancelled: false, startedAt: 0, lastEmit: 0, timer: null,
    };
    job.finished = new Promise((resolve) => { job.resolveFinished = resolve; });
    this.jobs.set(id, job);
    this.queue.push(job);
    this.emitChange(job, true);
    this.next();
    return this.toJSON(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.toJSON(job) : null;
  }

  // True when a queued/running job will write this path (so the planner won't pick the same name twice).
  reserved(outputPath) {
    return [...this.jobs.values()].some((j) => !TERMINAL.has(j.status) && j.outputPath === outputPath);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j !== job);
      this.finish(job, 'cancelled');
    } else if (job.status === 'running') {
      job.cancelled = true;
      job.proc?.kill('SIGKILL');
    }
    await job.finished;
    return this.toJSON(job);
  }

  // Shutdown: drop the queue, kill what is running, resolve once partial outputs are cleaned up.
  killAll() {
    this.queue = [];
    const running = [...this.jobs.values()].filter((j) => j.status === 'running');
    for (const job of running) { job.cancelled = true; job.proc?.kill('SIGKILL'); }
    return Promise.all(running.map((j) => j.finished));
  }

  toJSON(job) {
    const { id, status, pass, passes, progress, fps, speed, etaSeconds, plan, outputPath, outputBytes, error } = job;
    return { id, status, preview: Boolean(plan.preview), pass, passes, progress, fps, speed, etaSeconds, plan, outputPath, outputBytes, error, log: job.log.join('\n') };
  }

  next() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = job;
    job.status = 'running';
    job.startedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
    } catch (e) {
      return this.finish(job, 'error', `Cannot create output directory: ${e.message}`);
    }
    this.runPass(job, 0);
  }

  runPass(job, index) {
    job.pass = index + 1;
    job.passProgress = 0;
    this.emitChange(job, true);
    const proc = spawn(this.ffmpeg, job.args[index], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    job.proc = proc;
    let out = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n');
      out = lines.pop();
      for (const line of lines) this.progressLine(job, line);
    });
    let err = '';
    proc.stderr.on('data', (chunk) => {
      err += chunk;
      const lines = err.split('\n');
      err = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        job.log.push(line);
        if (job.log.length > 40) job.log.shift();
      }
    });
    proc.on('error', (e) => this.finish(job, 'error', `Cannot run ffmpeg: ${e.message}`));
    proc.on('close', (code) => {
      job.proc = null;
      if (job.status !== 'running') return;
      if (job.cancelled) return this.finish(job, 'cancelled');
      if (code !== 0) return this.finish(job, 'error', job.log.at(-1) || `ffmpeg exited with code ${code}`);
      if (index + 1 < job.args.length) return this.runPass(job, index + 1);
      this.finish(job, 'done');
    });
  }

  // ffmpeg -progress output: key=value lines, a block ends with progress=continue|end.
  progressLine(job, line) {
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'out_time_us') {
      const t = Number(value) / 1e6;
      if (Number.isFinite(t)) job.passProgress = Math.min(1, Math.max(0, t / job.plan.duration));
    } else if (key === 'fps' || key === 'speed') {
      const n = parseFloat(value);
      job[key] = Number.isFinite(n) ? n : null;
    } else if (key === 'progress') {
      const duration = job.plan.duration;
      job.progress = Math.min(1, (job.pass - 1 + job.passProgress) / job.passes);
      if (job.speed > 0) {
        job.etaSeconds = Math.round(((1 - job.passProgress) * duration + (job.passes - job.pass) * duration) / job.speed);
      } else if (job.progress > 0.02) {
        job.etaSeconds = Math.round(((Date.now() - job.startedAt) / 1000) * (1 - job.progress) / job.progress);
      }
      this.emitChange(job, false);
    }
  }

  finish(job, status, error = null) {
    if (TERMINAL.has(job.status)) return;
    job.status = status;
    job.error = error;
    if (status === 'done') {
      job.progress = 1;
      job.etaSeconds = 0;
      try {
        fs.renameSync(job.tempPath, job.outputPath);
        job.outputBytes = fs.statSync(job.outputPath).size;
      } catch (e) {
        job.status = 'error';
        job.error = `ffmpeg finished but the output could not be written: ${e.message}`;
      }
    } else {
      try { fs.rmSync(job.tempPath, { force: true }); } catch { /* locked by a scanner; harmless leftover */ }
    }
    // libx264 writes <passlog>-0.log and -0.log.mbtree next to the pass log base.
    try {
      for (const f of fs.readdirSync(this.tmpDir)) if (f.startsWith(`pass-${job.id}`)) fs.rmSync(path.join(this.tmpDir, f), { force: true });
    } catch { /* tmp dir gone */ }
    if (this.running === job) this.running = null;
    this.emitChange(job, true);
    job.resolveFinished();
    this.next();
  }

  emitChange(job, force) {
    const now = Date.now();
    if (!force && now - job.lastEmit < EMIT_INTERVAL) {
      if (!job.timer) job.timer = setTimeout(() => { job.timer = null; this.emitChange(job, true); }, EMIT_INTERVAL);
      return;
    }
    clearTimeout(job.timer);
    job.timer = null;
    job.lastEmit = now;
    this.emit('change', this.toJSON(job));
  }
}

export const isTerminal = (status) => TERMINAL.has(status);
