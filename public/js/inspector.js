// Right-hand panel: the selected clip, transition or music track, and the settings of the whole video.
import { $, h, fmtTime, fmtSec, fmtShort, fmtFps, parseTime, clamp, round3, MIN_LEN } from './util.js';
import { state, on, source, clipSource, clipLength, clipSpan, isImage, maxTransition, checkpoint, afterEdit, edit, setClipRange, setTransition, setAllTransitions,
  setMusic, setSequenceField, removeClip, duplicateClip, moveClip, selectClip, totalDuration, cropRegion, panAt, setPanAt, canvasRatio,
  DEFAULT_TRANSITION, DEFAULT_MUSIC, MAX_FADE } from './state.js';
import { availableGroups } from './transitions.js';
import { LOOKS, KEEP_COLORS, lookName } from './looks.js';
import { api } from './api.js';
import { playheadTime } from './monitor.js';

const el = { itemPanel: $('itemPanel'), sequencePanel: $('sequencePanel') };
let handlers = { addMusic: () => {}, addSound: () => {}, montage: () => {}, montageStyle: () => {}, toast: () => {} };

export function setInspectorHandlers(h2) { handlers = { ...handlers, ...h2 }; }

// ---------- small field builders ----------

function field(label, control, { hint } = {}) {
  return h('label', { class: 'field' }, h('span', { class: 'fieldlabel', text: label }), control, hint ? h('span', { class: 'fieldhint', text: hint }) : null);
}

// A range + number pair that edits continuously but records one undo step per interaction.
function slider({ min, max, step, value, format, onLive, onCommit, disabled = false }) {
  const range = h('input', { type: 'range', min, max, step, value, disabled: disabled || null });
  const out = h('span', { class: 'sliderval num', text: format(value) });
  let armed = false;
  const arm = () => { if (!armed) { checkpoint(); armed = true; } };
  range.addEventListener('pointerdown', arm);
  range.addEventListener('keydown', arm);
  range.addEventListener('input', () => { arm(); const v = Number(range.value); out.textContent = format(v); onLive(v); });
  range.addEventListener('change', () => { armed = false; onCommit(Number(range.value)); });
  return h('div', { class: 'slider' }, range, out);
}

function seconds({ value, min = 0, max = MAX_FADE, step = 0.1, onChange }) {
  const input = h('input', { type: 'number', class: 'num', min, max, step, value: String(round3(value)) });
  input.addEventListener('change', () => {
    const v = clamp(Number(input.value) || 0, min, max);
    input.value = String(round3(v));
    onChange(v);
  });
  return h('span', { class: 'unit' }, input, 's');
}

function timeInput(value, onChange, { placeholder } = {}) {
  const input = h('input', { type: 'text', class: 'num', value: value == null ? '' : fmtTime(value), placeholder, spellcheck: 'false', autocomplete: 'off' });
  const commit = () => {
    if (input.value.trim() === '' && placeholder) return onChange(null);
    const t = parseTime(input.value);
    if (t != null) onChange(t); else input.value = value == null ? '' : fmtTime(value);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
  input.addEventListener('focus', () => input.select());
  return input;
}

// Segmented buttons: [[value, label, title?], ...]
function seg(options, current, onPick) {
  return h('div', { class: 'seg small' }, ...options.map(([value, label, title]) => h('button', {
    type: 'button', 'aria-checked': String(value === current), text: label, title, onclick: () => onPick(value),
  })));
}

// Collapsible sections remember whether they are open across re-renders.
const openSections = new Set(['hit']);
function remembered(details, name) {
  details.open = openSections.has(name);
  details.addEventListener('toggle', () => { if (details.open) openSections.add(name); else openSections.delete(name); });
  return details;
}

function section(name, title, summary, kids) {
  return remembered(h('details', { class: 'sect' },
    h('summary', {}, h('span', { class: 'secttitle', text: title }), h('span', { class: 'sectsum muted', text: summary || '' })),
    h('div', { class: 'sectbody' }, ...kids.filter(Boolean))), name);
}

const srcMeta = (s) => {
  if (!s) return 'missing source';
  if (s.kind === 'image') return `image · ${s.width}×${s.height}`;
  if (s.kind === 'audio') return `audio · ${fmtShort(s.duration)}`;
  return [`${s.width}×${s.height}`, `${fmtFps(s.fps)} fps`, fmtShort(s.duration), s.hasAudio ? null : 'no audio'].filter(Boolean).join(' · ');
};

// ---------- looks ----------

// Look values with defaults dropped (so a preset stays recognisable); null when nothing is left.
const LOOK_DEFAULTS = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, sharpen: 0, motionBlur: 0 };
function cleanLook(look) {
  if (!look) return null;
  const out = {};
  for (const [k, v] of Object.entries(look)) {
    if (k === 'tint') { if (v && v.amount > 0) out.tint = { color: v.color, amount: round3(v.amount) }; } else if (v !== LOOK_DEFAULTS[k]) out[k] = round3(v);
  }
  return Object.keys(out).length ? out : null;
}

