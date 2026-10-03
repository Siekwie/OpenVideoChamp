// Right-hand panel: the selected clip or transition, and the sequence-wide audio/fade settings.
import { $, h, fmtTime, fmtSec, fmtShort, fmtFps, parseTime, clamp, round3 } from './util.js';
import { state, on, source, clipSource, clipLength, selectedIndex, isImage, maxTransition, checkpoint, afterEdit, edit, setClipRange, setTransition, setAllTransitions,
  setMusic, setSequenceField, removeClip, duplicateClip, moveClip, select, selectClip, totalDuration, DEFAULT_TRANSITION, MAX_FADE } from './state.js';
import { availableGroups } from './transitions.js';
import { splitAtPlayhead } from './monitor.js';

const el = { itemPanel: $('itemPanel'), sequencePanel: $('sequencePanel') };
let handlers = { addMusic: () => {} };

export function setInspectorHandlers(h2) { handlers = { ...handlers, ...h2 }; }

// ---------- small field builders ----------

function field(label, control, { hint } = {}) {
  return h('label', { class: 'field' }, h('span', { class: 'fieldlabel', text: label }), control, hint ? h('span', { class: 'fieldhint', text: hint }) : null);
}

// A range + number pair that edits continuously but records one undo step per interaction.
function slider({ min, max, step, value, format, onLive, onCommit }) {
  const range = h('input', { type: 'range', min, max, step, value });
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

function timeInput(value, onChange) {
  const input = h('input', { type: 'text', class: 'num', value: fmtTime(value), spellcheck: 'false', autocomplete: 'off' });
  const commit = () => { const t = parseTime(input.value); if (t != null) onChange(t); else input.value = fmtTime(value); };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
  input.addEventListener('focus', () => input.select());
  return input;
}

const srcMeta = (s) => {
  if (!s) return 'missing source';
  if (s.kind === 'image') return `image · ${s.width}×${s.height}`;
  if (s.kind === 'audio') return `audio · ${fmtShort(s.duration)}`;
  return [`${s.width}×${s.height}`, `${fmtFps(s.fps)} fps`, fmtShort(s.duration), s.hasAudio ? null : 'no audio'].filter(Boolean).join(' · ');
};

// ---------- clip ----------

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
    kids.push(field('Shown for', seconds({ value: clipLength(c), min: 0.1, max: 600, step: 0.5, onChange: (v) => edit(() => setClipRange(c, 0, v)) })));
  } else {
    const row = h('div', { class: 'fieldrow' },
      field('In', timeInput(c.start, (t) => edit(() => setClipRange(c, Math.min(t, c.end - 0.101), c.end)))),
      field('Out', timeInput(c.end, (t) => edit(() => setClipRange(c, c.start, Math.max(t, c.start + 0.101))))),
      field('Length', h('span', { class: 'fieldvalue num', text: fmtSec(clipLength(c)) })));
    kids.push(row);
    kids.push(field('Volume', slider({
      min: 0, max: 200, step: 1, value: Math.round(c.volume * 100), format: (v) => `${v}%`,
      onLive: (v) => { c.volume = v / 100; }, onCommit: (v) => { c.volume = v / 100; afterEdit(); },
    }), { hint: src?.hasAudio === false ? 'This source has no audio.' : undefined }));
    const mute = h('input', { type: 'checkbox', checked: c.mute || null });
    mute.addEventListener('change', () => edit(() => { c.mute = mute.checked; }));
    kids.push(h('label', { class: 'check' }, mute, 'Mute this clip'));
  }
  kids.push(h('div', { class: 'actions' },
    !image ? h('button', { type: 'button', class: 'small', text: 'Split at playhead', title: 'S', onclick: () => splitAtPlayhead() }) : null,
    h('button', { type: 'button', class: 'small', text: 'Duplicate', title: 'D', onclick: () => duplicateClip(i) }),
    h('button', { type: 'button', class: 'small', text: '← Earlier', disabled: i === 0 || null, title: 'Alt+←', onclick: () => moveClip(i, i - 1) }),
    h('button', { type: 'button', class: 'small', text: 'Later →', disabled: i === n - 1 || null, title: 'Alt+→', onclick: () => moveClip(i, i + 1) })));
  return kids;
}

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

// ---------- sequence-wide ----------

