'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round3 = (t) => Math.round(t * 1000) / 1000;
const MIN_LEN = 0.101; // backend rejects < 0.1 s; the extra ms keeps float subtraction on the safe side
const OPT_VALUES = {
  preset: ['cut', 'discord', 'discord50', 'discord500', 'steam', 'custom'],
  cut: ['fast', 'precise'],
  resolution: ['auto', 'source', '1080', '720', '480', '360'],
  fps: ['auto', 'source', '60', '30'],
  audio: ['keep', 'mute'],
  speed: ['fast', 'balanced', 'best'],
};

const state = {
  info: null,
  source: null,        // Source from the API; null while an upload is in flight
  name: '',            // file name shown in the header
  size: 0,             // bytes
  objectUrl: null,     // preview URL for uploaded files
  duration: 0,
  fps: 30,
  inT: 0,
  outT: 0,
  opts: { preset: 'discord', targetMB: 10, cut: 'fast', resolution: 'auto', fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto' },
  plan: null,
  planError: null,
  planPending: false,
  job: null,
  es: null,
  pollTimer: 0,
  keyframes: null,
  kfLoading: false,
  thumbs: [],
  thumbGen: 0,
  drag: null,
  upload: null,
  loadError: '',
};

const el = {};
for (const id of ['app', 'fileinfo', 'filename', 'filemeta', 'openBtn', 'openBtn2', 'fileInput', 'player', 'dropzone',
  'dropError', 'uploading', 'uploadFill', 'uploadText', 'video', 'thumbVideo', 'playerNote', 'playBtn', 'curTime', 'totTime',
  'selLen', 'track', 'strip', 'kfCanvas', 'dimL', 'dimR', 'selBody', 'snapMark', 'hIn', 'hOut', 'playhead', 'inInput',
  'outInput', 'setIn', 'setOut', 'presets', 'customWrap', 'targetMB', 'cutWrap', 'optCut', 'optResolution', 'optFps',
  'optAudio', 'speedWrap', 'optSpeed', 'encoderWrap', 'optEncoder', 'estimate', 'exportBtn', 'progress', 'progressFill',
  'progressText', 'cancelBtn', 'resultRow', 'resultText', 'revealBtn', 'downloadBtn', 'logDetails', 'logPre', 'version',
  'copyDocsBtn']) el[id] = $(id);
const video = el.video;

// ---------- formatting ----------

function fmtTime(t) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000 + 1e-6);
  const mm = String(m).padStart(2, '0');
  const body = `${mm}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return h ? `${h}:${body}` : body;
}

function fmtShort(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.round(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtMB(bytes) {
  const mb = bytes / 1e6;
  return mb >= 100 ? `${Math.round(mb)} MB` : mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `~${sec} s` : `~${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function parseTime(str) {
  const parts = String(str).trim().replace(/,/g, '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d*\.?\d*$/.test(p) || p === '')) return null;
  let t = 0;
  for (const p of parts) t = t * 60 + parseFloat(p);
  return isFinite(t) ? t : null;
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

// ---------- options persistence ----------

function loadOpts() {
  try {
    const saved = JSON.parse(localStorage.getItem('ovc.opts') || '{}');
    for (const [k, allowed] of Object.entries(OPT_VALUES)) if (allowed.includes(String(saved[k]))) state.opts[k] = saved[k];
    if (typeof saved.encoder === 'string') state.opts.encoder = saved.encoder;
    if (Number(saved.targetMB) >= 1) state.opts.targetMB = Number(saved.targetMB);
  } catch { /* storage unavailable */ }
}

function saveOpts() {
  try { localStorage.setItem('ovc.opts', JSON.stringify(state.opts)); } catch { /* ignore */ }
}

// ---------- loading media ----------

function showLoadError(msg) {
  state.loadError = msg || '';
  el.dropError.textContent = state.loadError;
  renderEstimate();
}

function loadMedia({ url, name, size, source, objectUrl }) {
  stopJob();
  state.job = null;
  if (state.objectUrl && state.objectUrl !== objectUrl) URL.revokeObjectURL(state.objectUrl);
  if (state.upload) { state.upload.abort(); state.upload = null; }
  Object.assign(state, {
    source, name, size, objectUrl: objectUrl || null, keyframes: null, kfLoading: false, plan: null, planError: null,
    duration: source ? source.duration : 0, fps: (source && source.fps) || 30, inT: 0,
  });
  state.outT = state.duration;
  state.thumbGen++;
  state.thumbs = [];
  showLoadError('');
  applyPresetDefault(size);
  el.app.classList.remove('nofile');
  el.dropzone.hidden = true;
  el.uploading.hidden = true;
  el.playerNote.hidden = true;
  video.hidden = false;
  video.pause();
  video.src = url;
  el.thumbVideo.src = url;
  document.title = `${name} · OpenVideoChamp`;
  render();
  requestPlan();
  startThumbs();
}

function applyPresetDefault(size) {
  const p = state.opts.preset;
  if (size > 10e6 && p === 'cut') state.opts.preset = 'discord';
  else if (size <= 10e6 && p === 'discord') state.opts.preset = 'cut';
}

function loadSource(src) {
  loadMedia({ url: `/api/sources/${src.id}/stream`, name: src.name, size: src.size, source: src });
}

async function openPath(path) {
  try {
    const res = await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showLoadError(data.error || `Could not open (${res.status})`);
    loadSource(data);
  } catch { showLoadError('Cannot reach the server'); }
}

async function openDialog() {
  if (state.info && state.info.dialog === false) return el.fileInput.click();
  try {
    const res = await fetch('/api/open/dialog', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (data.unsupported) return el.fileInput.click();
    if (data.cancelled) return;
    if (!res.ok) return showLoadError(data.error || `Could not open (${res.status})`);
    loadSource(data);
  } catch { el.fileInput.click(); }
}

function uploadFile(file) {
  if (!file) return;
  const objectUrl = URL.createObjectURL(file);
  loadMedia({ url: objectUrl, name: file.name, size: file.size, source: null, objectUrl });
  el.uploading.hidden = false;
  setUploadProgress(0);
  const xhr = new XMLHttpRequest();
  state.upload = xhr;
  xhr.open('PUT', `/api/upload?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(e.loaded / e.total); };
  xhr.onload = () => {
    if (state.upload !== xhr) return;
    state.upload = null;
    el.uploading.hidden = true;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
    if (xhr.status < 200 || xhr.status >= 300) return showLoadError(`Upload failed: ${data.error || xhr.status}`);
    attachSource(data);
  };
  xhr.onerror = () => {
    if (state.upload !== xhr) return;
    state.upload = null;
    el.uploading.hidden = true;
    showLoadError('Upload failed: cannot reach the server');
  };
  xhr.send(file);
}

function setUploadProgress(frac) {
  el.uploadFill.style.width = `${Math.round(frac * 100)}%`;
  el.uploadText.textContent = `Uploading ${Math.round(frac * 100)}%`;
}

// Called when the upload finishes: the preview keeps playing the object URL.
function attachSource(src) {
  state.source = src;
  state.fps = src.fps || state.fps;
  state.size = src.size || state.size;
  if (src.duration > 0) {
    state.duration = src.duration;
    state.outT = Math.min(state.outT, state.duration);
    if (state.outT - state.inT < MIN_LEN) { state.inT = 0; state.outT = state.duration; }
  }
  state.keyframes = null;
  state.kfLoading = false;
  render();
  requestPlan();
}

// ---------- rendering ----------

function render() {
  renderHeader();
  renderSelection();
  renderPlayhead();
  renderOptions();
  renderEstimate();
  renderJob();
}

function renderHeader() {
  const has = !!(state.source || state.name);
  el.fileinfo.hidden = !has;
  if (!has) return;
  el.filename.textContent = state.name;
  const s = state.source;
  const w = s ? s.width : video.videoWidth, h = s ? s.height : video.videoHeight;
  const parts = [];
  if (w && h) parts.push(`${w}×${h}`);
  if (s) parts.push(`${Number.isInteger(s.fps) ? s.fps : s.fps.toFixed(2)} fps`);
  if (state.duration) parts.push(fmtShort(state.duration));
  if (state.size) parts.push(fmtMB(state.size));
  if (s && s.videoCodec) parts.push(s.videoCodec);
  el.filemeta.textContent = parts.join(' · ');
  el.totTime.textContent = fmtTime(state.duration);
}

function pct(t) { return `${(t / (state.duration || 1)) * 100}%`; }

function showKeyframes() { return state.opts.preset === 'cut' && state.opts.cut === 'fast'; }

function snappedKeyframe() {
  if (!state.keyframes || !state.keyframes.length) return null;
  let kf = 0;
  for (const t of state.keyframes) { if (t <= state.inT + 0.002) kf = t; else break; }
  return kf;
}

function renderSelection() {
  el.dimL.style.width = pct(state.inT);
  el.dimR.style.left = pct(state.outT);
  el.selBody.style.left = pct(state.inT);
  el.selBody.style.width = pct(state.outT - state.inT);
  el.hIn.style.left = pct(state.inT);
  el.hOut.style.left = pct(state.outT);
  if (document.activeElement !== el.inInput) el.inInput.value = fmtTime(state.inT);
  if (document.activeElement !== el.outInput) el.outInput.value = fmtTime(state.outT);
  el.selLen.textContent = `${(state.outT - state.inT).toFixed(2)} s`;
  const kf = showKeyframes() ? snappedKeyframe() : null;
  const showSnap = kf != null && state.inT - kf > 0.02;
  el.snapMark.hidden = !showSnap;
  if (showSnap) {
    el.snapMark.style.left = pct(kf);
    el.snapMark.style.setProperty('--snap-w', `${((state.inT - kf) / state.duration) * el.track.clientWidth}px`);
  }
}

function renderPlayhead() {
  const t = video.currentTime || 0;
  el.playhead.style.left = pct(Math.min(t, state.duration));
  el.curTime.textContent = fmtTime(t);
}

function renderOptions() {
  const o = state.opts;
  for (const b of el.presets.children) b.setAttribute('aria-checked', String(b.dataset.preset === o.preset));
  el.customWrap.hidden = o.preset !== 'custom';
  if (document.activeElement !== el.targetMB) el.targetMB.value = o.targetMB;
  el.cutWrap.hidden = o.preset !== 'cut';
  const copyMode = state.plan ? state.plan.mode === 'copy' : showKeyframes();
  el.speedWrap.hidden = copyMode;
  const encoders = (state.info && state.info.encoders) || [];
  el.encoderWrap.hidden = encoders.length <= 1;
  el.optCut.value = o.cut;
  el.optResolution.value = o.resolution;
  el.optFps.value = o.fps;
  el.optAudio.value = o.audio;
  el.optSpeed.value = o.speed;
  el.optEncoder.value = o.encoder;
  if (showKeyframes()) ensureKeyframes();
  drawKeyframes();
  renderSelection(); // snap mark depends on the cut mode
}

function renderEstimate() {
  const box = el.estimate;
  box.textContent = '';
  const add = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; box.appendChild(s); };
  if (!state.source) {
    if (state.loadError && state.name) add(state.loadError, 'err');
    else if (state.upload) add('Uploading…');
    return;
  }
  if (state.planPending) return add('…');
  if (state.planError) return add(state.planError, 'err');
  if (!state.plan) return;
  add(state.plan.summary);
  for (const w of state.plan.warnings || []) add(w, 'warn');
}

function exportEnabled() {
  return !!(state.source && state.plan && !state.planPending && !state.planError && !jobActive());
}

function jobActive() {
  return !!(state.job && (state.job.status === 'queued' || state.job.status === 'running'));
}

function renderJob() {
  const job = state.job;
  const active = jobActive();
  el.exportBtn.hidden = active;
  el.exportBtn.disabled = !exportEnabled();
  el.progress.hidden = !active;
  el.cancelBtn.hidden = !active;
  if (active) {
    const p = job.progress || 0;
    el.progressFill.style.width = `${Math.round(p * 100)}%`;
    if (job.status === 'queued') el.progressText.textContent = 'Queued…';
    else {
      const bits = [`${Math.round(p * 100)}%`];
      if (job.passes > 1) bits.push(`pass ${job.pass || 1}/${job.passes}`);
      const eta = fmtEta(job.etaSeconds);
      if (eta) bits.push(eta);
      el.progressText.textContent = bits.join(' · ');
    }
  }
  const terminal = job && !active;
  el.resultRow.hidden = !terminal;
  if (!terminal) return;
  el.resultRow.className = `row result-row ${job.status}`;
  const done = job.status === 'done';
  el.revealBtn.hidden = !done;
  el.downloadBtn.hidden = !done;
  el.logDetails.hidden = !(job.status === 'error' && job.log);
  if (done) {
    el.resultText.textContent = ['Done', job.outputBytes != null ? fmtMB(job.outputBytes) : null, basename(job.outputPath)].filter(Boolean).join(' · ');
    el.downloadBtn.href = `/api/jobs/${job.id}/download`;
    el.downloadBtn.setAttribute('download', basename(job.outputPath) || 'export.mp4');
  } else if (job.status === 'error') {
    el.resultText.textContent = `Export failed: ${job.error || 'unknown error'}`;
    el.logPre.textContent = job.log || '';
  } else {
    el.resultText.textContent = 'Cancelled';
  }
}

// ---------- filmstrip + keyframes ----------

const once = (target, ev, ms) => new Promise((resolve) => {
  const done = () => { target.removeEventListener(ev, done); clearTimeout(tm); resolve(); };
  const tm = setTimeout(done, ms);
  target.addEventListener(ev, done);
});

async function startThumbs() {
  const gen = ++state.thumbGen;
  const hv = el.thumbVideo;
  state.thumbs = [];
  drawStrip();
  if (hv.readyState < 1) await once(hv, 'loadedmetadata', 15000);
  if (gen !== state.thumbGen || hv.readyState < 1) return;
  const dur = hv.duration && isFinite(hv.duration) ? hv.duration : state.duration;
  if (!dur) return;
  const n = clamp(Math.round(el.track.clientWidth / 80), 12, 32);
  const slots = new Array(n).fill(null);
  state.thumbs = slots;
  const th = Math.max(1, Math.round(160 * (hv.videoHeight || 9) / (hv.videoWidth || 16)));
  for (let i = 0; i < n; i++) {
    hv.currentTime = Math.min(dur - 0.05, (i + 0.5) * dur / n);
    await once(hv, 'seeked', 2000);
    if (gen !== state.thumbGen) return;
    if (hv.readyState < 2) continue;
    const c = document.createElement('canvas');
    c.width = 160; c.height = th;
    c.getContext('2d').drawImage(hv, 0, 0, c.width, c.height);
    slots[i] = c;
    drawStrip();
  }
}

function sizeCanvas(c) {
  const w = el.track.clientWidth, h = el.track.clientHeight, dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawStrip() {
  const { ctx, w, h } = sizeCanvas(el.strip);
  const n = state.thumbs.length;
  if (!n || !w) return;
  const sw = w / n;
  state.thumbs.forEach((t, i) => {
    if (!t) return;
    const da = sw / h, sa = t.width / t.height;
    let sx = 0, sy = 0, cw = t.width, ch = t.height;
    if (sa > da) { cw = t.height * da; sx = (t.width - cw) / 2; } else { ch = t.width / da; sy = (t.height - ch) / 2; }
    ctx.drawImage(t, sx, sy, cw, ch, Math.floor(i * sw), 0, Math.ceil(sw) + 1, h);
  });
}

function drawKeyframes() {
  const { ctx, w, h } = sizeCanvas(el.kfCanvas);
  if (!showKeyframes() || !state.keyframes || !state.duration) return;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (const t of state.keyframes) ctx.fillRect(Math.round((t / state.duration) * w), h - 5, 1, 5);
}

async function ensureKeyframes() {
  if (!state.source || state.keyframes || state.kfLoading) return;
  const id = state.source.id;
  state.kfLoading = true;
  try {
    const res = await fetch(`/api/sources/${id}/keyframes`);
    const data = await res.json();
    if (!state.source || state.source.id !== id) return;
    state.keyframes = res.ok && Array.isArray(data.times) ? data.times : [];
  } catch { if (state.source && state.source.id === id) state.keyframes = []; }
  finally { if (state.source && state.source.id === id) state.kfLoading = false; }
  drawKeyframes();
  renderSelection();
}

// ---------- playback ----------

let rafId = 0;

function seek(t) {
  if (!state.duration) return;
  video.currentTime = clamp(t, 0, state.duration);
  renderPlayhead();
}

function play() {
  if (!state.duration) return;
  if (video.currentTime >= state.outT - 0.001) video.currentTime = state.inT;
  video.play().catch(() => {});
}

function togglePlay() {
  if (video.paused) play(); else video.pause();
}

function tick() {
  if (video.paused) { rafId = 0; return; }
  if (video.currentTime >= state.outT) {
    video.pause();
    video.currentTime = state.outT;
  }
  renderPlayhead();
  rafId = requestAnimationFrame(tick);
}

function stepFrames(dir, seconds) {
  video.pause();
  const cur = video.currentTime;
  const f = state.fps || 30;
  seek(seconds ? cur + dir : (Math.round(cur * f) + dir) / f);
}

// ---------- selection ----------

function setIn(t) {
  t = clamp(round3(t), 0, Math.max(0, state.duration - MIN_LEN));
  if (t > state.outT - MIN_LEN) state.outT = state.duration;
  state.inT = t;
  renderSelection();
  requestPlan();
}

function setOut(t) {
  t = clamp(round3(t), Math.min(MIN_LEN, state.duration), state.duration);
  if (t < state.inT + MIN_LEN) state.inT = 0;
  state.outT = t;
  renderSelection();
  requestPlan();
}

function commitTimeInput(input, which) {
  const t = parseTime(input.value);
  if (t == null) { input.value = fmtTime(which === 'in' ? state.inT : state.outT); return; }
  if (which === 'in') setIn(t); else setOut(t);
  input.value = fmtTime(which === 'in' ? state.inT : state.outT);
}

function xToTime(clientX) {
  const r = el.track.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * state.duration;
}

function onTrackDown(e) {
  if (e.button !== 0 || !state.duration) return;
  const handle = e.target.closest('.handle');
  const kind = handle ? handle.dataset.handle : e.target.closest('.playhead') ? 'playhead' : e.target.closest('.selbody') ? 'body' : 'seek';
  state.drag = { kind, x0: e.clientX, in0: state.inT, out0: state.outT, moved: false, el: handle };
  el.track.setPointerCapture(e.pointerId);
  video.pause();
  if (handle) handle.classList.add('active');
  if (kind === 'seek' || kind === 'playhead') seek(xToTime(e.clientX));
  else if (kind === 'in') seek(state.inT);
  else if (kind === 'out') seek(state.outT);
  e.preventDefault();
}

function onTrackMove(e) {
  const d = state.drag;
  if (!d) return;
  const dx = e.clientX - d.x0;
  if (Math.abs(dx) > 3) d.moved = true;
  const t = xToTime(e.clientX);
  if (d.kind === 'seek' || d.kind === 'playhead') return seek(t);
  if (d.kind === 'in') { state.inT = round3(clamp(t, 0, state.outT - MIN_LEN)); seek(state.inT); }
  else if (d.kind === 'out') { state.outT = round3(clamp(t, state.inT + MIN_LEN, state.duration)); seek(state.outT); }
  else if (d.kind === 'body') {
    if (!d.moved) return;
    el.selBody.classList.add('grabbing');
    const len = d.out0 - d.in0;
    const r = el.track.getBoundingClientRect();
    const nin = round3(clamp(d.in0 + (dx / r.width) * state.duration, 0, state.duration - len));
    state.inT = nin;
    state.outT = round3(nin + len);
  }
  renderSelection();
  requestPlan();
}

function onTrackUp(e) {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  if (d.el) d.el.classList.remove('active');
  el.selBody.classList.remove('grabbing');
  if (d.kind === 'body' && !d.moved) seek(xToTime(e.clientX));
}

// ---------- plan ----------

let planTimer = 0;
let planAbort = null;

function exportRequest() {
  const o = state.opts;
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  const req = {
    sourceId: state.source.id, start: state.inT, end: state.outT, preset: o.preset, cut: o.cut,
    resolution: num(o.resolution), fps: num(o.fps), audio: o.audio, speed: o.speed, encoder: o.encoder,
  };
  if (o.preset === 'custom') req.targetMB = Number(o.targetMB) || 1;
  return req;
}

function requestPlan() {
  clearTimeout(planTimer);
  if (planAbort) { planAbort.abort(); planAbort = null; }
  if (!state.source) { state.plan = null; state.planError = null; state.planPending = false; renderEstimate(); renderJob(); return; }
  state.planPending = true;
  renderEstimate();
  renderJob();
  planTimer = setTimeout(async () => {
    const ac = planAbort = new AbortController();
    try {
      const res = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exportRequest()), signal: ac.signal });
      const data = await res.json().catch(() => ({}));
      if (ac !== planAbort) return;
      if (res.ok) { state.plan = data; state.planError = null; }
      else { state.plan = null; state.planError = data.error || `Plan failed (${res.status})`; }
    } catch {
      if (ac.signal.aborted) return;
      state.plan = null;
      state.planError = 'Cannot reach the server';
    }
    planAbort = null;
    state.planPending = false;
    renderEstimate();
    renderOptions();
    renderJob();
    if (state.exportWhenPlanned) { state.exportWhenPlanned = false; startExport(); }
  }, 150);
}

// ---------- export jobs ----------

function stopJob() {
  if (state.es) { state.es.close(); state.es = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = 0; }
}

async function startExport() {
  // Enter right after an edit lands inside the plan debounce: export as soon as the plan is back.
  if (state.source && state.planPending && !jobActive()) { state.exportWhenPlanned = true; return; }
  if (!exportEnabled()) return;
  stopJob();
  state.job = { id: null, status: 'queued', progress: 0 };
  renderJob();
  let data = {};
  try {
    const res = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exportRequest()) });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Export failed (${res.status})`);
  } catch (err) {
    state.job = { id: null, status: 'error', error: err.message };
    return renderJob();
  }
  state.job = { id: data.jobId, status: 'queued', progress: 0 };
  renderJob();
  listenJob(data.jobId);
}

function applyJob(job) {
  if (!state.job || state.job.id !== job.id) return;
  state.job = job;
  renderJob();
  if (!jobActive()) stopJob();
}

function listenJob(id) {
  let es;
  try { es = new EventSource(`/api/jobs/${id}/events`); } catch { return pollJob(id); }
  state.es = es;
  es.onmessage = (ev) => { try { applyJob(JSON.parse(ev.data)); } catch { /* ignore malformed */ } };
  es.onerror = () => {
    if (state.es !== es) return;
    es.close();
    state.es = null;
    if (jobActive()) pollJob(id);
  };
}

function pollJob(id) {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.ok) applyJob(await res.json());
      else if (res.status === 404) { stopJob(); state.job = { id, status: 'error', error: 'Job disappeared' }; renderJob(); }
    } catch { /* retry next tick */ }
  }, 500);
}

