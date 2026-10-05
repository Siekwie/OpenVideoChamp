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
const OUT = path.join(WORK, 'out'); // stands in for ~/Videos/OpenVideoChamp
const ENV = { ...process.env, OVC_OUTPUT_DIR: OUT };
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

const probeField = (file, entries) => execFileSync(ffprobe, ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim().replace(/\r/g, '');
const duration = (file) => Number(probeField(file, 'format=duration'));

before(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of fs.readdirSync(WORK)) if (f.startsWith('sample_')) fs.rmSync(path.join(WORK, f));
  fs.rmSync(OUT, { recursive: true, force: true });
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
  proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'ovc.js'), '--no-open', '--port', '0'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'inherit'] });
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
  assert.equal(data.defaultOutputDir, OUT); // OVC_OUTPUT_DIR
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
  assert.equal(plan.data.outputPath, path.join(OUT, 'my clip_steam.mp4'));
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

test('export: a transition after a hard cut works, and many odd-length clips keep audio and video the same length', async () => {
  // 0.517 s is not a whole number of frames; cut to the nominal length the audio would end ~0.2 s before the video
  const clips = Array.from({ length: 12 }, (_, i) => ({ sourceId, start: 1 + i * 0.7, end: 1 + i * 0.7 + 0.517 }));
  const transitions = clips.slice(1).map((_, i) => (i === 5 ? { type: 'wipeleft', duration: 0.2 } : { type: 'cut' }));
  const { status, data } = await api('POST', '/api/export', { clips, transitions, preset: 'cut', cut: 'precise', speed: 'fast', resolution: 360 });
  assert.equal(status, 200, JSON.stringify(data));
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status), 90_000);
  assert.equal(job.status, 'done', job.log);
  assert.equal(job.plan.duration, 6); // 180 frames at 30 fps: within half a frame of the nominal 12 * 0.517 - 0.2
  const [video, audio] = probeField(job.outputPath, 'stream=duration').split('\n').map(Number);
  assert.ok(Math.abs(video - 6) < 0.04, `video ${video}`);
  assert.ok(Math.abs(audio - video) < 0.04, `audio ${audio} vs video ${video}`);
});

test('GET /api/jobs lists every job of this run', async () => {
  const { status, data } = await api('GET', '/api/jobs');
  assert.equal(status, 200);
  assert.ok(data.length >= 5);
  assert.ok(data.every((j) => /^j_/.test(j.id) && j.status && j.plan));
  assert.ok(data.some((j) => j.preview) && data.some((j) => j.status === 'cancelled'));
});

test('POST /api/titlecard renders a card that is kept outside the temp dir; exports do not land next to it', async (t) => {
  const { status, data } = await api('POST', '/api/titlecard', { title: 'Coming 100% soon: it\'s "here"', subtitle: 'Wishlist now', style: 'bar', accent: '#ff8800', logoSourceId: cardId });
  if (status === 501) return t.skip(data.error);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.kind, 'image');
  assert.equal(data.width, 1920);
  assert.equal(data.height, 1080);
  assert.equal(data.uploaded, true);
  assert.equal(path.dirname(data.path), path.join(OUT, 'title-cards'));
  assert.equal(data.name, 'Coming 100 soon its here.png');
  // the same title again gets its own file
  const again = await api('POST', '/api/titlecard', { title: 'Coming 100% soon: it\'s "here"', width: 1280, height: 720 });
  assert.equal(again.data.name, 'Coming 100 soon its here-2.png');
  assert.equal(again.data.height, 720);
  const plan = await api('POST', '/api/plan', { clips: [{ sourceId: data.id, end: 3 }, { sourceId, start: 0, end: 2 }], transitions: ['fadeblack'], preset: 'steam' });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(path.dirname(plan.data.outputPath), OUT);
  for (const bad of [{}, { title: 'x', background: 'red' }, { title: 'x', style: 'fancy' }, { title: 'x', width: 10 }, { title: 'x', logoSourceId: sourceId }]) {
    assert.equal((await api('POST', '/api/titlecard', bad)).status, 400, JSON.stringify(bad));
  }
});

test('PUT /api/upload?card=1 keeps the file in the title card folder; a broken one is not left behind', async () => {
  const put = (name, body) => fetch(`${base}/api/upload?card=1&name=${encodeURIComponent(name)}`, { method: 'PUT', body });
  const res = await put('logo.png', fs.readFileSync(CARD));
  assert.equal(res.status, 200);
  const src = await res.json();
  assert.equal(src.path, path.join(OUT, 'title-cards', 'logo.png'));
  assert.equal(src.kind, 'image');
  assert.equal((await put('broken.png', 'not an image')).status, 400);
  assert.ok(!fs.existsSync(path.join(OUT, 'title-cards', 'broken.png')));
});

