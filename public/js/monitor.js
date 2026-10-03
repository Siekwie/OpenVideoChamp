// The monitor (video/image/preview playback + transport) and the trim track of the selected clip.
import { $, clamp, round3, MIN_LEN, fmtTime, fmtSec, parseTime, once, sizeCanvas, drawCover } from './util.js';
import { api } from './api.js';
import { state, on, emit, source, clipSource, selectedClip, selectedIndex, selectClip, isImage, checkpoint, afterEdit, setClipRange, splitClip, copyCandidate, setMonitorMode, totalDuration } from './state.js';

const el = {};
for (const id of ['monitor', 'dropzone', 'dropError', 'video', 'image', 'thumbVideo', 'monitorBadge', 'monitorNote', 'backToSourceBtn', 'playBtn', 'curTime', 'totTime',
  'transportLabel', 'inout', 'inInput', 'outInput', 'setIn', 'setOut', 'splitBtn', 'selLen', 'trim', 'track', 'strip', 'kfCanvas', 'dimL', 'dimR', 'selBody',
  'snapMark', 'hIn', 'hOut', 'playhead', 'trackNote']) el[id] = $(id);
const video = el.video;

let loadedUrl = null;      // what the <video> currently has
let shownSourceId = null;  // the source shown in source mode
let rafId = 0;
let drag = null;

// ---------- what is on screen ----------

// The clip the monitor shows: the selected one, or the clip before a selected transition.
export function monitorIndex() {
  const s = state.selection;
  if (!s) return -1;
  return s.kind === 'clip' ? s.index : Math.min(s.index, state.clips.length - 1);
}
export function currentClip() { return state.clips[monitorIndex()] || null; }

function previewActive() { return state.monitorMode === 'preview' && state.preview && !state.preview.stale; }

// Source-time bounds of playback in source mode.
function bounds() {
  const c = currentClip();
  if (state.monitorMode === 'preview') return { start: 0, end: state.preview?.duration || video.duration || 0 };
  if (!c) return { start: 0, end: 0 };
  return { start: c.start, end: c.end };
}

function setVideoSrc(url) {
  if (loadedUrl === url) return false;
  loadedUrl = url;
  video.pause();
  video.src = url;
  return true;
}

export function renderMonitor() {
  const c = currentClip();
  const src = clipSource(c);
  const atTransition = state.selection?.kind === 'transition';
  const hasClips = state.clips.length > 0;
  el.dropzone.hidden = hasClips;
  el.monitorNote.hidden = true;
  if (!hasClips) {
    video.hidden = true; el.image.hidden = true; el.monitorBadge.hidden = true; el.backToSourceBtn.hidden = true;
    setVideoSrc('');
    shownSourceId = null;
    renderTrack();
    renderTransport();
    return;
  }
  if (state.monitorMode === 'preview' && state.preview) {
    el.image.hidden = true;
    video.hidden = false;
    const changed = setVideoSrc(state.preview.url);
    if (changed) video.currentTime = 0;
    shownSourceId = null;
    el.monitorBadge.hidden = false;
    el.monitorBadge.textContent = state.preview.stale ? 'Draft preview · out of date' : 'Draft preview';
    el.monitorBadge.className = `monitorbadge ${state.preview.stale ? 'stale' : ''}`;
    el.backToSourceBtn.hidden = false;
  } else {
    el.backToSourceBtn.hidden = true;
    el.monitorBadge.hidden = !c || state.clips.length < 2;
    if (c) el.monitorBadge.textContent = atTransition ? `End of clip ${monitorIndex() + 1} · transition` : `Clip ${monitorIndex() + 1} of ${state.clips.length}`;
    el.monitorBadge.className = 'monitorbadge';
    if (src && src.kind === 'image') {
      video.hidden = true;
      setVideoSrc('');
      el.image.hidden = false;
      if (el.image.dataset.sourceId !== src.id) { el.image.src = api.streamUrl(src.id); el.image.dataset.sourceId = src.id; }
      shownSourceId = src.id;
    } else if (src) {
      el.image.hidden = true;
      video.hidden = false;
      const changed = setVideoSrc(api.streamUrl(src.id)) || shownSourceId !== src.id;
      shownSourceId = src.id;
      const t = video.currentTime;
      if (atTransition) seek(Math.max(c.start, c.end - 1 / (src.fps || 30))); // the last frame before the cut, not the (black) end
      else if (changed || t < c.start - 0.001 || t > c.end + 0.001) seek(c.start);
    }
  }
  renderTrack();
  renderTransport();
}

// ---------- transport ----------