function musicBlock() {
  const m = state.music;
  const musicSources = [...state.sources.values()].filter((s) => s.hasAudio && s.id !== m?.sourceId);
  const picker = h('select', { class: 'musicpick' }, h('option', { value: '', text: m ? 'Replace with…' : 'Choose a track…' }),
    h('option', { value: '__file', text: 'Music file…' }),
    ...musicSources.map((s) => h('option', { value: s.id, text: `${s.name} (${fmtShort(s.duration)})` })));
  picker.addEventListener('change', () => {
    const v = picker.value;
    picker.value = '';
    if (v === '__file') handlers.addMusic();
    else if (v) setMusic({ sourceId: v, start: 0, volume: m?.volume ?? 0.5, fadeIn: m?.fadeIn ?? 1, fadeOut: m?.fadeOut ?? 2, loop: m?.loop ?? true, mode: m?.mode ?? 'mix' });
  });
  if (!m) {
    return [h('div', { class: 'subhead' }, h('h3', { text: 'Music' })),
      h('p', { class: 'muted small', text: 'Lay a track under the whole sequence. It is faded, looped if too short and mixed with the clip audio.' }),
      picker];
  }
  const src = source(m.sourceId);
  const total = totalDuration();
  const patch = (p) => setMusic({ ...state.music, ...p });
  const mode = h('div', { class: 'seg small' },
    h('button', { type: 'button', 'aria-checked': String(m.mode === 'mix'), text: 'Under the clips', title: 'Mix with the clip audio', onclick: () => patch({ mode: 'mix' }) }),
    h('button', { type: 'button', 'aria-checked': String(m.mode === 'replace'), text: 'Music only', title: 'Drop all clip audio', onclick: () => patch({ mode: 'replace' }) }));
  const loop = h('input', { type: 'checkbox', checked: m.loop || null });
  loop.addEventListener('change', () => patch({ loop: loop.checked }));
  const shortNote = src && !m.loop && src.duration - m.start < total ? `The track ends ${fmtSec(total - (src.duration - m.start), 1)} before the video; silence follows (or tick Loop).` : null;
  return [
    h('div', { class: 'subhead' }, h('h3', { text: 'Music' }), h('button', { type: 'button', class: 'small danger', text: 'Remove', onclick: () => setMusic(null) })),
    h('div', { class: 'sourceline' }, h('span', { class: 'sourcename', text: src?.name || '?' }), h('span', { class: 'muted', text: srcMeta(src) })),
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
    shortNote ? h('p', { class: 'warn small', text: shortNote }) : null,
    picker,
  ];
}

function sequencePanel() {
  if (!state.clips.length) return [];
  const normalize = h('input', { type: 'checkbox', checked: state.normalize || null });
  normalize.addEventListener('change', () => setSequenceField('normalize', normalize.checked));
  const total = totalDuration();
  return [
    h('div', { class: 'panelhead' }, h('h2', { text: 'Whole video' }), h('span', { class: 'muted num', text: fmtShort(total) })),
    h('div', { class: 'fieldrow' },
      field('Fade in from black', seconds({ value: state.fadeIn, max: Math.min(MAX_FADE, total), onChange: (v) => setSequenceField('fadeIn', v) })),
      field('Fade out to black', seconds({ value: state.fadeOut, max: Math.min(MAX_FADE, total), onChange: (v) => setSequenceField('fadeOut', v) }))),
    h('p', { class: 'fieldhint', text: 'Fades apply to picture and sound together.' }),
    ...musicBlock(),
    h('div', { class: 'subhead' }, h('h3', { text: 'Loudness' })),
    h('label', { class: 'check' }, normalize, 'Normalize to −14 LUFS (streaming loudness)'),
    h('p', { class: 'fieldhint', text: 'Evens out quiet and loud parts so the trailer sounds like other store videos. Slightly slower export.' }),
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

function renderNow() {
  const sel = state.selection;
  let kids;
  if (!state.clips.length) kids = [h('div', { class: 'emptypanel' }, h('h2', { text: 'Nothing here yet' }), h('p', { class: 'muted', text: 'Add a video to start. Each clip you add appears in the sequence below; select one to trim it here.' }))];
  else if (sel?.kind === 'transition') kids = transitionPanel(sel.index);
  else if (sel?.kind === 'clip') kids = clipPanel(sel.index);
  else kids = [h('p', { class: 'muted', text: 'Select a clip in the sequence.' })];
  el.itemPanel.replaceChildren(...kids.filter(Boolean));
  el.sequencePanel.replaceChildren(...sequencePanel().filter(Boolean));
  el.sequencePanel.hidden = !state.clips.length;
}

export function initInspector() {
  on('sequence', renderInspector);
  on('selection', renderInspector);
  on('sources', renderInspector);
  on('info', renderInspector);
}
