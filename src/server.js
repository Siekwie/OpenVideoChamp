// HTTP server implementing docs/API.md on top of node:http.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { probe, keyframes as probeKeyframes, version as ffmpegVersion } from './ffmpeg.js';
import { planExport } from './plan.js';
import { Jobs, isTerminal } from './jobs.js';
import { dialogAvailable, openFileDialog, reveal } from './dialog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'OpenVideoChamp');

const JSON_LIMIT = 1024 * 1024;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > JSON_LIMIT) { req.pause(); reject(new HttpError(413, 'Request body too large (1 MB max)')); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res, file, type, headers = {}) {
  const { size } = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...headers });
  fs.createReadStream(file).pipe(res);
}

export function createServer({ ffmpeg, ffprobe, encoderState, tmpDir, publicDir = path.join(ROOT, 'public') }) {
  const sources = new Map(); // id -> Source
  const keyframeCache = new Map(); // id -> Promise<number[]>
  const jobs = new Jobs({ ffmpeg, tmpDir });
  const versionPromise = ffmpegVersion(ffmpeg).catch(() => 'unknown');

  function source(id) {
    const s = sources.get(id);
    if (!s) throw new HttpError(404, 'Unknown source');
    return s;
  }

  function job(id) {
    const j = jobs.get(id);
    if (!j) throw new HttpError(404, 'Unknown job');
    return j;
  }

  async function register(file, { uploaded = false, name = path.basename(file) } = {}) {
    file = path.resolve(file);
    try { if (!fs.statSync(file).isFile()) throw new Error(); } catch { throw new HttpError(404, `File not found: ${file}`); }
    let id;
    do id = `s_${randomBytes(2).toString('hex')}`; while (sources.has(id));
    const src = { id, name, path: file, uploaded, ...(await probe(ffprobe, file)) };
    sources.set(id, src);
    // Keyframes are needed for copy-mode plans; compute once, early, in the background.
    keyframeCache.set(id, probeKeyframes(ffprobe, file).catch(() => []));
    return src;
  }

  async function plan(body) {
    const src = source(String(body?.sourceId ?? ''));
    return planExport(src, body, {
      encoders: encoderState.encoders,
      defaultOutputDir: DEFAULT_OUTPUT_DIR,
      exists: (p) => fs.existsSync(p) || jobs.reserved(p),
      keyframes: await keyframeCache.get(src.id),
    });
  }

  const routes = [
    ['GET', /^\/api\/info$/, async () => ({
      version: VERSION, platform: process.platform,
      ffmpeg: { path: ffmpeg, version: await versionPromise },
      encoders: encoderState.encoders, dialog: dialogAvailable(), defaultOutputDir: DEFAULT_OUTPUT_DIR,
    })],
    ['GET', /^\/api\/docs$/, (req, res) => sendFile(res, path.join(ROOT, 'docs', 'API.md'), 'text/markdown; charset=utf-8')],
    ['POST', /^\/api\/open$/, async (req) => {
      const body = await readJson(req);
      if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, 'Missing "path"');
      return register(body.path);
    }],
    ['POST', /^\/api\/open\/dialog$/, async () => {
      const r = await openFileDialog();
      return r.path ? register(r.path) : r;
    }],
    ['PUT', /^\/api\/upload$/, async (req, res, url) => {
      const name = path.basename(url.searchParams.get('name') || 'upload.mp4').replace(/[\\/:*?"<>|\0]/g, '_');
      const dir = fs.mkdtempSync(path.join(tmpDir, 'u-'));
      const file = path.join(dir, name);
      await pipeline(req, fs.createWriteStream(file));
      return register(file, { uploaded: true, name });
    }],
    ['GET', /^\/api\/sources\/([\w-]+)$/, (req, res, url, id) => source(id)],
    ['GET', /^\/api\/sources\/([\w-]+)\/keyframes$/, async (req, res, url, id) => ({ times: await keyframeCache.get(source(id).id) })],
    ['GET', /^\/api\/sources\/([\w-]+)\/stream$/, (req, res, url, id) => {
      const src = source(id);
      const size = fs.statSync(src.path).size;
      const type = VIDEO_TYPES[path.extname(src.path).toLowerCase()] || 'application/octet-stream';
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (!m) return sendFile(res, src.path, type, { 'Accept-Ranges': 'bytes' });
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (!m[1] && !m[2]) start = 0;
      if (start < 0 || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}` });
      fs.createReadStream(src.path, { start, end }).pipe(res);
    }],
    ['POST', /^\/api\/plan$/, async (req) => plan(await readJson(req))],
    ['POST', /^\/api\/export$/, async (req) => {
      const body = await readJson(req);
      const p = await plan(body);
      const j = jobs.create(p, source(body.sourceId), body);
      return { jobId: j.id };
    }],
    ['GET', /^\/api\/jobs\/([\w-]+)$/, (req, res, url, id) => job(id)],
    ['GET', /^\/api\/jobs\/([\w-]+)\/events$/, (req, res, url, id) => {
      let current = job(id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (j) => {
        res.write(`data: ${JSON.stringify(j)}\n\n`);
        if (isTerminal(j.status)) { jobs.off('change', onChange); res.end(); }
      };
      const onChange = (j) => { if (j.id === id) send(j); };
      jobs.on('change', onChange);
      req.on('close', () => jobs.off('change', onChange));
      send(current);
    }],
    ['POST', /^\/api\/jobs\/([\w-]+)\/cancel$/, async (req, res, url, id) => { job(id); return jobs.cancel(id); }],
    ['GET', /^\/api\/jobs\/([\w-]+)\/download$/, (req, res, url, id) => {
      const j = job(id);
      if (j.status !== 'done') throw new HttpError(409, `Job is ${j.status}, not done`);
      const name = path.basename(j.outputPath);
      sendFile(res, j.outputPath, VIDEO_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', {
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    }],
    ['POST', /^\/api\/jobs\/([\w-]+)\/reveal$/, async (req, res, url, id) => {
      const j = job(id);
      if (!fs.existsSync(j.outputPath)) throw new HttpError(404, 'Output file does not exist');
      return { ok: await reveal(j.outputPath) };
    }],
  ];

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
    sendFile(res, file, STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(res, url.pathname);
      }
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (!m) continue;
        if (req.method !== method) throw new HttpError(405, `Use ${method}`);
        const result = await handler(req, res, url, m[1]);
        if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
        return;
      }
      throw new HttpError(404, 'No such route');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) return res.end();
      if (status === 413) { res.setHeader('Connection', 'close'); res.once('finish', () => req.destroy()); }
      sendJson(res, status, { error: err.message });
    }
  });

  return { server, jobs };
}