test('POST /api/project opens a project file, re-registers its media and returns a ready ExportRequest; ovc render runs it', async () => {
  const project = {
    app: 'OpenVideoChamp', version: 1,
    sources: [{ id: 'a', path: 'sample.mp4' }, { id: 'c', path: 'card.png' }, { id: 'm', path: 'music.wav' }, { id: 'gone', path: 'deleted.mp4', name: 'deleted.mp4' }],
    clips: [{ sourceId: 'a', start: 1, end: 3 }, { sourceId: 'gone', start: 0, end: 2 }, { sourceId: 'c', end: 2 }],
    transitions: [{ type: 'cut' }, { type: 'fade', duration: 0.5 }],
    fadeOut: 0.5, music: { sourceId: 'm', volume: 0.4 },
    output: { preset: 'discord', speed: 'fast', nonsense: true },
  };
  const file = path.join(WORK, 'trailer.ovc.json');
  fs.writeFileSync(file, JSON.stringify(project));
  const { status, data } = await api('POST', '/api/project', { path: file });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.name, 'trailer');
  assert.deepEqual(data.missing, ['deleted.mp4']);
  assert.equal(data.dropped, 1);
  assert.equal(data.sources.length, 3);
  // paths are relative to the project file, and media that is already open keeps its id
  assert.deepEqual(data.sources.map((s) => s.id), [sourceId, cardId, musicId]);
  assert.deepEqual(data.clips, [{ sourceId, start: 1, end: 3 }, { sourceId: cardId, end: 2 }]);
  assert.deepEqual(data.transitions, [{ type: 'fade', duration: 0.5 }]); // the one in front of the surviving clip
  assert.equal(data.music.sourceId, musicId);
  assert.deepEqual(data.output, { preset: 'discord', speed: 'fast' });
  const { clips, transitions, fadeIn, fadeOut, music, normalize, output } = data;
  const plan = await api('POST', '/api/plan', { clips, transitions, fadeIn, fadeOut, music, normalize, ...output });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.equal(plan.data.duration, 3.5);
  assert.equal(plan.data.targetBytes, 10_000_000);

  // the same thing inline, with absolute paths
  const inline = await api('POST', '/api/project', { project: { ...project, sources: [{ id: 'a', path: SAMPLE }], clips: [{ sourceId: 'a', start: 0, end: 1 }], music: null } });
  assert.equal(inline.status, 200);
  assert.equal(inline.data.clips[0].sourceId, sourceId);
  assert.equal((await api('POST', '/api/project', { path: path.join(WORK, 'nope.json') })).status, 404);
  assert.equal((await api('POST', '/api/project', { project: { clips: [] } })).status, 400);

  // headless: a missing source stops the render, a complete project renders
  const cli = (args) => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'ovc.js'), 'render', ...args], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  assert.throws(() => cli([file]), /Source not found: deleted\.mp4/);
  project.sources.pop();
  project.clips.splice(1, 1);
  project.transitions = [{ type: 'fade', duration: 0.5 }];
  fs.writeFileSync(file, JSON.stringify(project));
  const out = cli([file, '--preset', 'cut', '--res', '360', '--out', path.join(WORK, 'sample_render.mp4')]);
  assert.equal(out, path.join(WORK, 'sample_render.mp4'));
  assert.ok(Math.abs(duration(out) - 3.5) <= 0.15, `duration ${duration(out)}`);
});

// ------------------------------------------------------------------ montage

const GOAL = path.join(WORK, 'goal.mp4'); // a "goal" at 4.5 s: a white flash and a loud boom
const BEAT = path.join(WORK, 'beat.wav'); // a kick drum at 120 BPM from 0.25 s