function cancelJob() {
  if (!jobActive() || !state.job.id) return;
  fetch(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => {});
}

// ---------- keyboard ----------

function onKey(e) {
  const t = e.target;
  const inField = t.matches && t.matches('input, select, textarea');
  if (e.key === 'Escape') {
    if (inField) t.blur(); else if (jobActive()) cancelJob();
    return;
  }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  const onButton = t.matches && t.matches('button, a, summary');
  if (!state.duration) return;
  switch (e.key) {
    case ' ': if (onButton) return; e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': setIn(video.currentTime); break;
    case 'o': case 'O': setOut(video.currentTime); break;
    case 'ArrowLeft': e.preventDefault(); stepFrames(-1, e.shiftKey); break;
    case 'ArrowRight': e.preventDefault(); stepFrames(1, e.shiftKey); break;
    case 'Home': e.preventDefault(); video.pause(); seek(state.inT); break;
    case 'End': e.preventDefault(); video.pause(); seek(state.outT); break;
    case 'Enter': if (onButton) return; startExport(); break;
    default: return;
  }
}

// ---------- wiring ----------

function bindOption(select, key) {
  select.addEventListener('change', () => {
    state.opts[key] = select.value;
    saveOpts();
    renderOptions();
    requestPlan();
  });
}

async function copyDocs() {
  const btn = el.copyDocsBtn;
  try {
    const res = await fetch('/api/docs');
    if (!res.ok) throw new Error();
    await navigator.clipboard.writeText(await res.text());
    btn.textContent = 'Copied';
  } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy agent instructions'; }, 1500);
}

