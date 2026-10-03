// HTTP server implementing docs/API.md on top of node:http.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { probe, keyframes as probeKeyframes, version as ffmpegVersion } from './ffmpeg.js';
import { planExport, ALL_TRANSITIONS } from './plan.js';
import { Jobs, isTerminal } from './jobs.js';
import { dialogAvailable, openFileDialog, reveal } from './dialog.js';
import { resolveProject } from './project.js';
import { normalizeCard, renderTitleCard } from './titlecard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_OUTPUT_DIR = path.resolve(process.env.OVC_OUTPUT_DIR || path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'OpenVideoChamp'));

const JSON_LIMIT = 1024 * 1024;
const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.opus': 'audio/ogg',
};
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

// pipeline() (not .pipe()) so an aborted request destroys the read stream and releases its fd.
function sendFile(res, file, type, headers = {}) {
  const { size } = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...headers });
  pipeline(fs.createReadStream(file), res).catch(() => {});
}

// Serves a media file with HTTP Range support so <video>/<audio> can scrub it.
function sendMedia(req, res, file) {
  const size = fs.statSync(file).size;
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m) return sendFile(res, file, type, { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!m[1] && !m[2]) start = 0;
  if (start < 0 || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Cache-Control': 'no-cache' });
  pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

// A browser page from another origin can POST to loopback blind; refuse it. curl and scripts send no Origin.
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// A free file name in `dir`: "name.ext", then "name-2.ext", ...
function freeName(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let file = path.join(dir, name);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem}-${n}${ext}`);
  return file;
}

export function createServer({ ffmpeg, ffprobe, capabilities, tmpDir, publicDir = path.join(ROOT, 'public'), outputDir = DEFAULT_OUTPUT_DIR }) {
  const caps = capabilities || { encoders: ['libx264'], transitions: ALL_TRANSITIONS, ready: Promise.resolve() };
  const sources = new Map(); // id -> Source
  const keyframeCache = new Map(); // id -> Promise<number[]>
  const previewDir = path.join(tmpDir, 'previews');
  // Title cards are kept outside the temp dir so that a saved project still finds them after a restart.
  const cardDir = path.join(outputDir, 'title-cards');
  const jobs = new Jobs({ ffmpeg, tmpDir, capabilities: caps });
  const versionPromise = ffmpegVersion(ffmpeg).catch(() => 'unknown');

  function source(id) {
    const s = sources.get(id);
    if (!s) throw new HttpError(404, `Unknown source: ${id}`);
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
    do id = `s_${randomBytes(4).toString('hex')}`; while (sources.has(id));
    let info;
    try { info = await probe(ffprobe, file); } catch (e) { throw new HttpError(e.status || 400, e.status ? e.message : `Not a readable media file: ${e.message}`); }
    const src = { id, name, path: file, uploaded, ...info };
    sources.set(id, src);
    // Keyframes are needed for copy-mode plans; compute once, early, in the background.
    keyframeCache.set(id, info.kind === 'video' ? probeKeyframes(ffprobe, file).catch(() => []) : Promise.resolve([]));
    return src;
  }

  const getSource = (id) => source(String(id ?? ''));

  async function plan(body) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
    const opts = {
      encoders: caps.encoders,
      transitions: caps.transitions,
      defaultOutputDir: outputDir,
      previewDir,
      exists: (p) => fs.existsSync(p) || jobs.reserved(p),
    };
    const planned = planExport(getSource, body, opts);
    if (planned.mode !== 'copy') return planned;
    // Only a stream copy needs keyframes (snap warning, size estimate); nothing else should wait for
    // the keyframe scan of a huge file.
    const clip = Array.isArray(body.clips) && body.clips.length ? body.clips[0] : body;
    return planExport(getSource, body, { ...opts, keyframes: await keyframeCache.get(clip.sourceId) });
  }

  const byPath = (file) => [...sources.values()].find((s) => s.path === file);

  const routes = [
    ['GET', /^\/api\/info$/, async () => {
      // Give hardware-encoder verification a moment so the first page load sees the full list.
      await Promise.race([caps.ready, new Promise((r) => setTimeout(r, 3000))]);
      return {
        version: VERSION, platform: process.platform,
        ffmpeg: { path: ffmpeg, version: await versionPromise },
        encoders: caps.encoders, transitions: caps.transitions, dialog: dialogAvailable(), defaultOutputDir: outputDir,
      };
    }],
    ['GET', /^\/api\/docs$/, (req, res) => sendFile(res, path.join(ROOT, 'docs', 'API.md'), 'text/markdown; charset=utf-8')],
    ['POST', /^\/api\/open$/, async (req) => {
      const body = await readJson(req);
      if (typeof body?.path !== 'string' || !body.path) throw new HttpError(400, 'Missing "path"');
      return register(body.path);
    }],
    ['POST', /^\/api\/open\/dialog$/, async (req) => {
      const multiple = Boolean((await readJson(req))?.multiple);
      const r = await openFileDialog({ multiple });
      if (!r.paths) return r;
      if (!multiple) return register(r.paths[0]);
      const opened = [], failed = [];
      for (const file of r.paths) {
        try { opened.push(await register(file)); } catch (e) { failed.push({ path: file, error: e.message }); }
      }
      return { sources: opened, failed };
    }],
    ['PUT', /^\/api\/upload$/, async (req, res, url) => {
      let name = path.basename(url.searchParams.get('name') || '').replace(/[\\/:*?"<>|\0]/g, '_');
      if (!name || name === '.' || name === '..') name = 'upload.mp4';
      let file;
      if (url.searchParams.get('card')) {
        fs.mkdirSync(cardDir, { recursive: true });
        file = freeName(cardDir, name);
      } else file = path.join(fs.mkdtempSync(path.join(tmpDir, 'u-')), name);
      // A kept file that turns out to be broken or is not media must not pile up in the card folder.
      try {
        await pipeline(req, fs.createWriteStream(file));
        return await register(file, { uploaded: true, name });
      } catch (e) {
        if (path.dirname(file) === cardDir) fs.rmSync(file, { force: true });
        throw e;
      }
    }],
    ['POST', /^\/api\/titlecard$/, async (req) => {
      const body = await readJson(req);
      const card = normalizeCard(body);
      const logo = body.logoSourceId != null ? getSource(body.logoSourceId) : null;
      if (logo && logo.kind !== 'image') throw new HttpError(400, `Logo: "${logo.name}" is not an image`);
      fs.mkdirSync(cardDir, { recursive: true });
      const stem = (card.title || card.subtitle || 'title card').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'title card';
      const file = freeName(cardDir, `${stem}.png`);
      await renderTitleCard(ffmpeg, card, file, { logo, workDir: fs.mkdtempSync(path.join(tmpDir, 'card-')) });
      return register(file, { uploaded: true });
    }],
    ['POST', /^\/api\/project$/, async (req) => {
      const body = await readJson(req);
      let data = body?.project;
      let baseDir = typeof body?.baseDir === 'string' && body.baseDir ? body.baseDir : process.cwd();
      if (typeof body?.path === 'string' && body.path) {
        const file = path.resolve(body.path);
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
          throw new HttpError(e.code === 'ENOENT' ? 404 : 400, e.code === 'ENOENT' ? `File not found: ${file}` : `Not a project file (no valid JSON): ${file}`);
        }
        baseDir = path.dirname(file);
        if (data && typeof data === 'object') data.name ||= path.basename(file).replace(/(\.ovc)?\.json$/i, '');
      }
      // A file that is already registered keeps its id, so the UI never holds the same media twice.
      return resolveProject(data, { baseDir, open: (file) => byPath(file) || register(file) });
    }],
    ['GET', /^\/api\/sources$/, () => [...sources.values()]],
    ['GET', /^\/api\/sources\/([\w-]+)$/, (req, res, url, id) => source(id)],
    ['GET', /^\/api\/sources\/([\w-]+)\/keyframes$/, async (req, res, url, id) => ({ times: await keyframeCache.get(source(id).id) })],
    ['GET', /^\/api\/sources\/([\w-]+)\/stream$/, (req, res, url, id) => sendMedia(req, res, source(id).path)],
    ['POST', /^\/api\/plan$/, async (req) => plan(await readJson(req))],
    ['POST', /^\/api\/export$/, async (req) => {
      const body = await readJson(req);
      const p = await plan(body);
      const j = jobs.create(p, getSource, body);
      return { jobId: j.id };
    }],
    ['GET', /^\/api\/jobs$/, () => jobs.list()],
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
      sendFile(res, j.outputPath, MEDIA_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', {
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    }],
    ['GET', /^\/api\/jobs\/([\w-]+)\/stream$/, (req, res, url, id) => {
      const j = job(id);
      if (j.status !== 'done') throw new HttpError(409, `Job is ${j.status}, not done`);
      if (!fs.existsSync(j.outputPath)) throw new HttpError(404, 'Output file does not exist');
      sendMedia(req, res, j.outputPath);
    }],
    ['POST', /^\/api\/jobs\/([\w-]+)\/reveal$/, async (req, res, url, id) => {
      const j = job(id);
      if (!fs.existsSync(j.outputPath)) throw new HttpError(404, 'Output file does not exist');
      return { ok: await reveal(j.outputPath) };
    }],
  ];

  function serveStatic(res, pathname) {
    let rel;
    try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)); } catch { throw new HttpError(404, 'Not found'); }
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
    sendFile(res, file, STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { throw new HttpError(400, 'Bad request'); }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(res, url.pathname);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin requests are not allowed');
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