function renderTransport() {
  const c = currentClip();
  const preview = state.monitorMode === 'preview' && state.preview;
  const image = isImage(c);
  el.playBtn.disabled = !c || (image && !preview);
  const total = preview ? (state.preview.duration || 0) : image ? c.end - c.start : clipSource(c)?.duration || 0;
  el.totTime.textContent = fmtTime(total);
  el.transportLabel.textContent = preview ? 'sequence time' : image ? 'still image' : 'source time';
  el.inout.hidden = !c || preview || image || state.selection?.kind !== 'clip';
  el.splitBtn.disabled = !c || image;
  renderTime();
}

export function renderTime() {
  const preview = state.monitorMode === 'preview' && state.preview;
  const t = video.hidden ? 0 : video.currentTime || 0;
  el.curTime.textContent = fmtTime(t);
  if (preview) emit('time', { mode: 'preview', t, total: state.preview.duration || video.duration || totalDuration() });
  else {
    const src = source(shownSourceId);
    const dur = src?.duration || 0;
    el.playhead.style.left = `${(dur ? clamp(t, 0, dur) / dur : 0) * 100}%`;
    el.playhead.hidden = !dur;
  }
}

export function seek(t) {
  const src = state.monitorMode === 'preview' ? null : source(shownSourceId);
  const max = state.monitorMode === 'preview' ? (state.preview?.duration || video.duration || 0) : src?.duration || 0;
  if (!max) return;
  video.currentTime = clamp(t, 0, max);
  renderTime();
}

export function play() {
  if (video.hidden || !video.src) return;
  const b = bounds();
  if (video.currentTime >= b.end - 0.001 || video.currentTime < b.start - 0.001) video.currentTime = b.start;
  video.play().catch(() => {});
}

export function togglePlay() {
  if (video.paused) play(); else video.pause();
}

function tick() {
  if (video.paused) { rafId = 0; return; }
  const b = bounds();
  if (state.monitorMode !== 'preview' && video.currentTime >= b.end) {
    video.pause();
    video.currentTime = b.end;
  }
  renderTime();
  rafId = requestAnimationFrame(tick);
}

export function stepFrames(dir, seconds) {
  video.pause();
  const cur = video.currentTime;
  const fps = (state.monitorMode === 'preview' ? state.plan?.fps : source(shownSourceId)?.fps) || 30;
  seek(seconds ? cur + dir : (Math.round(cur * fps) + dir) / fps);
}

export function jumpTo(which) {
  const b = bounds();
  video.pause();
  seek(which === 'in' ? b.start : b.end);
}

// ---------- in / out editing ----------

export function setIn(t) {
  const c = selectedClip();
  if (!c || isImage(c)) return;
  checkpoint();
  let end = c.end;
  if (t > end - MIN_LEN) end = clipSource(c).duration;
  setClipRange(c, t, end);
  afterEdit();
}

export function setOut(t) {
  const c = selectedClip();
  if (!c || isImage(c)) return;
  checkpoint();
  let start = c.start;
  if (t < start + MIN_LEN) start = 0;
  setClipRange(c, start, t);
  afterEdit();
}

export function splitAtPlayhead() {
  const i = selectedIndex();
  if (i < 0 || state.monitorMode === 'preview') return false;
  return splitClip(i, video.currentTime);
}

function commitTimeInput(input, which) {
  const c = selectedClip();
  if (!c) return;
  const t = parseTime(input.value);
  if (t == null) { input.value = fmtTime(which === 'in' ? c.start : c.end); return; }
  if (which === 'in') setIn(t); else setOut(t);
  input.value = fmtTime(which === 'in' ? c.start : c.end);
}

// ---------- trim track ----------

function showKeyframes() {
  return copyCandidate() && state.output.cut === 'fast' && state.output.preset === 'cut';
}

function snappedKeyframe(src, t) {
  if (!src?.keyframes?.length) return null;
  let kf = 0;
  for (const k of src.keyframes) { if (k <= t + 0.002) kf = k; else break; }
  return kf;
}