test('montage: beats of a track, the hit of a gameplay clip, an auto-edit cut to the beats, and a vertical export with every effect', async () => {
  if (!fs.existsSync(GOAL)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
      '-f', 'lavfi', '-i', "aevalsrc='0.03*(random(0)-0.5)+if(between(t,4.5,5.3),0.9*(random(1)-0.5)*exp(-(t-4.5)*4),0)':s=48000:d=8",
      '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=fill:enable='between(t,4.5,4.85)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', GOAL]);
  }
  if (!fs.existsSync(BEAT)) {
    const k = 'mod(t-0.25,0.5)';
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      `aevalsrc='sin(2*PI*(50+80*exp(-${k}*25))*${k})*exp(-${k}*10)*gte(t,0.25)+0.05*sin(2*PI*330*t)':s=22050:d=20`, BEAT]);
  }
  const goal = (await api('POST', '/api/open', { path: GOAL })).data;
  const beat = (await api('POST', '/api/open', { path: BEAT })).data;

  const b = await api('GET', `/api/sources/${beat.id}/beats`);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.ok(Math.abs(b.data.bpm - 120) < 1.5, `bpm ${b.data.bpm}`);
  assert.ok(Math.abs(b.data.beats[0] - 0.25) < 0.03, `first beat ${b.data.beats[0]}`);
  assert.ok(b.data.downbeats.length >= b.data.beats.length / 4 - 1);
  assert.ok(Math.abs(b.data.duration - 20) < 0.1);
  assert.equal((await api('GET', `/api/sources/${cardId}/beats`)).status, 400); // no audio

  const h = await api('GET', `/api/sources/${goal.id}/highlights`);
  assert.equal(h.status, 200, JSON.stringify(h.data));
  assert.ok(Math.abs(h.data.hits[0].t - 4.5) <= 0.1, JSON.stringify(h.data.hits));
  assert.ok(h.data.loudness.length >= 150 && h.data.brightness.length >= 150);
  assert.equal((await api('GET', `/api/sources/${beat.id}/highlights`)).status, 400); // not a video

  // three copies of the clip; the second has its own hit, the third is trimmed so its goal is cut off
  const m = await api('POST', '/api/montage', {
    clips: [{ sourceId: goal.id, volume: 0.6 }, { sourceId: goal.id, hit: 3 }, { sourceId: goal.id, start: 0, end: 4 }],
    music: { sourceId: beat.id }, setup: [3, 1.5], hold: 0.6, sync: 'beat',
  });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.sync, 'beat');
  assert.ok(Math.abs(m.data.bpm - 120) < 1.5);
  assert.equal(m.data.clips[0].volume, 0.6); // other fields survive
  assert.ok(Math.abs(m.data.clips[0].hit - 4.5) <= 0.1);
  assert.equal(m.data.clips[1].hit, 3);
  assert.deepEqual(m.data.transitions, [{ type: 'cut', duration: 0 }, { type: 'cut', duration: 0 }]);
  const onBeat = (t) => b.data.beats.some((x) => Math.abs(x - t) < 0.002);
  for (const t of m.data.timeline.slice(0, 2)) {
    assert.ok(t.onBeat && onBeat(t.hit) && onBeat(t.end), JSON.stringify(m.data.timeline));
  }
  assert.ok(m.data.timeline[0].hit - m.data.timeline[0].start > m.data.timeline[1].hit - m.data.timeline[1].start);
  assert.equal((await api('POST', '/api/montage', { clips: [] })).status, 400);
  assert.equal((await api('POST', '/api/montage', { clips: [{ sourceId: goal.id }], sync: 'nope' })).status, 400);

  // the montage as a vertical draft with framing, a pan, a look, selective colour, a flash and a sound
  const clips = m.data.clips.map((c) => ({ ...c, flash: c.hit != null ? 0.7 : 0 }));
  clips[0] = { ...clips[0], pan: [{ t: clips[0].start, x: 0.2 }, { t: clips[0].end, x: 0.8 }], keepColor: { color: '#e0501e', until: clips[0].hit }, sounds: [{ sourceId: musicId, volume: 0.5 }] };
  clips[1] = { ...clips[1], rate: 1.25, look: { tint: { color: '#ff3cc8', amount: 0.4 } } };
  clips.push({ sourceId: cardId, end: 1.5, fit: 'blur' });
  const request = {
    clips, transitions: [...m.data.transitions, { type: 'fadewhite', duration: 0.3 }],
    aspect: '9:16', fit: 'fill', look: { contrast: 1.12, saturation: 1.35, sharpen: 0.35, motionBlur: 0.3 },
    music: { sourceId: beat.id, volume: 0.8 }, preset: 'tiktok', preview: true,
  };
  const planned = await api('POST', '/api/plan', request);
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  assert.equal(planned.data.aspect, '9:16');
  assert.deepEqual([planned.data.width, planned.data.height], [360, 640]); // the clip is 360p, the preview caps at 480
  const { data } = await api('POST', '/api/export', request);
  const job = await waitForJob(data.jobId, (j) => ['done', 'error', 'cancelled'].includes(j.status), 120_000);
  assert.equal(job.status, 'done', job.log);
  const [video, audio] = probeField(job.outputPath, 'stream=width,height,duration').split('\n');
  assert.ok(video.startsWith('360,640,'), video);
  assert.ok(Math.abs(Number(video.split(',')[2]) - job.plan.duration) < 0.05, `${video} vs ${job.plan.duration}`);
  assert.ok(audio, 'has audio');

  // a project carries the montage fields and the sound sources through a save/open
  const project = {
    app: 'OpenVideoChamp', version: 1,
    sources: [{ id: 'g', path: GOAL }, { id: 'snd', path: MUSIC }],
    clips: [{ sourceId: 'g', start: 1, end: 5, hit: 4.5, sounds: [{ sourceId: 'snd', at: 4.5 }, { sourceId: 'gone' }] }],
    aspect: '9:16', fit: 'blur', look: { saturation: 1.3 },
  };
  const opened = await api('POST', '/api/project', { project });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.deepEqual(opened.data.clips[0].sounds, [{ sourceId: musicId, at: 4.5 }]);
  assert.equal(opened.data.aspect, '9:16');
  assert.equal(opened.data.fit, 'blur');
  assert.deepEqual(opened.data.look, { saturation: 1.3 });
});