function init() {
  loadOpts();

  el.openBtn.addEventListener('click', openDialog);
  el.openBtn2.addEventListener('click', openDialog);
  el.fileInput.addEventListener('change', () => { uploadFile(el.fileInput.files[0]); el.fileInput.value = ''; });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) el.app.classList.add('dragging'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.app.classList.remove('dragging'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.app.classList.remove('dragging');
    uploadFile(e.dataTransfer.files[0]);
  });

  video.addEventListener('click', togglePlay);
  video.addEventListener('play', () => { el.playBtn.classList.add('playing'); if (!rafId) rafId = requestAnimationFrame(tick); });
  video.addEventListener('pause', () => { el.playBtn.classList.remove('playing'); renderPlayhead(); });
  video.addEventListener('seeked', renderPlayhead);
  video.addEventListener('timeupdate', () => { if (video.paused) renderPlayhead(); });
  video.addEventListener('loadedmetadata', () => {
    if (!state.source && isFinite(video.duration)) { state.duration = video.duration; state.inT = 0; state.outT = video.duration; }
    render();
  });
  video.addEventListener('error', () => { if (state.name) { el.playerNote.textContent = 'Preview not available in this browser'; el.playerNote.hidden = false; } });
  el.playBtn.addEventListener('click', togglePlay);

  el.track.addEventListener('pointerdown', onTrackDown);
  el.track.addEventListener('pointermove', onTrackMove);
  el.track.addEventListener('pointerup', onTrackUp);
  el.track.addEventListener('pointercancel', onTrackUp);
  new ResizeObserver(() => { drawStrip(); drawKeyframes(); renderSelection(); }).observe(el.track);

  for (const [input, which] of [[el.inInput, 'in'], [el.outInput, 'out']]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commitTimeInput(input, which); input.blur(); }
      else if (e.key === 'Escape') { input.value = fmtTime(which === 'in' ? state.inT : state.outT); }
    });
    input.addEventListener('blur', () => commitTimeInput(input, which));
    input.addEventListener('focus', () => input.select());
  }
  el.setIn.addEventListener('click', () => setIn(video.currentTime));
  el.setOut.addEventListener('click', () => setOut(video.currentTime));

  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (!b) return;
    state.opts.preset = b.dataset.preset;
    saveOpts();
    renderOptions();
    requestPlan();
  });
  el.targetMB.addEventListener('input', () => {
    const v = Number(el.targetMB.value);
    if (v >= 1) { state.opts.targetMB = v; saveOpts(); requestPlan(); }
  });
  bindOption(el.optCut, 'cut');
  bindOption(el.optResolution, 'resolution');
  bindOption(el.optFps, 'fps');
  bindOption(el.optAudio, 'audio');
  bindOption(el.optSpeed, 'speed');
  bindOption(el.optEncoder, 'encoder');

  el.exportBtn.addEventListener('click', startExport);
  el.cancelBtn.addEventListener('click', cancelJob);
  el.revealBtn.addEventListener('click', () => { if (state.job && state.job.id) fetch(`/api/jobs/${state.job.id}/reveal`, { method: 'POST' }).catch(() => {}); });
  el.logDetails.addEventListener('toggle', () => { el.logDetails.querySelector('summary').textContent = el.logDetails.open ? 'Hide log' : 'Show log'; });
  el.copyDocsBtn.addEventListener('click', copyDocs);

  // Mouse clicks must not leave buttons focused, or Space would re-trigger them instead of toggling playback.
  document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail > 0) b.blur(); });
  window.addEventListener('keydown', onKey);

  render();

  fetch('/api/info').then((r) => r.json()).then((info) => {
    state.info = info;
    el.version.textContent = info.version ? `v${info.version}` : '';
    const encoders = info.encoders || [];
    for (const name of encoders) { const o = document.createElement('option'); o.value = name; o.textContent = name; el.optEncoder.appendChild(o); }
    if (!encoders.includes(state.opts.encoder)) state.opts.encoder = 'auto';
    renderOptions();
  }).catch(() => {});

  const path = new URLSearchParams(location.search).get('path');
  if (path) {
    history.replaceState(null, '', location.pathname);
    openPath(path);
  }
}

init();
