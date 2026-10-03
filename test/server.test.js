// Integration test: real ffmpeg, real server on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locate } from '../src/ffmpeg.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = path.join(ROOT, 'test', '.work');
const SAMPLE = path.join(WORK, 'sample.mp4');
const CARD = path.join(WORK, 'card.png');
const MUSIC = path.join(WORK, 'music.wav');
const { ffmpeg, ffprobe } = locate();

let proc, base, sourceId;

const api = async (method, route, body) => {
  const res = await fetch(base + route, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJob(id, done, timeoutMs = 40_000) {
  const started = Date.now();
  for (;;) {
    const { data } = await api('GET', `/api/jobs/${id}`);
    if (done(data)) return data;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for job: ${JSON.stringify(data)}`);
    await sleep(150);
  }
}

const probeField = (file, entries) => execFileSync(ffprobe, ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
const duration = (file) => Number(probeField(file, 'format=duration'));

before(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of fs.readdirSync(WORK)) if (f.startsWith('sample_')) fs.rmSync(path.join(WORK, f));
  if (!fs.existsSync(SAMPLE)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', SAMPLE]);
  }
  if (!fs.existsSync(CARD)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x203040:size=1920x1080:rate=1', '-frames:v', '1', CARD]);
  }
  if (!fs.existsSync(MUSIC)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '4', MUSIC]);
  }
  proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'ovc.js'), '--no-open', '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
      if (m) resolve(m[0]);
    });
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => proc?.kill());

test('GET /api/info', async () => {
  const { status, data } = await api('GET', '/api/info');
  assert.equal(status, 200);
  assert.equal(data.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(data.platform, process.platform);
  assert.ok(data.ffmpeg.path);
  assert.ok(Array.isArray(data.encoders));
  assert.ok(Array.isArray(data.transitions) && data.transitions.includes('fade') && data.transitions.includes('wipeleft'));
  assert.equal(typeof data.dialog, 'boolean');
  assert.ok(data.defaultOutputDir);
});

test('POST /api/open probes the file', async () => {
  const { status, data } = await api('POST', '/api/open', { path: SAMPLE });
  assert.equal(status, 200, JSON.stringify(data));
  sourceId = data.id;
  assert.match(sourceId, /^s_/);
  assert.equal(data.name, 'sample.mp4');
  assert.equal(data.path, SAMPLE);
  assert.equal(data.uploaded, false);
  assert.ok(Math.abs(data.duration - 12) < 0.2, `duration ${data.duration}`);
  assert.equal(data.width, 1280);
  assert.equal(data.height, 720);
  assert.equal(data.fps, 30);
  assert.equal(data.kind, 'video');
  assert.equal(data.videoCodec, 'h264');
  assert.equal(data.audioCodec, 'aac');
  assert.equal(data.hasAudio, true);
  assert.ok(data.bitrate > 1000);
  assert.equal(data.size, fs.statSync(SAMPLE).size);
  assert.deepEqual((await api('GET', `/api/sources/${sourceId}`)).data, data);
  assert.equal((await api('POST', '/api/open', { path: path.join(WORK, 'nope.mp4') })).status, 404);
  assert.equal((await api('GET', '/api/sources/s_nope')).status, 404);
});

test('GET /api/sources/:id/stream honours Range', async () => {
  const size = fs.statSync(SAMPLE).size;
  const res = await fetch(`${base}/api/sources/${sourceId}/stream`, { headers: { range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${size}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 100);
  assert.deepEqual(body, fs.readFileSync(SAMPLE).subarray(100, 200));
  const whole = await fetch(`${base}/api/sources/${sourceId}/stream`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-length'), String(size));
  await whole.arrayBuffer();
  const open = await fetch(`${base}/api/sources/${sourceId}/stream`, { headers: { range: `bytes=${size - 10}-` } });
  assert.equal(open.status, 206);
  assert.equal((await open.arrayBuffer()).byteLength, 10);
  const bad = await fetch(`${base}/api/sources/${sourceId}/stream`, { headers: { range: `bytes=${size + 1}-` } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
  await bad.arrayBuffer();
});

test('GET /api/sources/:id/keyframes', async () => {
  const { status, data } = await api('GET', `/api/sources/${sourceId}/keyframes`);
  assert.equal(status, 200);
  assert.ok(data.times.length >= 1);
  assert.equal(data.times[0], 0);
  for (let i = 1; i < data.times.length; i++) assert.ok(data.times[i] > data.times[i - 1]);
});

test('POST /api/plan returns a summary', async () => {
  const { status, data } = await api('POST', '/api/plan', { sourceId, start: 2, end: 8, preset: 'discord' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.mode, 'encode');
  assert.equal(data.targetBytes, 10_000_000);
  assert.ok(data.summary.includes('MB'));
  assert.equal(data.outputPath, path.join(WORK, 'sample_10MB.mp4'));
  const bad = await api('POST', '/api/plan', { sourceId, start: 8, end: 2, preset: 'discord' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error);
  assert.equal((await api('POST', '/api/plan', { sourceId: 's_zz', start: 0, end: 1 })).status, 404);
});

test('export: custom 1 MB, 2..8 s, two-pass', async () => {
  const { status, data } = await api('POST', '/api/export', { sourceId, start: 2, end: 8, preset: 'custom', targetMB: 1, speed: 'fast' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.match(data.jobId, /^j_/);
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status));
  assert.equal(job.status, 'done', job.log);
  assert.equal(job.passes, 2);
  assert.equal(job.progress, 1);
  assert.equal(job.plan.twoPass, true);
  assert.ok(fs.existsSync(job.outputPath));
  assert.equal(job.outputBytes, fs.statSync(job.outputPath).size);
  assert.ok(job.outputBytes <= 1_000_000, `output ${job.outputBytes} bytes`);
  assert.ok(Math.abs(duration(job.outputPath) - 6) <= 0.3, `duration ${duration(job.outputPath)}`);

  // download streams the file as an attachment
  const res = await fetch(`${base}/api/jobs/${data.jobId}/download`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="sample_1MB\.mp4"/);
  assert.equal(Number(res.headers.get('content-length')), job.outputBytes);
  assert.equal((await res.arrayBuffer()).byteLength, job.outputBytes);

  // SSE on a finished job: one terminal event, then the stream closes
  const sse = await fetch(`${base}/api/jobs/${data.jobId}/events`);
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  const text = await sse.text();
  assert.match(text, /^data: \{.*"status":"done"/);
});

test('export: cut + fast is a stream copy from the previous keyframe', async () => {
  const { data } = await api('POST', '/api/export', { sourceId, start: 2, end: 8, preset: 'cut', cut: 'fast' });
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status));
  assert.equal(job.status, 'done', job.log);
  assert.equal(job.plan.mode, 'copy');
  assert.equal(job.outputPath, path.join(WORK, 'sample_cut.mp4'));
  assert.ok(duration(job.outputPath) >= 5.9, `duration ${duration(job.outputPath)}`);
  assert.equal(probeField(job.outputPath, 'stream=codec_name').split('\n')[0], 'h264');
  // same encoder settings as the source means it really was copied, not re-encoded
  assert.equal(probeField(job.outputPath, 'stream=profile').split('\n')[0], probeField(SAMPLE, 'stream=profile').split('\n')[0]);
});

test('PUT /api/upload (chunked body) registers an uploaded source', async () => {
  const url = new URL(`${base}/api/upload?name=${encodeURIComponent('my clip.mp4')}`);
  const data = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on('error', reject);
    fs.createReadStream(SAMPLE).pipe(req);
  });
  assert.equal(data.status, 200, JSON.stringify(data.json));
  assert.equal(data.json.uploaded, true);
  assert.equal(data.json.name, 'my clip.mp4');
  assert.ok(Math.abs(data.json.duration - 12) < 0.2);
  assert.equal(data.json.size, fs.statSync(SAMPLE).size);
  const plan = await api('POST', '/api/plan', { sourceId: data.json.id, start: 0, end: 5, preset: 'steam' });
  assert.equal(plan.status, 200);
  assert.ok(plan.data.outputPath.endsWith(path.join('OpenVideoChamp', 'my clip_steam.mp4')), plan.data.outputPath);
});

test('cancelling a running job leaves no output or .part file and never touches an existing file', async () => {
  const outputPath = path.join(WORK, 'precious.mp4');
  fs.writeFileSync(outputPath, 'keep me');
  const { data } = await api('POST', '/api/export', { sourceId, start: 0, end: 12, preset: 'custom', targetMB: 5, speed: 'best', outputPath });
  const running = await waitForJob(data.jobId, (j) => j.status !== 'queued');
  assert.equal(running.status, 'running');
  assert.notEqual(running.outputPath, outputPath, 'explicit path must not overwrite');
  const { status, data: cancelled } = await api('POST', `/api/jobs/${data.jobId}/cancel`);
  assert.equal(status, 200);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!fs.existsSync(cancelled.outputPath));
  assert.ok(!fs.readdirSync(WORK).some((f) => f.includes('.part')), 'no .part leftovers');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'keep me');
  assert.equal((await api('GET', `/api/jobs/${data.jobId}/download`)).status, 409);
});

test('cross-origin POSTs are refused, same-origin and no-origin accepted; bad URLs do not crash', async () => {
  const post = (headers) => fetch(base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sourceId, start: 0, end: 5 }) });
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ origin: 'http://' + new URL(base).host })).status, 200);
  assert.equal((await post({})).status, 200);
  assert.equal((await api('POST', '/api/open', null)).status, 400);
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 404);
  const txt = path.join(WORK, 'not-a-video.mp4');
  fs.writeFileSync(txt, 'hello');
  assert.equal((await api('POST', '/api/open', { path: txt })).status, 400);
});

test('GET /api/docs serves markdown; unknown routes are JSON 404s', async () => {
  const res = await fetch(`${base}/api/docs`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/markdown/);
  assert.match(await res.text(), /OpenVideoChamp local API/);
  const { status, data } = await api('GET', '/api/nothing');
  assert.equal(status, 404);
  assert.ok(data.error);
});

// ------------------------------------------------------------------ sequences

let cardId, musicId;

test('images and audio files register with their kind; GET /api/sources lists everything', async () => {
  const card = await api('POST', '/api/open', { path: CARD });
  assert.equal(card.status, 200, JSON.stringify(card.data));
  assert.equal(card.data.kind, 'image');
  assert.equal(card.data.width, 1920);
  assert.equal(card.data.height, 1080);
  assert.equal(card.data.duration, 0);
  assert.equal(card.data.hasAudio, false);
  cardId = card.data.id;
  const music = await api('POST', '/api/open', { path: MUSIC });
  assert.equal(music.status, 200, JSON.stringify(music.data));
  assert.equal(music.data.kind, 'audio');
  assert.equal(music.data.hasAudio, true);
  assert.ok(Math.abs(music.data.duration - 4) < 0.1);
  musicId = music.data.id;
  const list = await api('GET', '/api/sources');
  assert.equal(list.status, 200);
  assert.ok(list.data.some((s) => s.id === sourceId) && list.data.some((s) => s.id === cardId) && list.data.some((s) => s.id === musicId));
  // keyframes of an image are an empty list, and its stream is served as an image
  assert.deepEqual((await api('GET', `/api/sources/${cardId}/keyframes`)).data, { times: [] });
  const res = await fetch(`${base}/api/sources/${cardId}/stream`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  await res.arrayBuffer();
  // audio cannot be a clip, an image cannot be music
  assert.equal((await api('POST', '/api/plan', { clips: [{ sourceId: musicId, end: 2 }], preset: 'cut', cut: 'precise' })).status, 400);
  assert.equal((await api('POST', '/api/plan', { sourceId, start: 0, end: 2, music: { sourceId: cardId } })).status, 400);
});

const sequence = (over = {}) => ({
  clips: [
    { sourceId, start: 2, end: 5 },
    { sourceId, start: 7, end: 10, volume: 0.5 },
    { sourceId: cardId, end: 2 },
  ],
  transitions: [{ type: 'fade', duration: 1 }, { type: 'cut' }],
  fadeIn: 0.5, fadeOut: 1,
  music: { sourceId: musicId, volume: 0.6, fadeIn: 0.5, fadeOut: 1, loop: true },
  normalize: true,
  preset: 'custom', targetMB: 2, speed: 'fast',
  ...over,
});

test('export: three clips with a crossfade, a title card, looping music, fades and normalisation', async () => {
  const planned = await api('POST', '/api/plan', sequence());
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  assert.equal(planned.data.duration, 7); // 3 + 3 - 1 + 2
  assert.equal(planned.data.clips, 3);
  assert.equal(planned.data.transitions, 1);
  assert.equal(planned.data.music, true);
  assert.equal(planned.data.width, 1280);
  assert.equal(planned.data.height, 720);
  assert.equal(planned.data.outputPath, path.join(WORK, 'sample_edit_2MB.mp4'));

  const { status, data } = await api('POST', '/api/export', sequence());
  assert.equal(status, 200, JSON.stringify(data));
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status), 90_000);
  assert.equal(job.status, 'done', job.log);
  assert.equal(job.passes, 2);
  assert.ok(fs.existsSync(job.outputPath));
  assert.ok(job.outputBytes <= 2_000_000, `output ${job.outputBytes} bytes`);
  assert.ok(Math.abs(duration(job.outputPath) - 7) <= 0.15, `duration ${duration(job.outputPath)}`);
  const streams = probeField(job.outputPath, 'stream=codec_type,codec_name,width,height,sample_rate').split('\n');
  assert.ok(streams.some((l) => l.includes('video') && l.includes('h264') && l.includes('1280') && l.includes('720')), streams.join(' | '));
  assert.ok(streams.some((l) => l.includes('audio') && l.includes('aac') && l.includes('48000')), streams.join(' | '));
});

test('export: a transition longer than its clip is rejected before anything runs', async () => {
  const { status, data } = await api('POST', '/api/export', sequence({ transitions: [{ type: 'fade', duration: 4 }, { type: 'cut' }] }));
  assert.equal(status, 400);
  assert.match(data.error, /too short/);
});

test('preview: draft render lands in the temp dir and streams back with Range support; music-only mix', async () => {
  const { status, data } = await api('POST', '/api/export', sequence({ preview: true, normalize: false, music: { sourceId: musicId, mode: 'replace', loop: false, volume: 1 } }));
  assert.equal(status, 200, JSON.stringify(data));
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status), 90_000);
  assert.equal(job.status, 'done', job.log);
  assert.equal(job.preview, true);
  assert.equal(job.passes, 1);
  assert.equal(job.plan.height, 480);
  assert.equal(job.plan.targetBytes, null);
  assert.ok(!job.outputPath.startsWith(WORK), `preview must not be written next to the source: ${job.outputPath}`);
  assert.ok(Math.abs(duration(job.outputPath) - 7) <= 0.15, `duration ${duration(job.outputPath)}`);
  assert.ok(probeField(job.outputPath, 'stream=codec_type').includes('audio'), 'music-only output still has an audio track');
  const res = await fetch(`${base}/api/jobs/${data.jobId}/stream`, { headers: { range: 'bytes=0-99' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal((await res.arrayBuffer()).byteLength, 100);
  const whole = await fetch(`${base}/api/jobs/${data.jobId}/stream`);
  assert.equal(whole.status, 200);
  assert.equal(Number(whole.headers.get('content-length')), job.outputBytes);
  await whole.arrayBuffer();
  // a plain single-clip request still works exactly as before (legacy shape)
  const legacy = await api('POST', '/api/plan', { sourceId, start: 1, end: 3, preset: 'cut', cut: 'fast' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.mode, 'copy');
});