export function renderTrack() {
  const c = currentClip();
  const src = clipSource(c);
  const preview = state.monitorMode === 'preview' && state.preview;
  const image = src?.kind === 'image';
  const show = !!c && !preview && !image;
  el.track.hidden = !show;
  el.trackNote.hidden = show || !c;
  if (!show) {
    if (preview) el.trackNote.textContent = 'Playing the draft preview of the whole sequence. Click a clip below to go back to editing it.';
    else if (image) el.trackNote.textContent = `Still image, shown for ${fmtSec(c.end - c.start, 1)}. Change the duration in the panel on the right.`;
    return;
  }
  const dur = src.duration || 1;
  const pct = (t) => `${(t / dur) * 100}%`;
  el.dimL.style.width = pct(c.start);
  el.dimR.style.left = pct(c.end);
  el.selBody.style.left = pct(c.start);
  el.selBody.style.width = pct(c.end - c.start);
  el.hIn.style.left = pct(c.start);
  el.hOut.style.left = pct(c.end);
  if (document.activeElement !== el.inInput) el.inInput.value = fmtTime(c.start);
  if (document.activeElement !== el.outInput) el.outInput.value = fmtTime(c.end);
  el.selLen.textContent = fmtSec(c.end - c.start);
  const kf = showKeyframes() ? snappedKeyframe(src, c.start) : null;
  const showSnap = kf != null && c.start - kf > 0.02;
  el.snapMark.hidden = !showSnap;
  if (showSnap) {
    el.snapMark.style.left = pct(kf);
    el.snapMark.style.setProperty('--snap-w', `${((c.start - kf) / dur) * el.track.clientWidth}px`);
  }
  if (showKeyframes()) ensureKeyframes(src);
  drawStrip(src);
  drawKeyframes(src);
  renderTime();
}

function drawStrip(src) {
  const w = el.track.clientWidth, h = el.track.clientHeight;
  const ctx = sizeCanvas(el.strip, w, h);
  if (!src?.thumbs?.length || !w) return;

  const n = src.thumbs.length;
  const sw = w / n;
  src.thumbs.forEach((t, i) => { if (t) drawCover(ctx, t, Math.floor(i * sw), 0, Math.ceil(sw) + 1, h); });
}

function drawKeyframes(src) {
  const w = el.track.clientWidth, h = el.track.clientHeight;
  const ctx = sizeCanvas(el.kfCanvas, w, h);
  if (!showKeyframes() || !src?.keyframes || !src.duration) return;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (const t of src.keyframes) ctx.fillRect(Math.round((t / src.duration) * w), h - 5, 1, 5);
}

async function ensureKeyframes(src) {
  if (!src || src.keyframes || src.kfLoading || src.kind !== 'video') return;
  src.kfLoading = true;
  try {
    const data = await api.keyframes(src.id);
    src.keyframes = Array.isArray(data.times) ? data.times : [];
  } catch { src.keyframes = []; } finally { src.kfLoading = false; }
  if (clipSource(currentClip())?.id === src.id) renderTrack();
}

function xToTime(clientX) {
  const r = el.track.getBoundingClientRect();
  const src = clipSource(currentClip());
  return clamp((clientX - r.left) / r.width, 0, 1) * (src?.duration || 0);
}

function onTrackDown(e) {
  const c = currentClip();
  if (e.button !== 0 || !c) return;
  if (state.selection?.kind !== 'clip') selectClip(monitorIndex());
  const handle = e.target.closest('.handle');
  const kind = handle ? handle.dataset.handle : e.target.closest('.playhead') ? 'playhead' : e.target.closest('.selbody') ? 'body' : 'seek';
  drag = { kind, x0: e.clientX, in0: c.start, out0: c.end, moved: false, el: handle, edited: false };
  el.track.setPointerCapture(e.pointerId);
  video.pause();
  if (handle) handle.classList.add('active');
  if (kind === 'seek' || kind === 'playhead') seek(xToTime(e.clientX));
  else if (kind === 'in') seek(c.start);
  else if (kind === 'out') seek(c.end);
  e.preventDefault();
}

function onTrackMove(e) {
  const d = drag;
  const c = selectedClip();
  if (!d || !c) return;
  const dx = e.clientX - d.x0;
  if (Math.abs(dx) > 3) d.moved = true;
  const t = xToTime(e.clientX);
  if (d.kind === 'seek' || d.kind === 'playhead') return seek(t);
  if (!d.edited) { checkpoint(); d.edited = true; }
  const src = clipSource(c);
  if (d.kind === 'in') { setClipRange(c, Math.min(t, c.end - MIN_LEN), c.end); seek(c.start); }
  else if (d.kind === 'out') { setClipRange(c, c.start, Math.max(t, c.start + MIN_LEN)); seek(c.end); }
  else if (d.kind === 'body') {
    if (!d.moved) return;
    el.selBody.classList.add('grabbing');
    const len = d.out0 - d.in0;
    const r = el.track.getBoundingClientRect();
    const nin = round3(clamp(d.in0 + (dx / r.width) * src.duration, 0, src.duration - len));
    setClipRange(c, nin, nin + len);
  }
  renderTrack();
  emit('sequence-live');
}

function onTrackUp(e) {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.el) d.el.classList.remove('active');
  el.selBody.classList.remove('grabbing');
  if (d.kind === 'body' && !d.moved) seek(xToTime(e.clientX));
  if (d.edited) afterEdit();
}

