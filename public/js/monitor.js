// The monitor (video/image/preview playback + transport) and the trim track of the selected clip.
import { $, h, clamp, round3, MIN_LEN, fmtTime, fmtSec, once, sizeCanvas, drawCover } from './util.js';
import { api } from './api.js';
import { state, on, emit, source, clipSource, selectedClip, selectedIndex, selectClip, isImage, checkpoint, afterEdit, edit, setClipRange, splitClip, copyCandidate, setMonitorMode, totalDuration,
  cropRegion, panAt, setPanAt, clipRate } from './state.js';

const el = {};
for (const id of ['dropzone', 'video', 'image', 'thumbVideo', 'monitorBadge', 'monitorNote', 'backToSourceBtn', 'playBtn', 'curTime', 'totTime',
  'transportLabel', 'setIn', 'setOut', 'splitBtn', 'track', 'strip', 'kfCanvas', 'dimL', 'dimR', 'selBody',
  'snapMark', 'hIn', 'hOut', 'playhead', 'trackNote', 'trackMarks', 'cropBox', 'cropFrame', 'cropLabel']) el[id] = $(id);
const video = el.video;

let loadedUrl = null;      // what the <video> currently has
let shownSourceId = null;  // the source shown in source mode
let lastIndex = 0;         // the clip that stays on screen while the music is selected
let rafId = 0;
let drag = null;

// ---------- what is on screen ----------

// The clip the monitor shows: the selected one, the clip before a selected transition, or
// (with the music selected) whatever was showing before.
export function monitorIndex() {
  const s = state.selection;
  if (s && s.kind !== 'music') lastIndex = s.index;
  return Math.min(lastIndex, state.clips.length - 1);
}
export function currentClip() { return state.clips[monitorIndex()] || null; }

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
  const preview = state.monitorMode === 'preview';
  video.playbackRate = preview || !c ? 1 : clipRate(c);
  const filter = preview ? '' : cssFilter(c);
  video.style.filter = el.image.style.filter = filter;
  renderTrack();
  renderTransport();
  renderCrop();
}

// ---------- live look and reframing on the source picture ----------

// The clip's look and the whole video's as a CSS filter: close enough to judge a grade while editing
// (tint, sharpening, motion blur, the flash and selective colour show in the draft preview).
function cssFilter(c) {
  const parts = [];
  for (const look of [c?.look, state.look]) {
    if (!look) continue;
    if (look.brightness) parts.push(`brightness(${1 + look.brightness})`);
    if (look.contrast != null && look.contrast !== 1) parts.push(`contrast(${look.contrast})`);
    if (look.saturation != null && look.saturation !== 1) parts.push(`saturate(${look.saturation})`);
    if (look.hue) parts.push(`hue-rotate(${look.hue}deg)`);
  }
  return parts.join(' ');
}

// The playhead as a source time of clip c, or null when the monitor is not showing c's source.
export function playheadTime(c) {
  if (!c || state.monitorMode === 'preview' || isImage(c) || shownSourceId !== c.sourceId || video.hidden) return null;
  return video.currentTime;
}

// Where the media is drawn inside the monitor (object-fit: contain).
function mediaRect(src) {
  const box = (video.hidden ? el.image : video).getBoundingClientRect(), mon = el.cropBox.parentElement.getBoundingClientRect();
  const scale = Math.min(box.width / src.width, box.height / src.height);
  const w = src.width * scale, hgt = src.height * scale;
  return { left: box.left - mon.left + (box.width - w) / 2, top: box.top - mon.top + (box.height - hgt) / 2, width: w, height: hgt, scale };
}

