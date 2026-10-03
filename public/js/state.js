// Application state, the sequence model and its edit operations (with undo), and a tiny event bus.
import { clamp, round3, MIN_LEN } from './util.js';

export const DEFAULT_IMAGE_SECONDS = 4;
export const DEFAULT_TRANSITION = 0.5;
export const DEFAULT_MUSIC = { start: 0, volume: 0.5, fadeIn: 1, fadeOut: 2, loop: true, mode: 'mix' };
export const MAX_FADE = 30;
export const OUTPUT_VALUES = {
  preset: ['cut', 'discord', 'discord50', 'discord500', 'steam', 'custom'],
  cut: ['fast', 'precise'],
  resolution: ['auto', 'source', '1080', '720', '480', '360'],
  fps: ['auto', 'source', '60', '30'],
  audio: ['keep', 'mute'],
  speed: ['fast', 'balanced', 'best'],
};

export const state = {
  info: null,
  sources: new Map(),          // id -> Source (+ thumbs: [canvas|null], thumbTimes: [s])
  clips: [],                   // { id, sourceId, start, end, volume, mute }
  transitions: [],             // { type, duration }  (clips.length - 1 entries)
  fadeIn: 0,
  fadeOut: 0,
  music: null,                 // { sourceId, start, volume, fadeIn, fadeOut, loop, mode }
  normalize: false,
  output: { preset: 'steam', targetMB: 10, cut: 'fast', resolution: 'auto', fps: 'auto', audio: 'keep', speed: 'balanced', encoder: 'auto' },
  projectName: null,           // set by an opened project; otherwise the first clip's name is used
  revision: 0,                 // counts edits, so a finished preview render knows whether it is already out of date
  selection: null,             // { kind: 'clip' | 'transition', index } or { kind: 'music' }
  plan: null, planError: null, planPending: false,
  job: null,                   // export job (Job JSON, or a local stub)
  previewJob: null,            // preview render job
  preview: null,               // { jobId, url, duration, stale }
  monitorMode: 'source',       // 'source' | 'preview'
};

// ---------- event bus ----------

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) fn(payload);
}

// ---------- history (undo / redo) ----------

