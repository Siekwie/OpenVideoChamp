// The sequence strip: one block per clip, markers between them for transitions, drag to reorder,
// and the music lane underneath.
import { $, h, clamp, fmtShort, fmtSec, sizeCanvas, drawCover } from './util.js';
import { state, on, source, clipSource, clipLength, clipOffsets, totalDuration, selectClip, select, moveClip, setTransition, isImage, canUndo, canRedo, undo, redo,
  DEFAULT_TRANSITION } from './state.js';
import { api } from './api.js';
import { thumbAt, seek } from './monitor.js';
import { transitionLabel } from './transitions.js';

const el = {};
for (const id of ['seqStrip', 'seqClips', 'seqAddBtn', 'musicLane', 'seqPlayhead', 'seqInfo', 'undoBtn', 'redoBtn']) el[id] = $(id);

let drag = null;
const handlers = { add: () => {}, addMusic: () => {} };

export function setSequenceHandlers(h2) { Object.assign(handlers, h2); }

function clipBlock(c, i) {
  const src = clipSource(c);
  const len = clipLength(c);
  const selected = state.selection?.kind === 'clip' && state.selection.index === i;
  const canvas = h('canvas', { class: 'clipthumb' });
  const badges = [];
  if (isImage(c)) badges.push(h('span', { class: 'badge', text: 'still' }));
  if (c.mute) badges.push(h('span', { class: 'badge', text: 'muted' }));
  else if (c.volume !== 1) badges.push(h('span', { class: 'badge', text: `${Math.round(c.volume * 100)}%` }));
  const block = h('div', {
    class: `clip${selected ? ' selected' : ''}${isImage(c) ? ' image' : ''}`,
    dataset: { index: i },
    style: { flexGrow: String(Math.max(0.5, len)) },
    title: `${src?.name || '?'} · ${fmtSec(len)}`,
  },
  canvas,
  h('div', { class: 'cliplabel' }, h('span', { class: 'clipname', text: src?.name || 'missing' }), h('span', { class: 'cliplen num', text: fmtSec(len, 1) })),
  badges.length ? h('div', { class: 'clipbadges' }, ...badges) : null);
  block._draw = () => drawClipThumb(canvas, c, src);
  return block;
}

function drawClipThumb(canvas, c, src) {
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  const ctx = sizeCanvas(canvas, w, hgt);
  if (!src) return;
  if (src.kind === 'image') {
    const img = imageCache(src);
    if (img.complete && img.naturalWidth) drawCover(ctx, img, 0, 0, w, hgt);
    else img.addEventListener('load', () => drawClipThumb(canvas, c, src), { once: true });
    return;
  }
  const n = Math.max(1, Math.floor(w / 56));
  const sw = w / n;
  for (let k = 0; k < n; k++) {
    const t = c.start + ((k + 0.5) / n) * (c.end - c.start);
    const img = thumbAt(src, t);
    if (img) drawCover(ctx, img, Math.floor(k * sw), 0, Math.ceil(sw) + 1, hgt);
  }
}

const images = new Map();
function imageCache(src) {
  if (!images.has(src.id)) { const img = new Image(); img.src = api.streamUrl(src.id); images.set(src.id, img); }
  return images.get(src.id);
}

function transitionMarker(t, i) {
  const selected = state.selection?.kind === 'transition' && state.selection.index === i;
  const cut = t.type === 'cut';
  return h('button', {
    type: 'button',
    class: `tr${cut ? ' cut' : ' active'}${selected ? ' selected' : ''}`,
    dataset: { index: i },
    title: cut ? 'Hard cut · click to choose a transition, double-click for a crossfade' : `${transitionLabel(t.type)} · ${fmtSec(t.duration, 1)}`,
    onclick: () => select({ kind: 'transition', index: i }),
    ondblclick: () => { if (cut) setTransition(i, { type: 'fade', duration: DEFAULT_TRANSITION }); },
  }, cut ? h('i') : h('span', { class: 'trlabel', text: `${transitionLabel(t.type)} ${t.duration.toFixed(1)}s` }));
}

// The music lane: how much of the video the track covers, and its mix at a glance.
function renderMusicLane() {
  const lane = el.musicLane, m = state.music, src = m && source(m.sourceId);
  lane.className = `musiclane${m ? '' : ' none'}${state.selection?.kind === 'music' ? ' selected' : ''}`;
  if (!m) {
    lane.title = 'Lay a music track under the whole sequence';
    lane.style.removeProperty('--covered');
    lane.replaceChildren(h('span', { class: 'musicname', text: '♪  Add music…' }));
    return;
  }
  const total = totalDuration();
  const left = src ? src.duration - m.start : 0;
  const short = left < total;
  lane.title = 'Music · click for volume, fades and mix';
  lane.style.setProperty('--covered', `${(m.loop || !short ? 1 : clamp(left / (total || 1), 0.04, 1)) * 100}%`);
  const meta = [`${Math.round(m.volume * 100)}%`, m.mode === 'replace' ? 'music only' : 'under the clips'];
  if (short) meta.push(m.loop ? 'looped' : `ends at ${fmtShort(left)}`);
  lane.replaceChildren(h('span', { class: 'musicname', text: `♪  ${src?.name || 'missing'}` }), h('span', { class: 'musicmeta num', text: meta.join(' · ') }));
}