function lookSummary(look) {
  const name = lookName(look);
  return name ? LOOKS[name].label : 'Custom';
}

// Preset picker + sliders for a look that lives at owner[key] (a clip, or the state for the whole video).
function lookEditor(owner, key, { inheritLabel }) {
  const look = owner[key];
  const current = lookName(look);
  const picker = h('select', {}, ...Object.entries(LOOKS).map(([name, { label }]) => h('option', { value: name, text: name === 'none' ? inheritLabel : label })),
    current ? null : h('option', { value: '', text: 'Custom' }));
  picker.value = current ?? '';
  picker.addEventListener('change', () => { if (picker.value) edit(() => { owner[key] = structuredClone(LOOKS[picker.value].look); }); });
  const live = (k, v) => { owner[key] = { ...(owner[key] || {}), [k]: v }; };
  const commit = () => { owner[key] = cleanLook(owner[key]); afterEdit(); };
  const L = { ...LOOK_DEFAULTS, ...(look || {}) };
  const pct = (v) => `${Math.round(v)}%`;
  const s = (label, k, min, max, toUi, fromUi, format) => field(label, slider({
    min, max, step: 1, value: Math.round(toUi(L[k])), format,
    onLive: (v) => live(k, fromUi(v)), onCommit: (v) => { live(k, fromUi(v)); commit(); },
  }));
  const tintOn = h('input', { type: 'checkbox', checked: L.tint ? true : null });
  const tintColor = h('input', { type: 'color', value: L.tint?.color || '#ff3cc8' });
  const setTint = (patch) => edit(() => { owner[key] = cleanLook({ ...(owner[key] || {}), tint: patch }); });
  tintOn.addEventListener('change', () => setTint(tintOn.checked ? { color: tintColor.value, amount: 0.3 } : null));
  tintColor.addEventListener('change', () => setTint({ color: tintColor.value, amount: owner[key]?.tint?.amount || 0.3 }));
  return [
    field('Look', picker),
    remembered(h('details', { class: 'subsect' }, h('summary', { text: 'Adjust' }),
      s('Brightness', 'brightness', -50, 50, (v) => v * 100, (v) => v / 100, (v) => `${v > 0 ? '+' : ''}${v}`),
      s('Contrast', 'contrast', 50, 200, (v) => v * 100, (v) => v / 100, pct),
      s('Saturation', 'saturation', 0, 250, (v) => v * 100, (v) => v / 100, pct),
      s('Hue', 'hue', -180, 180, (v) => v, (v) => v, (v) => `${v}°`),
      s('Sharpen', 'sharpen', 0, 150, (v) => v * 100, (v) => v / 100, pct),
      s('Motion blur', 'motionBlur', 0, 100, (v) => v * 100, (v) => v / 100, pct),
      h('div', { class: 'fieldrow tintrow' }, h('label', { class: 'check' }, tintOn, 'Tint'), tintColor,
        L.tint ? slider({
          min: 5, max: 100, step: 1, value: Math.round(L.tint.amount * 100), format: pct,
          onLive: (v) => { owner[key] = { ...owner[key], tint: { ...owner[key].tint, amount: v / 100 } }; },
          onCommit: (v) => { owner[key] = { ...owner[key], tint: { ...owner[key].tint, amount: v / 100 } }; commit(); },
        }) : null)), `adjust-${owner === state ? 'video' : 'clip'}`),
  ];
}

// ---------- clip ----------