// The frame that will be in the video: everything outside it is dimmed, and it can be dragged.
export function renderCrop() {
  const c = currentClip();
  const region = c && state.monitorMode !== 'preview' ? cropRegion(c) : null;
  const show = !!region && !region.full && state.selection?.kind === 'clip';
  el.cropBox.hidden = !show;
  if (!show) return;
  const src = clipSource(c);
  const r = mediaRect(src);
  Object.assign(el.cropBox.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const t = isImage(c) ? c.start : clampTime(c, video.currentTime);
  const pos = cropDrag ? cropDrag.pos : panAt(c, t);
  Object.assign(el.cropFrame.style, {
    left: `${(pos.x * region.roomX / src.width) * 100}%`, top: `${(pos.y * region.roomY / src.height) * 100}%`,
    width: `${(region.w / src.width) * 100}%`, height: `${(region.h / src.height) * 100}%`,
  });
  el.cropFrame.classList.toggle('fixed', region.roomX < 1 && region.roomY < 1);
  const keyed = c.pan.length >= 2 && c.pan.some((k) => Math.abs(k.t - t) < 0.02);
  el.cropLabel.textContent = c.pan.length >= 2 ? (keyed ? 'keyframe' : 'animated · drag to add a keyframe') : '';
}

const clampTime = (c, t) => clamp(t, c.start, c.end);
let cropDrag = null;

function onCropDown(e) {
  const c = currentClip();
  const region = c && cropRegion(c);
  if (e.button !== 0 || !region) return;
  if (state.selection?.kind !== 'clip') selectClip(monitorIndex());
  video.pause();
  const t = isImage(c) ? c.start : clampTime(c, video.currentTime);
  cropDrag = { c, t, x0: e.clientX, y0: e.clientY, start: panAt(c, t), pos: panAt(c, t), region, scale: mediaRect(clipSource(c)).scale, edited: false };
  el.cropFrame.setPointerCapture(e.pointerId);
  el.cropFrame.classList.add('dragging');
  e.preventDefault();
  e.stopPropagation();
}

function onCropMove(e) {
  const d = cropDrag;
  if (!d) return;
  const dx = (e.clientX - d.x0) / d.scale, dy = (e.clientY - d.y0) / d.scale;
  d.pos = {
    x: d.region.roomX >= 1 ? clamp(d.start.x + dx / d.region.roomX, 0, 1) : d.start.x,
    y: d.region.roomY >= 1 ? clamp(d.start.y + dy / d.region.roomY, 0, 1) : d.start.y,
  };
  if (!d.edited) { checkpoint(); d.edited = true; }
  setPanAt(d.c, d.t, d.pos.x, d.pos.y);
  renderCrop();
}

function onCropUp() {
  const d = cropDrag;
  if (!d) return;
  cropDrag = null;
  el.cropFrame.classList.remove('dragging');
  if (d.edited) afterEdit();
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
  el.setIn.disabled = el.setOut.disabled = el.splitBtn.disabled = !c || !!preview || image || state.selection?.kind !== 'clip';
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
    if (currentClip()?.pan.length >= 2) renderCrop(); // an animated frame moves with the playhead
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

// The selected clip, when the playhead is a position inside its source (not a still, not the draft preview).
function markable() {
  const c = selectedClip();
  return c && !isImage(c) && state.monitorMode !== 'preview' ? c : null;
}

// An in point past the out point (or the reverse) moves the other end out of the way, to the source's edge.
export function setInAtPlayhead() {
  const c = markable(), t = video.currentTime;
  if (c) edit(() => setClipRange(c, t, t > c.end - MIN_LEN ? clipSource(c).duration : c.end));
}

export function setOutAtPlayhead() {
  const c = markable(), t = video.currentTime;
  if (c) edit(() => setClipRange(c, t < c.start + MIN_LEN ? 0 : c.start, t));
}

export function splitAtPlayhead() {
  return markable() ? splitClip(selectedIndex(), video.currentTime) : false;
}

// Plays the draft preview from the top (the monitor has just been switched to it).
export function playPreview() {
  if (state.monitorMode !== 'preview' || !state.preview) return;
  if (video.readyState > 0) video.currentTime = 0;
  video.play().catch(() => {});
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
    else if (image) el.trackNote.textContent = `Still image, shown for ${fmtSec(c.end - c.start, 1)}. Change how long in the panel on the right.`;
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
  const kf = showKeyframes() ? snappedKeyframe(src, c.start) : null;
  const showSnap = kf != null && c.start - kf > 0.02;
  el.snapMark.hidden = !showSnap;
  if (showSnap) {
    el.snapMark.style.left = pct(kf);
    el.snapMark.style.setProperty('--snap-w', `${((c.start - kf) / dur) * el.track.clientWidth}px`);
  }
  if (showKeyframes()) ensureKeyframes(src);
  renderMarks(c, src);
  drawStrip(src);
  drawKeyframes(src);
  renderTime();
}

// The hit, the pan keyframes and where the colour returns, on the trim track.
function renderMarks(c, src) {
  const dur = src.duration || 1;
  const pct = (t) => `${(clamp(t, 0, dur) / dur) * 100}%`;
  const marks = [];
  if (c.hit != null) marks.push(h('div', { class: 'mark hit', style: { left: pct(c.hit) }, title: `Hit ${fmtTime(c.hit)}` }, h('span', { text: c.flash ? 'hit ✦' : 'hit' })));
  if (c.pan.length >= 2) for (const k of c.pan) marks.push(h('div', { class: 'mark key', style: { left: pct(k.t) }, title: `Frame keyframe ${fmtTime(k.t)}` }));
  if (c.keepColor?.until != null) marks.push(h('div', { class: 'mark colour', style: { left: pct(c.keepColor.until) }, title: `Colour returns ${fmtTime(c.keepColor.until)}` }));
  el.trackMarks.replaceChildren(...marks);
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

  el.cropFrame.addEventListener('pointerdown', onCropDown);
  el.cropFrame.addEventListener('pointermove', onCropMove);
  el.cropFrame.addEventListener('pointerup', onCropUp);
  el.cropFrame.addEventListener('pointercancel', onCropUp);
  new ResizeObserver(() => renderCrop()).observe(el.cropBox.parentElement);
  video.addEventListener('loadeddata', renderCrop);
  el.image.addEventListener('load', renderCrop);

  el.setIn.addEventListener('click', setInAtPlayhead);
  el.setOut.addEventListener('click', setOutAtPlayhead);
  el.splitBtn.addEventListener('click', splitAtPlayhead);

  on('selection', renderMonitor);
  on('monitor', renderMonitor);
  on('sequence', renderMonitor);
  on('output', () => { renderTrack(); renderCrop(); });
  on('plan', renderCrop); // with Format on Auto, the canvas shape comes from the plan
  on('sequence-live', renderCrop);
  on('sources', () => { for (const s of state.sources.values()) requestThumbs(s); });
  on('thumbs', (id) => { if (clipSource(currentClip())?.id === id) renderTrack(); });
}
