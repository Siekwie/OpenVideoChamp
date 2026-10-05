// Project files (.ovc.json) and the autosaved session in localStorage.
// Sources are stored by path; loading re-registers them with the server. Uploaded files live in the
// server's temp dir and are gone after a restart, so they may fail to restore.
import { api } from './api.js';
import { state, on, addSource, afterEdit, select, emit, fullClip, clipRequest, OUTPUT_VALUES, DEFAULT_MUSIC, ASPECTS, FITS } from './state.js';

const AUTOSAVE_KEY = 'ovc.project';
export const PROJECT_VERSION = 1;

export function projectName() {
  const first = state.clips.map((c) => state.sources.get(c.sourceId)).find((s) => s);
  return state.projectName || (first ? first.name.replace(/\.[^.]+$/, '') : 'Untitled');
}

export function serializeProject() {
  const used = new Set([...state.clips.flatMap((c) => [c.sourceId, ...c.sounds.map((x) => x.sourceId)]), state.music?.sourceId].filter(Boolean));
  return {
    app: 'OpenVideoChamp', version: PROJECT_VERSION, name: projectName(), savedAt: new Date().toISOString(),
    sources: [...used].map((id) => state.sources.get(id)).filter(Boolean).map((s) => ({ id: s.id, path: s.path, name: s.name, kind: s.kind, uploaded: s.uploaded })),
    clips: state.clips.map((c) => ({ id: c.id, ...clipRequest(c) })),
    transitions: state.transitions.map((t) => ({ type: t.type, duration: t.duration })),
    fadeIn: state.fadeIn, fadeOut: state.fadeOut, normalize: state.normalize,
    aspect: state.aspect, fit: state.fit, look: state.look,
    music: state.music ? { ...state.music } : null,
    output: { ...state.output },
  };
}

export function downloadProject() {
  const data = serializeProject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.name.replace(/[\\/:*?"<>|]+/g, '_')}.ovc.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Loads a project into the state. `from` is { path } (a file the server can read) or { project } (the
// parsed file). The server opens the media and hands back the project with its ids; see POST /api/project.
// Returns { missing: [names], dropped: n }.
export async function loadProject(from) {
  const data = await api.project(from);
  for (const src of data.sources) addSource(src);
  state.clips = data.clips.map((c) => {
    const src = state.sources.get(c.sourceId);
    return fullClip({ ...c, id: null, sourceId: src.id, start: Number(c.start) || 0, end: Number(c.end) || src.duration, volume: Number(c.volume ?? 1), mute: !!c.mute });
  });
  state.transitions = data.transitions.map((t) => (t && t.type && t.type !== 'cut' ? { type: t.type, duration: Number(t.duration) || 0 } : { type: 'cut', duration: 0 }));
  state.fadeIn = data.fadeIn;
  state.fadeOut = data.fadeOut;
  state.normalize = data.normalize;
  state.aspect = Object.hasOwn(ASPECTS, data.aspect) ? data.aspect : 'auto';
  state.fit = FITS.includes(data.fit) ? data.fit : 'fit';
  state.look = data.look || null;
  state.music = data.music ? { ...DEFAULT_MUSIC, ...data.music } : null;
  state.projectName = data.name;
  const out = data.output || {};
  for (const [key, allowed] of Object.entries(OUTPUT_VALUES)) if (allowed.includes(String(out[key]))) state.output[key] = String(out[key]);
  if (typeof out.encoder === 'string') state.output.encoder = out.encoder;
  if (Number(out.targetMB) >= 1) state.output.targetMB = Number(out.targetMB);
  state.selection = null;
  afterEdit({ structural: true });
  emit('output');
  select(state.selection);
  return { missing: data.missing, dropped: data.dropped };
}

export async function loadProjectFile(file) {
  let project;
  try { project = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON'); }
  return loadProject({ project });
}

// ---------- autosave ----------

export function autosave() {
  try {
    if (!state.clips.length) localStorage.removeItem(AUTOSAVE_KEY);
    else localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeProject()));
  } catch { /* storage full or unavailable */ }
}

export function autosaved() {
  try {
    const data = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
    return data && data.clips?.length ? data : null;
  } catch { return null; }
}

export function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

export function initProject() {
  on('sequence', autosave);
  on('output', autosave);
  window.addEventListener('beforeunload', autosave);
}