// The playhead as a time inside clip c (its source time), or null when the monitor shows something else.
function playheadIn(c) {
  const t = playheadTime(c);
  return t == null ? null : clamp(t, c.start, c.end);
}

function speedSection(c) {
  const set = (v) => edit(() => { c.rate = clamp(round3(v), 0.1, 4); });
  const input = h('input', { type: 'number', class: 'num', min: 0.1, max: 4, step: 0.05, value: String(c.rate) });
  input.addEventListener('change', () => set(Number(input.value) || 1));
  return section('speed', 'Speed', c.rate === 1 ? 'normal' : `${c.rate}×`, [
    h('div', { class: 'fieldrow' }, seg([[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']], c.rate, set), h('span', { class: 'unit' }, input, '×')),
    h('p', { class: 'fieldhint', text: `Slow motion or sped up; the sound follows at the same pitch. In the video: ${fmtSec(clipLength(c), 2)}.` }),
  ]);
}

function hitSection(c) {
  const src = clipSource(c);
  const has = c.hit != null;
  const outside = has && (c.hit < c.start || c.hit > c.end);
  const find = async (button) => {
    button.disabled = true;
    button.textContent = 'Finding…';
    try {
      const r = await api.highlights(src.id, { start: c.start, end: c.end });
      if (r.best == null) handlers.toast('No clear highlight in this clip (no sudden flash or bang). Set it at the playhead instead.');
      else edit(() => { c.hit = r.best; if (!c.flash) c.flash = 0; });
    } catch (err) { handlers.toast(err.message, 'error'); }
    button.disabled = false;
    button.textContent = 'Find';
  };
  const findBtn = h('button', { type: 'button', class: 'small', text: 'Find', title: 'Detect the goal / explosion (a sudden bang and flash) in this clip' });
  findBtn.addEventListener('click', () => find(findBtn));
  const sound = c.sounds[0];
  const audio = [...state.sources.values()].filter((x) => x.hasAudio && x.kind !== 'video');
  const soundPick = h('select', {}, h('option', { value: '', text: 'None' }), ...audio.map((x) => h('option', { value: x.id, text: x.name })), h('option', { value: '__file', text: 'Sound file…' }));
  soundPick.value = sound?.sourceId || '';
  soundPick.addEventListener('change', () => {
    const v = soundPick.value;
    if (v === '__file') { soundPick.value = sound?.sourceId || ''; handlers.addSound((s) => edit(() => { c.sounds = [{ sourceId: s.id, at: null, volume: sound?.volume ?? 1 }]; })); return; }
    edit(() => { c.sounds = v ? [{ sourceId: v, at: null, volume: sound?.volume ?? 1 }] : []; });
  });
  const summary = has ? `${fmtTime(c.hit)}${c.flash ? ' · flash' : ''}${sound ? ' · sound' : ''}` : 'not set';
  return section('hit', 'Goal / hit', summary, [
    h('div', { class: 'fieldrow hitrow' },
      field('Hit at', timeInput(c.hit, (t) => edit(() => { c.hit = t == null ? null : clamp(round3(t), 0, src?.duration || t); if (c.hit == null) c.flash = 0; }), { placeholder: 'not set' })),
      h('div', { class: 'btnstack' },
        h('button', { type: 'button', class: 'small', text: 'At playhead', title: 'The hit is where the playhead is (H)', onclick: () => setHitAtPlayhead() }),
        findBtn)),
    outside ? h('p', { class: 'warn', text: 'The hit is outside the trimmed clip, so it does nothing.' }) : null,
    h('p', { class: 'fieldhint', text: 'The moment the clip builds up to: the goal, the explosion. Auto-edit lands it on a beat; the flash and the sound fire on it.' }),
    field('Flash', slider({
      min: 0, max: 100, step: 5, value: Math.round(c.flash * 100), format: (v) => (v ? `${v}%` : 'off'), disabled: !has,
      onLive: (v) => { c.flash = v / 100; }, onCommit: (v) => { c.flash = v / 100; afterEdit(); },
    })),
    h('div', { class: 'fieldrow' }, field('Sound on hit', soundPick),
      sound ? field('Volume', slider({
        min: 0, max: 200, step: 5, value: Math.round(sound.volume * 100), format: (v) => `${v}%`,
        onLive: (v) => { sound.volume = v / 100; }, onCommit: (v) => { sound.volume = v / 100; afterEdit(); },
      })) : null),
  ]);
}

function framingSection(c) {
  const region = cropRegion(c);
  const fit = c.fit || state.fit;
  const t = playheadIn(c) ?? c.start;
  const pos = panAt(c, t);
  const animated = c.pan.length >= 2;
  const setPos = (axis, v) => setPanAt(c, t, axis === 'x' ? v : pos.x, axis === 'y' ? v : pos.y);
  const posSlider = (axis, label, ends) => field(label, slider({
    min: 0, max: 100, step: 1, value: Math.round(pos[axis] * 100), format: (v) => (v === 50 ? 'centre' : v < 50 ? `${ends[0]} ${50 - v}` : `${ends[1]} ${v - 50}`),
    onLive: (v) => { setPos(axis, v / 100); emitLive(); }, onCommit: (v) => { setPos(axis, v / 100); afterEdit(); },
  }));
  const fitLabel = { fit: 'Fit', fill: 'Fill', blur: 'Blur' };
  const summary = [fitLabel[fit], c.zoom !== 1 ? `${Math.round(c.zoom * 100)}%` : null, animated ? `${c.pan.length} keyframes` : c.pan.length ? 'moved' : null].filter(Boolean).join(' · ');
  const kids = [
    field('Frame', seg([[null, `Default (${fitLabel[state.fit]})`], ['fill', 'Fill', 'Crop to fill the frame'], ['fit', 'Fit', 'Whole picture, black bars'], ['blur', 'Blur', 'Whole picture over a blurred copy']],
      c.fit, (v) => edit(() => { c.fit = v; }))),
    field('Zoom', slider({
      min: 100, max: 300, step: 5, value: Math.round(c.zoom * 100), format: (v) => `${v}%`,
      onLive: (v) => { c.zoom = v / 100; emitLive(); }, onCommit: (v) => { c.zoom = v / 100; afterEdit(); },
    })),
  ];
  if (!region) kids.push(h('p', { class: 'fieldhint', text: 'Pick a format for the whole video (below) to place the frame.' }));
  else if (region.roomX < 1 && region.roomY < 1) kids.push(h('p', { class: 'fieldhint', text: 'The whole picture is used; zoom in or choose Fill to move the frame.' }));
  else {
    if (region.roomX >= 1) kids.push(posSlider('x', 'Position', ['left', 'right']));
    if (region.roomY >= 1) kids.push(posSlider('y', 'Height', ['up', 'down']));
    kids.push(h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'small', text: animated ? 'Keyframe at playhead' : 'Animate…', title: 'Follow the action: set the frame at a few moments and it pans between them', onclick: () => edit(() => {
        if (!animated) {
          // Start and end keep the current position; dragging the frame anywhere in between adds keyframes.
          const p = panAt(c, c.start);
          c.pan = [{ t: round3(c.start), ...p }, { t: round3(c.end), ...p }];
          return;
        }
        const at = playheadIn(c);
        if (at != null) setPanAt(c, at, panAt(c, at).x, panAt(c, at).y);
      }) }),
      c.pan.length ? h('button', { type: 'button', class: 'small', text: animated ? 'Stop animating' : 'Centre', onclick: () => edit(() => { c.pan = []; }) }) : null));
    kids.push(h('p', { class: 'fieldhint', text: animated
      ? 'Move the playhead and drag the frame on the picture: each position becomes a keyframe, and the frame pans between them.'
      : 'Drag the frame on the picture to choose what stays in view.' }));
  }
  return section('framing', 'Framing', summary, kids);
}

function colourSection(c) {
  const k = c.keepColor;
  const keepOn = h('input', { type: 'checkbox', checked: k ? true : null });
  keepOn.addEventListener('change', () => edit(() => { c.keepColor = keepOn.checked ? { color: KEEP_COLORS[0].color, range: 0.3, softness: 0.1, from: null, until: c.hit ?? null } : null; }));
  const kids = [...lookEditor(c, 'look', { inheritLabel: 'Same as the whole video' }), h('label', { class: 'check' }, keepOn, 'Keep one colour, the rest grey')];
  if (k) {
    const color = h('input', { type: 'color', value: k.color });
    color.addEventListener('change', () => edit(() => { k.color = color.value; }));
    kids.push(
      h('div', { class: 'fieldrow swatches' }, ...KEEP_COLORS.map((p) => h('button', {
        type: 'button', class: `swatch${p.color === k.color ? ' on' : ''}`, title: p.label, style: { background: p.color }, onclick: () => edit(() => { k.color = p.color; }),
      })), color),
      field('Range', slider({
        min: 5, max: 80, step: 1, value: Math.round(k.range * 100), format: (v) => `${v}%`,
        onLive: (v) => { k.range = v / 100; }, onCommit: (v) => { k.range = v / 100; afterEdit(); },
      })),
      h('div', { class: 'fieldrow hitrow' },
        field('Colour returns at', timeInput(k.until, (t) => edit(() => { k.until = t == null ? null : round3(t); }), { placeholder: 'never' })),
        h('div', { class: 'btnstack' },
          h('button', { type: 'button', class: 'small', text: 'At playhead', onclick: () => { const t = playheadIn(c); if (t != null) edit(() => { k.until = round3(t); }); } }),
          c.hit != null ? h('button', { type: 'button', class: 'small', text: 'At hit', onclick: () => edit(() => { k.until = c.hit; }) }) : null)),
      h('p', { class: 'fieldhint', text: 'Shows in the draft preview (P), not in the picture above.' }));
  }
  const summary = [c.look ? lookSummary(c.look) : null, k ? 'one colour' : null].filter(Boolean).join(' · ') || 'as the video';
  return section('colour', 'Colour', summary, kids);
}

function clipPanel(i) {
  const c = state.clips[i];
  const src = clipSource(c);
  const image = isImage(c);
  const n = state.clips.length;
  const kids = [
    h('div', { class: 'panelhead' },
      h('h2', { text: `Clip ${i + 1} of ${n}` }),
      h('button', { type: 'button', class: 'small danger', text: 'Remove', title: 'Remove clip (Delete)', onclick: () => removeClip(i) })),
    h('div', { class: 'sourceline' }, h('span', { class: 'sourcename', text: src?.name || '?' }), h('span', { class: 'muted', text: srcMeta(src) })),
  ];
  if (image) {
    kids.push(field('Shown for', seconds({ value: clipSpan(c), min: 0.1, max: 600, step: 0.5, onChange: (v) => edit(() => setClipRange(c, 0, v)) })));
  } else {
    const row = h('div', { class: 'fieldrow' },
      field('In', timeInput(c.start, (t) => edit(() => setClipRange(c, Math.min(t, c.end - MIN_LEN), c.end)))),
      field('Out', timeInput(c.end, (t) => edit(() => setClipRange(c, c.start, Math.max(t, c.start + MIN_LEN))))),
      field('Length', h('span', { class: 'fieldvalue num', text: fmtSec(clipLength(c)) })));
    kids.push(row);
    kids.push(field('Volume', slider({
      min: 0, max: 200, step: 1, value: Math.round(c.volume * 100), format: (v) => `${v}%`,
      onLive: (v) => { c.volume = v / 100; }, onCommit: (v) => { c.volume = v / 100; afterEdit(); },
    }), { hint: src?.hasAudio === false ? 'This source has no audio.' : undefined }));
    const mute = h('input', { type: 'checkbox', checked: c.mute || null });
    mute.addEventListener('change', () => edit(() => { c.mute = mute.checked; }));
    kids.push(h('label', { class: 'check' }, mute, 'Mute this clip'));
    kids.push(speedSection(c));
  }
  kids.push(hitSection(c), framingSection(c), colourSection(c));
  kids.push(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'small', text: 'Duplicate', title: 'Duplicate this clip (D)', onclick: () => duplicateClip(i) }),
    h('button', { type: 'button', class: 'small', text: '← Earlier', disabled: i === 0 || null, title: 'Move earlier in the sequence (Alt+←)', onclick: () => moveClip(i, i - 1) }),
    h('button', { type: 'button', class: 'small', text: 'Later →', disabled: i === n - 1 || null, title: 'Move later in the sequence (Alt+→)', onclick: () => moveClip(i, i + 1) }),
    h('button', { type: 'button', class: 'small', text: 'Style to all', title: 'Give every clip this clip\'s speed, framing, colour and flash', onclick: () => styleToAll(c) })));
  return kids;
}