const SNAPSHOT_KEYS = ['clips', 'transitions', 'fadeIn', 'fadeOut', 'music', 'normalize'];
const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify(Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, state[k]])));
function restore(snap) {
  Object.assign(state, JSON.parse(snap));
  afterEdit({ structural: true });
}
export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }
export function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
export function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// Call before a mutation (or at the start of a drag) so it can be undone as one step.
export function checkpoint() {
  const snap = snapshot();
  if (undoStack.at(-1) === snap) return;
  undoStack.push(snap);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

// `edit(fn)` = checkpoint + mutate + notify. Drags call checkpoint() once, mutate, then afterEdit().
export function edit(fn, opts) {
  checkpoint();
  fn();
  afterEdit(opts);
}

export function afterEdit({ structural = false } = {}) {
  normalizeSequence();
  fixSelection();
  state.revision++;
  if (state.preview) state.preview.stale = true;
  emit('sequence', { structural });
}

// ---------- derived values ----------

let nextId = 1;
export const newId = () => `c${Date.now().toString(36)}${(nextId++).toString(36)}`;
export const source = (id) => state.sources.get(id) || null;
export const clipSource = (clip) => (clip ? source(clip.sourceId) : null);
export const clipLength = (clip) => (clip ? Math.max(0, clip.end - clip.start) : 0);
export const isImage = (clip) => clipSource(clip)?.kind === 'image';
export const selectedClip = () => (state.selection?.kind === 'clip' ? state.clips[state.selection.index] || null : null);
export const selectedIndex = () => (state.selection?.kind === 'clip' ? state.selection.index : -1);

export function totalDuration() {
  const clips = state.clips.reduce((s, c) => s + clipLength(c), 0);
  const tr = state.transitions.reduce((s, t) => s + (t.type === 'cut' ? 0 : t.duration), 0);
  return Math.max(0, round3(clips - tr));
}

// Where each clip sits on the output timeline: [{ start, end }] (transitions overlap neighbours).
export function clipOffsets() {
  const out = [];
  let acc = 0;
  state.clips.forEach((c, i) => {
    const before = i > 0 && state.transitions[i - 1].type !== 'cut' ? state.transitions[i - 1].duration : 0;
    const start = acc - before;
    const end = start + clipLength(c);
    out.push({ start, end });
    acc = end;
  });
  return out;
}

// Largest transition that fits between clips i and i+1 given the other transitions around them.
export function maxTransition(i) {
  const a = state.clips[i], b = state.clips[i + 1];
  if (!a || !b) return 0;
  const beforeA = i > 0 && state.transitions[i - 1].type !== 'cut' ? state.transitions[i - 1].duration : 0;
  const afterB = i + 1 < state.transitions.length && state.transitions[i + 1].type !== 'cut' ? state.transitions[i + 1].duration : 0;
  return Math.max(0, round3(Math.min(clipLength(a) - beforeA, clipLength(b) - afterB)));
}

// Keeps transitions/fades consistent with clip lengths after any edit.
export function normalizeSequence() {
  while (state.transitions.length > Math.max(0, state.clips.length - 1)) state.transitions.pop();
  while (state.transitions.length < Math.max(0, state.clips.length - 1)) state.transitions.push({ type: 'cut', duration: 0 });
  for (let pass = 0; pass < 2; pass++) {
    state.transitions.forEach((t, i) => {
      if (t.type === 'cut') { t.duration = 0; return; }
      const max = maxTransition(i);
      if (max < 0.1) { t.type = 'cut'; t.duration = 0; } else if (t.duration > max) t.duration = round3(max);
    });
  }
  if (state.music && !state.sources.has(state.music.sourceId)) state.music = null;
  // A pair of fades can never be longer than the video; shrink both in proportion.
  const total = totalDuration();
  for (const fades of [state, state.music]) {
    if (!fades || fades.fadeIn + fades.fadeOut <= total) continue;
    const scale = total / (fades.fadeIn + fades.fadeOut);
    fades.fadeIn = Math.floor(fades.fadeIn * scale * 1000) / 1000;
    fades.fadeOut = Math.floor(fades.fadeOut * scale * 1000) / 1000;
  }
}

// Something is always selected while there are clips, and the selection always points at something that exists.
function fixSelection() {
  const s = state.selection;
  const first = state.clips.length ? { kind: 'clip', index: 0 } : null;
  if (!s || !first) { state.selection = first; return; }
  if (s.kind === 'music') return;
  const max = s.kind === 'clip' ? state.clips.length : state.transitions.length;
  if (!max) state.selection = first;
  else if (s.index >= max) s.index = max - 1;
}

// ---------- sources ----------

export function addSource(src) {
  const existing = state.sources.get(src.id);
  if (existing) return existing;
  const rec = { ...src, thumbs: null, thumbTimes: null };
  state.sources.set(src.id, rec);
  emit('sources');
  return rec;
}

// ---------- selection ----------

export function select(sel) {
  const same = JSON.stringify(sel) === JSON.stringify(state.selection);
  state.selection = sel;
  if (sel && state.monitorMode === 'preview' && sel.kind === 'clip') setMonitorMode('source');
  emit('selection', { same });
}

export function selectClip(index) {
  select(index >= 0 && index < state.clips.length ? { kind: 'clip', index } : null);
}

export function setMonitorMode(mode) {
  if (state.monitorMode === mode) return;
  state.monitorMode = mode;
  emit('monitor');
}

// ---------- clip operations ----------

function makeClip(src, seconds) {
  if (src.kind === 'image') return { id: newId(), sourceId: src.id, start: 0, end: seconds ?? DEFAULT_IMAGE_SECONDS, volume: 1, mute: false };
  return { id: newId(), sourceId: src.id, start: 0, end: src.duration, volume: 1, mute: false };
}

// Inserts a clip covering the whole source after the selected clip (or at the end); returns its index.
// `seconds` is how long a still image is shown.
export function addClip(src, { seconds } = {}) {
  if (src.kind === 'audio') return -1;
  let index = -1;
  edit(() => {
    const clip = makeClip(src, seconds);
    index = selectedIndex() >= 0 ? selectedIndex() + 1 : state.clips.length;
    state.clips.splice(index, 0, clip);
    if (state.clips.length > 1) state.transitions.splice(Math.max(0, index - 1), 0, { type: 'cut', duration: 0 });
  }, { structural: true });
  selectClip(index);
  return index;
}

export function removeClip(index) {
  if (index < 0 || index >= state.clips.length) return;
  edit(() => {
    state.clips.splice(index, 1);
    // drop the transition that followed the clip (or the one before it for the last clip)
    if (state.transitions.length) state.transitions.splice(Math.min(index, state.transitions.length - 1), 1);
  }, { structural: true });
  selectClip(Math.min(index, state.clips.length - 1));
}

export function moveClip(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.clips.length || to >= state.clips.length) return;
  edit(() => {
    const [c] = state.clips.splice(from, 1);
    state.clips.splice(to, 0, c);
  }, { structural: true });
  selectClip(to);
}