// ---------- thumbnails (per source, generated once, in the background) ----------

const thumbQueue = [];
let thumbBusy = false;

export function requestThumbs(src) {
  if (!src || src.kind !== 'video' || src.thumbs || thumbQueue.includes(src)) return;
  thumbQueue.push(src);
  runThumbQueue();
}

async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    // the source shown right now first
    const shownIdx = thumbQueue.findIndex((s) => s.id === shownSourceId);
    const src = thumbQueue.splice(shownIdx >= 0 ? shownIdx : 0, 1)[0];
    if (state.sources.has(src.id)) await generateThumbs(src);
  }
  thumbBusy = false;
}

async function generateThumbs(src) {
  const hv = el.thumbVideo;
  hv.src = api.streamUrl(src.id);
  if (hv.readyState < 1) await once(hv, 'loadedmetadata', 15000);
  if (hv.readyState < 1 || !state.sources.has(src.id)) { src.thumbs = []; return; }
  const dur = hv.duration && isFinite(hv.duration) ? hv.duration : src.duration;
  if (!dur) { src.thumbs = []; return; }
  const n = clamp(Math.round(dur / 2), 12, 40);
  src.thumbs = new Array(n).fill(null);
  src.thumbTimes = src.thumbs.map((_, i) => (i + 0.5) * dur / n);
  const th = Math.max(1, Math.round(160 * (hv.videoHeight || 9) / (hv.videoWidth || 16)));
  for (let i = 0; i < n; i++) {
    hv.currentTime = Math.min(dur - 0.05, src.thumbTimes[i]);
    await once(hv, 'seeked', 2000);
    if (!state.sources.has(src.id)) return;
    if (hv.readyState < 2) continue;
    const c = document.createElement('canvas');
    c.width = 160; c.height = th;
    c.getContext('2d').drawImage(hv, 0, 0, c.width, c.height);
    src.thumbs[i] = c;
    if (i % 4 === 3 || i === n - 1) emit('thumbs', src.id);
  }
  emit('thumbs', src.id);
}

// Nearest thumbnail of a source for time t (or null while it is still being generated).
export function thumbAt(src, t) {
  if (!src?.thumbs?.length) return null;
  const n = src.thumbs.length;
  const i = clamp(Math.floor((t / (src.duration || 1)) * n), 0, n - 1);
  return src.thumbs[i] || src.thumbs.find((x) => x) || null;
}

// ---------- wiring ----------

export function initMonitor() {
  video.addEventListener('click', togglePlay);
  video.addEventListener('play', () => { el.playBtn.classList.add('playing'); if (!rafId) rafId = requestAnimationFrame(tick); });
  video.addEventListener('pause', () => { el.playBtn.classList.remove('playing'); renderTime(); });
  video.addEventListener('seeked', renderTime);
  video.addEventListener('timeupdate', () => { if (video.paused) renderTime(); });
  video.addEventListener('loadedmetadata', () => {
    if (state.monitorMode === 'preview' && state.preview && isFinite(video.duration)) state.preview.duration = video.duration;
    renderTransport();
  });
  video.addEventListener('error', () => {
    if (!video.hidden && video.src) { el.monitorNote.textContent = 'Preview not available in this browser (the export still works)'; el.monitorNote.hidden = false; }
  });
  el.playBtn.addEventListener('click', togglePlay);
  el.backToSourceBtn.addEventListener('click', () => setMonitorMode('source'));

  el.track.addEventListener('pointerdown', onTrackDown);
  el.track.addEventListener('pointermove', onTrackMove);
  el.track.addEventListener('pointerup', onTrackUp);
  el.track.addEventListener('pointercancel', onTrackUp);
  new ResizeObserver(() => renderTrack()).observe(el.track);

  for (const [input, which] of [[el.inInput, 'in'], [el.outInput, 'out']]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commitTimeInput(input, which); input.blur(); }
      else if (e.key === 'Escape') { const c = selectedClip(); if (c) input.value = fmtTime(which === 'in' ? c.start : c.end); }
    });
    input.addEventListener('blur', () => commitTimeInput(input, which));
    input.addEventListener('focus', () => input.select());
  }
  el.setIn.addEventListener('click', () => setIn(video.currentTime));
  el.setOut.addEventListener('click', () => setOut(video.currentTime));
  el.splitBtn.addEventListener('click', splitAtPlayhead);

  on('selection', renderMonitor);
  on('monitor', renderMonitor);
  on('sequence', renderMonitor);
  on('output', renderTrack);
  on('sources', () => { for (const s of state.sources.values()) requestThumbs(s); });
  on('thumbs', (id) => { if (clipSource(currentClip())?.id === id) renderTrack(); });
}