// Copies the look of one clip (not its range or hit) to every other clip.
function styleToAll(c) {
  edit(() => {
    for (const o of state.clips) {
      if (o === c) continue;
      if (!isImage(o)) o.rate = c.rate;
      Object.assign(o, structuredClone({ fit: c.fit, zoom: c.zoom, look: c.look, flash: o.hit != null ? c.flash : o.flash }));
      o.keepColor = c.keepColor ? { ...structuredClone(c.keepColor), until: c.keepColor.until != null && o.hit != null ? o.hit : null } : null;
    }
  });
}

export function setHitAtPlayhead() {
  const i = state.selection?.kind === 'clip' ? state.selection.index : -1;
  const c = state.clips[i];
  if (!c) return;
  const t = playheadTime(c);
  if (t != null) edit(() => { c.hit = round3(t); });
}

// While a slider is dragged: redraw the monitor overlay, not the panel (that would end the drag).
function emitLive() { liveHandler(); }
let liveHandler = () => {};
export function onInspectorLive(fn) { liveHandler = fn; }

// ---------- transition ----------

function transitionPanel(i) {
  const t = state.transitions[i];
  if (!t) return [];
  const max = maxTransition(i);
  const a = clipSource(state.clips[i]), b = clipSource(state.clips[i + 1]);
  const sel = h('select');
  sel.append(h('option', { value: 'cut', text: 'None (hard cut)' }));
  for (const [name, items] of availableGroups(state.info?.transitions)) {
    const g = h('optgroup', { label: name });
    for (const [type, label] of items) g.append(h('option', { value: type, text: label }));
    sel.append(g);
  }
  sel.value = t.type;
  sel.addEventListener('change', () => setTransition(i, { type: sel.value, duration: sel.value === 'cut' ? 0 : t.duration || DEFAULT_TRANSITION }));
  const kids = [
    h('div', { class: 'panelhead' },
      h('h2', { text: `Transition ${i + 1} → ${i + 2}` }),
      h('button', { type: 'button', class: 'small', text: 'Back to clip', onclick: () => selectClip(i) })),
    h('div', { class: 'sourceline' }, h('span', { class: 'muted', text: `${a?.name || '?'}  →  ${b?.name || '?'}` })),
    field('Type', sel),
  ];
  if (t.type !== 'cut') {
    if (max < 0.1) kids.push(h('p', { class: 'warn', text: 'The clips around this transition are too short for one.' }));
    else {
      kids.push(field('Duration', slider({
        min: 0.1, max: Math.max(0.1, Math.min(max, 5)), step: 0.1, value: clamp(t.duration, 0.1, max), format: (v) => fmtSec(v, 1),
        onLive: (v) => { t.duration = v; }, onCommit: (v) => { t.duration = v; afterEdit(); },
      }), { hint: `Longest that fits here: ${fmtSec(max, 1)}. Transitions overlap the two clips, so the sequence gets shorter.` }));
    }
  }
  kids.push(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'small', text: 'Apply to all transitions', onclick: () => setAllTransitions(t.type, t.duration) }),
    t.type !== 'cut' ? h('button', { type: 'button', class: 'small danger', text: 'Remove', onclick: () => setTransition(i, { type: 'cut', duration: 0 }) }) : null));
  return kids;
}