export function renderSequence() {
  if (drag?.active) return; // rebuilt on drop
  const wrap = el.seqClips;
  wrap.textContent = '';
  state.clips.forEach((c, i) => {
    if (i > 0) wrap.append(transitionMarker(state.transitions[i - 1], i - 1));
    wrap.append(clipBlock(c, i));
  });
  for (const b of wrap.querySelectorAll('.clip')) b._draw();
  const total = totalDuration();
  const n = state.clips.length;
  const tr = state.transitions.filter((t) => t.type !== 'cut').length;
  const bits = [`${n} clip${n === 1 ? '' : 's'}`, fmtShort(total)];
  if (tr) bits.push(`${tr} transition${tr === 1 ? '' : 's'}`);
  if (state.music) bits.push('music');
  el.seqInfo.textContent = n ? bits.join(' · ') : '';
  el.undoBtn.disabled = !canUndo();
  el.redoBtn.disabled = !canRedo();
  renderMusicLane();
  renderSeqPlayhead();
}

function redrawThumbs() {
  for (const b of el.seqClips.querySelectorAll('.clip')) b._draw?.();
}

// ---------- preview playhead ----------

let lastTime = null;

function renderSeqPlayhead() {
  const ph = el.seqPlayhead;
  const show = state.monitorMode === 'preview' && state.preview && lastTime;
  ph.hidden = !show;
  if (!show) return;
  const { t } = lastTime;
  const offsets = clipOffsets();
  let i = offsets.findIndex((o, k) => t >= o.start && (k === offsets.length - 1 || t < offsets[k + 1].start));
  if (i < 0) i = t < 0 ? 0 : offsets.length - 1;
  const block = el.seqClips.querySelector(`.clip[data-index="${i}"]`);
  if (!block) return;
  const o = offsets[i];
  const frac = clamp((t - o.start) / Math.max(0.001, o.end - o.start), 0, 1);
  const r = block.getBoundingClientRect(), s = el.seqStrip.getBoundingClientRect();
  ph.style.left = `${r.left - s.left + frac * r.width}px`;
}

// ---------- pointer interaction: click to select/scrub, drag to reorder ----------

function onDown(e) {
  if (e.button !== 0) return;
  const block = e.target.closest('.clip');
  if (!block) return;
  drag = { from: Number(block.dataset.index), x0: e.clientX, y0: e.clientY, block, active: false, to: null };
  el.seqClips.setPointerCapture(e.pointerId);
}

function onMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.active) {
    if (Math.abs(dx) < 6 && Math.abs(e.clientY - drag.y0) < 6) return;
    drag.active = true;
    drag.block.classList.add('dragging');
    el.seqClips.classList.add('reordering');
  }
  drag.block.style.transform = `translateX(${dx}px)`;
  // target index: number of other blocks whose centre is left of the pointer
  const blocks = [...el.seqClips.querySelectorAll('.clip')].filter((b) => b !== drag.block);
  let to = 0;
  for (const b of blocks) { const r = b.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) to++; }
  drag.to = to;
  for (const b of el.seqClips.querySelectorAll('.clip')) b.classList.remove('drop-before', 'drop-after');
  if (blocks.length) {
    if (to < blocks.length) blocks[to].classList.add('drop-before');
    else blocks[blocks.length - 1].classList.add('drop-after');
  }
}

function onUp(e) {
  const d = drag;
  if (!d) return;
  drag = null;
  if (!d.active) {
    // plain click: select and scrub to the clicked moment of the clip
    const c = state.clips[d.from];
    selectClip(d.from);
    if (c && !isImage(c)) {
      const r = d.block.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      seek(c.start + frac * (c.end - c.start));
    }
    return;
  }
  d.block.classList.remove('dragging');
  d.block.style.transform = '';
  el.seqClips.classList.remove('reordering');
  for (const b of el.seqClips.querySelectorAll('.clip')) b.classList.remove('drop-before', 'drop-after');
  if (d.to != null && d.to !== d.from) moveClip(d.from, d.to);
  else renderSequence();
}

export function initSequence() {
  el.seqClips.addEventListener('pointerdown', onDown);
  el.seqClips.addEventListener('pointermove', onMove);
  el.seqClips.addEventListener('pointerup', onUp);
  el.seqClips.addEventListener('pointercancel', onUp);
  el.seqAddBtn.addEventListener('click', () => handlers.add(el.seqAddBtn));
  el.musicLane.addEventListener('click', () => {
    select({ kind: 'music' });
    if (!state.music) handlers.addMusic();
  });
  el.undoBtn.addEventListener('click', undo);
  el.redoBtn.addEventListener('click', redo);
  new ResizeObserver(() => { redrawThumbs(); renderSeqPlayhead(); }).observe(el.seqClips);

  on('sequence', renderSequence);
  on('sequence-live', () => { redrawThumbs(); });
  on('selection', renderSequence);
  on('sources', renderSequence);
  on('thumbs', redrawThumbs);
  on('monitor', renderSeqPlayhead);
  on('time', (info) => { lastTime = info.mode === 'preview' ? info : null; renderSeqPlayhead(); });
}