export function duplicateClip(index) {
  const c = state.clips[index];
  if (!c) return;
  edit(() => {
    state.clips.splice(index + 1, 0, { ...c, id: newId() });
    state.transitions.splice(index, 0, { type: 'cut', duration: 0 });
  }, { structural: true });
  selectClip(index + 1);
}

// Splits clip `index` at source time `t`; both halves keep volume/mute, the cut between them is a hard cut.
export function splitClip(index, t) {
  const c = state.clips[index];
  if (!c || isImage(c)) return false;
  t = round3(t);
  if (t < c.start + MIN_LEN || t > c.end - MIN_LEN) return false;
  edit(() => {
    const second = { ...c, id: newId(), start: t };
    c.end = t;
    state.clips.splice(index + 1, 0, second);
    state.transitions.splice(index, 0, { type: 'cut', duration: 0 });
  }, { structural: true });
  selectClip(index + 1);
  return true;
}

// Trim handles call these continuously during a drag (after one checkpoint()).
export function setClipRange(clip, start, end) {
  const src = clipSource(clip);
  if (!src) return;
  if (src.kind === 'image') {
    clip.start = 0;
    clip.end = clamp(round3(end), 0.1, 600);
  } else {
    start = clamp(round3(start), 0, Math.max(0, src.duration - MIN_LEN));
    end = clamp(round3(end), Math.min(MIN_LEN, src.duration), src.duration);
    if (end - start < MIN_LEN) end = Math.min(src.duration, start + MIN_LEN);
    clip.start = start;
    clip.end = end;
  }
}

export function setTransition(index, patch) {
  const t = state.transitions[index];
  if (!t) return;
  edit(() => {
    Object.assign(t, patch);
    if (t.type !== 'cut' && !(t.duration > 0)) t.duration = DEFAULT_TRANSITION;
  });
}

export function setAllTransitions(type, duration) {
  edit(() => { for (const t of state.transitions) { t.type = type; t.duration = type === 'cut' ? 0 : duration; } });
}

export function setMusic(music) {
  edit(() => { state.music = music; });
}

export function setSequenceField(key, value) {
  edit(() => { state[key] = value; });
}

export function clearSequence() {
  edit(() => { state.clips = []; state.transitions = []; state.music = null; state.fadeIn = 0; state.fadeOut = 0; state.normalize = false; }, { structural: true });
  select(null);
}

// ---------- output options ----------

export function loadOutputOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem('ovc.output') || '{}');
    for (const [k, allowed] of Object.entries(OUTPUT_VALUES)) if (allowed.includes(String(saved[k]))) state.output[k] = saved[k];
    if (typeof saved.encoder === 'string') state.output.encoder = saved.encoder;
    if (Number(saved.targetMB) >= 1) state.output.targetMB = Number(saved.targetMB);
  } catch { /* storage unavailable */ }
}

export function setOutput(patch) {
  // The draft preview only depends on one output option: whether there is sound at all.
  if (state.preview && 'audio' in patch && patch.audio !== state.output.audio) state.preview.stale = true;
  Object.assign(state.output, patch);
  try { localStorage.setItem('ovc.output', JSON.stringify(state.output)); } catch { /* ignore */ }
  emit('output');
}

// ---------- the request the API wants ----------

export function exportRequest(extra = {}) {
  const o = state.output;
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  const req = {
    clips: state.clips.map((c) => ({ sourceId: c.sourceId, start: c.start, end: c.end, volume: c.volume, mute: c.mute })),
    transitions: state.transitions.map((t) => ({ type: t.type, duration: t.duration })),
    fadeIn: state.fadeIn, fadeOut: state.fadeOut, normalize: state.normalize,
    music: state.music ? { ...state.music } : null,
    preset: o.preset, cut: o.cut, resolution: num(o.resolution), fps: num(o.fps), audio: o.audio, speed: o.speed, encoder: o.encoder,
    ...extra,
  };
  if (o.preset === 'custom') req.targetMB = Number(o.targetMB) || 1;
  return req;
}

// Is the sequence a plain single range that could be stream-copied? (controls the fast/precise option)
export function copyCandidate() {
  const [c] = state.clips;
  return state.clips.length === 1 && !isImage(c) && c.volume === 1 && !state.music && !state.fadeIn && !state.fadeOut && !state.normalize;
}

export const jobActive = (job) => !!(job && (job.status === 'queued' || job.status === 'running'));
export const anyJobActive = () => jobActive(state.job) || jobActive(state.previewJob);