// ---------- music ----------

function musicPanel() {
  const m = state.music;
  const others = [...state.sources.values()].filter((x) => x.hasAudio && x.id !== m?.sourceId);
  const picker = h('select', { class: 'musicpick' }, h('option', { value: '', text: m ? 'Use another track…' : 'Choose a track…' }),
    h('option', { value: '__file', text: 'Music file…' }),
    ...others.map((x) => h('option', { value: x.id, text: `${x.name} (${fmtShort(x.duration)})` })));
  picker.addEventListener('change', () => {
    const v = picker.value;
    picker.value = '';
    if (v === '__file') handlers.addMusic();
    else if (v) setMusic({ ...DEFAULT_MUSIC, ...m, sourceId: v, start: 0 });
  });
  if (!m) {
    return [
      h('div', { class: 'panelhead' }, h('h2', { text: 'Music' })),
      h('p', { class: 'muted', text: 'Lay a track under the whole sequence. It is faded in and out, looped if it is too short, and mixed with the sound of the clips. Auto-edit cuts the clips to its beats.' }),
      picker,
    ];
  }
  const src = source(m.sourceId);
  const total = totalDuration();
  const patch = (p) => setMusic({ ...state.music, ...p });
  const mode = h('div', { class: 'seg small' },
    h('button', { type: 'button', 'aria-checked': String(m.mode === 'mix'), text: 'Under the clips', title: 'Mix with the sound of the clips', onclick: () => patch({ mode: 'mix' }) }),
    h('button', { type: 'button', 'aria-checked': String(m.mode === 'replace'), text: 'Music only', title: 'Drop the sound of the clips', onclick: () => patch({ mode: 'replace' }) }));
  const loop = h('input', { type: 'checkbox', checked: m.loop || null });
  loop.addEventListener('change', () => patch({ loop: loop.checked }));
  const left = src ? src.duration - m.start : 0;
  const beats = state.beats?.sourceId === m.sourceId ? state.beats : null;
  return [
    h('div', { class: 'panelhead' }, h('h2', { text: 'Music' }), h('button', { type: 'button', class: 'small danger', text: 'Remove', title: 'Remove the music (Delete)', onclick: () => setMusic(null) })),
    h('div', { class: 'sourceline' }, h('span', { class: 'sourcename', text: src?.name || '?' }),
      h('span', { class: 'muted', text: [srcMeta(src), beats?.bpm ? `${beats.bpm} BPM` : beats ? 'no clear beat' : 'finding the beat…'].join(' · ') })),
    field('Volume', slider({
      min: 0, max: 150, step: 1, value: Math.round(m.volume * 100), format: (v) => `${v}%`,
      onLive: (v) => { state.music.volume = v / 100; }, onCommit: (v) => { state.music.volume = v / 100; afterEdit(); },
    })),
    field('Mix', mode),
    h('div', { class: 'fieldrow' },
      field('Start in track', timeInput(m.start, (t) => patch({ start: clamp(t, 0, Math.max(0, (src?.duration || 0) - 0.1)) }))),
      field('Fade in', seconds({ value: m.fadeIn, onChange: (v) => patch({ fadeIn: v }) })),
      field('Fade out', seconds({ value: m.fadeOut, onChange: (v) => patch({ fadeOut: v }) }))),
    h('label', { class: 'check' }, loop, 'Loop if the track is shorter than the video'),
    !m.loop && left < total ? h('p', { class: 'warn', text: `The track ends ${fmtSec(total - left, 1)} before the video does. Tick Loop, or the rest is silent.` }) : null,
    state.output.audio === 'mute' ? h('p', { class: 'warn', text: 'Audio is set to None below, so the export will have no music.' }) : null,
    h('p', { class: 'fieldhint', text: 'Start the track at its drop: Auto-edit then lands the first goal right on it.' }),
    picker,
  ];
}

// ---------- whole video ----------

const ASPECT_LABELS = [['auto', 'Auto (follow the clips)'], ['9:16', 'Vertical 9:16 (TikTok, Shorts, Reels)'], ['16:9', 'Landscape 16:9'], ['1:1', 'Square 1:1'], ['4:5', 'Portrait 4:5']];

function sequencePanel() {
  if (!state.clips.length) return [];
  const normalize = h('input', { type: 'checkbox', checked: state.normalize || null });
  normalize.addEventListener('change', () => setSequenceField('normalize', normalize.checked));
  const aspect = h('select', {}, ...ASPECT_LABELS.map(([v, label]) => h('option', { value: v, text: label })));
  aspect.value = state.aspect;
  aspect.addEventListener('change', () => setSequenceField('aspect', aspect.value));
  const total = totalDuration();
  const ratio = canvasRatio();
  const tiktokAuto = state.aspect === 'auto' && state.output.preset === 'tiktok';
  return [
    h('div', { class: 'panelhead' }, h('h2', { text: 'Whole video' }), h('span', { class: 'muted num', text: fmtShort(total) })),
    h('div', { class: 'montagebox' },
      h('button', { type: 'button', class: 'primary-soft', text: 'Auto-edit montage…', title: 'Find the goal in every clip, trim around it and cut on the beats of the music', onclick: () => handlers.montage() }),
      h('button', { type: 'button', class: 'small', text: 'Vertical montage style', title: '9:16, filled frame, punchy colours, hard cuts, game audio under the music, TikTok export', onclick: () => handlers.montageStyle() })),
    field('Format', aspect, { hint: tiktokAuto ? 'The TikTok preset makes Auto vertical (9:16).' : ratio && ratio < 1 && state.fit === 'fit' ? 'Landscape clips get black bars in a vertical video; Fill or Blur below avoids them.' : undefined }),
    field('Clips fill the frame', seg([['fill', 'Fill', 'Crop to fill the frame (drag the frame on the picture)'], ['blur', 'Blur', 'Whole picture over a blurred copy'], ['fit', 'Fit', 'Whole picture with black bars']],
      state.fit, (v) => setSequenceField('fit', v))),
    ...lookEditor(state, 'look', { inheritLabel: 'None' }),
    h('div', { class: 'fieldrow' },
      field('Fade in', seconds({ value: state.fadeIn, max: Math.min(MAX_FADE, total), onChange: (v) => setSequenceField('fadeIn', v) })),
      field('Fade out', seconds({ value: state.fadeOut, max: Math.min(MAX_FADE, total), onChange: (v) => setSequenceField('fadeOut', v) }))),
    h('p', { class: 'fieldhint', text: 'From and to black; the sound fades with the picture.' }),
    h('label', { class: 'check' }, normalize, 'Normalize loudness'),
    h('p', { class: 'fieldhint', text: 'Evens the sound out to −14 LUFS, the level of other store videos. Exports a little slower.' }),
  ];
}

// ---------- render ----------

// Replacing the panel removes the focused input, whose blur fires a change handler that asks for another
// render while the first one is still running. Queue it instead of re-entering replaceChildren.
let rendering = false, queued = false;

export function renderInspector() {
  if (rendering) { queued = true; return; }
  rendering = true;
  try { renderNow(); } finally {
    rendering = false;
    if (queued) { queued = false; renderInspector(); }
  }
}

// The focused control as "which panel, which control of that kind", to find its replacement after a render
// (a slider moved with the arrow keys commits on every step, and must keep the keyboard focus).
const CONTROLS = 'input, select, button, summary';
function focusKey() {
  const a = document.activeElement;
  for (const panel of [el.itemPanel, el.sequencePanel]) {
    if (a && panel.contains(a)) return { panel, index: [...panel.querySelectorAll(CONTROLS)].indexOf(a), tag: a.tagName, type: a.type };
  }
  return null;
}
function restoreFocus(key) {
  // Not text fields: after Enter in one, the keyboard shortcuts should work again.
  if (!key || (key.tag === 'INPUT' && (key.type === 'text' || key.type === 'number'))) return;
  const next = key.panel.querySelectorAll(CONTROLS)[key.index];
  if (next && next.tagName === key.tag && next.type === key.type) next.focus({ preventScroll: true });
}

function renderNow() {
  const sel = state.selection;
  let kids;
  const scroll = el.itemPanel.parentElement.scrollTop;
  const focus = focusKey();
  if (!state.clips.length) kids = [h('div', { class: 'emptypanel' }, h('h2', { text: 'Nothing here yet' }), h('p', { class: 'muted', text: 'Add a video to start. Each clip you add appears in the sequence below; select one to trim it here.' }))];
  else if (sel?.kind === 'transition') kids = transitionPanel(sel.index);
  else if (sel?.kind === 'music') kids = musicPanel();
  else kids = clipPanel(sel?.index ?? 0);
  el.itemPanel.replaceChildren(...kids.filter(Boolean));
  el.sequencePanel.replaceChildren(...sequencePanel().filter(Boolean));
  el.sequencePanel.hidden = !state.clips.length;
  el.itemPanel.parentElement.scrollTop = scroll;
  restoreFocus(focus);
}

export function initInspector() {
  on('sequence', renderInspector);
  on('selection', renderInspector);
  on('sources', renderInspector);
  on('info', renderInspector);
  on('beats', () => { if (state.selection?.kind === 'music') renderInspector(); });
  // With Format on Auto the canvas shape comes from the plan; only a new shape changes the framing section.
  let shape = null;
  on('plan', () => { const r = canvasRatio(); if (r !== shape) { shape = r; renderInspector(); } });
  on('output', () => renderInspector());
}
